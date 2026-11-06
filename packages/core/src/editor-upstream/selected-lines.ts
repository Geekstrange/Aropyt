import type { EditorState } from '@codemirror/state';

/** A selection ending at a line's start has not selected that line's text. */
export function selectedLines(state: EditorState): { first: number; last: number } {
  const selection = state.selection.main;
  const end = state.doc.lineAt(selection.to);
  return {
    first: state.doc.lineAt(selection.from).number,
    last: !selection.empty && selection.to === end.from ? end.number - 1 : end.number,
  };
}
