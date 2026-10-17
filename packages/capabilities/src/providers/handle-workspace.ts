/**
 * 基于 FileSystemDirectoryHandle 的工作区实现 —— File System Access 与 OPFS 共用。
 *
 * 为什么能共用：两者暴露的是**同一套 API**（`FileSystemDirectoryHandle`），
 * 区别只在根句柄从哪来 —— 一个是用户通过 picker 授权的真实目录，
 * 另一个是 `navigator.storage.getDirectory()` 给的沙箱目录。
 *
 * 既然底层相同，就没有理由写两遍。这也意味着"Android 上文件访问受限"
 * 这件事在代码里只体现为一处差异：根句柄的来源，以及权限能否持久化。
 */

import {
  assertSafePath,
  baseName,
  joinPath,
  splitPath,
  type FileStat,
  type Workspace,
} from '../types.js';

export interface WritableStreamLike {
  /** 入参类型刻意放宽：只声明我们实际用到的 string / Uint8Array / Blob 三种。 */
  write(data: unknown): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
}

export interface HandleFile {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableStreamLike>;
}

export interface HandleDirectory {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<HandleDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<HandleFile>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterableIterator<HandleFile | HandleDirectory>;
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export async function ensurePermission(
  handle: HandleDirectory,
  mode: 'read' | 'readwrite',
  request: boolean,
): Promise<boolean> {
  // OPFS 的句柄没有权限方法 —— 沙箱内的访问天然被授予。
  if (!handle.queryPermission) return true;

  const current = await handle.queryPermission({ mode });
  if (current === 'granted') return true;
  if (!request || !handle.requestPermission) return false;

  return (await handle.requestPermission({ mode })) === 'granted';
}

async function resolveDirectory(
  root: HandleDirectory,
  path: string,
  create: boolean,
): Promise<HandleDirectory> {
  assertSafePath(path);
  let current = root;
  for (const segment of splitPath(path)) {
    current = await current.getDirectoryHandle(segment, { create });
  }
  return current;
}

async function resolveFile(
  root: HandleDirectory,
  path: string,
  create: boolean,
): Promise<HandleFile> {
  assertSafePath(path);
  const segments = splitPath(path);
  const fileName = segments.pop();
  if (fileName === undefined) throw new Error(`不是文件路径：${path}`);

  let current = root;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create });
  }
  return current.getFileHandle(fileName, { create });
}

export function createHandleWorkspace(root: HandleDirectory, providerId: string): Workspace {
  const name = root.name || (providerId === 'opfs' ? '浏览器沙箱' : '工作区');

  return {
    id: `${providerId}:${name}`,
    name,
    providerId,

    async stat(path: string): Promise<FileStat> {
      assertSafePath(path);
      if (path === '') {
        return { path: '', name, kind: 'directory', size: 0, mtime: 0 };
      }

      const segments = splitPath(path);
      const last = segments[segments.length - 1];

      try {
        const file = await resolveFile(root, path, false);
        const blob = await file.getFile();
        return { path, name: last, kind: 'file', size: blob.size, mtime: blob.lastModified };
      } catch {
        await resolveDirectory(root, path, false);
        return { path, name: last, kind: 'directory', size: 0, mtime: 0 };
      }
    },

    async list(dirPath: string): Promise<readonly FileStat[]> {
      const directory = await resolveDirectory(root, dirPath, false);
      const entries: FileStat[] = [];

      for await (const entry of directory.values()) {
        const entryPath = joinPath(dirPath, entry.name);
        if (entry.kind === 'directory') {
          entries.push({ path: entryPath, name: entry.name, kind: 'directory', size: 0, mtime: 0 });
          continue;
        }

        // 文件树要显示大小和修改时间，只能真的读一次元数据。
        // markdown 工作区的目录通常只有几十个文件，这个代价可以接受；
        // 真遇到上万文件的目录，应该走 runChunked 切片而不是在这里优化。
        const blob = await entry.getFile().catch(() => null);
        entries.push({
          path: entryPath,
          name: entry.name,
          kind: 'file',
          size: blob?.size ?? 0,
          mtime: blob?.lastModified ?? 0,
        });
      }

      return entries.sort(compareEntries);
    },

    async read(path: string): Promise<string> {
      const file = await resolveFile(root, path, false);
      return (await file.getFile()).text();
    },

    async readBytes(path: string): Promise<Uint8Array> {
      const file = await resolveFile(root, path, false);
      return new Uint8Array(await (await file.getFile()).arrayBuffer());
    },

    async write(path: string, content: string): Promise<void> {
      const file = await resolveFile(root, path, true);
      // createWritable 的语义是"写临时文件，close 时才提交" ——
      // 这正是我们需要的原子性，而且由浏览器保证，比我们自己实现更可靠。
      const writable = await file.createWritable();
      try {
        await writable.write(content);
      } finally {
        await writable.close();
      }
    },

    async writeBytes(path: string, data: Uint8Array): Promise<void> {
      const file = await resolveFile(root, path, true);
      const writable = await file.createWritable();
      try {
        await writable.write(data);
      } finally {
        await writable.close();
      }
    },

    async createDirectory(path: string): Promise<void> {
      await resolveDirectory(root, path, true);
    },

    async remove(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
      assertSafePath(path);
      const segments = splitPath(path);
      const last = segments.pop();
      if (last === undefined) throw new Error('不能删除工作区根目录');

      const parent = await resolveDirectory(root, segments.join('/'), false);
      await parent.removeEntry(last, options?.recursive ? { recursive: true } : undefined);
    },
  };
}

function compareEntries(a: FileStat, b: FileStat): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

export { baseName };
