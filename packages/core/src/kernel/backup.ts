/**
 * 数据导出 / 导入（v0.0.7）。
 *
 * 覆盖面：**草稿 + 编辑历史**（两者都是用户在"想换机器/重装系统"时
 * 最怕丢的东西）。配置不需要进来 —— settings.jsonc 已经是可读文件。
 *
 * 为什么是 JSON：草稿与历史本来都是文本；导出成 JSON 可读、可手工修、
 * 且与 IndexedDB 的 origin/路径完全解耦（跨平台迁移、identifier 改名
 * 都不影响）。
 */

import { STORE, idbClear, idbEntries, idbSet } from './idb.js';
import type { HistoryVersion } from './history.js';

export interface BackupFile {
  readonly version: 1;
  readonly exportedAt: string;
  readonly drafts: Record<string, string>;
  readonly history: HistoryVersion[];
}

/** 组装备份：读取全部草稿与编辑历史。 */
export async function assembleBackup(): Promise<BackupFile> {
  const drafts: Record<string, string> = {};
  for (const [key, value] of await idbEntries<string>(STORE.drafts)) {
    drafts[String(key)] = value;
  }
  const history = (await idbEntries<HistoryVersion>(STORE.history)).map(([, value]) => value);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    drafts,
    history,
  };
}

/** 导入：清掉现有草稿与历史，写入备份里的。**不可撤销**，调用前要确认。 */
export async function applyBackup(data: BackupFile): Promise<{ drafts: number; history: number }> {
  if (data?.version !== 1) throw new Error('不支持的备份文件版本');
  if (typeof data.drafts !== 'object' || data.drafts === null) throw new Error('备份缺少草稿数据');
  if (!Array.isArray(data.history)) throw new Error('备份缺少编辑历史数据');

  await idbClear(STORE.drafts);
  await idbClear(STORE.history);
  for (const [key, value] of Object.entries(data.drafts)) {
    await idbSet(STORE.drafts, key, value);
  }
  for (const version of data.history) {
    await idbSet(STORE.history, version.id, version);
  }
  return { drafts: Object.keys(data.drafts).length, history: data.history.length };
}
