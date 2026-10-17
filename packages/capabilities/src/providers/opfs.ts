/**
 * OPFS 工作区 —— 沙箱兜底。
 *
 * Firefox 与 Safari 永远不会支持 File System Access 的 picker
 * （Mozilla 明确反对，Apple 以安全为由反对），所以在那两个浏览器上
 * 我们只能提供沙箱内的文件夹。
 *
 * 这**不是**降级到"功能不可用"，而是降级到"数据在沙箱里"：
 * 编辑器依然能完整工作，只是文件不在用户的磁盘上。
 * UI 必须把这个区别讲清楚 —— 用户有权知道自己的数据在哪。
 */

import { hasOpfs } from '../detect.js';
import type { Workspace, WorkspaceProvider } from '../types.js';
import { createHandleWorkspace, type HandleDirectory } from './handle-workspace.js';

const WORKSPACE_DIR = 'workspace';

async function opfsRoot(): Promise<HandleDirectory> {
  const storage = (navigator as unknown as { storage?: { getDirectory?: () => Promise<unknown> } }).storage;
  if (!storage?.getDirectory) throw new Error('当前浏览器不支持源私有文件系统（OPFS）');
  return (await storage.getDirectory()) as HandleDirectory;
}

export const opfsProvider: WorkspaceProvider = {
  id: 'opfs',
  label: '浏览器沙箱',

  isAvailable(): boolean {
    return hasOpfs();
  },

  async pick(): Promise<Workspace | null> {
    const root = await opfsRoot();
    const directory = await root.getDirectoryHandle(WORKSPACE_DIR, { create: true });
    return createHandleWorkspace(directory, 'opfs');
  },

  async restore(): Promise<Workspace | null> {
    // OPFS 不需要授权，所以总能恢复 —— 这是它相对 FSA 唯一的好处。
    const root = await opfsRoot();
    const directory = await root.getDirectoryHandle(WORKSPACE_DIR, { create: true });
    return createHandleWorkspace(directory, 'opfs');
  },
};
