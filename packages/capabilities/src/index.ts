/**
 * @aropyt/capabilities —— 平台能力适配层。
 *
 * 这里是内核与平台之间**唯一**的边界。内核不知道文件存在磁盘上还是沙箱里，
 * 只知道 Workspace 接口；也不知道有没有系统托盘，只读能力报告。
 *
 * 这条边界的价值在加平台时才显现：新增一个平台 = 新增一个 provider，
 * 内核一行不改。
 */

import { idbGet, STORE } from '@aropyt/core';
import { fsaProvider } from './providers/fsa.js';
import { opfsProvider } from './providers/opfs.js';
import { tauriProvider } from './providers/tauri.js';
import type { Workspace, WorkspaceProvider } from './types.js';

export {
  idbClear,
  idbDelete,
  idbGet,
  idbKeys,
  idbSet,
  openDatabase,
  requestPersistentStorage,
  STORE,
  type StoreName,
} from '@aropyt/core';

export {
  assertSafePath,
  baseName,
  joinPath,
  parentPath,
  splitPath,
  type CapabilityName,
  type CapabilityReport,
  type FileStat,
  type PathKind,
  type PlatformKind,
  type ShellKind,
  type Workspace,
  type WorkspaceProvider,
} from './types.js';

export {
  describeLimitations,
  detectCapabilities,
  detectPlatform,
  detectShell,
  hasFileSystemAccess,
  hasOpfs,
  isAndroid,
  isSecureContextOk,
  isTauri,
} from './detect.js';

export {
  createHandleWorkspace,
  ensurePermission,
  type HandleDirectory,
  type HandleFile,
  type WritableStreamLike,
} from './providers/handle-workspace.js';

export { forgetLastWorkspace, fsaProvider, regrantLastWorkspace } from './providers/fsa.js';
export { opfsProvider } from './providers/opfs.js';
export {
  importImageNative,
  isNativeAvailable,
  openNativeFolderAsWorkspace,
  pickMarkdownFileNative,
  pickSavePathNative,
  tauriProvider,
} from './providers/tauri.js';

/**
 * 顺序即优先级。
 *
 * Tauri 在最前（能力最强），FSA 次之（真实文件夹），OPFS 兜底（沙箱）。
 * 上层不该自己判断平台，只按顺序问"你能用吗"。
 */
export const workspaceProviders: readonly WorkspaceProvider[] = [
  tauriProvider,
  fsaProvider,
  opfsProvider,
];

export function getWorkspaceProvider(id: string): WorkspaceProvider | undefined {
  return workspaceProviders.find((provider) => provider.id === id);
}

export function availableProviders(): readonly WorkspaceProvider[] {
  return workspaceProviders.filter((provider) => provider.isAvailable());
}

/** 当前平台最优先可用的 provider。null 表示连沙箱都没有，功能应整体禁用。 */
export function preferredProvider(): WorkspaceProvider | null {
  return availableProviders()[0] ?? null;
}

export type RestoreResult =
  | { readonly status: 'restored'; readonly workspace: Workspace; readonly providerId: string }
  /** 曾打开过真实文件夹，但授权已过期，需要用户点一下才能恢复。 */
  | { readonly status: 'needs-regrant' }
  | { readonly status: 'none' };

/**
 * 尝试恢复上次的工作区。
 *
 * 不要在启动时静默弹权限框 —— 那是最让人反感的行为之一。
 * 权限失效时返回 needs-regrant，由 UI 在用户点击时调用 regrantLastWorkspace()。
 */
export async function restoreWorkspace(lastRoot?: string | null): Promise<RestoreResult> {
  // Tauri 排最前：发布形态下只有它可用，且它不需要重新授权，
  // 所以能恢复就是能恢复，不存在 needs-regrant 这条中间状态。
  if (tauriProvider.isAvailable()) {
    const workspace = await tauriProvider.restore?.(lastRoot ?? null);
    if (workspace) return { status: 'restored', workspace, providerId: 'tauri' };
    return { status: 'none' };
  }

  // 以下两个分支只服务开发模式（浏览器）。
  if (fsaProvider.isAvailable()) {
    const workspace = await fsaProvider.restore?.(lastRoot ?? null);
    if (workspace) return { status: 'restored', workspace, providerId: 'fsa' };

    const handle = await idbGet(STORE.handles, 'workspace.fsa.handle').catch(() => undefined);
    if (handle) return { status: 'needs-regrant' };
  }

  if (opfsProvider.isAvailable()) {
    const workspace = await opfsProvider.restore?.(lastRoot ?? null);
    if (workspace) return { status: 'restored', workspace, providerId: 'opfs' };
  }

  return { status: 'none' };
}
