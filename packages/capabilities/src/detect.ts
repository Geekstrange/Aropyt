/**
 * 运行时平台探测。
 *
 * 探测结果的用途不是"优化"，而是**决定 UI 展示什么、降级什么、禁用什么并说明原因**。
 * 这一点很重要：能力缺失时静默隐藏功能，是最让用户困惑的做法。
 *
 * ── 两个正交的维度 ──────────────────────────────────────
 *   platform = 操作系统（windows / macos / linux / android）
 *   shell    = 外壳（tauri / browser）
 *
 * 早期版本只有一个枚举，把这两件事混在一起，结果是"托盘插件"既不能表达
 * "我要在所有桌面系统上生效"，也不能在浏览器调试时优雅降级。现在拆开了。
 *
 * 注意：发布形态只有 Tauri（Windows / macOS / Linux / Android）。
 * `browser` 存在的唯一理由是开发模式 —— 改一行前端代码就能热更新，
 * 不必每次都走 Rust 工具链重新构建。它不是发布目标，所以不为它做能力承诺。
 */

import type { CapabilityName, CapabilityReport, PlatformKind, ShellKind } from './types.js';

const PICKER_METHODS = ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker'] as const;

type GlobalRecord = Record<string, unknown>;

function globalRecord(): GlobalRecord {
  return globalThis as unknown as GlobalRecord;
}

/** File System Access 的三个 picker 是一组出现的，缺一不可视为可用。 */
export function hasFileSystemAccess(): boolean {
  const global = globalRecord();
  return PICKER_METHODS.every((method) => typeof global[method] === 'function');
}

export function hasOpfs(): boolean {
  const storage = (navigator as unknown as { storage?: { getDirectory?: unknown } }).storage;
  return typeof storage?.getDirectory === 'function';
}

export function isTauri(): boolean {
  const global = globalRecord();
  return '__TAURI_INTERNALS__' in global || '__TAURI__' in global;
}

export function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

/** PWA 的 picker 只在安全上下文可用（https 或 localhost）。 */
export function isSecureContextOk(): boolean {
  return globalRecord().isSecureContext === true;
}

export function detectShell(): ShellKind {
  return isTauri() ? 'tauri' : 'browser';
}

/**
 * 探测宿主操作系统。
 *
 * 优先用 Tauri 提供的 os 插件信息（可靠，不靠 UA 猜），
 * 没有则退回 navigator 启发式 —— 后者只用于浏览器开发模式，精度够用。
 */
export function detectPlatform(): PlatformKind {
  if (isAndroid()) return 'android';

  // Tauri 注入了 __TAURI_OS_PLUGIN_INTERNALS__，里面带 platform 信息。
  const tauriOs = globalRecord().__TAURI_OS_PLUGIN_INTERNALS__ as
    | { readonly platform?: string }
    | undefined;
  const declared = tauriOs?.platform?.toLowerCase();
  if (declared === 'windows') return 'windows';
  if (declared === 'macos' || declared === 'darwin' || declared === 'ios') return 'macos';
  if (declared === 'linux') return 'linux';

  // 浏览器开发模式的启发式。顺序有讲究：Android 必须在 Linux 之前判，
  // 因为 Android 的 UA 里也含 "Linux"。
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
  if (/Linux|X11/i.test(ua)) return 'linux';

  // 兜底：开发环境几乎不会走到这里，但必须有确定值而不是 undefined ——
  // 插件会拿它做字符串比较，undefined 会静默走进错误的分支。
  return 'linux';
}

export function detectCapabilities(): CapabilityReport {
  const platform = detectPlatform();
  const shell = detectShell();
  const tauri = shell === 'tauri';

  // Tauri 下走Rust 原生 fs；浏览器形态下 FSA 可用就用 FSA，否则退到 OPFS。
  // 后者只服务于开发模式，不影响发布形态的能力承诺。
  const fsa = !tauri && hasFileSystemAccess() && isSecureContextOk();
  const folderAccess: CapabilityReport['folderAccess'] = tauri ? 'native' : fsa ? 'fsa' : 'opfs-only';

  const snapshot: Record<CapabilityName, boolean> = {
    'native-fs': tauri,
    'file-watch': tauri,
    'global-shortcut': tauri,
    tray: tauri,
    'file-associations': tauri,
    'clipboard-image-to-disk': tauri || fsa,
    'auto-update': tauri,
    worker: typeof Worker !== 'undefined',
  };

  return {
    platform,
    shell,
    folderAccess,
    fileWatch: snapshot['file-watch'],
    globalShortcut: snapshot['global-shortcut'],
    tray: snapshot.tray,
    fileAssociations: snapshot['file-associations'],
    clipboardImageToDisk: snapshot['clipboard-image-to-disk'],
    exportPdf: typeof globalThis.print === 'function',
    autoUpdate: tauri ? 'plugin' : 'none',
    snapshot,
  };
}

/** 给 UI 用：一句话解释当前平台缺了什么，而不是让功能神秘消失。 */
export function describeLimitations(report: CapabilityReport): readonly string[] {
  const notes: string[] = [];

  if (report.shell === 'browser') {
    notes.push('当前是浏览器开发模式：原生文件系统、托盘、文件监听均不可用，功能受限属预期。');
  }
  if (!report.fileWatch) {
    notes.push('当前环境不支持监听文件的外部改动，修改后的文件需要手动刷新。');
  }
  if (!report.tray) {
    notes.push('当前环境没有系统托盘，关闭窗口即退出应用。');
  }
  if (!report.globalShortcut) {
    notes.push('当前环境不支持全局快捷键，快捷键仅在应用获得焦点时生效。');
  }
  if (report.folderAccess === 'opfs-only') {
    notes.push('当前环境不支持直接打开本地文件夹，文件将保存在浏览器沙箱内。');
  }

  return notes;
}