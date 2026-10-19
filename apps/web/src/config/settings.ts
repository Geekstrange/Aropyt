/**
 * 用户级配置（settings.jsonc）。
 *
 * 设计要点：
 * 1. **只管配置，不管状态** —— 草稿、最近打开、折叠状态留在 IndexedDB/localStorage，
 *    它们会让配置文件变成噪声，用户就不敢手改了。
 * 2. **JSONC**（允许注释与尾逗号）—— 用户手改时一定会写"为什么这么设"。
 *    不用第三方解析库：去掉注释是个 40 行的状态机，引依赖不值得。
 * 3. **原子写**：先写 .tmp 再 rename，断电不会留下半截文件。
 * 4. **首次启动迁移**：文件不存在时把旧的 localStorage 值写进去，只做一次。
 */
import { idbGet, idbSet, STORE } from '@aropyt/core';
import { LOCALES, type Locale } from '../i18n.js';

export type ThemePreference = 'light' | 'dark' | 'auto';

export interface AppSettings {
  /** 界面语言。 */
  locale: Locale;
  theme: ThemePreference;
  editor: { fontSize: number };
  vim: { enabled: boolean };
  sidebar: { open: boolean };
  plugins: { disabled: string[] };
  /** 编辑历史。 */
  history: { limit: number; /** 自动保存版本（按间隔）。 */ autoSave: boolean; /** 间隔秒数。 */ autoSaveInterval: number };
}

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'en',
  theme: 'auto',
  editor: { fontSize: 15 },
  vim: { enabled: false },
  sidebar: { open: true },
  plugins: { disabled: [] },
  history: { limit: 50, autoSave: true, autoSaveInterval: 60 },
};

/** 配置文件在磁盘上的名字（与 appConfigDir 拼接）。 */
export const SETTINGS_FILE = 'settings.jsonc';

/* ─────────────────────── JSONC 解析 ─────────────────────── */

/**
 * 去掉 // 与 /* *\/ 注释、尾逗号，得到标准 JSON。
 *
 * 必须逐字符扫描而不是正则：`"url": "https://x"` 里的 `//` 不能被当成注释
 * （字符串内的内容原样保留）。
 */
export function stripJsonc(source: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  // 尾逗号：{"a":1,} / [1,2,]
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/* ─────────────────────── 校验 ─────────────────────── */

export interface SettingsProblems {
  readonly unknownKeys: string[];
  readonly invalidValues: string[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 把任意解析结果收敛成合法配置。
 *
 * 非法值 → 回落默认（并报告键名），未知键 → 忽略（并报告）。
 * **不静默吞掉**：用户改了文件却没生效，比报错更糟。
 */
export function normalizeSettings(raw: unknown): {
  settings: AppSettings;
  problems: SettingsProblems;
} {
  const unknownKeys: string[] = [];
  const invalidValues: string[] = [];
  const settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
  if (typeof raw !== 'object' || raw === null) {
    invalidValues.push('（根节点）');
    return { settings, problems: { unknownKeys, invalidValues } };
  }
  const obj = raw as Record<string, unknown>;
  const known = new Set(Object.keys(DEFAULT_SETTINGS));
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) unknownKeys.push(key);
  }
  if (obj.locale !== undefined) {
    if ((LOCALES as readonly string[]).includes(obj.locale as string)) settings.locale = obj.locale as Locale;
    else invalidValues.push('locale');
  }
  if (obj.theme !== undefined) {
    if (obj.theme === 'light' || obj.theme === 'dark' || obj.theme === 'auto') settings.theme = obj.theme;
    else invalidValues.push('theme');
  }
  const editor = obj.editor as Record<string, unknown> | undefined;
  if (editor?.fontSize !== undefined) {
    if (isFiniteNumber(editor.fontSize)) settings.editor.fontSize = clamp(Math.round(editor.fontSize), 12, 24);
    else invalidValues.push('editor.fontSize');
  }
  const vim = obj.vim as Record<string, unknown> | undefined;
  if (vim?.enabled !== undefined) {
    if (typeof vim.enabled === 'boolean') settings.vim.enabled = vim.enabled;
    else invalidValues.push('vim.enabled');
  }
  const sidebar = obj.sidebar as Record<string, unknown> | undefined;
  if (sidebar?.open !== undefined) {
    if (typeof sidebar.open === 'boolean') settings.sidebar.open = sidebar.open;
    else invalidValues.push('sidebar.open');
  }
  const plugins = obj.plugins as Record<string, unknown> | undefined;
  if (plugins?.disabled !== undefined) {
    if (Array.isArray(plugins.disabled) && plugins.disabled.every((v) => typeof v === 'string')) {
      settings.plugins.disabled = plugins.disabled as string[];
    } else {
      invalidValues.push('plugins.disabled');
    }
  }
  const history = obj.history as Record<string, unknown> | undefined;
  if (history?.limit !== undefined) {
    if (isFiniteNumber(history.limit)) settings.history.limit = clamp(Math.round(history.limit), 10, 200);
    else invalidValues.push('history.limit');
  }
  if (history?.autoSave !== undefined) {
    if (typeof history.autoSave === 'boolean') settings.history.autoSave = history.autoSave;
    else invalidValues.push('history.autoSave');
  }
  if (history?.autoSaveInterval !== undefined) {
    if (isFiniteNumber(history.autoSaveInterval)) {
      settings.history.autoSaveInterval = clamp(Math.round(history.autoSaveInterval), 15, 3600);
    } else invalidValues.push('history.autoSaveInterval');
  }
  return { settings, problems: { unknownKeys, invalidValues } };
}

/* ─────────────────────── 后端 ─────────────────────── */

/** 桌面壳能力：由宿主注入（浏览器模式下为 null → 走 IndexedDB）。 */
export interface SettingsIo {
  /** 配置文件绝对路径；浏览器模式为 null。 */
  readonly path: string | null;
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
  /** 用系统默认程序打开配置文件。 */
  openExternal(): Promise<void>;
}

/** 浏览器后端：IndexedDB kv（开发模式 / PWA）。 */
const BROWSER_KEY = 'aropyt.settings.jsonc';

export const browserSettingsIo: SettingsIo = {
  path: null,
  async read() {
    const value = await idbGet<string>(STORE.kv, BROWSER_KEY).catch(() => undefined);
    return value ?? null;
  },
  async write(text) {
    await idbSet(STORE.kv, BROWSER_KEY, text);
  },
  async openExternal() {
    /* 浏览器没有"打开本地文件"这件事 */
  },
};

/* ─────────────────────── 序列化 ─────────────────────── */

export function serializeSettings(settings: AppSettings): string {
  return `/*
 * Aropyt 用户配置（JSONC：允许注释与尾逗号）。
 * 修改后重启应用生效；界面里改的配置会立即写回这个文件。
 */
${JSON.stringify(settings, null, 2)}
`;
}

/* ─────────────────────── 读取 / 保存 ─────────────────────── */

export interface LoadedSettings {
  readonly settings: AppSettings;
  readonly problems: SettingsProblems;
  /** 是否走了"首次启动迁移"（文件不存在，从 localStorage 继承）。 */
  readonly migrated: boolean;
}

function readLegacy(): Partial<AppSettings> {
  const legacy: Partial<AppSettings> = {};
  try {
    const theme = localStorage.getItem('aropyt.theme');
    if (theme === 'light' || theme === 'dark' || theme === 'auto') legacy.theme = theme;
    const sidebar = localStorage.getItem('aropyt.sidebarOpen');
    if (sidebar === 'on' || sidebar === 'off') {
      legacy.sidebar = { open: sidebar === 'on' };
    }
    const vim = localStorage.getItem('aropyt.vimMode');
    if (vim === 'on' || vim === 'off') legacy.vim = { enabled: vim === 'on' };
    const disabled = localStorage.getItem('aropyt.disabledPlugins');
    if (disabled) {
      const parsed = JSON.parse(disabled) as unknown;
      if (Array.isArray(parsed)) legacy.plugins = { disabled: parsed.filter((v) => typeof v === 'string') };
    }
  } catch {
    /* 读不到就用默认 */
  }
  return legacy;
}

export async function loadSettings(io: SettingsIo): Promise<LoadedSettings> {
  let text: string | null = null;
  try {
    text = await io.read();
  } catch {
    text = null;
  }
  if (text === null) {
    // 首次启动：继承旧 localStorage 的值，并立刻落盘一次
    const legacy = readLegacy();
    const merged: AppSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...legacy,
      editor: { ...DEFAULT_SETTINGS.editor, ...(legacy.editor ?? {}) },
      vim: { ...DEFAULT_SETTINGS.vim, ...(legacy.vim ?? {}) },
      sidebar: { ...DEFAULT_SETTINGS.sidebar, ...(legacy.sidebar ?? {}) },
      plugins: { ...DEFAULT_SETTINGS.plugins, ...(legacy.plugins ?? {}) },
    };
    try {
      await io.write(serializeSettings(merged));
    } catch (error) {
      /*
       * 写不进去也要能启动，但**必须把原因带出去** ——
       * 静默吞掉的表现是"配置文件永远不会被创建"，用户完全无从排查
       * （实测：用户报"不会初始化配置文件"，而控制台没有任何提示）。
       */
      return {
        settings: merged,
        problems: {
          unknownKeys: [],
          invalidValues: [
            `配置文件写入失败：${error instanceof Error ? error.message : String(error)}`,
          ],
        },
        migrated: true,
      };
    }
    return { settings: merged, problems: { unknownKeys: [], invalidValues: [] }, migrated: true };
  }
  try {
    const raw = JSON.parse(stripJsonc(text)) as unknown;
    const { settings, problems } = normalizeSettings(raw);
    return { settings, problems, migrated: false };
  } catch (error) {
    // 语法错误：用默认值启动，但要把原因带出去（不能静默）
    return {
      settings: structuredClone(DEFAULT_SETTINGS),
      problems: {
        unknownKeys: [],
        invalidValues: [`语法错误：${error instanceof Error ? error.message : '无法解析'}`],
      },
      migrated: false,
    };
  }
}

export async function saveSettings(io: SettingsIo, settings: AppSettings): Promise<void> {
  await io.write(serializeSettings(settings));
}
