/**
 * 轻量 i18n：无依赖、约 100 行。
 *
 * 设计要点：
 * 1. **纯函数 + 全局状态 + 订阅**，不绑 React —— runtime.ts 的
 *    showMessage、命令注册等非组件场景也要取文案。
 * 2. React 侧用 `useSyncExternalStore(subscribe, getLocale)` 触发重渲染，
 *    不用 Context 包裹（Context 要求组件树里所有调用方都在 Provider 内，
 *    而这里很多文案来自非组件代码）。
 * 3. key 类型从 zh.ts 推导（`TextKey`），en.ts 用同一套 key 做类型约束，
 *    漏翻会在编译期报错。
 */
import { zh } from './zh';
import { en } from './en';
import { de } from './de';
import { fr } from './fr';
import { ja } from './ja';
import { ko } from './ko';
import { it } from './it';
import { ru } from './ru';

export type TextKey = keyof typeof zh;
export type Locale = 'zh' | 'en' | 'de' | 'fr' | 'ja' | 'ko' | 'it' | 'ru';
/** 配置值：'auto' 表示跟随系统。 */
export type LocalePreference = Locale | 'auto';

const DICTS: Record<Locale, Record<TextKey, string>> = { zh, en, de, fr, ja, ko, it, ru };

/*
 * 初始值取系统语言 —— **不能**写死 'zh'。
 * 命令式视图（大纲、文件树）在 runtime 创建时就会渲染一次，
 * 若此时仍是默认中文，英文环境首屏会闪一下中文；更糟的是那些视图
 * 不会随语言切换重画（除非重挂载），错误语言就留在那里了。
 */
let current: Locale = detectLocale();
const listeners = new Set<() => void>();

/** 系统语言 → 支持的语言（仅中/英，其余回退英文）。 */
export function detectLocale(): Locale {
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  const supported: Locale[] = ['zh', 'en', 'de', 'fr', 'ja', 'ko', 'it', 'ru'];
  for (const raw of langs) {
    const tag = raw.toLowerCase();
    // zh-CN / zh-TW 都归到 zh；ja-JP → ja
    const head = tag.split('-')[0];
    const found = supported.find((l) => l === head);
    if (found) return found;
    // 少数系统返回 jp / kr（非标准），一并映射
    if (head === 'jp') return 'ja';
    if (head === 'kr') return 'ko';
  }
  return 'en';
}

/** 把配置值解析成实际语言。 */
export function resolveLocale(pref: LocalePreference): Locale {
  return pref === 'auto' ? detectLocale() : pref;
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(pref: LocalePreference): void {
  const next = resolveLocale(pref);
  if (next === current) return;
  current = next;
  document.documentElement.lang = (
    {
      zh: 'zh-CN', en: 'en', de: 'de', fr: 'fr',
      ja: 'ja', ko: 'ko', it: 'it', ru: 'ru',
    } as Record<Locale, string>
  )[next];
  listeners.forEach((fn) => fn());
}

/** 订阅语言变化（供 useSyncExternalStore 使用）。返回取消订阅函数。 */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 取文案。变量用 `{name}` 占位：
 *   t('status.words', { n: 12 })  // 中文里通常不用，英文复数需要
 */
export function t(key: TextKey, vars?: Record<string, string | number>): string {
  let text = DICTS[current][key] ?? DICTS.zh[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value));
    }
  }
  return text;
}

/** 当前语言下是否中文（用于个别需要按语言调整格式的地方）。 */
export function isZh(): boolean {
  return current === 'zh';
}

/**
 * 内置命令标题的翻译表。
 *
 * 为什么需要它：内置插件的 manifest（`contributes.commands`）是**模块
 * 顶层静态对象**，`title` 在 import 时就固定了，无法按当前语言求值。
 * 在那个位置调用 `t()` 拿到的永远是启动瞬间的语言。
 *
 * 所以采用「渲染层翻译」：命令仍带着中文原文，渲染时用这张表换成
 * 当前语言。中文原文作键虽然不如 key 干净，但内置命令的文案稳定，
 * 且不需要改动插件 API 的注册链路。
 */
const COMMAND_TITLES: Record<string, TextKey> = {
  加粗: 'toolbar.bold',
  斜体: 'toolbar.italic',
  删除线: 'toolbar.strike',
  行内代码: 'toolbar.inlineCode',
  插入链接: 'toolbar.link',
  一级标题: 'toolbar.h1',
  二级标题: 'toolbar.h2',
  三级标题: 'toolbar.h3',
  无序列表: 'toolbar.ul',
  有序列表: 'toolbar.ol',
  任务列表: 'toolbar.task',
  引用: 'toolbar.quote',
  代码块: 'toolbar.codeBlock',
  插入表格: 'toolbar.table',
  插入公式: 'toolbar.math',
  插入图像: 'toolbar.image',
  保存: 'toolbar.save',
  '打开文件…': 'toolbar.openFile',
  '打开文件夹…': 'toolbar.openFolder',
  文件: 'panel.files',
  大纲: 'panel.outline',
  恢复上次工作区: 'toolbar.restoreWorkspace',
  关闭工作区: 'toolbar.closeWorkspace',
  恢复已移除的目录: 'view.restoreRemoved',
};

/** 把命令标题翻成当前语言；表里没有的原样返回（第三方插件）。 */
export function commandTitle(title: string): string {
  const key = COMMAND_TITLES[title];
  return key ? t(key) : title;
}


/**
 * 命令分类的翻译表。与 COMMAND_TITLES 同因：`category` 在插件 manifest
 * 里是静态中文，只能在渲染层换。
 */
const CATEGORY_TITLES: Record<string, TextKey> = {
  文件: 'category.files',
  格式: 'category.format',
};

export function categoryTitle(category: string): string {
  const key = CATEGORY_TITLES[category];
  return key ? t(key) : category;
}
