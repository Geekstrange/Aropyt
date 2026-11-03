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

import { idbGet, idbSet, recordRemoteVersion, STORE } from '@aropyt/core';
import type { RemoteDav } from './dav.js';
import type { BaseEntry, RemoteMeta, SyncBackend } from './runner.js';

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
  /* 图片：文档里的 `![](assets/a.png)` 到了另一台机器必须是能显示的图，
     而不是一条断链。传输走 base64（见 `dav_put_bytes`）。 */
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'avif',
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
  /** 读原始字节。文本文件就是它的 UTF-8 序列。 */
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
}

/* `RemoteDav` 的形状由 `dav.ts` 定义（它握着 href 的转换），这里直接用。 */

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
  /* 与 base 分键：一个描述内容，一个描述"这些文件我们决定不删" */
  const keptStoreKey = `kept:${rootKey}`;

  return {
    async readLocal() {
      const files = new Map<string, Uint8Array>();

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
            files.set(entry.path, await local.readBytes(entry.path));
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

    async writeLocal(path, bytes) {
      await local.writeBytes(path, bytes);
    },

    async deleteLocal(path) {
      await local.delete(path);
    },

    async listRemote() {
      const metas = new Map<string, RemoteMeta>();

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
          metas.set(entry.path, { size: entry.size, modified: entry.modified });
        }
      };

      await walk('');
      return metas;
    },

    async readRemote(path) {
      return remote.readBytes(path);
    },

    async writeRemote(path, bytes) {
      /*
       * 父目录不存在时 PUT 会被服务端拒绝（409）。自顶向下的同步通常
       * 已经建好了目录，但"本地新建了一个文件夹里的文件"这一轮里
       * 目录还没建过，所以这里补一次 —— 405（已存在）在 Rust 侧算成功。
       */
      /*
       * `parentOf('a.md')` 是空字符串（文件就在工作区根下），而那一层
       * 恰恰是最需要建的：每棵子树第一次被使用时都还没存在。传空串给
       * `ensureDir`，它会 MKCOL 子树本身。
       */
      await remote.ensureDir(parentOf(path) ?? '');
      await remote.writeBytes(path, bytes);
    },

    async deleteRemote(path) {
      await remote.remove(path);
    },

    async loadBase() {
      const stored = await idbGet<Record<string, BaseEntry | string>>(
        STORE.sync,
        baseStoreKey,
      ).catch(() => undefined);

      const out = new Map<string, BaseEntry>();
      for (const [path, value] of Object.entries(stored ?? {})) {
        /*
         * 兼容旧快照：早先存的是纯哈希字符串。当成"没有元信息"处理 ——
         * 表现是下一轮多下载一次，而不是把它误判成"没变"。
         */
        if (typeof value === 'string') out.set(path, { hash: value });
        else if (value && typeof value.hash === 'string') out.set(path, value);
      }
      return out;
    },

    async saveBase(base) {
      await idbSet(STORE.sync, baseStoreKey, Object.fromEntries(base));
    },

    async loadKept() {
      const stored = await idbGet<string[]>(STORE.sync, keptStoreKey).catch(() => undefined);
      return new Set(Array.isArray(stored) ? stored : []);
    },

    async saveKept(kept) {
      await idbSet(STORE.sync, keptStoreKey, [...kept]);
    },

    async saveConflict(path, bytes, at) {
      /*
       * 写进编辑历史，标 `source: 'remote'` —— 不落在工作区。
       *
       * 落成 `.conflict-….md` 的旧做法会让副本出现在文件树里、下一轮
       * 同步再把它传上去，于是冲突会自我繁殖；历史面板本来就是"找回
       * 旧内容"的地方。
       */
      /*
       * 历史表的正文列是 `text`，二进制进不去。
       *
       * 图片冲突时**远端那一份不保留**——但本地文件没动，用户的内容
       * 不会丢，只是没有"另一个版本"可对比。`fatal: true` 让解码失败
       * 抛错而不是悄悄产出替换字符。
       */
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return;
      }
      await recordRemoteVersion(path, text, at);
    },
  };
}
