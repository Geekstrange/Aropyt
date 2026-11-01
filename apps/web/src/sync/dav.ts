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

export interface RemoteDav {
  list(path: string): Promise<readonly { path: string; isDir: boolean }[]>;
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
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
  return {
    async list(path) {
      const entries = await invoke<DavEntry[]>('dav_list', { auth, path });
      const out: { path: string; isDir: boolean }[] = [];
      for (const entry of entries) {
        const relative = davRelativePath(entry.href, auth.url);
        /* 服务根自身与外部记录都会被这里滤掉 */
        if (!relative || relative === path) continue;
        out.push({ path: relative, isDir: entry.is_dir });
      }
      return out;
    },

    read(path) {
      return invoke<string | null>('dav_get', { auth, path });
    },

    async write(path, content) {
      await invoke('dav_put', { auth, path, content });
    },

    async remove(path) {
      await invoke('dav_delete', { auth, path });
    },

    async ensureDir(path) {
      await invoke('dav_mkcol', { auth, path });
    },
  };
}
