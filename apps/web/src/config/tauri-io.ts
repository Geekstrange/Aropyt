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
/** BaseDirectory.Home = 21（枚举顺序同上，Audio=1 起数）。 */
const BASE_DIRECTORY_HOME = 21;

/** 配置目录：`<用户家目录>/.aropyt`（用户要求放家目录，便于备份与手改）。 */
async function configDir(): Promise<string> {
  const home = await invoke<string>('plugin:path|resolve_directory', {
    directory: BASE_DIRECTORY_HOME,
  });
  const base = home.replace(/[\\/]+$/, '');
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base}${sep}.aropyt`;
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${dir}${sep}${name}`;
}

async function ensureDir(dir: string): Promise<void> {
  // 目录已存在时 mkdir 会报错，这是预期情况；其它错误必须往上抛
  await invoke('plugin:fs|mkdir', { path: dir, recursive: true }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/exist/i.test(message)) return;
    throw error;
  });
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
      /*
       * 分步 try/catch：每一步失败都带上步骤名与路径。
       * 只包一层的话，"配置文件永远不生成"这类问题完全无法定位
       * （此前连续三轮卡在这里，就是因为错误被合并成了一句话）。
       */
      const step = async (name: string, run: () => Promise<unknown>): Promise<void> => {
        try {
          await run();
        } catch (error) {
          const detail =
            error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
          throw new Error(`${name} 失败：${detail}`);
        }
      };
      await step(`mkdir(${dir})`, () => ensureDir(dir));
      const bytes = Array.from(new TextEncoder().encode(text));
      await step(`write(${tmp})`, () => invoke('plugin:fs|write_text_file', { path: tmp, data: bytes }));
      // 目标已存在时 Windows 的 rename 可能失败，先尽力删除
      await invoke('plugin:fs|remove', { path }).catch(() => undefined);
      await step(`rename(${tmp} → ${path})`, () => invoke('plugin:fs|rename', { oldPath: tmp, newPath: path }));
    },
    async openExternal() {
      await invoke('plugin:opener|open_path', { path });
    },
  };
}
