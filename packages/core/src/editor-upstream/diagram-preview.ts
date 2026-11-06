// A fence's line distinguishes repeated identical charts in the same document.
// Reuse only the SVG that belonged to that fence, keeping its generated IDs unique.
const previews = new Map<string, string>();
const key = (source: string, line: number) => line + ':' + source.trim();
export function cachedDiagram(source: string, line: number): string | undefined { return previews.get(key(source, line)); }
export function rememberDiagram(source: string, line: number, svg: string): void {
  if (previews.size >= 64) previews.delete(previews.keys().next().value!);
  previews.set(key(source, line), svg);
}
