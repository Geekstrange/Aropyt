import { EditorState } from '@codemirror/state';
import { type BlockRange } from './md.js';

/** Positions refer to the original Markdown, so editing, saving and undo all
 * use the same document even when the delimiters are hidden. */
export interface CodeFence {
  from: number;
  to: number;
  bodyFrom: number;
  bodyTo: number;
  firstLine: number;
  lastLine: number;
  opening: string;
  marker: string;
  info: string;
  lang: string;
  closed: boolean;
  empty: boolean;
  diagram: boolean;
  math: boolean;
}

export function codeFence(state: EditorState, block: BlockRange): CodeFence | null {
  if (block.kind !== 'fence') return null;
  const firstLine = block.startLine + 1;
  const opening = state.doc.line(firstLine);
  const match = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/.exec(opening.text);
  if (!match) return null;
  const marker = match[2];
  const info = match[3].trim();
  const lastLine = Math.min(block.endLine, state.doc.lines);
  const last = state.doc.line(lastLine);
  const closed = lastLine > firstLine && new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`).test(last.text);
  const empty = closed ? lastLine === firstLine + 1 : lastLine === firstLine;
  const lang = info.split(/\s+/)[0] || '';
  return {
    from: opening.from, to: last.to, firstLine, lastLine,
    bodyFrom: empty ? opening.to : opening.to + 1,
    bodyTo: empty ? opening.to : closed ? last.from - 1 : last.to,
    opening: opening.text, marker, info, lang, closed, empty,
    diagram: /^(mermaid\S*|flow|sequence|gantt)$/i.test(lang),
    math: lang === 'math',
  };
}
