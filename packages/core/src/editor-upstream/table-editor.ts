import { uiText } from './stubs.js';
import { EditorView, WidgetType } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { dialect, renderDocument, documentReferences, type MarkdownReferences } from './md.js';
import { projectTableInline } from './table-inline.js';
import { inlineMathSpans, inlineSpans } from './inline-markdown.js';
import { inlineImages, inlineFootnotes } from './inline-media.js';
import { tableText, tableTextNodes } from './table-dom.js';
import { textRange } from './editing-ranges.js';
import { type SearchHighlight, searchHighlights, searchText } from './search-highlights.js';
import type { ImageSourceRange } from './image-actions.js';
import { displayFileUrl } from './stubs.js';

export interface MarkdownTable { rows: string[][]; align: ('left' | 'center' | 'right' | '')[]; newline: boolean }
function cellRanges(line: string): { from: number; to: number }[] {
  const left = line.length - line.trimStart().length, right = line.trimEnd().length;
  const parts: { from: number; to: number }[] = []; let start = left, escaped = false;
  for (let i = left; i < right; i++) {
    const char = line[i];
    if (char === '|' && !escaped) { parts.push({ from: start, to: i }); start = i + 1; }
    escaped = char === '\\' && !escaped;
  }
  parts.push({ from: start, to: right });
  if (line[left] === '|') parts.shift();
  if (start === right && line[right - 1] === '|') parts.pop();
  return parts.map(part => {
    const text = line.slice(part.from, part.to), from = part.from + text.length - text.trimStart().length;
    return { from, to: Math.max(from, part.to - text.length + text.trimEnd().length) };
  });
}
function cells(line: string): string[] { return cellRanges(line).map(part => line.slice(part.from, part.to)); }
function sourceCells(source: string): { from: number; to: number }[][] {
  const rows: { from: number; to: number }[][] = []; let offset = 0;
  source.split('\n').forEach((line, index) => {
    if (index !== 1 && (index === 0 || line.trim())) rows.push(cellRanges(line).map(part => ({ from: offset + part.from, to: offset + part.to })));
    offset += line.length + 1;
  }); return rows;
}
function setCellRange(cell: HTMLElement, ranges: ReturnType<typeof sourceCells>, base: number, row: number, col: number): void {
  cell.dataset.sourceFrom = String(base + (ranges[row]?.[col]?.from ?? 0)); cell.dataset.sourceTo = String(base + (ranges[row]?.[col]?.to ?? 0));
}
export function parseTable(source: string): MarkdownTable | null {
  const lines = source.trimEnd().split('\n'); if (lines.length < 2) return null;
  const header = cells(lines[0]), separator = cells(lines[1]);
  if (!header.length || header.length !== separator.length || separator.some((cell) => !/^:?-+:?$/.test(cell))) return null;
  return { rows: [header, ...lines.slice(2).filter((line) => line.trim()).map(cells)].map((row) => header.map((_, c) => row[c] || '')),
    align: separator.map((cell) => cell.startsWith(':') ? cell.endsWith(':') ? 'center' : 'left' : cell.endsWith(':') ? 'right' : ''), newline: source.endsWith('\n') };
}
export function tableFromHeader(source: string): MarkdownTable | null {
  if (!/^ {0,3}\|.+(?<!\\)\|[ \t]*$/.test(source)) return null;
  const header = cells(source);
  return header.length ? { rows: [header, header.map(() => '')], align: header.map(() => ''), newline: false } : null;
}
export function serializeTable(table: MarkdownTable): string {
  const row = (values: string[]) => '| ' + values.join(' | ') + ' |';
  return [row(table.rows[0]), row(table.align.map((a) => a === 'left' ? ':---' : a === 'right' ? '---:' : a === 'center' ? ':---:' : '---')),
    ...table.rows.slice(1).map(row)].join('\n') + (table.newline ? '\n' : '');
}
function editable(source: string): string { return source.replace(/\\\|/g, '|').replace(/<br\s*\/?\s*>/gi, '\n'); }
function sourceOffset(source: string, offset: number): number {
  let from = 0, position = 0;
  while (from < source.length && position < offset) {
    const br = /^<br\s*\/?\s*>/i.exec(source.slice(from));
    from += br ? br[0].length : source[from] === '\\' && source[from + 1] === '|' ? 2 : 1;
    position++;
  }
  return from;
}
function escaped(source: string): string { return source.replace(/\r\n?/g, '\n').replace(/\|/g, '\\|').replace(/\n/g, '<br>'); }
function cellHighlights(cell: HTMLElement, source: string, view: EditorView): SearchHighlight[] {
  const length = editable(source).length;
  return searchHighlights(view.state, Number(cell.dataset.sourceFrom), Number(cell.dataset.sourceTo)).map(hit => ({ ...hit,
    from: Math.min(length, editable(source.slice(0, hit.from)).length), to: Math.min(length, editable(source.slice(0, hit.to)).length) }));
}
const fallbackSearch = new WeakMap<HTMLElement, string>();
function html(source: string, view: EditorView): string {
  const host = (view as any).__host;
  const root = document.createElement('div'); root.innerHTML = renderDocument(source || ' ', { math: host?.math, resolveSrc: host?.resolveSrc }).html;
  const content = root.querySelector('#write');
  return content?.firstElementChild?.tagName === 'P' ? content.firstElementChild.innerHTML : content?.innerHTML || '';
}
function annotateImages(cell: HTMLElement, source: string, view: EditorView): void {
  const formulas = inlineMathSpans(source), host = (view as any).__host;
  const images = inlineImages(source, documentReferences(view.state.doc.toString())).filter(image => !formulas.some(math => image.from >= math.from && image.to <= math.to));
  for (const img of cell.querySelectorAll<HTMLImageElement>('img:not([data-table-image-from])')) {
    const index = images.findIndex(image => {
      const resolved = host?.resolveSrc(image.image.src) || image.image.src;
      return [image.image.src, resolved, displayFileUrl(resolved)].includes(img.getAttribute('src') || '');
    });
    if (index < 0) continue;
    const [image] = images.splice(index, 1); img.dataset.tableImageFrom = String(image.from); img.dataset.tableImageTo = String(image.to);
  }
}
function offsets(cell: HTMLElement): [number, number] {
  const selection = window.getSelection(); if (!selection?.rangeCount || !cell.contains(selection.anchorNode) || !cell.contains(selection.focusNode)) return [0, 0];
  const range = selection.getRangeAt(0), before = range.cloneRange(); before.selectNodeContents(cell); before.setEnd(range.startContainer, range.startOffset);
  const from = tableText(before.cloneContents()).length;
  return [from, from + tableText(range.cloneContents()).length];
}
function replacesSource(cell: HTMLElement, event: InputEvent, view: EditorView): boolean {
  const source = tableText(cell);
  const protectedRanges = [...inlineImages(source, documentReferences(view.state.doc.toString())), ...inlineMathSpans(source),
    ...inlineSpans(source).filter(span => ['cm-md-code', 'cm-md-link'].includes(span.className)),
    ...Array.from(source.matchAll(/<[a-z!/][^>]*(?:>|$)/gi), match => ({ from: match.index!, to: match.index! + match[0].length }))];
  const point = (node: Node, offset: number) => {
    const before = document.createRange(); before.selectNodeContents(cell); before.setEnd(node, offset); return tableText(before.cloneContents()).length;
  };
  const targets = Array.from(event.getTargetRanges?.() || []).filter(range => cell.contains(range.startContainer) && cell.contains(range.endContainer))
    .map(range => [point(range.startContainer, range.startOffset), point(range.endContainer, range.endOffset)]);
  if (!targets.length) targets.push(offsets(cell));
  return targets.some(([from, to]) => protectedRanges.some(range => from === to ? from > range.from && from < range.to : from < range.to && to > range.from));
}
function select(cell: HTMLElement, from = 0, to = tableText(cell).length): void {
  cell.focus(); const length = tableText(cell).length;
  if (!cell.firstChild) cell.append(document.createTextNode(''));
  const nodes = tableTextNodes(cell);
  const point = (position: number): [Node, number] => {
    let rest = Math.min(length, Math.max(0, position));
    for (const node of nodes) { if (rest <= node.length) return [node, rest]; rest -= node.length; }
    return [cell, 0];
  };
  const range = document.createRange(); range.setStart(...point(from)); range.setEnd(...point(to));
  window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
}
function mathTooltip(cell: HTMLElement, source: string, selection: [number, number] | null, view: EditorView): void {
  const root = cell.closest<HTMLElement>('.md-table-widget'); if (!root) return;
  const formula = selection && inlineMathSpans(source).find((span) => selection[0] === selection[1] ? selection[0] > span.from && selection[0] < span.to : selection[0] < span.to && selection[1] > span.from);
  let tooltip = root.querySelector<HTMLElement>('.md-table-math-tooltip');
  if (!formula) { tooltip?.remove(); return; }
  if (!tooltip) { tooltip = document.createElement('div'); tooltip.className = 'cm-tooltip cm-inline-math-tooltip md-table-math-tooltip'; tooltip.contentEditable = 'false'; tooltip.setAttribute('role', 'tooltip'); root.append(tooltip); }
  if (tooltip.dataset.tex !== formula.tex) { tooltip.dataset.tex = formula.tex; tooltip.innerHTML = (view as any).__host?.math(formula.tex, false) || formula.tex; }
  const nodes = tableTextNodes(cell), range = document.createRange(); let offset = formula.from;
  for (const node of nodes) {
    if (offset < node.length) { range.setStart(node, offset); range.setEnd(node, Math.min(node.length, offset + 1)); break; }
    offset -= node.length;
  }
  const rect = range.getBoundingClientRect(), box = tooltip.getBoundingClientRect();
  tooltip.style.left = Math.max(4, Math.min(window.innerWidth - box.width - 4, rect.left)) + 'px';
  tooltip.style.top = (rect.bottom + box.height + 8 <= window.innerHeight ? rect.bottom + 8 : rect.top - box.height - 8) + 'px';
}
function renderCell(cell: HTMLElement, source: string, view: EditorView, active: boolean): void {
  const text = editable(source), selection = active ? offsets(cell) : null;
  const hits = cellHighlights(cell, source, view);
  const host = (view as any).__host;
  const projected = projectTableInline(cell, text, selection, (tex) => host?.math(tex, false) || tex, {
    references: documentReferences(view.state.doc.toString()), resolveSrc: src => host?.resolveSrc(src) || src, measure: () => view.requestMeasure(),
  }, hits);
  if (projected === null) {
    if (hits.length) {
      const key = JSON.stringify([text, hits]);
      if (fallbackSearch.get(cell) !== key || tableText(cell) !== text) {
        cell.replaceChildren(searchText(text, hits)); fallbackSearch.set(cell, key); if (active) select(cell, ...selection!);
      }
    } else {
      fallbackSearch.delete(cell);
      if (active) {
        if (tableText(cell) !== text) { cell.textContent = text; select(cell, ...selection!); }
        for (const mark of cell.querySelectorAll('.cm-search-hit')) mark.classList.remove('cm-search-hit', 'is-current');
      } else { cell.innerHTML = html(source, view); annotateImages(cell, text, view); }
    }
  } else if (projected && active) select(cell, ...selection!);
  for (const span of cell.querySelectorAll<HTMLElement>('code,a,.cm-md-code,[data-href]')) span.spellcheck = view.dom.dataset.spellcheckCode === 'true';
  mathTooltip(cell, text, selection, view);
  cell.dataset.source = source;
}
interface Controller {
  view: EditorView; root: HTMLElement; row: number; col: number; composing: boolean; writing: boolean;
  model(): MarkdownTable; commit(): void; mutate(action: string): void; focus(row: number, col: number): void;
  replace(text: string): void; resize(rows: number, columns: number): void;
}
const controllers = new WeakMap<HTMLElement, Controller>();
const cleanup = new WeakMap<HTMLElement, () => void>();
function syncFocus(controller: Controller): void {
  const cell = document.activeElement as HTMLElement | null;
  if (cell?.matches('td[data-row],th[data-row]') && controller.root.contains(cell)) {
    controller.row = Number(cell.dataset.row); controller.col = Number(cell.dataset.col);
  }
}
function cellAt(root: HTMLElement, row: number, col: number): HTMLElement | null { return root.querySelector(`[data-row="${row}"][data-col="${col}"]`); }
function write(controller: Controller, model: MarkdownTable, row = controller.row, col = controller.col): void {
  const { root, view } = controller, from = Number(root.dataset.from), to = Number(root.dataset.to);
  controller.writing = true;
  try { view.dispatch({ changes: { from, to, insert: serializeTable(model) }, selection: { anchor: from }, userEvent: 'input' }); }
  finally { controller.writing = false; }
  const focus = () => {
    const next = Array.from(view.dom.querySelectorAll<HTMLElement>('.md-table-widget')).find((element) => Number(element.dataset.from) === from);
    if (next) controllers.get(next)?.focus(Math.min(row, model.rows.length - 1), Math.min(col, model.align.length - 1));
  };
  // A structure change replaces the widget; text edits keep its DOM and caret.
  if (!root.isConnected) queueMicrotask(focus);
}

export class TableWidget extends WidgetType {
  readonly revision: string;
  constructor(readonly source: string, readonly from: number, readonly to: number, references: MarkdownReferences = {}, hits: SearchHighlight[] = []) {
    super(); this.revision = JSON.stringify([dialect(), references, hits]);
  }
  override eq(other: TableWidget): boolean { return this.source === other.source && this.from === other.from && this.to === other.to && this.revision === other.revision; }
  override ignoreEvent(): boolean { return true; }
  toDOM(view: EditorView): HTMLElement {
    const table = parseTable(this.source)!;
    const ranges = sourceCells(this.source);
    const root = document.createElement('div'); root.className = 'md-block-widget md-table-widget'; root.contentEditable = 'false';
    root.dataset.from = String(this.from); root.dataset.to = String(this.to); root.dataset.kind = 'table_open';
    root.dataset.revision = this.revision;
    const toolbar = document.createElement('div'); toolbar.className = 'md-table-toolbar'; toolbar.setAttribute('role', 'toolbar');
    const menu = document.createElement('div'); menu.className = 'md-table-menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
    const resize = document.createElement('div'); resize.className = 'md-table-resize'; resize.hidden = true; resize.setAttribute('role', 'dialog');
    const controller: Controller = {
      root, view, row: 0, col: 0, composing: false, writing: false,
      model: () => parseTable(view.state.sliceDoc(Number(root.dataset.from), Number(root.dataset.to)))!,
      focus(row, col) {
        this.row = row; this.col = col; const cell = cellAt(root, row, col); if (cell) select(cell);
      },
      commit() {
        if (!root.isConnected || this.writing || controllers.get(root) !== this) return;
        syncFocus(this);
        if (this.composing) return;
        const model = this.model(), cell = cellAt(root, this.row, this.col); if (!cell || !model?.rows[this.row]) return;
        const content = tableText(cell), source = model.rows[this.row][this.col];
        if (editable(source) === content) { renderCell(cell, source, view, document.activeElement === cell); return; }
        const text = escaped(content);
        const selection = offsets(cell);
        model.rows[this.row][this.col] = text; write(this, model);
        // CodeMirror restores its own document selection after a transaction.
        // Keep the independent cell caret where native typing left it.
        if (cell.isConnected) { select(cell, ...selection); renderCell(cell, text, view, true); }
      },
      replace(text) {
        syncFocus(this);
        const cell = cellAt(root, this.row, this.col); if (!cell) return;
        const [from, to] = offsets(cell), original = tableText(cell);
        cell.textContent = original.slice(0, from) + text + original.slice(to); select(cell, from + text.length, from + text.length); this.commit();
      },
      resize(rows, columns) {
        const model = this.model(); if (!model || !Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1) return;
        model.align = Array.from({ length: columns }, (_, c) => model.align[c] || '');
        model.rows = Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => model.rows[r]?.[c] || ''));
        resize.hidden = true; write(this, model);
        if (root.isConnected) this.focus(Math.min(this.row, rows - 1), Math.min(this.col, columns - 1));
      },
      mutate(action) {
        syncFocus(this);
        menu.hidden = true; resize.hidden = true; const model = this.model(); if (!model) return;
        let row = this.row, col = this.col;
        if (action === 'deleteTable') {
          const from = Number(root.dataset.from); view.dispatch({ changes: { from, to: Number(root.dataset.to), insert: '' }, selection: { anchor: from }, userEvent: 'delete' }); view.focus(); return;
        }
        if (['left', 'center', 'right'].includes(action)) model.align[col] = action as 'left';
        else if (action === 'rowBefore' || action === 'rowAfter') { row = Math.max(1, row + (action === 'rowAfter' ? 1 : 0)); model.rows.splice(row, 0, model.align.map(() => '')); }
        else if (action === 'columnBefore' || action === 'columnAfter') { col += action === 'columnAfter' ? 1 : 0; model.align.splice(col, 0, ''); model.rows.forEach((r) => r.splice(col, 0, '')); }
        else if (action === 'deleteRow') { if (model.rows.length === 1) return this.mutate('deleteTable'); model.rows.splice(row, 1); row = Math.min(row, model.rows.length - 1); }
        else if (action === 'deleteColumn') { if (model.align.length === 1) return this.mutate('deleteTable'); model.align.splice(col, 1); model.rows.forEach((r) => r.splice(col, 1)); col = Math.min(col, model.align.length - 1); }
        else if (action === 'rowUp' || action === 'rowDown') {
          const next = row + (action === 'rowUp' ? -1 : 1); if (next < 0 || next >= model.rows.length) return;
          [model.rows[row], model.rows[next]] = [model.rows[next], model.rows[row]]; row = next;
        } else if (action === 'columnLeft' || action === 'columnRight') {
          const next = col + (action === 'columnLeft' ? -1 : 1); if (next < 0 || next >= model.align.length) return;
          model.rows.forEach(r => { [r[col], r[next]] = [r[next], r[col]]; });
          [model.align[col], model.align[next]] = [model.align[next], model.align[col]]; col = next;
        } else if (action !== 'prettify' && !['left', 'center', 'right', 'rowBefore', 'rowAfter', 'columnBefore', 'columnAfter', 'deleteRow', 'deleteColumn'].includes(action)) return;
        write(this, model, row, col);
        queueMicrotask(() => {
          const current = Array.from(view.dom.querySelectorAll<HTMLElement>('.md-table-widget')).find((node) => Number(node.dataset.from) === Number(root.dataset.from));
          controllers.get(current!)?.focus(row, col);
        });
      },
    };
    controllers.set(root, controller);
    const button = (action: string, icon?: string) => {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.action = action;
      if (icon) { const i = document.createElement('i'); i.className = 'fa ' + icon; b.append(i); }
      b.addEventListener('mousedown', (event) => event.preventDefault());
      b.addEventListener('click', () => {
        if (action === 'resize') {
          menu.hidden = true; resize.hidden = !resize.hidden;
          if (!resize.hidden) { const model = controller.model(); previewSize(model.rows.length, model.align.length); }
        } else controller.mutate(action);
      }); return b;
    };
    toolbar.append(button('resize', 'fa-table'), button('left', 'fa-align-left'), button('center', 'fa-align-center'), button('right', 'fa-align-right'), button('deleteTable', 'fa-trash-o'));
    for (const action of ['rowBefore', 'rowAfter', 'deleteRow', 'columnBefore', 'columnAfter', 'deleteColumn']) menu.append(button(action));
    const sizes = document.createElement('div'); sizes.className = 'md-table-size-grid'; sizes.setAttribute('role', 'grid');
    const dimensions = document.createElement('div'); dimensions.className = 'md-table-dimensions';
    const columns = document.createElement('input'), rows = document.createElement('input');
    for (const [input, dimension] of [[columns, 'columns'], [rows, 'rows']] as const) {
      input.type = 'text'; input.inputMode = 'numeric'; input.pattern = '[0-9]+'; input.dataset.dimension = dimension;
      input.contentEditable = 'false';
      input.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation(); input.focus(); input.select(); });
      for (const type of ['beforeinput', 'input', 'paste', 'copy', 'cut', 'compositionstart', 'compositionupdate', 'compositionend']) input.addEventListener(type, (event) => event.stopPropagation());
      input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') { event.preventDefault(); controller.resize(Number(rows.value), Number(columns.value)); }
        if (event.key === 'Escape') { event.preventDefault(); resize.hidden = true; controller.focus(controller.row, controller.col); }
      });
    }
    const previewSize = (height: number, width: number) => {
      rows.value = String(height); columns.value = String(width);
      for (const tile of sizes.querySelectorAll<HTMLElement>('button')) {
        tile.classList.toggle('is-selected', Number(tile.dataset.rows) <= height && Number(tile.dataset.columns) <= width);
      }
    };
    for (let r = 1; r <= 10; r++) for (let c = 1; c <= 6; c++) {
      const tile = document.createElement('button'); tile.type = 'button'; tile.dataset.rows = String(r); tile.dataset.columns = String(c);
      tile.tabIndex = -1;
      tile.setAttribute('role', 'gridcell');
      if (r === 1) tile.classList.add('is-header');
      tile.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation(); });
      tile.addEventListener('mouseenter', () => previewSize(r, c));
      tile.addEventListener('click', () => controller.resize(r, c)); sizes.append(tile);
    }
    dimensions.append(columns, document.createTextNode(' × '), rows); resize.append(sizes, dimensions);
    root.append(toolbar, menu, resize);
    // A native window activation or accessibility click can briefly clear DOM
    // focus before the input receives it. Closing on blur races that transfer.
    const outside = (event: MouseEvent) => { if (!root.contains(event.target as Node)) { menu.hidden = true; resize.hidden = true; } };
    root.ownerDocument.addEventListener('mousedown', outside, true);
    const selectionChanged = () => {
      const cell = document.activeElement as HTMLElement | null;
      if (controller.composing || controller.writing) return;
      if (!cell?.matches('td[data-row],th[data-row]') || !root.contains(cell)) {
        const previous = cellAt(root, controller.row, controller.col), source = controller.model()?.rows[controller.row]?.[controller.col];
        if (previous && source !== undefined) renderCell(previous, source, view, false);
        return;
      }
      const source = controller.model()?.rows[Number(cell.dataset.row)]?.[Number(cell.dataset.col)];
      // Wait until native input/composition has committed before repainting.
      if (source !== undefined && tableText(cell) === editable(source)) renderCell(cell, source, view, true);
    };
    root.ownerDocument.addEventListener('selectionchange', selectionChanged);
    view.scrollDOM.addEventListener('scroll', selectionChanged); window.addEventListener('resize', selectionChanged);
    cleanup.set(root, () => { root.ownerDocument.removeEventListener('mousedown', outside, true); root.ownerDocument.removeEventListener('selectionchange', selectionChanged); view.scrollDOM.removeEventListener('scroll', selectionChanged); window.removeEventListener('resize', selectionChanged); });
    const grid = document.createElement('table'); const head = document.createElement('thead'), body = document.createElement('tbody'); grid.append(head, body);
    table.rows.forEach((row, r) => {
      const tr = document.createElement('tr'); (r ? body : head).append(tr);
      row.forEach((source, c) => {
        const cell = document.createElement(r ? 'td' : 'th'); cell.dataset.row = String(r); cell.dataset.col = String(c); cell.contentEditable = 'plaintext-only';
        setCellRange(cell, ranges, this.from, r, c);
        cell.tabIndex = 0;
        cell.setAttribute('role', 'textbox'); cell.setAttribute('spellcheck', 'true');
        cell.style.textAlign = table.align[c]; renderCell(cell, source, view, false); tr.append(cell);
        cell.addEventListener('focus', () => {
          controller.row = r; controller.col = c;
          renderCell(cell, controller.model()?.rows[r]?.[c] || '', view, true);
        });
        cell.addEventListener('mousedown', () => {
          if (view.state.selection.main.head !== Number(root.dataset.from)) view.dispatch({ selection: { anchor: Number(root.dataset.from) } });
        });
        cell.addEventListener('mousedown', (event) => {
          const preview = (event.target as HTMLElement).closest<HTMLElement>('.md-table-math-preview,.md-table-image-preview,.md-table-footnote'); if (!preview || event.button !== 0) return;
          event.preventDefault(); event.stopPropagation();
          const image = preview.classList.contains('md-table-image-preview'), note = preview.classList.contains('md-table-footnote');
          const from = Number(preview.dataset.from) + (image ? Number(preview.dataset.selectionFrom) : note ? 2 : 1);
          const to = image ? Number(preview.dataset.from) + Number(preview.dataset.selectionTo) : Number(preview.dataset.to) - 1;
          select(cell, from, to); renderCell(cell, controller.model()?.rows[r]?.[c] || '', view, true);
        });
        cell.addEventListener('blur', () => {
          // Windows emits blur synchronously when CodeMirror replaces a focused
          // widget. Dispatching there reenters the active update with stale ranges.
          const document = view.state.doc, content = tableText(cell), text = escaped(content), original = cell.dataset.source;
          queueMicrotask(() => {
            if (!root.isConnected || controllers.get(root) !== controller || view.state.doc !== document || controller.writing || controller.composing) return;
            const model = controller.model();
            if (!model?.rows[r]) return;
            if (model.rows[r][c] === original && editable(model.rows[r][c]) !== content) { model.rows[r][c] = text; write(controller, model); }
            if (cell.isConnected && globalThis.document.activeElement !== cell) renderCell(cell, model.rows[r][c], view, false);
          });
          menu.hidden = true;
        });
        cell.addEventListener('click', (event) => { const link = (event.target as HTMLElement).closest<HTMLElement>('[data-href]'); if (link && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void (window as any).JSBridge?.invoke('shell.openExternal', link.dataset.href); } });
        cell.addEventListener('compositionstart', () => { controller.composing = true; });
        cell.addEventListener('compositionend', () => { controller.composing = false; controller.commit(); });
        cell.addEventListener('beforeinput', event => {
          // macOS can replace an adjacent straight quote while inserting a
          // letter in an HTML attribute. Veto only automatic replacements in
          // source ranges; native typing, composition and plain-text correction stay native.
          if (event.cancelable && event.inputType === 'insertReplacementText' && replacesSource(cell, event, view)) event.preventDefault();
        });
        cell.addEventListener('input', () => controller.commit());
        cell.addEventListener('contextmenu', (event) => {
          controller.row = r; controller.col = c;
          // The desktop menu combines Blink's spelling results with table tools.
          if (typeof (window as any).JSBridge !== 'undefined') { menu.hidden = true; return; }
          event.preventDefault(); menu.hidden = false;
        });
        cell.addEventListener('paste', (event) => {
          event.preventDefault(); const text = event.clipboardData?.getData('text/plain') || '';
          if (!text.includes('\t')) { controller.replace(text); return; }
          const model = controller.model(), rows = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((line) => line.split('\t'));
          const columns = Math.max(model.align.length, c + Math.max(...rows.map((row) => row.length)));
          while (model.align.length < columns) { model.align.push(''); model.rows.forEach((row) => row.push('')); }
          while (model.rows.length < r + rows.length) model.rows.push(model.align.map(() => ''));
          rows.forEach((row, i) => row.forEach((value, j) => { model.rows[r + i][c + j] = escaped(value); })); write(controller, model, r, c);
        });
        cell.addEventListener('keydown', (event) => {
          if (event.defaultPrevented || event.isComposing || controller.composing) return;
          if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && ['ArrowLeft', 'ArrowRight', 'Backspace', 'Delete'].includes(event.key)) {
            const [from, to] = offsets(cell), backward = event.key === 'ArrowLeft' || event.key === 'Backspace';
            const rich = [...inlineMathSpans(tableText(cell)), ...inlineImages(tableText(cell), documentReferences(view.state.doc.toString())), ...inlineFootnotes(tableText(cell))];
            const formula = from === to && rich.find((span) => backward ? span.to === from : span.from === from);
            if (formula) {
              event.preventDefault(); event.stopPropagation();
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { select(cell, backward ? from - 1 : from + 1, backward ? from - 1 : from + 1); renderCell(cell, controller.model()?.rows[r]?.[c] || '', view, true); }
              else { select(cell, backward ? from - 1 : from, backward ? from : from + 1); controller.replace(''); }
              return;
            }
          }
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopPropagation(); tableAction(view, event.shiftKey ? 'redo' : 'undo'); return; }
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); event.stopPropagation(); select(cell); return; }
          if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === 'Backspace' || event.altKey && event.key.toLowerCase() === 'l')) {
            event.preventDefault(); event.stopPropagation(); controller.commit(); controller.mutate('deleteRow'); return;
          }
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault(); event.stopPropagation(); controller.commit(); controller.mutate(event.shiftKey ? 'rowBefore' : 'rowAfter'); return;
          }
          if (event.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation(); controller.commit();
            controller.mutate(({ ArrowUp: 'rowUp', ArrowDown: 'rowDown', ArrowLeft: 'columnLeft', ArrowRight: 'columnRight' } as Record<string, string>)[event.key]); return;
          }
          if (event.key === 'Escape') { event.preventDefault(); menu.hidden = true; resize.hidden = true; cell.blur(); view.focus(); return; }
          if (event.key !== 'Tab' && event.key !== 'Enter') return;
          event.preventDefault(); event.stopPropagation(); controller.commit();
          if (event.key === 'Enter' && event.shiftKey) { controller.replace('\n'); return; }
          const model = controller.model(), width = model.align.length;
          let row = r, col = c;
          if (event.key === 'Enter') row++;
          else { const next = r * width + c + (event.shiftKey ? -1 : 1); row = Math.floor(next / width); col = (next + width) % width; }
          if (row >= model.rows.length && event.key === 'Tab') { model.rows.push(model.align.map(() => '')); write(controller, model, row, col); }
          else if (row >= model.rows.length || row < 0) {
            const start = Number(root.dataset.from), end = Number(root.dataset.to), forward = row >= model.rows.length;
            let pos = forward ? end : Math.max(0, start - 1);
            if (forward && end === view.state.doc.length) { view.dispatch({ changes: { from: end, insert: '\n\n' }, selection: { anchor: end + 2 }, userEvent: 'input' }); }
            else view.dispatch({ selection: { anchor: pos }, scrollIntoView: true }); view.focus();
          } else controller.focus(row, col);
        });
      });
    });
    root.append(grid); localizeTable(root); return root;
  }
  override updateDOM(root: HTMLElement, view: EditorView): boolean {
    const model = parseTable(this.source); if (!model) return false;
    const ranges = sourceCells(this.source);
    const rows = root.querySelectorAll('tr');
    if (rows.length !== model.rows.length || root.querySelectorAll('th').length !== model.align.length) return false;
    root.dataset.from = String(this.from); root.dataset.to = String(this.to);
    const reconfigured = root.dataset.revision !== this.revision; root.dataset.revision = this.revision;
    for (let r = 0; r < model.rows.length; r++) for (let c = 0; c < model.align.length; c++) {
      const cell = cellAt(root, r, c)!; cell.style.textAlign = model.align[c];
      setCellRange(cell, ranges, this.from, r, c);
      if (document.activeElement === cell) {
        const source = editable(model.rows[r][c]);
        const controller = controllers.get(root);
        if (!controller?.composing && !controller?.writing) {
          if (tableText(cell) !== source) { const [from, to] = offsets(cell); cell.textContent = source; select(cell, from, to); }
          renderCell(cell, model.rows[r][c], view, true);
        }
      } else if (reconfigured || cell.dataset.source !== model.rows[r][c]) renderCell(cell, model.rows[r][c], view, false);
    }
    return true;
  }
  override destroy(root: HTMLElement): void { cleanup.get(root)?.(); cleanup.delete(root); controllers.delete(root); }
}

const tableLabels: Record<string, [string, string]> = {
  resize: ['调整表格', 'Resize Table'], left: ['左对齐', 'Align Left'], center: ['居中对齐', 'Align Center'], right: ['右对齐', 'Align Right'],
  deleteTable: ['删除表格', 'Delete Table'], rowBefore: ['在上方插入行', 'Insert Row Above'], rowAfter: ['在下方插入行', 'Insert Row Below'],
  deleteRow: ['删除行', 'Delete Row'], columnBefore: ['在左侧插入列', 'Insert Column Before'], columnAfter: ['在右侧插入列', 'Insert Column After'], deleteColumn: ['删除列', 'Delete Column'],
};
function localizeTable(root: HTMLElement): void {
  for (const [selector, zh, en] of [
    ['.md-table-toolbar', '表格工具', 'Table tools'], ['.md-table-menu', '表格操作', 'Table actions'],
    ['.md-table-resize', '调整表格尺寸', 'Resize table'], ['.md-table-size-grid', '选择列数与行数', 'Choose columns and rows'],
    ['[data-dimension="columns"]', '列数', 'Columns'], ['[data-dimension="rows"]', '行数', 'Rows'],
  ]) root.querySelector(selector)?.setAttribute('aria-label', uiText(zh, en));
  for (const button of root.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
    const label = uiText(...tableLabels[button.dataset.action!]);
    button.title = label; button.setAttribute('aria-label', label);
    if (button.parentElement?.classList.contains('md-table-menu')) button.textContent = label;
  }
  for (const tile of root.querySelectorAll<HTMLElement>('[data-rows][data-columns]')) {
    const c = tile.dataset.columns, r = tile.dataset.rows;
    tile.setAttribute('aria-label', uiText(`${c} 列 × ${r} 行`, `${c} columns × ${r} rows`));
  }
  for (const cell of root.querySelectorAll<HTMLElement>('td[data-row],th[data-row]')) {
    const r = Number(cell.dataset.row) + 1, c = Number(cell.dataset.col) + 1;
    cell.setAttribute('aria-label', uiText(`第 ${r} 行，第 ${c} 列`, `Row ${r}, column ${c}`));
  }
}
/** Update only table controls and accessibility text, retaining native cell selection. */
export function refreshTableLanguage(view: EditorView): void {
  for (const root of view.dom.querySelectorAll<HTMLElement>('.md-table-widget')) localizeTable(root);
}

export function refreshTableMedia(view: EditorView): void {
  for (const root of view.dom.querySelectorAll<HTMLElement>('.md-table-widget')) {
    const controller = controllers.get(root); if (!controller || controller.composing || controller.writing) continue;
    const model = controller.model(); if (!model) continue;
    for (const cell of root.querySelectorAll<HTMLElement>('td[data-row],th[data-row]')) {
      renderCell(cell, model.rows[Number(cell.dataset.row)][Number(cell.dataset.col)], view, document.activeElement === cell);
    }
  }
}

/** Store source positions rather than live DOM ranges: leaving a rich cell
 * can replace its formatted text nodes before the context menu opens. */
export function tableSelection(view: EditorView): { from: number; to: number } | undefined {
  const cell = document.activeElement as HTMLElement | null, native = window.getSelection();
  if (!cell?.matches('td[data-source-from],th[data-source-from]') || !view.dom.contains(cell) ||
      !native?.anchorNode || !native.focusNode || !cell.contains(native.anchorNode) || !cell.contains(native.focusNode)) return;
  const base = Number(cell.dataset.sourceFrom), source = view.state.sliceDoc(base, Number(cell.dataset.sourceTo));
  if (tableText(cell) !== editable(source)) return;
  const [from, to] = offsets(cell);
  return { from: base + sourceOffset(source, from), to: base + sourceOffset(source, to) };
}

export function focusTableRange(view: EditorView, from: number, to: number, preferred?: ImageSourceRange['cell']): boolean {
  for (const cell of view.dom.querySelectorAll<HTMLElement>('.md-table-widget [data-source-from]')) {
    const start = Number(cell.dataset.sourceFrom), end = Number(cell.dataset.sourceTo);
    if (preferred ? Number(cell.dataset.row) !== preferred.row || Number(cell.dataset.col) !== preferred.column ||
      Number(cell.closest<HTMLElement>('.md-table-widget')?.dataset.from) !== preferred.tableFrom : from < start || to > end) continue;
    const source = view.state.sliceDoc(start, end);
    select(cell, editable(source.slice(0, Math.max(0, from - start))).length, editable(source.slice(0, Math.max(0, to - start))).length);
    renderCell(cell, source, view, true); return true;
  }
  return false;
}

export function tableImageAt(view: EditorView, target: HTMLElement): ImageSourceRange | null {
  const image = target.closest<HTMLElement>('[data-table-image-from]'), cell = image?.closest<HTMLElement>('td[data-source-from],th[data-source-from]');
  const root = cell?.closest<HTMLElement>('.md-table-widget');
  if (!image || !cell || !root || !view.dom.contains(root) || controllers.get(root)?.composing) return null;
  const base = Number(cell.dataset.sourceFrom), raw = view.state.sliceDoc(base, Number(cell.dataset.sourceTo)), source = editable(raw);
  if (document.activeElement === cell && tableText(cell) !== source) return null;
  const start = Number(image.dataset.tableImageFrom), end = Number(image.dataset.tableImageTo);
  const from = base + sourceOffset(raw, start), to = base + sourceOffset(raw, end);
  return { from, to, source: source.slice(start, end), rawSource: view.state.sliceDoc(from, to), table: true,
    cell: { tableFrom: Number(root.dataset.from), row: Number(cell.dataset.row), column: Number(cell.dataset.col) } };
}

export function tableAction(view: EditorView, action: string): boolean {
  const cell = document.activeElement as HTMLElement | null, root = cell?.closest<HTMLElement>('.md-table-widget');
  if (!cell?.matches('td[data-row],th[data-row]') || !root || !view.dom.contains(root)) return false;
  const controller = controllers.get(root); if (!controller) return false;
  const mutations: Record<string, string> = { insertParagraphAfter: 'rowAfter', insertParagraphBefore: 'rowBefore', tableRowBefore: 'rowBefore', tableRowAfter: 'rowAfter', deleteLine: 'deleteRow', deleteBlock: 'deleteTable',
    tableRowUp: 'rowUp', tableRowDown: 'rowDown', tableColumnLeft: 'columnLeft', tableColumnRight: 'columnRight', prettifyTable: 'prettify',
    tableDeleteRow: 'deleteRow', tableColumnBefore: 'columnBefore', tableColumnAfter: 'columnAfter', tableDeleteColumn: 'deleteColumn', deleteTable: 'deleteTable' };
  if (mutations[action]) { controller.commit(); controller.mutate(mutations[action]); return true; }
  if (action === 'selectAll') { select(cell!); return true; }
  if (action === 'selectLine' || action === 'selectBlock') {
    controller.commit(); cell.focus();
    const model = controller.model(), row = Number(cell.dataset.row);
    const cells = Array.from(root.querySelectorAll<HTMLElement>('[data-row][data-col]')).filter((candidate) => action === 'selectBlock' || Number(candidate.dataset.row) === row);
    cells.forEach((candidate) => renderCell(candidate, model.rows[Number(candidate.dataset.row)][Number(candidate.dataset.col)], view, false));
    const range = document.createRange(); range.setStart(cells[0], 0); range.setEnd(cells[cells.length - 1], cells[cells.length - 1].childNodes.length);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); return true;
  }
  if (['selectStyled', 'selectWord', 'deleteStyled', 'deleteWord'].includes(action)) {
    const source = tableText(cell), [head] = offsets(cell), remove = action.startsWith('delete');
    const [from, to] = textRange(source, head, action.endsWith('Word') ? 'word' : 'style', remove);
    select(cell, from, to);
    if (remove) controller.replace(''); else renderCell(cell, controller.model().rows[Number(cell.dataset.row)][Number(cell.dataset.col)], view, true);
    return true;
  }
  if (action === 'undo' || action === 'redo') {
    const from = Number(root.dataset.from), row = Number(cell!.dataset.row), col = Number(cell!.dataset.col), [start, end] = offsets(cell!);
    (action === 'undo' ? undo : redo)(view);
    queueMicrotask(() => {
      const next = Array.from(view.dom.querySelectorAll<HTMLElement>('.md-table-widget')).find((node) => Number(node.dataset.from) === from);
      const target = next && cellAt(next, row, col); if (target) select(target, start, end);
    }); return true;
  }
  if (action === 'del') {
    const [from, to] = offsets(cell!); if (from === to) select(cell!, from, Math.min(tableText(cell!).length, to + 1));
    controller.replace(''); return true;
  }
  const formats: Record<string, [string, string]> = { strong: ['**', '**'], emphasis: ['*', '*'], strike: ['~~', '~~'], inlineCode: ['`', '`'], underline: ['<u>', '</u>'], highlight: ['==', '=='] };
  const format = formats[action];
  if (format && cell?.matches('td,th')) {
    const [from, to] = offsets(cell), selected = tableText(cell).slice(from, to);
    controller.replace(format[0] + selected + format[1]); select(cell, from + format[0].length, to + format[0].length); return true;
  }
  return false;
}
