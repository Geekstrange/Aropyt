import { uiText } from './stubs.js';
import { displayFileUrl } from './stubs.js';
import MarkdownIt from 'markdown-it';
/*
 * 这五个插件都没有类型声明。用行级 `@ts-expect-error` 而不是全局
 * `declare module`：core / capabilities / web 三个包各自 `tsc -p`，
 * 全局声明只有 include 范围内的 .d.ts 才可见，会有一个包漏报。
 */
// @ts-expect-error 无类型声明
import footnote from 'markdown-it-footnote';
// @ts-expect-error 无类型声明
import taskLists from 'markdown-it-task-lists';
// @ts-expect-error 无类型声明
import subPlugin from 'markdown-it-sub';
// @ts-expect-error 无类型声明
import supPlugin from 'markdown-it-sup';
// @ts-expect-error 无类型声明
import markPlugin from 'markdown-it-mark';
import hljs from 'highlight.js';
import { highlightedCode } from './code-highlighting.js';

export interface RenderOptions {
  /** Directory of the document, used to resolve relative image paths. */
  docDir?: string;
  /** Rewrites an image src (e.g. file:// for the renderer, absolute for export). */
  resolveSrc?: (src: string) => string;
  /** Render math to SVG markup. Falls back to a pending placeholder. */
  math?: (tex: string, display: boolean) => string;
  /** Class applied to the outer wrapper. */
  rootClass?: string;
  preserveLineBreaks?: boolean;
}

export interface Dialect {
  /** Auto-link bare URLs. */
  autoLinks: boolean;
  /** $...$ and $...$ */
  inlineMath: boolean;
  /** ```math fenced blocks */
  codeBlockMath: boolean;
  subscript: boolean;
  superscript: boolean;
  highlight: boolean;
  /** GitHub-style > [!NOTE] blocks */
  githubAlert: boolean;
  /** mermaid / flowchart fences */
  diagrams: boolean;
  /** Force line numbers on every fence. */
  fenceLineNumbers: boolean;
  /** Language used when a fence has none. */
  defaultCodeLang: string;
  smartQuotes: boolean;
  smartDash: boolean;
  singleLineBreaks: boolean;
  strictMode: boolean;
  remapPunctuation: boolean;
  visibleBr: boolean;
  smartDoubleQuoteStyle: string;
  smartSingleQuoteStyle: string;
}

export const DEFAULT_DIALECT: Dialect = {
  autoLinks: true,
  inlineMath: true,
  codeBlockMath: true,
  // Off by default: these three render as literal text.
  subscript: false,
  superscript: false,
  highlight: false,
  githubAlert: true,
  diagrams: true,
  fenceLineNumbers: false,
  defaultCodeLang: '',
  smartQuotes: false,
  smartDash: false,
  singleLineBreaks: true,
  strictMode: true,
  remapPunctuation: false,
  visibleBr: false,
  smartDoubleQuoteStyle: '“abc”',
  smartSingleQuoteStyle: '‘abc’',
};

/** Dialect actually used by the current engine instance. */
let D: Dialect = { ...DEFAULT_DIALECT };

const MD = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  // Aropyt renders a single newline inside a paragraph as a hard break.
  breaks: true,
});

MD.use(footnote).use(taskLists, { enabled: true });
MD.use(subPlugin).use(supPlugin).use(markPlugin);

// The native reference editor applies a Setext underline to the immediately
// preceding line. Split earlier paragraph lines without changing source maps.
MD.core.ruler.after('block', 'single_line_setext', (state) => {
  for (let i = 0; i < state.tokens.length; i++) {
    const open = state.tokens[i], body = state.tokens[i + 1];
    if (open.type !== 'heading_open' || !['=', '-'].includes(open.markup) || !open.map ||
        open.map[1] - open.map[0] <= 2 || body?.type !== 'inline') continue;
    const split = body.content.lastIndexOf('\n');
    if (split < 0) continue;
    const start = open.map[0], heading = open.map[1] - 2;
    const paragraph = new state.Token('paragraph_open', 'p', 1);
    paragraph.level = open.level; paragraph.map = [start, heading];
    const text = new state.Token('inline', '', 0);
    text.level = body.level; text.map = [start, heading]; text.content = body.content.slice(0, split); text.children = [];
    const close = new state.Token('paragraph_close', 'p', -1); close.level = open.level;
    open.map = [heading, open.map[1]]; body.map = [heading, heading + 1]; body.content = body.content.slice(split + 1);
    state.tokens.splice(i, 0, paragraph, text, close); i += 3;
  }
});

MD.renderer.rules.softbreak = (_tokens, _index, options, env) => {
  const breaks = env.preserveLineBreaks ?? options.breaks;
  return breaks ? (D.visibleBr ? '<span class="md-br-marker" aria-hidden="true">↵</span>' : '') + '<br>\n' : '\n';
};
MD.renderer.rules.hardbreak = () => (D.visibleBr ? '<span class="md-br-marker" aria-hidden="true">↵</span>' : '') + '<br>\n';

/** Typora's non-strict mode accepts headings without a following space. */
MD.block.ruler.before('heading', 'relaxed_heading', (state, startLine, _endLine, silent) => {
  if (D.strictMode) return false;
  const line = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
  const match = /^(#{1,6})([^#\s].*)$/.exec(line);
  if (!match) return false;
  if (silent) return true;
  const open = state.push('heading_open', 'h' + match[1].length, 1); open.map = [startLine, startLine + 1]; open.markup = match[1];
  const inline = state.push('inline', '', 0); inline.content = match[2].trim(); inline.map = [startLine, startLine + 1]; inline.children = [];
  state.push('heading_close', 'h' + match[1].length, -1); state.line = startLine + 1; return true;
}, { alt: ['paragraph', 'reference', 'blockquote'] });

/* Optional syntax is switched off by making the markers literal again. */
const literalOpen = (marker: string) => () => marker;
const literalClose = (marker: string) => () => marker;
MD.renderer.rules.mark_open = () => (D.highlight ? '<mark>' : '==');
MD.renderer.rules.mark_close = () => (D.highlight ? '</mark>' : '==');
MD.renderer.rules.sub_open = () => (D.subscript ? '<sub>' : '~');
MD.renderer.rules.sub_close = () => (D.subscript ? '</sub>' : '~');
MD.renderer.rules.sup_open = () => (D.superscript ? '<sup>' : '^');
MD.renderer.rules.sup_close = () => (D.superscript ? '</sup>' : '^');
void literalOpen;
void literalClose;



/* --------------------------------------------------------------- helpers */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface StandaloneImage {
  kind: 'markdown' | 'html'; src: string; alt: string; title: string; altLength: number;
  selectionFrom: number; selectionTo: number; attributes: Record<string, string>;
}
export type MarkdownReferences = Record<string, { href: string; title: string }>;
const referenceCache = new Map<string, MarkdownReferences>();
export function documentReferences(source: string): MarkdownReferences {
  const cached = referenceCache.get(source); if (cached) return cached;
  const env: { references?: MarkdownReferences } = {};
  MD.parse(prepareMarkdown(source), env);
  const references = env.references || {};
  if (referenceCache.size > 16) referenceCache.clear();
  referenceCache.set(source, references); return references;
}

export function standaloneImage(source: string, references?: MarkdownReferences): StandaloneImage | null {
  if (source.includes('\n')) return null;
  if (/^ {0,3}<img\b.*>\s*$/i.test(source)) {
    const template = document.createElement('template'); template.innerHTML = source.trim();
    const image = template.content.firstElementChild;
    if (template.content.childNodes.length !== 1 || image?.tagName !== 'IMG' || !image.hasAttribute('src')) return null;
    const attributes = Object.fromEntries(Array.from(image.attributes, (attribute) => [attribute.name, attribute.value]));
    return { kind: 'html', src: attributes.src, alt: attributes.alt || '', title: attributes.title || '', altLength: 0,
      selectionFrom: 0, selectionTo: source.length, attributes };
  }
  if (!source.startsWith('![')) return null;
  const children = MD.parseInline(source, { references })[0]?.children ?? [];
  if (children.length !== 1 || children[0].type !== 'image') return null;
  const token = children[0], alt = /^!\[((?:\\.|[^\]\\])*)\]/.exec(source);
  const src = token.attrGet('src') ?? '', title = token.attrGet('title') ?? '', altLength = alt?.[1].length ?? 0;
  return { kind: 'markdown', src, alt: token.content, title, altLength, selectionFrom: 2, selectionTo: 2 + altLength,
    attributes: { src, alt: token.content, ...(title ? { title } : {}) } };
}

export const SUPPORTED_LANGS = [
  'javascript', 'typescript', 'jsx', 'tsx', 'json', 'html', 'xml', 'css', 'scss', 'less',
  'python', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'ruby', 'php', 'swift', 'kotlin',
  'bash', 'shell', 'powershell', 'sql', 'yaml', 'toml', 'ini', 'markdown', 'dockerfile',
  'diff', 'lua', 'perl', 'r', 'scala', 'dart', 'objectivec', 'http', 'graphql', 'vim',
];

function highlightCode(code: string, lang: string): { html: string; lang: string } {
  const key = (lang || '').toLowerCase();
  if (key && hljs.getLanguage(key)) {
    try {
      return { html: highlightedCode(code, key) ?? escapeHtml(code), lang: key };
    } catch {
      /* fall through to plain */
    }
  }
  return { html: escapeHtml(code), lang: key };
}

let diagramSeq = 0;

/* --------------------------------------------------------------- renderer */

MD.renderer.rules.fence = (tokens, idx, _options, _env, _self) => {
  const token = tokens[idx];
  const info = (token.info || '').trim();
  const lang = info.split(/\s+/)[0] || '';
  const code = token.content;

  if (lang === 'math' && D.codeBlockMath) return `<div class="md-math-block" data-tex="${escapeHtml(code.trim())}">${escapeHtml(code)}</div>`;

  const isDiagram = /^mermaid/i.test(lang) || lang === 'flow' || lang === 'sequence' || lang === 'gantt';
  if (isDiagram && D.diagrams) {
    const id = 'md-diagram-' + ++diagramSeq;
    return `<div class="md-diagram md-fences" data-lang="${escapeHtml(lang)}" data-id="${id}">` +
      `<pre class="md-diagram-pending">${escapeHtml(code)}</pre></div>`;
  }

  const hasLineNo = D.fenceLineNumbers || /\b(line[-_]?numbers?|lineno)\b/i.test(info);
  const { html, lang: resolved } = highlightCode(code, lang || D.defaultCodeLang);
  const langClass = resolved ? ` class="language-${resolved}"` : '';
  const start = info.match(/(?:^|\s)start(?:=?)(\d+)/i);
  const startAt = start ? Number(start[1]) : 1;
  let body = html;
  if (hasLineNo) {
    const lines = html.split('\n');
    const pad = String(startAt + lines.length - 1).length;
    body = lines
      .map((l, i) => `<span class="md-lineno">${String(startAt + i).padStart(pad, ' ')}</span>${l}`)
      .join('\n');
  }
  const cls = ['md-fences', 'md-end-block', 'md-focus'].concat(hasLineNo ? ['md-fences-with-lineno'] : []).join(' ');
  return `<pre class="${cls}" data-lang="${escapeHtml(lang)}"><div class="md-fences-title"><span class="md-lang">${escapeHtml(lang)}</span></div>` +
    `<code${langClass ? langClass.replace('class="', 'class="hljs ') : ' class="hljs"'}>${body}</code></pre>\n`;
};

/* inline math: $...$ and $$...$$ handled at block level for display math */
MD.inline.ruler.before('escape', 'math_inline', (state, silent) => {
  if (!D.inlineMath) return false;
  const src = state.src;
  let pos = state.pos;
  if (src.charCodeAt(pos) !== 0x24 /* $ */) return false;
  pos++;
  const start = pos;
  let closed = -1;
  while (pos < state.posMax) {
    const ch = src.charCodeAt(pos);
    if (ch === 0x5c) {
      pos += 2;
      continue;
    }
    if (ch === 0x24) {
      closed = pos;
      break;
    }
    pos++;
  }
  if (closed < 0 || closed === start) return false;
  const content = src.slice(start, closed);
  if (!content.trim()) return false;
  // An opening $ followed by a digit and closed by another digit reads as currency.
  if (/^\d/.test(content) && /^\s/.test(src.slice(closed + 1, closed + 2))) return false;
  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.content = content;
    token.markup = '$';
  }
  state.pos = closed + 1;
  return true;
});

MD.renderer.rules.math_inline = (tokens, idx) => {
  const tex = tokens[idx].content;
  return `<span class="md-inline-math" data-tex="${escapeHtml(tex)}">${escapeHtml(tex)}</span>`;
};

/* block math $$...$$ */
const mathBlock = (state: any, startLine: number, endLine: number, silent: boolean) => {
  if (!D.inlineMath) return false;
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const line = state.src.slice(start, max);
  if (!/^\$\$/.test(line)) return false;
  if (silent) return true;
  let nextLine = startLine;
  let body = '';
  const firstRest = line.slice(2);
  if (/\$\$\s*$/.test(firstRest) && firstRest.trim()) {
    body = firstRest.replace(/\$\$\s*$/, '');
    nextLine = startLine + 1;
  } else {
    body = firstRest + '\n';
    nextLine = startLine + 1;
    let closed = false;
    for (; nextLine < endLine; nextLine++) {
      const ls = state.bMarks[nextLine] + state.tShift[nextLine];
      const le = state.eMarks[nextLine];
      const cur = state.src.slice(ls, le);
      if (/\$\$\s*$/.test(cur)) {
        body += cur.replace(/\$\$\s*$/, '');
        closed = true;
        nextLine++;
        break;
      }
      body += cur + '\n';
    }
    if (!closed) return false;
  }
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = body.replace(/\n$/, '');
  token.map = [startLine, nextLine];
  token.markup = '$$';
  state.line = nextLine;
  return true;
};
MD.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
MD.renderer.rules.math_block = (tokens, idx) => {
  const tex = tokens[idx].content;
  return `<div class="md-math-block" data-tex="${escapeHtml(tex)}"><pre class="md-math-pending">${escapeHtml(tex)}</pre></div>\n`;
};

/* ------------------------------------------------- front matter / [toc] */

function frontMatter(src: string): string | null {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  return m ? m[1] : null;
}

const tocPattern = /^\s*\[(?:toc|TOC)\]\s*$/;

/* ------------------------------------------------------------------ alerts */

const ALERTS = ['note', 'tip', 'important', 'warning', 'caution'];

MD.core.ruler.push('aropyt_alerts', (state) => {
  if (!D.githubAlert) return;
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'blockquote_open') continue;
    const inline = tokens[i + 1];
    if (!inline || inline.type !== 'paragraph_open') continue;
    const text = tokens[i + 2];
    if (!text || text.type !== 'inline') continue;
    const m = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\r?\n?/i.exec(text.content);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    if (!ALERTS.includes(kind)) continue;
    t.attrJoin('class', `md-alert md-alert-${kind}`);
    text.content = text.content.slice(m[0].length);
    // The renderer uses `children`, so the inline tokens must be rebuilt from
    // the stripped content rather than just trimming the source string.
    text.children = [];
    try {
      state.md.inline.parse(text.content, state.md, state.env, text.children);
    } catch {
      text.children = [{ type: 'text', content: text.content } as never];
    }
  }
});

/* ----------------------------------------------------------- heading ids */

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

const usedSlugs = new Map<string, number>();

MD.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
  const token = tokens[idx];
  const inline = tokens[idx + 1];
  const text = inline && inline.type === 'inline' ? inline.content : '';
  let id = slugify(text) || 'heading';
  const seen = usedSlugs.get(id) ?? 0;
  usedSlugs.set(id, seen + 1);
  if (seen) id = `${id}-${seen}`;
  token.attrSet('id', id);
  if (token.map) token.attrSet('data-line', String(token.map[0]));
  token.attrJoin('class', 'md-heading md-end-block');
  return self.renderToken(tokens, idx, options);
};

/* ------------------------------------------------------------------ images */

let imageResolver: ((src: string) => string) | null = null;

MD.renderer.rules.image = (tokens, idx, options, _env, self) => {
  const token = tokens[idx];
  const srcIdx = token.attrIndex('src');
  if (srcIdx >= 0) {
    const raw = token.attrs![srcIdx][1];
    const resolved = displayFileUrl(imageResolver ? imageResolver(raw) : raw);
    token.attrs![srcIdx][1] = resolved;
  }
  token.attrJoin('class', 'md-image');
  return self.renderToken(tokens, idx, options);
};

// Markdown's image rule does not see raw HTML <img> tags. Resolve those paths
// relative to the document too, retaining their dimensions and export styles.
for (const kind of ['html_inline', 'html_block']) {
  MD.renderer.rules[kind] = (tokens, index) => {
    const source = tokens[index].content;
    if (!imageResolver || !/<img\b/i.test(source)) return source;
    return source.replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
      const template = document.createElement('template'); template.innerHTML = tag;
      const image = template.content.firstElementChild, src = image?.getAttribute('src');
      if (!src) return tag;
      const resolved = escapeHtml(displayFileUrl(imageResolver!(src)));
      return tag.replace(/(\ssrc\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/i, (_match, prefix) => prefix + '"' + resolved + '"');
    });
  };
}


/** Swaps the dialect. The engine is shared; the optional syntax is gated at
 *  render time, so nothing has to be re-registered. */
export function setDialect(next: Partial<Dialect>): boolean {
  const merged: Dialect = { ...D, ...next };
  const changed = (Object.keys(merged) as (keyof Dialect)[]).some((k) => merged[k] !== D[k]);
  if (!changed) return false;
  D = merged;
  const double = D.smartDoubleQuoteStyle.split('abc'), single = D.smartSingleQuoteStyle.split('abc');
  MD.set({ typographer: D.smartQuotes || D.smartDash, breaks: D.singleLineBreaks, linkify: D.autoLinks,
    quotes: [double[0] || '“', double[1] || '”', single[0] || '‘', single[1] || '’'] });
  if (D.smartQuotes) MD.core.ruler.enable('smartquotes'); else MD.core.ruler.disable('smartquotes');
  if (D.smartDash) MD.core.ruler.enable('replacements'); else MD.core.ruler.disable('replacements');
  blockCache.clear(); referenceCache.clear();
  return true;
}

export function dialect(): Dialect {
  return { ...D };
}

function prepareMarkdown(source: string): string {
  let fence = '';
  const lists: { indent: number; content: number }[] = [];
  return source.split('\n').map((original) => {
    let line = original;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) { if (new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}[ \\t]*$').test(line)) fence = ''; return line; }
    if (marker) { fence = marker; return line; }
    /*
     * LaTeX 原生定界符归一化。
     *
     * `\( ... \)` 与 `\[ ... \]` 是 LaTeX 自己的写法，Typora 直接支持；
     * 而 markdown-it 的数学规则只认 `$`。不转换的话 `\(` 会被当成
     * 「反斜杠转义的左括号」原样输出 —— 公式源码露在正文里，识别、
     * 渲染都不报错，只是完全没生效。
     *
     * 放在这个位置是因为它已经在代码围栏之后：不会误改代码块里的内容。
     */
    if (D.inlineMath) {
      /* 单行成对：\[ ... \] → $$ ... $$ */
      line = line.replace(/^\s*\\\[([\s\S]+?)\\\]\s*$/, (_m, tex: string) => `$$${tex}$$`);
      /*
       * 独占一行的定界符（跨行写法）：\[ / \] → $$。
       *
       * ⚠️ 替换值必须写成函数。`String.replace` 的**字符串**替换里
       * `$$` 是转义序列，代表单个 `$` —— 直接写 `'$$'` 得到的是一个
       * 美元符，公式块就退化成行内定界符，整段源码原样露在正文里
       * 且不报错（实测：块级公式全部失效，行内正常）。
       */
      line = line
        .replace(/^\s*\\\[\s*$/, () => '$$')
        .replace(/^\s*\\\]\s*$/, () => '$$');
      /* 行内：\( ... \) → $ ... $ */
      line = line.replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex: string) => `$${tex}$`);
    }
    if (D.remapPunctuation) {
      line = line.replace(/<![—–]/g, '<!--').replace(/[—–]>/g, '-->')
        .replace(/^(\s*)[》＞]( ?)/, '$1>$2').replace(/^(\s*)[＃]+/, (m) => m.replace(/＃/g, '#'))
        .replace(/^(\s*)[—–]+\s*$/, '$1---')
        .replace(/(\]\([^\n]*?)\s[“«]([^”»]*)[”»](\s*\))/g, '$1 "$2"$3');
    }
    if (!D.strictMode) {
      const item = /^(\s*)(?:[-*+]|\d+[.)])\s+/.exec(line), indent = /^\s*/.exec(line)![0].length;
      if (item) {
        while (lists.length && indent <= lists[lists.length - 1].indent) lists.pop();
      }
      const parent = lists[lists.length - 1];
      const extra = parent && indent >= parent.indent + 2 && indent < parent.content ? parent.content - indent : 0;
      if (extra) line = ' '.repeat(extra) + line;
      if (item) lists.push({ indent: indent + extra, content: item[0].length + extra });
      else if (line.trim() && indent === 0) lists.length = 0;
    }
    return line;
  }).join('\n');
}

/* ------------------------------------------------------------ block ranges */

export interface BlockRange {
  startLine: number;
  endLine: number;
  kind: string;
}

/**
 * Block boundaries derived from markdown-it's token stream. `map` is
 * [startLine, endLine) in lines, which is exactly what the editor needs to
 * decide which source range a rendered block replaces.
 */
const blockCache = new Map<string, BlockRange[]>();

const FRONT_MATTER_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export function blockRanges(src: string): BlockRange[] {
  const cached = blockCache.get(src);
  if (cached) return cached;

  const out: BlockRange[] = [];
  let body = src;
  let lineOffset = 0;

  // YAML front matter is not CommonMark; treat the whole fence as one block so
  // the editor never lets markdown-it read `author: x` + `---` as a setext heading.
  const fm = FRONT_MATTER_RE.exec(src);
  if (fm) {
    const covered = fm[0].replace(/\r?\n$/, '').split(/\r?\n/).length;
    out.push({ startLine: 0, endLine: covered, kind: 'meta_block' });
    lineOffset = covered;
    body = src.slice(fm[0].length);
  }

  let tokens: ReturnType<MarkdownIt['parse']>;
  try {
    const env: { references?: MarkdownReferences } = {};
    tokens = MD.parse(prepareMarkdown(body), env);
    if (referenceCache.size > 16) referenceCache.clear();
    referenceCache.set(src, env.references || {});
  } catch {
    return out;
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.level !== 0 || !t.map) continue;
    const startLine = t.map[0] + lineOffset;
    const endLine = t.map[1] + lineOffset;
    if (endLine <= startLine) continue;
    out.push({ startLine, endLine, kind: t.type });
  }
  // markdown-it-footnote swallows `[^label]: …` definitions, so they never
  // produce a token (and therefore never a map). Without a block of their own
  // the editor would keep showing the raw source line. Give each definition its
  // own range, including indented continuation lines.
  const lines = src.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    if (!/^\[\^[^\]]+\]:/.test(lines[ln])) continue;
    if (out.some((b) => ln >= b.startLine && ln < b.endLine)) continue;
    let end = ln + 1;
    while (end < lines.length && /^[ \t]{2,}\S/.test(lines[end])) end++;
    out.push({ startLine: ln, endLine: end, kind: 'footnote_def' });
  }
  for (let ln = 0; ln < lines.length; ln++) {
    if (/^ {0,3}\[(?!\^)[^\]]+\]:[ \t]*\S/.test(lines[ln]) && !out.some((b) => ln >= b.startLine && ln < b.endLine)) {
      out.push({ startLine: ln, endLine: ln + 1, kind: 'reference_def' });
    }
  }
  out.sort((a, b) => a.startLine - b.startLine);

  if (blockCache.size > 64) blockCache.clear();
  blockCache.set(src, out);
  return out;
}

/* ------------------------------------------------------------- public API */

export interface Heading {
  level: number;
  text: string;
  line: number;
  id: string;
}

export function extractHeadings(src: string): Heading[] {
  const out: Heading[] = [];
  let tokens: ReturnType<MarkdownIt['parse']>;
  try {
    tokens = MD.parse(prepareMarkdown(src), {});
  } catch {
    return out;
  }
  usedSlugs.clear();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'heading_open') continue;
    const level = Number(t.tag.slice(1));
    const inline = tokens[i + 1];
    const text = inline ? inline.content.replace(/[*_`~$]/g, '') : '';
    let id = slugify(text) || 'heading';
    const seen = usedSlugs.get(id) ?? 0;
    usedSlugs.set(id, seen + 1);
    if (seen) id = `${id}-${seen}`;
    out.push({ level, text, line: t.map ? t.map[0] : 0, id });
  }
  usedSlugs.clear();
  return out;
}

export interface RenderResult {
  html: string;
  headings: Heading[];
  /** Offsets of every block, used by the live-preview editor. */
  blocks: BlockRange[];
}

function renderMarkdown(src: string, opts: RenderOptions, footnoteLabel?: string): RenderResult {
  imageResolver = opts.resolveSrc ?? null;
  usedSlugs.clear();

  let body = src;
  let metaHtml = '';
  const fm = frontMatter(src);
  if (fm !== null) {
    const consumed = src.indexOf(fm, 4) + fm.length;
    const after = src.slice(consumed);
    const closeIdx = after.indexOf('---');
    body = closeIdx >= 0 ? after.slice(closeIdx + 3).replace(/^\r?\n/, '') : '';
    metaHtml = `<pre class="md-meta-block">${escapeHtml(fm)}</pre>\n`;
  }

  let tocHtml = '';
  if (tocPattern.test(body.split(/\r?\n/)[0] ?? '')) {
    const lines = body.split(/\r?\n/);
    lines.shift();
    body = lines.join('\n');
    const hs = extractHeadings(body);
    tocHtml = renderToc(hs);
  }

  let html = '';
  try {
    const env = { preserveLineBreaks: opts.preserveLineBreaks };
    if (footnoteLabel === undefined) html = MD.render(prepareMarkdown(body), env);
    else {
      const tokens = MD.parse(prepareMarkdown(body), env);
      const from = tokens.findIndex(token => token.type === 'footnote_open' && token.meta?.label === footnoteLabel);
      const end = from < 0 ? -1 : tokens.findIndex((token, index) => index > from && token.type === 'footnote_close');
      if (end >= 0) html = MD.renderer.render(tokens.slice(from + 1, end).filter(token => token.type !== 'footnote_anchor'), MD.options, env);
    }
  } catch (err) {
    html = `<p>${escapeHtml(String(err))}</p>`;
  }

  if (footnoteLabel === undefined) html = metaHtml + tocHtml + html;

  // Aropyt renders alerts with a bold label row ("Note", "Tip", ...) above the
  // body, and footnote references as a bare number rather than "[1]".
  const ALERT_LABELS: Record<string, string> = {
    note: uiText('注意', 'Note'), tip: uiText('提示', 'Tip'), important: uiText('重要', 'Important'), warning: uiText('警告', 'Warning'), caution: uiText('小心', 'Caution'),
  };
  html = html.replace(
    /<blockquote class="([^"]*\bmd-alert\b[^"]*)">\s*<p>/g,
    (_m, cls: string) => {
      const kind = /md-alert-(note|tip|important|warning|caution)/.exec(cls)?.[1] ?? 'note';
      const label = ALERT_LABELS[kind] ?? uiText('注意', 'Note');
      return `<blockquote class="${cls}"><p class="md-alert-text md-alert-text-${kind}">` +
        `<span class="md-alert-text-container" data-text="${label}"></span></p><p>`;
    },
  );
  html = html.replace(/(<sup class="footnote-ref"><a[^>]*>)\[(\d+)\]<\/a><\/sup>/g, '$1$2</a></sup>');

  // Resolve math now that the tree exists.
  html = html.replace(
    /<div class="md-math-block" data-tex="([^"]*)"><pre class="md-math-pending">[^<]*<\/pre><\/div>/g,
    (_m, tex) => {
      const decoded = decodeAttr(tex);
      const rendered = opts.math ? opts.math(decoded, true) : `<pre>${escapeHtml(decoded)}</pre>`;
      return `<div class="md-math-block" data-tex="${tex}">${rendered}</div>`;
    },
  );
  html = html.replace(
    /<span class="md-inline-math" data-tex="([^"]*)">[^<]*<\/span>/g,
    (_m, tex) => {
      const decoded = decodeAttr(tex);
      const rendered = opts.math ? opts.math(decoded, false) : `<code>${escapeHtml(decoded)}</code>`;
      return `<span class="md-inline-math" data-tex="${tex}">${rendered}</span>`;
    },
  );

  const res: RenderResult = {
    html: `<div class="${opts.rootClass ?? 'aropyt-export-content'}"><div id="write" class="aropyt-export">${html}</div></div>`,
    headings: extractHeadings(body),
    blocks: blockRanges(src),
  };
  imageResolver = null;
  return res;
}

export function renderDocument(src: string, opts: RenderOptions = {}): RenderResult {
  return renderMarkdown(src, opts);
}

/** Parse the whole document so preview content shares reference definitions,
 * dialect and math/image rendering with export. Drop navigation-only backrefs. */
export function renderFootnote(src: string, label: string, opts: RenderOptions = {}): string {
  return renderMarkdown(src, opts, label).html;
}

function decodeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function renderToc(headings: Heading[]): string {
  if (!headings.length) return '';
  const items = headings
    .map((h) => `<div class="md-toc-item md-toc-h${h.level}"><a class="md-toc-inner" href="#${h.id}">${escapeHtml(h.text)}</a></div>`)
    .join('');
  return `<div class="md-toc" contenteditable="false"><p class="md-toc-content">${items}</p></div>\n`;
}

export function getMarkdown(): MarkdownIt {
  return MD;
}
