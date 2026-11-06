import { selectedLines } from './selected-lines.js';
import type { DocEditor } from './editor.js';
import { blockRanges, renderDocument } from './md.js';
import { codeFence } from './code-fences.js';
import { textRange, type TextRangeKind } from './editing-ranges.js';

export function blockAt(editor: DocEditor, kind?: string) {
  const state = editor.view.state, number = state.doc.lineAt(state.selection.main.head).number - 1;
  const block = blockRanges(editor.value).find((b) => number >= b.startLine && number < b.endLine && (!kind || b.kind === kind));
  if (!block) return null;
  const from = state.doc.line(block.startLine + 1).from;
  const last = state.doc.line(Math.min(block.endLine, state.doc.lines));
  return { ...block, from, to: last.to, text: state.sliceDoc(from, last.to) };
}

export function selectedMarkdown(editor: DocEditor): string {
  const { main } = editor.view.state.selection;
  return main.empty ? editor.view.state.doc.lineAt(main.head).text : editor.view.state.sliceDoc(main.from, main.to);
}

export function plainText(source: string): string {
  const root = document.createElement('div'); root.innerHTML = renderDocument(source).html;
  for (const br of root.querySelectorAll('br')) br.replaceWith('\n');
  for (const cell of root.querySelectorAll('td,th')) cell.append('\t');
  for (const el of root.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,pre,tr,blockquote')) el.append('\n');
  return (root.textContent ?? '').replace(/\t\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function replaceBlock(editor: DocEditor, text: string, kind?: string): boolean {
  const block = blockAt(editor, kind); if (!block) return false;
  editor.view.dispatch({ changes: { from: block.from, to: block.to, insert: text }, selection: { anchor: block.from }, userEvent: 'input' });
  return true;
}

export function selectLine(editor: DocEditor): void {
  rangeAction(editor, 'selectLine');
}

export function rangeAction(editor: DocEditor, action: string): boolean {
  const kind: Record<string, TextRangeKind | 'block'> = { selectLine: 'sentence', deleteLine: 'sentence', selectWord: 'word', deleteWord: 'word', selectStyled: 'style', deleteStyled: 'style', selectBlock: 'block', deleteBlock: 'block' };
  const scope = kind[action]; if (!scope) return false;
  const state = editor.view.state, head = state.selection.main.from, line = state.doc.lineAt(head), block = blockAt(editor), remove = action.startsWith('delete');
  const fence = block?.kind === 'fence' ? codeFence(state, block) : null;
  if (fence?.empty && remove && scope === 'sentence') return rangeAction(editor, 'deleteBlock');
  let from = block?.from ?? line.from, to = block?.to ?? line.to;
  if (fence && scope !== 'block') { from = Math.max(fence.bodyFrom, line.from); to = Math.min(fence.bodyTo, line.to); }
  else if (scope !== 'block' && block?.kind === 'heading_open') {
    const opening = state.doc.line(block.startLine + 1), prefix = /^ {0,3}#{1,6}[ \t]+/.exec(opening.text);
    from = opening.from + (prefix?.[0].length || 0); to = opening.to;
  } else if (/^(?:bullet|ordered)_list_open$/.test(block?.kind || '') && scope !== 'block') {
    from = line.from + (/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/.exec(line.text)?.[0].length || 0); to = line.to;
  }
  if (scope !== 'block' && !(fence && scope === 'sentence') && !editor.isSourceMode) {
    const range = textRange(state.sliceDoc(from, to), head - from, scope, remove); to = from + range[1]; from += range[0];
  } else if (editor.isSourceMode && scope !== 'block') {
    from = line.from; to = line.to;
    if (scope !== 'sentence') { const range = textRange(line.text, head - from, scope, remove); to = from + range[1]; from += range[0]; }
  }
  if (remove) {
    if (scope === 'block') {
      if (to < state.doc.length) { for (let n = 0; n < 2 && state.sliceDoc(to, to + 1) === '\n'; n++) to++; }
      else if (from >= 2 && state.sliceDoc(from - 2, from) === '\n\n') from -= 2;
    } else if (fence && scope === 'sentence') {
      if (to < fence.bodyTo) to++;
      else if (from > fence.bodyFrom) from--;
    } else if (from === to && !line.text && to < state.doc.length) to++;
    editor.view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from }, userEvent: 'delete' });
  } else editor.view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
  editor.focus(); return true;
}

export function setTaskStatus(editor: DocEditor, done: boolean): void {
  const state = editor.view.state, changes = [];
  const { first, last } = selectedLines(state);
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n), match = /^(\s*[-*+]\s+\[)[ xX](\])/.exec(line.text);
    if (match) changes.push({ from: line.from + match[1].length, to: line.from + match[1].length + 1, insert: done ? 'x' : ' ' });
  }
  if (changes.length) editor.view.dispatch({ changes, userEvent: 'input' });
}

export function codeContent(editor: DocEditor) {
  const block = blockAt(editor, 'fence');
  const fence = block && codeFence(editor.view.state, block);
  return fence ? { ...fence, text: editor.view.state.sliceDoc(fence.bodyFrom, fence.bodyTo) } : null;
}

/** Typora's prettify action reindents a code block. Preserve literal contents
 * while measuring braces outside strings/comments; JSON additionally formats. */
export function reindentCode(source: string, language: string, size: number): string {
  const width = Math.min(8, Math.max(1, size || 4));
  if (/^(json|jsonc|json5)$/.test(language)) {
    try { return JSON.stringify(JSON.parse(source), null, width); } catch { /* use indentation below */ }
  }
  if (/^(python|py|yaml|yml|makefile|make)$/.test(language)) return source.split('\n').map((s) => s.replace(/\s+$/, '')).join('\n');
  let depth = 0, comment = false;
  return source.split('\n').map((line) => {
    const text = line.trim(); if (!text) return '';
    const closing = /^[}\])]/.test(text) ? 1 : 0;
    const result = ' '.repeat(Math.max(0, depth - closing) * width) + text;
    let quote = '', escaped = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i], next = text[i + 1];
      if (comment) { if (c === '*' && next === '/') { comment = false; i++; } continue; }
      if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = ''; continue; }
      if (c === '/' && next === '/') break;
      if (c === '/' && next === '*') { comment = true; i++; continue; }
      if ('\'"`'.includes(c)) { quote = c; continue; }
      if ('{[('.includes(c)) depth++;
      if ('}])'.includes(c)) depth = Math.max(0, depth - 1);
    }
    return result;
  }).join('\n');
}

export function linkAt(editor: DocEditor): { href: string; image: boolean; alt: string } | null {
  const line = editor.view.state.doc.lineAt(editor.view.state.selection.main.head);
  const pos = editor.view.state.selection.main.head - line.from;
  const matches = [...line.text.matchAll(/(!?)\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g)];
  const match = matches.find((m) => pos >= m.index! && pos <= m.index! + m[0].length) ?? matches[0];
  return match ? { href: match[3] || match[4], image: match[1] === '!', alt: match[2] } : null;
}

export function clearMarkdown(source: string): string {
  return source.replace(/^ {0,3}#{1,6}\s+/gm, '').replace(/^\s*>\s?/gm, '')
    .replace(/!?(\[([^\]]+)\])\([^)]*\)/g, '$2')
    .replace(/(\*\*|__|~~|==)([^\n]+?)\1/g, '$2').replace(/(`+)([^`]+)\1/g, '$2')
    .replace(/(?<!\w)([*_])([^\n]+?)\1(?!\w)/g, '$2').replace(/<\/?(?:u|mark|s|strong|em|sup|sub)>/g, '');
}
