import { escapeHtml, standaloneImage, type StandaloneImage, type MarkdownReferences } from './md.js';

export const IMAGE_ZOOM_LEVELS = [25, 33, 50, 67, 80, 100, 150, 200];
export interface ImageSourceRange {
  from: number; to: number; source: string; table?: boolean; rawSource?: string;
  cell?: { tableFrom: number; row: number; column: number };
}
export interface ImageMenuItem { label: string; action?: string; type?: 'separator' | 'checkbox'; checked?: boolean; submenu?: ImageMenuItem[] }
export function imageMenu(source: string, zh: boolean): ImageMenuItem[] {
  const image = standaloneImage(source)!;
  return [
    { label: zh ? '缩放图片' : 'Zoom Image', submenu: IMAGE_ZOOM_LEVELS.map((scale) => ({ label: scale + '%', action: 'image:zoom:' + scale })) },
    { label: zh ? '转换图片语法' : 'Convert Image Syntax', submenu: [
      { label: 'Markdown ![alt](src)', action: 'image:markdown', type: 'checkbox', checked: image.kind === 'markdown' },
      { label: 'HTML <img src="src" />', action: 'image:html', type: 'checkbox', checked: image.kind === 'html' },
    ] },
  ];
}
function htmlImage(attributes: Record<string, string>): string {
  return '<img ' + Object.entries(attributes).map(([name, value]) => `${name}="${escapeHtml(value)}"`).join(' ') + ' />';
}
export function replaceImageSource(source: string, src: string, references?: MarkdownReferences): string {
  const image = standaloneImage(source, references); if (!image) return source;
  if (image.kind === 'html') return htmlImage({ ...image.attributes, src });
  const alt = image.alt.replace(/[\\[\]]/g, '\\$&');
  const url = src.replace(/ /g, '%20').replace(/[()]/g, '\\$&');
  const title = image.title ? ' "' + image.title.replace(/[\\"]/g, '\\$&') + '"' : '';
  return `![${alt}](${url}${title})`;
}
export function transformImage(source: string, action: string, references?: MarkdownReferences): string | null {
  const image = standaloneImage(source, references); if (!image) return null;
  if (action === 'image:markdown') {
    if (image.kind === 'markdown') return source;
    const alt = image.alt.replace(/[\\[\]]/g, '\\$&'), src = image.src.replace(/ /g, '%20').replace(/[()]/g, '\\$&');
    const title = image.title ? ' "' + image.title.replace(/[\\"]/g, '\\$&') + '"' : '';
    return `![${alt}](${src}${title})`;
  }
  if (action === 'image:html') return image.kind === 'html' ? source : htmlImage(image.attributes);
  if (!action.startsWith('image:zoom:')) return null;
  const scale = Number(action.slice('image:zoom:'.length)); if (!IMAGE_ZOOM_LEVELS.includes(scale)) return null;
  const attributes = { ...image.attributes };
  const other = (attributes.style || '').split(';').map((part) => part.trim()).filter((part) => part && !/^zoom\s*:/i.test(part));
  attributes.style = [...other, `zoom:${scale}%`].join(';') + ';';
  return htmlImage(attributes);
}

/** The reference editor applies width, height and zoom while editing, while
 * leaving other HTML styles in the source for export. */
export function applyImageDimensions(image: HTMLImageElement, data: StandaloneImage): void {
  image.style.cssText = '';
  if (data.kind !== 'html') return;
  const style = document.createElement('span').style; style.cssText = data.attributes.style || '';
  for (const property of ['width', 'height', 'zoom']) {
    let value = style.getPropertyValue(property) || (property === 'zoom' ? '' : data.attributes[property] || '');
    if (/^\d+(?:\.\d+)?$/.test(value) && property !== 'zoom') value += 'px';
    if (value && CSS.supports(property, value)) image.style.setProperty(property, value);
  }
}
