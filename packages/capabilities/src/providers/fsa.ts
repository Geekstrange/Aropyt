/**
 * File System Access 工作区 —— 桌面 Chromium 与 Android Chrome 132+ 上的真实文件夹访问。
 *
 * 关键点：这个 provider 覆盖了两个平台，而且是同一个代码路径。
 * Chrome 132（2025-01-14）把 FS Access 带到了 Android 与 WebView，
 * 所以 Android 端不需要任何原生代码就能直接读写用户的文件夹。
 * 整套"用 Web 内核覆盖五平台"的方案就建立在这个事实上。
 *
 * 另一个关键点：句柄本身是可以结构化克隆的，所以能存进 IndexedDB。
 * 这意味着"上次打开的文件夹"能被记住 —— 但重新授权需要用户手势，
 * 因此 restore() 只在权限仍然有效时成功，否则老老实实返回 null。
 */

import { idbGet, idbSet, STORE } from '@aropyt/core';
import { hasFileSystemAccess, isSecureContextOk } from '../detect.js';
import type { Workspace, WorkspaceProvider } from '../types.js';
import { createHandleWorkspace, ensurePermission, type HandleDirectory } from './handle-workspace.js';

const HANDLE_KEY = 'workspace.fsa.handle';

interface DirectoryPickerOptions {
  readonly id?: string;
  readonly mode?: 'read' | 'readwrite';
  readonly startIn?: string;
}

type DirectoryPicker = (options?: DirectoryPickerOptions) => Promise<HandleDirectory>;

function picker(): DirectoryPicker | undefined {
  return (globalThis as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
}

export const fsaProvider: WorkspaceProvider = {
  id: 'fsa',
  label: '本地文件夹',

  isAvailable(): boolean {
    return hasFileSystemAccess() && isSecureContextOk();
  },

  async pick(): Promise<Workspace | null> {
    const showDirectoryPicker = picker();
    if (!showDirectoryPicker) throw new Error('当前浏览器不支持打开本地文件夹');

    let handle: HandleDirectory;
    try {
      handle = await showDirectoryPicker({ id: 'aropyt-workspace', mode: 'readwrite' });
    } catch (error) {
      // 用户取消不是错误，不该弹错误框。
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      throw error;
    }

    await idbSet(STORE.handles, HANDLE_KEY, handle);
    return createHandleWorkspace(handle, 'fsa');
  },

  async restore(): Promise<Workspace | null> {
    let handle: HandleDirectory | undefined;
    try {
      handle = await idbGet<HandleDirectory>(STORE.handles, HANDLE_KEY);
    } catch {
      return null;
    }

    if (!handle) return null;

    // 不主动 requestPermission —— 重新授权必须由用户手势触发，
    // 在启动阶段静默弹窗是最让人反感的行为之一。
    const granted = await ensurePermission(handle, 'readwrite', false);
    if (!granted) return null;

    return createHandleWorkspace(handle, 'fsa');
  },
};

/** 权限失效后由 UI 在用户点击时调用，用于重新授权上次的工作区。 */
export async function regrantLastWorkspace(): Promise<Workspace | null> {
  const handle = await idbGet<HandleDirectory>(STORE.handles, HANDLE_KEY).catch(() => undefined);
  if (!handle) return null;
  const granted = await ensurePermission(handle, 'readwrite', true);
  return granted ? createHandleWorkspace(handle, 'fsa') : null;
}

export async function forgetLastWorkspace(): Promise<void> {
  await idbSet(STORE.handles, HANDLE_KEY, undefined);
  await idbSet(STORE.handles, HANDLE_KEY, null);
}
