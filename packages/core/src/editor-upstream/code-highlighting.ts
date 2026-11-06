import hljs from 'highlight.js';

// Mermaid is editable beside its preview, so it needs the same lexical colours
// as other native code boxes even though highlight.js has no bundled grammar.
hljs.registerLanguage('mermaid', () => ({
  name: 'Mermaid', contains: [
    { scope: 'comment', begin: /%%/, end: /$/ },
    { scope: 'keyword', match: /\b(?:graph|flowchart|subgraph|end|sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|xychart-beta|block-beta|packet-beta|architecture-beta|participant|actor|activate|deactivate|note|loop|alt|else|opt|par|and|rect|classDef|class|style|linkStyle|direction|title|section|dateFormat|axisFormat)\b/ },
    { scope: 'literal', match: /\b(?:LR|RL|TD|TB|BT)\b/ },
    { scope: 'type', begin: /\[/, end: /\]/ },
    { scope: 'type', begin: /\{/, end: /\}/ },
    { scope: 'string', begin: /"/, end: /"/ },
    { scope: 'operator', match: /(?:[-=.]+(?:>|o|x)|<[-=.]+|:::)/ },
  ],
}));

export function highlightedCode(code: string, language: string): string | null {
  if (!hljs.getLanguage(language)) return null;
  let html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  if (/^(?:java|c|cpp|c\+\+|csharp|cs|objectivec)$/.test(language)) {
    html = html.replace(/<span class="hljs-keyword">(void|boolean|bool|byte|char|short|int|long|float|double|signed|unsigned)<\/span>/g, '<span class="hljs-type">$1</span>');
  }
  // Operators outside strings/comments are otherwise left unclassified by
  // several highlight.js grammars. Never alter the escaped source characters.
  if (/^(?:java|javascript|js|typescript|ts|c|cpp|csharp|cs|python|py)$/.test(language)) {
    let depth = 0;
    html = html.replace(/<[^>]+>|[^<]+/g, (part) => {
      if (part.startsWith('</')) { depth--; return part; }
      if (part.startsWith('<')) { depth++; return part; }
      return depth ? part : part.replace(/(?:&(?:lt|gt|amp);|[=+*/!%|^-])+/g, '<span class="hljs-operator">$&</span>');
    });
  }
  return html;
}
