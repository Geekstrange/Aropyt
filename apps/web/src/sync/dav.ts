/**
 * WebDAV 适配层 —— 把原生命令包成 `RemoteDav`，并消化 `href` 的形态差异。
 *
 * ── 为什么 href 要单独处理 ────────────────────────────────
 * PROPFIND 返回的 `href` 有三种合法形态（RFC 4918 都允许）：
 *
 *   https://dav.example.com/dav/notes/a.md    绝对 URL
 *   /dav/notes/a.md                           绝对路径
 *   notes/a.md                                相对路径
 *
 * 而同步逻辑只认一种：`notes/a.md`（相对服务根）。用字符串前缀剥离会有
 * 一堆边界（base 带不带尾斜杠、href 带不带、百分号编码、Windows 盘符混进
 * 来），所以统一走 `URL` 解析：它天生处理相对与绝对、也会归一编码。
 */

export interface DavAuth {
  /** 服务根，**不带**子目录（子目录已由调用方拼好）。 */
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

export interface DavEntry {
  readonly href: string;
  readonly is_dir: boolean;
  readonly size: number;
  readonly modified?: string | null;
}

/** 列目录时带回的元信息：同步靠它跳过没变的文件。 */
export interface DavListEntry {
  readonly path: string;
  readonly isDir: boolean;
  readonly size: number;
  readonly modified: string | null;
}

/** base64 解码成字节。浏览器 `atob` 给的是"每字符一字节"的二进制串。 */
function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * 字节编码成 base64。
 *
 * 分块处理：`String.fromCharCode(...bytes)` 在几十万字节时会因为参数
 * 过多直接栈溢出，而一张照片轻松超过那个上限。
 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export interface RemoteDav {
  list(path: string): Promise<readonly DavListEntry[]>;
  /** 读原始字节。文本文件就是它的 UTF-8 序列。 */
  readBytes(path: string): Promise<Uint8Array | null>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
}

/**
 * 把 `href` 折成"相对服务根"的路径。
 *
 * 返回 `null` 表示这条记录不属于这个服务根（跨源、或路径不在 base 之下）——
 * 调用方应当**忽略**而不是报错：有些服务端会在 Depth 1 里带上自己根目录
 * 之外的东西（例如另一块挂载点）。
 */
export function davRelativePath(href: string, baseUrl: string): string | null {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }

  let target: URL;
  try {
    /* 第二个参数让它同时接受绝对 URL、绝对路径与相对路径 */
    target = new URL(href, base);
  } catch {
    return null;
  }

  if (target.origin !== base.origin) return null;

  /* base 的 path 统一补一个尾斜杠，避免 `/dav` 前缀匹配到 `/dav2/x` */
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  if (!target.pathname.startsWith(basePath)) return null;

  let rest = target.pathname.slice(basePath.length);
  /* 目录的 href 通常带尾斜杠，同步层不要它 */
  rest = rest.replace(/\/+$/, '');
  if (rest.length === 0) return null; // 服务根自身

  try {
    return decodeURIComponent(rest);
  } catch {
    /* 百分号编码非法时原样返回：宁可路径对不上，也不让一次同步整体崩掉 */
    return rest;
  }
}

/** 把服务根与子目录拼成一个 base URL，保证中间只有一个斜杠。 */
export function joinBaseUrl(root: string, subPath: string): string {
  const trimmedRoot = root.trim();
  if (!trimmedRoot) return '';
  const trimmedSub = subPath.trim().replace(/^\/+|\/+$/g, '');
  const rootWithSlash = trimmedRoot.endsWith('/') ? trimmedRoot : `${trimmedRoot}/`;
  return trimmedSub ? `${rootWithSlash}${trimmedSub}/` : rootWithSlash;
}

/** 调用原生命令的签名（与 runtime 的 `invokeNative` 一致）。 */
export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * 生成 `RemoteDav`。
 *
 * 所有 `href` 在这里就地转换，同步层永远只看到 `notes/a.md` 这种形式 ——
 * 协议细节不往上漏。
 */
export function createRemoteDav(invoke: Invoke, auth: DavAuth): RemoteDav {
  /* 本次同步里已经确认存在的目录，避免每个文件都发一次 MKCOL */
  const ensured = new Set<string>();

  return {
    async list(path) {
      let entries: DavEntry[];
      try {
        entries = await invoke<DavEntry[]>('dav_list', { auth, path });
      } catch (error) {
        /*
         * 404 = 这个目录还不存在，**不是错误**。
         *
         * 每个工作区在远端有自己的子树（`test-9wxtej/`），它要到第一次
         * 调用 `ensureDir` 才会被建出来。首次同步时 `listRemote` 先跑，
         * 撞上 404 就整轮失败 —— 那意味着"新工作区永远没法完成第一次
         * 同步"。空目录与不存在的目录对同步而言是同一件事。
         */
        const detail = error instanceof Error ? error.message : String(error);
        if (detail.includes('404')) return [];
        throw error;
      }

      const out: DavListEntry[] = [];
      for (const entry of entries) {
        const relative = davRelativePath(entry.href, auth.url);
        /* 服务根自身与外部记录都会被这里滤掉 */
        if (!relative || relative === path) continue;
        out.push({
          path: relative,
          isDir: entry.is_dir,
          size: entry.size,
          modified: entry.modified ?? null,
        });
      }
      return out;
    },

    async readBytes(path) {
      /*
       * 走 `dav_get_bytes`（base64）而不是 `dav_get`（纯文本）：
       * 后者让 Rust 侧按 UTF-8 解码响应体，图片会在这里就已经损坏，
       * 而且**不报错** —— 要到显示成裂图才发现。
       */
      const encoded = await invoke<string | null>('dav_get_bytes', { auth, path });
      return encoded === null ? null : base64ToBytes(encoded);
    },

    async writeBytes(path, bytes) {
      await invoke('dav_put_bytes', { auth, path, base64: bytesToBase64(bytes) });
    },

    async remove(path) {
      await invoke('dav_delete', { auth, path });
    },

    async ensureDir(path) {
      /*
       * 逐级建。RFC 4918 的 MKCOL 只建**一层**：父目录不存在时返回 409，
       * 所以 `a/b/c` 要先建 `a`、再 `a/b`、再 `a/b/c`。
       *
       * 405（已存在）在 Rust 侧已当成功；其余错误在这里静默忽略 ——
       * 目录真建不出来时，随后那次 PUT 的报错比这里更有信息量。
       *
       * 已经建过的路径记在 `ensured` 里：每写一个文件都会调一次，不缓存
       * 就会在服务端日志里刷出一串 405（实测：13 个文件 = 13 次 MKCOL）。
       * 缓存只在本次同步内有效，下一次运行重新建一遍也无妨。
       */
      if (ensured.has(path)) return;
      ensured.add(path);

      const parts = path.split('/').filter(Boolean);
      if (parts.length === 0) {
        /*
         * 空路径 = 工作区自己的那棵子树。`auth.url` 已经拼过子树路径，
         * 所以 MKCOL 的是它本身，不会碰到服务根。
         *
         * 这一层原来没人建：`writeRemote` 只在父目录非空时调 `ensureDir`，
         * 而"文件直接放在工作区根下"正是空父目录 —— 首次同步的 PROPFIND
         * 因此永远是 404，PUT 也全被 409 拒掉。
         */
        await invoke('dav_mkcol', { auth, path: '' }).catch(() => undefined);
        return;
      }
      let current = '';
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        await invoke('dav_mkcol', { auth, path: current }).catch(() => undefined);
      }
    },
  };
}
