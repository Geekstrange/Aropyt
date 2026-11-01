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

import { hashText, planSync, summarize, type SyncAction, type SyncSummary } from './engine.js';

export interface SyncBackend {
  /** 本地所有待同步文件：相对路径 → 内容。非文本文件由宿主过滤掉。 */
  readLocal(): Promise<Map<string, string>>;
  writeLocal(path: string, content: string): Promise<void>;
  deleteLocal(path: string): Promise<void>;

  /** 远端：只列路径，内容按需取。 */
  listRemote(): Promise<ReadonlySet<string>>;
  readRemote(path: string): Promise<string | null>;
  writeRemote(path: string, content: string): Promise<void>;
  deleteRemote(path: string): Promise<void>;

  /** 上次同步成功时的状态：路径 → 内容哈希。 */
  loadBase(): Promise<Map<string, string>>;
  saveBase(base: ReadonlyMap<string, string>): Promise<void>;
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
  /**
   * 决策做完、动作开始执行时回调一次。
   *
   * 界面要靠它知道"这一轮是往上还是往下" —— 只有 plan 出来之后才知道，
   * 而那时 `running` 状态已经亮起来了。不给这个回调，界面在运行期间就
   * 只能显示一个没有方向的图标。
   */
  onPlanned?: (summary: SyncSummary, actionCount: number) => void,
): Promise<SyncRunResult> {
  const [localFiles, remotePaths, base] = await Promise.all([
    backend.readLocal(),
    backend.listRemote(),
    backend.loadBase(),
  ]);

  /*
   * 远端内容必须取回来才能算哈希 —— WebDAV 的 PROPFIND 只给大小和
   * 修改时间，没有内容摘要。只同步文本文件时这个代价可以接受；
   * 将来把图片纳入同步，要先按 size 筛掉没变的。
   */
  const remoteHashes = new Map<string, string>();
  for (const path of remotePaths) {
    const text = await backend.readRemote(path);
    if (text !== null) remoteHashes.set(path, hashText(text));
  }

  const localHashes = new Map([...localFiles].map(([path, text]) => [path, hashText(text)]));
  const actions = planSync({ local: localHashes, remote: remoteHashes, base });
  onPlanned?.(summarize(actions), actions.length);

  const nextBase = new Map(base);

  /*
   * 引擎对"两端一致"不产出动作 —— 确实没什么要做的，但它的哈希仍要
   * 记进 base：否则这些文件永远不进快照，下次同步时"上次同步过"这件事
   * 就无从判断（只会在两端都改过时表现成 `bothDiffer` 而不是
   * `bothChanged`，措辞不同、行为一样，属于能跑但说不清的坑）。
   */
  for (const [path, hash] of localHashes) {
    if (remoteHashes.get(path) === hash) nextBase.set(path, hash);
  }

  const steps: SyncStepResult[] = [];

  for (const action of actions) {
    let result: SyncStepResult;
    try {
      switch (action.kind) {
        case 'upload': {
          const text = localFiles.get(action.path);
          if (text === undefined) throw new Error('本地文件已消失');
          await backend.writeRemote(action.path, text);
          nextBase.set(action.path, hashText(text));
          result = { action, ok: true };
          break;
        }
        case 'download': {
          const text = await backend.readRemote(action.path);
          if (text === null) throw new Error('远端文件已消失');
          await backend.writeLocal(action.path, text);
          nextBase.set(action.path, hashText(text));
          result = { action, ok: true };
          break;
        }
        case 'deleteRemote': {
          await backend.deleteRemote(action.path);
          nextBase.delete(action.path);
          result = { action, ok: true };
          break;
        }
        case 'deleteLocal': {
          await backend.deleteLocal(action.path);
          nextBase.delete(action.path);
          result = { action, ok: true };
          break;
        }
        case 'conflict': {
          const remoteText = await backend.readRemote(action.path);
          if (remoteText === null) throw new Error('远端文件已消失');
          const copy = conflictPath(action.path, now());
          await backend.writeLocal(copy, remoteText);
          /*
           * `nextBase` 一个字都不动：冲突尚未解决，下一轮同步必须
           * 继续报它，否则冲突会在用户处理之前被悄悄"忘记"。
           */
          result = { action, ok: true, conflictCopy: copy };
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

  return { steps, ok: steps.every((step) => step.ok) };
}
