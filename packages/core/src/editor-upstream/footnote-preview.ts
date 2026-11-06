import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { renderFootnote, standaloneImage } from './md.js';
import { applyImageDimensions } from './image-actions.js';
import type { EditorHost } from './editor.js';

let sequence = 0;
class FootnotePreview {
  private target?: HTMLElement;
  private tooltip?: HTMLElement;
  private timer?: number;
  private observer?: ResizeObserver;
  constructor(private view: EditorView) {
    view.dom.addEventListener('mouseover', this.over);
    view.dom.addEventListener('mouseout', this.out);
    view.dom.ownerDocument.addEventListener('mousedown', this.close, true);
    view.dom.ownerDocument.addEventListener('keydown', this.key, true);
    view.dom.ownerDocument.addEventListener('scroll', this.close, true);
    window.addEventListener('resize', this.close);
    window.addEventListener('blur', this.close);
  }
  private over = (event: MouseEvent) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-footnote-label]');
    if (!target || target === this.target) return;
    this.close(); this.target = target;
    this.timer = window.setTimeout(() => this.render(), 200);
  };
  private out = (event: MouseEvent) => {
    if (event.relatedTarget instanceof Node && this.target?.contains(event.relatedTarget)) return;
    if ((event.target as HTMLElement).closest('[data-footnote-label]')) this.close();
  };
  private key = (event: KeyboardEvent) => { if (event.key === 'Escape') this.close(); };
  private removeTooltip(): void {
    if (this.tooltip && this.target) {
      const ids = (this.target.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== this.tooltip!.id);
      if (ids.length) this.target.setAttribute('aria-describedby', ids.join(' ')); else this.target.removeAttribute('aria-describedby');
    }
    this.observer?.disconnect(); this.observer = undefined;
    this.tooltip?.remove(); this.tooltip = undefined;
  }
  private close = () => {
    window.clearTimeout(this.timer); this.timer = undefined;
    this.removeTooltip(); this.target = undefined;
  };
  private render(): void {
    const target = this.target;
    if (!target?.isConnected || !this.view.dom.contains(target) || this.view.dom.classList.contains('mode-source')) { this.close(); return; }
    const host = (this.view as unknown as { __host: EditorHost }).__host;
    const html = renderFootnote(this.view.state.doc.toString(), target.dataset.footnoteLabel!, { math: host.math, resolveSrc: host.resolveSrc });
    const template = document.createElement('template'); template.innerHTML = html;
    const body = template.content.querySelector('#write');
    if (!body?.childNodes.length) { this.close(); return; }
    // Preview markup is passive: inline HTML must not create active controls,
    // run event handlers, or add duplicate document anchors just by hovering.
    body.querySelectorAll('script,style,iframe,object,embed,link,meta,base,form,input,textarea,select,button,audio,video').forEach(node => node.remove());
    for (const node of body.querySelectorAll('*')) {
      const image = node instanceof HTMLImageElement ? standaloneImage(node.outerHTML) : null;
      for (const attr of Array.from(node.attributes)) {
        if (/^on/i.test(attr.name) || ['srcdoc', 'autofocus', 'contenteditable'].includes(attr.name) ||
            !node.closest('svg') && ['id', 'style'].includes(attr.name) || ['src', 'href', 'xlink:href'].includes(attr.name) &&
            /^(?:javascript:|vbscript:|data:text\/html)/i.test(attr.value.replace(/[\u0000-\u0020]/g, ''))) node.removeAttribute(attr.name);
      }
      if (node.matches('a,area,summary,[tabindex]')) node.setAttribute('tabindex', '-1');
      if (image) applyImageDimensions(node as HTMLImageElement, image);
    }
    this.removeTooltip();
    const tooltip = document.createElement('div'); tooltip.className = 'cm-footnote-tooltip';
    tooltip.id = 'aropyt-footnote-preview-' + ++sequence; tooltip.setAttribute('role', 'tooltip');
    tooltip.replaceChildren(...Array.from(body.childNodes));
    document.body.append(tooltip); this.tooltip = tooltip;
    target.setAttribute('aria-describedby', [target.getAttribute('aria-describedby'), tooltip.id].filter(Boolean).join(' '));
    this.position();
    this.observer = new ResizeObserver(() => this.position()); this.observer.observe(tooltip);
  }
  private position(): void {
    const tooltip = this.tooltip, target = this.target;
    if (!tooltip || !target?.isConnected || this.view.dom.classList.contains('mode-source')) { this.close(); return; }
    const rect = target.getBoundingClientRect(), gap = 8;
    // getBoundingClientRect uses physical CSS pixels, while fixed offsets are
    // affected by the app's document zoom. Keep both coordinate systems aligned.
    const zoom = document.body.getBoundingClientRect().width / document.body.offsetWidth || 1;
    tooltip.style.maxWidth = Math.min(440, (window.innerWidth - gap * 2) / zoom) + 'px';
    tooltip.style.maxHeight = (window.innerHeight - gap * 2) / zoom + 'px';
    const box = tooltip.getBoundingClientRect();
    tooltip.style.left = Math.max(gap, Math.min(window.innerWidth - box.width - gap, rect.left + (rect.width - box.width) / 2)) / zoom + 'px';
    const top = rect.bottom + box.height + gap * 2 <= window.innerHeight ? rect.bottom + gap : rect.top - box.height - gap;
    tooltip.style.top = Math.max(gap, Math.min(window.innerHeight - box.height - gap, top)) / zoom + 'px';
  }
  update(update: ViewUpdate): void {
    if (!this.target) return;
    const refresh = update.docChanged || update.selectionSet || update.transactions.some(transaction => transaction.effects.length);
    if (refresh || update.geometryChanged || update.viewportChanged) queueMicrotask(() => {
      if (this.tooltip) {
        if (refresh) this.render(); else this.position();
      } else if (!this.target?.isConnected) this.close();
    });
  }
  destroy(): void {
    this.close();
    this.view.dom.removeEventListener('mouseover', this.over);
    this.view.dom.removeEventListener('mouseout', this.out);
    this.view.dom.ownerDocument.removeEventListener('mousedown', this.close, true);
    this.view.dom.ownerDocument.removeEventListener('keydown', this.key, true);
    this.view.dom.ownerDocument.removeEventListener('scroll', this.close, true);
    window.removeEventListener('resize', this.close);
    window.removeEventListener('blur', this.close);
  }
}

export const footnotePreview = ViewPlugin.fromClass(FootnotePreview);
