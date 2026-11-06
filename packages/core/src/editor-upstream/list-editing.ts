import type { EditorView } from '@codemirror/view';
import type { Line } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import type { BlockRange } from './md.js';
import { structureRows } from './native-structure.js';

const columns = (text: string) => Array.from(text).reduce((n, ch) => ch === '\t' ? n + 4 - n % 4 : n + 1, 0);

/** A marker-start Backspace turns an item into a paragraph of its preceding
 * sibling or parent. Removing the first item instead promotes its children. */
export function backspaceListItem(view: EditorView, block: BlockRange): boolean {
  const { state } = view, selection = state.selection.main;
  if (!selection.empty || !/^(bullet|ordered)_list_open$/.test(block.kind)) return false;
  const firstLine = state.doc.line(block.startLine + 1), lastLine = state.doc.line(block.endLine);
  const source = state.sliceDoc(firstLine.from, lastLine.to);
  if (!structureRows(block.kind, source.split('\n').filter(line => line.trim()).join('\n'))) return false;
  const markers: { line: Line; indent: string; width: number; contentIndent: string; bodyFrom: number }[] = [];
  for (let n = firstLine.number; n <= lastLine.number; n++) {
    const line = state.doc.line(n), match = /^([ \t]*)([-+*]|\d+[.)])([ \t]+)(?:\[[ xX]\][ \t]+)?/.exec(line.text);
    if (match) markers.push({ line, indent: match[1], width: columns(match[1]),
      contentIndent: match[1] + ' '.repeat(match[2].length) + match[3], bodyFrom: line.from + match[0].length });
  }
  const at = markers.findIndex(marker => marker.bodyFrom === selection.head);
  if (at < 0) return false;
  const current = markers[at];
  // Empty-item Backspace retains the existing marker-removal behavior.
  if (!state.sliceDoc(current.bodyFrom, current.line.to).trim()) return false;
  let sibling: typeof current | undefined, parent: typeof current | undefined;
  for (let n = at - 1; n >= 0; n--) {
    const marker = markers[n];
    if (marker.width === current.width) { sibling = marker; break; }
    if (marker.width < current.width) { parent = marker; break; }
  }
  const owner = sibling || parent;
  let end = at + 1;
  while (end < markers.length && markers[end].width > current.width) end++;
  const next = markers[end], changes: { from: number; to?: number; insert: string }[] = [];
  let insert = '';
  if (owner) {
    const separated = current.line.number > firstLine.number && !state.doc.line(current.line.number - 1).text.trim();
    insert = (separated ? '' : current.indent + '\n') + owner.contentIndent;
  }
  changes.push({ from: current.line.from, to: current.bodyFrom, insert });
  if (!owner) {
    const remove = columns(current.contentIndent);
    for (let n = current.line.number + 1; n < (next?.line.number ?? lastLine.number + 1); n++) {
      const line = state.doc.line(n), prefix = /^[ \t]*/.exec(line.text)![0];
      let count = 0;
      while (count < prefix.length && columns(prefix.slice(0, count)) < remove) count++;
      const excess = Math.max(0, columns(prefix.slice(0, count)) - remove);
      if (count) changes.push({ from: line.from, to: line.from + count, insert: ' '.repeat(excess) });
    }
  }
  // A sibling becomes a loose item with another paragraph. A first item's
  // promoted children must remain separate from its former following sibling.
  if (next && (!owner || sibling) && state.doc.line(next.line.number - 1).text.trim()) {
    changes.push({ from: next.line.from, insert: current.indent + '\n' });
  }
  view.dispatch({ changes, selection: { anchor: current.line.from + insert.length },
    annotations: isolateHistory.of('full'), userEvent: 'delete.backward', scrollIntoView: true });
  return true;
}

/** Indent an item and its descendants, rather than inserting spaces in its text. */
export function indentListItem(view: EditorView, block: BlockRange, reverse: boolean, tabs: boolean): boolean {
  const { state } = view, selection = state.selection.main;
  const firstLine = state.doc.line(block.startLine + 1), lastLine = state.doc.line(block.endLine);
  const source = state.sliceDoc(firstLine.from, lastLine.to);
  // Keep complex nested blocks on their existing source-editing path.
  if (!structureRows(block.kind, source.split('\n').filter(line => line.trim()).join('\n'))) return false;
  const markers: { line: Line; indent: string; width: number; body: number }[] = [];
  for (let n = firstLine.number; n <= lastLine.number; n++) {
    const line = state.doc.line(n), match = /^([ \t]*)([-+*]|\d+[.)])([ \t]+)/.exec(line.text);
    if (match) markers.push({ line, indent: match[1], width: columns(match[1]), body: columns(match[0]) });
  }
  const selectedEnd = !selection.empty && selection.to === state.doc.lineAt(selection.to).from ? selection.to - 1 : selection.to;
  if (selection.from < firstLine.from || selectedEnd > lastLine.to) return false;
  const owner = (line: number) => {
    for (let i = markers.length - 1; i >= 0; i--) if (markers[i].line.number <= line) return i;
    return -1;
  };
  const first = owner(state.doc.lineAt(selection.from).number), last = owner(state.doc.lineAt(selectedEnd).number);
  if (first < 0 || last < first) return false;
  const item = markers[first];
  if (markers.slice(first, last + 1).some(marker => marker.width < item.width)) return false;

  let unit = '', remove = 0;
  if (reverse) {
    if (!item.width) return true;
    let parentWidth = 0;
    for (let i = first - 1; i >= 0; i--) if (markers[i].width < item.width) { parentWidth = markers[i].width; break; }
    remove = item.width - parentWidth;
  } else {
    let previous = first - 1;
    while (previous >= 0 && markers[previous].width > item.width) previous--;
    if (previous < 0 || markers[previous].width !== item.width) {
      if (!selection.empty) return false;
      view.dispatch({ changes: { from: selection.head, insert: '\t' }, selection: { anchor: selection.head + 1 },
        annotations: isolateHistory.of('full'), userEvent: 'input' });
      return true;
    }
    const sibling = markers[previous], child = markers.slice(previous + 1, first).find(marker => marker.width > sibling.width);
    unit = child?.indent.slice(sibling.indent.length) || (tabs ? '\t' : ' '.repeat(sibling.body - sibling.width));
  }
  let end = last + 1;
  while (end < markers.length && markers[end].width > item.width) end++;
  let lastNumber = end < markers.length ? markers[end].line.number - 1 : lastLine.number;
  while (lastNumber > item.line.number && !state.doc.line(lastNumber).text.trim()) lastNumber--;
  const changes = [];
  for (let n = item.line.number; n <= lastNumber; n++) {
    const line = state.doc.line(n);
    if (!reverse) changes.push({ from: line.from, insert: unit });
    else {
      const prefix = /^[ \t]*/.exec(line.text)![0];
      let count = 0;
      while (count < prefix.length && columns(prefix.slice(0, count)) < remove) count++;
      const excess = Math.max(0, columns(prefix.slice(0, count)) - remove);
      if (count) changes.push({ from: line.from, to: line.from + count, insert: ' '.repeat(excess) });
    }
  }
  if (changes.length) view.dispatch({ changes, annotations: isolateHistory.of('full'), userEvent: 'input.indent', scrollIntoView: true });
  return true;
}
