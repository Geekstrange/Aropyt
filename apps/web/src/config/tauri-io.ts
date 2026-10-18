/**
 * 桌面壳的配置文件后端。
 *
 * 刻意**不静态 import @tauri-apps/api 或 plugin-fs**：浏览器开发模式下这些
 * 模块解析会失败，而开发模式必须能跑（与 providers/tauri.ts 的做法一致）。
 * 走 globalThis 上的注入对象，命令名用 plugin:xxx|yyy 形式。
 *
 * 写文件是**原子**的：先写 .tmp 再 rename —— 断电/崩溃不会留下半截 JSONC。
 */
import type { SettingsIo } from './settings.js';
import { SETTINGS_FILE } from './settings.js';

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

/**
 * appConfigDir 的绝对路径（末尾无分隔符）。
 *
 * ⚠️ `directory` 参数是 **BaseDirectory 枚举的数值**（u16），不是字符串 ——
 * 传 'AppConfig' 会被 IPC 校验拒绝：`expected u16`（实测报错）。
 * Tauri 2 的枚举顺序（Audio=1, Cache, Config, Data, LocalData, Document,
 * Download, Picture, Public, Video, Resource, Temp, **AppConfig=13** …）。
 * 这个数值是版本敏感点：升级 Tauri 大版本时要复核。
 */
const BASE_DIRECTORY_APP_CONFIG = 13;

async function configDir(): Promise<string> {
  const dir = await invoke<string>('plugin:path|resolve_directory', {
    directory: BASE_DIRECTORY_APP_CONFIG,
  });
  return dir.replace(/[\\/]+$/, '');
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${dir}${sep}${name}`;
}

async function ensureDir(dir: string): Promise<void> {
  await invoke('plugin:fs|mkdir', { path: dir, recursive: true }).catch(() => undefined);
}

/** 用原生能力读写 settings.jsonc。 */
export async function createTauriSettingsIo(): Promise<SettingsIo & { path: string }> {
  const dir = await configDir();
  const path = joinPath(dir, SETTINGS_FILE);
  const tmp = `${path}.tmp`;

  return {
    path,
    async read() {
      try {
        const text = await invoke<string>('plugin:fs|read_text_file', { path });
        return text;
      } catch {
        // 文件不存在（或读不了）→ 交给上层走"首次启动迁移"
        return null;
      }
    },
    async write(text) {
      await ensureDir(dir);
      // 注意：fs 插件的 write_text_file 接受字节数组
      const bytes = Array.from(new TextEncoder().encode(text));
      await invoke('plugin:fs|write_text_file', { path: tmp, data: bytes });
      // rename 覆盖：Windows 上目标存在时 rename 会失败，先尽力删除旧文件
      await invoke('plugin:fs|remove', { path }).catch(() => undefined);
      await invoke('plugin:fs|rename', { oldPath: tmp, newPath: path });
    },
    async openExternal() {
      await invoke('plugin:opener|open_path', { path });
    },
  };
}
