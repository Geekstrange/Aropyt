/**
 * Tauri 原生文件系统工作区。
 *
 * 这是**发布形态下的唯一工作区实现** —— Windows / macOS / Linux / Android
 * 四个平台全部走这里。浏览器形态（FSA / OPFS）只剩开发模式在用。
 *
 * 与 FSA 实现的关系：两者的路径语义必须完全一致 ——
 * POSIX 分隔符、相对根目录、根为空串。文件树、大纲、链接解析都建立在这个约定上，
 * 两端只要有一处不一致，路径穿越防护就会出现缺口。
 *
 * 为什么值得单独写而不是复用 handle-workspace：
 *   - 原子写。Web侧没有等价物，这是桌面端最实在的优势。
 *   - 不需要权限持久化。FSA 每次启动都要重新授权用户目录，
 *     Tauri 侧记下路径即可，IndexedDB 里那套 regrant 逻辑整个不需要。
 */

import {
  assertSafePath,
  baseName,
  parentPath,
  type FileStat,
  type Workspace,
} from '../types.js';

/** Tauri 注入的 IPC 桥。不直接依赖 @tauri-apps/api —— 那是运行时依赖，不该进类型层。 */
interface TauriBridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** 带类型的 invoke 包装。IPC 的返回值本质是 unknown，断言集中在这一个函数里。 */
async function invokeAs<T>(api: TauriBridge, command: string, args?: Record<string, unknown>): Promise<T> {
  return (await api.invoke(command, args)) as T;
}

interface NativeFileEntry {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  size: number;
  mtime: number;
}

interface NativeWorkspaceDescriptor {
  readonly id: string;
  readonly name: string;
  readonly root: string;
}

/**
 * 取Tauri 注入的 invoke。
 *
 * 刻意用 globalThis 而不是 import：@tauri-apps/api 是运行期注入的，
 * 静态 import 在浏览器开发模式下会解析失败，而开发模式必须能用。
 */
function bridge(): TauriBridge | null {
  const internals = (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ as
    | { invoke?: TauriBridge['invoke'] }
    | undefined;

  const invoke = internals?.invoke;
  if (typeof invoke !== 'function') return null;

  // __TAURI_INTERNALS__.invoke 需要正确的 this 绑定，直接取出再调用会丢上下文。
  return { invoke: (command, args) => invoke.call(internals, command, args) };
}

export function isNativeAvailable(): boolean {
  return bridge() !== null;
}

/**
 * 选一张图片并导入工作区。
 *
 * 只走原生：浏览器的 File System Access 也能做，但那需要把
 * "选文件"与"写进工作区"两件事分别暴露给上层 —— 那正是我们想避免的
 * （见 plugin-api 里 importImage 的注释）。桌面端是发布形态，
 * 浏览器只是开发模式，所以这里不做降级实现。
 */
export async function importImageNative(
  targetDir: string,
): Promise<{ path: string; name: string; bytes: number } | null> {
  const api = bridge();
  if (!api) return null;
  return invokeAs<{ path: string; name: string; bytes: number } | null>(api, 'import_image', {
    args: { targetDir },
  });
}

/**
 * 工作区 id 的前缀。
 *
 * id 里带上了根路径，因为**恢复上次工作区需要它**：
 * FSA 把目录句柄存进 IndexedDB 就够了，而原生侧的根路径只存在于
 * Rust 的 managed state 里 —— 进程重启就没了，必须自己记一份。
 */
const ID_PREFIX = 'tauri:';

export function tauriWorkspaceId(root: string): string {
  return `${ID_PREFIX}${root}`;
}

/**
 * 从 id 或裸路径里取出根路径。
 *
 * 两种输入都接受是有意的：启动恢复时拿到的是上次存下的 id，
 * 而插件或配置也可能给出一个裸路径。让这一处兼容，
 * 好过让每个调用点都记得先判断格式。
 */
function rootFromHint(hint: string): string {
  return hint.startsWith(ID_PREFIX) ? hint.slice(ID_PREFIX.length) : hint;
}

/**
 * 字节→ base64。
 *
 * **必须分块**：`String.fromCharCode(...bytes)` 在数组长度到六位数量级时会
 * 直接爆调用栈（"Maximum call stack size exceeded"）。一张手机照片轻松
 * 超过这个量级，所以展开写法在这里是个定时炸弹。CHUNK 取 0x8000 是
 * 任意安全值，唯一要求是小于引擎的参数上限。
 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 → 字节。Rust 侧保证输出是 RFC 4648 标准字母表且无换行。 */
function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

class NativeWorkspace implements Workspace {
  readonly id: string;
  readonly name: string;
  readonly providerId = 'tauri';
  readonly #api: TauriBridge;

  /**
   * @param descriptor.root 已在 Rust 侧注册过的根路径。
   *   Web 侧不再保存它 —— 所有路径解析都在 Rust 侧做（resolve + assertSafePath），
   *   双份保存只会带来"两边不一致"的窗口。
   */
  constructor(api: TauriBridge, descriptor: NativeWorkspaceDescriptor) {
    this.#api = api;
    this.id = descriptor.id;
    this.name = descriptor.name;
  }

  /**
   * 取单个条目信息。
   *
   * 实现方式是列父目录再按名字匹配 —— 因为 Rust 侧只暴露了 list/read/write
   * 三个命令，没有单独的 metadata 查询。加 stat 命令会多一条IPC 往返，
   * 而这个接口目前的调用点（文件树渲染、文件打开前的存在性检查）
   * 本来就要列目录，顺带拿到信息更划算。
   *
   * 注意：列父目录失败（目录不存在）与条目不存在是两种情况，
   * 前者向上抛错，后者返回一个"不存在"的哨兵值。
   */
  async stat(path: string): Promise<FileStat> {
    assertSafePath(path);
    const name = baseName(path);
    if (!name) throw new Error(`无法 stat 工作区根目录：${path}`);

    const siblings = await invokeAs<NativeFileEntry[]>(this.#api, 'workspace_list', {
      args: { path: parentPath(path) },
    });
    const found = siblings.find((entry) => entry.name === name);

    if (!found) throw new Error(`路径不存在：${path}`);

    return {
      path: found.path,
      name: found.name,
      kind: found.kind,
      size: found.size,
      mtime: found.mtime,
    };
  }

  async list(dirPath: string): Promise<readonly FileStat[]> {
    assertSafePath(dirPath);
    const entries = await invokeAs<NativeFileEntry[]>(this.#api, 'workspace_list', {
      args: { path: dirPath },
    });
    return entries.map((entry) => ({
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      size: entry.size,
      mtime: entry.mtime,
    }));
  }

  async read(path: string): Promise<string> {
    assertSafePath(path);
    return invokeAs<string>(this.#api, 'workspace_read', { args: { path } });
  }

  async readBytes(path: string): Promise<Uint8Array> {
    assertSafePath(path);
    /*
     * 走 workspace_read_base64，**不能**走 workspace_read。
     *
     * 这里原来是 `const text = await this.read(path)` —— 把任意字节交给
     * UTF-8 解码，PNG 的 0x89 之类会变成替换字符，而且**调用是成功的**。
     * 那个 bug 在"粘贴 base64 图片"那条路上看不见（那边本来就是文本），
     * 只在真正搬运原始字节时才现形，而且表现为"图片显示不出来"，
     * 完全没有报错指向这里。
     */
    const encoded = await invokeAs<string>(this.#api, 'workspace_read_base64', { args: { path } });
    return base64ToBytes(encoded);
  }

  /** 原子写。Rust 侧做 write-tmp → fsync → rename。 */
  async write(path: string, content: string): Promise<void> {
    assertSafePath(path);
    await invokeAs<void>(this.#api, 'workspace_write', { args: { path, content } });
  }

  /**
   * 二进制写。
   *
   * 走 base64，与 readBytes 对称。**不能**按 UTF-8 解码后交给
   * `workspace_write` —— 那条路会把文件损坏，而且是"写成功"地损坏，
   * 用户要到打开那张图时才发现。两侧都用同一套编解码才不会有人踩。
   */
  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    assertSafePath(path);
    await invokeAs<void>(this.#api, 'workspace_write_base64', {
      args: { path, base64: bytesToBase64(data) },
    });
  }

  /**
   * 创建空目录。
   *
   * 未接入：Rust 侧没有对应命令。但注意—— **写入文件时父目录会自动创建**，
   * 所以绝大多数场景感知不到这个缺口。真正需要它的是"建一个空文件夹"这种操作。
   */
  async createDirectory(path: string): Promise<void> {
    assertSafePath(path);
    throw new Error(
      '原生适配器尚未支持创建空目录（写入文件时会自动创建父目录，此缺口仅影响显式建空文件夹）',
    );
  }

  /** 删除文件或目录。未接入。 */
  async remove(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    assertSafePath(path);
    void options;
    throw new Error('原生适配器尚未支持删除操作');
  }
}

export const tauriProvider = {
  id: 'tauri',
  label: '本地文件夹',

  isAvailable(): boolean {
    return isNativeAvailable();
  },

  async pick(): Promise<Workspace | null> {
    const api = bridge();
    if (!api) return null;

    const root = await invokeAs<string | null>(api, 'pick_folder');
    if (!root) return null;

    await invokeAs<void>(api, 'set_workspace', { root });
    return openNativeWorkspace(root);
  },

  /**
   * 恢复上次工作区。
   *
   * 与 FSA 的关键差异：这里**不需要重新授权**。
   * Tauri 侧直接用文件系统权限，记住路径即可 ——
   * 所以 FSA 那套"句柄存入 IndexedDB + regrant 流程"整个不适用于本平台。
   */
  async restore(lastRoot: string | null): Promise<Workspace | null> {
    const api = bridge();
    if (!api || !lastRoot) return null;

    const root = rootFromHint(lastRoot);
    try {
      await invokeAs<void>(api, 'set_workspace', { root });
    } catch {
      // 目录可能已被删除或改名。静默失败即可 —— 上层会退回"未打开工作区"，
      // 不该弹错误打扰用户。
      return null;
    }
    return openNativeWorkspace(root);
  },
};

/**
 * 把一个绝对目录设为工作区。
 *
 * "打开文件"要用到：选定文件后，把它所在的目录设为工作区，
 * 文件树就能显示它的邻居们。复用 restore 的 set_workspace 路径
 * 会让语义变得莫名其妙，所以单独导出。
 */
export async function openNativeFolderAsWorkspace(root: string): Promise<Workspace | null> {
  const api = bridge();
  if (!api) return null;
  await invokeAs<void>(api, 'set_workspace', { root });
  return openNativeWorkspace(root);
}

/** 选一个 Markdown 文件，返回它的绝对路径。宿主用它推导工作区。 */
export async function pickMarkdownFileNative(): Promise<string | null> {
  const api = bridge();
  if (!api) return null;
  return invokeAs<string | null>(api, 'pick_markdown_file');
}

/**
 * 选一个保存位置（另存为），返回目标绝对路径；用户取消时返回 null。
 *
 * 未命名文档（刚开的应用）没有关联路径，保存必须先把路径问出来 ——
 * 这条命令就是那个"问"的动作，和 `pickMarkdownFileNative` 完全对称。
 *
 * `suggested` 是对话框里的默认文件名：给一个总比给空白强，
 * 用户改比从零想快。
 */
export async function pickSavePathNative(suggested?: string): Promise<string | null> {
  const api = bridge();
  if (!api) return null;
  return invokeAs<string | null>(api, 'save_markdown_file', {
    suggested: suggested ?? null,
  });
}

async function openNativeWorkspace(root: string): Promise<Workspace> {
  const api = bridge();
  if (!api) throw new Error('Tauri 运行时不可用');

  const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
  return new NativeWorkspace(api, { id: tauriWorkspaceId(root), name, root });
}