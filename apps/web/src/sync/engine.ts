/**
 * 同步决策引擎 —— 纯函数，不碰文件、不碰网络。
 *
 * ── 为什么要有"上次同步的快照" ────────────────────────────
 * 只看本地和远端两份内容，无法区分下面两种情况：
 *
 *   · 本地改了，远端没动      → 应该上传
 *   · 远端改了，本地没动      → 应该下载
 *
 * 两者在"本地和远端内容不同"这件事上完全一样。唯一能分开它们的信息是
 * **上次同步时它们长什么样** —— 所以 `base` 是决策的必要输入，不是缓存。
 *
 * ── 决策表 ────────────────────────────────────────────────
 *
 *   本地相对 base   远端相对 base   结果
 *   ─────────────────────────────────────────────
 *   未变            未变            什么都不做
 *   变了            未变            上传
 *   未变            变了            下载
 *   变了            变了            **冲突**
 *   删除            未变            删远端
 *   未变            删除            删本地
 *   删除            变了            冲突（远端有未合并的修改）
 *   变了            删除            冲突（本地有未合并的修改）
 *
 * `base` 里没有这个文件（首次同步）：存在的一侧算"变了"，两侧都存在时
 * 只有内容一致才算无变化，否则记冲突。
 *
 * ── 一条刻意的原则 ────────────────────────────────────────
 * **冲突永远不自动解决**。留两份、让人决定，是唯一不会丢数据的做法；
 * "远端优先"或"本地优先"都能在几秒内把对方机器上几小时的写作抹掉。
 */

/** 同步动作。`conflict` 不是"失败"，是需要人工介入的终态。 */
export type SyncActionKind =
  | 'upload'
  | 'download'
  | 'deleteRemote'
  | 'deleteLocal'
  | 'conflict';

/**
 * 为什么产生这个动作 —— **结构化原因码，不是文案**。
 *
 * 引擎不返回人类可读的句子：同步日志要按界面语言显示，把中文写死在
 * 决策层会让英文用户看不懂，也会让"想改一句措辞"变成改两处。
 * 文案在 i18n 表里，键由 `causeKey()` 拼出来。
 */
export type SyncCause =
  /** 本地改过，远端没动 */
  | 'localChanged'
  /** 远端改过，本地没动 */
  | 'remoteChanged'
  /** 两端都改过 */
  | 'bothChanged'
  /** 首次同步：只有本地有 */
  | 'onlyLocal'
  /** 首次同步：只有远端有 */
  | 'onlyRemote'
  /** 首次同步：两端都有但内容不同 */
  | 'bothDiffer'
  /** 远端删了，本地没动 */
  | 'remoteDeleted'
  /** 本地删了，远端没动 */
  | 'localDeleted'
  /** 远端删了，但本地有未同步的修改 */
  | 'remoteDeletedDirty'
  /** 本地删了，但远端有未同步的修改 */
  | 'localDeletedDirty';

export interface SyncAction {
  readonly kind: SyncActionKind;
  /** 相对工作区根的路径。 */
  readonly path: string;
  /** 触发原因，供界面翻译成当前语言的说明。 */
  readonly cause: SyncCause;
}

export interface SyncInput {
  /** 本地：路径 → 内容哈希。 */
  readonly local: ReadonlyMap<string, string>;
  /** 远端：路径 → 内容哈希。 */
  readonly remote: ReadonlyMap<string, string>;
  /** 上次同步成功时的状态：路径 → 内容哈希。 */
  readonly base: ReadonlyMap<string, string>;
}

/**
 * 内容哈希（FNV-1a 32 位，36 进制）。
 *
 * 不用加密哈希：这里只回答"两份文本是否相同"，32 位 FNV 对几千个文件
 * 的实际碰撞率远低于需要担心的程度。用 SubtleCrypto 会把一个纯函数变
 * 成异步的，还要处理 TextEncoder，得不偿失。
 *
 * 注意它按 UTF-16 码元计算：代理对（emoji）会被拆成两段参与运算。
 * 这不影响"相同输入得相同哈希"，只是不同 emoji 可能理论上更早撞车 ——
 * 对变化检测足够了。
 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * 比对三方状态，产出动作清单。
 *
 * 顺序按路径排序，保证同样的输入永远产出同样的顺序 —— 同步日志要能
 * 前后对照，随机顺序会让"这次怎么多动了一个文件"变得无法排查。
 */
export function planSync(input: SyncInput): SyncAction[] {
  const paths = new Set<string>([
    ...input.local.keys(),
    ...input.remote.keys(),
    ...input.base.keys(),
  ]);

  const actions: SyncAction[] = [];

  for (const path of [...paths].sort()) {
    const localHash = input.local.get(path);
    const remoteHash = input.remote.get(path);
    const baseHash = input.base.get(path);

    const hasLocal = localHash !== undefined;
    const hasRemote = remoteHash !== undefined;

    /* 两端都不在了：只需把 base 里的记录清掉，没有文件要动 */
    if (!hasLocal && !hasRemote) continue;

    /* 两端一致（含首次同步就相同的文件）：不需要动作，只需刷新 base */
    if (hasLocal && hasRemote && localHash === remoteHash) continue;

    const localChanged = hasLocal && localHash !== baseHash;
    const remoteChanged = hasRemote && remoteHash !== baseHash;

    if (hasLocal && hasRemote) {
      if (localChanged && !remoteChanged) {
        actions.push({ kind: 'upload', path, cause: 'localChanged' });
      } else if (!localChanged && remoteChanged) {
        actions.push({ kind: 'download', path, cause: 'remoteChanged' });
      } else {
        actions.push({
          kind: 'conflict',
          path,
          cause: baseHash === undefined ? 'bothDiffer' : 'bothChanged',
        });
      }
      continue;
    }

    if (hasLocal) {
      /* 只有本地：首次同步就上传；base 里有而远端没了，说明远端删了它 */
      if (baseHash === undefined) {
        actions.push({ kind: 'upload', path, cause: 'onlyLocal' });
      } else if (localChanged) {
        actions.push({ kind: 'conflict', path, cause: 'remoteDeletedDirty' });
      } else {
        actions.push({ kind: 'deleteLocal', path, cause: 'remoteDeleted' });
      }
      continue;
    }

    /* 只有远端 */
    if (baseHash === undefined) {
      actions.push({ kind: 'download', path, cause: 'onlyRemote' });
    } else if (remoteChanged) {
      actions.push({ kind: 'conflict', path, cause: 'localDeletedDirty' });
    } else {
      actions.push({ kind: 'deleteRemote', path, cause: 'localDeleted' });
    }
  }

  return actions;
}

/**
 * 动作名 / 原因说明的 i18n 键。
 *
 * 引擎只给键，界面负责翻译 —— 决策层不该知道用户说的是哪种语言。
 * 键的形态固定为 `sync.action.*` / `sync.cause.*` / `sync.summary.*`，
 * 新增动作或原因时两边一起加，`check:i18n` 会盯着漏掉的键。
 */
export function actionKey(kind: SyncActionKind): string {
  return `sync.action.${kind}`;
}

export function causeKey(cause: SyncCause): string {
  return `sync.cause.${cause}`;
}

export function summaryKey(state: SyncSummary): string {
  return `sync.summary.${state}`;
}

/** 状态栏三态（外加冲突）。`conflict` 不是方向，是需要人介入的状态。 */
export type SyncSummary = 'clean' | 'up' | 'down' | 'conflict';

/**
 * 把动作清单浓缩成状态栏要的三态。
 *
 * `conflict` 优先于任何方向：有冲突时既不能说"已同步"也不能说"待上传"，
 * 那会让用户以为按一下就能解决。
 */
export function summarize(actions: readonly SyncAction[]): SyncSummary {
  if (actions.length === 0) return 'clean';
  if (actions.some((action) => action.kind === 'conflict')) return 'conflict';
  const hasUp = actions.some(
    (action) => action.kind === 'upload' || action.kind === 'deleteRemote',
  );
  const hasDown = actions.some(
    (action) => action.kind === 'download' || action.kind === 'deleteLocal',
  );
  if (hasUp && hasDown) return 'up';
  return hasUp ? 'up' : 'down';
}
