/**
 * 同步执行器 —— 把引擎的决策落到磁盘与网络上。
 *
 * ── 为什么要依赖注入 ──────────────────────────────────────
 * 执行器要读写本地文件、调 Tauri 命令、碰 IndexedDB，这些在 node 里
 * 都跑不起来。所以它只依赖一个 `SyncBackend` 接口，宿主实现那一层。
 * 好处很直接：整个"上传/下载/删除/冲突/失败回滚"的逻辑可以用内存
 * 假后端跑单元测试，不需要起 Tauri、也不需要真网盘。
 *
 * ── 一条最容易写错、后果最严重的原则 ──────────────────────
 * **元数据只能记已成功的动作。**
 *
 * 如果先写元数据再执行，中途失败就会留下一句"已同步"的谎言 ——
 * 下一次同步据此判定"两端都没变"，于是那份内容永远停在一边，
 * 用户在另一台机器上看到的是旧版本，而且没有任何提示。
 *
 * 所以 `nextBase` 只在动作**成功之后**才被改写，并且每一步都落盘：
 * 中途失败时，已经完成的那部分保持正确。
 */

import { hashBytes, planSync, type SyncAction } from './engine.js';

/** 远端的元信息，用来判断"这份文件在上次同步之后变过没有"。 */
export interface RemoteMeta {
  readonly size: number;
  /** `getlastmodified` 的原文；服务端不返回时为 `null`。 */
  readonly modified: string | null;
}

/** 快照里的一条：内容哈希 + 当时远端的元信息。 */
export interface BaseEntry {
  readonly hash: string;
  readonly size?: number;
  readonly modified?: string | null;
}

export interface SyncBackend {
  /** 本地所有待同步文件：相对路径 → 内容。非文本文件由宿主过滤掉。 */
  /**
   * 本地所有待同步文件：相对路径 → **原始字节**。
   *
   * 用字节而不是字符串：图片与文本要走同一条链路，而把二进制塞进
   * `string` 会在 UTF-8 解码时损坏（更糟的是它**不报错**，要到图片
   * 显示成裂图才发现）。文本文件读出来的字节就是它的 UTF-8 序列。
   */
  readLocal(): Promise<Map<string, Uint8Array>>;
  writeLocal(path: string, bytes: Uint8Array): Promise<void>;
  deleteLocal(path: string): Promise<void>;

  /**
   * 远端：路径 → 元信息。**内容按需取**。
   *
   * 带上大小与修改时间，没变的文件就能直接沿用快照里的哈希 —— 否则每一轮
   * 都要把每个文件下回来算一遍，目录一大就是几十秒。
   */
  listRemote(): Promise<Map<string, RemoteMeta>>;
  readRemote(path: string): Promise<Uint8Array | null>;
  writeRemote(path: string, bytes: Uint8Array): Promise<void>;
  deleteRemote(path: string): Promise<void>;

  /** 上次同步成功时的状态：路径 → 哈希与远端元信息。 */
  loadBase(): Promise<Map<string, BaseEntry>>;
  saveBase(base: ReadonlyMap<string, BaseEntry>): Promise<void>;

  /**
   * "远端没有、本地保留"过的路径。
   *
   * 与 `base` 分开存：`base` 描述内容（谁和谁一致），这个集合描述意图
   * （这些文件我们决定不删）。混在一起会让 `base` 的语义变得含混，
   * 而 `base` 是判断"哪一侧改过"的唯一依据。
   */
  loadKept(): Promise<ReadonlySet<string>>;
  saveKept(kept: ReadonlySet<string>): Promise<void>;

  /**
   * 冲突时保存远端那一份。
   *
   * 宿主把它写进**编辑历史**（标 `source: 'remote'`），而不是在工作区里
   * 生成 `note.conflict-….md`：那种副本会出现在文件树、会被下一轮同步
   * 再传一遍，于是冲突会自我繁殖。历史是它的自然归宿 —— 用户想找回时
   * 和找回旧版本是同一个操作。
   *
   * 收字节而不是字符串：远端可能是图片。能否当文本处理由宿主判断
   * （历史表存的是 `text`，二进制进不去）。
   */
  saveConflict(path: string, bytes: Uint8Array, at: number): Promise<void>;
}

export interface SyncStepResult {
  readonly action: SyncAction;
  readonly ok: boolean;
  readonly error?: string;
  /** 冲突时写出的副本路径（本地）。 */
  readonly conflictCopy?: string;
}

export interface SyncRunResult {
  readonly steps: readonly SyncStepResult[];
  /** 全部动作都成功了才算一次干净的同步。 */
  readonly ok: boolean;
}

/**
 * 冲突副本的路径：`note.conflict-20261101T081500.md`。
 *
 * 保留扩展名是有意的 —— 副本仍是个可打开的文档，用户双击就能对照，
 * 而不是一个需要改名才能用的怪文件。
 */
export function conflictPath(path: string, at: number): string {
  const stamp = new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '');
  const dot = path.lastIndexOf('.');
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : '.md';
  return `${stem}.conflict-${stamp}${ext}`;
}

/**
 * 跑一轮同步。
 *
 * 动作按引擎给出的顺序逐个执行，单个失败**不中断**整轮 —— 一个文件
 * 没权限不该让其余九个也同步不了；失败会被记进 `steps`，界面据此
 * 展示"哪几个没成功"。
 */
export async function runSync(
  backend: SyncBackend,
  now: () => number = Date.now,
): Promise<SyncRunResult> {
  const [localFiles, remoteEntries, base, kept] = await Promise.all([
    backend.readLocal(),
    backend.listRemote(),
    backend.loadBase(),
    backend.loadKept(),
  ]);

  /*
   * 远端哈希。WebDAV 的 PROPFIND 没有内容摘要，所以**只有变过的文件**
   * 才真的下载：大小与修改时间都和快照一致时，直接沿用上次算出的哈希。
   *
   * 这一步是"自动同步能不能无感"的关键 —— 以前每次保存后都要把整个
   * 目录下回来，文件一多就在后台跑几十秒，而图片不会出现在这里，
   * 因为它只同步文本。
   */
  const remoteHashes = new Map<string, string>();
  for (const [path, meta] of remoteEntries) {
    const known = base.get(path);
    if (known && meta.size === known.size && meta.modified === known.modified) {
      remoteHashes.set(path, known.hash);
      continue;
    }
    const bytes = await backend.readRemote(path);
    if (bytes !== null) remoteHashes.set(path, hashBytes(bytes));
  }

  /** 快照条目：哈希取自本轮，元信息取自远端列表。 */
  const snapshotOf = (path: string, hash: string): BaseEntry => {
    const meta = remoteEntries.get(path);
    return { hash, size: meta?.size, modified: meta?.modified ?? null };
  };

  const localHashes = new Map([...localFiles].map(([path, bytes]) => [path, hashBytes(bytes)]));
  /* `planSync` 只关心哈希 —— 元信息是给"要不要下载"用的，留在本层 */
  const baseHashes = new Map([...base].map(([path, entry]) => [path, entry.hash]));

  /*
   * 远端整体为空 + base 里记着东西 → **忽略快照，全部重新上传**。
   *
   * 这不是"用户把所有文件都删了"，而是"这个远端是新目录 / 被清空了"。
   * 交给 `planSync` 会因为 base 里有记录而判成"远端删除了这些文件"，
   * 全部产出 `keep` —— 同步就永远传不上去。
   *
   * 反过来做是安全的：多传一份不会丢数据，而"传不上去"会让同步彻底
   * 卡死。删本地那条路由 `keep` 动作堵着，这里可以放心偏向上传。
   */
  const remoteIsEmpty = remoteHashes.size === 0 && baseHashes.size > 0;
  const effectiveBase = remoteIsEmpty ? new Map<string, string>() : baseHashes;
  /*
   * **不要加"远端整体为空就中止"这类闸门。**
   *
   * 本地有文件、远端是空目录 —— 唯一正确的动作就是上传。它想防的情况
   * （网盘被清空、连错目录）结果不过是"把文件传到另一个地方"，不丢数据。
   * 而真正危险的"删本地"已经由 `keep` 动作堵死了：用一个会卡住正常同步的
   * 检查去防一个不丢数据的误操作，代价不对等。
   */

  const actions = planSync({
    local: localHashes,
    remote: remoteHashes,
    base: effectiveBase,
    kept,
  });

  const nextBase = new Map(base);
  const nextKept = new Set(kept);

  /*
   * 引擎对"两端一致"不产出动作 —— 确实没什么要做的，但它的哈希仍要
   * 记进 base：否则这些文件永远不进快照，下次同步时"上次同步过"这件事
   * 就无从判断（只会在两端都改过时表现成 `bothDiffer` 而不是
   * `bothChanged`，措辞不同、行为一样，属于能跑但说不清的坑）。
   */
  for (const [path, hash] of localHashes) {
    if (remoteHashes.get(path) === hash) nextBase.set(path, snapshotOf(path, hash));
  }

  const steps: SyncStepResult[] = [];

  for (const action of actions) {
    let result: SyncStepResult;
    try {
      switch (action.kind) {
        case 'upload': {
          const bytes = localFiles.get(action.path);
          if (bytes === undefined) throw new Error('本地文件已消失');
          await backend.writeRemote(action.path, bytes);
          /*
           * 上传之后远端的大小与 mtime 由**服务端**决定，本地算不出来。
           * 这里不写 meta，于是下一轮会（因为 `size === undefined`）
           * 下载一次确认 —— 只多这一次，换来的是快照不会记下错误的元信息。
           */
          nextBase.set(action.path, { hash: hashBytes(bytes) });
          result = { action, ok: true };
          break;
        }
        case 'download': {
          const bytes = await backend.readRemote(action.path);
          if (bytes === null) throw new Error('远端文件已消失');
          await backend.writeLocal(action.path, bytes);
          nextBase.set(action.path, snapshotOf(action.path, hashBytes(bytes)));
          result = { action, ok: true };
          break;
        }
        case 'deleteRemote': {
          await backend.deleteRemote(action.path);
          nextBase.delete(action.path);
          result = { action, ok: true };
          break;
        }
        case 'keep': {
          /*
           * 什么都不动，只把路径记进 kept。
           *
           * `nextBase` 也**不清**那条记录：清掉之后下一轮就成了"首次
           * 同步"，会把它当成新文件重新上传到云端 —— 用户想删都删不掉。
           */
          nextKept.add(action.path);
          result = { action, ok: true };
          break;
        }
        case 'deleteLocal': {
          /*
           * 引擎**不再产生**这个动作（见 engine.ts：远端为空不等于用户
           * 删了它）。分支保留只为类型完整，执行时一律拒绝 ——
           * 删本地文件是不可逆的，宁可留一个多余的文件。
           */
          result = {
            action,
            ok: false,
            error: '拒绝删除本地文件：远端缺少某个文件不等于它应该被删除',
          };
          break;
        }
        case 'conflict': {
          const remoteBytes = await backend.readRemote(action.path);
          if (remoteBytes === null) throw new Error('远端文件已消失');
          /*
           * 远端版本进历史，**不落在工作区**。
           *
           * 下一轮同步又把它当新文件传上去，于是每次冲突都会多出一个
           * 副本，冲突会自我繁殖。历史面板本来就是"找回旧内容"的地方，
           * 放那儿才对。
           *
           * 二进制（图片）进不了历史表 —— 那列存的是 `text`。宿主会为
           * 这种情况在历史里留一条"无法保存内容"的占位，而不是静默丢弃。
           */
          await backend.saveConflict(action.path, remoteBytes, now());
          /*
           * `nextBase` 一个字都不动：冲突尚未解决，下一轮同步必须
           * 继续报它，否则冲突会在用户处理之前被悄悄"忘记"。
           */
          result = { action, ok: true };
          break;
        }
      }
    } catch (error) {
      result = {
        action,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    steps.push(result);

    /*
     * 每一步都落盘。失败时保存的是"已经成功的那些"，
     * 而不是一个乐观的全量快照 —— 后者会让本轮失败的文件
     * 在下一轮被误判成"没变化"。
     */
    await backend.saveBase(nextBase).catch(() => undefined);
  }

  /*
   * 收尾再落盘一次。
   *
   * 上面的循环一动作一存，但**没有动作时它一次都不会跑** —— 而"两端
   * 一致"的文件正是在那段补齐逻辑里写进 nextBase 的（实测：首轮同步
   * 两个文件完全相同，base 一直是空的）。
   */
  await backend.saveBase(nextBase).catch(() => undefined);

  /*
   * kept 跟着一起落盘。它只增不减 —— 本地文件被用户删掉之后，
   * 下一轮 `hasLocal === false`，那条自然不会再进 `kept`；
   * 但清理它没有收益（多一条无害），少一条却可能让文件被重新上传。
   */
  await backend.saveKept(nextKept).catch(() => undefined);

  return { steps, ok: steps.every((step) => step.ok) };
}
