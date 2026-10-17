/**
 * 性能预算的运行时守卫。
 *
 * ─── 三条目标如何统一 ──────────────────────────────────────────
 *
 * 「轻量」「极致性能」「极致稳定」看起来是三个目标，实际上可以被
 * 一条约束同时满足：
 *
 *     主线程只做编辑，其余一切搬出去。
 *
 *   - 轻量：主线程代码少 → 首屏 bundle 小
 *   - 性能：主线程空闲 → 输入延迟低
 *   - 稳定：主线程崩不了 → 不会"用到一半崩了"
 *
 * 所以本文件不提供"调优技巧"，只提供一个执行器 + 一个监视器：
 * 把工作按优先级调度，把长活切成时间片，超预算就上报。
 *
 * ─── 为什么"极致性能"必须是可测量的 ───────────────────────────
 *
 * 这个品类里唯一不可妥协的指标是【输入延迟】。首屏慢可以等，
 * 预览慢可以防抖，保存慢可以异步 —— 但按键之后字符不出来，
 * 用户立刻判定"卡"。它一旦超过约 50ms 就是可感知的。
 *
 * 因此下面所有的数字都必须是硬阈值，且在 CI 里被断言，
 * 而不是"尽量优化"。不可测量的"极致"等于没有要求。
 */

import type { Disposable } from '@aropyt/plugin-api';

/** 性能预算表。改这里等于改产品承诺，需要同步更新 CI 断言。 */
export const BUDGETS = {
  /** 主线程同步路径总预算。超了就是"卡"。 */
  inputLatencyMs: 8,
  /** 一帧。60fps 的物理上限。 */
  frameMs: 16.7,
  /** 长任务告警阈值。浏览器标准定义。 */
  longTaskMs: 50,
  /** 预览渲染防抖。低于 120ms 用户感觉不到滞后。 */
  previewDebounceMs: 120,
  /** 崩溃恢复日志落盘防抖。保证最多丢 300ms 的输入。 */
  walDebounceMs: 300,
  /** 空闲提交（fsync + rename）。移出关键路径，所以可以很慢。 */
  commitIdleMs: 2000,
  /** 冷启动到可交互。 */
  startupInteractiveMs: 1000,
} as const;

export type BudgetKey = keyof typeof BUDGETS;

export interface BudgetViolation {
  readonly label: string;
  readonly actualMs: number;
  readonly budgetMs: number;
  readonly at: number;
}

export type ViolationHandler = (violation: BudgetViolation) => void;

function report(
  label: string,
  actualMs: number,
  budgetMs: number,
  onViolation?: ViolationHandler,
): void {
  if (actualMs <= budgetMs) return;
  onViolation?.({
    label,
    actualMs: Math.round(actualMs * 100) / 100,
    budgetMs,
    at: Date.now(),
  });
}

// ─────────────────────────── 调度：把工作排好队 ───────────────────────────

export type TaskPriority = 'user-blocking' | 'user-visible' | 'background';

interface NativeScheduler {
  postTask<T>(callback: () => T, options?: { priority?: TaskPriority; signal?: AbortSignal }): Promise<T>;
}

const nativeScheduler = (globalThis as unknown as { scheduler?: NativeScheduler }).scheduler;

let yieldChannel: MessageChannel | null = null;
const yieldWaiters: Array<() => void> = [];

/**
 * 让出一个宏任务给浏览器。
 *
 * 用 MessageChannel 而不是 setTimeout(0)：setTimeout 在嵌套调用和
 * 后台标签页里会被钳制到 4ms 甚至 1s，那正好会把"切片"变成"卡顿源"。
 */
export function yieldToMain(): Promise<void> {
  if (!yieldChannel) {
    yieldChannel = new MessageChannel();
    yieldChannel.port1.onmessage = () => {
      const waiters = yieldWaiters.splice(0);
      for (const resolve of waiters) resolve();
    };
    yieldChannel.port1.start();
  }
  const channel = yieldChannel;
  return new Promise<void>((resolve) => {
    yieldWaiters.push(resolve);
    channel.port2.postMessage(null);
  });
}

/**
 * 按优先级调度一次任务。
 *
 * 优先级的真正用途不是"排序"，而是保证【后台任务永远抢不到输入】。
 * 所有可能变慢的活（索引、字数统计、文件扫描）都必须走 'background'。
 */
export async function schedule<T>(
  priority: TaskPriority,
  task: () => T,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError');

  if (nativeScheduler) {
    return nativeScheduler.postTask(task, signal ? { priority, signal } : { priority });
  }

  await yieldToMain();
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError');
  return task();
}

/**
 * 把一批工作切成不超过 sliceMs 的时间片执行，每片之间把主线程还回去。
 *
 * 这是"防挂起"的主力：不加切片的批量操作（重新高亮整篇、重建文件树、
 * 全文搜索）会在文档稍大时直接冻结 UI —— 用户看到的就是崩溃。
 */
export async function runChunked<T>(
  items: readonly T[],
  run: (item: T, index: number) => void,
  options: { sliceMs?: number; signal?: AbortSignal; onProgress?: (done: number) => void } = {},
): Promise<void> {
  const sliceMs = options.sliceMs ?? 5;
  let sliceStart = performance.now();

  for (let i = 0; i < items.length; i += 1) {
    if (options.signal?.aborted) throw new DOMException('任务已取消', 'AbortError');

    run(items[i], i);
    options.onProgress?.(i + 1);

    if (performance.now() - sliceStart >= sliceMs) {
      await yieldToMain();
      sliceStart = performance.now();
    }
  }
}

/**
 * 空闲执行。requestIdleCallback 在 Safari 上缺失，且它的 timeout 语义
 * 与 setTimeout 不同，所以两条路都要有。
 */
export function onIdle(callback: () => void, timeoutMs = BUDGETS.commitIdleMs): Disposable {
  const global = globalThis as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (global.requestIdleCallback) {
    const handle = global.requestIdleCallback(callback, { timeout: timeoutMs });
    return {
      dispose() {
        global.cancelIdleCallback?.(handle);
      },
    };
  }

  const timer = setTimeout(callback, timeoutMs);
  return {
    dispose() {
      clearTimeout(timer);
    },
  };
}

// ─────────────────────────── 防抖：带最大等待 ───────────────────────────

export interface Debounced<A extends readonly unknown[]> {
  (...args: A): void;
  cancel(): void;
  flush(): void;
  readonly pending: boolean;
}

/**
 * 带 maxWait 的防抖。
 *
 * 普通防抖在"用户持续输入"时会永远不触发 —— 对保存而言这是灾难：
 * 一个连续敲了 5 分钟的用户，5 分钟里一次都没落盘。
 * maxWait 保证无论如何都会按期执行一次。
 */
export function debounce<A extends readonly unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
  options: { maxWaitMs?: number } = {},
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstCallAt = 0;
  let lastArgs: A | null = null;

  const invoke = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    firstCallAt = 0;
    const args = lastArgs;
    lastArgs = null;
    if (args) fn(...args);
  };

  const debounced = (...args: A) => {
    lastArgs = args;
    const now = performance.now();
    if (firstCallAt === 0) firstCallAt = now;

    if (options.maxWaitMs && now - firstCallAt >= options.maxWaitMs) {
      invoke();
      return;
    }

    if (timer) clearTimeout(timer);
    timer = setTimeout(invoke, waitMs);
  };

  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
    firstCallAt = 0;
  };

  debounced.flush = () => {
    if (timer) invoke();
  };

  Object.defineProperty(debounced, 'pending', { get: () => timer !== null });

  return debounced as Debounced<A>;
}

// ─────────────────────────── 监视：超预算就上报 ───────────────────────────

export interface FrameBudgetOptions {
  readonly onViolation?: ViolationHandler;
  /** 只测量不上报。开发和基准测试时用于收集数据。 */
  readonly observeOnly?: boolean;
  /**
   * 启动宽限期（毫秒）。默认 1500。
   *
   * 为什么需要：longtask 报的是"某段同步代码超过 50ms"，
   * 而冷启动本身（解析 bundle、构建语法树、首帧布局）**必然**超一次。
   * 把它算进违规，状态栏就会常驻一条"预算超支 N 次"——
   * 而这条信息对"我打字卡不卡"毫无帮助，反而让人以为编辑器有问题。
   *
   * 这个指标要能回答的问题是"编辑过程中有没有卡"，
   * 而不是"启动花了多久"（那个由另一条启动预算管）。
   * 注意这不是把问题藏起来：超预算的**具体条目**仍然记录在
   * 最近违规列表里，鼠标悬停就能看到，只是不再占用告警计数。
   */
  readonly warmupMs?: number;
}

/**
 * 帧预算监视器。
 *
 * 用浏览器的 Long Task API 而不是自己打点 —— 因为我们要抓的正是
 * "我们没预料到的"阻塞：第三方代码、GC 停顿、样式重算引发的同步布局。
 * 自己打点只能测到自己写的部分。
 */
export class FrameBudgetMonitor implements Disposable {
  #observer: PerformanceObserver | null = null;
  #disposed = false;
  /** 宽限期结束的时刻。之前的 longtask 不计入违规。 */
  readonly #warmupUntil: number;

  constructor(private readonly options: FrameBudgetOptions = {}) {
    this.#warmupUntil = performance.now() + (options.warmupMs ?? 1500);
  }

  observe(): void {
    if (this.#observer || this.#disposed) return;
    if (typeof PerformanceObserver === 'undefined') return;

    try {
      this.#observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.#handleLongTask(entry);
        }
      });
      this.#observer.observe({ entryTypes: ['longtask'] });
    } catch {
      // 不支持 longtask 的引擎直接放弃监视，不能让监视本身成为故障源。
      this.#observer = null;
    }
  }

  #handleLongTask(entry: PerformanceEntry): void {
    const attribution = (entry as PerformanceEntry & {
      attribution?: readonly { name?: string; containerType?: string }[];
    }).attribution;

    const source =
      attribution?.[0]?.name ??
      attribution?.[0]?.containerType ??
      'unknown';

    const violation: BudgetViolation = {
      label: `longtask:${source}`,
      actualMs: Math.round(entry.duration * 100) / 100,
      budgetMs: BUDGETS.longTaskMs,
      at: Date.now(),
    };

    if (this.options.observeOnly) return;
    // 启动期的那一次不算违规，见 warmupMs 的说明。
    if (performance.now() < this.#warmupUntil) return;
    this.options.onViolation?.(violation);
  }

  /** 手动上报一次测量结果，用于包裹我们自己知道的慢操作。 */
  measure<T>(label: string, budgetMs: number, fn: () => T): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      report(label, performance.now() - start, budgetMs, this.options.onViolation);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#observer?.disconnect();
    this.#observer = null;
  }
}

/**
 * 输入延迟探针：按键到下一次绘制之间的间隔。
 *
 * 这是唯一真正反映"用户觉得卡不卡"的指标 —— 它包含了事件处理、
 * 我们的同步逻辑、样式重算和浏览器绘制，而不是其中某一项。
 */
export function createInputLatencyProbe(
  onSample: (latencyMs: number, budgetMs: number) => void,
): Disposable {
  let pressedAt = 0;
  let frame = 0;

  const onKeyDown = () => {
    pressedAt = performance.now();
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const latency = performance.now() - pressedAt;
      if (latency > BUDGETS.inputLatencyMs) onSample(latency, BUDGETS.inputLatencyMs);
    });
  };

  globalThis.addEventListener('keydown', onKeyDown, { capture: true, passive: true });

  return {
    dispose() {
      globalThis.removeEventListener('keydown', onKeyDown, { capture: true });
      if (frame) cancelAnimationFrame(frame);
    },
  };
}
