import { parser } from '@lezer/markdown';
import { type MarkdownReferences, type StandaloneImage, standaloneImage } from './md.js';
import { inlineSpans } from './inline-markdown.js';

export interface InlineImage { from: number; to: number; source: string; image: StandaloneImage }
export function inlineImages(source: string, references: MarkdownReferences): InlineImage[] {
  const images: InlineImage[] = [];
  parser.parse(source).iterate({ enter({ node }) {
    if (node.name !== 'Image') return;
    const text = source.slice(node.from, node.to), image = standaloneImage(text, references);
    if (image) images.push({ from: node.from, to: node.to, source: text, image });
    return false;
  } });
  const code = inlineSpans(source).filter(span => span.className === 'cm-md-code');
  for (const match of source.matchAll(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const from = match.index!, to = from + match[0].length;
    if ((/\\*$/.exec(source.slice(0, from))![0].length % 2) || [...images, ...code].some(span => from >= span.from && from < span.to)) continue;
    const image = standaloneImage(match[0]); if (image) images.push({ from, to, source: match[0], image });
  }
  return images.sort((a, b) => a.from - b.from);
}

export function inlineFootnotes(source: string): { from: number; to: number; label: string }[] {
  const code = inlineSpans(source).filter(span => span.className === 'cm-md-code');
  return Array.from(source.matchAll(/(?<!\\)\[\^([^\]\s]+)\]/g)).filter(match =>
    !code.some(span => match.index! >= span.from && match.index! < span.to)).map(match =>
    ({ from: match.index!, to: match.index! + match[0].length, label: match[1] }));
}
