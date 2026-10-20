/**
 * Typora 式原地渲染 —— 把 Markdown 标记"藏起来"，让编辑区本身即预览。
 *
 * ── 为什么能做到 ──────────────────────────────────────────
 * CodeMirror 的文档始终是**纯 Markdown 源码**（文件即真理不变），
 * 我们只改变"怎么画"：用 Decoration 把标记符号替换掉、
 * 给内容加样式。复制粘贴出来的仍是源码，光标定位仍在字符级。
 * 这比"渲染成富文本再反向同步"安全得多 —— 后者意味着两份文档模型。
 *
 * ── Typora 的关键交互 ────────────────────────────────────
 * 不是"永远隐藏标记"。Typora 的实际行为是：
 *   - 光标**不在**该行时 → 标记隐藏，内容按格式显示
 *   - 光标**在**该行时 → 标记重新显形，让你看得见自己在改什么
 *
 * 这一条是"能不能用"的分水岭。永远隐藏标记会让用户失去方向感
 * （我到底在第几级标题里？）；永远显示标记就等于没做。
 *
 * ── IME（中文输入）是硬约束 ─────────────────────────────────
 * 装饰集合必须在**组合期间冻结**。原因：输入法组合时文档里有临时文本，
 * 若此时重建装饰，CM6 会拿组合中的偏移去测当前行归属，
 * 结果是拼音被打断、光标跳走 —— 中文输入直接不可用。
 *
 * 这一点无法靠"小心处理"绕开，只能显式检测 `view.composing`：
 * 组合开始时快照当前装饰，组合结束后再重算。
 * 代码里所有重算入口都先过这道闸。
 */

import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { EditorState, StateEffect, StateField, type Text } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';


/**
 * 会被隐藏的标记符号。
 *
 * 只列"纯符号"的节点。像 `Link`（`[文字](url)`）不能整体隐藏 ——
 * 那是内容，得替换成可点击的文字而不是删掉。
 */
const MARKER_TYPES = new Set([
  'HeaderMark',
  'EmphasisMark',
  'ListMark',
  'QuoteMark',
  'CodeMark',
  'SetextUnderline',
  /*
   * 下面这四个是**按 test.md 的语法树 dump 找出来的缺口**。
   *
   * 之前的覆盖清单只写了"看起来该藏的"，没拿语法树的节点表对过账，
   * 于是这些标记在渲染态原样挂在文字旁边（60 处转义、9 处引用式链接、
   * 2 处自动链接的尖括号、6 处 HTML 标签）。
   * 判断依据是 `scripts/dump-md-tree.mjs` 的输出，不是肉眼扫。
   */
  'LinkLabel',
  'LinkTitle',
  'HTMLTag',
  'Escape',
]);

/**
 * 引用式链接的**定义行**（`[ref-1]: https://example.com "Example"`）。
 *
 * 整个节点就是那一行，渲染态下必须整行藏掉 —— 它是给解析器看的元数据，
 * 显示出来对读者毫无意义（读者看的是 `[点这里][ref-1]` 里的文字）。
 */
const DEFINITION_TYPES = new Set(['LinkReference']);

/**
 * 需要隐藏的**成对**标记：单侧隐藏会让文本看起来只剩一半。
 *
 * StrikethroughMark 是 `~~`，实测（@lezer/markdown 的 GFM 扩展）
 * 它是 Strikethrough 的两个子节点，与 EmphasisMark 同构 ——
 * 所以走同一套"同长度两两配对"的逻辑即可。
 * 之前漏了它，于是 `~~删除线~~` 在渲染态是两个波浪号原样挂在文字两边。
 */
const PAIRED_MARKERS = new Set(['EmphasisMark', 'CodeMark', 'StrikethroughMark']);

/**
 * 链接与图片的包装符号（`[`、`]`、`(`、`)`）与目标 URL。
 *
 * 拆开处理的理由：链接要**留下文字**、丢掉包装；图片要**整体换成图**。
 * 两者在语法树里长得一样（都是 LinkMark × 4 + URL），只能靠父节点区分。
 *
 * ⚠️ 父节点有**三种**，不只 Link：
 *   Link        `[百度](url)`
 *   Autolink    `<https://x.com>` —— 尖括号也是 LinkMark，目标也是 URL
 *   LinkReference / Image —— 引用式写法 `[x][ref]` / `![x][ref]`
 * 原来的判据只写了 `parent === 'Link'`，于是自动链接的尖括号与
 * 引用式链接的方括号全都没被藏起来（dump 显示 LinkMark 出现 36 次，
 * 真正被处理掉的只有父节点为 Link 的那部分）。
 */
const LINK_WRAPPER_PARENTS = new Set(['Link', 'Autolink']);
const LINK_PARTS = new Set(['LinkMark', 'URL']);

/**
 * 隐藏一个标记用的**行内装饰**。
 *
 * ── 为什么不用 Decoration.replace({}) ──────────────────────────
 *
 * `Decoration.replace` 会被 CM6 归类为"不可编辑的内联内容"，
 * 于是它在**每个**替换范围的两侧插入 `<img class="cm-widgetBuffer">`
 * （CM6 源码注释直说了："drawn around uneditable widgets to
 * avoid a number of browser bugs"）。实测一行含 5 种标记时
 * 会插进 26 个 `<img>`。
 *
 * 这些 `<img>` 是纯 DOM 负担：不参与渲染、不可选中、却要被
 * 布局与命中测试遍历一遍。所以改用 `Decoration.mark` + CSS
 * `display: none`，视觉效果完全相同而 DOM 干净得多。
 *
 * ── 一条必须记下的实测结论 ──────────────────────────────────
 *
 * 我一度断言"widgetBuffer 打断了浏览器原生选区，所以拖不中字"。
 * **这个因果被自己的实验推翻了**：把这行改回 `Decoration.replace`
 * 之后，`check-selection` 的全部断言依然通过（拖选拿到
 * `AAA**粗体**`、选区跨 2 个视觉行、双击选中「粗体」）。
 *
 * 真正的表象成因是**探针自己的坐标算错** —— 那几轮里
 * 灌文档用的是 `insertText`（不 `selectAll`），文档与初始内容叠在一起，
 * 行号对不上，于是"单击落在第 3 行、目标在第 2 行"这类假象接连出现。
 *
 * 留下这条记录是因为：**改实现前先用受控对照实验确认因果**，
 * 否则就会把一个测错的探针当成产品缺陷去修，越修越偏。
 *
 * ── 代价 ────────────────────────────────────────────────────
 *
 * 隐藏的标记无法被鼠标直接选到（本就看不见，也无从选中）；
 * 光标能停在它前后 —— 用户在光标行看到的是显形版本，不冲突。
 * `display: none` 让这些字符不参与文字测量，这正是我们要的
 * （渲染态不该为看不见的符号留位置）。
 */
function hideMarker(): Decoration {
  return Decoration.mark({ class: 'cm-md-hidden-mark' });
}

/**
 * 段落级样式。key 是 CM6 class 名，value 追加到编辑器主题里。
 *
 * 为什么不用 markdown-it 的 class：那会引入一份 HTML class 词汇表，
 * 而编辑器主题本来就该由内核控制。渲染层只负责"这是哪类结构"。
 */
const BLOCK_CLASSES: Record<string, string> = {
  ATXHeading1: 'cm-md-h1',
  ATXHeading2: 'cm-md-h2',
  ATXHeading3: 'cm-md-h3',
  ATXHeading4: 'cm-md-h4',
  ATXHeading5: 'cm-md-h5',
  ATXHeading6: 'cm-md-h6',
  SetextHeading1: 'cm-md-h1',
  SetextHeading2: 'cm-md-h2',
  Blockquote: 'cm-md-quote',
  BulletList: 'cm-md-list',
  OrderedList: 'cm-md-list',
  ListItem: 'cm-md-list-item',
  FencedCode: 'cm-md-code',
  CodeBlock: 'cm-md-code',
  HorizontalRule: 'cm-md-hr',
  Table: 'cm-md-table',
  /*
   * 表头与数据行分开染色 —— 原预览窗的表格是真 <table>（表头加粗、
   * 行间分隔、天然对齐），编辑区是行内 mark，做不到列对齐，
   * 但"表头加粗 + 行分隔 + 等宽"能把表格的**观感**补回来大半。
   */
  TableHeader: 'cm-md-table-head',
  TableRow: 'cm-md-table-row',
};

/**
 * 行内样式。
 *
 * Emphasis 节点覆盖标记与内容（`**粗体**` 整体），
 * 标记单独隐藏，所以这里只需给内容加粗/倾斜。
 */
const INLINE_CLASSES: Record<string, string> = {
  StrongEmphasis: 'cm-md-strong',
  Emphasis: 'cm-md-em',
  InlineCode: 'cm-md-inline-code',
  Link: 'cm-md-link',
  Image: 'cm-md-image',
  Strikethrough: 'cm-md-strike',
  // 表格的行内竖线。不藏掉（藏了单元格会连成一串），只压低对比度，
  // 让 `| 列 A | 列 B |` 读起来像表格而不是源码。
  TableDelimiter: 'cm-md-vbar',
};

// ── Widget：把"一段源码"换成"一个东西" ──────────────────────
//
// 与"隐藏标记"的区别：隐藏只是让符号不见了，内容还是文本；
// 图片/分隔线/复选框没有对应的文本形态，必须画出来。
//
// 全部用 Decoration.replace 覆盖整个节点。注意它们**只能是单行**的 ——
// 跨行的 block 装饰不允许由 ViewPlugin 提供（CM6 的限制），
// 表格这种多行块要画成真表格就得换成 StateField，那是另一件事。

/** 把图片地址变成可用的 src。宿主注入 —— 内核不知道工作区在哪。 */
export type AssetResolver = (url: string) => Promise<string | null>;

/** 已经是绝对地址的（http:、data:、blob:、//…）直接用，不必问宿主。 */
const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * 图片。
 *
 * 工作区里的图片只能拿到**相对路径**，而相对路径在 WebView 里是取不到的
 * （既不是 http 也不是 file），所以要把字节读出来转成 data URL。
 * 这件事只有宿主能做，内核通过 resolveAsset 拿结果。
 */
class ImageWidget extends WidgetType {
  constructor(
    private readonly url: string,
    private readonly alt: string,
    private readonly resolveAsset: AssetResolver | undefined,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.url === this.url && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const figure = document.createElement('span');
    figure.className = 'cm-md-image-figure';

    const img = document.createElement('img');
    img.className = 'cm-md-image-img';
    img.alt = this.alt;
    // 不设 draggable=false 的话，在图片上按下会拖出一个幽灵图像，
    // 而拖拽又不会真的移动任何东西 —— 用户会以为编辑器卡了。
    img.draggable = false;
    figure.append(img);

    const fallback = (): void => {
      figure.replaceChildren();
      const note = document.createElement('span');
      note.className = 'cm-md-image-missing';
      // 图片加载失败是**静默**的：<img> 不会抛异常，
      // 不显示任何东西的后果是"这里本来就没图"和"图没加载出来"无法区分。
      note.textContent = this.alt ? `（图片无法显示：${this.alt}）` : '（图片无法显示）';
      figure.append(note);
    };

    if (ABSOLUTE_URL.test(this.url)) {
      img.addEventListener('error', fallback);
      img.src = this.url;
    } else if (this.resolveAsset) {
      void this.resolveAsset(this.url)
        .then((src) => {
          if (!src) {
            fallback();
            return;
          }
          img.addEventListener('error', fallback);
          img.src = src;
        })
        .catch(fallback);
    } else {
      fallback();
    }

    return figure;
  }

  /** 让 CM6 自己处理事件：点在图上等于点在那个位置，光标自然落上去并显形源码。 */
  ignoreEvent(): boolean {
    return true;
  }
}

/** 分隔线：`---` 不画成一条线的话，读者看到的就是三个减号。 */
class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const line = document.createElement('span');
    line.className = 'cm-md-hr-line';
    return line;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * 任务复选框。
 *
 * 目前**只渲染不可点**：把 `[ ]` / `[x]` 画成方框，但点击不会改动文档。
 * 可点需要把 widget 映射回文档位置并在其上分发 change，
 * 那属于"编辑操作"，与这里"只影响怎么画"的职责边界不同，单独做。
 */
class TaskWidget extends WidgetType {
  constructor(private readonly checked: boolean) {
    super();
  }

  eq(other: TaskWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(): HTMLElement {
    const box = document.createElement('span');
    box.className = `cm-md-task${this.checked ? ' cm-md-task--done' : ''}`;
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.checked));
    box.setAttribute('aria-disabled', 'true');
    return box;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/*
 * ── 块级渲染引擎（markdown-it）────────────────────────────────
 *
 * 装饰近似（隐藏标记 + 样式 mark）永远到不了"与预览窗完全一致"：
 * 表格没有真布局、HTML 标签只能近似、typographer 无法做。
 * 所以非光标块**整体替换**为 markdown-it 渲染出的 HTML（块级 WYSIWYG），
 * 光标所在块显示源码供编辑 —— 这正是 Typora 的架构：
 * 渲染引擎只有一套（markdown-it），编辑区与预览窗的输出**必然一致**。
 *
 * 引擎走动态 import（markdown-it + highlight.js 不进首屏，见 check:bundle）。
 * 就绪前所有块显示源码，就绪后通过 effect 触发一次重建。
 */
type MarkdownEngine = { renderMarkdown(source: string): string };

let engine: MarkdownEngine | null = null;
let enginePromise: Promise<MarkdownEngine> | null = null;

function ensureEngine(): Promise<MarkdownEngine> {
  enginePromise ??= import('../markdown.js').then((m) => {
    engine = m;
    return m;
  });
  return enginePromise;
}

const isEngineReady = (): boolean => engine !== null;

/** 引擎就绪后要通知的视图（dispatch 一个 effect 触发重建）。 */
const pendingViews = new Set<EditorView>();

const engineReadyEffect = StateEffect.define<null>();

/*
 * markdown-it 渲染缓存：块文本 → HTML。
 * 输入时光标块之外的内容文本不变 → 缓存全命中，只有真正变更的块重渲染。
 */
const blockHtmlCache = new Map<string, string>();

function renderBlockCached(source: string): string {
  if (!engine) return '';
  const hit = blockHtmlCache.get(source);
  if (hit !== undefined) return hit;
  const html = engine.renderMarkdown(source);
  if (blockHtmlCache.size > 800) blockHtmlCache.clear();
  blockHtmlCache.set(source, html);
  return html;
}

/*
 * 编辑区不是 iframe，innerHTML 里的 <script> 会真的执行。
 * 原预览窗靠 sandbox 兜底，这里必须自己消毒：
 * 危险元素整个移除，on* 属性与 javascript: 协议一律剥掉。
 */
function sanitizeBlockHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of [...doc.body.querySelectorAll('script,iframe,object,embed,link,meta,base,form')]) {
    el.remove();
  }
  for (const el of [...doc.body.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name === 'src') && value.startsWith('javascript:'))) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML;
}

/** 顶层块节点 → 整体替换为渲染结果。 */
const BLOCK_REPLACE_TYPES = new Set([
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
  'SetextHeading1', 'SetextHeading2',
  'Paragraph', 'BulletList', 'OrderedList', 'Blockquote',
  'FencedCode', 'CodeBlock', 'Table', 'HTMLBlock', 'HorizontalRule',
]);

class BlockWidget extends WidgetType {
  constructor(
    readonly html: string,
    private readonly resolveAsset?: AssetResolver,
  ) {
    super();
  }

  override eq(other: BlockWidget): boolean {
    return other.html === this.html;
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-block';
    wrap.innerHTML = sanitizeBlockHtml(this.html);
    // 数学公式占位 → KaTeX 异步渲染（markdown-it 层只输出 data-tex 占位）
    void hydrateMath(wrap).catch(() => {
      /* 公式渲染失败保留占位 —— 原式在 data-tex 里，内容不丢 */
    });
    // 工作区相对路径的图片在 WebView 里解析不到 —— 与行内图片 widget
    // 相同，走 resolveAsset 转成 data URL（异步，拿到后回填）。
    if (this.resolveAsset) {
      for (const img of [...wrap.querySelectorAll('img')]) {
        const src = img.getAttribute('src') ?? '';
        if (!src || /^https?:|^data:/.test(src)) continue;
        void Promise.resolve(this.resolveAsset(src)).then((url) => {
          if (url) img.setAttribute('src', url);
        }).catch(() => {
          /* 解析失败保留破图占位 —— alt 文本仍在 */
        });
      }
    }
    return wrap;
  }

  override ignoreEvent(): boolean {
    // 点击事件交给 CM6 处理：光标会落到替换范围的边界（块首），
    // 块随即切回源码态 —— 与 Typora"点进段落开始编辑"一致。
    return false;
  }
}

/*
 * ── Mermaid 图表 ────────────────────────────────────────────
 * ```mermaid 代码块不走 markdown-it（highlight.js 不认识它），
 * 由 mermaid 库（动态 import，不进首屏）渲染成 SVG。
 * securityLevel: 'strict' 是 mermaid 的消毒模式，innerHTML 安全。
 */
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, code: string): Promise<{ svg: string }>;
}
let mermaidMod: MermaidApi | null = null;
const mermaidSvgCache = new Map<string, string>();

function mermaidTheme(): 'dark' | 'default' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
}

class MermaidWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }

  override eq(other: MermaidWidget): boolean {
    return other.code === this.code;
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-mermaid';
    // 渲染结果缓存：CM6 滚动销毁/重建视口 DOM 时，toDOM 会被反复调用，
    // mermaid.render 是上百毫秒的重活，绝不能每次都跑。
    const cached = mermaidSvgCache.get(this.code);
    if (cached) {
      wrap.innerHTML = cached;
      return wrap;
    }
    // 渲染完成前先显示源码占位（异步加载 mermaid chunk + render）
    const pre = document.createElement('pre');
    pre.className = 'cm-md-mermaid-src';
    pre.textContent = this.code;
    wrap.appendChild(pre);
    void (async () => {
      try {
        mermaidMod ??= (await import('mermaid')).default as unknown as MermaidApi;
        mermaidMod.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: mermaidTheme(),
        });
        const id = 'mmd-' + Math.random().toString(36).slice(2);
        const { svg } = await mermaidMod.render(id, this.code);
        mermaidSvgCache.set(this.code, svg);
        wrap.innerHTML = svg;
      } catch (err) {
        /*
         * 图表语法错误：保留源码占位并**显示原因** —— 静默回退会让用户
         * 分不清"还没渲染"和"语法不支持"（stateDiagram 用 classDef 的
         * 场景实测踩过：mermaid 状态图不支持 flowchart 的着色指令）。
         */
        pre.className = 'cm-md-mermaid-src cm-md-mermaid-err';
        pre.textContent = `${this.code}\n\n[mermaid 渲染失败：${err instanceof Error ? err.message.slice(0, 120) : '未知错误'}]`;
      }
    })();
    return wrap;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 块级渲染的装饰源。
 *
 * ⚠️ 必须是 **StateField**：CM6 明确禁止 ViewPlugin 提供 block: true 的
 * 装饰（RangeError: Block decorations may not be specified via plugins）。
 * 这一轮栽过 —— MEMORY 里"表格 widget 改 StateField"就是同一颗雷的
 * 上一次爆发。
 */
/**
 * 行级扫描块级数学：`$$ … $$` 与 `\[ … \]`。
 *
 * ⚠️ 为什么不能只依赖 lezer / markdown-it 的块边界：
 * 两者都会把 `+ \frac{...}` 这类以列表符号开头的 tex 行切成**独立的
 * 列表块**，于是数学块被拆成两半、各自找不到闭合定界符，整块退化成
 * 普通文本（"希腊字母与偏导"实测就是这个）。块切分必须在**这一层**
 * 先把数学块整体圈出来，再交给 KaTeX。
 *
 * 返回的 to 是闭合定界符所在行的**行尾**（block widget 要求覆盖整行）。
 */
function scanMathBlocks(doc: Text): { from: number; to: number; tex: string }[] {
  const out: { from: number; to: number; tex: string }[] = [];
  let i = 1;
  while (i <= doc.lines) {
    const line = doc.line(i);
    const trimmed = line.text.trimStart();
    const open = trimmed.startsWith('$$') ? '$$' : trimmed.startsWith('\\[') ? '\\[' : '';
    if (!open) {
      i += 1;
      continue;
    }
    const close = open === '$$' ? '$$' : '\\]';
    // 单行形式：$$x$$ / \[x\]
    const single = trimmed.slice(open.length);
    const singleClose = single.indexOf(close);
    if (singleClose >= 0) {
      out.push({
        from: line.from,
        to: line.to,
        tex: single.slice(0, singleClose).trim(),
      });
      i += 1;
      continue;
    }
    // 多行：找含闭合定界符的行
    let found = -1;
    for (let j = i + 1; j <= doc.lines; j += 1) {
      if (doc.line(j).text.includes(close)) {
        found = j;
        break;
      }
    }
    if (found < 0) {
      i += 1;
      continue;
    }
    const startPos = line.from + (line.text.length - trimmed.length) + open.length;
    const endLine = doc.line(found);
    const closeIdx = endLine.text.indexOf(close);
    out.push({
      from: line.from,
      to: endLine.to,
      tex: doc.sliceString(startPos, endLine.from + closeIdx).trim(),
    });
    i = found + 1;
  }
  return out;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function createBlockDecorationsField(
  reveal: boolean,
  resolveAsset?: AssetResolver,
): StateField<DecorationSet> {
  const buildBlocks = (state: EditorState): DecorationSet => {
    const ranges: { from: number; to: number; value: Decoration }[] = [];
    if (!isEngineReady()) return Decoration.set(ranges, true);
    const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
    const headLine = state.doc.lineAt(state.selection.main.head).number;

    /*
     * 第一步：块级数学的整体识别（行级扫描，见 scanMathBlocks 的注释）。
     * 必须先于 lezer 遍历 —— lezer 会把 tex 里的 `+` / `-` 行切成独立
     * 列表块，按 lezer 边界切会把数学块拆碎。
     */
    const mathBlocks = scanMathBlocks(state.doc);
    const mathByFrom = new Map<number, { to: number; tex: string }>();
    for (const block of mathBlocks) {
      const startLine = state.doc.lineAt(block.from).number;
      const endLineNo = state.doc.lineAt(block.to).number;
      const isActive = reveal
        && (headLine === startLine || headLine === endLineNo
          || (headLine > startLine && headLine < endLineNo));
      if (!isActive) {
        const html = `<span class="aropyt-math-block" data-tex="${escapeAttr(block.tex)}"></span>`;
        ranges.push({
          from: block.from,
          to: block.to,
          value: Decoration.replace({
            widget: new BlockWidget(html, resolveAsset),
            block: true,
          }),
        });
        mathByFrom.set(block.from, block);
      }
    }
    // 数学块覆盖的区间：lezer 遍历遇到就跳过
    const mathRanges = mathBlocks
      .filter((b) => mathByFrom.has(b.from))
      .map((b) => ({ from: b.from, to: b.to }));
    const inMath = (pos: number): number | null => {
      for (const r of mathRanges) {
        if (pos >= r.from && pos < r.to) return r.to;
      }
      return null;
    };

    const cursor = tree.cursor();
    let skip = -1;
    do {
      if (cursor.from < skip) continue;
      const mathEnd = inMath(cursor.from);
      if (mathEnd !== null) {
        skip = mathEnd;
        continue;
      }
      const name = cursor.name;
      if (cursor.node.parent?.name === 'Document' && BLOCK_REPLACE_TYPES.has(name)) {
        const startLine = state.doc.lineAt(cursor.from).number;
        const endLine = state.doc.lineAt(cursor.to).number;
        // 光标所在的块保持源码（要编辑）；跨行块用"块首/块尾/中间夹住"判断
        const isActiveBlock = reveal
          && (headLine === startLine || headLine === endLine
            || (headLine > startLine && headLine < endLine));
        if (!isActiveBlock) {
          /*
           * mermaid 代码块优先于 markdown-it：highlight.js 不认识 mermaid，
           * 图表必须由 mermaid 库渲染成 SVG（见 MermaidWidget）。
           */
          if (name === 'FencedCode') {
            const info = cursor.node.getChild('CodeInfo');
            const lang = info ? state.doc.sliceString(info.from, info.to).trim().toLowerCase() : '';
            if (lang === 'mermaid') {
              const source = state.doc.sliceString(cursor.from, cursor.to);
              const body = source
                .replace(/^```mermaid[^\n]*\n/, '')
                .replace(/\n?```$/, '');
              ranges.push({
                from: cursor.from,
                to: cursor.to,
                value: Decoration.replace({
                  widget: new MermaidWidget(body),
                  block: true,
                }),
              });
              skip = cursor.to;
              continue;
            }
          }
          const source = state.doc.sliceString(cursor.from, cursor.to);
          const html = renderBlockCached(source);
          if (html) {
            ranges.push({
              from: cursor.from,
              to: cursor.to,
              value: Decoration.replace({
                widget: new BlockWidget(html, resolveAsset),
                block: true,
              }),
            });
            skip = cursor.to;
            continue;
          }
        }
      }
    } while (cursor.next());
    return Decoration.set(ranges, true);
  };

  return StateField.define<DecorationSet>({
    create: buildBlocks,
    update(value, tr) {
      const engineReady = tr.effects.some((e) => e.is(engineReadyEffect));
      // 光标移动也要重算 —— 光标进出块会切换"渲染/源码"
      if (!tr.docChanged && !tr.selection && !engineReady) return value;
      return buildBlocks(tr.state);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}


/*
 * ── KaTeX 数学公式 ──────────────────────────────────────────
 * markdown-it 层把 $…$ / \(…\) 等替换成 data-tex 占位元素，
 * 这里在 DOM 水合时用 KaTeX 渲染成真公式。动态 import + 缓存
 * （与 mermaid 同一套理由：renderToString 是重活，滚动重建 DOM
 * 时不能反复跑）。
 */
interface KaTeXApi {
  renderToString(tex: string, options?: Record<string, unknown>): string;
}
let katexMod: KaTeXApi | null = null;
const katexCache = new Map<string, string>();

async function hydrateMath(wrap: HTMLElement): Promise<void> {
  const nodes = wrap.querySelectorAll('[data-tex]');
  if (nodes.length === 0) return;
  katexMod ??= (await import('katex')).default as unknown as KaTeXApi;
  // KaTeX 的 CSS 由 web 宿主层预热加载（core 包的 tsconfig 对 CSS 子路径
  // 没有模块声明，这里不引 —— 字体也由该 CSS 按需下载）
  for (const el of [...wrap.querySelectorAll('[data-tex]')]) {
    const tex = el.getAttribute('data-tex') ?? '';
    if (!tex) continue;
    const display = el.classList.contains('aropyt-math-block');
    let html = katexCache.get(tex);
    if (html === undefined) {
      html = katexMod.renderToString(tex, {
        throwOnError: false,
        displayMode: display,
      });
      katexCache.set(tex, html);
    }
    el.innerHTML = html;
  }
}

export interface InlineRenderConfig {
  /**
   * 光标所在行是否强制显示标记。
   *
   * 默认 true（跟随光标）。设为 false 则永远隐藏 —— 调试时有用，
   * 但用户会失去"我在改哪一层"的感觉。
   */
  readonly revealAtCursor?: boolean;
  /** 把工作区相对路径的图片变成可显示的 src。宿主注入。 */
  readonly resolveAsset?: AssetResolver;
}

/**
 * 生成 Typora 式渲染扩展。
 *
 * 做成工厂而不是导出单例扩展：配置不同则行为不同，
 * 单例会让配置无处安放（而"跟随光标"这个开关未来可能要进设置）。
 */
export function inlineRender(config: InlineRenderConfig = {}): Extension {
  const revealAtCursor = config.revealAtCursor ?? true;
  const resolveAsset = config.resolveAsset;

  const blockField = createBlockDecorationsField(revealAtCursor, resolveAsset);

  return [
    aropytInlineTheme,
    blockField,
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = build(view, revealAtCursor, resolveAsset, blockField);
          this.watchEngine(view);
        }

        update(update: ViewUpdate): void {
          // IME 组合期间冻结装饰。注意 composing 挂在 view 上而不是
          // update 上 —— ViewUpdate 只说"有没有变化"，view 才有"是否正在组合"。
          //
          // 这里的顺序不能颠倒：先判组合，再判是否需要重算。
          if (update.view.composing) return;

          // 引擎就绪信号：动态 import 完成时由 promise 对每个登记的
          // 视图 dispatch 一个 effect —— 此时文档没变，但所有块要从
          // "源码态"切换成"渲染态"，必须重建。
          if (update.transactions.some((tr) => tr.effects.some((e) => e.is(engineReadyEffect)))) {
            this.decorations = build(update.view, revealAtCursor, resolveAsset, blockField);
            return;
          }

          // 纯滚动：装饰是按整个文档算好的，滚出视口不影响它们。
          // 这是长文档下的关键优化 —— 滚动不该触发 markdown 树遍历。
          if (!update.docChanged && !update.selectionSet) return;

          this.decorations = build(update.view, revealAtCursor, resolveAsset, blockField);
        }

        /**
         * 引擎懒加载：构造时就把 import 跑起来（与应用启动并行），
         * 就绪后 dispatch effect 通知重建。就绪前编辑区显示源码 ——
         * 一次性代价（通常在用户打开文件之前就已经加载完了）。
         */
        private watchEngine(view: EditorView): void {
          if (isEngineReady()) return;
          pendingViews.add(view);
          void ensureEngine().then(() => {
            for (const v of pendingViews) {
              v.dispatch({ effects: engineReadyEffect.of(null) });
            }
            pendingViews.clear();
          });
        }
      },
      {
        decorations: (plugin) => plugin.decorations,
      },
    ),
  ];
}

/** 找出光标涉及的所有行。选区跨行时全部揭示。 */
function cursorLines(view: EditorView): readonly number[] {
  const result = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const start = view.state.doc.lineAt(range.from);
    const end = view.state.doc.lineAt(range.to);
    for (let n = start.number; n <= end.number; n += 1) result.add(n);
  }
  return [...result];
}

function build(
  view: EditorView,
  revealAtCursor: boolean,
  resolveAsset: AssetResolver | undefined,
  blockDecorationsField: StateField<DecorationSet>,
): DecorationSet {
  // 光标所在行的集合：这些行要显形标记，不做替换。
  const active = revealAtCursor ? new Set(cursorLines(view)) : new Set<number>();

  /*
   * 先收集、最后统一排序构建，**不能用 RangeSetBuilder 边遍历边 add**。
   *
   * CM6 的 RangeSetBuilder.add() 要求调用方保证按 `from` 升序，
   * 否则直接抛 "Ranges must be added sorted"。
   * 语法树遍历本身是升序的，但成对标记是在主循环**之后**才补进去的，
   * 那些位置比后面已添加的靠前 —— 顺序就乱了。
   *
   * 更糟的是失败方式：CM6 捕获到插件异常后会**整个停用这个插件**，
   * 于是装饰全部消失，控制台只有一条 "CodeMirror plugin crashed"。
   * 表现是"打字有高亮、但标记一个都不隐藏"，很难往排序上想。
   *
   * 所以改成收集成数组，交给 Decoration.set 排序（第二个参数 true）。
   * 代价是多一次排序（O(n log n)），换来不可能再踩这个坑。
   */
  const ranges: { from: number; to: number; value: Decoration }[] = [];

  /*
   * StateField 里那一份"块级渲染"装饰：被整体替换的块（from → to）。
   * 主循环遇到它们直接跳过 —— 行内装饰落进 replace 范围会被掩盖，
   * 白做功还可能互相干扰。
   */
  const coveredBlocks = new Map<number, number>();
  const blockSet = view.state.field(blockDecorationsField, false) as DecorationSet | undefined;
  if (blockSet) {
    blockSet.between(0, view.state.doc.length, (from, to) => {
      coveredBlocks.set(from, to);
    });
  }

  const full = ensureSyntaxTree(view.state, view.state.doc.length, 100);
  const tree = full ?? syntaxTree(view.state);
  const cursor = tree.cursor();

  // 成对标记（* / ** / ` / ~~）不能各自独立处理 —— 只隐藏起点会让
  // "粗**体" 这种中间态看着像 bug。所以先收集，再成对决定。
  const pairMarks: { from: number; to: number; line: number }[] = [];

  /*
   * 被整体替换掉的节点，其内部不再逐项处理。
   *
   * 图片的子树同样是 LinkMark × 4 + URL（与链接同构）。外层已经把整个
   * Image 换成了 <img>，若再进去给这些子节点加装饰，就会得到
   * "替换范围里还嵌着别的装饰"——CM6 对这种嵌套的处置是丢掉内层，
   * 结果不确定，且不报错。位置比较是最省事的跳过法：先序遍历程中，
   * 子节点必然落在父节点的 [from, to) 内。
   */
  let skipUntil = -1;

  // 需要整体塌缩的行（表格的 `| --- | --- |` 分隔行）。
  const collapseLines = new Set<number>();

  // 代码围栏占的行区间（含首尾两行围栏本身）。
  const fenceRanges: { from: number; to: number }[] = [];

  /*
   * 列表标记：行号 → 标记原文（`-` / `1.`）。
   *
   * 为什么必须单独收集而不是直接隐藏了事：列表的 `-` / `1.` 被藏掉之后
   * **行首就没有任何东西了**，列表看起来只是一段缩进的普通文字 ——
   * 用户看到的就是"样式没渲染好"。源码里的标记要藏，但视觉上的项目符号
   * 得补回来。
   *
   * 补法是用行装饰 + CSS `::before`，标记内容通过行内 style 上的
   * CSS 变量传进去（有序列表要显示真实序号，不能一律画成圆点）。
   */
  const listMarkers = new Map<number, string>();

  /* 含任务复选框的行。它们有自己的方框 widget，不该再画一个项目符号。 */
  const taskLines = new Set<number>();

  /*
   * 内联 HTML 标签（`<strong>` 等）。主循环里先藏掉标签文本，
   * 之后 addHtmlInline 再把**开/闭标签配对**，用 Decoration.mark 的
   * tagName 把中间的内容包进真实元素 —— `<strong>加粗</strong>` 在
   * 编辑区里就真的是加粗的，与原预览窗的 markdown-it html:true 一致。
   */
  const htmlTags: { from: number; to: number; text: string }[] = [];

  /*
   * linkify 的避让范围：这些区间内的"裸 URL"样式**已经有人管了**
   * （Link/Autolink/InlineCode 的内容、代码块），重复染色会在
   * hide 装饰上叠 mark，行为不可预测。
   */
  const takenRanges: { from: number; to: number }[] = [];

  do {
    const name = cursor.name;
    /*
     * ── 块级渲染（markdown-it，与原预览窗同一引擎）─────────────
     *
     * 顶层块节点整体替换为 markdown-it 渲染出的 HTML —— 编辑区与
     * 预览窗用的是**同一个引擎**，输出必然一致（真 <table> 布局、
     * 真 <strong>、typographer……装饰近似永远到不了这一步）。
     *
     * 光标所在块不替换（要编辑）；被替换的块用 skipUntil 跳过子树，
     * 后面的装饰逻辑只对光标块生效。
     *
     * replace 用 block: true：范围必须是完整行（node.from 是行首 ✓、
     * node.to 是块尾字符，换行符留在块外 —— 块与块之间的空行行保留，
     * 视觉上仍是源码的行距节奏）。
     */
    /*
     * 被块级渲染（StateField）整体替换的块：跳过子树 —— 它的源码
     * 已经被 markdown-it 的 HTML 取代，再叠装饰只会落进被掩盖的范围。
     */
    if (coveredBlocks.has(cursor.from)) {
      skipUntil = coveredBlocks.get(cursor.from) as number;
      continue;
    }

    /*
     * ⚠️ 必须用 `cursor.name`（节点自己的名字），**不能**用 `cursor.type.name`。
     *
     * lezer 会把"纯 inline 叶子节点"（没有任何 nodeType 属性）的 type
     * **内联进父节点** —— 于是 `cursor.type.name` 拿到的是 Paragraph、
     * 而节点真名 Escape 就永远匹配不上，`\*转义\*` 里的反斜杠照显示。
     * 这类节点不报错、也不影响别的分支，只是安静地不生效 ——
     * 靠看代码是发现不了的，只有拿语法树的节点名对账才会暴露
     * （见 `scripts/dump-md-tree.mjs`）。
     */
    if (cursor.from < skipUntil) continue;

    /*
     * 表格的分隔行（`| --- | --- |`）。
     *
     * 判断依据是**父节点**必须直接是 Table —— 行内那些竖线的节点名也叫
     * TableDelimiter（父节点是 TableHeader / TableRow），把那些也塌缩
     * 会把整张表压没。分隔行的唯一作用是告诉渲染器对齐方式，
     * 对读文档的人是纯噪音，Typora 也不显示它。
     */
    if (name === 'TableDelimiter' && cursor.node.parent?.name === 'Table') {
      const line = view.state.doc.lineAt(cursor.from).number;
      if (!active.has(line)) collapseLines.add(line);
      continue;
    }

    /*
     * 代码围栏的 ``` 与行内代码的 ` 都叫 CodeMark，但语义完全不同：
     *   父节点 FencedCode → 围栏定界符，**本身跨行且两端独立**
     *   父节点 InlineCode → 行内代码，两端必须成对
     * 早期版本一律按"成对"处理，结果围栏因为跨行而被跳过，永远不隐藏。
     * 所以这里按父节点分流。
     *
     * FencedCode 本身要记下行范围，代码块的背景靠行装饰画（见下方
     * `fenceRanges`）—— 背景必须连续成一整块，而 mark 是行内片段，
     * 每行各自一块背景，接缝处会出现横向断线。
     */
    if (name === 'FencedCode') {
      fenceRanges.push({
        from: view.state.doc.lineAt(cursor.from).number,
        to: view.state.doc.lineAt(cursor.to).number,
      });
      /*
       * ⚠️ 必须 `continue`，不能让这个节点再落到下面的
       * "其余节点 → Decoration.mark" 分支。
       *
       * 那个分支会按 BLOCK_CLASSES 给它加一个 **行内** 的 `cm-md-code`，
       * 而 `cm-md-code` 带着 `padding: 0 0.9em` —— 于是整个代码块的内容
       * 被左右各推 13.5px。**行元素自己那份 padding 是 CM6 认的，
       * 行内这份不认**，两者叠加后鼠标落点的 x 就整体右偏 13.5px
       * （实测：点第 1 个字符，光标落到第 2 个；点第 5 个落到第 6 个）。
       *
       * 代码块的视觉样式由 `addFenceBody` 的行装饰负责，不需要行内 mark。
       * `continue` 只跳过"处理这个节点自身"，子节点仍会被遍历到
       * （`continue` 之后是 `while (cursor.next())`）。
       */
      continue;
    }

    if (name === 'CodeMark' && cursor.node.parent?.name === 'FencedCode') {
      const line = view.state.doc.lineAt(cursor.from).number;
      if (!active.has(line)) {
        ranges.push({ from: cursor.from, to: cursor.to, value: hideMarker() });
      }
      continue;
    }

    // 围栏行的语言标记（```js 里的 js）同属围栏，一起藏掉。
    // 留着它会看到一行悬空的 "js"，比不藏更像 bug。
    if (name === 'CodeInfo') {
      const line = view.state.doc.lineAt(cursor.from).number;
      if (!active.has(line)) {
        ranges.push({ from: cursor.from, to: cursor.to, value: hideMarker() });
      }
      continue;
    }

    /*
     * 图片：整块换成 <img>。
     *
     * 必须赶在子节点之前处理，所以放在最前面并设置 skipUntil。
     * 光标在本行时不换 —— 那时你要改的是路径，得看得见源码。
     */
    if (name === 'Image') {
      const line = view.state.doc.lineAt(cursor.from).number;
      const url = cursor.node.getChild('URL');
      if (!active.has(line) && url) {
        /*
         * alt 是第一个 `![` 与第二个 `]` **之间**的裸文本 ——
         * 它本身不是语法节点，只能按位置取。
         * 用"前两个 LinkMark"而不是"URL 往前数两个字符"来定位：
         * 后者依赖 `](` 紧邻这个当前的排版习惯，改天写成
         * `[alt]( url )` 就会取错。
         */
        const marks: SyntaxNode[] = [];
        for (let child = cursor.node.firstChild; child; child = child.nextSibling) {
          if (child.name === 'LinkMark') marks.push(child);
          if (marks.length === 2) break;
        }
        const alt =
          marks.length === 2
            ? view.state.doc.sliceString(marks[0].to, marks[1].from)
            : '';
        ranges.push({
          from: cursor.from,
          to: cursor.to,
          value: Decoration.replace({
            widget: new ImageWidget(view.state.doc.sliceString(url.from, url.to), alt, resolveAsset),
          }),
        });
        skipUntil = cursor.to;
        continue;
      }
    }

    // 分隔线：`---` 就是三个减号，不画出来读者只会以为作者写错了。
    if (name === 'HorizontalRule') {
      const line = view.state.doc.lineAt(cursor.from).number;
      if (!active.has(line)) {
        ranges.push({
          from: cursor.from,
          to: cursor.to,
          value: Decoration.replace({ widget: new RuleWidget() }),
        });
      }
      continue;
    }

    // 任务列表的 `[ ]` / `[x]`：换成方框。
    if (name === 'TaskMarker') {
      const line = view.state.doc.lineAt(cursor.from).number;
      taskLines.add(line);
      if (!active.has(line)) {
        const checked = /x/i.test(view.state.doc.sliceString(cursor.from, cursor.to));
        ranges.push({
          from: cursor.from,
          to: cursor.to,
          value: Decoration.replace({ widget: new TaskWidget(checked) }),
        });
      }
      continue;
    }

    /*
     * 列表的项目符号（`-` / `*` / `+` / `1.`）。
     *
     * 与普通标记的区别：普通标记藏掉就完事，列表标记**必须补一个等价的
     * 视觉符号**，否则列表退化成缩进段落。所以这里除了隐藏，
     * 还把原文记进 `listMarkers`，遍历结束后统一画 `::before`。
     *
     * 单独判在 MARKER_TYPES 之前：ListMark 也在那个集合里，
     * 走到那里就没有机会记录原文了。
     */
    if (name === 'ListMark') {
      const line = view.state.doc.lineAt(cursor.from).number;
      if (!active.has(line)) {
        listMarkers.set(line, view.state.doc.sliceString(cursor.from, cursor.to));
        ranges.push({ from: cursor.from, to: cursor.to, value: hideMarker() });
      }
      continue;
    }

    /*
     * 链接的包装与目标地址：藏掉，只留可读的文字。
     *
     * 父节点判据涵盖 Link 与 Autolink（`<https://x.com>` 的尖括号与
     * URL 同构）；图片的子节点结构与链接也一样，但图片整体已被 widget
     * 替换掉，装饰落在被替换范围内行为不确定，所以仍排除 Image。
     */
    if (LINK_PARTS.has(name) && LINK_WRAPPER_PARENTS.has(cursor.node.parent?.name ?? '')) {
      const line = view.state.doc.lineAt(cursor.from).number;
      takenRanges.push({ from: cursor.from, to: cursor.to });
      if (!active.has(line)) {
        ranges.push({ from: cursor.from, to: cursor.to, value: hideMarker() });
      }
      continue;
    }

    /*
     * 引用式链接的定义行：整行藏掉。
     *
     * `[ref-1]: https://example.com "Example"` 是给解析器看的元数据。
     * 藏掉整行而不是逐个标记 —— 它的子节点（LinkLabel/URL/LinkTitle）
     * 各自也会被 MARKER_TYPES 处理，双重保险；而行的空白与换行部分
     * 只有整节点隐藏才能一起消失，否则会留下一行空白。
     */
    if (DEFINITION_TYPES.has(name)) {
      ranges.push({ from: cursor.from, to: cursor.to, value: hideMarker() });
      continue;
    }

    if (PAIRED_MARKERS.has(name)) {
      pairMarks.push({
        from: cursor.from,
        to: cursor.to,
        line: view.state.doc.lineAt(cursor.from).number,
      });
      continue;
    }

    // 单独成词的标记（#、- 、>、---）：光标不在本行就隐藏。
    if (MARKER_TYPES.has(name)) {
      const line = view.state.doc.lineAt(cursor.from).number;
      if (!active.has(line)) {
        ranges.push({
          from: cursor.from,
          /*
           * **Escape 是两字符的节点**（`\*` = 反斜杠 + 被转义的字符）。
           * 整个藏掉会连被转义的那个字符一起吃掉，`\*这不是斜体\*`
           * 就会变成"这不是斜体"—— 反斜杠的作用正是"别把它当标记"，
           * 渲染态下标记已经不存在了，所以该显示的是这个字本身。
           *
           * 同理 LinkLabel / LinkTitle / HTMLTag 是"包装 + 内容"型节点，
           * 但它们的**内容不在节点范围内**（是兄弟节点），
           * 整个藏掉只会藏掉包装部分，所以这几个走整体隐藏是对的。
           */
          to: name === 'Escape' ? cursor.from + 1 : cursor.to,
          value: hideMarker(),
        });
      }
      if (name === 'HTMLTag') {
        htmlTags.push({
          from: cursor.from,
          to: cursor.to,
          text: view.state.doc.sliceString(cursor.from, cursor.to),
        });
      }
      continue;
    }

    /*
     * HTML 块（`<details>` … `</details>`）：整块藏起来。
     *
     * CommonMark 把 HTML 块当作**不透明内容**交给宿主，编辑器里也没有
     * 真正的折叠能力（widget 会带来一整套交互与无障碍问题）。
     * 这里的选择：标签行藏掉、内容行照常显示 —— 至少读者看到的是
     * 块内的 Markdown 内容，而不是一屏尖括号。
     */
    if (name === 'HTMLBlock') {
      const text = view.state.doc.sliceString(cursor.from, cursor.to);
      const onlyTags = /^\s*<\/?[A-Za-z][^>]*>\s*$/.test(text);
      takenRanges.push({ from: cursor.from, to: cursor.to });
      if (onlyTags) {
        ranges.push({ from: cursor.from, to: cursor.to, value: hideMarker() });
      }
      continue;
    }

    const line = view.state.doc.lineAt(cursor.from).number;
    const revealed = active.has(line);

    // 标题：走行装饰，样式才能作用到整行（含空白与换行）。
    if (name.startsWith('ATXHeading') || name.startsWith('SetextHeading')) {
      const cls = BLOCK_CLASSES[name];
      if (cls) {
        const docLine = view.state.doc.lineAt(cursor.from);
        // 行装饰必须落在行的起点，且长度为零。
        ranges.push({ from: docLine.from, to: docLine.from, value: Decoration.line({ class: cls }) });
      }
      continue;
    }

    // 其余节点：光标在行内时不加装饰，否则光标附近的样式会"闪"。
    if (!revealed) {
      const cls = INLINE_CLASSES[name] ?? BLOCK_CLASSES[name];
      if (cls) {
        ranges.push({ from: cursor.from, to: cursor.to, value: Decoration.mark({ class: cls }) });
        takenRanges.push({ from: cursor.from, to: cursor.to });
      }
    }
  } while (cursor.next());

  addAlerts(ranges, view);
  addParagraphRhythm(ranges, view);
  addEmptyLineCollapse(ranges, view);
  collectPairedMarkers(ranges, pairMarks, active);
  addFenceCollapse(ranges, view, active);
  addFenceBody(ranges, view, active, fenceRanges);
  for (const lineNo of collapseLines) {
    const line = view.state.doc.line(lineNo);
    collapseWholeLine(ranges, line);
  }
  addListMarkers(ranges, view, listMarkers, taskLines);
  addHtmlInline(ranges, htmlTags);
  addLinkify(ranges, view, takenRanges, fenceRanges, active);
  return Decoration.set(ranges, true);
}

/**
 * 内联 HTML 的**配对渲染**。
 *
 * 原预览窗开着 `html: true`，`<strong>加粗</strong>` 渲染出来是真的
 * `<strong>` 元素。编辑区里标签文本已经藏了（MARKER_TYPES），但只藏标签
 * 的话内容还是裸文本 —— "HTML 加粗"四个字不加粗，与预览不一致。
 *
 * 补法：把同层的开/闭标签**栈式配对**，中间的内容用
 * `Decoration.mark({ tagName })` 包进真实元素 —— 不引入任何 HTML 解析，
 * 标签名直接透传给浏览器，效果与预览窗一致。
 *
 * 只放行**样式类**标签（加粗/斜体/删除线/code 等）。`a`、`img`、`iframe`
 * 这类带行为或资源的标签不放行 —— 编辑区里链接点击本来就没有交互，
 * 而资源类标签在这个体系里没有可靠的安全边界。
 */
const HTML_RENDERABLE = new Set([
  'strong', 'b', 'em', 'i', 'del', 's', 'code', 'u',
  'sub', 'sup', 'small', 'mark', 'kbd', 'cite', 'q', 'span',
]);

function addHtmlInline(
  ranges: { from: number; to: number; value: Decoration }[],
  tags: ReadonlyArray<{ from: number; to: number; text: string }>,
): void {
  if (tags.length === 0) return;
  const openStack: { name: string; to: number }[] = [];
  const pairs: { name: string; from: number; to: number }[] = [];
  for (const tag of tags) {
    const match = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(tag.text);
    if (!match) continue;
    const closing = match[1] === '/';
    const tagName = match[2].toLowerCase();
    if (!closing) {
      openStack.push({ name: tagName, to: tag.to });
      continue;
    }
    // 找最近的同名开标签与之配对（未配对的开标签自然作废）
    for (let i = openStack.length - 1; i >= 0; i -= 1) {
      if (openStack[i].name === tagName) {
        const open = openStack[i];
        if (tag.from > open.to) pairs.push({ name: tagName, from: open.to, to: tag.from });
        openStack.splice(i, 1);
        break;
      }
    }
  }
  for (const { name, from, to } of pairs) {
    if (!HTML_RENDERABLE.has(name)) continue;
    ranges.push({ from, to, value: Decoration.mark({ tagName: name }) });
  }
}

/**
 * 裸 URL 的自动链接（linkify）。
 *
 * 原预览窗开着 `linkify: true`，正文中 `www.baidu.com`、`https://…`
 * 会自动变成链接样式。语法树里没有对应节点（Autolink 只认 `<url>` 尖括号
 * 写法），所以只能对视口文本自扫正则。
 *
 * 三条避让规则，缺一不可：
 *   - 代码块（fenceRanges）：代码里的 URL 是代码，不是链接
 *   - takenRanges（Link/Autolink/InlineCode 等）：已有人管，叠 mark 会在
 *     hide 装饰上叠加，行为不可预测
 *   - 光标行（active）：与其它"光标行不渲染"的约定一致
 *
 * 只加 `cm-md-link` 样式，不做交互 —— 编辑区里链接的点击语义
 * （打开/编辑/预览）是另一个话题。
 */
const LINKIFY_RE = /(?:https?:\/\/|www\.)[^\s<>")\]]+/g;

function addLinkify(
  ranges: { from: number; to: number; value: Decoration }[],
  view: EditorView,
  taken: ReadonlyArray<{ from: number; to: number }>,
  fenceRanges: ReadonlyArray<{ from: number; to: number }>,
  active: ReadonlySet<number>,
): void {
  const avoid: { from: number; to: number }[] = [...taken];
  for (const { from: lf, to: lt } of fenceRanges) {
    avoid.push({ from: view.state.doc.line(lf).from, to: view.state.doc.line(lt).to });
  }
  for (const { from: viewFrom, to: viewTo } of view.visibleRanges) {
    const text = view.state.doc.sliceString(viewFrom, viewTo);
    for (const match of text.matchAll(LINKIFY_RE)) {
      const start = viewFrom + (match.index ?? 0);
      const end = start + match[0].length;
      if (active.has(view.state.doc.lineAt(start).number)) continue;
      if (avoid.some((r) => start < r.to && end > r.from)) continue;
      ranges.push({
        from: start,
        to: end,
        value: Decoration.mark({ class: 'cm-md-link' }),
      });
    }
  }
}

/**
 * 给列表行补上项目符号。
 *
 * 源码里的 `-` / `1.` 已经被藏起来了，这里用行装饰 + CSS `::before`
 * 把它换成**视觉等价物**：无序列表一律画圆点（`-`、`*`、`+` 在渲染态
 * 没有区别），有序列表显示真实序号（`1.` `2.` …）。
 *
 * 符号通过行内 style 上的 CSS 变量传进去，而不是用 widget：
 * widget 会被 CM6 当成不可编辑内容而在两侧插 `<img class="cm-widgetBuffer">`，
 * 而 `::before` 是纯 CSS 生成的，零 DOM 节点、不参与命中测试。
 *
 * 任务列表行跳过 —— 它们已经有方框 widget，再画个圆点会变成"• ☐ 待办"。
 */
function addListMarkers(
  ranges: { from: number; to: number; value: Decoration }[],
  view: EditorView,
  markers: ReadonlyMap<number, string>,
  taskLines: ReadonlySet<number>,
): void {
  for (const [lineNo, raw] of markers) {
    if (taskLines.has(lineNo)) continue;
    const text = raw.trim();
    /*
     * 有序 vs 无序靠标记原文判断：`1.` `2)` 这类以数字开头，
     * 其余（`-` `*` `+`）都是无序。
     * 不去查语法树里的 OrderedList/BulletList —— 那要走祖先链，
     * 而标记原文已经把答案写在脸上了。
     */
    const symbol = /^\d/.test(text) ? text : '•';
    /*
     * 转义：符号会拼进 `--md-marker:"…"` 这个 CSS 变量值里，
     * 而它来自文档内容。有序列表的 `1.` 本身安全，但用户完全可能
     * 写出带引号的畸形标记 —— 不转义就会把整条 style 属性拆断。
     */
    const safe = symbol.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const line = view.state.doc.line(lineNo);
    ranges.push({
      from: line.from,
      to: line.from,
      value: Decoration.line({
        class: 'cm-md-list-line',
        attributes: { style: `--md-marker:"${safe}"` },
      }),
    });
  }
}

/**
 * 成对标记处理。
 *
 * 同长度的标记两两配对（** 对 **、* 对 *、` 对 `），
 * 只在**两端都在非光标行**时一起隐藏。
 *
 * 只剩一个的时候不隐藏 —— 那正是"用户正在输入"的表现，
 * 隐藏了反而看不见自己在干嘛。跨行的也不配对，那同样是未完成状态。
 */

/**
 * GitHub alerts：`> [!NOTE]` 之类的块整体加类型 class（按行）。
 * 纯行装饰 —— 不改文本、不插节点，编辑体验零影响。
 */

/**
 * 段落节奏（v0.0.9）：段内紧凑、段间留白。
 *
 * CM6 是逐行 DOM，一个段落的多个软换行是多个独立行 —— 行距只能由
 * line-height 控制，而段间距只能由"段落末行"的 padding 补齐。
 * 这里只给 **Paragraph 节点的最后一行** 加 class，由 CSS 加下留白；
 * 段内行什么都不加（靠收紧后的 line-height 自然紧凑）。
 *
 * 标题不参与 —— 它们已有各自的上下 padding，再叠一层会打架。
 */

/**
 * 空行压缩（v0.0.9）：段落之间那一行空白不该占满一行高度。
 *
 * Markdown 用空行分隔段落，而空行在 CM6 里同样是一个 `.cm-line` ——
 * line-height 1.35 意味着它凭空吃掉约 20px，段与段之间看起来像
 * "空了一行"。这里把**不含文字的行**压到 0.5em 高。
 *
 * 光标所在的空行**不压缩** —— 编辑时需要一个正常高度的落点，
 * 否则光标线几乎看不见。
 */
function addEmptyLineCollapse(
  ranges: { from: number; to: number; value: Decoration }[],
  view: EditorView,
): void {
  const doc = view.state.doc;
  const sel = view.state.selection;
  for (const range of view.visibleRanges) {
    let pos = range.from;
    while (pos <= range.to) {
      const line = doc.lineAt(pos);
      if (line.text.trim() === '') {
        const caretInside = sel.ranges.some((r) => r.from <= line.to && r.to >= line.from);
        if (!caretInside) {
          ranges.push({ from: line.from, to: line.from, value: Decoration.line({ class: 'cm-md-empty-line' }) });
        }
      }
      if (line.to >= doc.length) break;
      pos = line.to + 1;
    }
  }
}

function addParagraphRhythm(
  ranges: { from: number; to: number; value: Decoration }[],
  view: EditorView,
): void {
  const doc = view.state.doc;
  const tree = syntaxTree(view.state);
  const { from, to } = view.viewport;
  tree.iterate({
    from,
    to,
    enter(node) {
      if (node.name !== 'Paragraph') return;
      /*
       * 列表项内的段落**不参与段间距** —— 否则每个列表项都被撑开
       * 0.15em，整个列表看起来散成一块一块，不像一个整体（实测反馈）。
       * 列表的紧凑感由行高本身保证。
       */
      if (node.node.parent?.name === 'ListItem') return;
      // 末行：node.to 可能正好落在下一行行首，减一取本行
      const endPos = Math.min(Math.max(node.to - 1, node.from), doc.length);
      const line = doc.lineAt(endPos);
      ranges.push({ from: line.from, to: line.from, value: Decoration.line({ class: 'cm-md-para-end' }) });
    },
  });
}

function addAlerts(
  ranges: { from: number; to: number; value: Decoration }[],
  view: EditorView,
): void {
  const doc = view.state.doc;
  const tree = syntaxTree(view.state);
  tree.iterate({
    enter(node) {
      if (node.name !== 'Blockquote') return;
      const head = doc.sliceString(node.from, Math.min(node.to, node.from + 80));
      const match = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(head);
      if (!match) return;
      const cls = `cm-md-alert cm-md-alert-${match[1].toLowerCase()}`;
      const firstLine = doc.lineAt(node.from).number;
      const lastLine = doc.lineAt(Math.min(node.to, doc.length)).number;
      for (let ln = firstLine; ln <= lastLine; ln += 1) {
        const line = doc.line(ln);
        // 首行额外带 -head：图标只画一次，每行都画会很吵
        const lineCls = ln === firstLine ? `${cls} cm-md-alert-head` : cls;
        ranges.push({ from: line.from, to: line.from, value: Decoration.line({ class: lineCls }) });
      }
    },
  });
}

function collectPairedMarkers(
  ranges: { from: number; to: number; value: Decoration }[],
  marks: readonly { from: number; to: number; line: number }[],
  active: ReadonlySet<number>,
): void {
  const byLength = new Map<number, { from: number; to: number; line: number }[]>();
  for (const mark of marks) {
    const len = mark.to - mark.from;
    const list = byLength.get(len);
    if (list) list.push(mark);
    else byLength.set(len, [mark]);
  }

  for (const list of byLength.values()) {
    for (let i = 0; i + 1 < list.length; i += 2) {
      const open = list[i];
      const close = list[i + 1];
      if (open.line !== close.line) continue; // 跨行：还没写完
      if (active.has(open.line)) continue; // 光标在这行：显形
      ranges.push({ from: open.from, to: open.to, value: hideMarker() });
      ranges.push({ from: close.from, to: close.to, value: hideMarker() });
    }
  }
}

/**
 * 让围栏行整体塌缩。
 *
 * 只把 ``` 藏掉是不够的：行还在，于是代码块上下会各多出一条空行，
 * 看起来像文档里凭空多了两处间距。Typora 的围栏行是完全不占位的。
 *
 * 做法是给那一行加一个把行高与字号压到 0 的类。
 * 光标进入该行时不加 —— 那时需要它恢复成可编辑的正常行。
 */
function addFenceCollapse(
  ranges: { from: number; to: number; value: Decoration }[],
  view: EditorView,
  active: ReadonlySet<number>,
): void {
  const lines = view.state.doc.iterLines();
  for (let lineNo = 1; !lines.next().done; lineNo += 1) {
    if (!/^\s*(```|~~~)/.test(lines.value)) continue;
    if (active.has(lineNo)) continue; // 光标在这行：保持可编辑
    const line = view.state.doc.line(lineNo);
    collapseWholeLine(ranges, line);
  }
}

/**
 * 把一整行彻底折叠：行高度归零 **并且** 把文字藏起来。
 *
 * ── 为什么两件事都要做 ─────────────────────────────────────
 *
 * 只把高度归零（`font-size: 0; line-height: 0`）是不够的：
 * 文字仍在 DOM 里、仍有宽度，于是**浏览器原生的命中测试仍会选中它**。
 * 症状很具体 —— 双击代码块里的词，结果选中了围栏行的 `js`。
 * 这一点与 CM6 自己的坐标换算无关（CM6 逐行比较 y 区间，0 高度行匹配不到，
 * 实测过 y 矩阵：围栏行的 y 区间从未被命中）；问题出在
 * 浏览器双击选词用的 `caretRangeFromPoint`，它会在 0 高度矩形上命中。
 *
 * 所以文字用与"藏标记"完全相同的机制藏掉（`display: none`），
 * 这样它既不占宽也不参与命中测试，行高度也自然归零 ——
 * `font-size: 0` 那套技巧就不需要了。
 *
 * 注意不能改用 `display: none` 藏**整行**：CM6 需要这一行仍然存在
 * 才能定位光标（否则方向键经过时整行消失、算不出坐标）。
 */
function collapseWholeLine(
  ranges: { from: number; to: number; value: Decoration }[],
  line: { from: number; to: number },
): void {
  ranges.push({
    from: line.from,
    to: line.from,
    value: Decoration.line({ class: 'cm-md-fence-hidden' }),
  });
  /*
   * 整行文字兜底藏掉。
   *
   * 实测：围栏行的每个字符**通常已经被逐 token 的标记隐藏覆盖**
   * （``` 走 CodeMark 分支，`js` 那类语言标记也有自己的隐藏装饰），
   * 所以这一层在多数文档里是冗余的 —— 注入掉它，界面看不出任何区别
   * （`fenceCharCoverage` 仍是 2/2、1/1）。
   *
   * 仍然保留它，是因为"围栏行必须整体不可见"是产品要求，
   * 而逐 token 的覆盖依赖 lezer 的 token 划分方式与 INLINE_CLASSES 的完整性
   * —— 那是**外部依赖**。这一层让要求不依赖外部：无论标记被切成几个 token，
   * 整行都会被盖住。
   *
   * 零长度范围（空行）不用加，加了也没意义。
   */
  if (line.to > line.from) {
    ranges.push({ from: line.from, to: line.to, value: hideMarker() });
  }
}

/**
 * 给代码块的**正文行**加底色。
 *
 * 为什么不用 `Decoration.mark({class: 'cm-md-code'})`：
 * mark 是行内片段，每行各自一块背景，于是一个代码块看起来是
 * N 个带圆角的独立方块，接缝处横向断开 —— 而它应该是**一整块**。
 * 行装饰（Decoration.line）作用在整个 `.cm-line` 上，跨行才连得起来。
 *
 * 首行/末行分别标记，用来给整块加上下内边距与四角圆角 ——
 * 代码块应该看起来是**一个整体**，而不是几条紧贴的行。
 *
 * ⚠️ 早先这里写的是
 *   `lineNo === fence.from + 1 && lineNo === fence.to - 1 ? A : B`
 * 那个 `&&` 让它只在"代码块恰好一行"时才成立，多行时**每一行都拿到 B**，
 * 于是首尾根本没被区分开（实测两行代码都是 `--mid`）。
 * 首尾判定本质是"或"的关系，不是"与"。
 *
 * 光标进入代码块时不加底色：那行会变成源码编辑态，
 * 底色 + 等宽 + 语法高亮同时出现会让"我在改代码还是在读预览"分不清。
 */
function addFenceBody(
  ranges: { from: number; to: number; value: Decoration }[],
  view: EditorView,
  active: ReadonlySet<number>,
  fences: readonly { from: number; to: number }[],
): void {
  for (const fence of fences) {
    // from/to 含首尾两行围栏本身，正文是中间的 +1..-1
    for (let lineNo = fence.from + 1; lineNo < fence.to; lineNo += 1) {
      if (active.has(lineNo)) continue;
      const line = view.state.doc.line(lineNo);
      const isFirst = lineNo === fence.from + 1;
      const isLast = lineNo === fence.to - 1;
      const cls = [
        'cm-md-code',
        isFirst ? 'cm-md-code--first' : '',
        isLast ? 'cm-md-code--last' : '',
      ]
        .filter(Boolean)
        .join(' ');
      ranges.push({ from: line.from, to: line.from, value: Decoration.line({ class: cls }) });
    }
  }
}

// ── 样式 ──────────────────────────────────────────────────

const aropytInlineTheme = EditorView.baseTheme({
  /*
   * Typora 的排版节奏 —— 这是它"读起来像文档"的关键，缺了就不像。
   *
   * 注意这里改的是**内容区**（而theme.ts 里那个是给源码模式用的）：
   * 隐藏标记后，行内不再有等宽符号，30px 的行号栏会变成纯粹的视觉噪音
   * —— Typora 就没有行号。行号在渲染态是有害的，不是多余的。
   */
  /*
   * 渲染态的 scroller / content / line 样式**必须带 `aropyt-render-mode` 前缀**。
   *
   * 不加前缀的话，它们与 theme.ts 里的同名规则**特异性完全相同**，
   * 谁赢取决于 CM6 生成 CSS 的顺序 —— 而那与扩展位置并不一一对应。
   * 实测踩过：theme.ts 的等宽字体压住了这里的无衬线，
   * 渲染态正文变成等宽，且**零报错**。
   *
   * 带上模式类后两边选择器互斥（根节点同时只有一个模式类），
   * 顺序从此无关。这也让"改渲染样式改哪里"这个问题只有一个答案。
   */
  '&.aropyt-render-mode .cm-scroller': {
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--md-font-size, 15px)',
    /*
     * 行高放在 scroller 上（行会继承）而不是每行各写一遍：
     * 一处定义，且源码模式卸载这套样式时它会跟着一起走。
     *
     * ⚠️ 这里是**渲染态行距的唯一真源** —— 之前两轮改的是 theme.ts 与
     * .cm-md-block，都不在这条链上（行继承自 scroller），所以"行距过大"
     * 两轮没修掉。1.8 → 1.55 与块内排版保持一致。
     */
    lineHeight: '1.2',
  },
  '&.aropyt-render-mode .cm-content': {
    /*
     * 铺满编辑区，**不设 max-width、不居中**。
     *
     * 曾经写的是 `max-width: 46em; margin: 0 auto`（理由是"阅读宽度"），
     * 但在 1600px 视口下编辑区宽 1358px，内容只有 690px ——
     * **左右各浪费 334px**，看起来像"只是在中间显示"。
     * 桌面编辑器的窗口宽度本来就是用户自己拉的，替他做这个决定
     * 只会让人觉得界面没铺开。
     *
     * 顺带也去掉了居中带来的坐标风险：`margin: 0 auto` 让
     * `.cm-content` 的 x 起点随视口浮动，而 CM6 的命中测试
     * 依赖它作为基准。
     */
    padding: '40px 32px 40vh',
    /*
     * ⚠️ 必须解开 CM6 的 `flex-shrink: 0`，否则"铺满"会变成"被撑宽"。
     *
     * CM6 的 baseTheme 给 `.cm-content` 设的是：
     *     flex-grow: 2; flex-shrink: 0; white-space: pre
     * 三者合起来的意思是"这块内容只增长、绝不收缩、也不折行"——
     * 对源码编辑器完全正确（一行源码就是一个视觉行，横向滚动即可）。
     *
     * 但渲染态要的是文档排版：内容跟着容器宽度走，长段折行。
     * 只改 `white-space` 不够 —— `flex-shrink: 0` 让 content 永远不会
     * 缩到内容宽度以下，于是一段长文把它**整块撑宽**，
     * 编辑器出现横向滚动（实测 content 宽 2149px，溢出 967px）。
     *
     * `min-width: 0` 是 flex item 能收缩的**必要条件**（默认 `min-width: auto`
     * 会以内容为下限，同样阻止收缩）。两个都要给。
     *
     * 这个坑此前被 `max-width: 46em` 掩盖着：有固定上限时撑不宽，
     * 一取消限制就露出来了。
     */
    flexShrink: '1',
    minWidth: '0',
    /*
     * 必须 `pre-wrap`，不能沿用 CM6 的 `pre`。
     *
     * CM6 默认 `white-space: pre` 是**源码编辑器**的正确选择：
     * 一行源码就是一个视觉行，自动折行会让"光标在第几行"这件事失真。
     * 但渲染态的排版规则正好相反 —— 不折行的话，一段长文字会
     * 整段横向溢出容器（实测 clientWidth 690 / scrollWidth 1005），
     * 右侧的字直接被裁掉，而且因为没有折行也就没有"下一行"，
     * 光标与文字的对应关系随之错乱。
     *
     * `pre-wrap` 保住"空白与换行按文档来"，同时允许长行折行 ——
     * 正是渲染态需要的语义。
     */
    whiteSpace: 'pre-wrap',
    /*
     * 折行处优先断在词边界，但**长串**（URL、无空格中文长段）
     * 必须能断，否则中文段落会撑出容器。
     */
    overflowWrap: 'break-word',
    wordBreak: 'break-word',
  },
  '&.aropyt-render-mode .cm-line': {
    /*
     * ⚠️ 这里**故意不写 `padding: 0`**。
     *
     * 行级 padding 本身默认就是 0，写出来只是冗余；而它会变成一条
     * 高特异性的 `padding` 声明，把后面所有行装饰想加的 padding 都压掉
     * （踩过：代码块首行的 `paddingTop: 0.5em` 完全不生效，行高仍是 27px）。
     *
     * 同一条规则里的 `margin: 0` 则必须留着 —— 它不是冗余，
     * 是防"行上出现 margin"的硬约束（那会让点击落点累积偏移，见下）。
     */
    lineHeight: '1.2',
    /*
     * 同上：CM6 给 `.cm-line` 自己设了 `white-space: pre`，
     * 不显式覆盖的话它不会从 `.cm-content` 继承 —— 那一层改了等于没改。
     */
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    /*
     * ⚠️ `.cm-line` 上**永远不能有 margin**。
     *
     * 这是本项目最隐蔽的一处缺陷，症状是"点第 N 行，光标落到第 N+1 行"。
     *
     * 成因：CM6 的垂直坐标是**按行高累加**算出来的
     * （`posAtCoords` → `lineBlockAtHeight`），而累加用的是
     * `offsetHeight` —— **margin 不计入 offsetHeight**。
     * 于是每个带 margin 的行都会给后续所有行引入一份累积误差，
     * 误差随标题数量增长。实测：一篇含 1 个 h1 + 1 个 h2 的文档里，
     * 点第 0/2/4 行分别落到第 1/3/6 行，越往下偏得越多。
     *
     * 间距要用 **padding** 表达（它计入 offsetHeight，CM6 算得对）。
     * 注意这是"行"层级的约束：行内的 inline 元素用 margin 没问题，
     * 因为那不影响行的 block 高度。
     */
    margin: '0',
  },
  '.cm-md-list': { listStyle: 'none' },

  /*
   * 列表的项目符号。
   *
   * 源码里的 `-` / `1.` 被藏掉后，行首就空了 —— 列表看起来只是
   * 一段缩进的普通文字。这里用 `::before` 把视觉标记补回来，
   * 内容由行装饰上的 `--md-marker` 变量给出（有序列表是真实序号）。
   *
   * ⚠️ `::before` 必须 `position: absolute`，缩进交给**行的 padding**。
   *
   * 原因是 CM6 的 x 坐标换算只认 `.cm-line` 自己的 padding，
   * **不认行内元素的占位**（伪元素算行内）。早先这条写的是
   * `display: inline-block; min-width: 1.1em; margin-right: 0.35em`，
   * 于是整行文本被右推约 25px 而 CM6 不知道 ——
   * 实测点第 0 个字符光标偏移 -1、点第 2 个偏移 4，
   * 拖选起手位置整个错位。
   *
   * 绝对定位的元素不参与行高、不占行内宽度，把缩进挪到行 padding 上即可。
   * 顺带一个好处：`min-width` + `text-align: right` 让 `1.` 与 `10.`
   * 宽度不一致时也不会让文本起点左右跳。
   */
  '.cm-line.cm-md-list-line': {
    position: 'relative',
    paddingLeft: '1.6em',
  },
  '.cm-line.cm-md-list-line::before': {
    content: 'var(--md-marker, "•")',
    position: 'absolute',
    left: '0.15em',
    width: '1.2em',
    textAlign: 'right',
    color: 'var(--md-muted)',
  },

  /*
   * 标题的排版节奏。
   *
   * 用 `padding` 而不是 `margin` 实现上下留白 —— 理由见上面
   * `.cm-line` 里那段（margin 会让点击落点整体偏移，且随标题数累积）。
   *
   * 选择器必须带 `.cm-line` 前缀：这些 class 由 `Decoration.line`
   * 加在行上，前缀让规则**只作用于行**，不误伤同名的行内元素。
   */
  '.cm-line.cm-md-h1': {
    fontSize: '1.7em',
    fontWeight: '600',
    lineHeight: '1.3',
    paddingTop: '0.9em',
    paddingBottom: '0.35em',
  },
  '.cm-line.cm-md-h2': {
    fontSize: '1.45em',
    fontWeight: '600',
    lineHeight: '1.2',
    paddingTop: '0.8em',
    paddingBottom: '0.3em',
  },
  '.cm-line.cm-md-h3': {
    fontSize: '1.22em',
    fontWeight: '600',
    lineHeight: '1.2',
    paddingTop: '0.7em',
    paddingBottom: '0.25em',
  },
  '.cm-line.cm-md-h4': {
    fontSize: '1.08em',
    fontWeight: '600',
    paddingTop: '0.6em',
    paddingBottom: '0.2em',
  },
  '.cm-line.cm-md-h5': {
    fontSize: '1em',
    fontWeight: '600',
    paddingTop: '0.55em',
    paddingBottom: '0.15em',
  },
  '.cm-line.cm-md-h6': {
    fontSize: '0.95em',
    fontWeight: '600',
    color: 'var(--md-muted)',
    paddingTop: '0.5em',
    paddingBottom: '0.15em',
  },

  '.cm-md-strong': { fontWeight: '600' },
  '.cm-md-em': { fontStyle: 'italic' },
  '.cm-md-strike': { textDecoration: 'line-through', color: 'var(--md-muted)' },
  '.cm-md-inline-code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.88em',
    background: 'var(--md-surface-2)',
    padding: '0.1em 0.32em',
    borderRadius: '4px',
  },
  '.cm-md-link': { color: 'var(--md-link)', textDecoration: 'none' },
  '.cm-md-image': { color: 'var(--md-link)' },

  /*
   * 图片。
   *
   * 三件事都是必须的，缺一个就会"看起来像没插进去"：
   *   - max-width 100%：大图会把行撑到视口外，横向滚动条一出现，
   *     整个编辑区的对齐就崩了
   *   - display: block：图片是 inline 时，基线对齐会在下方留出一条
   *     莫名的空白（那是 descender 的位置），看着像多余的行距
   *   - border-radius + 边框：截图类图片在白底上边界会糊掉
   */
  /*
   * 图片容器。
   *
   * 用 padding 而不是 margin —— 同上：这是行内块，margin 不计入行高，
   * 会让含图的行之后所有行的点击落点偏移。
   */
  '.cm-md-image-figure': { display: 'block', padding: '0.4em 0' },
  '.cm-md-image-img': {
    display: 'block',
    maxWidth: '100%',
    height: 'auto',
    borderRadius: '6px',
    border: '1px solid var(--md-border)',
  },
  '.cm-md-image-missing': {
    display: 'inline-block',
    padding: '0.15em 0.5em',
    border: '1px dashed var(--md-border-strong)',
    borderRadius: '4px',
    color: 'var(--md-muted)',
    fontSize: '0.92em',
  },

  // 分隔线。用 border-top 而不是 `<hr>`：宽度要跟随正文栏宽，
  // 且行内元素不能有外边距，只能靠 border 画。
  '.cm-md-hr-line': {
    display: 'inline-block',
    width: '100%',
    height: '0',
    borderTop: '1px solid var(--md-border-strong)',
    verticalAlign: 'middle',
  },

  /*
   * 任务复选框。
   *
   * 勾用 CSS 画（旋转 45° 的 L 形边框）而不是塞一个 "✓" 字符：
   * 字符依赖字体，而复选框会跟着文档走，落到任何一个没装对应字形的
   * 环境里就变成一个方框 —— 那正好和"未勾选"长得一样。
   */
  '.cm-md-task': {
    display: 'inline-block',
    width: '0.95em',
    height: '0.95em',
    border: '1.5px solid var(--md-border-strong)',
    borderRadius: '3px',
    marginRight: '0.4em',
    verticalAlign: '-0.12em',
    position: 'relative',
  },
  '.cm-md-task--done': {
    background: 'var(--md-link)',
    borderColor: 'var(--md-link)',
  },
  '.cm-md-task--done::after': {
    content: '""',
    position: 'absolute',
    left: '0.26em',
    top: '0.06em',
    width: '0.26em',
    height: '0.5em',
    borderRight: '1.6px solid #fff',
    borderBottom: '1.6px solid #fff',
    transform: 'rotate(45deg)',
  },

  // 表格的行内竖线：压低到接近背景，让内容成为主体。
  '.cm-md-vbar': { color: 'var(--md-border-strong)' },

  /*
   * ── 块级渲染（markdown-it 输出的 HTML）──────────────────────
   * 这些规则作用于 BlockWidget 内部 —— 与原预览窗同一套引擎输出，
   * 样式也按预览窗的观感走（真表格边框、真标题字号、引用块左线）。
   */
  /*
   * ⚠️ `.cm-md-block` 必须是 BFC（flow-root），且首尾子元素的 margin 归零。
   *
   * 块内元素（h1/p 等）的 margin 会**塌陷穿透**普通 div 容器 —— 容器的
   * offsetHeight 不含溢出的 margin，而 CM6 的垂直坐标按行高累加，
   * 不认 margin。于是"点击第 N 行、光标落到第 N+1 行"的误差随块数
   * 累积 —— 这是源码态那条老雷（.cm-line 上永远不能有 margin）在
   * 块渲染下的复发，症状一模一样。
   */
  '.cm-md-block': {
    display: 'flow-root',
    /*
     * 1.7 在渲染态下显得松散（用户反馈"预览模式行间距过大"）。
     * 1.55 接近 Typora 的正文行高，同时保留中文阅读的呼吸感。
     */
    lineHeight: '1.2',
  },
  '.cm-md-block > :first-child': { marginTop: 0 },
  '.cm-md-block > :last-child': { marginBottom: 0 },
  '.cm-md-block h1': { fontSize: '1.9em', fontWeight: '600', margin: '0.34em 0 0.16em', paddingBottom: '0.16em', borderBottom: '1px solid var(--md-border)' },
  '.cm-md-block h2': { fontSize: '1.5em', fontWeight: '600', margin: '0.42em 0 0.18em' },
  '.cm-md-block h3': { fontSize: '1.25em', fontWeight: '600', margin: '0.38em 0 0.16em' },
  '.cm-md-block h4': { fontSize: '1.1em', fontWeight: '600', margin: '0.34em 0 0.15em' },
  '.cm-md-block h5': { fontSize: '1em', fontWeight: '600', margin: '0.32em 0 0.15em' },
  '.cm-md-block h6': { fontSize: '0.95em', fontWeight: '600', color: 'var(--md-muted)', margin: '0.3em 0 0.15em' },
  '.cm-md-block p': { margin: '0.05em 0' },
  '.cm-md-block strong': { fontWeight: '600' },
  '.cm-md-block a': { color: 'var(--md-link)' },
  '.cm-md-block blockquote > p': { margin: '0' },
  '.cm-md-block blockquote': {
    /*
     * ⚠️ 必须显式设 margin —— 浏览器对 blockquote 的默认值是 1em 40px，
     * 主题不重置的话引用块上下各空 15px、左右各缩 40px（实测"引用间距
     * 很大"的根源）。
     */
    borderLeft: '3px solid var(--md-border-strong)',
    paddingLeft: '0.9em',
    margin: '0.2em 0',
    color: 'var(--md-muted)',
  },
  '.cm-md-block pre': {
    background: 'var(--md-surface-1)',
    padding: '10px 14px',
    borderRadius: '6px',
    overflowX: 'auto',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.92em',
    lineHeight: '1.6',
    margin: '0.5em 0',
  },
  '.cm-md-block code': { fontFamily: 'var(--font-mono)' },
  '.cm-md-block :not(pre) > code': {
    background: 'var(--md-surface-1)',
    padding: '0.1em 0.35em',
    borderRadius: '4px',
    fontSize: '0.9em',
    color: 'var(--md-code)',
  },
  '.cm-md-block table': { borderCollapse: 'collapse', margin: '0.6em 0', fontSize: '0.94em' },
  '.cm-md-block th': {
    border: '1px solid var(--md-border-strong)',
    padding: '5px 12px',
    background: 'var(--md-surface-1)',
    fontWeight: '600',
    textAlign: 'left',
  },
  '.cm-md-block td': { border: '1px solid var(--md-border)', padding: '5px 12px' },
  '.cm-md-block img': { maxWidth: '100%' },
  '.cm-md-block hr': { border: 'none', borderTop: '1px solid var(--md-border)', margin: '1em 0' },
  '.cm-md-block ul': { paddingLeft: '1.5em', margin: '0.08em 0' },
  /* 列表项内部的段落不参与段距 —— 否则每个项都被撑开（与行装饰侧同理） */
  '.cm-md-block li > p': { margin: '0' },
  '.cm-md-block ol': { paddingLeft: '1.5em', margin: '0.08em 0' },
  '.cm-md-block input[type=checkbox]': { marginRight: '0.45em', verticalAlign: 'middle' },
  '.cm-md-block .katex-display': { margin: '0.6em 0', overflowX: 'auto' },


  /*
   * ── highlight.js token 染色（代码块语法高亮）─────────────────
   * markdown-it 的 highlight 用 hljs 输出 <span class="hljs-*">，
   * 没有这些 CSS 时 token 全是正文色 —— "有高亮引擎但看不到颜色"。
   * 色值全部走主题的语法色变量，与源码态的 CM6 高亮同一套色板。
   */
  '.cm-md-block .hljs-keyword': { color: 'var(--md-syntax-keyword)' },
  '.cm-md-block .hljs-string': { color: 'var(--md-syntax-string)' },
  '.cm-md-block .hljs-number': { color: 'var(--md-syntax-number)' },
  '.cm-md-block .hljs-literal': { color: 'var(--md-syntax-number)' },
  '.cm-md-block .hljs-comment': { color: 'var(--md-muted)', fontStyle: 'italic' },
  '.cm-md-block .hljs-title': { color: 'var(--md-syntax-type)' },
  '.cm-md-block .hljs-title.function_': { color: 'var(--md-syntax-type)' },
  '.cm-md-block .hljs-type': { color: 'var(--md-syntax-type)' },
  '.cm-md-block .hljs-built_in': { color: 'var(--md-syntax-type)' },
  '.cm-md-block .hljs-attr': { color: 'var(--md-syntax-keyword)' },
  '.cm-md-block .hljs-symbol': { color: 'var(--md-syntax-number)' },
  '.cm-md-block .hljs-meta': { color: 'var(--md-muted)' },
  '.cm-md-block .hljs-tag': { color: 'var(--md-syntax-keyword)' },
  '.cm-md-block .hljs-name': { color: 'var(--md-syntax-keyword)' },
  '.cm-md-block .hljs-variable': { color: 'var(--md-text)' },
  '.cm-md-block .hljs-params': { color: 'var(--md-text)' },

  /*
   * ── Mermaid 图表 ──────────────────────────────────────────
   * 渲染完成前是源码占位（等宽 + 弱化底色），完成后是居中的 SVG。
   */
  '.cm-md-mermaid': {
    display: 'flex',
    justifyContent: 'center',
    margin: '0.6em 0',
  },
  '.cm-md-mermaid svg': { maxWidth: '100%' },
  '.cm-md-mermaid-err': { color: 'var(--md-state-red, #e05252)' },
  '.cm-md-mermaid-src': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.88em',
    background: 'var(--md-surface-1)',
    padding: '10px 14px',
    borderRadius: '6px',
    color: 'var(--md-muted)',
    margin: 0,
    whiteSpace: 'pre-wrap',
    width: '100%',
  },

  /*
   * ── highlight.js token 染色（代码块语法高亮）─────────────────
   * markdown-it 的 highlight 用 hljs 输出 <span class="hljs-*">，
   * 没有这些 CSS 时 token 全是正文色 —— "有高亮引擎但看不到颜色"。
   * 色值全部走主题的语法色变量，与源码态的 CM6 高亮同一套色板。
   */


  /*
   * ── 块级渲染（markdown-it 输出的 HTML）──────────────────────
   * 这些规则作用于 BlockWidget 内部 —— 与原预览窗同一套引擎输出，
   * 样式也按预览窗的观感走（真表格边框、真标题字号、引用块左线）。
   */


  /*
   * 被隐藏的 Markdown 标记。
   *
   * `display: none` 而不是 `font-size: 0` 之类：前者在盒模型里**彻底不存在**，
   * 不占宽度、不参与文字测量、不打断选区；后者虽然看不见，
   * 仍然是一个有位置的字符，浏览器会把它算进选区与坐标换算 ——
   * 正是那样才让"文字选择有问题"。
   *
   * ⚠️ 必须连**后代**一起打掉，并且用 `!important`：
   *
   * CM6 的语法高亮会把标记包进自己的 `<span class="ͼc ͼk">`，
   * 结构是 `<strong><span hidden><span highlight>**</span></span></strong>`。
   * 只隐藏外层时，内层高亮 span 仍是一个渲染实体（它带 `position: relative`
   * 这类样式），会把外层的 `display:none` 顶掉一部分，
   * 表现是"标记没藏住 + 那一行多出可疑的空白"。
   *
   * 这里同时命中 `.cm-md-hidden-mark` 本身与它的所有后代，
   * 保证整棵子树都不参与渲染。
   */
  '.cm-md-hidden-mark, .cm-md-hidden-mark *': {
    display: 'none !important',
  },

  '.cm-md-list-item': { paddingLeft: '0.2em' },
  '.cm-md-quote': {
    borderLeft: '3px solid var(--md-border-strong)',
    paddingLeft: '0.9em',
    color: 'var(--md-muted)',
  },
  /*
   * 代码块。
   *
   * 靠**行装饰**而不是 mark：mark 是行内片段，每行一块背景，
   * 接缝会横向断开，而代码块应该是一整块。行装饰跨行才连得起来。
   *
   * ⚠️ 选择器必须带 `.cm-line` 前缀。
   *
   * 这里的 `padding: 0 0.9em` 只对**行元素**是安全的 —— CM6 会把
   * `.cm-line` 的 padding-left 正确计入 x 坐标（实测：普通段落行
   * padding-left 6px 时，点第 k 个字符的光标偏移正好是 k）。
   *
   * 但如果同名的 class 也落在**行内**元素上（`BLOCK_CLASSES` 里的
   * `FencedCode` / `CodeBlock` 映射就会那样），那份 padding 会额外
   * 把内容右推 13.5px，而 CM6 **不认行内的这部分偏移** ——
   * 症状是鼠标落点整体右偏、拖选起点错位（实测点第 1 个字符
   * 光标落到第 2 个字符，拖选整行只选中 "on"）。
   *
   * 加前缀之后，"行内同名 class"不再获得 padding，这类偏移从根上消失。
   *
   * 同样不能设 display:block —— 代码块可以是多行的，
   * 一旦允许软折行（渲染态已改成 pre-wrap），每行各自成块会彻底散架。
   * 真正的换行交给围栏里的真实换行符。
   */
  '.cm-line.cm-md-code': {
    fontFamily: 'var(--font-mono)',
    background: 'var(--md-surface-1)',
    padding: '0 0.9em',
  },
  /*
   * 代码块的首行与末行：加上下内边距 + 四角圆角。
   *
   * 中间行**什么都不加** —— 它只要 `.cm-md-code` 的背景就能和上下行
   * 连成一整块；给它加上下内边距会把每行撑高（早期踩过：padding 逐行
   * 累加让代码行高 45px，普通行才 27px）。
   *
   * 圆角只落在整块的外侧两角：`.cm-line` 是块级元素，每行都有自己的背景盒，
   * 中间行的四角如果也带圆角，接缝处就会出现一排小豁口。
   */
  '.cm-md-code--first': {
    paddingTop: '0.5em',
    borderTopLeftRadius: '6px',
    borderTopRightRadius: '6px',
  },
  '.cm-md-code--last': {
    paddingBottom: '0.5em',
    borderBottomLeftRadius: '6px',
    borderBottomRightRadius: '6px',
  },

  '.cm-md-hr': { color: 'var(--md-border-strong)' },
  // 围栏行塌缩。用 font-size/line-height 归零而不是 display:none ——
  // CM6 需要这一行仍然存在才能定位光标，display:none 会让它算不出坐标。
  /*
   * 整行塌缩（代码围栏 ``` 与表格分隔行 `| --- |`）。
   *
   * 文字由 `collapseWholeLine` 用 `display: none` 藏掉，这里只负责让行高归零。
   *
   * ⚠️ 必须用 `font-size: 0`，不能只写 `line-height: 0`。
   *
   * `&.aropyt-render-mode .cm-line` 里已经有一条 `line-height: 1.8`
   * —— 它是 **2 个 class** 的特异性，而本条只有 1 个，
   * 于是 `line-height: 0` **静默失效**（实测围栏行仍是 28px 高，
   * 代码块上下各多一条空白）。
   *
   * `font-size` 则没有这个冲突（`.cm-line` 那条规则不设 font-size），
   * 而 `line-height: 1.8` 是**无单位倍数**、以自身 font-size 为基准，
   * 所以 `font-size: 0` 自动把行高也带到 0 —— 一个属性解决两件事，
   * 还避开了特异性竞赛。这是本项目第三次栽在"同属性两处定义"上，
   * 每次都是零报错，所以这条注释写得长一点。
   *
   * `visibility: hidden` 是错的方向：它不参与命中测试，但 CM6 量行高读的是
   * `getBoundingClientRect`（`visibility` 不影响它），真正的问题在文字本身还在，
   * 所以要从文字下手（见 `collapseWholeLine`）。
   */
  '.cm-md-fence-hidden': {
    fontSize: '0',
    padding: '0',
    overflow: 'hidden',
  },
  /*
   * 表格三件套：等宽（竖线纵向对齐的唯一手段）、表头加重、行分隔。
   * mark 跨行时 CM6 按行拆 span，border 落在每行的文本盒上 ——
   * 观感是行间分隔线，与预览窗的 <table> 边界接近。
   */
  '.cm-md-table': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.92em',
  },
  '.cm-md-table-head': {
    fontWeight: '600',
    borderBottom: '2px solid var(--md-border-strong)',
  },
  '.cm-md-table-row': {
    borderBottom: '1px solid var(--md-border)',
  },

  /*
   * 这里曾经有一条 `.cm-line.cm-md-h1/h2/h3 { paddingTop: '0.05em' }`，
   * 已删除。
   *
   * 它是标题样式演进过程中的残骸：早期的标题只有字号字重、没有上下留白，
   * 所以补了 0.05em 的微调。后来标题改用 paddingTop/paddingBottom 做
   * 完整的排版节奏（见上方 `.cm-line.cm-md-hN`），这条就该走了 ——
   * 但它**留在了文件末尾**，而 CSS 里同特异性规则**后写的胜**，
   * 于是把新写的 `paddingTop: 0.9em` 静默压成了 0.05em。
   *
   * 实测症状：一级标题的上边距只有 1.275px（应约 23px），
   * 标题与上文的间距全靠偶然。
   *
   * 教训与 theme.ts 里那条一样：**同一条属性不能定义两处**。
   * 在同一个文件里也一样 —— 相隔 200 行就足以让人找不到它。
   */
});

type Extension = import('@codemirror/state').Extension;