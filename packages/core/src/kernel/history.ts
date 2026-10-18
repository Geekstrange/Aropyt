/**
 * 编辑历史（v0.0.7）。
 *
 * 模型是"git 的最小闭环"：**保存即版本**，版本链不可变，恢复时把当前内容
 * 先存成新版本再跳回旧版本 —— 所以**任何操作都不会丢内容**。
 *
 * 几个刻意的设计：
 *  1. **全量存文本**，不做增量（delta）。增量要维护链式依赖，一个版本坏了
 *     整条链就断；编辑历史的价值恰恰在"出事了能找回"，不能有这种脆弱点。
 *  2. **内容哈希去重**：反复保存同一内容不会产生垃圾版本。
 *  3. **按文件淘汰**：每个文件只保留最近 N 个（N 来自配置 history.limit），
 *     并且单版本超过 4MB 直接跳过 —— 避免一个大文件吃光配额。
 *  4. 存储在 IndexedDB 的独立 store（`history`），与草稿/配置分开。
 */

import { STORE, idbDelete, idbGet, idbSet } from './idb.js';

export interface HistoryVersion {
  readonly id: string;
  /** 文件标识：工作区相对路径，或外部文件的绝对路径。 */
  readonly path: string;
  readonly text: string;
  readonly hash: string;
  readonly createdAt: number;
  /** 手动命名的版本（里程碑）；自动版本为 undefined。 */
  readonly label?: string;
  readonly size: number;
}

/** 单版本上限：超过不记录（避免一个大文件吃光配额）。 */
export const MAX_VERSION_BYTES = 4 * 1024 * 1024;

/** 列表里要展示的摘要（不带全量文本，避免 UI 拉一堆大字符串）。 */
export interface HistorySummary {
  readonly id: string;
  readonly createdAt: number;
  readonly label?: string;
  readonly size: number;
  /** 与上一个版本相比的行数变化（+增 / -删），由 diff 计算后填充。 */
  readonly wordCount: number;
}

/** FNV-1a 32 位：足够做"内容是否相同"的判定，且同步、无依赖。 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** 每个文件的所有版本（按时间升序）。history store 的 key 是 id。 */
async function loadAll(): Promise<HistoryVersion[]> {
  const { openDatabase } = await import('./idb.js');
  const db = await openDatabase();
  return new Promise<HistoryVersion[]>((resolve, reject) => {
    const transaction = db.transaction(STORE.history, 'readonly');
    const request = transaction.objectStore(STORE.history).getAll();
    request.onsuccess = () => resolve((request.result ?? []) as HistoryVersion[]);
    request.onerror = () => reject(request.error ?? new Error('读取编辑历史失败'));
  });
}

/** 某个文件的版本列表（新→旧）。 */
export async function listVersions(path: string): Promise<HistorySummary[]> {
  const all = await loadAll();
  return all
    .filter((version) => version.path === path)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ id, createdAt, label, size, text }) => ({
      id,
      createdAt,
      label,
      size,
      wordCount: text.length,
    }));
}

/**
 * 记录一个版本。
 *
 * 返回 true 表示新增了版本；false 表示内容与最近一版相同（被去重）或
 * 超过大小上限（被跳过）。
 */
export async function recordVersion(
  path: string,
  text: string,
  limit: number,
  label?: string,
): Promise<boolean> {
  const size = new TextEncoder().encode(text).length;
  if (size > MAX_VERSION_BYTES) return false;

  const hash = hashText(text);
  const existing = (await loadAll()).filter((version) => version.path === path);
  const latest = existing.sort((a, b) => b.createdAt - a.createdAt)[0];
  // 与最近一版内容相同 → 不重复记录（手动命名的版本除外：用户显式要求留痕）
  if (!label && latest && latest.hash === hash) return false;

  const version: HistoryVersion = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    path,
    text,
    hash,
    createdAt: Date.now(),
    label,
    size,
  };
  await idbSet(STORE.history, version.id, version);

  // 淘汰：按时间保留最近 limit 个
  const sorted = [...existing, version].sort((a, b) => b.createdAt - a.createdAt);
  const overflow = sorted.slice(Math.max(limit, 1));
  await Promise.all(overflow.map((item) => idbDelete(STORE.history, item.id).catch(() => undefined)));
  return true;
}

/** 取一个版本（含全文）。 */
export async function getVersion(id: string): Promise<HistoryVersion | null> {
  const version = await idbGet<HistoryVersion>(STORE.history, id);
  return version ?? null;
}

/** 删除某个文件的全部历史（文件被删除时用）。 */
export async function clearHistory(path: string): Promise<void> {
  const all = (await loadAll()).filter((version) => version.path === path);
  await Promise.all(all.map((version) => idbDelete(STORE.history, version.id).catch(() => undefined)));
}
