/**
 * 语言识别（扩展名 → language id）。
 *
 * ── 为什么这属于内核而不是插件 ──────────────────────────────
 * 打开一个文件时，"它是什么语言"是**文档身份的组成部分**：标签要显示、
 * 状态栏要显示、编辑器要据此决定挂哪个解析器、插件要据此决定挂不挂
 * 渲染扩展。如果这件事由某个插件提供，那么没装插件的用户打开 .tex
 * 就永远拿不到高亮 —— 而"识别"本身不需要任何格式知识。
 *
 * 渲染仍然全部是插件的事（见 index.ts 的硬约束）。这里只做识别：
 * 认得出、说得出名字，至于怎么画，是语言贡献者与渲染插件的事。
 *
 * 内置表刻意只覆盖**已经在安装包里注册了文件关联**的格式
 * （见 src-tauri/tauri.conf.json）。不为没承诺的格式做承诺，
 * 也不给"打开一个 .xyz 就自称支持"留口子。
 */

import type { LanguageContribution } from '@aropyt/plugin-api';

export interface LanguageDefinition extends LanguageContribution {
  /** 界面显示名。英文专名，不做本地化（与 VS Code 一致）。 */
  readonly label: string;
}

/** markdown 是产品默认形态。 */
export const MARKDOWN_LANGUAGE = 'markdown';

/** 纯文本：唯一没有渲染层的语言。 */
export const PLAIN_TEXT_LANGUAGE = 'text';

/** 内置语言表。顺序即优先级：插件贡献排在内置之前（可覆盖同扩展名）。 */
export const BUILTIN_LANGUAGES: readonly LanguageDefinition[] = [
  {
    id: MARKDOWN_LANGUAGE,
    label: 'Markdown',
    aliases: ['md'],
    extensions: ['md', 'markdown', 'mdown', 'mkd'],
  },
  {
    id: 'latex',
    label: 'LaTeX',
    aliases: ['tex'],
    extensions: ['tex', 'latex'],
  },
  {
    id: 'fountain',
    label: 'Fountain',
    aliases: ['screenplay'],
    extensions: ['fountain'],
  },
  {
    id: PLAIN_TEXT_LANGUAGE,
    label: 'Plain Text',
    extensions: ['txt', 'log'],
  },
];

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 插件贡献的条目通常不带 label（`LanguageContribution` 里没有这个字段）。
 *
 * 这时要用**内置表同名条目的 label** 兜底，而不是退回 id ——
 * 否则插件一旦声明 `{ id: 'fountain' }`（内置表里已有 'Fountain'），
 * 状态栏会突然显示小写的 `fountain`，而标签徽标仍显示 `Fountain`：
 * 同一个语言在两处显示两个名字。这个坑是实测踩到的。
 */
function fallbackLabel(id: string): string | undefined {
  return BUILTIN_LANGUAGES.find((item) => item.id === id)?.label;
}

function toDefinition(language: LanguageContribution, label?: string): LanguageDefinition {
  const declared = 'label' in language ? (language as LanguageDefinition).label : undefined;
  return {
    ...language,
    label: label ?? (typeof declared === 'string' ? declared : (fallbackLabel(language.id) ?? language.id)),
  };
}

/**
 * 按文件名 / 扩展名识别语言。
 *
 * `extra` 是插件贡献的语言，**优先于内置表** —— 这样插件可以接管某个
 * 扩展名（"我的插件对 .fountain 有自己的解析器"），而内置行为保持不变。
 *
 * 识别不出来返回 `null`，由调用方决定回退到什么（宿主回退 markdown，
 * 那是产品默认形态）。
 */
export function detectLanguage(
  path: string,
  extra: readonly LanguageContribution[] = [],
): LanguageDefinition | null {
  const name = basename(path).toLowerCase();
  if (!name) return null;

  const candidates: readonly LanguageDefinition[] = [
    ...extra.map((language) => toDefinition(language)),
    ...BUILTIN_LANGUAGES,
  ];

  for (const language of candidates) {
    if (language.filenames?.some((filename) => filename.toLowerCase() === name)) return language;
  }

  const extension = extensionOf(name);
  if (!extension) return null;
  for (const language of candidates) {
    if (language.extensions?.some((item) => item.toLowerCase() === extension)) return language;
  }
  return null;
}

/** 语言 id → 显示名。未知 id 原样返回，拼错的插件贡献也能被看见。 */
export function languageLabelOf(
  id: string | null,
  extra: readonly LanguageContribution[] = [],
): string | null {
  if (!id) return null;
  const found = [...extra, ...BUILTIN_LANGUAGES].find((language) => language.id === id);
  return found ? toDefinition(found).label : id;
}

/**
 * 该语言是否有"渲染态"（可切换源码/渲染）。
 *
 * 只有纯文本没有：给它一个渲染开关只会让人以为还有别的显示方式。
 * 其余语言（markdown、fountain、latex，以及插件贡献的自定义 id）
 * 都可能有插件提供装饰 —— 画成什么样是那个插件的自由，但"能不能切"
 * 不该由内核按扩展名硬编码：`.tex` 有公式渲染、`.fountain` 有剧本样式，
 * 它们和 markdown 一样需要一个"看原文"的出口。
 */
export function isRenderableLanguage(id: string | null): boolean {
  return id !== PLAIN_TEXT_LANGUAGE;
}
