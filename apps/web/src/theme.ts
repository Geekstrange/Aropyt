/**
 * 主题控制 —— 深浅色切换。
 *
 * ── 设计要点 ──────────────────────────────────────────────
 *
 * 1. **只有两个具体主题，外加一个"跟随系统"的偏好。**
 *    `auto` 不是一个主题，它只是"从系统偏好解析出具体值"。
 *    解析结果永远落到 `light` 或 `dark`，所以 CSS 里只需要两套色板、
 *    不需要在媒体查询里再写一遍（那会变成两处定义，迟早不一致）。
 *
 * 2. **持久化用 localStorage 而不是配置系统。**
 *    这是个不常见的取舍，理由很具体：主题必须在**首次绘制之前**生效，
 *    否则会出现"深色闪一下再变浅"的白/黑闪。配置系统底层是 IndexedDB，
 *    是异步的，赶不上首帧；localStorage 是同步的，赶得上。
 *    `index.html` 里那段内联脚本就是为此存在的。
 *
 *    代价是主题偏好没有走统一配置系统，插件读不到它。
 *    等设置页落地、且确有插件需要读主题时再补一条同步通道 ——
 *    现在为它建一套双写机制属于提前复杂化。
 *
 * 3. **切换只改 `data-theme` 属性，不重绘任何组件。**
 *    所有颜色都是 CSS 自定义属性，改属性即可全局生效；
 *    CodeMirror 的主题、预览 iframe 的色板都从计算值读取，自然跟随。
 */

import type { Disposable } from '@aropyt/plugin-api';

export type ThemePreference = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'light' | 'dark';

/** localStorage 键。与 index.html 内联脚本里用的必须一致。 */
export const THEME_STORAGE_KEY = 'aropyt.theme';

const PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'auto'];

export interface ThemeService {
  /** 用户的偏好（可能是 auto）。 */
  readonly preference: ThemePreference;
  /** 实际生效的主题。永远不是 auto。 */
  readonly resolved: ResolvedTheme;
  /** 在 light → dark → auto 之间循环，返回新偏好。 */
  cycle(): ThemePreference;
  set(preference: ThemePreference): void;
  /** 主题变化（含系统偏好变化导致的解析结果变化）。 */
  onDidChange(listener: (resolved: ResolvedTheme) => void): Disposable;
}

function isPreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (PREFERENCES as readonly string[]).includes(value);
}

/** 读偏好。存储损坏或被手改时退回 auto，而不是让界面停在无样式状态。 */
function readPreference(storage: Storage | null): ThemePreference {
  try {
    const raw = storage?.getItem(THEME_STORAGE_KEY);
    return isPreference(raw) ? raw : 'auto';
  } catch {
    // 隐私模式下 localStorage 可能直接抛异常。
    return 'auto';
  }
}

function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function createThemeService(): ThemeService {
  // 直接取 window.localStorage：访问它本身在部分环境下会抛，
  // 所以包一层 try。拿不到就退化成"不持久化"，功能仍可用。
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }

  let preference = readPreference(storage);
  let resolved: ResolvedTheme = preference === 'auto' ? systemTheme() : preference;

  const listeners = new Set<(resolved: ResolvedTheme) => void>();

  /**
   * 把解析结果写到 DOM。
   *
   * 用 `data-theme` 而不是 class：属性更适合表达"当前状态是什么"，
   * 而且 `:root[data-theme='light']` 这种选择器读起来就是它的语义。
   *
   * 同时更新 `<meta name="color-scheme">` —— 它影响滚动条、表单控件、
   * 以及 WebView 自身的默认配色。只写 CSS 的 color-scheme 在部分 WebView
   * 上覆盖不到原生控件。
   */
  const apply = (): void => {
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    // color-scheme 让浏览器原生部件（滚动条、光标）也跟着变，
    // 否则浅色主题下会出现一条深色滚动条。
    root.style.colorScheme = resolved;

    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', resolved);
  };

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener(resolved);
      } catch {
        /* 单个监听器出错不该影响其他监听器，更不该影响主题本身 */
      }
    }
  };

  const resolve = (): void => {
    const next: ResolvedTheme = preference === 'auto' ? systemTheme() : preference;
    if (next === resolved) return;
    resolved = next;
    apply();
    emit();
  };

  // 跟随系统时，系统切换要实时反映过来。
  // 非 auto 模式下这个订阅仍然挂着但不产生效果 —— 因为 resolve() 会算出同一个值。
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (): void => resolve();
    // Safari 14 之前只有 addListener。留着不影响新浏览器。
    if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
    else if (typeof query.addListener === 'function') query.addListener(onChange);
  }

  apply();

  return {
    get preference() {
      return preference;
    },
    get resolved() {
      return resolved;
    },

    set(next: ThemePreference) {
      if (next === preference) return;
      preference = next;
      try {
        storage?.setItem(THEME_STORAGE_KEY, next);
      } catch {
        /* 存不下就只是不持久化，本次会话仍然生效 */
      }

      resolved = next === 'auto' ? systemTheme() : next;
      apply();
      // 解析结果没变时也要通知（比如 dark → auto 且系统恰好就是 dark）：
      // 偏好变了，工具栏按钮的显示状态得跟着更新。
      emit();
    },

    cycle() {
      // light → dark → auto → light
      const index = PREFERENCES.indexOf(preference);
      const next = PREFERENCES[(index + 1) % PREFERENCES.length];
      this.set(next);
      return next;
    },

    onDidChange(listener) {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
  };
}
