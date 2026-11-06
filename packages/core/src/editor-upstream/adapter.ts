/**
 * 原版渲染层 ↔ 宿主 `EditorAdapter` 的接线。
 *
 * 宿主已有 `EditorAdapter`（vim、搜索、主题、字数统计、模式切换都挂在它
 * 上面），不能整个换成 `DocEditor`。这里只把**渲染相关的扩展**暴露出来，
 * 由宿主按 Compartment 注入；其余能力仍由宿主自己的扩展提供。
 *
 * 三件必须在宿主侧完成的事：
 *   1. 应用启动时调 `initUpstreamRenderer()` 注册块渲染器；
 *   2. 状态里常驻 `upstreamRenderExtensions()`（**不随模式切换**，见下）；
 *   3. `new EditorView` **之后**调 `mountUpstreamHost()` 挂宿主、装公式观察器
 *      并补一次重绘。
 *
 * 第 3 步不能省：`DocEditor` 构造顺序是 `new EditorView` 在前、`__host`
 * 赋值在后，首帧 widget 拿不到宿主，公式会退化成纯文本。
 */

import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import katex from 'katex';

import {
  rebuild,
  setBlockRenderer,
  setSingleBlockRenderer,
  upstreamRenderFields,
  type EditorHost,
} from './editor.js';
import { blockRanges, renderDocument } from './md.js';
import { rememberDiagram } from './diagram-preview.js';

/**
 * 属性转义。只处理会破坏属性值的那几个字符 —— 公式源码里 `"` 和 `&`
 * 都很常见（`a & b`、`\text{"x"}`），不转义会让占位元素整个错位。
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 占位元素的类名。所有公式路径最终都产出它，再由 `hydrate` 换成真内容。 */
const MATH_PLACEHOLDER = 'aropyt-math';

/**
 * 公式的渲染**委托**成占位元素，而不是直接返回 KaTeX 的 HTML。
 *
 * 三条路径产出公式：`md.ts` 的块级规则、`.md-inline-math` 占位、
 * 表格单元格里的 `md-table-math-preview`。它们分别在 `enhance`、
 * widget 的 `toDOM`、原版 `refreshTableMedia` 里被写入 —— 后两条不经过
 * `enhance`，所以统一返回占位、由 `mountUpstreamHost` 装的
 * MutationObserver 接管，才能一处不漏。
 */
function renderMath(tex: string, display: boolean): string {
  return `<span class="${MATH_PLACEHOLDER}" data-tex="${escapeAttr(tex)}" data-display="${display ? '1' : '0'}"></span>`;
}

/*
 * 公式渲染进 Shadow DOM。
 *
 * 宿主侧有三套 CSS 会渗进公式内部：原版的 app.css / 主题 CSS（它们本来
 * 不用 KaTeX，没有保护规则）、主项目 styles.css、以及 CM6 动态注入的
 * `lineWrapping`（white-space: break-spaces）。逐条补 display / white-space
 * 或提升 katex.min.css 优先级都挡不住 —— 实测分式、积分号、上下限会竖排。
 *
 * 影子树里只有 KaTeX 自己的 CSS，是唯一确定的隔离边界。
 */
let katexCss: Promise<string> | null = null;

function loadKatexCss(): Promise<string> {
  if (!katexCss) {
    katexCss = fetch('/vendor/katex/katex.min.css')
      .then((response) => response.text())
      .then((css) => css.replace(/url\(fonts\//g, 'url(/vendor/katex/fonts/'))
      .catch(() => '');
  }
  return katexCss;
}

function hydrate(el: HTMLElement): void {
  if (el.dataset.hydrated === '1') return;
  el.dataset.hydrated = '1';

  const tex = el.dataset.tex ?? '';
  const display = el.dataset.display === '1';

  void loadKatexCss().then((css) => {
    if (!el.isConnected) {
      /* 元素已经被 CM6 换掉了：清掉标记，下次重建还能再来一次 */
      delete el.dataset.hydrated;
      return;
    }
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    try {
      shadow.innerHTML = `<style>${css}</style>${katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
      })}`;
    } catch {
      shadow.textContent = tex;
    }
  });
}

/** 扫描并填充某个子树里的所有公式占位。 */
function hydrateAll(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(`.${MATH_PLACEHOLDER}`))) {
    hydrate(el);
  }
}

interface MermaidLike {
  initialize(config: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

let mermaidReady: Promise<MermaidLike | null> | null = null;

/**
 * 加载 mermaid。
 *
 * 用项目自己的依赖（v12）而不是原版那份静态 UMD：`quadrantChart` 这类较新
 * 的图表在老版本里只会画出半张空框（实测坐标轴标签竖排、数据点缺失）。
 *
 * 动态 `import()` 让它单独成块，不进首屏预算。
 */
function loadMermaid(): Promise<MermaidLike | null> {
  if (mermaidReady) return mermaidReady;
  mermaidReady = (async () => {
    try {
      const mod = await import('mermaid');
      const mermaid = ((mod as unknown as { default?: MermaidLike }).default ??
        mod) as MermaidLike;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'default' });
      return mermaid;
    } catch (error) {
      console.warn('mermaid 加载失败', error);
      return null;
    }
  })();
  return mermaidReady;
}

let renderSeq = 0;

/**
 * 填充块渲染器留下的占位元素。
 *
 * `md.ts` 只输出占位：
 *   `<span class="md-inline-math" data-tex="...">…</span>`
 * 真正的内容由这里生成。漏掉它的表现是"公式原样露在文字里"，而识别、
 * 解析、块渲染全都正常，没有任何报错。
 */
function enhance(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.md-math-block'))) {
    if (el.dataset.rendered) continue;
    el.innerHTML = renderMath(el.dataset.tex ?? '', true);
    el.dataset.rendered = '1';
  }

  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.md-inline-math'))) {
    if (el.dataset.rendered) continue;
    /* 行内公式 widget 自带 `data-tex`，直接换成占位再统一 hydrate */
    el.innerHTML = renderMath(el.dataset.tex ?? '', false);
    el.dataset.rendered = '1';
  }

  hydrateAll(root);

  const diagrams = Array.from(root.querySelectorAll<HTMLElement>('.md-diagram')).filter(
    (el) => !el.dataset.rendered,
  );
  for (const diagram of diagrams) {
    /* 异步回来时若已被新的请求取代，旧结果必须丢弃 */
    const request = String(++renderSeq);
    diagram.dataset.renderRequest = request;

    void (async () => {
      const mermaid = await loadMermaid();
      if (!mermaid || !diagram.isConnected || diagram.dataset.renderRequest !== request) return;

      const source =
        diagram.dataset.source ?? diagram.querySelector('.md-diagram-pending')?.textContent ?? '';
      try {
        const { svg } = await mermaid.render(`mmd-${request}`, source);
        if (!diagram.isConnected || diagram.dataset.renderRequest !== request) return;

        const line = Number(diagram.closest<HTMLElement>('.md-block-widget')?.dataset.line);
        if (line) rememberDiagram(source, line, svg);

        diagram.innerHTML = svg;
        diagram.dataset.rendered = '1';
      } catch (error) {
        if (!diagram.isConnected || diagram.dataset.renderRequest !== request) return;
        diagram.innerHTML = `<div class="md-diagram-panel-error">${String(error)}</div>`;
        diagram.dataset.rendered = '1';
      }
    })();
  }
}

const host: EditorHost = {
  docDir: () => undefined,
  math: renderMath,
  resolveSrc: (src: string) => src,
  enhance,
  language: () => 'zh',
};

/** 应用启动时调用一次：把文档切块与块内渲染接进原版内核。 */
export function initUpstreamRenderer(): void {
  setBlockRenderer(blockRanges);
  setSingleBlockRenderer(
    (source) => renderDocument(source, { math: renderMath }).html || null,
  );
}

/** 渲染态要注入的 CM6 扩展。与模式无关，只与语言有关。 */
export function upstreamRenderExtensions(): Extension[] {
  return [
    upstreamRenderFields.preferenceField.init(() => ({})),
    upstreamRenderFields.modeField,
    upstreamRenderFields.draftHeadingField,
    upstreamRenderFields.fenceSelection,
    upstreamRenderFields.searchHighlightField,
    upstreamRenderFields.decorationField,
    upstreamRenderFields.inlineMathTooltip,
    upstreamRenderFields.footnotePreview,
    upstreamRenderFields.fenceKeymap,
    upstreamRenderFields.pairInput,
    EditorView.lineWrapping,
  ];
}

/** 切换原版内核的源码态（清空装饰，源码露出来）。 */
export { setSourceMode as upstreamSetSourceMode } from './editor.js';

const observers = new WeakMap<EditorView, MutationObserver>();

/**
 * 挂宿主 + 装公式观察器 + 补首帧重绘。
 *
 * 必须在 `new EditorView` **之后**调用。widget 在构造时就已 `toDOM` 过，
 * 那时 `__host` 还是空的，只有 `rebuild` 触发的重建才会重新走渲染。
 *
 * 观察器负责**所有**不经过 `enhance` 的公式：表格单元格由原版
 * `refreshTableMedia` 直接写 innerHTML，行内公式由 widget 自己 `toDOM`。
 */
export function mountUpstreamHost(view: EditorView): void {
  (view as unknown as { __host: EditorHost }).__host = host;

  const previous = observers.get(view);
  if (previous) previous.disconnect();

  const observer = new MutationObserver(() => hydrateAll(view.dom));
  observer.observe(view.dom, { childList: true, subtree: true });
  observers.set(view, observer);

  view.dispatch({ effects: rebuild.of() });
  hydrateAll(view.dom);
}
