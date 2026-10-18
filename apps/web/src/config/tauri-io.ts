/**
 * 桌面壳的配置文件后端 —— 走**原生命令**，不用 fs 插件。
 *
 * 为什么不用 @tauri-apps/plugin-fs：
 * fs 的 `{ path, options: { baseDir } }` 与纯绝对路径两种形态在 Windows 上
 * 都会报 "missing file path"（scope + 参数解析的边界问题），排查成本高。
 * 配置文件是"应用自己的数据"，用 std::fs 的命令更直接：mkdir_all + 原子写。
 *
 * 刻意**不静态 import** @tauri-apps/api：浏览器开发模式解析会失败，
 * 与 providers/tauri.ts 的做法一致 —— 走 globalThis 上的注入对象。
 */
import type { SettingsIo } from './settings.js';

interface TauriInternals {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

function internals(): TauriInternals | null {
  const candidate = (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return candidate ?? null;
}

/** 桌面壳是否可用（浏览器开发模式返回 false）。 */
export function hasTauri(): boolean {
  return internals() !== null;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const api = internals();
  if (!api) throw new Error('当前环境没有原生能力');
  return (await api.invoke(command, args)) as T;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
}

/** 用原生命令读写 ~/.aropyt/settings.jsonc。 */
export async function createTauriSettingsIo(): Promise<SettingsIo & { path: string }> {
  // 让原生侧解析家目录并确保 ~/.aropyt 存在，拿到绝对路径
  const path = await invoke<string>('settings_path').catch((error: unknown) => {
    throw new Error(`解析配置路径失败：${detailOf(error)}`);
  });

  return {
    path,
    async read() {
      const text = await invoke<string | null>('settings_read');
      return text ?? null;
    },
    async write(text) {
      await invoke('settings_write', { text }).catch((error: unknown) => {
        throw new Error(`写入配置失败：${detailOf(error)}`);
      });
    },
    async openExternal() {
      await invoke('plugin:opener|open_path', { path }).catch((error: unknown) => {
        throw new Error(`打开配置失败：${detailOf(error)}`);
      });
    },
  };
}
