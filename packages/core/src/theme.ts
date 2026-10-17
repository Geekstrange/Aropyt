import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';

/**
 * 内核主题完全由 CSS 变量驱动，不硬编码颜色。
 * 这样同一份内核在 PWA / Tauri 桌面 / Android 壳里都能跟随宿主主题，
 * 不需要为每个平台维护一套色板。
 */
export const aropytEditorTheme: Extension = EditorView.theme(
  {
    '&': {
      color: 'var(--md-text)',
      backgroundColor: 'transparent',
      height: '100%',
      fontSize: 'var(--md-font-size)',
    },
    '&.cm-focused': { outline: 'none' },
    /*
     * 模式专属样式一律**带模式类前缀**。
     *
     * 为什么必须这样，而不是"渲染层的扩展排在后面就行"：
     * `.cm-scroller { font-mono }`（这里）与 `.cm-scroller { font-sans }`
     * （渲染层）**特异性完全相同**，谁赢只取决于 CM6 生成 CSS 的顺序 ——
     * 而那与扩展在数组里的位置并不一一对应（Compartment 里配置的
     * 扩展在初始化时就注入了，反而更早）。实测结果是等宽赢了，
     * 于是渲染态正文变成等宽字体，**零报错**。
     *
     * 加上 `&.aropyt-source-mode` / `&.aropyt-render-mode` 之后，
     * 两条选择器**互斥**（同一时刻根节点上只有一个模式类），
     * 谁也压不住谁 —— 顺序从此无关紧要。这比"记住把谁排后面"可靠得多。
     *
     * 代价是每写一条模式样式都要多打一个前缀；收益是改样式时
     * 不再需要先猜"到底哪条在生效"。
     */
    '&.aropyt-source-mode .cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.75',
      overflow: 'auto',
    },
    /*
     * ⚠️ 渲染态（Typora 模式）的样式**不在这里定义**。
     *
     * 这里曾经有三条 `&.aropyt-render-mode ...` 规则（无衬线字体、
     * 收窄的正文宽度、行 padding）。它们与渲染层自己主题里的同名规则
     * **重复**，而且带 `.aropyt-render-mode` 前缀后特异性更高
     * （2 个 class vs 1 个），于是**静默压住了渲染层的定义**。
     *
     * 症状：在渲染层改样式完全没反应，而在这一层改才有 ——
     * 一个"改错文件"的错觉。实测先例是 `max-width: 46em`，
     * 在渲染层删掉后宽度依然 690px。
     *
     * 现在渲染态样式**只有一处 owner**：`wysiwyg/inline-render.ts`。
     * 它随渲染扩展一起装载与卸载，切到源码模式时自然消失。
     *
     * 保留本节是为了记住这个坑：**同一样式定义在两处，特异性高的赢，
     * 与扩展顺序无关，而且不会有任何报错。**
     */
    '&.aropyt-source-mode .cm-content': {
      padding: '28px 0 40vh',
      /*
       * 源码模式也必须折行。
       *
       * CM6 默认的 `white-space: pre` 是源码编辑器的惯例，但在这里
       * 有一个连锁后果：长单行把 .cm-content 撑到两千多像素宽，
       * .app-main（flex: 1 1 auto）的 basis 跟着被撑大 ——
       * **并排的预览面板被挤压到 min-width**，用户看到的就是
       * "打开预览后预览窗被挤到没法看"。
       *
       * `pre-wrap` 保住"空白与换行按文档来"，同时允许长行折行；
       * `overflow-wrap: anywhere` 兜底超长 URL / 无空格长串
       * （3000 个连续字符没有断点，pre-wrap 折不了它）。
       */
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      /*
       * ⚠️ CM6 给 .cm-content 设了 `flex-shrink: 0; flex-grow: 2`
       * （永不收缩）。渲染态在 inline-render.ts 里补过这两个，
       * 源码模式**同样必须补** —— 不补的话，pre-wrap 就算生效，
       * content 本身还是不肯变窄，横向溢出依旧（实测 26054px）。
       * MEMORY 已有此坑的渲染态版本，这里是源码模式的同一颗雷。
       */
      flexShrink: '1',
      minWidth: '0',
    },
    /*
     * .cm-line 自己也设了 white-space: pre（CM6 的另一处），
     * 不跟着改的话 content 折了、line 还是单行不折。
     */
    '&.aropyt-source-mode .cm-line': {
      padding: '0 28px',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    },
    /* 光标颜色两种模式都要，所以不带前缀。 */
    '.cm-content': { caretColor: 'var(--md-accent)' },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--md-accent)',
      borderLeftWidth: '2px',
    },
    /*
     * 选区高亮。
     *
     * ⚠️ 选择器必须与 CM6 自带的**同等特异性**，否则压不住。
     * CM6 的 baseTheme 里有四条：
     *   &light .cm-selectionBackground
     *   &dark  .cm-selectionBackground
     *   &light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground
     *   &dark .cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground
     * 后两条带了 `.cm-focused > .cm-scroller > .cm-selectionLayer`
     * 共 3 个额外 class，**特异性比单个 `.cm-selectionBackground` 高得多**。
     *
     * 结果：写 `.cm-selectionBackground { background: var(--md-selection) }`
     * 看着有、实则完全无效 —— 实测计算值是 CM6 默认的
     * `rgb(34,51,51)`（深青灰），在浅色主题下就是一块黑，
     * 选中的字被盖住看不清。
     *
     * 所以下面这条**照抄 CM6 的结构**（同样的 class 数量与层级），
     * 靠"后注入者胜"取胜。这不是偷懒写法，是唯一能压住的办法 ——
     * `:is()` 之类的等价写法特异性仍不同。
     */
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: 'var(--md-selection)',
    },
    '.cm-content ::selection': {
      backgroundColor: 'var(--md-selection)',
    },
    '.cm-activeLine': { backgroundColor: 'var(--md-active-line)' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--md-muted)',
      border: 'none',
      paddingLeft: '8px',
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--md-text)' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--md-surface-2)',
      border: 'none',
      color: 'var(--md-muted)',
      padding: '0 6px',
      borderRadius: '4px',
    },
    '.cm-selectionMatch': { backgroundColor: 'var(--md-selection)' },
    '.cm-searchMatch': {
      backgroundColor: 'var(--md-selection)',
      outline: '1px solid var(--md-accent)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--md-surface-2)',
      border: '1px solid var(--md-border)',
      borderRadius: '8px',
      color: 'var(--md-text)',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: 'var(--md-accent)',
      color: 'var(--md-accent-contrast)',
    },
  },
  { dark: true },
);

/**
 * Markdown 语法着色。刻意压低标点标记的对比度 —— 源码标记应该退到背景里，
 * 正文才是主体。这一点 Typora 做得对，值得学。
 */
export const aropytHighlightStyle: Extension = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading1, color: 'var(--md-h1)', fontWeight: '500' },
    { tag: tags.heading2, color: 'var(--md-h2)', fontWeight: '500' },
    { tag: tags.heading3, color: 'var(--md-h3)', fontWeight: '500' },
    { tag: tags.heading4, color: 'var(--md-h4)', fontWeight: '500' },
    { tag: tags.heading5, color: 'var(--md-h5)', fontWeight: '500' },
    { tag: tags.heading6, color: 'var(--md-h6)', fontWeight: '500' },
    { tag: tags.strong, color: 'var(--md-text)', fontWeight: '500' },
    { tag: tags.emphasis, color: 'var(--md-text)', fontStyle: 'italic' },
    { tag: tags.strikethrough, color: 'var(--md-muted)', textDecoration: 'line-through' },
    { tag: tags.link, color: 'var(--md-link)' },
    { tag: tags.url, color: 'var(--md-muted)' },
    { tag: tags.monospace, color: 'var(--md-code)' },
    { tag: tags.quote, color: 'var(--md-muted)', fontStyle: 'italic' },
    { tag: tags.list, color: 'var(--md-marker)' },
    { tag: tags.processingInstruction, color: 'var(--md-marker)' },
    { tag: tags.contentSeparator, color: 'var(--md-marker)' },
    { tag: tags.punctuation, color: 'var(--md-marker)' },
    { tag: tags.keyword, color: 'var(--md-syntax-keyword)' },
    { tag: tags.string, color: 'var(--md-syntax-string)' },
    { tag: tags.number, color: 'var(--md-syntax-number)' },
    { tag: tags.bool, color: 'var(--md-syntax-number)' },
    { tag: tags.typeName, color: 'var(--md-syntax-type)' },
    { tag: tags.comment, color: 'var(--md-muted)', fontStyle: 'italic' },
    { tag: tags.operator, color: 'var(--md-syntax-keyword)' },
    { tag: tags.variableName, color: 'var(--md-text)' },
    { tag: tags.labelName, color: 'var(--md-link)' },
  ]),
);
