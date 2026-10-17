/**
 * 编辑器适配器 —— 内核里唯一"真正碰 CodeMirror"的地方。
 *
 * 它的职责就一件事：把 CodeMirror 的实例语义，翻译成插件能用的语义操作。
 * 插件永远拿不到 EditorView，理由见 plugin-api 的注释。
 *
 * 这里还承担了"逃生舱"的守卫职责：插件注入的原生 Extension 会经过
 * guardSync 和 pluginId 归因 —— 因为 Extension 跑在主线程、每个 transaction
 * 都执行、而且是同步代码无法超时，它是整个防挂起体系里最需要被盯住的入口。
 */

import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';

import type {
  CapabilitySnapshot,
  Disposable,
  DocumentRef,
  EditorApi,
  EditorExtensionEnv,
  Event,
  PlatformKind,
  SelectionInfo,
} from '@aropyt/plugin-api';

import { toggleLinePrefix as applyLinePrefix, toggleWrap as applyWrap } from '../commands.js';
import { inlineRender } from '../wysiwyg/inline-render.js';
import { guardSync } from '../safety.js';
import { aropytEditorTheme, aropytHighlightStyle } from '../theme.js';

export interface CursorInfo {
  /** 1 起算，与 revealLine / getLine 保持一致。 */
  readonly line: number;
  readonly column: number;
  readonly selectionLength: number;
}

export interface EditorOptions {
  readonly parent: HTMLElement;
  readonly platform: PlatformKind;
  readonly capabilities: CapabilitySnapshot;
  readonly initialDoc?: string;
  readonly placeholderText?: string;
  readonly extraExtensions?: readonly Extension[];
  /** 初始是否为 vim 模式（normal/insert/visual 操作方式）。持久化由宿主负责。 */
  readonly vimMode?: boolean;
  /**
   * 是否启用 Typora 式原地渲染。
   *
   * 默认 true —— 这已经是产品的默认形态，不是可选增强。
   * 保留这个开关是因为**源码模式**仍然必要：webdev 场景要写 HTML、
   * 调试时要看原始标记，而那时渲染层会碍事。
   */
  readonly inlineRender?: boolean;
  /**
   * 把工作区相对路径的图片变成可显示的 src（通常是 data URL）。
   *
   * 由宿主注入，内核不知道工作区在哪 —— 这是"内核不依赖外壳"的一部分。
   * 不注入时图片渲染成"无法显示"的占位，而不是静默留空。
   */
  readonly resolveAsset?: (url: string) => Promise<string | null>;
  readonly onDocChange?: (text: string, version: number) => void;
  readonly onCursorChange?: (info: CursorInfo) => void;
  /** Ctrl/Cmd+S。由应用层决定它意味着什么。 */
  readonly onSaveRequest?: () => void;
}

type ActiveFilePayload = { readonly path: string | null; readonly language: string | null };
type DocPayload = { readonly path: string; readonly text: string; readonly version: number };

export class EditorAdapter implements EditorApi {
  readonly #view: EditorView;
  /** 插件 Extension 的装载槽。用 Compartment 才能在运行时增删而不重建编辑器。 */
  readonly #slot = new Compartment();
  /** 渲染层的装载槽。同上：切模式绝不能重建编辑器。 */
  readonly #renderSlot = new Compartment();
  /**
   * 模式类名槽。
   *
   * 不在运行时切换"哪个主题生效" —— 那条路已经踩过两次：
   * 同优先级的 EditorView.theme 规则，谁最后注入谁赢，
   * 与扩展顺序无关，切模式后字体静默不变。
   *
   * 现在只有一个主题，模式体现为根节点上的类名。
   * 规则唯一、优先级确定、且能在检查器里一眼看出当前处于哪个模式。
   */
  readonly #modeClassSlot = new Compartment();
  /** vim 模式槽：运行时开关，不重建编辑器。 */
  readonly #vimSlot = new Compartment();
  #vimOn = false;
  #sourceMode = false;
  /*
   * 曾经还有一个 #forcedSource（"预览面板把编辑区逼成源码"）。
   * 它与 #sourceMode 分开是为了"关面板只撤销强制、不动用户偏好"——
   * 但既然编辑区不再被任何东西强制，那条耦合本身就是多余的：
   * Typora 式编辑里编辑区永远是渲染态，预览面板是并列的另一栏。
   * 整台机器（字段 + setter + 合取）一并删掉，不留"也许以后会用"的死代码。
   */
  /** 已经同步给视图的模式。用于避免重复 dispatch（重复会白白触发一次重绘）。 */
  #appliedSource = false;
  #pluginExtensions: Extension[] = [];

  #activeFile: string | null = null;
  #language: string | null = null;
  #document: DocumentRef | null = null;
  #opener: ((path: string, options?: { readonly preview?: boolean }) => Promise<void>) | null = null;
  #documentVersion = 0;

  readonly #activeFileListeners = new Set<(payload: ActiveFilePayload) => void>();
  readonly #docListeners = new Set<(payload: DocPayload) => void>();
  readonly #saveListeners = new Set<(payload: { path: string }) => void>();

  constructor(private readonly options: EditorOptions) {
    this.#sourceMode = options.inlineRender === false;
    this.#appliedSource = this.#sourceMode;
    this.#vimOn = options.vimMode ?? false;
    // vim 模式的初始装载是异步的（动态 import），就绪后补挂扩展
    if (this.#vimOn) {
      void import('@replit/codemirror-vim').then(({ vim }) => {
        if (this.#vimOn) this.#view.dispatch({ effects: this.#vimSlot.reconfigure(vim()) });
      });
    }

    this.#view = new EditorView({
      state: EditorState.create({
        doc: options.initialDoc ?? '',
        extensions: [
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          // Typora 式原地渲染。必须在 markdown 解析器之后 —— 它依赖 syntaxTree。
          //
          // 走 Compartment：切模式时重配这个槽，而不是重建视图。
          // 重建会连带丢失撤销历史、光标位置、滚动位置 ——
          // 那种"切一下模式回到文档开头"的体验是灾难性的。
          this.#renderSlot.of(this.#renderModeExtensions(options.inlineRender === false)),
          /*
           * 自有键位必须排在 `...defaultKeymap` **之前**。
           *
           * CM6 的同一批 keymap 里，**前面的优先**。defaultKeymap 自带
           * `{ key: "Mod-/", run: toggleComment }`（见 @codemirror/commands），
           * 所以原来把 Mod-/ 放在它后面等于永远轮不到自己 ——
           * 按 Ctrl+/ 得到的是"注释选中行"，不是切换源码模式。
           *
           * 这里以前的注释写的是"必须在 defaultKeymap 之后，否则会被覆盖"，
           * 方向正好反了。它当时没暴露只是因为 Mod-s 在 defaultKeymap 里
           * 恰好没有占用者 —— 也就是说那条注释把"巧合"说成了"规则"，
           * 而照着它排版的 Mod-/ 直接失效了。
           *
           * 拆成独立的一段放最前面，让优先级变成显式的，而不是靠数组顺序猜。
           */
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { options.onSaveRequest?.(); return true; } },
            // Ctrl+/ 切换源码模式 —— 与 Typora 一致。
            // 放这里而不是贡献点：它是编辑器自身状态的切换，
            // 不该让插件来决定"这个编辑器能不能切模式"。
            { key: 'Mod-/', preventDefault: true, run: () => { this.setSourceMode(!this.#sourceMode); return true; } },
          ]),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          // 主题常驻，不再随模式切换 —— 它内部用 `&.aropyt-render-mode`
          // 这个类来区分排版，所以本身与模式无关。
          // 模式类由下面的槽设置。
          aropytEditorTheme,
          this.#modeClassSlot.of(
            EditorView.editorAttributes.of({
              class: options.inlineRender === false ? 'aropyt-source-mode' : 'aropyt-render-mode',
            }),
          ),
          aropytHighlightStyle,
          this.#slot.of([]),
          // vim 槽：初始状态来自 options（持久化由宿主负责）
          this.#vimSlot.of([]),
          ...(options.extraExtensions ?? []),
          EditorView.updateListener.of((update) => this.#handleUpdate(update)),
        ],
      }),
      parent: options.parent,
    });
  }

  /** 内核内部使用。刻意不进 EditorApi —— 插件拿不到它。 */
  get view(): EditorView {
    return this.#view;
  }

  /**
   * 渲染模式下的扩展集合。
   *
   * 行号与渲染层放在**同一个 Compartment** 里 ——
   * 拆开的话切模式时行号会留在原地，那种"没有标记却还有行号"
   * 的半吊子状态比两者都开着更糟。
   */
  #renderModeExtensions(sourceMode: boolean): Extension {
    if (sourceMode) {
      // 源码模式：行号 + 折叠栏都回来，渲染层整个卸掉。
      // 装饰为零，不留任何隐藏行为 —— 这才是排障模式该有的样子。
      //
      // 折叠栏也放这里而不是无条件装载：它同样会创建 .cm-gutters，
      // 在渲染态留下一列视觉噪音（Typora 的阅读视图没有它）。
      return [lineNumbers(), highlightActiveLineGutter(), foldGutter()];
    }
    // 渲染态：行号是纯噪音。Typora 就没有行号，
    // 而且标记隐藏后行内不再有等宽符号，一列数字贴在正文左边
    // 反而让人进不了"读文档"的状态。
    return inlineRender({ resolveAsset: this.options.resolveAsset });
  }

  /**
   * 切换源码模式 / 渲染模式（Typora 模式）。
   *
   * 走 Compartment 重配，**不重建视图** —— 重建会丢撤销历史、
   * 光标位置、滚动位置。切模式后回到文档开头是灾难性的体验。
   */
  setSourceMode(source: boolean): void {
    this.#sourceMode = source;
    this.#applyMode();
  }

  /*
   * 应用当前模式到视图。
   *
   * 原来这里是 `sourceMode || forcedSource` 的合取，因为预览面板会强制源码。
   * 那条强制已删，现在生效模式就等于用户的唯一选择 ——
   * 留着合取的写法只会让人以为强制态还在。
   */
  /**
   * vim 模式开关（@replit/codemirror-vim）。持久化由宿主负责。
   * 库走动态 import —— vim 按键映射是纯增量能力，不该进首屏预算；
   * 就绪前开关状态已记录，扩展随后补挂。
   */
  setVimMode(on: boolean): void {
    if (on === this.#vimOn) return;
    this.#vimOn = on;
    if (!on) {
      this.#view.dispatch({ effects: this.#vimSlot.reconfigure([]) });
      return;
    }
    void import('@replit/codemirror-vim').then(({ vim }) => {
      if (this.#vimOn) this.#view.dispatch({ effects: this.#vimSlot.reconfigure(vim()) });
    });
  }

  get vimMode(): boolean {
    return this.#vimOn;
  }

  #applyMode(): void {
    const source = this.#sourceMode;
    if (source === this.#appliedSource) return;
    this.#appliedSource = source;
    this.#view.dispatch({
      effects: [
        this.#renderSlot.reconfigure(this.#renderModeExtensions(source)),
        this.#modeClassSlot.reconfigure(
          EditorView.editorAttributes.of({
            class: source ? 'aropyt-source-mode' : 'aropyt-render-mode',
          }),
        ),
      ],
    });
  }

  /** 实际生效的模式。UI 判断按钮亮不亮要看这个。 */
  get sourceMode(): boolean {
    return this.#sourceMode;
  }

  /** 用户自己选定的模式，**不含**外部强制。持久化偏好该用这个。 */
  get preferredSourceMode(): boolean {
    return this.#sourceMode;
  }

  get extensionSlot(): Extension {
    return this.#slot.of([]);
  }

  focus(): void {
    this.#view.focus();
  }

  destroy(): void {
    this.#view.destroy();
  }

  setActiveFile(path: string | null, language: string | null): void {
    this.#activeFile = path;
    this.#language = language;
    this.#emitActiveFile();
  }

  /**
   * 绑定当前文档。保存语义由宿主实现（它才知道工作区在哪），
   * 内核只负责把插件的"保存当前文档"转给它。
   */
  bindDocument(document: DocumentRef | null): void {
    this.#document = document;
  }

  /** 宿主注入"打开文档"的实现 —— 它需要工作区与崩溃恢复知识，内核没有。 */
  bindOpener(
    opener: (path: string, options?: { readonly preview?: boolean }) => Promise<void>,
  ): void {
    this.#opener = opener;
  }

  async openDocument(path: string, options?: { readonly preview?: boolean }): Promise<void> {
    if (!this.#opener) throw new Error('宿主尚未注入打开文档的能力');
    await this.#opener(path, options);
  }

  // ─────────────────────────── EditorApi ───────────────────────────

  get activeFile(): string | null {
    return this.#activeFile;
  }

  get activeLanguage(): string | null {
    return this.#language;
  }

  get activeDocument(): DocumentRef | null {
    return this.#document;
  }

  get onDidChangeActiveFile(): Event<ActiveFilePayload> {
    return (listener) => subscribe(this.#activeFileListeners, listener);
  }

  get onDidChangeDocument(): Event<DocPayload> {
    return (listener) => subscribe(this.#docListeners, listener);
  }

  get onDidSaveDocument(): Event<{ path: string }> {
    return (listener) => subscribe(this.#saveListeners, listener);
  }

  getText(): string {
    return this.#view.state.doc.toString();
  }

  /** 行号 1 起算。越界返回 null，而不是抛 —— 调用方通常是插件。 */
  getLine(lineNumber: number): string | null {
    const doc = this.#view.state.doc;
    if (lineNumber < 1 || lineNumber > doc.lines) return null;
    return doc.line(lineNumber).text;
  }

  getSelection(): SelectionInfo | null {
    const range = this.#view.state.selection.main;
    const doc = this.#view.state.doc;
    return {
      text: this.#view.state.sliceDoc(range.from, range.to),
      anchor: range.anchor,
      head: range.head,
      startLine: doc.lineAt(range.from).number,
      endLine: doc.lineAt(range.to).number,
    };
  }

  insertText(text: string): void {
    const range = this.#view.state.selection.main;
    this.#view.dispatch({ changes: { from: range.from, insert: text }, selection: { anchor: range.from + text.length } });
    this.#view.focus();
  }

  replaceSelection(text: string): void {
    const range = this.#view.state.selection.main;
    this.#view.dispatch({ changes: { from: range.from, to: range.to, insert: text }, selection: { anchor: range.from + text.length } });
    this.#view.focus();
  }

  replaceDocument(text: string): void {
    this.#view.dispatch({ changes: { from: 0, to: this.#view.state.doc.length, insert: text } });
  }

  wrapSelection(prefix: string, suffix: string = prefix): void {
    applyWrap(this.#view, prefix, suffix);
  }

  toggleLinePrefix(prefix: string | ((index: number) => string)): boolean {
    return applyLinePrefix(this.#view, prefix);
  }

  revealLine(lineNumber: number): void {
    const doc = this.#view.state.doc;
    if (lineNumber < 1 || lineNumber > doc.lines) return;
    const line = doc.line(lineNumber);
    this.#view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      scrollIntoView: false,
    });
    this.#view.focus();
  }

  /**
   * 逃生舱。唯一允许插件触碰编辑器内部的地方。
   *
   * 三重约束同时生效：pluginId 归因、guardSync 兜住抛错、
   * dispose 时从槽里摘掉。但要说清楚 —— **它无法被超时保护**，
   * 因为 CodeMirror 的 transaction 是同步的。这就是为什么
   * "安全模式启动"（禁用全部插件）必须存在。
   */
  registerExtension(
    factory: (env: EditorExtensionEnv) => unknown,
    owner: { readonly pluginId: string | null } = { pluginId: null },
  ): Disposable {
    const env: EditorExtensionEnv = {
      platform: this.options.platform,
      capabilities: this.options.capabilities,
    };

    const produced = guardSync(
      { scope: 'editor.extension', pluginId: owner.pluginId },
      () => factory(env) as Extension,
      [] as Extension,
    );

    this.#pluginExtensions.push(produced);
    this.#reconfigure();

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const index = this.#pluginExtensions.indexOf(produced);
        if (index >= 0) this.#pluginExtensions.splice(index, 1);
        this.#reconfigure();
      },
    };
  }

  #reconfigure(): void {
    this.#view.dispatch({ effects: this.#slot.reconfigure(this.#pluginExtensions) });
  }

  #handleUpdate(update: import('@codemirror/view').ViewUpdate): void {
    if (update.docChanged) {
      this.#documentVersion += 1;
      const payload: DocPayload = {
        path: this.#activeFile ?? '',
        text: update.state.doc.toString(),
        version: this.#documentVersion,
      };
      this.options.onDocChange?.(payload.text, payload.version);
      for (const listener of this.#docListeners) {
        try {
          listener(payload);
        } catch {
          /* 插件监听器出错不影响编辑本身 */
        }
      }
    }

    if (update.selectionSet || update.docChanged) {
      const range = update.state.selection.main;
      const line = update.state.doc.lineAt(range.from);
      this.options.onCursorChange?.({
        line: line.number,
        column: range.from - line.from + 1,
        selectionLength: range.to - range.from,
      });
    }
  }

  #emitActiveFile(): void {
    const payload: ActiveFilePayload = { path: this.#activeFile, language: this.#language };
    for (const listener of this.#activeFileListeners) {
      try {
        listener(payload);
      } catch {
        /* 同上 */
      }
    }
  }

  /** 由应用层在保存成功后调用。 */
  notifySaved(path: string): void {
    for (const listener of this.#saveListeners) {
      try {
        listener({ path });
      } catch {
        /* 同上 */
      }
    }
  }
}

function subscribe<T>(set: Set<(payload: T) => void>, listener: (payload: T) => void): Disposable {
  set.add(listener);
  return {
    dispose: () => {
      set.delete(listener);
    },
  };
}

export function createEditor(options: EditorOptions): EditorAdapter {
  return new EditorAdapter(options);
}
