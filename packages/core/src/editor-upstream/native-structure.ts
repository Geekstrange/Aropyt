import { nativeParagraph } from './inline-markdown.js';

export interface StructureRow {
  from: number; to: number; prefix: number; body: string; depth: number; marker: string; task: boolean | null;
}

/** Simple text quotes and lists retain native text rows. Rich nested blocks
 * stay with the block renderer until their own editing model is available. */
export function structureRows(kind: string, source: string): StructureRow[] | null {
  const quote = kind === 'blockquote_open';
  if (!quote && kind !== 'bullet_list_open' && kind !== 'ordered_list_open') return null;
  const rows: StructureRow[] = [];
  const levels: number[] = [];
  const contentIndents = new Map<number, number>();
  const counters = new Map<number, number>();
  let offset = 0, continuationIndent = 0;
  for (const line of source.replace(/\n+$/, '').split('\n')) {
    const match = quote ? /^( {0,3}(?:>[ \t]?)+)/.exec(line) : /^([ \t]*)([-+*]|\d+[.)])[ \t]+(?:\[([ xX])\][ \t]+)?/.exec(line);
    if (!match) {
      const prefix = /^[ \t]*/.exec(line)![0];
      const body = line.slice(prefix.length), previous = rows[rows.length - 1];
      const width = prefix.replace(/\t/g, '    ').length;
      const parent = [...levels].reverse().find(level => (contentIndents.get(level) || continuationIndent) <= width);
      if (quote || !previous || body && parent === undefined || !nativeParagraph(body) || /^(?:#{1,6}\s|[>|]|`{3}|~{3})/.test(body)) return null;
      const depth = parent === undefined ? previous.depth : levels.indexOf(parent) + 1;
      rows.push({ from: offset, to: offset + line.length, prefix: prefix.length, body, depth, marker: '', task: null });
      offset += line.length + 1; continue;
    }
    const body = line.slice(match[0].length);
    if (!nativeParagraph(body) || /^(?:#{1,6}\s|\[!\w+\]|[-*_]{3,}\s*$|[|]|`{3}|~{3})/.test(body) ||
        quote && /^(?:[-+*][ \t]|\d+[.)][ \t])/.test(body)) return null;
    let depth: number, marker = '', task: boolean | null = null;
    if (quote) depth = (match[0].match(/>/g) ?? []).length;
    else {
      continuationIndent = match[0].replace(/\t/g, '    ').length;
      const indent = match[1].replace(/\t/g, '    ').length;
      while (levels.length && levels[levels.length - 1] > indent) levels.pop();
      if (!levels.length || indent > levels[levels.length - 1]) levels.push(indent);
      contentIndents.set(indent, /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/.exec(line)![0].replace(/\t/g, '    ').length);
      depth = levels.length;
      if (/^\d/.test(match[2])) {
        const number = counters.get(indent) ?? Number(match[2].slice(0, -1));
        marker = number + '.'; counters.set(indent, number + 1);
      } else { marker = depth === 1 ? '•' : depth === 2 ? '◦' : '▪'; counters.delete(indent); }
      for (const level of counters.keys()) if (level > indent) counters.delete(level);
      if (match[3] !== undefined) task = match[3].toLowerCase() === 'x';
    }
    rows.push({ from: offset, to: offset + line.length, prefix: match[0].length, body, depth, marker, task });
    offset += line.length + 1;
  }
  return rows;
}
