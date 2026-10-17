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
}).use(taskListPlugin);

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
