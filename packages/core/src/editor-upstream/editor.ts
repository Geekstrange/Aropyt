import { uiText } from './stubs.js';
import { selectedLines } from './selected-lines.js';
import { displayFileUrl } from './stubs.js';
import { Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewUpdate, WidgetType, drawSelection, keymap, rectangularSelection, showTooltip } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from '@codemirror/commands';
import hljs from 'highlight.js';
import { renderDocument, type BlockRange, type Heading, dialect, escapeHtml, standaloneImage, type StandaloneImage, documentReferences } from './md.js';
import { codeFence, type CodeFence } from './code-fences.js';
import { attachLanguagePicker } from './code-language.js';
import { plainText, reindentCode } from './editing-commands.js';
import { parseTable, serializeTable, tableFromHeader, TableWidget, tableAction, refreshTableMedia, refreshTableLanguage, focusTableRange, tableImageAt } from './table-editor.js';
import { inlineSpans, inlineMathSpans, nativeParagraph } from './inline-markdown.js';
import { inlineImages, inlineFootnotes } from './inline-media.js';
import { cachedDiagram } from './diagram-preview.js';
import { structureRows } from './native-structure.js';
import { backspaceListItem, indentListItem } from './list-editing.js';
import { highlightedCode } from './code-highlighting.js';
import { applyImageDimensions, transformImage, type ImageSourceRange } from './image-actions.js';
import { type SearchHit, searchHighlightField, searchHighlights, searchIntersects, searchClass, setSearchHighlights } from './search-highlights.js';
import { footnotePreview } from './footnote-preview.js';

/* --------------------------------------------------------------- effects */

export const setSourceMode = StateEffect.define<boolean>();
export const setFocusMode = StateEffect.define<boolean>();
export const setTypewriter = StateEffect.define<boolean>();
export const rebuild = StateEffect.define<void>();
const setPreferences = StateEffect.define<Record<string, any>>();
const preferenceField = StateField.define<Record<string, any>>({
  create: () => ({}),
  update(value, transaction) { for (const effect of transaction.effects) if (effect.is(setPreferences)) value = effect.value; return value; },
});

export interface EditorHost {
  docDir: () => string | undefined;
  math: (tex: string, display: boolean) => string;
  resolveSrc: (src: string) => string;
  /** Called after a widget's DOM is attached so async renderers can run. */
  enhance: (root: HTMLElement) => void;
  onFocusChange?: (line: number) => void;
  language?: () => 'zh' | 'en';
}

/* --------------------------------------------------------------- widgets */

class BlockWidget extends WidgetType {
  constructor(
    readonly html: string,
    readonly kind: string,
    readonly lineNo: number,
    readonly topLine: number,
  ) {
    super();
  }

  override eq(other: BlockWidget): boolean {
    return other.html === this.html && other.kind === this.kind && other.topLine === this.topLine;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'md-block-widget';
    wrap.dataset.kind = this.kind;
    wrap.dataset.line = String(this.topLine);
    wrap.setAttribute('contenteditable', 'false');
    wrap.innerHTML = this.html;
    const diagram = wrap.querySelector<HTMLElement>('.md-diagram');
    const source = diagram?.querySelector('.md-diagram-pending')?.textContent;
    const cached = source !== undefined && cachedDiagram(source, this.topLine);
    if (diagram && cached) { diagram.innerHTML = cached; diagram.dataset.rendered = '1'; diagram.dataset.source = source!; }
    (view as unknown as { __host?: EditorHost }).__host?.enhance(wrap);
    return wrap;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Only the Markdown delimiters are replaced; the code remains native
 * CodeMirror text, with a single selection, clipboard and undo history. */
class FenceEdgeWidget extends WidgetType {
  constructor(readonly fence: CodeFence, readonly bottom: boolean, readonly active = false, readonly afterClass = '') { super(); }

  override eq(other: FenceEdgeWidget): boolean {
    return this.bottom === other.bottom && this.active === other.active && this.afterClass === other.afterClass && this.fence.from === other.fence.from &&
      this.fence.opening === other.fence.opening;
  }

  toDOM(view: EditorView): HTMLElement {
    const edge = document.createElement('div');
    edge.className = (this.bottom ? 'cm-code-edge cm-code-bottom' : 'cm-code-edge cm-code-top') + this.afterClass;
    edge.classList.toggle('is-active', this.active);
    edge.classList.toggle('cm-code-diagram-bottom', this.bottom && this.fence.diagram && dialect().diagrams);
    edge.contentEditable = 'false';
    const cap = document.createElement('div');
    cap.className = 'cm-code-cap';
    edge.append(cap);
    if (this.bottom && !(this.fence.diagram && dialect().diagrams && this.active)) edge.append(languageControl(view, this.fence));
    return edge;
  }

  override ignoreEvent(): boolean { return true; }
  override updateDOM(dom: HTMLElement, _view: EditorView): boolean {
    if (dom.classList.contains('cm-code-bottom') !== this.bottom ||
        dom.classList.contains('cm-code-diagram-bottom') !== (this.bottom && this.fence.diagram && dialect().diagrams)) return false;
    dom.className = (this.bottom ? 'cm-code-edge cm-code-bottom' : 'cm-code-edge cm-code-top') + this.afterClass;
    dom.classList.toggle('cm-code-diagram-bottom', this.bottom && this.fence.diagram && dialect().diagrams);
    dom.classList.toggle('is-active', this.active); updateLanguageControl(dom, this.fence); return true;
  }
  override destroy(dom: HTMLElement): void { destroyLanguageControl(dom); }
}
const pickerCleanup = new WeakMap<HTMLElement, () => void>();
const languageFences = new WeakMap<HTMLElement, CodeFence>();
function updateLanguageControl(root: HTMLElement, fence: CodeFence): void {
  const shell = root.querySelector<HTMLElement>('.cm-code-language-shell'); if (!shell) return;
  const previous = languageFences.get(shell);
  languageFences.set(shell, fence); shell.dataset.fenceFrom = String(fence.from);
  const input = shell.querySelector<HTMLInputElement>('input')!;
  if (document.activeElement !== input || previous?.opening !== fence.opening) input.value = fence.lang;
}
function destroyLanguageControl(root: HTMLElement): void {
  const shell = root.querySelector<HTMLElement>('.cm-code-language-shell');
  if (shell) { pickerCleanup.get(shell)?.(); pickerCleanup.delete(shell); languageFences.delete(shell); }
}
function languageControl(view: EditorView, fence: CodeFence): HTMLElement {
  const shell = document.createElement('div'); shell.className = 'cm-code-language-shell'; shell.contentEditable = 'false';
  languageFences.set(shell, fence); shell.dataset.fenceFrom = String(fence.from);
  const input = document.createElement('input');
  input.className = 'cm-code-language'; input.contentEditable = 'false'; input.autocapitalize = 'off';
  input.setAttribute('autocorrect', 'off'); input.setAttribute('spellcheck', 'false');
  input.value = fence.lang; input.placeholder = uiText('代码语言', 'Code language'); input.setAttribute('aria-label', uiText('代码块语言', 'Code language'));
  const commit = () => {
    const fence = languageFences.get(shell);
    if (!fence || fence.from > view.state.doc.length) return;
    const line = view.state.doc.lineAt(fence.from);
    if (line.from !== fence.from || !line.text.trimStart().startsWith(fence.marker)) return;
    const lang = input.value.trim().replace(/[^\w+#.-]/g, '');
    const suffix = fence.info.slice(fence.lang.length);
    const opening = fence.opening.slice(0, fence.opening.indexOf(fence.marker) + fence.marker.length);
    if (line.text !== opening + lang + suffix) view.dispatch({ changes: { from: line.from, to: line.to, insert: opening + lang + suffix }, userEvent: 'input' });
  };
  // Chromium may emit change while CodeMirror removes a focused widget. Wait
  // for that update to finish, and ignore the event if the control was retired.
  input.addEventListener('change', (event) => { event.stopPropagation(); queueMicrotask(commit); });
  shell.addEventListener('mousedown', (event) => { if (event.target === shell) { event.preventDefault(); input.focus(); } });
  pickerCleanup.set(shell, attachLanguagePicker(input, commit, () => view.focus(), () => {
    const current = view.dom.querySelector<HTMLElement>(`.cm-code-language-shell[data-fence-from="${fence.from}"]`);
    current?.querySelector<HTMLInputElement>('input')?.focus(); if (current) pickerCleanup.get(current)?.();
  }));
  shell.append(input); return shell;
}

/** Keep the last graph in place while its separate native code box is edited. */
class DiagramPreviewWidget extends WidgetType {
  constructor(readonly source: string, readonly fence: CodeFence) { super(); }
  get line(): number { return this.fence.firstLine; }
  override eq(other: DiagramPreviewWidget): boolean {
    return this.source === other.source && this.fence.from === other.fence.from && this.fence.opening === other.fence.opening;
  }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div'); root.className = 'md-block-widget md-diagram-edit-preview';
    root.contentEditable = 'false'; root.dataset.kind = 'fence'; root.dataset.line = String(this.line);
    const cached = cachedDiagram(this.source, this.line);
    root.innerHTML = `<div class="md-diagram md-fences">${cached || `<pre class="md-diagram-pending">${escapeHtml(this.source)}</pre>`}</div>`;
    const diagram = root.querySelector<HTMLElement>('.md-diagram')!; diagram.dataset.source = this.source;
    if (cached) diagram.dataset.rendered = '1';
    root.append(languageControl(view, this.fence)); root.dataset.fenceFrom = String(this.fence.from); root.dataset.opening = this.fence.opening;
    (view as any).__host?.enhance(root); return root;
  }
  override updateDOM(root: HTMLElement, view: EditorView): boolean {
    root.dataset.line = String(this.line);
    const diagram = root.querySelector<HTMLElement>('.md-diagram'); if (!diagram) return false;
    updateLanguageControl(root, this.fence);
    if (diagram.dataset.source !== this.source) {
      diagram.dataset.source = this.source; delete diagram.dataset.rendered;
      (view as any).__host?.enhance(root);
    }
    return true;
  }
  override ignoreEvent(event: Event): boolean { return !!(event.target as HTMLElement | null)?.closest('.cm-code-language-shell'); }
  override destroy(dom: HTMLElement): void { destroyLanguageControl(dom); }
}

class ListMarkerWidget extends WidgetType {
  constructor(readonly marker: string, readonly task: boolean | null, readonly position: number) { super(); }
  override eq(other: ListMarkerWidget): boolean { return this.marker === other.marker && this.task === other.task && this.position === other.position; }
  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement('span'); span.className = 'cm-list-marker'; span.contentEditable = 'false';
    if (this.task === null) {
      if (['•', '◦', '▪'].includes(this.marker)) { span.classList.add('cm-list-bullet'); span.dataset.marker = this.marker; }
      else span.textContent = this.marker;
      span.setAttribute('aria-hidden', 'true');
    }
    else {
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = this.task; checkbox.setAttribute('aria-label', uiText('任务状态', 'Task status'));
      checkbox.addEventListener('mousedown', (event) => event.preventDefault());
      checkbox.addEventListener('click', (event) => {
        event.stopPropagation(); view.dispatch({ changes: { from: this.position, to: this.position + 1, insert: this.task ? ' ' : 'x' }, userEvent: 'input' });
      }); span.append(checkbox);
    }
    return span;
  }
  override ignoreEvent(): boolean { return true; }
}

class InlineMathWidget extends WidgetType {
  constructor(readonly tex: string, readonly from: number, readonly to: number) { super(); }
  override eq(other: InlineMathWidget): boolean { return this.tex === other.tex && this.from === other.from && this.to === other.to; }
  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement('span'); span.className = 'cm-inline-math-widget md-inline-math'; span.contentEditable = 'false';
    span.dataset.tex = this.tex; span.dataset.from = String(this.from); span.dataset.to = String(this.to);
    span.innerHTML = (view as any).__host?.math(this.tex, false) ?? escapeHtml(this.tex);
    return span;
  }
  override ignoreEvent(): boolean { return false; }
}

class ImagePreviewWidget extends WidgetType {
  constructor(readonly source: string, readonly from: number, readonly active: boolean,
    readonly data: StandaloneImage = standaloneImage(source)!, readonly inline = false) { super(); }
  override eq(other: ImagePreviewWidget): boolean { return this.source === other.source && this.from === other.from && this.active === other.active &&
    this.inline === other.inline && JSON.stringify(this.data) === JSON.stringify(other.data); }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement(this.inline ? 'span' : 'div'); root.className = (this.inline ? 'cm-inline-image ' : 'md-block-widget ') + 'cm-image-preview' + (this.active ? ' is-active' : ''); root.contentEditable = 'false';
    const img = document.createElement('img'); img.className = 'md-image';
    const fallback = document.createElement('span'); fallback.className = 'cm-image-fallback'; fallback.hidden = true;
    const failed = (value: boolean) => {
      root.classList.toggle('is-failed', value); img.hidden = value; fallback.hidden = !value;
      root.hidden = value && root.classList.contains('is-active'); view.requestMeasure();
    };
    img.addEventListener('load', () => failed(false)); img.addEventListener('error', () => failed(true));
    root.append(img, fallback); this.updateDOM(root, view); return root;
  }
  override updateDOM(root: HTMLElement, view: EditorView): boolean {
    const data = this.data; if (!data) return false;
    root.dataset.from = String(this.from); root.dataset.to = String(this.from + this.source.length);
    root.dataset.selectionFrom = String(data.selectionFrom); root.dataset.selectionTo = String(data.selectionTo); root.classList.toggle('is-active', this.active);
    root.querySelector('.cm-image-fallback')!.textContent = this.source;
    root.hidden = this.active && root.classList.contains('is-failed');
    const img = root.querySelector('img')!; img.alt = data.alt; img.title = data.title; applyImageDimensions(img, data);
    const src = displayFileUrl((view as any).__host?.resolveSrc(data.src) ?? data.src);
    if (img.getAttribute('src') !== src) { root.classList.remove('is-failed'); root.hidden = false; img.hidden = false; root.querySelector<HTMLElement>('.cm-image-fallback')!.hidden = true; img.setAttribute('src', src); }
    return true;
  }
  override ignoreEvent(): boolean { return false; }
}

class FootnoteReferenceWidget extends WidgetType {
  constructor(readonly label: string, readonly from: number, readonly to: number) { super(); }
  override eq(other: FootnoteReferenceWidget): boolean { return this.label === other.label && this.from === other.from && this.to === other.to; }
  toDOM(): HTMLElement {
    const root = document.createElement('sup'); root.className = 'cm-inline-footnote'; root.contentEditable = 'false';
    root.textContent = this.label; root.dataset.from = String(this.from); root.dataset.to = String(this.to);
    root.dataset.footnoteLabel = this.label; return root;
  }
  override ignoreEvent(): boolean { return false; }
}

class FootnoteBackrefWidget extends WidgetType {
  constructor(readonly label: string, readonly from: number) { super(); }
  override eq(other: FootnoteBackrefWidget): boolean { return this.label === other.label && this.from === other.from; }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('a'); root.className = 'cm-footnote-backref'; root.contentEditable = 'false';
    root.textContent = '↩'; root.href = '#'; root.dataset.from = String(this.from); root.title = `[^${this.label}]`;
    root.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
      if (!focusTableRange(view, this.from + 2, this.from + 2)) view.focus();
    });
    return root;
  }
  override ignoreEvent(): boolean { return false; }
}

interface CodeToken { from: number; to: number; className: string }
const codeTokens = new Map<string, CodeToken[]>();
function highlightTokens(code: string, lang: string): CodeToken[] {
  if (!hljs.getLanguage(lang)) return [];
  const key = lang + '\n' + code;
  const cached = codeTokens.get(key);
  if (cached) return cached;
  const root = document.createElement('div');
  root.innerHTML = highlightedCode(code, lang) ?? escapeHtml(code);
  const tokens: CodeToken[] = [];
  let offset = 0;
  const walk = (node: Node, classes: string) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const end = offset + (node.textContent?.length ?? 0);
      if (classes && end > offset) tokens.push({ from: offset, to: end, className: classes });
      offset = end;
    } else {
      const own = node instanceof HTMLElement ? node.className : '';
      for (const child of node.childNodes) walk(child, [classes, own].filter(Boolean).join(' '));
    }
  };
  walk(root, '');
  if (codeTokens.size > 64) codeTokens.clear();
  codeTokens.set(key, tokens);
  return tokens;
}

/* ---------------------------------------------------------- decoration set */

interface ModeState {
  source: boolean;
  focus: boolean;
  typewriter: boolean;
}

const modeField = StateField.define<ModeState>({
  create: () => ({ source: false, focus: false, typewriter: false }),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setSourceMode)) next = { ...next, source: e.value };
      if (e.is(setFocusMode)) next = { ...next, focus: e.value };
      if (e.is(setTypewriter)) next = { ...next, typewriter: e.value };
    }
    return next;
  },
});

function lineStartOffsets(state: EditorState): number[] {
  const offsets = new Array<number>(state.doc.lines + 2);
  for (let i = 1; i <= state.doc.lines; i++) offsets[i] = state.doc.line(i).from;
  offsets[state.doc.lines + 1] = state.doc.length;
  return offsets;
}

const HEADING_RE = /^(#{1,6})\s/;
const QUOTE_RE = /^\s{0,3}>\s?/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s/;
const TASK_RE = /^(\s*)([-*+])\s+\[[ xX]\]\s/;

function headingPrefix(text: string) {
  return (dialect().strictMode ? /^ {0,3}(#{1,6})(?:[ \t]+|$)/ : /^ {0,3}(#{1,6})[ \t]*/).exec(text.replace(/＃/g, '#'));
}

function headingAt(state: EditorState, number: number) {
  const line = state.doc.line(number);
  const prefix = headingPrefix(line.text);
  if (prefix) return { line, level: prefix[1].length, bodyFrom: line.from + prefix[0].length, underline: null };
  const underline = number < state.doc.lines ? state.doc.line(number + 1) : null;
  return line.text.trim() && underline && /^ {0,3}(?:=+|-+)[ \t]*$/.test(underline.text) ?
    { line, level: underline.text.trim()[0] === '=' ? 1 : 2, bodyFrom: line.from, underline } : null;
}

const commitHeading = StateEffect.define<void>();
/** A newly typed ATX heading stays ordinary editable text until the caret leaves
 * its line. Loaded headings and headings already committed never reopen. */
const draftHeadingField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    if (tr.state.field(modeField).source || tr.state.field(preferenceField).liveRenderSource ||
        tr.effects.some(effect => effect.is(commitHeading)) ||
        tr.docChanged && !tr.isUserEvent('input') && !tr.isUserEvent('delete')) return null;
    const selection = tr.newSelection.main, line = tr.newDoc.lineAt(selection.head);
    if (selection.from < line.from || selection.to > line.to) return null;
    if (value !== null && tr.changes.mapPos(value, -1) === line.from) return line.from;
    if (!tr.docChanged || !(tr.isUserEvent('input') || tr.isUserEvent('delete')) || !headingPrefix(line.text) ||
        tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop')) return null;
    const previous = tr.startState.doc.lineAt(tr.changes.invertedDesc.mapPos(line.from, -1));
    if (headingPrefix(previous.text)) return null;
    const block = renderDocumentBlocks(tr.newDoc.toString()).find(block => block.startLine === line.number - 1 && block.kind === 'heading_open');
    return block ? line.from : null;
  },
});

function currentHeading(state: EditorState) {
  const line = state.doc.lineAt(state.selection.main.head);
  if (state.field(draftHeadingField) === line.from) return null;
  const block = renderDocumentBlocks(state.doc.toString()).find((b) => b.kind === 'heading_open' && b.startLine < line.number && b.endLine >= line.number);
  return block ? headingAt(state, block.startLine + 1) : null;
}

function activeLineRange(state: EditorState): [number, number] {
  const sel = state.selection.main;
  const a = state.doc.lineAt(sel.from);
  const b = state.doc.lineAt(sel.to);
  // An empty selection on the boundary line still counts as editing that line.
  return [a.number, b.number];
}

/** Snapshot of the document the current decoration build is based on. */
let docSnapshot = '';

export function getDocSnapshot(): string {
  return docSnapshot;
}

function buildDecorations(state: EditorState, host: EditorHost | null): DecorationSet {
  docSnapshot = state.doc.toString();
  const mode = state.field(modeField);
  const search = searchHighlights(state), searching = !!state.field(searchHighlightField, false)?.selecting;
  if (mode.source) return Decoration.set(search.map(hit => Decoration.mark({ class: searchClass(hit.current) }).range(hit.from, hit.to)), true);

  const items: { from: number; to: number; deco: Decoration }[] = [];
  const text = state.doc.toString();
  const offsets = lineStartOffsets(state);
  const [firstActive, lastActive] = activeLineRange(state);
  const blocks: BlockRange[] = renderDocumentBlocks(text);
  const draftHeading = state.field(draftHeadingField);
  const references = documentReferences(text);
  const codeLines = new Set<number>();
  const headingLines = new Set<number>();
  const structureLines = new Set<number>();
  const selectionActive = (from: number, to: number, bodyFrom = from, bodyTo = from) => {
    const selection = state.selection.main;
    return (!searching && (selection.empty ? selection.head > from && selection.head < to : selection.from < to && selection.to > from)) ||
      searchIntersects(search, from, bodyFrom) || searchIntersects(search, bodyTo, to);
  };
  const inline = (from: number, source: string) => {
    const candidates = inlineImages(source, references);
    const formulas = inlineMathSpans(source).filter(formula => !candidates.some(image => formula.from >= image.from && formula.to <= image.to));
    const images = candidates.filter(image => !formulas.some(formula => image.from >= formula.from && image.to <= formula.to));
    const footnotes = inlineFootnotes(source).filter(note => ![...images, ...formulas].some(range => note.from >= range.from && note.to <= range.to));
    const richRanges = [...images, ...footnotes];
    for (const image of images) {
      const a = from + image.from, b = from + image.to;
      const active = selectionActive(a, b);
      const widget = new ImagePreviewWidget(image.source, a, active, image.image, true);
      if (active) {
        items.push({ from: a, to: b, deco: Decoration.mark({ class: 'cm-inline-image-source' }) });
        items.push({ from: b, to: b, deco: Decoration.widget({ widget, side: 1 }) });
      } else items.push({ from: a, to: b, deco: Decoration.replace({ widget, inclusive: false }) });
    }
    for (const note of footnotes) {
      const a = from + note.from, b = from + note.to;
      const active = selectionActive(a, b);
      if (active) items.push({ from: a, to: b, deco: Decoration.mark({ class: 'cm-md-marker' }) });
      else items.push({ from: a, to: b, deco: Decoration.replace({ widget: new FootnoteReferenceWidget(note.label, a, b), inclusive: false }) });
    }
    const mathSpans = formulas;
    for (const math of mathSpans) {
      if (richRanges.some(range => math.from >= range.from && math.to <= range.to)) continue;
      const a = from + math.from, b = from + math.to;
      const active = selectionActive(a, b);
      if (!active) items.push({ from: a, to: b, deco: Decoration.replace({ widget: new InlineMathWidget(math.tex, a, b), inclusive: false }) });
      else {
        items.push({ from: a, to: a + 1, deco: Decoration.mark({ class: 'cm-md-marker' }) });
        items.push({ from: b - 1, to: b, deco: Decoration.mark({ class: 'cm-md-marker' }) });
        items.push({ from: a + 1, to: b - 1, deco: Decoration.mark({ class: 'cm-md-math-source' }) });
      }
    }
    for (const span of inlineSpans(source)) {
      if (richRanges.some(range => span.from >= range.from && span.to <= range.to)) continue;
      if (mathSpans.some((math) => span.from >= math.from && span.to <= math.to)) continue;
      const active = selectionActive(from + span.from, from + span.to, from + span.bodyFrom, from + span.bodyTo);
      if (span.bodyTo > span.bodyFrom && span.className) items.push({ from: from + span.bodyFrom, to: from + span.bodyTo,
        deco: Decoration.mark({ class: span.className, attributes: {
          ...(span.href ? { 'data-href': span.href, title: span.href } : {}),
          ...((span.href || span.className === 'cm-md-code') && !state.field(preferenceField).spellcheckForCodeAndLink ? { spellcheck: 'false' } : {}),
        } }) });
      for (const [a, b] of [[span.from, span.bodyFrom], [span.bodyTo, span.to]]) {
        if (a >= b) continue;
        items.push({ from: from + a, to: from + b, deco: active ? Decoration.mark({ class: 'cm-md-marker' }) : Decoration.replace({ inclusive: false }) });
      }
    }
  };

  for (const b of blocks) {
    const startLine = b.startLine + 1;
    const endLine = b.endLine; // exclusive, 1-based
    if (endLine < startLine) continue;

    const active = !(endLine < firstActive || startLine > lastActive) || searchIntersects(search, offsets[startLine], state.doc.line(endLine).to);
    const previous = blocks[blocks.indexOf(b) - 1];
    const previousHeading = previous?.kind === 'heading_open' && headingAt(state, previous.startLine + 1);
    const previousFence = previous && codeFence(state, previous);
    const afterFence = previousFence && !previousFence.empty && !(previousFence.diagram && dialect().diagrams || previousFence.math && dialect().codeBlockMath);
    const afterClass = previousHeading ? ` cm-after-heading-${previousHeading.level}` : previous?.kind === 'paragraph_open' ? ' cm-after-paragraph' :
      previous?.kind === 'blockquote_open' ? ' cm-after-quote' : /^(bullet|ordered)_list_open$/.test(previous?.kind ?? '') ? ' cm-after-list' : afterFence ? ' cm-after-fence' : '';

    if (b.kind === 'table_open') {
      const from = offsets[startLine], to = endLine + 1 < offsets.length ? offsets[endLine + 1] : state.doc.length;
      const source = text.slice(from, to);
      if (parseTable(source)) {
        items.push({ from, to, deco: Decoration.replace({ widget: new TableWidget(source, from, to, references, searchHighlights(state, from, to)), block: true }) });
        continue;
      }
    }

    const heading = b.kind === 'heading_open' && headingAt(state, startLine);
    if (heading && draftHeading === heading.line.from) {
      headingLines.add(startLine);
      const spaced = /[ \t]/.test(heading.line.text.slice(0, heading.bodyFrom - heading.line.from));
      items.push({ from: heading.line.from, to: heading.line.from, deco: Decoration.line({ class: 'cm-paragraph-first cm-paragraph-last' + (spaced ? ` cm-draft-heading-${heading.level}` : '') + afterClass }) });
      if (spaced) items.push({
        from: heading.line.from, to: heading.bodyFrom, deco: Decoration.mark({ class: 'cm-md-marker' }),
      });
      inline(heading.bodyFrom, heading.line.text.slice(heading.bodyFrom - heading.line.from));
      continue;
    }
    if (heading && !(active && state.field(preferenceField).liveRenderSource)) {
      headingLines.add(startLine);
      items.push({ from: heading.line.from, to: heading.line.from, deco: Decoration.line({
        class: `cm-heading cm-header-${heading.level}` + afterClass,
      }) });
      if (heading.bodyFrom > heading.line.from && !searchIntersects(search, heading.line.from, heading.bodyFrom)) items.push({ from: heading.line.from, to: heading.bodyFrom,
        deco: Decoration.replace({ inclusive: false }) });
      if (heading.underline) {
        headingLines.add(heading.underline.number);
        if (!searchIntersects(search, heading.line.to, heading.underline.to)) items.push({ from: heading.line.to, to: heading.underline.to,
          deco: Decoration.replace({ block: true, inclusiveStart: false, inclusiveEnd: true }) });
      }
      inline(heading.bodyFrom, heading.line.text.slice(heading.bodyFrom - heading.line.from));
      continue;
    }

    if (b.kind === 'paragraph_open' || b.kind === 'html_block') {
      const from = offsets[startLine], last = state.doc.line(endLine), source = text.slice(from, last.to);
      const image = standaloneImage(source, references);
      if (image && !state.field(preferenceField).liveRenderSource) {
        if (active) {
          structureLines.add(startLine);
          items.push({ from, to: from, deco: Decoration.line({ class: 'cm-native-image-source cm-paragraph-first' + afterClass }) });
          items.push({ from: last.to, to: last.to, deco: Decoration.widget({ widget: new ImagePreviewWidget(source, from, true, image), block: true, side: 1 }) });
        } else {
          items.push({ from, to: Math.min(last.to + 1, state.doc.length), deco: Decoration.replace({ widget: new ImagePreviewWidget(source, from, false, image), block: true }) });
        }
        continue;
      }
    }

    if (['paragraph_open', 'html_block'].includes(b.kind) && !(active && state.field(preferenceField).liveRenderSource)) {
      const from = offsets[startLine], last = state.doc.line(endLine), source = text.slice(from, last.to);
      if (nativeParagraph(source, true)) {
        items.push({ from, to: from, deco: Decoration.line({ class: 'cm-paragraph-first' + afterClass }) });
        items.push({ from: last.from, to: last.from, deco: Decoration.line({ class: 'cm-paragraph-last' }) });
        inline(from, source); continue;
      }
    }

    if (b.kind === 'footnote_def' || b.kind === 'reference_def') {
      const first = state.doc.line(startLine), match = /^( {0,3}\[\^?)([^\]]+)(\]:[ \t]*)/.exec(first.text);
      if (match && !state.field(preferenceField).liveRenderSource) {
        for (let n = startLine; n <= endLine; n++) {
          const row = state.doc.line(n), prefix = n === startLine ? match[0].length : /^[ \t]*/.exec(row.text)![0].length;
          items.push({ from: row.from, to: row.from, deco: Decoration.line({ class: 'cm-reference-definition' + (n === startLine ? ' cm-paragraph-first' + afterClass : '') }) });
          structureLines.add(n); inline(row.from + prefix, row.text.slice(prefix));
        }
        items.push({ from: first.from, to: first.from + match[1].length, deco: Decoration.mark({ class: 'cm-md-marker' }) });
        items.push({ from: first.from + match[1].length, to: first.from + match[1].length + match[2].length, deco: Decoration.mark({ class: 'cm-reference-label' }) });
        items.push({ from: first.from + match[1].length + match[2].length, to: first.from + match[0].length, deco: Decoration.mark({ class: 'cm-md-marker' }) });
        if (b.kind === 'footnote_def') {
          const reference = inlineFootnotes(text).find(note => note.label === match[2] && !blocks.some(block =>
            ['footnote_def', 'fence', 'code_block'].includes(block.kind) && note.from >= offsets[block.startLine + 1] && note.from < offsets[block.endLine + 1]));
          if (reference) {
            const end = state.doc.line(endLine).to;
            items.push({ from: end, to: end, deco: Decoration.widget({ widget: new FootnoteBackrefWidget(match[2], reference.from), side: 1 }) });
          }
        } else {
          const start = first.from + match[0].length, url = /^(?:<[^>]+>|\S+)/.exec(first.text.slice(match[0].length));
          if (url) items.push({ from: start, to: start + url[0].length, deco: Decoration.mark({ class: 'cm-reference-url' }) });
        }
        continue;
      }
    }

    const rows = !(active && state.field(preferenceField).liveRenderSource) && structureRows(b.kind, text.slice(offsets[startLine], state.doc.line(endLine).to));
    if (rows) {
      const quote = b.kind === 'blockquote_open';
      rows.forEach((row, index) => {
        const from = offsets[startLine] + row.from;
        structureLines.add(startLine + index);
        items.push({ from, to: from, deco: Decoration.line({ class: (quote ? 'cm-native-quote' : 'cm-native-list cm-list-line') +
          (index === 0 ? (quote ? ' cm-native-quote-first' : ' cm-native-list-first') + afterClass : '') +
          (!quote && rows[index + 1]?.marker === '' ? ' cm-native-list-soft' : '') +
          (index === rows.length - 1 ? (quote ? ' cm-native-quote-last' : ' cm-native-list-last') : ''), attributes: { style: `--cm-structure-depth:${row.depth}` } }) });
        if (row.prefix > 0 && !searchIntersects(search, from, from + row.prefix)) items.push({ from, to: from + row.prefix, deco: Decoration.replace({ inclusive: false,
          ...(quote ? {} : { widget: new ListMarkerWidget(row.marker, row.task, from + text.slice(from, from + row.prefix).lastIndexOf('[') + 1) }) }) });
        inline(from + row.prefix, row.body);
      });
      const last = offsets[startLine] + rows[rows.length - 1].to, blockEnd = state.doc.line(endLine).to;
      if (last < blockEnd) items.push({ from: last, to: blockEnd,
        deco: Decoration.replace({ block: true, inclusiveStart: false, inclusiveEnd: true }) });
      continue;
    }

    const fence = codeFence(state, b);
    const preview = fence && (fence.diagram && dialect().diagrams || fence.math && dialect().codeBlockMath);
    if (fence && (!preview || active) && !fence.empty) {
      if (!searchIntersects(search, fence.from, fence.bodyFrom)) items.push({ from: fence.from, to: fence.bodyFrom, deco: Decoration.replace({
        widget: new FenceEdgeWidget(fence, false, false, afterClass), block: true, inclusiveStart: true, inclusiveEnd: false,
      }) });
      if (fence.closed && !searchIntersects(search, fence.bodyTo, fence.to)) items.push({ from: fence.bodyTo, to: fence.to, deco: Decoration.replace({
        widget: new FenceEdgeWidget(fence, true, active), block: true, inclusiveStart: false, inclusiveEnd: true,
      }) });
      const numbered = dialect().fenceLineNumbers || /\b(line[-_]?numbers?|lineno)\b/i.test(fence.info);
      const startAt = Number(fence.info.match(/(?:^|\s)start=?([0-9]+)/i)?.[1] ?? 1);
      const lastBody = fence.closed ? fence.lastLine - 1 : fence.lastLine;
      for (let n = fence.firstLine + 1; n <= lastBody; n++) {
        codeLines.add(n);
        items.push({ from: offsets[n], to: offsets[n], deco: Decoration.line({
          class: 'cm-code-line' + (numbered ? ' cm-code-numbered' : ''),
          attributes: { 'data-code-line': String(startAt + n - fence.firstLine - 1), spellcheck: String(!!state.field(preferenceField).spellcheckForCodeAndLink) },
        }) });
      }
      const lang = fence.lang || dialect().defaultCodeLang;
      for (const token of highlightTokens(text.slice(fence.bodyFrom, fence.bodyTo), lang)) {
        items.push({ from: fence.bodyFrom + token.from, to: fence.bodyFrom + token.to,
          deco: Decoration.mark({ class: token.className }) });
      }
      if (fence.diagram && dialect().diagrams && active) items.push({ from: fence.to, to: fence.to,
        deco: Decoration.widget({ widget: new DiagramPreviewWidget(text.slice(fence.bodyFrom, fence.bodyTo), fence), block: true, side: 1 }) });
      continue;
    }
    if (active && (!fence || (fence.empty && !fence.closed))) {
      // Match the rendered paragraph's complete box, including its margins.
      // Otherwise leaving the paragraph makes all following blocks jump.
      if (b.kind === 'paragraph_open') {
        items.push({ from: offsets[startLine], to: offsets[startLine],
          deco: Decoration.line({ class: 'cm-paragraph-first' + afterClass }) });
        items.push({ from: offsets[endLine], to: offsets[endLine],
          deco: Decoration.line({ class: 'cm-paragraph-last' }) });
      }
      continue;
    }

    const from = offsets[startLine];
    const to = endLine + 1 < offsets.length ? offsets[endLine + 1] : state.doc.length;
    if (from === undefined || from >= to) continue;
    const slice = text.slice(from, to);
    const one = renderOneBlock(slice, host);
    if (!one) continue;
    items.push({
      from,
      to,
      deco: Decoration.replace({
        widget: new BlockWidget(one, b.kind, startLine, startLine),
        block: true,
      }),
    });
  }

  // Line-level styling for the block under the caret (heading sizes, quotes…).
  for (let n = firstActive; n <= lastActive; n++) {
    if (codeLines.has(n) || headingLines.has(n) || structureLines.has(n)) continue;
    const line = state.doc.line(n);
    const cls = lineClass(line.text, mode.focus);
    if (cls) items.push({ from: line.from, to: line.from, deco: Decoration.line({ class: cls }) });
  }

  // Markdown's separating blank lines are already represented by the rendered
  // blocks' spacing. Retaining them as empty CM rows doubles every gap.
  const covered = new Set<number>();
  for (const b of blocks) for (let n = b.startLine + 1; n <= b.endLine; n++) covered.add(n);
  let separatingBlanks = 0;
  for (let n = 1; n < state.doc.lines; n++) {
    if (covered.has(n)) { separatingBlanks = 0; continue; }
    const line = state.doc.line(n);
    if (line.text.trim()) { separatingBlanks = 0; continue; }
    separatingBlanks++;
    // Every additional pair of source breaks represents an empty paragraph.
    if (separatingBlanks % 2 === 0 || (state.selection.main.empty && n === firstActive)) continue;
    items.push({ from: line.from, to: line.to + 1, deco: Decoration.replace({
      block: true, inclusiveStart: true, inclusiveEnd: false,
    }) });
  }

  const tables = blocks.filter(block => block.kind === 'table_open').map(block => ({ from: offsets[block.startLine + 1], to: offsets[block.endLine + 1] ?? state.doc.length }));
  for (const hit of search) {
    let ranges = [{ from: hit.from, to: hit.to }];
    for (const table of tables) ranges = ranges.flatMap(range => range.from >= table.to || range.to <= table.from ? [range] :
      [{ from: range.from, to: Math.min(range.to, table.from) }, { from: Math.max(range.from, table.to), to: range.to }].filter(part => part.from < part.to));
    for (const range of ranges) items.push({ ...range, deco: Decoration.mark({ class: searchClass(hit.current) }) });
  }
  items.sort((a, b) => (a.from - b.from) || (a.to - b.to));
  return Decoration.set(items.map((i) => i.deco.range(i.from, i.to)), true);
}

let blockRenderer: ((src: string) => BlockRange[]) | null = null;
export function setBlockRenderer(fn: (src: string) => BlockRange[]): void {
  blockRenderer = fn;
}
function renderDocumentBlocks(src: string): BlockRange[] {
  if (blockRenderer) return blockRenderer(src);
  return [];
}

let singleRenderer: ((src: string) => string | null) | null = null;
export function setSingleBlockRenderer(fn: (src: string) => string | null): void {
  singleRenderer = fn;
}
function renderOneBlock(src: string, _host: EditorHost | null): string | null {
  return singleRenderer ? singleRenderer(src) : null;
}

function lineClass(src: string, _focus: boolean): string {
  const h = HEADING_RE.exec(src);
  if (h) return `cm-line cm-heading cm-header-${h[1].length}`;
  if (QUOTE_RE.test(src)) return 'cm-line cm-quote-line';
  if (TASK_RE.test(src)) return 'cm-line cm-task-line';
  if (LIST_RE.test(src)) return 'cm-line cm-list-line';
  if (/^\s*(```|~~~)/.test(src)) return 'cm-line cm-fence-line';
  if (/^\s*\|/.test(src)) return 'cm-line cm-table-line';
  if (/^\s*\$/.test(src)) return 'cm-line cm-math-line';
  return '';
}

const decorationField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state, null);
  },
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.effects.length) {
      return buildDecorations(tr.state, null);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const inlineMathTooltip = showTooltip.compute([decorationField], (state) => {
  if (state.field(modeField).source || fences(state).some((fence) => state.selection.main.head >= fence.from && state.selection.main.head <= fence.to)) return null;
  const selection = state.selection.main, line = state.doc.lineAt(selection.head);
  const math = inlineMathSpans(line.text).find((span) => selection.empty ?
    selection.head > line.from + span.from && selection.head < line.from + span.to :
    selection.from < line.from + span.to && selection.to > line.from + span.from);
  if (!math || !nativeParagraph(line.text)) return null;
  return { pos: line.from + math.from, end: line.from + math.to, above: false, arrow: true,
    create(view) {
      const dom = document.createElement('div'); dom.className = 'cm-inline-math-tooltip';
      dom.innerHTML = (view as any).__host?.math(math.tex, false) ?? escapeHtml(math.tex); return { dom };
    } };
});

function fences(state: EditorState): CodeFence[] {
  return renderDocumentBlocks(state.doc.toString()).map((b) => codeFence(state, b))
    .filter((f): f is CodeFence => f !== null);
}

function currentStructure(state: EditorState) {
  const head = state.selection.main.head, line = state.doc.lineAt(head);
  const block = renderDocumentBlocks(state.doc.toString()).find((b) => b.startLine < line.number && b.endLine >= line.number);
  if (!block) return null;
  const first = state.doc.line(block.startLine + 1), last = state.doc.line(block.endLine);
  const rows = structureRows(block.kind, state.sliceDoc(first.from, last.to));
  const row = rows?.[line.number - first.number];
  return row ? { from: line.from, bodyFrom: line.from + row.prefix } : null;
}

/** Keep collapsed cursors off the hidden delimiter rows. Expanded selections
 * remain untouched so selecting/copying the whole Markdown still works. */
const fenceSelection = EditorState.transactionFilter.of((tr) => {
  if (tr.state.field(modeField).source || !tr.newSelection.main.empty) return tr;
  const head = tr.newSelection.main.head;
  const structure = !tr.state.field(preferenceField).liveRenderSource && currentStructure(tr.state);
  if (structure && head < structure.bodyFrom) return [tr, { selection: EditorSelection.cursor(structure.bodyFrom), sequential: true }];
  const heading = currentHeading(tr.state);
  if (heading?.underline && head > heading.line.to && !tr.state.field(preferenceField).liveRenderSource) return [tr, {
    selection: EditorSelection.cursor(heading.line.to), sequential: true,
  }];
  if (heading && !tr.state.field(preferenceField).liveRenderSource && head < heading.bodyFrom) return [tr, {
    selection: EditorSelection.cursor(heading.bodyFrom), sequential: true,
  }];
  const fence = fences(tr.state).find((f) => head >= f.from && head <= f.to);
  if (!fence || (!fence.empty && head >= fence.bodyFrom && head <= fence.bodyTo)) return tr;
  if (fence.empty) {
    if (!fence.closed) return tr; // Let the user finish typing the language.
    return [tr, { changes: { from: fence.bodyFrom, insert: '\n' },
      selection: { anchor: fence.bodyFrom + 1 }, sequential: true }];
  }
  const previous = tr.changes.mapPos(tr.startState.selection.main.head);
  const wasInside = previous >= fence.bodyFrom && previous <= fence.bodyTo;
  let pos: number;
  if (wasInside) {
    pos = head < fence.bodyFrom ? Math.max(0, fence.from - 1) : Math.min(tr.newDoc.length, fence.to + 1);
    // At a document edge there is no neighbouring paragraph yet.
    if (pos >= fence.from && pos <= fence.to) pos = head < fence.bodyFrom ? fence.bodyFrom : fence.bodyTo;
  } else pos = head <= fence.bodyFrom ? fence.bodyFrom : fence.bodyTo;
  return [tr, { selection: EditorSelection.cursor(pos), sequential: true }];
});

function currentFence(view: EditorView): CodeFence | undefined {
  if (view.state.field(modeField).source) return undefined;
  const sel = view.state.selection.main;
  return fences(view.state).find((f) => !f.empty && sel.from >= f.bodyFrom && sel.to <= f.bodyTo);
}

function leaveFence(view: EditorView, fence: CodeFence, forward: boolean): boolean {
  let pos = forward ? fence.to + 1 : fence.from - 1;
  if (pos > view.state.doc.length) {
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\n' },
      selection: { anchor: view.state.doc.length + 2 }, userEvent: 'input' });
  } else if (pos < 0) {
    view.dispatch({ changes: { from: 0, insert: '\n\n' }, selection: { anchor: 0 }, userEvent: 'input' });
  } else view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  return true;
}

const fenceKeymap = keymap.of([
  { key: 'Shift-Enter', run(view) {
    if (view.state.field(modeField).source) return false;
    const state = view.state, sel = state.selection.main, line = state.doc.lineAt(sel.from);
    const block = renderDocumentBlocks(state.doc.toString()).find((b) => b.startLine < line.number && b.endLine >= line.number);
    let continuation = '';
    if (currentFence(view)) continuation = /^\s*/.exec(line.text)![0];
    else if (block?.kind === 'blockquote_open') continuation = /^(?: {0,3}>[ \t]?)+/.exec(line.text)?.[0] || '';
    else if (/^(bullet|ordered)_list_open$/.test(block?.kind || '')) {
      const prefix = /^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/.exec(line.text);
      continuation = prefix ? prefix[0].replace(/[^\t]/g, ' ') : /^[ \t]*/.exec(line.text)![0];
    } else if (block && !['paragraph_open', 'heading_open'].includes(block.kind)) return false;
    const insert = '\n' + continuation;
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + insert.length }, userEvent: 'input' });
    return true;
  } },
  { key: 'Backspace', run(view) {
    const state = view.state, sel = state.selection.main, prefs = state.field(preferenceField);
    if (!sel.empty || !sel.head) return false;
    const pair = state.sliceDoc(sel.head - 1, sel.head + 1);
    const allowed = (prefs.autoPairBrackets ? ['()', '[]', '{}', '\"\"', "''", '“”', '‘’'] : [])
      .concat(prefs.autoPairMarkdownSyntax ? ['**', '__', '~~', '``', '$$'] : []);
    if (!allowed.includes(pair)) return false;
    view.dispatch({ changes: { from: sel.head - 1, to: sel.head + 1, insert: '' }, selection: { anchor: sel.head - 1 }, userEvent: 'delete.backward' }); return true;
  } },
  { key: 'Backspace', run(view) {
    if (view.state.field(modeField).source || !view.state.selection.main.empty) return false;
    const heading = currentHeading(view.state);
    if (!heading || view.state.field(preferenceField).liveRenderSource || view.state.selection.main.head !== heading.bodyFrom) return false;
    view.dispatch({ changes: heading.underline ? { from: heading.line.to, to: heading.underline.to, insert: '' } : { from: heading.line.from, to: heading.bodyFrom, insert: '' },
      selection: { anchor: heading.line.from }, userEvent: 'delete.backward' });
    return true;
  } },
  ...(['Backspace', 'Delete'] as const).map((key) => ({ key, run(view: EditorView) {
    const state = view.state, sel = state.selection.main;
    if (state.field(modeField).source || !sel.empty || currentFence(view)) return false;
    const line = state.doc.lineAt(sel.head), backward = key === 'Backspace';
    if (sel.head !== (backward ? line.from : line.to)) return false;
    const from = backward ? sel.head - 2 : sel.head, to = from + 2;
    if (from < 0 || to > state.doc.length || state.sliceDoc(from, to) !== '\n\n') return false;
    const blocks = renderDocumentBlocks(state.doc.toString());
    const before = state.doc.lineAt(from), after = state.doc.lineAt(to);
    const left = blocks.find((b) => b.startLine < before.number && b.endLine >= before.number);
    const right = blocks.find((b) => b.startLine < after.number && b.endLine >= after.number);
    if (left && left.kind !== 'paragraph_open' || right && right.kind !== 'paragraph_open') return false;
    view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from }, userEvent: backward ? 'delete.backward' : 'delete.forward' }); return true;
  } })),
  { key: 'ArrowLeft', run(view) {
    if (view.state.field(modeField).source || !view.state.selection.main.empty) return false;
    const structure = !view.state.field(preferenceField).liveRenderSource && currentStructure(view.state);
    if (structure && view.state.selection.main.head === structure.bodyFrom) {
      if (structure.from > 0) view.dispatch({ selection: { anchor: structure.from - 1 }, scrollIntoView: true });
      return true;
    }
    const heading = currentHeading(view.state);
    if (!heading || view.state.selection.main.head !== heading.bodyFrom) return false;
    if (heading.line.from > 0) view.dispatch({ selection: { anchor: heading.line.from - 1 }, scrollIntoView: true });
    return true;
  } },
  { key: 'ArrowRight', run(view) {
    if (view.state.field(modeField).source || !view.state.selection.main.empty) return false;
    const heading = currentHeading(view.state);
    if (!heading?.underline || view.state.selection.main.head !== heading.line.to) return false;
    const next = heading.underline.to < view.state.doc.length ? heading.underline.to + 1 : heading.underline.to + 2;
    view.dispatch({ ...(heading.underline.to === view.state.doc.length ? { changes: { from: heading.underline.to, insert: '\n\n' } } : {}),
      selection: { anchor: next }, scrollIntoView: true }); return true;
  } },
  { key: 'Enter', run(view) {
    if (view.state.field(modeField).source) return false;
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.head);
    const heading = currentHeading(view.state);
    if (heading?.underline && sel.from >= heading.bodyFrom && sel.to <= heading.line.to) {
      if (sel.empty && sel.head === heading.bodyFrom) {
        view.dispatch({ changes: { from: heading.line.from, insert: '\n\n' }, selection: { anchor: heading.bodyFrom + 2 }, userEvent: 'input' });
      } else {
        const separator = '\n' + heading.underline.text + '\n\n';
        view.dispatch({ changes: { from: sel.from, to: heading.underline.to, insert: separator + view.state.sliceDoc(sel.to, heading.line.to) },
          selection: { anchor: sel.from + separator.length }, userEvent: 'input' });
      }
      return true;
    }
    if (sel.empty && /^ {0,3}(`{3,}|~{3,})[^`~]*$/.test(line.text) && sel.head === line.to &&
        !currentFence(view)) {
      const marker = line.text.match(/`{3,}|~{3,}/)![0];
      const prefs = view.state.field(preferenceField);
      const language = !line.text.slice(line.text.indexOf(marker) + marker.length).trim() && prefs.fenceLangWhen !== 'menubar' ? String(prefs.defaultCodeLang || '') : '';
      view.dispatch({ changes: { from: line.to, insert: language + '\n\n' + marker },
        selection: { anchor: line.to + language.length + 1 }, userEvent: 'input' });
      return true;
    }
    const fence = currentFence(view);
    if (!fence) {
      const block = renderDocumentBlocks(view.state.doc.toString()).find((b) => b.startLine < line.number && b.endLine >= line.number);
      if (sel.empty && sel.head === line.to && (!block || block.kind === 'paragraph_open') && /^ {0,3}\|.+\|[ \t]*$/.test(line.text)) {
        const table = tableFromHeader(line.text);
        if (table) {
          const from = line.from, insert = serializeTable(table);
          view.dispatch({ changes: { from, to: line.to, insert }, selection: { anchor: from }, userEvent: 'input' });
          queueMicrotask(() => {
            const root = Array.from(view.dom.querySelectorAll<HTMLElement>('.md-table-widget')).find((node) => Number(node.dataset.from) === from);
            root?.querySelector<HTMLElement>('[data-row="1"][data-col="0"]')?.focus();
          }); return true;
        }
      }
      const prefix = /^([ \t]*)(?:(?:(\d+)([.)])|([-*+]))[ \t]+(?:\[[ xX]\][ \t]+)?|(?:>[ \t]?)+)/.exec(line.text);
      if (!prefix || sel.to > line.to || sel.from < line.from + prefix[0].length) {
        if (sel.empty && /^(bullet|ordered)_list_open$/.test(block?.kind || '')) {
          for (let n = line.number - 1; n > block!.startLine; n--) {
            const earlier = view.state.doc.line(n), marker = /^([ \t]*)([-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/.exec(earlier.text);
            if (!marker) continue;
            let next = marker[0].replace(/\[[xX]\]/, '[ ]');
            if (/^\d/.test(marker[2]) && view.state.field(preferenceField).orderedDelimiter !== 'repeat') next = marker[1] + (Number(marker[2].slice(0, -1)) + 1) + marker[2].slice(-1) + next.slice(marker[1].length + marker[2].length);
            view.dispatch({ changes: { from: sel.from, insert: '\n' + next }, selection: { anchor: sel.from + 1 + next.length }, userEvent: 'input' }); return true;
          }
        }
        if (block && !['paragraph_open', 'heading_open'].includes(block.kind)) return false;
        const from = heading && sel.empty && sel.head === heading.bodyFrom ? heading.line.from : sel.from;
        view.dispatch({ changes: { from, to: sel.empty ? from : sel.to, insert: '\n\n' },
          selection: { anchor: from + 2 }, userEvent: 'input' }); return true;
      }
      if (sel.empty && !line.text.slice(prefix[0].length).trim()) {
        const quote = prefix[0].includes('>');
        const outer = quote ? prefix[0].slice(0, prefix[0].lastIndexOf('>')) : prefix[1];
        const insert = (quote ? outer.trimEnd() : outer) + '\n' + outer;
        view.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + insert.length },
          annotations: isolateHistory.of('full'), userEvent: 'input' }); return true;
      }
      let next = prefix[0].replace(/\[[xX]\]/, '[ ]');
      if (prefix[2] && view.state.field(preferenceField).orderedDelimiter !== 'repeat') next = prefix[1] + (Number(prefix[2]) + 1) + prefix[3] + next.slice(prefix[1].length + prefix[2].length + 1);
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: '\n' + next }, selection: { anchor: sel.from + 1 + next.length },
        annotations: isolateHistory.of('full'), userEvent: 'input' }); return true;
    }
    const indent = /^\s*/.exec(line.text.slice(0, sel.from - line.from))![0];
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: '\n' + indent },
      selection: { anchor: sel.from + 1 + indent.length }, userEvent: 'input' });
    return true;
  } },
  ...(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const).map((key) => ({ key, run(view: EditorView) {
    const sel = view.state.selection.main;
    const fence = currentFence(view);
    if (!fence || !sel.empty) return false;
    const forward = key === 'ArrowRight' || key === 'ArrowDown';
    const next = key === 'ArrowUp' || key === 'ArrowDown'
      ? view.moveVertically(sel, forward).head : sel.head + (forward ? 1 : -1);
    return next < fence.bodyFrom || next > fence.bodyTo || next === sel.head
      ? leaveFence(view, fence, forward) : false;
  } })),
  { key: 'Backspace', run(view) {
    const fence = currentFence(view);
    if (fence && fence.bodyFrom === fence.bodyTo && view.state.selection.main.empty) {
      view.dispatch({ changes: { from: fence.from, to: fence.to, insert: '' },
        selection: { anchor: fence.from }, userEvent: 'delete.backward' });
      return true;
    }
    return !!fence && view.state.selection.main.empty && view.state.selection.main.head === fence.bodyFrom;
  } },
  { key: 'Delete', run(view) {
    const fence = currentFence(view);
    return !!fence && view.state.selection.main.empty && view.state.selection.main.head === fence.bodyTo;
  } },
  { key: 'Mod-a', run: selectCode },
  { key: 'Shift-Tab', run: (view) => changeIndent(view, true) },
  { key: 'Tab', run: (view) => changeIndent(view, false) },
  { key: 'Backspace', run(view) {
    const sel = view.state.selection.main; if (!sel.empty || view.state.field(modeField).source || currentFence(view)) return false;
    const line = view.state.doc.lineAt(sel.head), prefix = /^(?:[ \t]*(?:[-*+][ \t]+|\d+[.)][ \t]+)(?:\[[ xX]\][ \t]+)?| {0,3}(?:>[ \t]?)+)/.exec(line.text);
    if (!prefix || sel.head !== line.from + prefix[0].length) return false;
    const block = renderDocumentBlocks(view.state.doc.toString()).find(block => /^(bullet|ordered)_list_open$/.test(block.kind) && block.startLine < line.number && block.endLine >= line.number);
    if (block && backspaceListItem(view, block)) return true;
    const insert = prefix[0].includes('>') ? prefix[0].slice(0, prefix[0].lastIndexOf('>')) : '';
    view.dispatch({ changes: { from: line.from, to: sel.head, insert }, selection: { anchor: line.from + insert.length },
      annotations: isolateHistory.of('full'), userEvent: 'delete.backward' }); return true;
  } },
]);

function changeIndent(view: EditorView, reverse: boolean): boolean {
  const state = view.state, prefs = state.field(preferenceField), sel = state.selection.main;
  const fence = currentFence(view);
  if (!fence && !state.field(modeField).source) {
    const number = state.doc.lineAt(sel.from).number;
    const block = renderDocumentBlocks(state.doc.toString()).find(block => /^(bullet|ordered)_list_open$/.test(block.kind) && block.startLine < number && block.endLine >= number);
    if (block && indentListItem(view, block, reverse, prefs.indentSize === 'tab')) return true;
  }
  if (reverse && fence && prefs.fenceShiftTabIndent) {
    view.dispatch({ changes: { from: fence.bodyFrom, to: fence.bodyTo,
      insert: reindentCode(state.sliceDoc(fence.bodyFrom, fence.bodyTo), fence.lang, Number(prefs.codeIndentSize || 4)) }, userEvent: 'input' }); return true;
  }
  const width = Math.max(1, Math.min(8, Number(currentFence(view) ? prefs.codeIndentSize || 4 : prefs.indentSize || 4) || 4));
  const unit = prefs.indentSize === 'tab' && !currentFence(view) ? '\t' : ' '.repeat(width);
  if (sel.empty && !reverse) {
    view.dispatch({ changes: { from: sel.head, insert: unit }, selection: { anchor: sel.head + unit.length }, userEvent: 'input' }); return true;
  }
  const changes = [];
  const end = !sel.empty && sel.to === state.doc.lineAt(sel.to).from ? sel.to - 1 : sel.to;
  for (let number = state.doc.lineAt(sel.from).number; number <= state.doc.lineAt(end).number; number++) {
    const line = state.doc.line(number), prefix = new RegExp('^(?:\\t| {1,' + width + '})').exec(line.text)?.[0];
    if (!reverse || prefix) changes.push({ from: line.from, to: line.from + (reverse ? prefix!.length : 0), insert: reverse ? '' : unit });
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'input' }); return true;
}

const pairInput = EditorView.inputHandler.of((view, from, to, text) => {
  if (text.length !== 1 || view.composing) return false;
  const prefs = view.state.field(preferenceField), doc = view.state.doc;
  const before = doc.sliceString(Math.max(0, from - 1), from), after = doc.sliceString(to, to + 1);
  const inCode = !!currentFence(view);
  const line = doc.lineAt(from), prefix = doc.sliceString(line.from, from);
  const block = renderDocumentBlocks(doc.toString()).find((b) => b.startLine < line.number && b.endLine >= line.number);
  const special = block?.kind === 'meta_block' || block?.kind === 'math_block' || (prefix.match(/(?<!\\)\$/g)?.length || 0) % 2 === 1 || (prefix.match(/(?<!\\)`/g)?.length || 0) % 2 === 1;
  if (!view.state.field(modeField).source && !inCode && !special && before !== '\\' && prefs.smartPunctuation === 'input') {
    if (prefs.smartQuotes && ['\"', "'"].includes(text)) {
      const pattern = String((text === '\"' ? prefs.smartDoubleQuoteStyle : prefs.smartSingleQuoteStyle) || (text === '\"' ? '“abc”' : '‘abc’')).split('abc');
      const opening = pattern[0], closing = pattern[1];
      if (from === to && doc.sliceString(to, to + closing.length) === closing) { view.dispatch({ selection: { anchor: to + closing.length } }); return true; }
      const start = !before || /[\s([{>]/.test(before);
      const insertion = start ? opening + (prefs.autoPairBrackets ? doc.sliceString(from, to) + closing : '') : closing;
      view.dispatch({ changes: { from, to, insert: insertion }, selection: { anchor: from + (start ? opening.length : closing.length) }, userEvent: 'input' }); return true;
    }
    if (prefs.smartDash && from === to) {
      const dots = text === '.' && doc.sliceString(Math.max(0, from - 2), from) === '..';
      if (dots || text === '-' && ['-', '–', '—'].includes(before)) {
        const start = from - (dots ? 2 : 1), insertion = dots ? '…' : before === '-' && !/Mac/i.test(navigator.platform) ? '–' : '—';
        view.dispatch({ changes: { from: start, to, insert: insertion }, selection: { anchor: start + 1 }, userEvent: 'input' }); return true;
      }
    }
  }
  const pairs: Record<string, string> = {};
  if (prefs.autoPairBrackets) Object.assign(pairs, { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" });
  if (prefs.autoPairMarkdownSyntax && !inCode) Object.assign(pairs, { '*': '*', '_': '_', '~': '~', '`': '`', '$': '$' });
  // Leave opening list/fence syntax available without generating a closing
  // delimiter into the unfinished block.
  if (/^[`~*]*$/.test(prefix) && /^[`~*]$/.test(text)) return false;
  if (from === to && after === text && Object.values(pairs).includes(text)) {
    view.dispatch({ selection: { anchor: to + 1 } }); return true;
  }
  const closing = pairs[text]; if (!closing || (from === to && /[\w]/.test(after))) return false;
  if ((text === "'" || text === '_') && /\w/.test(before)) return false;
  const selected = doc.sliceString(from, to);
  view.dispatch({ changes: { from, to, insert: text + selected + closing }, selection: { anchor: from + 1, head: from + 1 + selected.length }, userEvent: 'input' });
  return true;
});

function selectCode(view: EditorView): boolean {
  const fence = currentFence(view);
  if (!fence) return false;
  const sel = view.state.selection.main;
  if (sel.from === fence.bodyFrom && sel.to === fence.bodyTo) return false;
  view.dispatch({ selection: { anchor: fence.bodyFrom, head: fence.bodyTo } });
  return true;
}

/* ----------------------------------------------------------------- editor */

export interface EditorOptions {
  parent: HTMLElement;
  doc: string;
  host: EditorHost;
  onChange: () => void;
  onCursor?: (line: number, column: number, selectedWords: number) => void;
  preferences?: Record<string, any>;
}

export class DocEditor {
  readonly view: EditorView;
  private host: EditorHost;
  private source = false;
  private history = new Compartment();
  private imageContext: ImageSourceRange | null = null;
  private headingStyle = document.createElement('style');
  private disposeWindowFocus = () => {};

  constructor(opts: EditorOptions) {
    this.host = opts.host;
    const state = EditorState.create({
      doc: opts.doc,
      selection: { anchor: /^ {0,3}#{1,6}(?:[ \t]+|$)/.exec(opts.doc.split('\n')[0])?.[0].length ?? 0 },
      extensions: [
        this.history.of(history()),
        drawSelection(),
        rectangularSelection(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.compute([preferenceField], (state) => ({ spellcheck: String(state.field(preferenceField).spellCheck !== false) })),
        EditorView.editorAttributes.of((view) => {
          const mode = view.state.field(modeField), prefs = view.state.field(preferenceField);
          return { class: 'aropyt-document-editor' + (mode.source ? ' mode-source' : '') + (mode.focus ? ' mode-focus' : '') +
            (mode.typewriter ? ' mode-typewriter' : '') + (prefs.fenceAutoWrap === false ? ' no-code-wrap' : ''),
            style: '--code-tab-size:' + (Number(prefs.codeIndentSize) || 4), 'data-spellcheck-code': String(!!prefs.spellcheckForCodeAndLink) };
        }),
        preferenceField.init(() => ({ ...opts.preferences })),
        modeField,
        draftHeadingField,
        fenceSelection,
        searchHighlightField,
        decorationField,
        inlineMathTooltip,
        footnotePreview,
        EditorView.updateListener.of((u: ViewUpdate) => {
          if (u.docChanged) opts.onChange();
          if (u.selectionSet || u.docChanged) this.emitCursor();
        }),
        EditorView.domEventHandlers({
          mousedown: (event, view) => this.handleWidgetClick(event, view),
          blur: (_event, view) => {
            if (view.state.field(draftHeadingField) !== null) view.dispatch({ effects: commitHeading.of() });
          },
          copy: (event) => this.copy(event, false),
          cut: (event) => this.copy(event, true),
        }),
        EditorView.theme({
          '&': { height: '100%' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit', lineHeight: 'inherit' },
          '.cm-content': { caretColor: 'var(--text-color, #333)' },
          '.cm-line': { padding: '0' },
          '&.cm-focused': { outline: 'none' },
        }),
        fenceKeymap,
        pairInput,
        keymap.of([
          ...defaultKeymap.filter((b) => !['Mod-z', 'Mod-y', 'Mod-Shift-z'].includes(b.key ?? '')),
          ...historyKeymap,
          indentWithTab,
        ]),
      ],
    });
    this.view = new EditorView({ state, parent: opts.parent });
    document.head.append(this.headingStyle);
    this.syncHeadingStyles();
    (this.view as unknown as { __host: EditorHost }).__host = opts.host;
    this.updateModeClass();
    this.focusLoop();
    this.preserveWindowFocus();
  }

  private preserveWindowFocus(): void {
    if (!/Linux/i.test(navigator.platform)) return;
    const doc = this.view.dom.ownerDocument, win = doc.defaultView!;
    let restore = false;
    const blur = () => {
      if (doc.hasFocus() || doc.activeElement !== this.view.contentDOM) return;
      // CodeMirror also synchronizes the DOM selection in inactive windows.
      // On GTK/X11 that claims PRIMARY and collapses the foreground input's
      // selection. Keep the model range and restore native focus on activation.
      restore = true;
      this.view.contentDOM.blur();
    };
    const focus = () => {
      const shouldRestore = restore && doc.activeElement === doc.body;
      restore = false;
      if (shouldRestore) this.view.focus();
    };
    win.addEventListener('blur', blur);
    win.addEventListener('focus', focus);
    this.disposeWindowFocus = () => {
      win.removeEventListener('blur', blur);
      win.removeEventListener('focus', focus);
    };
  }

  private focusLoop(): void {
    this.view.dom.addEventListener('keydown', () => {
      if (this.view.state.field(modeField).typewriter && this.view.state.field(preferenceField).typewriterKeepCaret !== false) {
        requestAnimationFrame(() => {
          this.view.dispatch({ effects: EditorView.scrollIntoView(this.view.state.selection.main.head, { y: 'center' }) });
        });
      }
    });
  }

  imageAt(target: HTMLElement): ImageSourceRange | null {
    if (target.closest('.md-table-widget')) {
      const range = tableImageAt(this.view, target);
      return this.imageContext = range && standaloneImage(range.source, documentReferences(this.value)) ? range : null;
    }
    const view = this.view, root = target.closest<HTMLElement>('.cm-image-preview');
    const line = target?.closest<HTMLElement>('.cm-native-image-source,.cm-inline-image-source');
    if (!root && !line) return null;
    const row = !root && line ? view.state.doc.lineAt(view.posAtDOM(line)) : null;
    const range = row && line?.classList.contains('cm-inline-image-source') ? inlineImages(row.text, documentReferences(this.value)).find(image =>
      row.from + image.from === view.posAtDOM(line)) : null;
    const from = root ? Number(root.dataset.from) : row!.from + (range?.from || 0), to = root ? Number(root.dataset.to) : range ? row!.from + range.to : row!.to;
    const source = view.state.sliceDoc(from, to);
    if (!standaloneImage(source, documentReferences(this.value))) return null;
    return this.imageContext = { from, to, source };
  }

  handleImageAction(action: string): boolean {
    if (!action.startsWith('image:')) return false;
    const context = this.imageContext; if (!context) return true;
    const source = transformImage(context.source, action, documentReferences(this.value)); if (source === null) return true;
    this.replaceImage(context, source, true); return true;
  }

  replaceImage(context: ImageSourceRange, source: string, focus = false): boolean {
    if (context.from < 0 || context.to > this.value.length || context.to < context.from ||
        this.view.state.sliceDoc(context.from, context.to) !== (context.rawSource ?? context.source)) return false;
    // Table delimiters must remain syntax-safe, including pipes inside HTML
    // attributes. Entities preserve their value without changing nearby cells.
    const insert = source === context.source ? context.rawSource ?? source : context.table ? source.replace(/\|/g, '&#124;') : source;
    if (insert !== (context.rawSource ?? context.source)) this.view.dispatch({ changes: { from: context.from, to: context.to, insert },
      ...(focus ? { selection: { anchor: context.from, head: context.from + insert.length } } : {}), userEvent: 'input' });
    this.imageContext = { ...context, to: context.from + insert.length, source, rawSource: context.table ? insert : undefined };
    if (focus && (!context.table || !focusTableRange(this.view, context.from, context.from + insert.length, context.cell))) this.view.focus();
    return true;
  }

  private handleWidgetClick(event: MouseEvent, view: EditorView): boolean {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.md-table-widget, .cm-code-language-shell')) return false;
    const backref = target?.closest<HTMLElement>('.cm-footnote-backref');
    if (backref) {
      if (event.button !== 0) return false;
      event.preventDefault(); view.dispatch({ selection: { anchor: Number(backref.dataset.from) }, scrollIntoView: true }); view.focus(); return true;
    }
    const note = target?.closest<HTMLElement>('.cm-inline-footnote');
    if (note) {
      if (event.button !== 0) return false;
      event.preventDefault(); view.dispatch({ selection: { anchor: Number(note.dataset.from) + 2, head: Number(note.dataset.to) - 1 } }); view.focus(); return true;
    }
    const math = target?.closest<HTMLElement>('.cm-inline-math-widget');
    if (math) {
      event.preventDefault(); view.dispatch({ selection: { anchor: Number(math.dataset.from) + 1, head: Number(math.dataset.to) - 1 } }); view.focus(); return true;
    }
    const image = target?.closest<HTMLElement>('.cm-image-preview');
    if (image) {
      if (event.button !== 0) return false;
      const from = Number(image.dataset.from);
      event.preventDefault(); view.dispatch({ selection: { anchor: from + Number(image.dataset.selectionFrom), head: from + Number(image.dataset.selectionTo) }, scrollIntoView: true }); view.focus(); return true;
    }
    const inlineLink = target?.closest<HTMLElement>('[data-href]');
    if (inlineLink && (event.metaKey || event.ctrlKey)) {
      event.preventDefault(); void (window as any).JSBridge?.invoke('shell.openExternal', inlineLink.dataset.href); return true;
    }
    const widget = target?.closest('.md-block-widget') as HTMLElement | null;
    if (widget) {
      const line = Number(widget.dataset.line || '1');
      const clamped = Math.min(Math.max(1, line), view.state.doc.lines);
      const block = renderDocumentBlocks(view.state.doc.toString()).find((b) => b.startLine === clamped - 1);
      if (target?.matches('input[type="checkbox"]') && block) {
        const index = Array.from(widget.querySelectorAll('input[type="checkbox"]')).indexOf(target);
        const tasks = [];
        for (let n = block.startLine + 1; n <= block.endLine; n++) {
          const row = view.state.doc.line(n), match = /^(\s*[-*+]\s+\[)([ xX])\]/.exec(row.text);
          if (match) tasks.push({ row, match });
        }
        const task = tasks[index];
        if (task) {
          const from = task.row.from + task.match[1].length; event.preventDefault();
          view.dispatch({ changes: { from, to: from + 1, insert: task.match[2] === ' ' ? 'x' : ' ' }, userEvent: 'input' }); return true;
        }
      }
      const fence = block && codeFence(view.state, block);
      const pos = fence ? fence.bodyFrom : view.state.doc.line(clamped).from;
      event.preventDefault();
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
      return true;
    }
    const link = target?.closest('a') as HTMLAnchorElement | null;
    if (link) {
      const href = link.getAttribute('href') || '';
      if (/^https?:/i.test(href)) {
        event.preventDefault();
        (window as any).JSBridge?.invoke('shell.openExternal', href);
        return true;
      }
      if (href.startsWith('#')) {
        event.preventDefault();
        const el = view.contentDOM.querySelector(`[id="${CSS.escape(href.slice(1))}"]`);
        if (el) el.scrollIntoView({ block: 'start' });
        return true;
      }
    }
    return false;
  }

  private emitCursor(): void {
    const sel = this.view.state.selection.main;
    const line = this.view.state.doc.lineAt(sel.head);
    const col = sel.head - line.from + 1;
    const selectedWords = sel.empty ? 0 : this.view.state.doc.sliceString(sel.from, sel.to).trim().split(/\s+/).filter(Boolean).length;
    this.onCursor?.(line.number, col, selectedWords);
  }

  private copy(event: ClipboardEvent, cut: boolean): boolean {
    if (!event.clipboardData) return false;
    this.syncNativeSelection();
    const state = this.view.state, sel = state.selection.main, prefs = state.field(preferenceField);
    if (sel.empty && prefs.lineWiseCopyCut === false) { event.preventDefault(); return true; }
    const line = state.doc.lineAt(sel.head), from = sel.empty ? line.from : sel.from,
      to = sel.empty ? Math.min(state.doc.length, line.to + 1) : sel.to;
    const source = state.sliceDoc(from, to), code = !!currentFence(this.view);
    const raw = state.field(modeField).source || prefs.copyMarkdownAsPlain || code || prefs.mathCopyFormat === 'latex' && /^\$/.test(source);
    event.clipboardData.setData('text/plain', raw ? source : plainText(source));
    if (!raw) event.clipboardData.setData('text/html', renderDocument(source, { math: this.host.math, resolveSrc: this.host.resolveSrc }).html);
    event.preventDefault();
    if (cut && from < to) this.view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from }, userEvent: 'delete.cut' });
    return true;
  }

  private onCursor?: (line: number, column: number, selectedWords: number) => void;

  setCursorListener(fn: (line: number, column: number, selectedWords: number) => void): void {
    this.onCursor = fn;
  }

  get value(): string {
    return this.view.state.doc.toString();
  }

  /** Replace the active document without retaining the previous file's undo/redo. */
  loadDocument(text: string): void {
    this.imageContext = null;
    // Removing the history field discards both branches while leaving modes,
    // preferences and all other editor extensions in place.
    this.view.dispatch({ effects: this.history.reconfigure([]) });
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor: 0 },
      effects: this.history.reconfigure(history()),
      annotations: Transaction.addToHistory.of(false),
      scrollIntoView: true,
    });
  }

  setValue(text: string, keepCursor = false): void {
    this.imageContext = null;
    const pos = keepCursor ? Math.min(this.view.state.selection.main.head, text.length) : 0;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor: pos },
    });
  }

  focus(): void {
    this.view.focus();
  }

  /** Native accessibility APIs can update Blink's selection before CodeMirror
   * observes it. Menu and clipboard commands must use that visible selection. */
  syncNativeSelection(): void {
    const selection = window.getSelection();
    if (!selection?.anchorNode || !selection.focusNode || !this.view.contentDOM.contains(selection.anchorNode) || !this.view.contentDOM.contains(selection.focusNode)) return;
    const inWidget = (node: Node) => (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest('.md-block-widget, .md-table-widget, [contenteditable="false"]');
    if (inWidget(selection.anchorNode) || inWidget(selection.focusNode)) return;
    const anchor = this.view.posAtDOM(selection.anchorNode, selection.anchorOffset), head = this.view.posAtDOM(selection.focusNode, selection.focusOffset);
    const current = this.view.state.selection.main;
    if (current.anchor !== anchor || current.head !== head) this.view.dispatch({ selection: { anchor, head } });
  }

  selectAll(): void {
    if (!selectCode(this.view)) this.view.dispatch({ selection: { anchor: 0, head: this.view.state.doc.length } });
  }

  setSourceMode(on: boolean): void {
    this.source = on;
    this.view.dispatch({ effects: setSourceMode.of(on) });
    this.updateModeClass();
  }

  get isSourceMode(): boolean {
    return this.source;
  }

  setFocusMode(on: boolean): void {
    this.view.dispatch({ effects: setFocusMode.of(on) });
    this.updateModeClass();
  }

  setTypewriterMode(on: boolean): void {
    this.view.dispatch({ effects: setTypewriter.of(on) });
    this.updateModeClass();
  }

  private updateModeClass(): void {
    const m = this.view.state.field(modeField);
    this.view.dom.classList.toggle('mode-source', m.source);
    this.view.dom.classList.toggle('mode-focus', m.focus);
    this.view.dom.classList.toggle('mode-typewriter', m.typewriter);
  }

  scrollToLine(line: number): void {
    const clamped = Math.min(Math.max(1, line + 1), this.view.state.doc.lines);
    const pos = this.view.state.doc.line(clamped).from;
    this.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    this.view.focus();
  }

  /** Line range [from,to) of the block containing the caret, in lines. */
  activeBlockLines(): [number, number] {
    return activeLineRange(this.view.state);
  }

  refreshDecorations(): void {
    this.syncHeadingStyles();
    this.view.dispatch({ effects: rebuild.of() });
    refreshTableMedia(this.view);
    for (const formula of this.view.dom.querySelectorAll<HTMLElement>('.cm-inline-math-widget, .md-table-math-preview, .md-table-math-tooltip')) {
      formula.innerHTML = this.host.math(formula.dataset.tex ?? '', false);
    }
    for (const image of this.view.dom.querySelectorAll<HTMLImageElement>('.cm-image-preview img')) {
      const root = image.parentElement!, source = this.view.state.sliceDoc(Number(root.dataset.from), Number(root.dataset.to));
      const info = standaloneImage(source, documentReferences(this.value)); if (info) image.src = displayFileUrl(this.host.resolveSrc(info.src));
    }
    this.view.requestMeasure();
  }

  refreshUiLanguage(): void {
    this.refreshDecorations();
    for (const input of this.view.dom.querySelectorAll<HTMLInputElement>('.cm-code-language')) {
      input.placeholder = uiText('代码语言', 'Code language');
      input.setAttribute('aria-label', uiText('代码块语言', 'Code language'));
    }
    for (const checkbox of this.view.dom.querySelectorAll<HTMLInputElement>('.cm-task-checkbox input, .cm-list-marker input[type=checkbox]'))
      checkbox.setAttribute('aria-label', uiText('任务状态', 'Task status'));
    refreshTableLanguage(this.view);
  }

  setSearchHighlights(hits: SearchHit[], current: number, selectCurrent = false): void {
    const hit = hits[current];
    this.view.dispatch({ effects: setSearchHighlights.of({ hits, current, selecting: !!hits.length && (selectCurrent || this.view.state.field(searchHighlightField).selecting) }),
      ...(selectCurrent && hit ? { selection: { anchor: hit.from, head: hit.to }, scrollIntoView: true } : {}) });
    if (selectCurrent && hit) this.view.dom.querySelector<HTMLElement>('.md-table-widget .cm-search-hit.is-current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  focusSearchHit(): void {
    const selection = this.view.state.selection.main;
    if (!focusTableRange(this.view, selection.from, selection.to)) this.focus();
  }

  configure(preferences: Record<string, any>): void {
    this.view.dispatch({ effects: setPreferences.of({ ...preferences }) });
    for (const span of this.view.dom.querySelectorAll<HTMLElement>('.md-table-widget code,.md-table-widget a,.md-table-widget .cm-md-code,.md-table-widget [data-href]')) {
      span.spellcheck = !!preferences.spellcheckForCodeAndLink;
    }
  }

  handleTableAction(action: string): boolean { return tableAction(this.view, action); }

  /** Keep native heading rows visually identical to theme headings. Padding
   * contains the theme's margins so CodeMirror measures their complete height. */
  private syncHeadingStyles(): void {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:800px;top:0;left:0';
    for (let n = 1; n <= 6; n++) { const h = document.createElement('h' + n); h.textContent = 'Heading'; probe.append(h); }
    const paragraph = document.createElement('p'); paragraph.textContent = 'Paragraph'; probe.append(paragraph);
    this.view.dom.parentElement!.append(probe);
    const css: string[] = [];
    Array.from(probe.children).slice(0, 6).forEach((h, index) => {
      const s = getComputedStyle(h);
      const px = (value: string) => parseFloat(value) || 0;
      const selector = `.cm-editor.aropyt-document-editor .cm-line.cm-heading.cm-header-${index + 1}`;
      css.push(`${selector}{font-size:${s.fontSize};font-weight:${s.fontWeight};line-height:${s.lineHeight};letter-spacing:${s.letterSpacing};margin:0;border:0;position:relative;padding:calc(max(0px,${px(s.marginTop)}px - var(--cm-previous-margin,0px)) + ${px(s.paddingTop)}px) ${s.paddingRight} ${px(s.marginBottom) + px(s.paddingBottom) + px(s.borderBottomWidth)}px ${s.paddingLeft};}`);
      css.push(`.cm-editor.aropyt-document-editor .cm-line.cm-draft-heading-${index + 1}{font-weight:${s.fontWeight};}`);
      css.push(`.cm-editor.aropyt-document-editor .cm-after-heading-${index + 1}{--cm-previous-margin:${s.marginBottom};}`);
      css.push(`${selector}::after{content:"";position:absolute;left:${s.paddingLeft};right:${s.paddingRight};bottom:${s.marginBottom};border-bottom:${s.borderBottomWidth} ${s.borderBottomStyle} ${s.borderBottomColor};pointer-events:none;}`);
    });
    const p = getComputedStyle(paragraph);
    const px = (value: string) => parseFloat(value) || 0;
    const scope = '.cm-editor.aropyt-document-editor .cm-line';
    css.push(`${scope}.cm-paragraph-first{padding-top:calc(max(0px,${px(p.marginTop)}px - var(--cm-previous-margin,0px)) + ${px(p.paddingTop)}px);}`);
    css.push(`${scope}.cm-paragraph-last{padding-bottom:${px(p.marginBottom) + px(p.paddingBottom)}px;}`);
    css.push(`.cm-editor.aropyt-document-editor .cm-after-paragraph{--cm-previous-margin:${p.marginBottom};}`);
    const quote = document.createElement('blockquote'), list = document.createElement('ul'); probe.append(quote, list);
    const q = getComputedStyle(quote), l = getComputedStyle(list);
    css.push(`.cm-editor.aropyt-document-editor{--cm-quote-color:${q.color};--cm-quote-border:${q.borderLeftColor};--cm-quote-border-width:${q.borderLeftWidth};--cm-quote-indent:${px(q.paddingLeft) + px(q.borderLeftWidth)}px;--cm-quote-margin-top:${q.marginTop};--cm-quote-margin-bottom:${q.marginBottom};--cm-list-indent:${l.paddingLeft};--cm-list-margin-top:${l.marginTop};--cm-list-margin-bottom:${l.marginBottom};}`);
    css.push(`.cm-editor.aropyt-document-editor .cm-after-quote{--cm-previous-margin:${q.marginBottom};}.cm-editor.aropyt-document-editor .cm-after-list{--cm-previous-margin:${l.marginBottom};}`);
    const fence = document.createElement('pre'); fence.className = 'md-fences'; probe.append(fence);
    const f = getComputedStyle(fence);
    css.push(`.cm-editor.aropyt-document-editor{--cm-fence-margin-top:${f.marginTop};--cm-fence-margin-bottom:${f.marginBottom};}.cm-editor.aropyt-document-editor .cm-after-fence{--cm-previous-margin:${f.marginBottom};}`);
    probe.remove();
    this.headingStyle.textContent = css.join('\n');
    this.view.requestMeasure();
  }

  destroy(): void {
    this.disposeWindowFocus();
    this.headingStyle.remove();
    this.view.destroy();
  }
}

/* ------------------------------------------------------- selection helper */

export function replaceSelection(editor: DocEditor, text: string): void {
  const view = editor.view;
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
  });
}

export function wrapSelection(editor: DocEditor, before: string, after = before, placeholder = uiText('文本', 'text')): void {
  const view = editor.view;
  const sel = view.state.selection.main;
  const doc = view.state.doc;
  const selected = doc.sliceString(sel.from, sel.to);
  const body = selected || placeholder;
  const insert = before + body + after;
  const anchor = selected ? sel.from + insert.length : sel.from + before.length;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: selected
      ? { anchor: sel.from, head: sel.from + insert.length }
      : { anchor, head: anchor + placeholder.length },
  });
}

export function lineTransform(
  editor: DocEditor,
  fn: (line: string, index: number) => string,
): void {
  const view = editor.view;
  const { first, last } = selectedLines(view.state);
  const changes: { from: number; to: number; insert: string }[] = [];
  for (let n = first; n <= last; n++) {
    const line = view.state.doc.line(n);
    const next = fn(line.text, n - first);
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
  }
  if (changes.length) view.dispatch({ changes });
}

export function getHeadings(editor: DocEditor): Heading[] {
  return renderDocument(editor.value).headings;
}

/**
 * 原版的渲染扩展，供宿主项目的 `EditorAdapter` 直接注入 CM6 状态。
 *
 * `DocEditor` 在自己手里组装这些扩展，但宿主项目已有 `EditorAdapter`
 * （vim、搜索、主题、字数统计都在它上面），不能整个换掉。这里把**渲染
 * 相关的那一部分**单独暴露出来，让宿主按 Compartment 的方式接入。
 *
 * `preferenceField` 由宿主自行 `init`（见 adapter），`modeField` 恒为
 * 渲染态 —— 源码模式时宿主整个收起这批扩展，不需要 modeField 参与。
 */
export const upstreamRenderFields = {
  preferenceField,
  modeField,
  draftHeadingField,
  fenceSelection,
  searchHighlightField,
  decorationField,
  inlineMathTooltip,
  footnotePreview,
  fenceKeymap,
  pairInput,
  rebuild,
} as const;
