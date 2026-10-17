/**
 * 能力适配层的类型定义。
 *
 * 这一层存在的唯一理由是：内核必须纯浏览器可运行，而"打开一个文件夹"
 * 这件事在不同宿主上要用完全不同的机制完成。
 *
 *   发布形态（Tauri）：Windows / macOS / Linux / Android
 *     → 全部走 Rust 侧原生 fs，四端行为一致
 *
 *   开发形态（浏览器，npm run dev）：仅为了热更新调试
 *     → File System Access API，不可用时退到 OPFS 沙箱
 *
 * 所以接口设计成"能降级"：provider 声明自己 isAvailable，
 * 不可用时上层明确告知用户原因，而不是让功能神秘消失。
 */

import type {
  CapabilityName,
  PlatformKind,
  ShellKind,
  WorkspaceFileHandle,
  WorkspaceFileStat,
} from '@aropyt/plugin-api';

export type { CapabilityName, PlatformKind, ShellKind };
export type { WorkspaceFileStat };

export type PathKind = 'file' | 'directory';

/** 工作区内的相对路径，POSIX 风格，根目录为空串。 */
export type FileStat = WorkspaceFileStat;

/**
 * 工作区抽象。
 *
 * 所有实现共享同一套路径语义：POSIX 分隔符、相对根目录、根为空串。
 * 这样上层的文件树、大纲、搜索、链接解析都不需要知道底下是什么。
 */
export type Workspace = WorkspaceFileHandle;

export interface WorkspaceProvider {
  /** `tauri` / `fsa` / `opfs` */
  readonly id: string;
  readonly label: string;
  /** 该能力是否可用。为 false 时上层应展示原因而非静默隐藏。 */
  isAvailable(): boolean;
  /** 用户显式选择。返回 null 表示用户取消。 */
  pick(): Promise<Workspace | null>;
  /**
   * 尝试恢复上次的工作区。
   *
   * `lastRoot` 由调用方给出（来自配置：工作区根路径 + 各平台自己的句柄数据）。
   * 为什么不让 provider 自己找：不同平台的"上次位置"存在不同的地方 ——
   * Tauri 只需一个路径字符串，FSA 还需要 IndexedDB 里的目录句柄，
   * OPFS 则有自己的一套。差异留在各自实现里，契约只负责把线索递进来。
   */
  restore?(lastRoot: string | null): Promise<Workspace | null>;
}

/** 平台能力报告。UI 直接读它来决定展示、降级还是禁用 + 说明。 */
export interface CapabilityReport {
  readonly platform: PlatformKind;
  /** 外壳。`browser` 仅用于开发模式，不是发布形态。 */
  readonly shell: ShellKind;
  readonly folderAccess: 'native' | 'fsa' | 'opfs-only';
  readonly fileWatch: boolean;
  readonly globalShortcut: boolean;
  readonly tray: boolean;
  readonly fileAssociations: boolean;
  readonly clipboardImageToDisk: boolean;
  readonly exportPdf: boolean;
  readonly autoUpdate: 'plugin' | 'service-worker' | 'store' | 'none';
  /** 交给插件用的快照。键一定存在，值表示是否可用。 */
  readonly snapshot: Readonly<Record<CapabilityName, boolean>>;
}

/** 路径工具。集中在一处，避免每个 provider 各写一份。 */
export function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '' && segment !== '.');
}

export function joinPath(...segments: readonly string[]): string {
  return segments.filter((s) => s !== '').join('/');
}

export function parentPath(path: string): string {
  const segments = splitPath(path);
  segments.pop();
  return segments.join('/');
}

export function baseName(path: string): string {
  const segments = splitPath(path);
  return segments.length === 0 ? '' : segments[segments.length - 1];
}

/** 路径穿越防护。工作区之外的访问必须被挡住，这是安全边界不是便利问题。 */
export function assertSafePath(path: string): void {
  if (path.split('/').some((segment) => segment === '..')) {
    throw new Error(`路径越界：${path}`);
  }
}
