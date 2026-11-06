/** Rendered media have their source in adjacent hidden text nodes. Their SVG
 * labels must never be mistaken for Markdown when reading a cell or range. */
export function tableTextNodes(root: Node): Text[] {
  const nodes: Text[] = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    if (!text.parentElement?.closest('[data-table-rendered]')) nodes.push(text);
  }
  return nodes;
}
export function tableText(root: Node): string { return tableTextNodes(root).map((node) => node.data).join(''); }
