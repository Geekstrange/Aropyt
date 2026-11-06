/**
 * 原版内核的两个应用层依赖的替身。
 *
 * `ui-language` 只提供双语文案查表，`bridge/files` 把相对路径转成可用的
 * file:// URL。两者都不参与渲染逻辑，POC 里退化成恒等函数即可 —— 真正
 * 迁移时它们各自有现成的对应物（i18n 与 asset resolver）。
 */

export type Lang = 'zh' | 'en';

let language: Lang = 'zh';

export function setUiLanguage(value: Lang): void {
  language = value;
}

export function getUiLanguage(): Lang {
  return language;
}

/**
 * 原版的签名是 (中文, English)。
 *
 * 这里一律取**英文**：用到它的是警告块标签（Note / Tip / …）与脚注标签，
 * 它们和 Markdown 源码里的 `> [!NOTE]` 一一对应。翻译之后，用户在源码里
 * 写的是 NOTE、渲染出来却显示「注意」，反而对不上。
 */
export function uiText(_zh: string, en: string, _lang: Lang = language): string {
  return en;
}

export function filePath(source: string): string {
  return source;
}

export function asFileUrl(path: string): string {
  return path;
}

export function localFileUrl(source: string): string {
  return source;
}

/** 原版把相对路径拼成 file:// 或 tauri://；POC 里原样返回。 */
export function displayFileUrl(source: string): string {
  return source;
}
