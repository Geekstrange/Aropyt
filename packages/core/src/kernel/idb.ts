/**
 * 极简 IndexedDB 封装。
 *
 * 放在内核而不是能力层，是因为"崩溃恢复日志"和"配置持久化"是内核的
 * 固有职责（配置系统属于不可插件化的七项之一），而能力层是建立在它之上的。
 * 方向必须单一：capabilities → core，不能反过来。
 *
 * 三张表，职责分明：
 *   kv      —— 配置与偏好
 *   handles —— 持久化的文件系统句柄（结构化克隆可以存 FileSystemHandle，是恢复工作区的关键）
 *   drafts  —— 未提交的编辑内容（崩溃恢复用）
 *
 * 刻意不引 Dexie 之类的库：这里的需求只有 CRUD，
 * 而"轻量"是硬约束，不是一个倾向。
 */

const DB_NAME = 'aropyt';
const DB_VERSION = 1;

export const STORE = {
  kv: 'kv',
  handles: 'handles',
  drafts: 'drafts',
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

let databasePromise: Promise<IDBDatabase> | null = null;

export function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of Object.values(STORE)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
  });

  return databasePromise;
}

function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  action: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = action(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error(`IndexedDB 操作失败：${store}`));
        transaction.onabort = () => reject(transaction.error ?? new Error('事务中止'));
      }),
  );
}

export function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return run<unknown>(store, 'readonly', (os) => os.get(key) as IDBRequest<unknown>).then(
    (value) => value as T | undefined,
  );
}

export function idbSet(store: StoreName, key: IDBValidKey, value: unknown): Promise<void> {
  return run(store, 'readwrite', (os) => os.put(value, key) as unknown as IDBRequest<undefined>).then(() => undefined);
}

export function idbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  return run(store, 'readwrite', (os) => os.delete(key) as unknown as IDBRequest<undefined>).then(() => undefined);
}

export function idbKeys(store: StoreName): Promise<IDBValidKey[]> {
  return run<IDBValidKey[]>(store, 'readonly', (os) => os.getAllKeys() as IDBRequest<IDBValidKey[]>);
}

export function idbClear(store: StoreName): Promise<void> {
  return run(store, 'readwrite', (os) => os.clear() as unknown as IDBRequest<undefined>).then(() => undefined);
}

/**
 * 申请持久化存储。
 *
 * 不申请的话，浏览器在磁盘紧张时可以静默清掉 IndexedDB ——
 * 而那里面装着用户的未提交内容和恢复日志。这不是优化，是数据安全。
 */
export async function requestPersistentStorage(): Promise<boolean> {
  const storage = (navigator as unknown as { storage?: StorageManager }).storage;
  if (!storage?.persist) return false;
  try {
    if (await storage.persisted?.()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
