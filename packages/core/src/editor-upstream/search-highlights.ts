import { EditorState, StateEffect, StateField } from '@codemirror/state';

export interface SearchHit { from: number; to: number }
export interface SearchHighlight extends SearchHit { current: boolean }
export interface SearchHighlights { hits: SearchHit[]; current: number; selecting?: boolean }
export const setSearchHighlights = StateEffect.define<SearchHighlights>();
export const searchHighlightField = StateField.define<SearchHighlights>({
  create: () => ({ hits: [], current: -1 }),
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setSearchHighlights)) return effect.value;
    if (transaction.selection) value = { ...value, selecting: false };
    if (!transaction.docChanged) return value;
    return { ...value, hits: value.hits.map(hit => ({ from: transaction.changes.mapPos(hit.from, 1), to: transaction.changes.mapPos(hit.to, -1) }))
      .filter(hit => hit.to >= hit.from) };
  },
});
export function searchHighlights(state: EditorState, from = 0, to = state.doc.length): SearchHighlight[] {
  const value = state.field(searchHighlightField, false);
  return value ? value.hits.flatMap((hit, index) => hit.from < hit.to && hit.from < to && hit.to > from ?
    [{ from: Math.max(from, hit.from) - from, to: Math.min(to, hit.to) - from, current: index === value.current }] : []) : [];
}
export function searchIntersects(hits: readonly SearchHit[], from: number, to: number): boolean {
  return hits.some(hit => hit.from < to && hit.to > from);
}
export function searchClass(current: boolean): string { return 'cm-search-hit' + (current ? ' is-current' : ''); }

/** Fallback cells still retain Markdown text, including unsupported HTML. */
export function searchText(source: string, hits: SearchHighlight[]): DocumentFragment {
  const fragment = document.createDocumentFragment(); let end = 0;
  for (const hit of hits) {
    fragment.append(document.createTextNode(source.slice(end, hit.from)));
    const mark = document.createElement('span'); mark.className = searchClass(hit.current); mark.textContent = source.slice(hit.from, hit.to);
    fragment.append(mark); end = hit.to;
  }
  fragment.append(document.createTextNode(source.slice(end))); return fragment;
}
