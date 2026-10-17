import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlightCode(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      /* 语言包异常时退化为纯文本，不能让渲染整体失败 */
    }
  }
  return escapeHtml(code);
}

/**
 * 数学公式：$…$（行内）、$$…$$（块级）、\(…\)（行内）、\[…\]（块级）。
 *
 * 输出的是**占位元素**（data-tex 存原式）—— KaTeX 的渲染发生在
 * BlockWidget 的 DOM 水合阶段（异步动态 import，不进首屏）。
 *
 * 为什么必须抢在 escape 规则之前：`\(` 的反斜杠会被 markdown-it 的
 * escape 规则当成转义吃掉，行内规则看到的就只剩 `(` 了。
 * `$` 的闭合判定要求定界符内侧贴着内容（`$5 和 $10` 这种货币文本
 * 不满足，不会被误判成公式）。
 */
function mathPlugin(md: MarkdownIt): void {
  /*
   * ⚠️ 块级数学必须是 **block 规则**，不能只靠 inline 规则。
   *
   * 实测（希腊字母与偏导块）：`\[ ... \]` 里有一行以 `+ \frac{...}` 开头，
   * markdown-it 的列表规则先把它切成 `<p>` + `<ul><li>`，inline 规则
   * 在第一个块里找不到闭合 `\]` → 整块退化成普通文本（用户看到的就是
   * "未渲染"）。凡是以 `-` / `+` / `*` / `1.` 开头的 tex 行都会这样。
   *
   * block 规则插在 `fence` 之前，整块吞掉（不参与列表/段落解析）。
   */
  md.block.ruler.before('fence', 'aropyt_math_block', (state, startLine, _endLine, silent) => {
    const lineStart = state.bMarks[startLine] + state.tShift[startLine];
    const lineEnd = state.eMarks[startLine];
    const head = state.src.slice(lineStart, lineEnd).trimStart();
    const open = head.startsWith('$$') ? '$$' : head.startsWith('\\[') ? '\\[' : '';
    if (!open) return false;
    const close = open === '$$' ? '$$' : '\\]';
    const closePos = state.src.indexOf(close, lineStart + open.length);
    if (closePos < 0) return false;
    if (silent) return true;
    const token = state.push('math_block', '', 0);
    token.block = true;
    token.content = state.src.slice(lineStart + open.length, closePos).trim();
    token.markup = open;
    const end = state.src.slice(0, closePos).split('\n').length - 1;
    token.map = [startLine, end];
    state.line = end + 1;
    return true;
  });

  md.inline.ruler.before('escape', 'aropyt_math', (state, silent) => {
    const src = state.src;
    const start = state.pos;
    let marker = '';
    if (src.startsWith('$$', start)) marker = '$$';
    else if (src[start] === '$') marker = '$';
    else if (src.startsWith('\\(', start)) marker = '\\(';
    else if (src.startsWith('\\[', start)) marker = '\\[';
    if (!marker) return false;
    const close = marker === '\\(' ? '\\)' : marker === '\\[' ? '\\]' : marker;
    const end = src.indexOf(close, start + marker.length);
    if (end < 0) return false;
    const tex = src.slice(start + marker.length, end).trim();
    if (!tex) return false;
    // 行内 $ 的防误判：闭合 $ 前不能是空白（$5 和 $10 里的两个 $ 不配对）
    if (marker === '$' && /\s$/.test(src.slice(start + 1, end))) return false;
    if (silent) return true;
    const isBlock = marker === '$$' || marker === '\\[';
    const token = state.push(isBlock ? 'math_block' : 'math_inline', '', 0);
    token.content = tex;
    token.markup = marker;
    state.pos = end + close.length;
    return true;
  });

  const renderPlaceholder = (tex: string, display: boolean): string =>
    `<span class="${display ? 'aropyt-math-block' : 'aropyt-math-inline'}" data-tex="${escapeHtml(tex)}"></span>`;

  md.renderer.rules.math_inline = (tokens, idx) => renderPlaceholder(tokens[idx].content, false);
  md.renderer.rules.math_block = (tokens, idx) => renderPlaceholder(tokens[idx].content, true);
}

/**
 * GFM 任务列表。[ ] / [x] 不在 CommonMark 里，markdown-it 核心不认，
 * 自己补一个最小实现比再引一个依赖更可控。
 */
function taskListPlugin(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'aropyt-task-list', (state) => {
    const { tokens } = state;
    for (let i = 2; i < tokens.length; i += 1) {
      if (tokens[i].type !== 'inline') continue;
      if (tokens[i - 1].type !== 'paragraph_open') continue;
      if (tokens[i - 2].type !== 'list_item_open') continue;

      const match = /^\[([ xX])\][ \t]+/.exec(tokens[i].content);
      if (!match) continue;

      const checked = match[1].toLowerCase() === 'x';
      tokens[i].content = tokens[i].content.slice(match[0].length);

      const first = tokens[i].children?.[0];
      if (first && first.type === 'text') {
        first.content = first.content.replace(/^\[([ xX])\][ \t]+/, '');
      }

      tokens[i - 2].attrJoin('class', 'task-list-item');
      const checkbox = new state.Token('html_inline', '', 0);
      checkbox.content = `<input class="task-checkbox" type="checkbox" disabled${
        checked ? ' checked' : ''
      }> `;
      tokens[i].children = [checkbox, ...(tokens[i].children ?? [])];
    }
  });
}

export const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: false,
  highlight: highlightCode,
}).use(taskListPlugin)
  .use(mathPlugin);

/** 外链一律加 target=_blank + rel，避免在 PWA 里把应用本身导航走。 */
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href') ?? '';
  if (/^https?:\/\//.test(href)) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}

export interface OutlineItem {
  level: number;
  text: string;
  /**
   * **1 起算**，与 `editor.getLine` / `editor.revealLine` 一致。
   *
   * 这条注释与 `plugin-api` 里的同名接口必须说同一件事 ——
   * 曾经这里只写 `line: number`，实现就顺手写成了 0 起算的 `index`，
   * 而调用方按 1 起算去用，于是每次跳转都差一行。**契约要在类型上写明**，
   * 否则两个包各自"合理"地理解一遍就是一辈子修不完的差 1。
   */
  line: number;
}

/**
 * 从源码里抽取大纲。刻意不用渲染后的 DOM —— 编辑器里用户经常处于半截语法状态，
 * 解析源码更稳。
 */
export function extractOutline(source: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = source.split('\n');
  let inFence = false;

  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!match) return;
    items.push({
      level: match[1].length,
      text: match[2].replace(/[*_`~[\]]/g, '').trim(),
      /*
       * ⚠️ **1 起算**，必须 `index + 1`。
       *
       * `plugin-api` 里 `OutlineItem.line` 的契约写的就是"1 起算，
       * 与 editor.getLine / revealLine 一致"，而这里原来直接给的是
       * `index`（0 起算）—— 契约与实现差 1。
       *
       * 后果是大纲点击永远跳到目标标题的**上一行**：实测点「1.1 小节」
       * （第 5 行）光标落到第 4 行，点「1.2 另一个小节」（第 13 行）
       * 落到第 12 行。差一行不像"功能坏了"，用户只会觉得"点了没跳对地方"。
       */
      line: index + 1,
    });
  });

  return items;
}

export interface DocStats {
  words: number;
  chars: number;
  lines: number;
  readMinutes: number;
}

export function countStats(source: string): DocStats {
  const chars = source.replace(/\s/g, '').length;
  const cjk = (source.match(/[\u4e00-\u9fa5\u3040-\u30ff]/g) ?? []).length;
  const words = (source.match(/[A-Za-z0-9_'-]+/g) ?? []).length + cjk;
  return {
    words,
    chars,
    lines: source ? source.split('\n').length : 0,
    readMinutes: Math.max(1, Math.round(words / 300)),
  };
}
