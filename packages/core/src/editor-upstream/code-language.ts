import hljs from 'highlight.js';

const languages = [...new Set([
  ...hljs.listLanguages().flatMap((name) => [name, ...(hljs.getLanguage(name)?.aliases ?? [])]),
  'mermaid', 'flow', 'sequence', 'gantt', 'math', 'text', 'plaintext',
])].sort((a, b) => a.localeCompare(b));

let nextId = 0;

const canonicalNames = new Map(hljs.listLanguages().flatMap((name) =>
  [name, ...(hljs.getLanguage(name)?.aliases ?? [])].map((alias) => [alias, name] as const)));
const iconAliases: Record<string, string> = {
  plaintext: 'file', text: 'file', shell: 'console', bash: 'console', dos: 'console',
  coffeescript: 'coffee', jinja2: 'jinja', jade: 'pug', vbnet: 'vb', vbscript: 'vb',
  armasm: 'assembly', x86asm: 'assembly', latex: 'tex', makefile: 'makefile',
  mathematica: 'wolframlanguage', wasm: 'webassembly', lsl: 'glsl',
  mermaid: 'uml', sequence: 'uml', gantt: 'uml', math: 'tex',
};
let iconLayers: Map<string, number> | undefined;
function languageIcon(name: string): HTMLElement {
  // Read the bundled font's own selectors, including its layered colour glyphs.
  // Themes can still supply colours without duplicating the font's codepoints.
  if (!iconLayers) {
    iconLayers = new Map();
    for (const sheet of document.styleSheets) {
      if (!sheet.href?.includes('/aropyt-file-icon/')) continue;
      for (const rule of sheet.cssRules) {
        const match = /^\.ty-fi-([\w-]+)(?: \.path(\d+))?::?before$/.exec((rule as CSSStyleRule).selectorText ?? '');
        if (match) iconLayers.set(match[1], Math.max(iconLayers.get(match[1]) ?? 0, Number(match[2] ?? 0)));
      }
    }
  }
  const canonical = canonicalNames.get(name) ?? name;
  const mapped = iconAliases[name] ?? iconAliases[canonical] ?? canonical;
  const iconName = iconLayers.has(name) ? name : iconLayers.has(mapped) ? mapped : 'file';
  const icon = document.createElement('span');
  icon.className = 'cm-language-icon ty-file-icon ty-fi-' + iconName;
  icon.setAttribute('aria-hidden', 'true');
  for (let layer = 1; layer <= (iconLayers.get(iconName) ?? 0); layer++) {
    const part = document.createElement('span'); part.className = 'path' + layer; icon.append(part);
  }
  return icon;
}

/** A real combobox, shared by every code fence; its popup stays within the
 * viewport even when the fence is near the bottom of the document. */
export function attachLanguagePicker(input: HTMLInputElement, commit: () => void, returnToCode: () => void, focusLanguage = () => input.focus()): () => void {
  const list = document.createElement('div');
  list.className = 'cm-language-options';
  list.id = 'code-languages-' + ++nextId;
  list.setAttribute('role', 'listbox');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');
  input.autocomplete = 'off';
  // This input lives beside editable CodeMirror rows. Its native editing and
  // IME events must never be interpreted as edits to the code selection.
  for (const type of ['beforeinput', 'input', 'paste', 'copy', 'cut', 'compositionstart', 'compositionupdate', 'compositionend']) {
    input.addEventListener(type, (event) => event.stopPropagation());
  }
  let matches: string[] = [];
  let active = -1;

  const close = () => { list.remove(); input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
  const choose = (value: string, leave = false) => {
    input.value = value;
    close();
    commit();
    if (leave) returnToCode(); else focusLanguage();
  };
  const paint = () => {
    list.replaceChildren();
    matches.forEach((name, index) => {
      const option = document.createElement('div');
      option.className = 'cm-language-option' + (index === active ? ' is-selected' : '');
      option.id = list.id + '-' + index;
      const label = document.createElement('span'); label.textContent = name;
      option.append(languageIcon(name), label);
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === active));
      option.addEventListener('mousedown', (event) => { event.preventDefault(); choose(name); });
      list.append(option);
    });
    if (active >= 0) input.setAttribute('aria-activedescendant', list.id + '-' + active);
    else input.removeAttribute('aria-activedescendant');
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };
  const show = () => {
    const query = input.value.trim().toLowerCase();
    matches = languages.filter((name) => name.toLowerCase().startsWith(query)).slice(0, 80);
    if (!matches.length) { close(); return; }
    active = -1;
    paint();
    document.body.append(list);
    const rect = input.getBoundingClientRect();
    const width = Math.max(140, rect.width);
    const height = Math.min(matches.length * 30 + 8, 158);
    list.style.width = width + 'px';
    list.style.left = Math.max(8, Math.min(innerWidth - width - 8, rect.right - width)) + 'px';
    list.style.top = (rect.bottom + height < innerHeight - 8 ? rect.bottom + 3 : Math.max(8, rect.top - height - 3)) + 'px';
    input.setAttribute('aria-expanded', 'true');
  };
  input.addEventListener('focus', show);
  input.addEventListener('input', show);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!list.isConnected) show();
      else {
        active = active < 0 ? (event.key === 'ArrowDown' ? 0 : matches.length - 1) :
          (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        paint();
      }
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      choose(list.isConnected && active >= 0 ? matches[active] : input.value.trim(), event.key === 'Tab');
    } else if (event.key === 'Escape') {
      event.preventDefault(); close(); returnToCode();
    }
  });
  return close;
}
