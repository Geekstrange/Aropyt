/**
 * `SyncBackend` 的宿主实现 —— 把执行器的接口接到真实的文件系统与网络。
 *
 * 依赖全部注入（`LocalFs` / `RemoteDav`），而不是直接 import runtime：
 *  · runtime 有 3000 多行且持有大量状态，import 进来会把同步和它焊死；
 *  · 注入之后这一层仍然可以用假实现跑测试（`runner.ts` 的用例就是）。
 *
 * 远端那侧把 WebDAV 的 `href` 收在 `RemoteDav` 里面 —— `href` 的形态
 * （绝对 URL / 绝对路径 / 带尾斜杠）是协议细节，不该漏到同步逻辑里。
 */

import { idbGet, idbSet, STORE } from '@aropyt/core';
import type { SyncBackend } from './runner.js';

/**
 * 参与同步的扩展名。
 *
 * 只收文本：图片这类二进制要走 base64、还要考虑大文件，和"改一个字"
 * 完全不是同一个代价模型。将来把图片纳入时，比对也要先用 size 筛。
 */
const SYNC_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'tex',
  'latex',
  'ltx',
  'fountain',
]);

/** 存 base 快照的键。一张表只放一条 —— 多工作区并存时按根路径分键。 */
const BASE_PREFIX = 'base:';

export interface LocalEntry {
  readonly path: string;
  /** 与 `FileStat.kind` 对齐（`file` / `directory`）。 */
  readonly kind: string;
}

export interface LocalFs {
  list(dir: string): Promise<readonly LocalEntry[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
}

export interface RemoteEntry {
  /** 相对服务根的路径（`notes/a.md`），没有前导斜杠。 */
  readonly path: string;
  readonly isDir: boolean;
}

export interface RemoteDav {
  list(path: string): Promise<readonly RemoteEntry[]>;
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** 建目录（已存在视为成功）。写文件前用它保证父目录在。 */
  ensureDir(path: string): Promise<void>;
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot > 0 ? path.slice(dot + 1).toLowerCase() : '';
}

function parentOf(path: string): string | null {
  const slash = path.lastIndexOf('/');
  return slash > 0 ? path.slice(0, slash) : null;
}

/**
 * 生成后端。`rootKey` 用来隔离不同工作区的同步快照 ——
 * 两个项目各自的"上次同步状态"必须分开，否则 A 的哈希会被拿去判 B。
 */
export function createSyncBackend(options: {
  readonly local: LocalFs;
  readonly remote: RemoteDav;
  readonly rootKey: string;
}): SyncBackend {
  const { local, remote, rootKey } = options;
  const baseStoreKey = `${BASE_PREFIX}${rootKey}`;

  return {
    async readLocal() {
      const files = new Map<string, string>();

      /* 递归走目录：`list` 只给一层，而同步要的是整棵树 */
      const walk = async (dir: string): Promise<void> => {
        const entries = await local.list(dir);
        for (const entry of entries) {
          if (entry.kind === 'directory') {
            await walk(entry.path);
            continue;
          }
          if (!SYNC_EXTENSIONS.has(extensionOf(entry.path))) continue;
          try {
            files.set(entry.path, await local.read(entry.path));
          } catch {
            /*
             * 单个文件读不出来（编码不支持、被占用）不该让整轮同步失败：
             * 跳过它，其余文件照常同步。它会出现在下一次的清单里，
             * 届时仍然失败就已经是持续性问题，而不是偶发。
             */
            continue;
          }
        }
      };

      await walk('');
      return files;
    },

    async writeLocal(path, content) {
      await local.write(path, content);
    },

    async deleteLocal(path) {
      await local.delete(path);
    },

    async listRemote() {
      const paths = new Set<string>();

      const walk = async (dir: string): Promise<void> => {
        const entries = await remote.list(dir);
        for (const entry of entries) {
          /* 服务端会把自己这一层也列进来，跳过自引用 */
          if (entry.path === dir) continue;
          if (entry.isDir) {
            await walk(entry.path);
            continue;
          }
          if (!SYNC_EXTENSIONS.has(extensionOf(entry.path))) continue;
          paths.add(entry.path);
        }
      };

      await walk('');
      return paths;
    },

    async readRemote(path) {
      return remote.read(path);
    },

    async writeRemote(path, content) {
      /*
       * 父目录不存在时 PUT 会被服务端拒绝（409）。自顶向下的同步通常
       * 已经建好了目录，但"本地新建了一个文件夹里的文件"这一轮里
       * 目录还没建过，所以这里补一次 —— 405（已存在）在 Rust 侧算成功。
       */
      const parent = parentOf(path);
      if (parent) await remote.ensureDir(parent);
      await remote.write(path, content);
    },

    async deleteRemote(path) {
      await remote.remove(path);
    },

    async loadBase() {
      const stored = await idbGet<Record<string, string>>(STORE.sync, baseStoreKey).catch(
        () => undefined,
      );
      return new Map(Object.entries(stored ?? {}));
    },

    async saveBase(base) {
      await idbSet(STORE.sync, baseStoreKey, Object.fromEntries(base));
    },
  };
}
