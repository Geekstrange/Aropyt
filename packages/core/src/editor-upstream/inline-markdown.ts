import { parser, Strikethrough, Subscript, Superscript, Autolink } from '@lezer/markdown';
import { dialect } from './md.js';

export interface InlineSpan { from: number; to: number; bodyFrom: number; bodyTo: number; className: string; href?: string }
export interface InlineMathSpan { from: number; to: number; tex: string }
export function inlineMathSpans(source: string): InlineMathSpan[] {
  if (!dialect().inlineMath) return [];
  const code = inlineSpans(source).filter((span) => span.className === 'cm-md-code');
  const spans: InlineMathSpan[] = [];
  for (const match of source.matchAll(/(?<![\\$])\$((?:\\.|[^$\\\n])+)\$(?!\$)/g)) {
    const from = match.index!, to = from + match[0].length, tex = match[1];
    if (!tex.trim() || /^\d/.test(tex) && /^\s/.test(source.slice(to, to + 1)) ||
        code.some((span) => from >= span.from && from < span.to)) continue;
    spans.push({ from, to, tex });
  }

  /*
   * `\( ... \)` —— LaTeX 原生行内定界符。
   *
   * Typora 直接支持这一对，用户从别处贴过来时写的就是它。只认 `$` 的话
   * 这些公式会原样显示成源码，而且不报错 —— 看起来像"公式渲染坏了"。
   *
   * 内容里允许任意 `\命令`（公式里到处都是）：`\\.` 优先吃掉反斜杠及其
   * 后一个字符，`[^\\]` 兜住普通字符，遇到第一个 `\)` 收尾。
   */
  for (const match of source.matchAll(/\\\(((?:\\.|[^\\])+?)\\\)/g)) {
    const from = match.index!, to = from + match[0].length, tex = match[1];
    if (!tex.trim()) continue;
    if (code.some((span) => from >= span.from && from < span.to)) continue;
    /* 已经被 `$...$` 收走的重叠区间跳过 */
    if (spans.some((span) => from < span.to && to > span.from)) continue;
    spans.push({ from, to, tex });
  }

  /* 两种定界符混排时顺序会乱，调用方按位置递增遍历，这里排一次 */
  spans.sort((a, b) => a.from - b.from);
  return spans;
}
const cache = new Map<string, InlineSpan[]>();
export function inlineSpans(source: string): InlineSpan[] {
  const settings = dialect(), key = `${+settings.subscript}${+settings.superscript}${+settings.autoLinks}${+settings.highlight}:` + source;
  const cached = cache.get(key); if (cached) return cached;
  const configured = parser.configure([Strikethrough, ...(settings.subscript ? [Subscript] : []), ...(settings.superscript ? [Superscript] : []), ...(settings.autoLinks ? [Autolink] : [])]);
  const result: InlineSpan[] = [];
  configured.parse(source).iterate({ enter(ref) {
    const node = ref.node, type = node.name;
    if (type === 'Image') return false;
    const style: Record<string, string> = { StrongEmphasis: 'cm-md-strong', Emphasis: 'cm-md-emphasis', Strikethrough: 'cm-md-strike', InlineCode: 'cm-md-code', Subscript: 'cm-md-sub', Superscript: 'cm-md-sup' };
    if (style[type]) {
      const first = node.firstChild, last = node.lastChild;
      if (first && last) result.push({ from: node.from, to: node.to, bodyFrom: first.to, bodyTo: last.from, className: style[type] });
      if (type === 'InlineCode') return false;
    } else if (type === 'Link' || type === 'Autolink') {
      const marks = []; let url = '';
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === 'LinkMark') marks.push(child);
        if (child.name === 'URL') url = source.slice(child.from, child.to);
      }
      if (marks.length >= 2) result.push({ from: node.from, to: node.to, bodyFrom: marks[0].to, bodyTo: marks[1].from, className: 'cm-md-link', href: url });
    } else if (type === 'URL' && node.parent?.name !== 'Link' && node.parent?.name !== 'Autolink') {
      result.push({ from: node.from, to: node.to, bodyFrom: node.from, bodyTo: node.to, className: 'cm-md-link', href: source.slice(node.from, node.to) });
    } else if (type === 'Escape') {
      result.push({ from: node.from, to: node.to, bodyFrom: node.from + 1, bodyTo: node.to, className: '' });
    }
  } });
  for (const match of source.matchAll(/<(u|mark|s|strong|em|sup|sub)>([\s\S]*?)<\/\1>/g)) {
    const cls: Record<string, string> = { u: 'underline', mark: 'highlight', s: 'strike', strong: 'strong', em: 'emphasis', sup: 'sup', sub: 'sub' };
    result.push({ from: match.index!, to: match.index! + match[0].length, bodyFrom: match.index! + match[1].length + 2,
      bodyTo: match.index! + match[0].length - match[1].length - 3, className: 'cm-md-' + cls[match[1]] });
  }
  if (settings.highlight) for (const match of source.matchAll(/(?<!\\)==([^=\n]+)==/g)) {
    if (!result.some((span) => span.className === 'cm-md-code' && match.index! >= span.from && match.index! < span.to)) result.push({ from: match.index!, to: match.index! + match[0].length,
      bodyFrom: match.index! + 2, bodyTo: match.index! + match[0].length - 2, className: 'cm-md-highlight' });
  }
  if (cache.size > 64) cache.clear(); cache.set(key, result); return result;
}

/** Leave constructs with their own rich widget (images, math, TOC, HTML, etc.)
 * on that path. Text-only paragraphs can retain one native caret throughout. */
export function nativeParagraph(source: string, richInline = false): boolean {
  const settings = dialect();
  if ((!richInline && /!\[|\[\^|<img\b/i.test(source)) || /^\s*\[toc\]\s*$|&(?:#\w+|\w+);/i.test(source)) return false;
  const text = richInline ? source.replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, '') : source;
  if (/<(?!\/?(?:u|mark|s|strong|em|sup|sub)>)[a-z!/]/i.test(text)) return false;
  if (!settings.singleLineBreaks && source.trim().includes('\n')) return false;
  if (settings.smartQuotes && /["']/.test(text) || settings.smartDash && /--|\.\.\./.test(text)) return false;
  return true;
}
