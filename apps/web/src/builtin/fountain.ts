/**
 * 内置插件：Fountain 剧本。
 *
 * 一个格式的支持分两半：
 *   - **识别**（扩展名 → language id）已经在内核里做完（core/languages.ts）
 *   - **渲染**（长什么样）是插件的事 —— 这个文件就是那个插件
 *
 * 渲染只做两件事，都刻意保持"不改变文本"：
 *   1. 场景列表（侧栏）—— 剧本作者 80% 的时间在找场景，不在欣赏排版
 *   2. 行级样式（decoration）—— 场景标题加粗、角色居中、对白缩进、
 *      转场右对齐。**只加 class，不改字符**：光标、选择、撤销、
 *      保存全部走原生路径，不会出现"渲染态下编辑错位"这类问题。
 *
 * 为什么不做完整 WYSIWYG（隐藏标记、双人对白分栏）：
 *   Fountain 本身是可读的纯文本，藏掉 `INT.` / `(` 这些记号并不会让它
 *   更像剧本，反而让"这一行到底是什么元素"变得不可见。样式区分
 *   的收益/成本比最高，先做这一层。
 */

import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import type { PluginContext, PluginManifest, ViewProvider } from '@aropyt/plugin-api';
import type { LoadablePlugin } from '@aropyt/core';
import { t } from '../i18n';

const LANGUAGE_ID = 'fountain';
const VIEW_ID = 'aropyt.fountain.scenes';

type LineKind =
  | 'blank'
  | 'title'
  | 'scene'
  | 'section'
  | 'character'
  | 'dialogue'
  | 'paren'
  | 'transition'
  | 'center'
  | 'lyrics'
  | 'note'
  | 'boneyard'
  | 'pagebreak'
  | 'action';

export interface FountainLine {
  /** 1 起算，与 editor.revealLine 一致。 */
  readonly number: number;
  readonly kind: LineKind;
  readonly text: string;
}

/** 场景标题：INT. / EXT. / EST. / INT./EXT. / I/E. —— 允许大小写，实际写作都是大写。 */
const SCENE_HEADING = /^(?:INT|EXT|EST|I\/E|INT\.?\s*\/\s*EXT)[.\s]/i;
/** 强制场景：行首一个 `.`（区别于省略号）。 */
const FORCED_SCENE = /^\.(?!\.)\S/;
/** 分节：`#` 到 `######`。 */
const SECTION = /^#{1,6}\s+\S/;
/** 居中：`> ... <`（必须在转场之前判断，两者都以 `>` 开头）。 */
const CENTERED = /^>.*<$/;
/** 强制角色：`@` 前缀。 */
const FORCED_CHARACTER = /^@\S/;
/** 角色行允许的字符（大写字母/数字/常见标点）—— 用来排除整段大写的动作行。 */
const CHARACTER_TEXT = /^[A-Z0-9 .,'’\-()#^@]+$/;
/** 分页：三个以上等号独占一行。 */
const PAGE_BREAK = /^={3,}$/;
/** 歌词：`~` 开头。 */
const LYRICS = /^~/;
/** 标题页：`Key: Value`，只认文档开头的若干行。 */
const TITLE_LINE = /^[A-Za-z][A-Za-z0-9 _-]*:\s*\S/;
/** 标题页最多认这么多行 —— 正文里偶尔出现 "作者: xxx" 不该被当成标题页。 */
const TITLE_PAGE_LIMIT = 30;

function isScene(text: string): boolean {
  return SCENE_HEADING.test(text) || FORCED_SCENE.test(text);
}

function isTransition(text: string): boolean {
  /* `>` 开头（且不是居中）或全大写以 TO: 结尾 */
  if (text.startsWith('>')) return true;
  return text === text.toUpperCase() && /TO:$/.test(text);
}

function isCharacter(text: string): boolean {
  const bare = text.replace(/^@/, '').replace(/\^$/, '').trim();
  if (bare.length === 0 || bare.length > 60) return false;
  if (!CHARACTER_TEXT.test(bare)) return false;
  /* 至少要有两个字母，避免 "INT." 这类被误判（它已被场景规则先接走） */
  return /[A-Z]{2}/.test(bare);
}

/**
 * 逐行分类。
 *
 * 必须是**有状态**的：fountain 的对白靠"上一行是角色"来判定，
 * 注释块（boneyard）与笔记（`[[ … ]]`）还允许跨行。纯正则一次扫不完。
 *
 * 顺序有讲究：
 *   - 注释块优先（里面的 `INT.` 不是场景）
 *   - 居中先于转场（两者都以 `>` 开头）
 *   - 场景/转场先于"是否在对白里"（作者漏写空行时也能认出来）
 */
export function classifyFountain(lines: readonly string[]): readonly FountainLine[] {
  const out: FountainLine[] = [];
  let inDialogue = false;
  let previousBlank = true;
  let inBoneyard = false;
  let inNote = false;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const text = raw.trim();

    if (inBoneyard) {
      out.push({ number: index + 1, kind: 'boneyard', text: raw });
      if (text.includes('*/')) inBoneyard = false;
      previousBlank = text.length === 0;
      continue;
    }
    if (inNote) {
      out.push({ number: index + 1, kind: 'note', text: raw });
      if (text.includes(']]')) inNote = false;
      previousBlank = text.length === 0;
      continue;
    }
    if (text.startsWith('/*')) {
      out.push({ number: index + 1, kind: 'boneyard', text: raw });
      if (!text.includes('*/')) inBoneyard = true;
      previousBlank = false;
      continue;
    }
    if (text.startsWith('[[')) {
      out.push({ number: index + 1, kind: 'note', text: raw });
      if (!text.includes(']]')) inNote = true;
      previousBlank = false;
      continue;
    }

    if (text.length === 0) {
      out.push({ number: index + 1, kind: 'blank', text: raw });
      inDialogue = false;
      previousBlank = true;
      continue;
    }

    let kind: LineKind;
    if (PAGE_BREAK.test(text)) kind = 'pagebreak';
    else if (LYRICS.test(text)) kind = 'lyrics';
    else if (index < TITLE_PAGE_LIMIT && TITLE_LINE.test(text)) kind = 'title';
    else if (CENTERED.test(text)) kind = 'center';
    else if (SECTION.test(text)) kind = 'section';
    else if (isTransition(text)) kind = 'transition';
    else if (isScene(text)) kind = 'scene';
    else if (text.startsWith('(') && text.endsWith(')')) kind = 'paren';
    else if (inDialogue) kind = 'dialogue';
    else if (previousBlank && (FORCED_CHARACTER.test(text) || isCharacter(text))) kind = 'character';
    else kind = 'action';

    if (kind === 'character') inDialogue = true;
    else if (kind !== 'dialogue' && kind !== 'paren') inDialogue = false;

    out.push({ number: index + 1, kind, text: raw });
    previousBlank = false;
  }

  return out;
}

/** 场景列表用的条目：场景 + 分节（分节当分组标题，点它也能跳）。 */
function extractOutline(text: string): readonly FountainLine[] {
  return classifyFountain(text.split('\n')).filter(
    (line) => line.kind === 'scene' || line.kind === 'section',
  );
}

const LINE_CLASS: Partial<Record<LineKind, string>> = {
  title: 'cm-fountain-title',
  scene: 'cm-fountain-scene',
  section: 'cm-fountain-section',
  character: 'cm-fountain-character',
  dialogue: 'cm-fountain-dialogue',
  paren: 'cm-fountain-paren',
  transition: 'cm-fountain-transition',
  center: 'cm-fountain-center',
  lyrics: 'cm-fountain-lyrics',
  note: 'cm-fountain-note',
  boneyard: 'cm-fountain-boneyard',
  pagebreak: 'cm-fountain-pagebreak',
};

/** 按行号区间生成行装饰。只处理视口内的行。 */
function decorate(view: EditorView, lines: readonly FountainLine[]): DecorationSet {
  const doc = view.state.doc;
  const builder = new RangeSetBuilder<Decoration>();

  for (const line of lines) {
    if (line.number > doc.lines) break;
    const css = LINE_CLASS[line.kind];
    if (!css) continue;
    const docLine = doc.line(line.number);
    if (docLine.to < view.viewport.from || docLine.from > view.viewport.to) continue;
    builder.add(docLine.from, docLine.from, Decoration.line({ class: css }));
  }

  return builder.finish();
}

/**
 * 装饰扩展。
 *
 * ── 全量分类 + 缓存 ────────────────────────────────────────
 * 分类结果只在**文本变化**时重算（一次线性扫描），滚动时只重挂装饰。
 * 反过来做（滚动也重新分类）会让滚动变成 O(行数)：状态机必须从文档
 * 开头累积，几千行的剧本每帧扫一遍，滚动就肉眼可见地掉帧。
 *
 * `isActive` 由插件维护：非 fountain 文档直接清空，一行都不扫 ——
 * 这个扩展对所有文件常驻，不能成为 .md 用户的成本。
 */
function fountainDecorations(isActive: () => boolean): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      #classified: readonly FountainLine[] = [];
      #active = false;

      constructor(view: EditorView) {
        this.#recompute(view);
      }

      update(update: ViewUpdate): void {
        const active = isActive();
        if (update.docChanged || active !== this.#active) {
          this.#active = active;
          this.#recompute(update.view);
          return;
        }
        if (update.viewportChanged) {
          this.decorations = decorate(update.view, this.#classified);
        }
      }

      #recompute(view: EditorView): void {
        const active = isActive();
        this.#active = active;
        if (!active) {
          this.#classified = [];
          this.decorations = Decoration.none;
          return;
        }
        const doc = view.state.doc;
        const lines: string[] = [];
        lines.length = doc.lines;
        for (let number = 1; number <= doc.lines; number += 1) {
          lines[number - 1] = doc.line(number).text;
        }
        this.#classified = classifyFountain(lines);
        this.decorations = decorate(view, this.#classified);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

function createView(context: PluginContext): ViewProvider {
  return {
    render(container) {
      const body = document.createElement('div');
      body.className = 'view-body';
      container.append(body);

      const header = document.createElement('div');
      header.className = 'fountain-scenes__header';

      const list = document.createElement('div');
      list.className = 'fountain-scenes__list';

      body.append(header, list);

      let disposed = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const render = (): void => {
        if (disposed) return;
        header.textContent = '';
        list.textContent = '';

        if (context.editor.activeLanguage !== LANGUAGE_ID) {
          const note = document.createElement('p');
          note.className = 'view-empty';
          note.textContent = t('view.notScreenplay');
          list.append(note);
          return;
        }

        const items = extractOutline(context.editor.getText());
        const scenes = items.filter((item) => item.kind === 'scene').length;

        if (items.length === 0) {
          const note = document.createElement('p');
          note.className = 'view-empty';
          note.textContent = t('view.noScenes');
          list.append(note);
          return;
        }

        header.textContent = `${String(scenes)} · ${t('view.scenes')}`;

        for (const item of items) {
          const row = document.createElement('button');
          row.type = 'button';
          row.className =
            'tree-item fountain-scene' +
            (item.kind === 'section' ? ' fountain-scene--section' : '');

          const number = document.createElement('span');
          number.className = 'fountain-scene__line';
          number.textContent = String(item.number);

          const text = document.createElement('span');
          text.className = 'fountain-scene__text';
          text.textContent = item.text.trim();

          row.append(number, text);
          row.addEventListener('click', () => context.editor.revealLine(item.number));
          list.append(row);
        }
      };

      /*
       * 编辑时防抖 200ms：剧本里敲一个字母就重建整张场景表，
       * 在长剧本上会让侧栏一直在闪。
       */
      const schedule = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          render();
        }, 200);
      };

      const docSubscription = context.editor.onDidChangeDocument(schedule);
      /* 换文件必须立刻刷新 —— 等 200ms 会短暂显示上一个剧本的场景 */
      const fileSubscription = context.editor.onDidChangeActiveFile(() => render());

      render();

      return {
        dispose() {
          disposed = true;
          if (timer !== null) clearTimeout(timer);
          docSubscription.dispose();
          fileSubscription.dispose();
        },
      };
    },
  };
}

function activate(context: PluginContext): void {
  const provider = createView(context);

  context.subscriptions.push(
    context.window.registerView(
      { id: VIEW_ID, title: '场景', location: 'sidebar', order: 3, languages: [LANGUAGE_ID] },
      provider,
    ),
  );

  /*
   * 装饰扩展常驻挂载，由 activeLanguage 决定是否生效。
   *
   * 这里必须用"常驻 + 开关"而不是"进 fountain 才注册"——
   * registerExtension 的槽不能按文件反复重配（那需要视图入口，
   * 插件拿不到），而开关一个布尔量的成本是零。
   */
  context.subscriptions.push(
    context.editor.registerExtension(() =>
      /*
       * 源码模式下必须让路：用户按 Ctrl+/ 要求看原始标记时，
       * 装饰再把行改得"像剧本"就是把源码视图盖住了。
       */
      fountainDecorations(
        () => context.editor.activeLanguage === LANGUAGE_ID && !context.editor.sourceMode,
      ),
    ),
  );
}

const manifest: PluginManifest = {
  id: 'aropyt.fountain',
  name: 'Fountain',
  version: '0.1.0',
  engines: { aropyt: '^0.1.0' },
  activationEvents: [`onView:${VIEW_ID}`, `onLanguage:${LANGUAGE_ID}`],
  contributes: {
    languages: [{ id: LANGUAGE_ID, aliases: ['screenplay'], extensions: ['fountain'] }],
    /*
     * 标题写**中文原文**，不在这里调用 `t()`。
     *
     * manifest 是模块顶层静态对象，import 时执行一次 —— 那时语言还没从
     * 配置里读出来，`t()` 拿到的是启动瞬间的默认语言（实测：界面切成英文后，
     * 侧栏仍显示「Expand "场景"」）。翻译交给渲染层的 `commandTitle()`
     * （见 i18n 的 COMMAND_TITLES），与文件/大纲两个视图一致。
     */
    views: [{ id: VIEW_ID, title: '场景', location: 'sidebar', order: 3, languages: [LANGUAGE_ID] }],
  },
};

export const fountainPlugin: LoadablePlugin = { manifest, activate };
