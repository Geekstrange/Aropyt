import { inlineMathSpans, inlineSpans } from './inline-markdown.js';

export type TextRangeKind = 'sentence' | 'word' | 'style';
export function textRange(source: string, position: number, kind: TextRangeKind, remove = false): [number, number] {
  const point = Math.max(0, Math.min(source.length, position));
  if (kind === 'style') {
    const spans = [...inlineSpans(source), ...inlineMathSpans(source).map((span) => ({ ...span, bodyFrom: span.from + 1, bodyTo: span.to - 1 }))];
    const span = spans.filter((span) => point >= span.bodyFrom && point <= span.bodyTo).sort((a, b) => a.to - a.from - (b.to - b.from))[0];
    return span ? remove ? [span.from, span.to] : [span.bodyFrom, span.bodyTo] : [0, source.length];
  }
  const segments = Array.from(new Intl.Segmenter(undefined, { granularity: kind }).segment(source));
  const segment = kind === 'word'
    ? segments.find((part) => part.isWordLike && point >= part.index && point <= part.index + part.segment.length)
    : segments.find((part) => point >= part.index && point < part.index + part.segment.length) ?? segments[segments.length - 1];
  if (!segment) return [point, point];
  let end = segment.index + segment.segment.length;
  if (kind === 'word' && remove) while (end < source.length && /[ \t]/.test(source[end])) end++;
  return [segment.index, end];
}
