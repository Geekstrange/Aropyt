/**
 * 稳定性原语。
 *
 * ─── 稳定性模型 ────────────────────────────────────────────────
 *
 * 三条排序，前一条压倒后一条：
 *
 *   1. 数据不能丢。（崩溃可接受，丢内容不可接受）
 *   2. 主线程不能挂。（"卡死"和"崩溃"在用户感知里是同一件事）
 *   3. 单个插件不能拖垮整个应用。
 *
 * 本文只负责第 2、3 条。第 1 条在能力层，机制是原子写：
 *   写 <file>.tmp → fsync → rename / ReplaceFileW
 * POSIX 的 rename 是原子的，Windows 用 ReplaceFileW。任何时刻断电，
 * 磁盘上要么是完整旧内容、要么是完整新内容，不存在"半截文件"。
 * 注意这条无法在 PWA 上等价实现 —— File System Access 的
 * createWritable() 内部有同样的提交语义，但它不是我们的代码，
 * 不是我们能保证的。这个落差必须显式记录，不能假装没有。
 *
 * ─── 为什么不用 try/catch 到处撒 ───────────────────────────────
 *
 * 因为真正会崩的不是"某个函数抛错"，而是【跨越边界的调用】：
 * 插件代码、用户提供的 markdown-it 插件、渲染 Worker、序列化数据。
 * 每一处这样的边界都需要守卫，且守卫失败时要能回答两个问题：
 *   - 这是谁的责任？（pluginId）
 *   - 这是偶发还是这个插件已经坏了？（FailureTracker）
 * 撒 try/catch 回答不了这两个问题，于是你会得到一个"不崩但也不工作"的应用。
 */

import type { Disposable } from '@aropyt/plugin-api';

/** 守卫作用域。用于归因 —— 出问题时要能一眼看出是哪一类调用。 */
export type GuardScope =
  | 'plugin.activate'
  | 'plugin.deactivate'
  | 'command'
  | 'event'
  | 'view.data'
  | 'view.render'
  | 'markdown-it'
  | 'highlighter'
  | 'editor.extension'
  | 'storage'
  | 'serialization'
  /** 全局兜底守卫捕获到的东西 —— 触发即意味着上面某个守卫有漏洞。 */
  | 'global';

export interface FailureRecord {
  readonly scope: GuardScope;
  readonly pluginId: string | null;
  readonly error: unknown;
  readonly at: number;
}

/**
 * 统一回收站。
 *
 * 插件卸载、视图关闭、编辑器重建都靠它。漏掉一个 Disposable
 * 不会立刻报错，但会以"内存涨到 OOM"的形式在几小时后崩掉 ——
 * 那是稳定性里最难查的一类。
 */
export class DisposableStore implements Disposable {
  #items: Disposable[] = [];
  #disposed = false;

  get disposed(): boolean {
    return this.#disposed;
  }

  get size(): number {
    return this.#items.length;
  }

  /** 若已释放，传入的对象会被立即释放而不是被吞掉。 */
  add<T extends Disposable>(item: T): T {
    if (this.#disposed) {
      item.dispose();
      return item;
    }
    this.#items.push(item);
    return item;
  }

  /** 释放全部但保持可用（对齐 VS Code 的语义，便于复用同一个 store）。 */
  clear(): void {
    const items = this.#items;
    this.#items = [];
    disposeAll(items);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const items = this.#items;
    this.#items = [];
    disposeAll(items);
  }
}

function disposeAll(items: readonly Disposable[]): void {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    try {
      items[i].dispose();
    } catch (error) {
      // 释放失败不能中断其余释放 —— 否则一次泄漏会级联成一片。
      reportFailure({ scope: 'plugin.deactivate', pluginId: null, error, at: Date.now() });
    }
  }
}

/** 单个插件的失败账本。 */
export class FailureTracker {
  #records = new Map<string, number[]>();

  constructor(
    /** 时间窗内累计多少次失败就熔断。 */
    private readonly threshold = 3,
    /** 计数窗口，毫秒。 */
    private readonly windowMs = 60_000,
    /** 熔断回调。内核在这里禁用插件并通知用户。 */
    private readonly onTrip: (pluginId: string, count: number) => void,
  ) {}

  record(pluginId: string | null, at: number): void {
    if (!pluginId) return;
    const cutoff = at - this.windowMs;
    const hits = (this.#records.get(pluginId) ?? []).filter((t) => t > cutoff);
    hits.push(at);
    this.#records.set(pluginId, hits);

    if (hits.length >= this.threshold) {
      this.#records.delete(pluginId);
      this.onTrip(pluginId, hits.length);
    }
  }

  /** 成功一次就清零 —— 避免把"偶发抖动"和"插件已坏"混为一谈。 */
  reset(pluginId: string | null): void {
    if (pluginId) this.#records.delete(pluginId);
  }

  count(pluginId: string): number {
    return this.#records.get(pluginId)?.length ?? 0;
  }
}

let failureTracker: FailureTracker | null = null;

export function setFailureTracker(tracker: FailureTracker): void {
  failureTracker = tracker;
}

/** 只记录日志，不计入"连续异常 → 自动禁用"的计数。 */
export function logFailure(record: FailureRecord): void {
  console.error(`[aropyt:${record.scope}]`, record.pluginId ?? '(kernel)', record.error);
}

/** 全局失败上报。守卫用它，DisposableStore 也用它。 */
export function reportFailure(record: FailureRecord): void {
  failureTracker?.record(record.pluginId, record.at);
  logFailure(record);
}

export interface GuardOptions {
  readonly scope: GuardScope;
  readonly pluginId?: string | null;
  /** 覆盖默认的上报行为，用于测试断言。 */
  readonly onFailure?: (record: FailureRecord) => void;
  /**
   * 该失败是否计入"插件连续异常 → 自动禁用"的计数。默认计入。
   *
   * 什么时候该设 false：**失败原因在环境而不在插件**的场景。
   * 命令处理器是典型 —— 用户取消选择框、权限不足、磁盘写满、
   * 路径不存在，这些都是正常使用中会发生的事，却会让插件在
   * 连续 3 次之后被自动禁用，连带它的所有命令一起消失（工具栏图标
   * 会静默回退成通用图标）。把环境问题当成插件故障处理，代价远大于收益。
   *
   * 激活与视图渲染失败仍然计入 —— 那些确实说明插件代码有问题。
   */
  readonly track?: boolean;
}

function handleFailure(options: GuardOptions, error: unknown): void {
  const record: FailureRecord = {
    scope: options.scope,
    pluginId: options.pluginId ?? null,
    error,
    at: Date.now(),
  };

  if (options.onFailure) options.onFailure(record);
  else if (options.track === false) logFailure(record);
  else reportFailure(record);
}

/**
 * 同步守卫。
 *
 * 返回值一定是函数返回值或 fallback，不会抛。插件抛出的任何东西
 * —— 包括非 Error 的裸值、Proxy 陷阱里抛的、getter 里抛的 —— 都在这里被截住。
 */
export function guardSync<T>(options: GuardOptions, fn: () => T, fallback: T): T {
  try {
    const result = fn();
    if (failureTracker) failureTracker.reset(options.pluginId ?? null);
    return result;
  } catch (error) {
    handleFailure(options, error);
    return fallback;
  }
}

/**
 * 异步守卫，比同步多一层超时。
 *
 * 超时不是性能优化，是防挂起：一个 await 一个永不 resolve 的 Promise，
 * 在没有超时的世界里就是永久卡住，而且堆栈上看不出任何异常。
 */
export async function guardAsync<T>(
  options: GuardOptions,
  fn: () => T | Promise<T>,
  fallback: T,
  timeoutMs?: number,
): Promise<T> {
  try {
    const result = await (timeoutMs ? withTimeout(Promise.resolve(fn()), timeoutMs) : fn());
    if (failureTracker) failureTracker.reset(options.pluginId ?? null);
    return result;
  } catch (error) {
    handleFailure(options, error);
    return fallback;
  }
}

/**
 * Promise 超时。定时器一定会被清掉 —— 否则一个"忘了清"的 setTimeout
 * 就能在浏览器里吊住整个页面，让看似正常的代码无法被垃圾回收。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message ?? `操作超过 ${ms}ms 未完成`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export type GlobalFailureKind = 'uncaught' | 'unhandled-rejection';

export interface GlobalGuardOptions {
  readonly onFailure?: (error: unknown, kind: GlobalFailureKind) => void;
  /**
   * 观察模式下不阻止默认行为，只是记录。
   * 生产环境应保持 false —— 未捕获异常如果任由冒泡，某些 WebView 会直接白屏。
   */
  readonly observeOnly?: boolean;
}

/**
 * 兜底全局守卫。
 *
 * 这是防线里的最后一道，它捕获的是【我们没预料到的】异常 ——
 * 所以它触发就意味着守卫有漏洞，必须被记录和跟踪，而不是静默吞掉。
 */
export function installGlobalGuards(options: GlobalGuardOptions = {}): Disposable {
  const report = (error: unknown, kind: GlobalFailureKind) => {
    reportFailure({ scope: 'global', pluginId: null, error, at: Date.now() });
    options.onFailure?.(error, kind);
  };

  const onError = (event: ErrorEvent) => {
    report(event.error ?? event.message, 'uncaught');
    if (!options.observeOnly) event.preventDefault();
  };

  const onRejection = (event: PromiseRejectionEvent) => {
    report(event.reason, 'unhandled-rejection');
    if (!options.observeOnly) event.preventDefault();
  };

  globalThis.addEventListener('error', onError);
  globalThis.addEventListener('unhandledrejection', onRejection);

  return {
    dispose() {
      globalThis.removeEventListener('error', onError);
      globalThis.removeEventListener('unhandledrejection', onRejection);
    },
  };
}

/**
 * 从不可信来源解析 JSON。
 *
 * 插件写进 storage 的东西、从工作区读到的配置文件，都属于不可信来源 ——
 * 它们可能来自另一个版本、另一个平台、或者被用户手动改坏。
 * 解析失败必须返回 fallback 而不是抛，否则一个坏配置文件就能让应用起不来。
 */
export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    const value: unknown = JSON.parse(text);
    return value === null || value === undefined ? fallback : (value as T);
  } catch {
    return fallback;
  }
}
