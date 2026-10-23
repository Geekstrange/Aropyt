/**
 * 空格可视化：把视口内的空格标成装饰，由 CSS 画成中点。
 *
 * 为什么用 mark + CSS 而不是 replace：replace 会改变文本语义（不可编辑），
 * 空格必须始终可以正常输入/删除。CSS 画点对文档零影响。
 */
function showWhitespace(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildSpaceDecorations(view);
      }
      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildSpaceDecorations(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

function buildSpaceDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const to = Math.min(view.viewport.to, view.state.doc.length);
  for (let pos = view.viewport.from; pos < to; pos += 1) {
    const ch = view.state.doc.sliceString(pos, pos + 1);
    if (ch === ' ') {
      builder.add(pos, pos + 1, Decoration.mark({ class: 'cm-md-ws-space' }));
    } else if (ch === '\t') {
      builder.add(pos, pos + 1, Decoration.mark({ class: 'cm-md-ws-tab' }));
    }
  }
  return builder.finish();
}

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

import { Compartment, EditorState, Prec, type Extension,
  RangeSetBuilder,
} from '@codemirror/state';
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
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';

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
   * 执行一条命令（插件键位绑定时用）。
   *
   * 编辑器不认识 CommandRegistry —— 注入回调，保持内核与命令系统解耦。
   */
  readonly runCommand?: (commandId: string) => void;
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
  /** 源码/渲染模式变化（含 Ctrl+/ 与 vim 强制切换）—— 宿主据此刷新按钮状态。 */
  readonly onModeChange?: (sourceMode: boolean) => void;
  readonly onCursorChange?: (info: CursorInfo) => void;
  /** Ctrl/Cmd+S。由应用层决定它意味着什么。 */
  readonly onSaveRequest?: () => void;
  /** 关闭当前文档（vim 的 :q / :wq 用）。 */
  readonly onCloseRequest?: () => void;
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
  /** 默认键位槽：vim 开启时收起（见构造函数里的说明）。 */
  readonly #keymapSlot = new Compartment();
  /** 插件声明的键位（键 → 命令），由宿主在插件加载后注入。 */
  #pluginKeybindings: readonly { readonly key: string; readonly command: string }[] = [];

  /**
   * 设置插件键位。
   *
   * CM6 的 keymap 是静态扩展，插件是在启动后才加载的 —— 所以这里
   * 通过 Compartment 重配，而不是创建视图时就固定。
   * **插件键位排在 defaultKeymap 之前**（CM6 同一批里前者优先）。
   */
  setPluginKeybindings(bindings: readonly { readonly key: string; readonly command: string }[]): void {
    /*
     * key 归一化。
     *
     * 插件按 VSCode 习惯写 `Mod-Shift-D`，而 CM6 的 key 语法要求
     * **末段字母小写**（`Mod-Shift-d`）—— 原样传进去永远匹配不上，
     * 表现为"声明了键位、按了没反应"（实测）。
     */
    this.#pluginKeybindings = bindings.map((binding) => ({
      ...binding,
      key: binding.key.replace(/^(.*-)?([A-Za-z])$/, (_match, prefix: string | undefined, letter: string) =>
        `${prefix ?? ''}${letter.toLowerCase()}`,
      ),
    }));
    this.#applyKeymap();
  }

  #applyKeymap(): void {
    if (!this.#view) return;
    const runCommand = this.options.runCommand;
    const pluginBindings = this.#pluginKeybindings.map((binding) => ({
      key: binding.key,
      run: () => {
        runCommand?.(binding.command);
        return true;
      },
    }));
    this.#view.dispatch({
      effects: this.#keymapSlot.reconfigure(
        keymap.of([...pluginBindings, ...historyKeymap, indentWithTab]),
      ),
    });
  }
  #vimOn = false;
  /** 动态 import 的 vim 模块（懒加载，这里只留 getCM 供状态查询）。 */
  #vimApi: { getCM: (view: EditorView) => unknown } | null = null;
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
    this.#vimOn = options.vimMode ?? false;
    /*
     * vim 开启时初始就是源码态：渲染态下非光标块是整块 widget，j/k 与
     * 上下键按 DOM 几何移动会跳过文本（用户实测"跳过文字行"）。
     * 注意这只管**初始**状态；用户仍可用 Ctrl+/ 切到渲染态（能切回去
     * 才是可用的，上一版"拒绝切回"导致用户卡在源码态出不来）。
     */
    this.#sourceMode = options.inlineRender === false || this.#vimOn;
    this.#appliedSource = this.#sourceMode;
    // vim 模式的初始装载是异步的（动态 import），就绪后补挂扩展
    if (this.#vimOn) {
      void import('@replit/codemirror-vim').then(({ vim, getCM, Vim }) => {
        this.#vimApi = { getCM: getCM as (view: EditorView) => unknown };
        // ex 命令：:w / :q / :wq（defineEx 幂等，重复注册只是覆盖）
        Vim.defineEx('write', 'w', () => options.onSaveRequest?.());
        Vim.defineEx('quit', 'q', () => options.onCloseRequest?.());
        Vim.defineEx('wq', 'wq', () => { options.onSaveRequest?.(); options.onCloseRequest?.(); });
        if (!this.#vimOn) return;
        this.#view.dispatch({
          effects: [
            this.#vimSlot.reconfigure(
              Prec.highest([
                vim(),
                // 类名给 CSS 用：vim 模式禁掉原生鼠标选择（见 styles.css）
                EditorView.editorAttributes.of({ class: 'aropyt-vim' }),
              ]),
            ),
            this.#keymapSlot.reconfigure(
              keymap.of([
                ...this.#pluginKeybindings.map((binding) => ({
                  key: binding.key,
                  run: () => {
                    this.options.runCommand?.(binding.command);
                    return true;
                  },
                })),
                ...historyKeymap,
                indentWithTab,
              ]),
            ),
          ],
        });
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
          /*
           * 搜索面板：必须显式安装 search() —— 只装 searchKeymap 时
           * openSearchPanel 没有对应的 state，面板的配色与文案都无法定制
           * （用户看到的"原始 UI"就是 CM6 内部的兜底渲染）。
           * phrases 把按钮文案换成中文（CM6 官方支持的本地化入口）。
           */
          search({ top: true }),
          /*
           * 面板文案走 EditorState.phrases（CM6 的全局文案 facet）——
           * 键名是 CM6 search 内部调用 phrase() 时用的英文原文，
           * 不能改成任意中文键（试过 phrases 放在 search() 里，类型上不存在）。
           */
          EditorState.phrases.of({
            Find: '查找',
            Replace: '替换',
            // CM6 内部用的是小写键（用户实测这两个漏翻）
            replace: '替换',
            'replace all': '全部替换',
            next: '下一个',
            previous: '上一个',
            all: '全部选中',
            'match case': '区分大小写',
            regexp: '正则',
            'by word': '全词匹配',
            close: '关闭',
            'replaced all': '已全部替换',
            'current match': '当前匹配',
            'on line': '第几行',
            'Go to line': '跳转到行',
            go: '跳转',
          }),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          // Typora 式原地渲染。必须在 markdown 解析器之后 —— 它依赖 syntaxTree。
          //
          // 走 Compartment：切模式时重配这个槽，而不是重建视图。
          // 重建会连带丢失撤销历史、光标位置、滚动位置 ——
          // 那种"切一下模式回到文档开头"的体验是灾难性的。
          /*
           * 必须用 this.#sourceMode（已含 vim 强制源码）—— 只看 options.inlineRender
           * 会让"启动即 vim"的场景下：状态说源码、实际注入的却是渲染态扩展
           * （#appliedSource 与槽分叉，用户表现为"源码模式未激活"）。
           */
          this.#renderSlot.of(this.#renderModeExtensions(this.#sourceMode)),
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
            {
              key: 'Mod-/',
              preventDefault: true,
              run: () => {
                /*
                 * vim 模式恒为源码态 —— Ctrl+/ 在这里**直接吞掉**。
                 * 自有 keymap 独立于 vim 的键位层（vim 不占 Ctrl+/），
                 * 不做这层拦截的话 vim 下仍能切到渲染态，
                 * j/k 又会跳块（用户实测）。
                 */
                if (this.#vimOn) return true;
                this.setSourceMode(!this.#sourceMode);
                return true;
              },
            },
          ]),
          /*
           * 默认键位用 Compartment 包起来：**vim 模式下必须整体收起**。
           *
           * CM6 的 keymap 前面优先，而 defaultKeymap 里的 Backspace 是
           * "删除字符" —— 排在 vim 之前就会让 normal 模式的 Backspace
           * 真的删字（用户实测打回：不进插入模式也能删）。
           * vim 模式下只留历史与缩进兜底（insert 模式的 Tab、Ctrl-Z）。
           */
          this.#keymapSlot.of(
            keymap.of([
              ...closeBracketsKeymap,
              ...defaultKeymap,
              ...searchKeymap,
              ...historyKeymap,
              ...foldKeymap,
              ...completionKeymap,
              indentWithTab,
            ]),
          ),
          // 主题常驻，不再随模式切换 —— 它内部用 `&.aropyt-render-mode`
          // 这个类来区分排版，所以本身与模式无关。
          // 模式类由下面的槽设置。
          aropytEditorTheme,
          this.#modeClassSlot.of(
            EditorView.editorAttributes.of({
              /*
               * 必须用 this.#sourceMode（已含 vim 强制源码），不能只看
               * options.inlineRender —— 否则"启动时 vim 已开启"的场景下
               * 按钮显示激活、编辑器实际却是渲染态（用户实测）。
               */
              class: this.#sourceMode ? 'aropyt-source-mode' : 'aropyt-render-mode',
            }),
          ),
          aropytHighlightStyle,
          EditorView.domEventHandlers({
            // vim 模式禁用鼠标选择（单击定位仍可用）—— 老用户的手始终在键位层
            mousedown: (event) => this.#vimOn && (event.shiftKey || event.detail > 1),
            /*
             * 拖选必须拦 **mousemove**：CM6 的 drawSelection() 自绘选区，
             * 选中过程完全不走浏览器原生选择 —— `user-select: none`
             * 对它无效（因此上一版没能禁掉拖选）。
             * 按住左键移动时返回 true = CM6 不扩展选择；
             * 单击定位（按下即抬起，无 move）仍然可用。
             */
            mousemove: (event) => this.#vimOn && event.buttons === 1,
            selectstart: () => this.#vimOn,
            /*
             * vim 模式下的纵向移动：如果当前在渲染态，先切回源码态。
             * 渲染态的非光标块是整块 widget，j/k 只能落在 widget 边界
             * （用户实测"跳过文字行"）—— 渲染态与 vim 的行级光标本质冲突，
             * 一按 j/k 就退回源码是最不反直觉的处理。
             */
            keydown: (event) => {
              if (!this.#vimOn || this.#sourceMode) return false;
              if (!['j', 'k', 'ArrowDown', 'ArrowUp'].includes(event.key)) return false;
              this.setSourceMode(true);
              return false;
            },
          }),
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
      return [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        /*
         * 非打印字符可视化（v0.0.8）：
         *  - highlightSpecialChars：tab → 箭头、控制字符 → 转义符号（CM6 内置）
         *  - showWhitespace：空格画成中点（自定义装饰，纯 CSS 渲染，不改文本）
         * 与"源码模式是排障模式"的定位一致 —— 看得见空白，才找得到缩进错。
         */
        highlightSpecialChars(),
        showWhitespace(),
      ];
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
    if (this.#sourceMode === source) return;
    this.#sourceMode = source;
    this.options.onModeChange?.(source);
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
    /*
     * vim 模式强制源码态。
     *
     * 两个理由：
     * 1. 渲染态下非光标块是整块 widget（8 行源码 = 1 行 DOM），j/k 与
     *    上下方向键按 DOM 几何移动，只会落在 widget 边界 —— 用户实测
     *    "跳过文字行落到空白行"。
     * 2. vim 用户的编辑习惯本来就是源码（Typora 的 vim 模式同样如此）。
     * 关闭 vim 时不自动切回，用户按 Ctrl+/ 自己决定。
     */
    if (on) this.setSourceMode(true);
    if (!on) {
      /*
       * 退出 vim：回到渲染态。
       * vim 是"强制源码"的唯一原因，退出后应回到用户的阅读模式，
       * 而不是把人留在源码态里（上一版留在源码态，用户以为按钮坏了）。
       */
      this.setSourceMode(false);
      this.#view.dispatch({
        effects: [
          this.#vimSlot.reconfigure([]),
          this.#keymapSlot.reconfigure(
            keymap.of([
              ...closeBracketsKeymap,
              ...defaultKeymap,
              ...searchKeymap,
              ...historyKeymap,
              ...foldKeymap,
              ...completionKeymap,
              indentWithTab,
            ]),
          ),
        ],
      });
      return;
    }
    void import('@replit/codemirror-vim').then(({ vim, getCM, Vim }) => {
      // ex 命令：:w / :q / :wq
      Vim.defineEx('write', 'w', () => this.options.onSaveRequest?.());
      Vim.defineEx('quit', 'q', () => this.options.onCloseRequest?.());
      Vim.defineEx('wq', 'wq', () => { this.options.onSaveRequest?.(); this.options.onCloseRequest?.(); });
      if (!this.#vimOn) return;
      /*
       * 这里也必须保存 getCM —— 只在构造时保存的话，"先关 vim 再开"的
       * 路径下 #vimApi 永远是 null，getVimSubMode() 恒返回 null，
       * 状态栏就永远显示 fallback 的 NORMAL（用户实测：按 i 进插入模式
       * 仍显示 NORMAL）。
       */
      this.#vimApi = { getCM: getCM as (view: EditorView) => unknown };
      this.#view.dispatch({
        effects: [
          this.#vimSlot.reconfigure(
            Prec.highest([
              vim(),
              EditorView.editorAttributes.of({ class: 'aropyt-vim' }),
            ]),
          ),
          // 收起默认键位：否则 defaultKeymap 的 Backspace/Delete 会先命中
          this.#keymapSlot.reconfigure(keymap.of([...historyKeymap, indentWithTab])),
        ],
      });
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
  /**
   * vim 子模式（normal / insert / visual …）。
   * 未开 vim 时返回 null —— 状态栏据此显示 -- NORMAL -- 这类指示，
   * 这是"用起来像 vim"最直接的一环（老用户靠它确认当前模式）。
   */
  getVimSubMode(): string | null {
    if (!this.#vimOn || !this.#vimApi) return null;
    try {
      const cm = this.#vimApi.getCM(this.#view) as { state?: { vim?: { mode?: unknown } } } | null;
      const mode = cm?.state?.vim?.mode;
      if (typeof mode !== 'string') return null;
      /*
       * 库在 normal 模式返回的是 'vim'（内部默认名），不是 'normal' ——
       * 直接大写会显示成 "VIM"，与旁边的 vim logo 重复（用户实测）。
       */
      return mode === 'vim' ? 'normal' : mode;
    } catch {
      return null;
    }
  }

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
