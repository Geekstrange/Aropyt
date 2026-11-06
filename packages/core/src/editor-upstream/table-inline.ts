import { inlineMathSpans, inlineSpans, nativeParagraph } from './inline-markdown.js';
import { tableText } from './table-dom.js';
import { inlineImages, inlineFootnotes } from './inline-media.js';
import { type MarkdownReferences } from './md.js';
import { applyImageDimensions } from './image-actions.js';
import { displayFileUrl } from './stubs.js';
import { type SearchHighlight, searchIntersects, searchClass } from './search-highlights.js';

const projections = new WeakMap<HTMLElement, string>();
/** Keep Markdown in text nodes (including hidden delimiters), so DOM ranges
 * map to the same source offsets before and after a format is opened. */
export function projectTableInline(cell: HTMLElement, source: string, selection: [number, number] | null, math?: (tex: string) => string,
  media?: { references: MarkdownReferences; resolveSrc(src: string): string; measure(): void }, hits: SearchHighlight[] = []): boolean | null {
  const candidates = media ? inlineImages(source, media.references) : [];
  // Known image attributes may contain entities or quotes. Explicit cell line
  // breaks are inline content too; neither requires exposing the whole cell.
  let text = source;
  for (const image of [...candidates].reverse()) text = text.slice(0, image.from) + 'image' + text.slice(image.to);
  if (!nativeParagraph(text.replace(/\n/g, ' '), !!media)) { projections.delete(cell); return null; }
  const formulas = inlineMathSpans(source).filter(formula => !candidates.some(image => formula.from >= image.from && formula.to <= image.to));
  const images = candidates.filter(image => !formulas.some(formula => image.from >= formula.from && image.to <= formula.to));
  const footnotes = inlineFootnotes(source).filter(note => ![...images, ...formulas].some(range => note.from >= range.from && note.to <= range.to));
  const rich = [...images, ...formulas, ...footnotes];
  const spans = [...inlineSpans(source).filter((span) => !rich.some((range) => span.from >= range.from && span.to <= range.to)),
    ...formulas.map((formula) => ({ ...formula, bodyFrom: formula.from + 1, bodyTo: formula.to - 1, className: 'cm-md-math-source', href: undefined })),
    ...footnotes.map(note => ({ ...note, bodyFrom: note.from + 2, bodyTo: note.to - 1, className: 'cm-inline-footnote', href: undefined })),
    ...images.map(image => ({ ...image, bodyFrom: image.from, bodyTo: image.to, className: 'cm-inline-image-source', href: undefined }))];
  const active = spans.map((span) => (!!selection && (selection[0] === selection[1]
    ? selection[0] > span.from && selection[0] < span.to : selection[0] < span.to && selection[1] > span.from)) ||
    (rich.some(range => range.from === span.from && range.to === span.to) ? searchIntersects(hits, span.from, span.to) :
      searchIntersects(hits, span.from, span.bodyFrom) || searchIntersects(hits, span.bodyTo, span.to)));
  const key = source + '\0' + JSON.stringify([spans.map((span, i) => [span, active[i]]), images.map(image => media!.resolveSrc(image.image.src)), hits]);
  if (projections.get(cell) === key && tableText(cell) === source && (!spans.length || cell.querySelector('[data-table-inline]'))) return false;
  projections.set(cell, key);
  if (!spans.length && !hits.length) { cell.textContent = source; return true; }
  const points = [...new Set([0, source.length, ...spans.flatMap((span) => [span.from, span.bodyFrom, span.bodyTo, span.to]), ...hits.flatMap(hit => [hit.from, hit.to])])].sort((a, b) => a - b);
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i], to = points[i + 1]; if (from === to) continue;
    const note = footnotes.find(note => from >= note.from && to <= note.to);
    const openedNote = note && active[spans.findIndex(span => span.from === note.from && span.to === note.to)];
    const part = document.createElement(note && !openedNote && from >= note.from + 2 && to <= note.to - 1 ? 'sup' : 'span'); part.dataset.tableInline = ''; part.textContent = source.slice(from, to);
    const classes = new Set<string>(); let hidden = false;
    spans.forEach((span, index) => {
      if (images.some(image => image.from === span.from && image.to === span.to)) {
        if (from >= span.from && to <= span.to) {
          part.dataset.tableImageFrom = String(span.from); part.dataset.tableImageTo = String(span.to);
          if (active[index]) { classes.add('cm-inline-image-source'); if (from === span.from) classes.add('cm-inline-image-source-start'); }
          else hidden = true;
        }
        return;
      }
      if (note && span.from === note.from && span.to === note.to) {
        if (from >= span.from && to <= span.to) {
          if (active[index]) classes.add('cm-md-marker');
          else if (from >= span.bodyFrom && to <= span.bodyTo) {
            classes.add('cm-inline-footnote'); classes.add('md-table-footnote');
            part.dataset.from = String(note.from); part.dataset.to = String(note.to); part.dataset.footnoteLabel = note.label;
          } else hidden = true;
        }
        return;
      }
      if (formulas.some((formula) => formula.from === span.from && formula.to === span.to) && !active[index] && from >= span.from && to <= span.to) { hidden = true; return; }
      const marker = from >= span.from && to <= span.bodyFrom || from >= span.bodyTo && to <= span.to;
      if (marker) { if (active[index]) classes.add('cm-md-marker'); else hidden = true; }
      else if (from >= span.bodyFrom && to <= span.bodyTo && span.className) {
        classes.add(span.className);
        if (span.href) { part.dataset.href = span.href; part.title = span.href; }
      }
    });
    const hit = hits.find(hit => from >= hit.from && to <= hit.to);
    if (hit) for (const cls of searchClass(hit.current).split(' ')) classes.add(cls);
    if (hidden) { classes.add('md-table-hidden-marker'); part.setAttribute('aria-hidden', 'true'); }
    part.className = [...classes].join(' '); fragment.append(part);
    const formula = formulas.find((formula) => formula.to === to);
    if (formula && !active[spans.findIndex((span) => span.from === formula.from && span.to === formula.to)]) {
      const preview = document.createElement('span'); preview.className = 'md-table-math-preview'; preview.contentEditable = 'false';
      preview.dataset.tableRendered = ''; preview.dataset.tex = formula.tex; preview.dataset.from = String(formula.from); preview.dataset.to = String(formula.to);
      preview.innerHTML = math?.(formula.tex) || formula.tex; fragment.append(preview);
    }
    const image = images.find(image => image.to === to);
    if (image) {
      const preview = document.createElement('span'); preview.className = 'md-table-image-preview'; preview.contentEditable = 'false';
      preview.dataset.tableRendered = ''; preview.dataset.from = String(image.from); preview.dataset.to = String(image.to);
      preview.dataset.tableImageFrom = String(image.from); preview.dataset.tableImageTo = String(image.to);
      preview.dataset.selectionFrom = String(image.image.selectionFrom); preview.dataset.selectionTo = String(image.image.selectionTo);
      const img = document.createElement('img'); img.alt = image.image.alt; img.title = image.image.title;
      applyImageDimensions(img, image.image); img.src = displayFileUrl(media!.resolveSrc(image.image.src));
      img.addEventListener('load', () => media!.measure());
      img.addEventListener('error', () => {
        img.hidden = true;
        const opened = active[spans.findIndex(span => span.from === image.from && span.to === image.to)];
        if (opened) preview.hidden = true; else preview.append(document.createTextNode(image.source));
        media!.measure();
      });
      preview.append(img); fragment.append(preview);
    }
  }
  cell.replaceChildren(fragment); return true;
}
