/**
 * 内置插件：LaTeX。
 *
 * 与 Fountain 插件同构：识别已经在内核里（`core/languages.ts`），
 * 这里是渲染。三件事：
 *
 *   1. **结构视图**（侧栏）—— 章节/小节列表，点击跳转。
 *   2. **公式渲染** —— `$…$`、`\(…\)`、`\[…\]`、`$$…$$`、
 *      `\begin{equation|align|gather|…}` 用 KaTeX 原地排版。
 *   3. **文档排版** —— 标题页、章节、列表、表格、代码块、引用、摘要、
 *      以及一批只影响排版的命令（`\textbf` / `\ref` / `\label` / `~` …）。
 *
 * ── 为什么不是"KaTeX 渲染一下公式"就完事 ────────────────────
 * KaTeX 是数学排版库，不是 LaTeX 文档引擎：它只认 `$…$` 里的数学语法。
 * `\section{}`、`\begin{tabular}`、`\textbf{}` 属于文档层，需要自己实现
 * 一层（markdown 那边靠 markdown-it 做的正是这件事）。
 *
 * ── 两个必须遵守的约束 ─────────────────────────────────────
 * 1. 跨行块（公式、表格）的装饰必须由 StateField 提供：
 *    CM6 明确禁止 ViewPlugin 产出 `block: true` 的装饰。
 * 2. 凡是替换掉字符的装饰，都要做**光标避让**（选区碰到就退回源码）。
 *    否则公式、表格、标题命令都会变成"点不进去的区域"。
 */

import {
  EditorState,
  StateField,
  type Extension,
  type Range,
} from '@codemirror/state';
import { Decoration, WidgetType, EditorView, type DecorationSet } from '@codemirror/view';
import type { PluginContext, PluginManifest, ViewProvider } from '@aropyt/plugin-api';
import type { LoadablePlugin } from '@aropyt/core';
import { t } from '../i18n';

const LANGUAGE_ID = 'latex';
const VIEW_ID = 'aropyt.latex.structure';

/* ── 章节结构 ─────────────────────────────────────────────── */

const SECTION_LEVELS = [
  'part',
  'chapter',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
] as const;

const SECTION_RE =
  /\\\s*(part|chapter|section|subsection|subsubsection|paragraph)\s*\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/;

/**
 * 章节层级 → 标题字号类。
 *
 * `part` 与 `chapter` 同属最高一级：`article` 里没有 chapter，
 * `book` 里 chapter 才是最大的分节单位，两者都给 h1 才能让
 * `\section` 稳定落在"二级标题"上。
 */
const HEADING_CLASS = [
  'cm-tex-h1',
  'cm-tex-h1',
  'cm-tex-h2',
  'cm-tex-h3',
  'cm-tex-h4',
  'cm-tex-h5',
] as const;

export interface TexSection {
  /** 1 起算，与 editor.revealLine 一致。 */
  readonly number: number;
  /** 层级（0 = part，2 = section …），用于缩进。 */
  readonly level: number;
  readonly title: string;
}

/** 提取章节标题。纯函数，供视图与测试共用。 */
export function extractSections(text: string): readonly TexSection[] {
  const out: TexSection[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = SECTION_RE.exec(lines[index] ?? '');
    if (!match) continue;
    out.push({
      number: index + 1,
      level: SECTION_LEVELS.indexOf(match[1] as (typeof SECTION_LEVELS)[number]),
      title: (match[2] ?? '').trim(),
    });
  }
  return out;
}

/* ── 通用小工具 ───────────────────────────────────────────── */

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function touchesSelection(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

/**
 * 把一段 LaTeX 源码变成"看起来像文字"的纯文本。
 *
 * 用于表格单元格与 `\caption`：这些地方的命令必须去掉（`\textbf{Alpha}`
 * 显示成 Alpha），否则表格里全是反斜杠。
 */
function stripCommands(source: string): string {
  let out = source;
  /* 最多剥 5 层：嵌套命令（\textbf{\emph{x}}）是常见写法，一层不够 */
  for (let round = 0; round < 5; round += 1) {
    const next = out.replace(/\\[A-Za-z]+\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g, '$1');
    if (next === out) break;
    out = next;
  }
  return out
    .replace(/\\[A-Za-z]+\*?/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── 公式渲染 ─────────────────────────────────────────────── */

interface KaTeXApi {
  renderToString(tex: string, options?: Record<string, unknown>): string;
}

let katexModule: Promise<KaTeXApi> | null = null;
/** 渲染结果缓存：滚动会反复重建 widget DOM，renderToString 不该重跑。 */
const mathCache = new Map<string, string>();

function loadKatex(): Promise<KaTeXApi> {
  katexModule ??= import('katex').then(
    (module) => (module as unknown as { default: KaTeXApi }).default,
  );
  return katexModule;
}

async function fillMath(target: HTMLElement, tex: string, display: boolean): Promise<void> {
  const key = `${display ? 'D' : 'I'}\u0000${tex}`;
  let html = mathCache.get(key);
  if (html === undefined) {
    try {
      const katex = await loadKatex();
      html = katex.renderToString(tex, { displayMode: display, throwOnError: false });
      mathCache.set(key, html);
    } catch {
      /* 渲染失败就保留源码占位 —— 公式内容不丢 */
      return;
    }
  }
  target.innerHTML = html;

  /*
   * 高度变了，必须让 CM6 重新测量。
   *
   * KaTeX 是异步加载的：widget 先以源码文本占位（大约一行高），排版结果
   * 填进来之后高度往往差好几行。CM6 的高度图只在插入时测量一次，不重测
   * 的话——它以为内容比实际短——之后每一次点击都会按旧坐标换算位置，
   * 表现就是"点这一行、插入符出现在下一行"（实测：点击 `Table~\\ref…`
   * 那一行，光标落到下面的空行）。
   */
  EditorView.findFromDOM(target)?.requestMeasure();
}

class MathWidget extends WidgetType {
  constructor(
    private readonly tex: string,
    private readonly display: boolean,
  ) {
    super();
  }

  override eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display;
  }

  override toDOM(): HTMLElement {
    const node = document.createElement(this.display ? 'div' : 'span');
    node.className = this.display ? 'cm-tex-math-block' : 'cm-tex-math-inline';
    /* 先放源码：KaTeX 是异步加载的，空白占位会让公式"闪一下" */
    node.textContent = this.tex;
    void fillMath(node, this.tex, this.display);
    return node;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** 用一个纯文本替换一段命令（`\LaTeX` → LaTeX、`~` → 空格、`\%` → %）。 */
class TextWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly kind: 'text' | 'ref' | 'image' = 'text',
  ) {
    super();
  }

  override eq(other: TextWidget): boolean {
    return other.text === this.text && other.kind === this.kind;
  }

  override toDOM(): HTMLElement {
    const node = document.createElement('span');
    node.className =
      this.kind === 'ref' ? 'cm-tex-ref' : this.kind === 'image' ? 'cm-tex-image' : 'cm-tex-text';
    node.textContent = this.text;
    return node;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** 隐藏一段源码（环境行、命令与花括号）。 */
class EmptyWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  override toDOM(): HTMLElement {
    const node = document.createElement('span');
    node.className = 'cm-tex-hidden';
    return node;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class BulletWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }

  override eq(other: BulletWidget): boolean {
    return other.label === this.label;
  }

  override toDOM(): HTMLElement {
    const node = document.createElement('span');
    node.className = 'cm-tex-bullet';
    node.textContent = this.label;
    return node;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class PageBreakWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  override toDOM(): HTMLElement {
    const node = document.createElement('div');
    node.className = 'cm-tex-pagebreak';
    return node;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/* ── 表格 ─────────────────────────────────────────────────── */

interface TableModel {
  readonly align: readonly ('left' | 'center' | 'right')[];
  readonly rows: readonly (readonly string[])[];
  /** 在第 rows[i] 行之前画一条分隔线；等于 rows.length 表示表格末尾。 */
  readonly rules: readonly number[];
  readonly caption: string | null;
}

const ALIGN_OF: Record<string, 'left' | 'center' | 'right'> = {
  l: 'left',
  c: 'center',
  r: 'right',
};

/**
 * 解析 `tabular`（含外层的 `table` 浮动体）。
 *
 * 只做最常见的子集：`&` 分列、`\\` 分行、`\toprule/\midrule/\bottomrule/\hline`
 * 画线、`\caption` 作表题。列格式里的 `|`、`p{…}`、`@{…}` 一律忽略 ——
 * 它们影响的是列宽与竖线，而这个视图的宽度由窗口决定。
 */
function parseTable(body: string): TableModel | null {
  const tabular =
    /\\begin\{(tabular\*?|tabularx|array)\}\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}([\s\S]*?)\\end\{\1\}/.exec(
      body,
    );

  const source = tabular ? (tabular[3] ?? '') : body;
  const spec = tabular ? (tabular[2] ?? '') : '';
  const align = [...spec]
    .map((char) => ALIGN_OF[char])
    .filter((item): item is 'left' | 'center' | 'right' => item !== undefined);

  const captionMatch = /\\caption\{([\s\S]*?)\}/.exec(body);
  const caption = captionMatch ? stripCommands(captionMatch[1] ?? '') : null;

  let content = source
    .replace(/\\caption\{[\s\S]*?\}/g, '')
    .replace(/\\label\{[^}]*\}/g, '');

  const rows: string[][] = [];
  const rules: number[] = [];

  /* `\\[2pt]` 的可选间距参数要一起吃掉，否则会变成单元格内容 */
  for (const chunk of content.split(/\\\\(?:\[[^\]]*\])?/)) {
    let text = chunk.trim();
    if (text.length === 0) continue;

    const rule = /^\\(toprule|midrule|bottomrule|hline|cline\{[^}]*\})\b/.exec(text);
    if (rule) {
      if (rows.length > 0 || rules.length === 0) rules.push(rows.length);
      text = text.slice(rule[0].length).trim();
      if (text.length === 0) continue;
    }

    rows.push(text.split('&').map((cell) => stripCommands(cell)));
  }

  if (rows.length === 0) return null;
  return { align, rows, rules, caption };
}

class TableWidget extends WidgetType {
  constructor(private readonly model: TableModel) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return JSON.stringify(other.model) === JSON.stringify(this.model);
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-tex-table';

    const table = document.createElement('table');
    const body = document.createElement('tbody');

    this.model.rows.forEach((cells, index) => {
      const row = document.createElement('tr');
      if (this.model.rules.includes(index)) row.className = 'cm-tex-rule';
      /* 末尾的 \bottomrule 落在 rows.length 上，没有对应行可挂上边框 */
      if (index === this.model.rows.length - 1 && this.model.rules.includes(this.model.rows.length)) {
        row.classList.add('cm-tex-rule-bottom');
      }
      cells.forEach((cell, column) => {
        const td = document.createElement('td');
        td.textContent = cell;
        td.style.textAlign = this.model.align[column] ?? 'left';
        row.append(td);
      });
      body.append(row);
    });

    table.append(body);
    wrap.append(table);

    if (this.model.caption) {
      const caption = document.createElement('div');
      caption.className = 'cm-tex-caption';
      caption.textContent = this.model.caption;
      wrap.append(caption);
    }

    return wrap;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/* ── 环境块扫描 ───────────────────────────────────────────── */

type EnvKind = 'table' | 'code' | 'quote' | 'abstract' | 'figure';

const ENV_KINDS: Record<string, EnvKind> = {
  table: 'table',
  'table*': 'table',
  tabular: 'table',
  'tabular*': 'table',
  tabularx: 'table',
  figure: 'figure',
  'figure*': 'figure',
  verbatim: 'code',
  'verbatim*': 'code',
  lstlisting: 'code',
  minted: 'code',
  quote: 'quote',
  quotation: 'quote',
  abstract: 'abstract',
};

interface EnvBlock {
  readonly kind: EnvKind;
  readonly name: string;
  /** 块起点（\begin 所在行首）与终点（\end 所在行尾）。 */
  readonly from: number;
  readonly to: number;
  readonly startLine: number;
  readonly endLine: number;
  /** 去掉首尾环境行后的正文。 */
  readonly body: string;
}

const BEGIN_RE = /^\s*\\begin\{([^}]+)\}/;
const END_RE = /^\s*\\end\{([^}]+)\}/;

/**
 * 扫描文档级的"有结构的环境"。
 *
 * 找到 `\begin{X}` 就一路跳到匹配的 `\end{X}`，中间不再识别别的环境 ——
 * `table` 里嵌着 `tabular` 是标准写法，外层已经整体渲染成表格，
 * 内层再算一次只会重复。
 */
function scanEnvironments(state: EditorState): readonly EnvBlock[] {
  const doc = state.doc;
  const out: EnvBlock[] = [];
  let line = 1;

  while (line <= doc.lines) {
    const text = doc.line(line).text;
    const begin = BEGIN_RE.exec(text);
    const kind = begin ? ENV_KINDS[begin[1] ?? ''] : undefined;
    if (!begin || !kind) {
      line += 1;
      continue;
    }

    const name = begin[1] ?? '';
    let endLine = -1;
    for (let probe = line; probe <= doc.lines; probe += 1) {
      if (END_RE.exec(doc.line(probe).text)?.[1] === name) {
        endLine = probe;
        break;
      }
    }
    if (endLine < 0) {
      /* 没闭合：当作普通文本，别把后面整篇吞掉 */
      line += 1;
      continue;
    }

    const bodyLines: string[] = [];
    for (let inner = line + 1; inner < endLine; inner += 1) {
      bodyLines.push(doc.line(inner).text);
    }

    out.push({
      kind,
      name,
      from: doc.line(line).from,
      to: doc.line(endLine).to,
      startLine: line,
      endLine,
      body: bodyLines.join('\n'),
    });
    line = endLine + 1;
  }

  return out;
}

/* ── 行内命令表 ───────────────────────────────────────────── */

/** 换成对应文字的命令（不产生排版，只产生文本）。 */
const TEXT_COMMANDS: Record<string, string> = {
  LaTeX: 'LaTeX',
  LaTeXe: 'LaTeX2e',
  TeX: 'TeX',
  XeTeX: 'XeTeX',
  LuaTeX: 'LuaTeX',
  BibTeX: 'BibTeX',
};

/** 命令本身与花括号藏起来、内容加样式。 */
const STYLE_COMMANDS: Record<string, string> = {
  textbf: 'cm-tex-bold',
  textit: 'cm-tex-italic',
  emph: 'cm-tex-italic',
  texttt: 'cm-tex-mono',
  underline: 'cm-tex-underline',
  textsf: 'cm-tex-sans',
  textrm: 'cm-tex-serif',
  textsc: 'cm-tex-smallcaps',
};

/** 交叉引用：内容保留、淡化显示（无法解析真实编号，但至少不再是裸命令）。 */
const REF_COMMANDS = new Set(['ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref']);

/** 整行没有任何输出、直接隐藏的命令。 */
const VOID_LINE_COMMANDS = new Set([
  'maketitle',
  'tableofcontents',
  'listoffigures',
  'listoftables',
  'centering',
  'noindent',
  'indent',
  'label',
  'index',
  'bibliography',
  'bibliographystyle',
  'printbibliography',
]);

/** 转义字符：`\%` → `%`。 */
const ESCAPED_CHARS: Record<string, string> = {
  '%': '%',
  '&': '&',
  _: '_',
  '#': '#',
  $: '$',
  '{': '{',
  '}': '}',
  '\\': ' ',
};

/**
 * 行内排版。
 *
 * 从左到右一次扫描，而不是叠几个全局正则：公式、命令、转义字符会互相
 * 包含（`$\textbf{x}$` 里的 `\textbf` 属于数学，不该被当排版命令），
 * 多个正则各扫一遍必然打架。
 */
function decorateInline(line: { readonly from: number; readonly text: string }, ranges: Range<Decoration>[], state: EditorState): void {
  const text = line.text;
  /** 已被公式占用的区间（相对偏移），后续命令跳过它们。 */
  const mathSpans: { from: number; to: number }[] = [];
  const occupied = (from: number, to: number): boolean =>
    mathSpans.some((span) => from < span.to && to > span.from);

  let index = 0;
  while (index < text.length) {
    const char = text[index];

    /* 注释之后全部是注释 */
    if (char === '%' && !isEscaped(text, index)) break;

    /* ── 行内公式 $…$ ── */
    if (char === '$' && text[index + 1] !== '$' && !isEscaped(text, index)) {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === '$' && !isEscaped(text, end)) break;
        if (text[end] === '%' && !isEscaped(text, end)) {
          end = text.length;
          break;
        }
        end += 1;
      }
      if (end < text.length && end > index + 1) {
        const from = line.from + index;
        const to = line.from + end + 1;
        if (!touchesSelection(state, from, to)) {
          ranges.push(
            Decoration.replace({ widget: new MathWidget(text.slice(index + 1, end), false) }).range(
              from,
              to,
            ),
          );
        }
        mathSpans.push({ from, to });
        index = end + 1;
        continue;
      }
    }

    /* ── 行内公式 \(…\) ── */
    if (char === '\\' && text[index + 1] === '(') {
      const end = text.indexOf('\\)', index + 2);
      if (end !== -1 && end > index + 2) {
        const from = line.from + index;
        const to = line.from + end + 2;
        if (!touchesSelection(state, from, to)) {
          ranges.push(
            Decoration.replace({
              widget: new MathWidget(text.slice(index + 2, end), false),
            }).range(from, to),
          );
        }
        mathSpans.push({ from, to });
        index = end + 2;
        continue;
      }
    }

    /* ── 反斜杠：转义字符或命令 ── */
    if (char === '\\') {
      const next = text[index + 1] ?? '';

      /* 转义字符：\% \& \_ \# \$ \{ \} */
      if (ESCAPED_CHARS[next] !== undefined) {
        const from = line.from + index;
        const to = from + 2;
        if (!occupied(from, to) && !touchesSelection(state, from, to)) {
          ranges.push(
            Decoration.replace({ widget: new TextWidget(ESCAPED_CHARS[next] ?? '') }).range(
              from,
              to,
            ),
          );
        }
        index += 2;
        continue;
      }

      const command = /^\\([A-Za-z]+)\*?/.exec(text.slice(index));
      if (command) {
        const name = command[1] ?? '';
        const commandEnd = index + command[0].length;

        /* \today：日期是运行时才知道的，不能进静态表 */
        if (name === 'today') {
          let end = commandEnd;
          if (text[end] === '{' && text[end + 1] === '}') end += 2;
          const from = line.from + index;
          const to = line.from + end;
          if (!occupied(from, to) && !touchesSelection(state, from, to)) {
            ranges.push(
              Decoration.replace({
                widget: new TextWidget(new Date().toLocaleDateString()),
              }).range(from, to),
            );
          }
          index = end;
          continue;
        }

        /* 换字的命令：\LaTeX{} / \TeX{} */
        if (TEXT_COMMANDS[name] !== undefined) {
          let end = commandEnd;
          if (text[end] === '{' && text[end + 1] === '}') end += 2;
          const from = line.from + index;
          const to = line.from + end;
          if (!occupied(from, to) && !touchesSelection(state, from, to)) {
            ranges.push(
              Decoration.replace({ widget: new TextWidget(TEXT_COMMANDS[name] ?? '') }).range(
                from,
                to,
              ),
            );
          }
          index = end;
          continue;
        }

        /* 带一个花括号参数的排版命令 */
        if (STYLE_COMMANDS[name] !== undefined && text[commandEnd] === '{') {
          const close = text.indexOf('}', commandEnd + 1);
          if (close !== -1) {
            const contentFrom = line.from + commandEnd + 1;
            const contentTo = line.from + close;
            const absFrom = line.from + index;
            const absTo = line.from + close + 1;
            if (!occupied(absFrom, absTo) && !touchesSelection(state, absFrom, absTo)) {
              ranges.push(
                Decoration.replace({ widget: new EmptyWidget() }).range(
                  absFrom,
                  line.from + commandEnd + 1,
                ),
              );
              ranges.push(
                Decoration.replace({ widget: new EmptyWidget() }).range(
                  line.from + close,
                  absTo,
                ),
              );
              if (close > commandEnd + 1) {
                ranges.push(
                  Decoration.mark({ class: STYLE_COMMANDS[name] }).range(contentFrom, contentTo),
                );
              }
            }
            index = close + 1;
            continue;
          }
        }

        /* 引用：\ref{key} → 保留 key 并淡化 */
        if (REF_COMMANDS.has(name) && text[commandEnd] === '{') {
          const close = text.indexOf('}', commandEnd + 1);
          if (close !== -1) {
            const absFrom = line.from + index;
            const absTo = line.from + close + 1;
            if (!occupied(absFrom, absTo) && !touchesSelection(state, absFrom, absTo)) {
              ranges.push(
                Decoration.replace({ widget: new EmptyWidget() }).range(
                  absFrom,
                  line.from + commandEnd + 1,
                ),
              );
              ranges.push(
                Decoration.replace({ widget: new EmptyWidget() }).range(line.from + close, absTo),
              );
              if (close > commandEnd + 1) {
                ranges.push(
                  Decoration.mark({ class: 'cm-tex-ref' }).range(
                    line.from + commandEnd + 1,
                    line.from + close,
                  ),
                );
              }
            }
            index = close + 1;
            continue;
          }
        }

        /* 只影响排版、没有可见内容的命令：\label{…} \index{…} \vspace{…} */
        if (
          ['label', 'index', 'vspace', 'hspace', 'footnotesize', 'small', 'large'].includes(name)
        ) {
          let end = commandEnd;
          if (text[end] === '{') {
            const close = text.indexOf('}', end + 1);
            if (close !== -1) end = close + 1;
          }
          const from = line.from + index;
          const to = line.from + end;
          if (!occupied(from, to) && !touchesSelection(state, from, to)) {
            ranges.push(Decoration.replace({ widget: new EmptyWidget() }).range(from, to));
          }
          index = end;
          continue;
        }
      }

      index += 1;
      continue;
    }

    /* ── 不换行空格 ~ ── */
    if (char === '~') {
      const from = line.from + index;
      const to = from + 1;
      if (!occupied(from, to) && !touchesSelection(state, from, to)) {
        ranges.push(Decoration.replace({ widget: new TextWidget(' ') }).range(from, to));
      }
      index += 1;
      continue;
    }

    index += 1;
  }
}

/* ── 行级命令 ─────────────────────────────────────────────── */

const VOID_LINE_RE = /^\s*\\([A-Za-z]+)\*?\s*(?:\{[^}]*\})?\s*$/;
const PAGE_BREAK_RE = /^\s*\\(newpage|clearpage|pagebreak|cleardoublepage)\s*$/;
const DOCUMENT_ENV_RE = /^\s*\\(begin|end)\{document\}\s*$/;

/* ── 装饰构建 ─────────────────────────────────────────────── */

interface BlockMath {
  readonly from: number;
  readonly to: number;
  readonly tex: string;
}

const BLOCK_OPENERS: readonly { readonly open: string; readonly close: string }[] = [
  { open: '$$', close: '$$' },
  { open: '\\[', close: '\\]' },
];

const MATH_ENV_OPEN = /^\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|displaymath|eqnarray\*?)\}/;

/** 扫描跨行与单行的块级公式，返回区间与正文。 */
function scanMathBlocks(state: EditorState): readonly BlockMath[] {
  const doc = state.doc;
  const out: BlockMath[] = [];
  let line = 1;

  while (line <= doc.lines) {
    const first = doc.line(line);
    const trimmed = first.text.trimStart();

    let close = '';
    let bodyStart = 0;
    /*
     * 数学环境要**连环境本身**一起交给 KaTeX。
     *
     * `align` 里的 `&` 是环境级别的对齐标记，剥掉 `\begin{align}…\end{align}`
     * 只把中间那几行传进去，KaTeX 会直接报 "Unexpected alignment tab"，
     * 公式于是退化成源码（实测：整篇文档里最显眼的那一段没渲染）。
     */
    let envOpen = -1;

    for (const opener of BLOCK_OPENERS) {
      if (trimmed.startsWith(opener.open)) {
        close = opener.close;
        bodyStart = first.text.indexOf(opener.open) + opener.open.length;
        break;
      }
    }
    const env = close === '' ? MATH_ENV_OPEN.exec(trimmed) : null;
    if (close === '' && env) {
      close = `\\end{${env[1] ?? ''}}`;
      envOpen = first.text.indexOf(env[0]);
      bodyStart = envOpen + env[0].length;
    }
    if (close === '') {
      line += 1;
      continue;
    }

    /* 单行：定界符在同一行闭合 */
    const inlineClose = first.text.indexOf(close, bodyStart);
    if (inlineClose !== -1 && close !== '$$') {
      out.push({
        from: first.from,
        to: first.to,
        tex:
          envOpen >= 0
            ? first.text.slice(envOpen, inlineClose + close.length)
            : first.text.slice(bodyStart, inlineClose).trim(),
      });
      line += 1;
      continue;
    }

    let endLine = line + 1;
    let endAt = -1;
    while (endLine <= doc.lines) {
      const at = doc.line(endLine).text.indexOf(close);
      if (at !== -1) {
        endAt = at;
        break;
      }
      endLine += 1;
    }
    if (endLine > doc.lines) {
      line += 1;
      continue;
    }

    const endDocLine = doc.line(endLine);
    const parts: string[] = [];
    if (endLine === line) {
      parts.push(first.text.slice(bodyStart, endAt));
    } else {
      parts.push(first.text.slice(bodyStart));
      for (let inner = line + 1; inner < endLine; inner += 1) {
        parts.push(doc.line(inner).text);
      }
      parts.push(endDocLine.text.slice(0, endAt));
    }

    out.push({
      from: first.from,
      to: endDocLine.to,
      tex:
        envOpen >= 0
          ? doc.sliceString(first.from + envOpen, endDocLine.from + endAt + close.length)
          : parts.join('\n').trim(),
    });
    line = endLine + 1;
  }

  return out;
}

function buildDecorations(state: EditorState, active: boolean): DecorationSet {
  if (!active) return Decoration.none;

  const doc = state.doc;
  const ranges: Range<Decoration>[] = [];
  /** 被块级装饰整体替换的行：行内扫描必须跳过它们。 */
  const handledLines = new Set<number>();
  const markLines = (start: number, end: number): void => {
    for (let n = start; n <= end; n += 1) handledLines.add(n);
  };

  /* ── 块级公式 ── */
  for (const block of scanMathBlocks(state)) {
    markLines(doc.lineAt(block.from).number, doc.lineAt(block.to).number);
    if (block.tex.length === 0 || touchesSelection(state, block.from, block.to)) continue;
    ranges.push(
      Decoration.replace({ block: true, widget: new MathWidget(block.tex, true) }).range(
        block.from,
        block.to,
      ),
    );
  }

  /* ── 结构环境（表格 / 代码 / 引用 / 摘要 / 图） ── */
  for (const block of scanEnvironments(state)) {
    markLines(block.startLine, block.endLine);

    if (block.kind === 'table') {
      const model = parseTable(block.body);
      if (!model || touchesSelection(state, block.from, block.to)) {
        /* 解析失败或光标在里面：保留源码，只淡化环境行 */
        for (const lineNo of [block.startLine, block.endLine]) {
          const line = doc.line(lineNo);
          ranges.push(Decoration.line({ class: 'cm-tex-environment' }).range(line.from));
        }
        continue;
      }
      ranges.push(
        Decoration.replace({ block: true, widget: new TableWidget(model) }).range(
          block.from,
          block.to,
        ),
      );
      continue;
    }

    /* 环境行（\begin / \end）一律隐藏 —— 它们在这几个块里没有信息量 */
    const hideLine = (lineNo: number): void => {
      const line = doc.line(lineNo);
      if (line.to > line.from && !touchesSelection(state, line.from, line.to)) {
        ranges.push(
          Decoration.replace({ block: true, widget: new EmptyWidget() }).range(line.from, line.to),
        );
      }
    };
    hideLine(block.startLine);
    hideLine(block.endLine);

    for (let inner = block.startLine + 1; inner < block.endLine; inner += 1) {
      const line = doc.line(inner);
      if (block.kind === 'code') {
        ranges.push(Decoration.line({ class: 'cm-tex-code' }).range(line.from));
        continue;
      }
      if (block.kind === 'quote') {
        ranges.push(Decoration.line({ class: 'cm-tex-quote' }).range(line.from));
      } else if (block.kind === 'abstract') {
        ranges.push(Decoration.line({ class: 'cm-tex-abstract' }).range(line.from));
      } else if (block.kind === 'figure') {
        ranges.push(Decoration.line({ class: 'cm-tex-figure' }).range(line.from));
      }
    }

    if (block.kind === 'figure') {
      /* 没有资源通道：`\includegraphics` 显示成路径占位，比裸露命令诚实 */
      for (let inner = block.startLine + 1; inner < block.endLine; inner += 1) {
        const line = doc.line(inner);
        const image = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(line.text);
        if (!image || touchesSelection(state, line.from, line.to)) continue;
        ranges.push(
          Decoration.replace({
            widget: new TextWidget(`[图片] ${image[1] ?? ''}`, 'image'),
          }).range(line.from + (image.index ?? 0), line.from + (image.index ?? 0) + image[0].length),
        );
      }
    }

    /* 代码块内部不做任何行内解析（verbatim 的字面意思就是"照原样"） */
    if (block.kind === 'code') continue;
    for (let inner = block.startLine + 1; inner < block.endLine; inner += 1) {
      if (block.kind === 'figure') continue;
      decorateInline(doc.line(inner), ranges, state);
    }
  }

  /* ── 逐行：标题页 / 整行命令 / 章节 / 行内 ── */
  const listStack: { kind: 'itemize' | 'enumerate'; count: number }[] = [];

  for (let number = 1; number <= doc.lines; number += 1) {
    if (handledLines.has(number)) continue;
    const line = doc.line(number);
    const raw = line.text;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    /* `\begin{document}` / `\end{document}`：没有可见内容 */
    if (DOCUMENT_ENV_RE.test(raw)) {
      if (!touchesSelection(state, line.from, line.to)) {
        ranges.push(
          Decoration.replace({ block: true, widget: new EmptyWidget() }).range(line.from, line.to),
        );
      }
      continue;
    }

    /* 分页命令 → 一条虚的分页线 */
    if (PAGE_BREAK_RE.test(raw)) {
      if (!touchesSelection(state, line.from, line.to)) {
        ranges.push(
          Decoration.replace({ block: true, widget: new PageBreakWidget() }).range(
            line.from,
            line.to,
          ),
        );
      }
      continue;
    }

    /* 整行命令（\maketitle / \tableofcontents / \label{…} …）：没有输出 */
    const voidLine = VOID_LINE_RE.exec(raw);
    if (voidLine && VOID_LINE_COMMANDS.has(voidLine[1] ?? '')) {
      if (!touchesSelection(state, line.from, line.to)) {
        ranges.push(
          Decoration.replace({ block: true, widget: new EmptyWidget() }).range(line.from, line.to),
        );
      }
      continue;
    }

    /* 列表环境：整行隐藏（\begin{itemize} / \end{enumerate}） */
    const listEnv = /^\s*\\(begin|end)\{(itemize|enumerate)\}\s*$/.exec(raw);
    if (listEnv) {
      if (listEnv[1] === 'begin') {
        listStack.push({ kind: listEnv[2] as 'itemize' | 'enumerate', count: 0 });
      } else {
        listStack.pop();
      }
      if (!touchesSelection(state, line.from, line.to)) {
        ranges.push(
          Decoration.replace({ block: true, widget: new EmptyWidget() }).range(line.from, line.to),
        );
      }
      continue;
    }

    /* \item：换成项目符号，保留其后的文本（继续做行内处理） */
    const item = /^\s*\\item\b\s*/.exec(raw);
    if (item && listStack.length > 0) {
      const current = listStack[listStack.length - 1];
      let label = '•';
      if (current.kind === 'enumerate') {
        current.count += 1;
        label = `${String(current.count)}.`;
      }
      ranges.push(Decoration.line({ class: 'cm-tex-item' }).range(line.from));
      const indent = item[0].length - item[0].trimStart().length;
      if (!touchesSelection(state, line.from, line.to)) {
        ranges.push(
          Decoration.replace({ widget: new BulletWidget(label) }).range(
            line.from + indent,
            line.from + item[0].length,
          ),
        );
      }
    }

    /* 注释 / 其它环境行 / 导言行：整行淡化 */
    if (trimmed.startsWith('%')) {
      ranges.push(Decoration.line({ class: 'cm-tex-comment' }).range(line.from));
      continue;
    }
    if (/^\s*\\(begin|end)\{/.test(raw)) {
      ranges.push(Decoration.line({ class: 'cm-tex-environment' }).range(line.from));
      continue;
    }
    if (/^\s*\\(documentclass|usepackage|newcommand|renewcommand|input|include)\b/.test(raw)) {
      ranges.push(Decoration.line({ class: 'cm-tex-preamble' }).range(line.from));
      continue;
    }

    /* 标题页：\title / \author / \date */
    const meta = /^\s*\\(title|author|date)\s*\{/.exec(raw);
    if (meta) {
      const css =
        meta[1] === 'title' ? 'cm-tex-title' : meta[1] === 'author' ? 'cm-tex-author' : 'cm-tex-date';
      ranges.push(Decoration.line({ class: css }).range(line.from));
      const brace = raw.indexOf('{', meta.index);
      const close = raw.lastIndexOf('}');
      if (!touchesSelection(state, line.from, line.to)) {
        if (brace !== -1) {
          ranges.push(
            Decoration.replace({ widget: new EmptyWidget() }).range(
              line.from + meta.index,
              line.from + brace + 1,
            ),
          );
        }
        if (close > brace) {
          ranges.push(
            Decoration.replace({ widget: new EmptyWidget() }).range(
              line.from + close,
              line.from + close + 1,
            ),
          );
        }
      }
      decorateInline(line, ranges, state);
      continue;
    }

    /* 章节标题：藏起命令，按层级排版 */
    const heading = SECTION_RE.exec(raw);
    if (heading) {
      const level = SECTION_LEVELS.indexOf(heading[1] as (typeof SECTION_LEVELS)[number]);
      ranges.push(
        Decoration.line({ class: HEADING_CLASS[level] ?? 'cm-tex-h5' }).range(line.from),
      );
      if (!touchesSelection(state, line.from, line.to)) {
        const brace = raw.indexOf('{', heading.index);
        const close = raw.lastIndexOf('}');
        if (brace !== -1) {
          ranges.push(
            Decoration.replace({ widget: new EmptyWidget() }).range(
              line.from + heading.index,
              line.from + brace + 1,
            ),
          );
        }
        if (close > brace) {
          ranges.push(
            Decoration.replace({ widget: new EmptyWidget() }).range(
              line.from + close,
              line.from + close + 1,
            ),
          );
        }
      }
      decorateInline(line, ranges, state);
      continue;
    }

    decorateInline(line, ranges, state);
  }

  return Decoration.set(ranges, true);
}

/**
 * 装饰字段。
 *
 * 用 StateField 而不是 ViewPlugin：跨行公式与表格必须产出 `block: true`
 * 的装饰，而 CM6 禁止 ViewPlugin 提供块级装饰。
 */
function texDecorations(isActive: () => boolean): Extension {
  /*
   * 缓存上一次的"是否生效"。
   *
   * 切换源码模式不会改文档、也不动选区 —— 只看 docChanged/selection 的话
   * 装饰会一直留在屏幕上，源码模式看起来没生效。`#applyMode` 切模式时
   * 会 dispatch 一个 transaction，这里借它检测生效状态的变化。
   */
  let lastActive: boolean | null = null;

  return StateField.define<DecorationSet>({
    create(state) {
      lastActive = isActive();
      return buildDecorations(state, lastActive);
    },
    update(value, tr) {
      const active = isActive();
      if (!tr.docChanged && !tr.selection && active === lastActive) return value;
      lastActive = active;
      return buildDecorations(tr.state, active);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

/* ── 视图 ─────────────────────────────────────────────────── */

function createView(context: PluginContext): ViewProvider {
  return {
    render(container) {
      const body = document.createElement('div');
      body.className = 'view-body';
      container.append(body);

      const header = document.createElement('div');
      header.className = 'tex-structure__header';

      const list = document.createElement('div');
      list.className = 'tex-structure__list';

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
          note.textContent = t('view.notLatex');
          list.append(note);
          return;
        }

        const sections = extractSections(context.editor.getText());
        if (sections.length === 0) {
          const note = document.createElement('p');
          note.className = 'view-empty';
          note.textContent = t('view.noSections');
          list.append(note);
          return;
        }

        header.textContent = `${String(sections.length)} · ${t('view.structure')}`;

        for (const section of sections) {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'tree-item tex-section';
          row.style.paddingLeft = `${10 + Math.max(0, section.level - 1) * 12}px`;

          const number = document.createElement('span');
          number.className = 'tex-section__line';
          number.textContent = String(section.number);

          const title = document.createElement('span');
          title.className = 'tex-section__title';
          title.textContent = section.title || '(untitled)';

          row.append(number, title);
          row.addEventListener('click', () => context.editor.revealLine(section.number));
          list.append(row);
        }
      };

      const schedule = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          render();
        }, 200);
      };

      const docSubscription = context.editor.onDidChangeDocument(schedule);
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
  context.subscriptions.push(
    context.window.registerView(
      { id: VIEW_ID, title: '结构', location: 'sidebar', order: 3, languages: [LANGUAGE_ID] },
      createView(context),
    ),
  );

  context.subscriptions.push(
    context.editor.registerExtension(() =>
      /* 源码模式下必须让路（与 fountain 插件同一条规则）。 */
      texDecorations(
        () => context.editor.activeLanguage === LANGUAGE_ID && !context.editor.sourceMode,
      ),
    ),
  );
}

const manifest: PluginManifest = {
  id: 'aropyt.latex',
  name: 'LaTeX',
  version: '0.1.0',
  engines: { aropyt: '^0.1.0' },
  activationEvents: [`onView:${VIEW_ID}`, `onLanguage:${LANGUAGE_ID}`],
  contributes: {
    languages: [{ id: LANGUAGE_ID, aliases: ['tex'], extensions: ['tex', 'latex'] }],
    /* 标题写中文原文，翻译交给 commandTitle（见 fountain.ts 的说明）。 */
    views: [{ id: VIEW_ID, title: '结构', location: 'sidebar', order: 3, languages: [LANGUAGE_ID] }],
  },
};

export const latexPlugin: LoadablePlugin = { manifest, activate };
