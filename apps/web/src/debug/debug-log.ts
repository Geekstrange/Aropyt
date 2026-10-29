/**
 * DEBUG 模式（F12）—— 错误捕获与诊断报告。
 *
 * 目标：让用户能交出一份**维护者能据此定位问题**的 issue 报告。
 *
 * 三条硬规则（都是被真实 issue 教出来的）：
 *   1. **启动即采集，永不卸载**。日志和错误必须覆盖"面板打开之前"
 *      发生的事 —— 用户打开面板的动机恰恰是"刚才出了问题"。
 *   2. **错误不被普通日志挤掉**。500 条环形缓冲对 info/log 公平、
 *      对 error 不公平：一次循环报错就能洗掉崩溃前的上下文。
 *      所以淘汰时优先删非 error，且同一错误合并计数。
 *   3. **报告只带诊断信息，绝不带文档正文**。整份 `RuntimeState`
 *      里有每个标签的完整文本，序列化进去会让报告超过 issue 的
 *      字符上限，把真正的日志截断在中间。
 *
 * 报告模板保持中文：受众是维护者，关键词要能 grep（见 CHANGELOG 的
 * Known limitations）。
 */

import { STORE, idbGet, idbSet, type BudgetViolation } from '@aropyt/core';
import { formatTimeline, sessionStartedAt } from './timeline';

export type LogLevel = 'debug' | 'log' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /**
   * 会话内唯一 id（渲染 key 用）。
   *
   * 不能用「来源 + 时间 + 文本前缀」拼 key：同一毫秒内的多条日志
   * 时间相同，而 React 的警告文本前缀又高度相似 —— 实测直接撞 key，
   * 面板每帧报一次 "Encountered two children with the same key"，
   * 122 次就把日志缓冲洗掉了。
   */
  readonly id?: number;
  /** 首次出现的时间（毫秒）。 */
  readonly at: number;
  /** 最近一次出现的时间。与 `at` 不同即为重复错误。 */
  readonly lastAt: number;
  readonly level: LogLevel;
  /** 来源：console / error / rejection / resource / prev（上次会话）。 */
  readonly source: string;
  readonly text: string;
  /** 连续重复次数（同 level + 同文本）。 */
  readonly count: number;
  /**
   * 错误发生那一刻的应用状态（文件 / 脏 / vim / 标签数）。
   *
   * 必须与错误一起记录，不能等生成报告时再读 —— 用户看到报错之后
   * 通常会切文件、关标签、重开，报告时的状态已经不是现场了。
   */
  readonly context?: string;
}

/**
 * 运行时把当前状态投影到这里（O(1) 字符串，由 `notify()` 驱动）。
 * 只在 push 时读取一次，不参与每次渲染。
 */
let currentContext = '';

export function setDebugContext(value: string): void {
  currentContext = value;
}

export interface ErrorSummary {
  readonly level: LogLevel;
  readonly source: string;
  readonly count: number;
  readonly firstAt: number;
  readonly lastAt: number;
  readonly text: string;
  readonly context?: string;
}

export interface PreviousSession {
  readonly at: number;
  readonly version: string;
  readonly errors: readonly LogEntry[];
}

const MAX_ENTRIES = 500;
/** error 的独立配额：再糟也不能少于这么多条错误上下文。 */
const MAX_ERROR_ENTRIES = 300;
const LAST_SESSION_KEY = 'debug:lastSession';
const MAX_PERSISTED_ERRORS = 200;
/** 报告长度上限：GitHub issue body 是 65536 字符，留足余量。 */
const MAX_REPORT_CHARS = 30000;

const buffer: LogEntry[] = [];
const listeners = new Set<() => void>();

let installed = false;
let original: Pick<Console, 'debug' | 'log' | 'info' | 'warn' | 'error'> | null = null;
let windowErrorHandler: ((event: ErrorEvent) => void) | null = null;
let rejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;
let previousSession: PreviousSession | null = null;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let entrySeq = 0;

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  /*
   * Error 只用 stack：stack 的首行已经包含 `Name: message`，
   * 再拼一次 message 会让每条错误都重复一遍，报告白白变长。
   */
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 拼接 console 参数。
 *
 * 必须处理 `%s/%d/%o` 这类占位符：React 的警告就是
 * `console.error('Warning: ... %s ...', key, componentStack)` ——
 * 直接 join 会把 `%s` 原样留在报告里，读者既看不到 key 也看不到组件栈，
 * 一条本该有用的警告变成一段看不懂的模板文本。
 */
function formatArgs(args: readonly unknown[]): string {
  if (args.length === 0) return '';
  const [first, ...rest] = args;
  if (typeof first !== 'string' || rest.length === 0 || !/%[sdifoOc]/.test(first)) {
    return args.map(toText).join(' ');
  }
  let index = 0;
  const formatted = first.replace(/%[sdifoOc]/g, (token) => {
    if (index >= rest.length) return token;
    const value = rest[index];
    index += 1;
    /* %c 是 CSS 样式，不该出现在纯文本报告里 */
    return token === '%c' ? '' : toText(value);
  });
  return [formatted, ...rest.slice(index).map(toText)].join(' ').trim();
}

/** 淘汰时优先删最老的非 error —— error 是诊断的主证据。 */
function trim(): void {
  while (buffer.length > MAX_ENTRIES) {
    const index = buffer.findIndex((entry) => entry.level !== 'error');
    buffer.splice(index === -1 ? 0 : index, 1);
  }
  let errors = buffer.reduce((count, entry) => (entry.level === 'error' ? count + 1 : count), 0);
  while (errors > MAX_ERROR_ENTRIES) {
    const index = buffer.findIndex((entry) => entry.level === 'error');
    if (index === -1) break;
    buffer.splice(index, 1);
    errors -= 1;
  }
}

/** 合并通知：日志高频时逐条重渲染整个面板会污染它自己的性能读数。 */
function notify(): void {
  if (notifyTimer !== null) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    for (const listener of listeners) listener();
  }, 50);
}

function notifyNow(): void {
  if (notifyTimer !== null) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  for (const listener of listeners) listener();
}

function append(
  level: LogLevel,
  source: string,
  text: string,
  options?: { readonly at?: number; readonly persist?: boolean; readonly prepend?: boolean },
): void {
  const now = options?.at ?? Date.now();
  const last = buffer[buffer.length - 1];
  /*
   * 同一条错误连续出现（rAF 里循环抛、事件处理器每次都炸）时只累加计数。
   * 否则 300 次重复会把缓冲洗成同一行，反而看不到"第一次炸之前发生了什么"。
   */
  if (!options?.prepend && last && last.level === level && last.source === source && last.text === text) {
    buffer[buffer.length - 1] = { ...last, lastAt: now, count: last.count + 1 };
  } else {
    const entry: LogEntry = {
      id: ++entrySeq,
      at: now,
      lastAt: now,
      level,
      source,
      text,
      count: 1,
      ...(currentContext ? { context: currentContext } : {}),
    };
    if (options?.prepend) buffer.unshift(entry);
    else buffer.push(entry);
    trim();
  }

  if (options?.persist !== false && level === 'error' && source !== 'prev') schedulePersist();
  notify();
}

function schedulePersist(): void {
  if (persistTimer !== null) return;
  /*
   * 延迟 0ms，不是 500ms。
   *
   * 崩溃场景恰恰是"错误发生后立刻挂"：致命错误 → 白屏 / 进程被杀，
   * 留给我们落盘的窗口只有几十毫秒。原来用 500ms 合并高频错误，
   * 等于把最需要留住的最后一条丢在内存里。
   *
   * 合并的需求已经由 append 层的"同一条错误累加计数"解决，
   * 这里再 debounce 只会牺牲可靠性换一个并不存在的性能问题。
   */
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistErrors();
  }, 0);
}

/**
 * 把 error 落盘，**跨启动保留**。
 *
 * 只在内存里的日志有一个致命盲区：进程被杀 / 断电 / 白屏时，
 * 用户根本打不开面板，错误随进程一起消失。而这类 issue 恰恰最难查。
 * 下次启动时它们会被注入日志列表顶部（source = prev），报告里也会
 * 单独成段。
 */
async function persistErrors(): Promise<void> {
  const current = buffer.filter((entry) => entry.level === 'error' && entry.source !== 'prev');
  const previous = previousSession?.errors ?? [];
  const seen = new Set<string>();
  const errors = [...previous, ...current]
    .filter((entry) => {
      const key = `${entry.level}\u0000${entry.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-MAX_PERSISTED_ERRORS);
  if (errors.length === 0) return;
  try {
    await idbSet(STORE.kv, LAST_SESSION_KEY, {
      at: Date.now(),
      version: __APP_VERSION__,
      errors,
    } satisfies PreviousSession);
  } catch {
    /* 存储不可用（隐私模式 / 配额满）不该影响应用 */
  }
}

/** 启动时调用一次：把上次会话的错误注回日志，供面板与报告使用。 */
export async function loadPreviousSession(): Promise<void> {
  try {
    const record = await idbGet<PreviousSession>(STORE.kv, LAST_SESSION_KEY);
    if (!record || !Array.isArray(record.errors) || record.errors.length === 0) return;
    /* 本次会话自己写的（热重载）不算"上次"。 */
    if (record.at >= sessionStartedAt) return;
    previousSession = record;
    /* 时间上更早，插到列表最前，保持时间顺序。 */
    for (const entry of [...record.errors].reverse()) {
      append(entry.level, 'prev', entry.text, { at: entry.lastAt, persist: false, prepend: true });
    }
    notifyNow();
  } catch {
    /* 读不到就没有"上次会话"，不影响正常使用 */
  }
}

export function getPreviousSession(): PreviousSession | null {
  return previousSession;
}

export function installDebugLog(): void {
  if (installed) return;
  installed = true;
  original = {
    debug: console.debug.bind(console),
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  /*
   * console.debug 必须拦：插件 API 的 `logger.debug()` 就走这里
   * （packages/core/src/kernel/plugin-host.ts）。漏掉它等于插件作者
   * 按规范打的调试信息在面板里完全不存在。
   */
  console.debug = (...args: unknown[]) => {
    append('debug', 'console', formatArgs(args));
    original?.debug(...args);
  };
  console.log = (...args: unknown[]) => {
    append('log', 'console', formatArgs(args));
    original?.log(...args);
  };
  console.info = (...args: unknown[]) => {
    append('info', 'console', formatArgs(args));
    original?.info(...args);
  };
  console.warn = (...args: unknown[]) => {
    append('warn', 'console', formatArgs(args));
    original?.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    append('error', 'console', formatArgs(args));
    original?.error(...args);
  };

  windowErrorHandler = (event: ErrorEvent): void => {
    /*
     * 资源加载失败（img/script/link）也在 window 的 error 事件里，
     * 但它不冒泡、没有 message，只有 target —— 必须靠捕获阶段 + target
     * 才能记下来。之前这类错误是完全静默的。
     */
    const target = event.target;
    if (target && target !== (window as unknown as EventTarget) && !event.message) {
      const element = target as HTMLElement;
      const url = (element as HTMLImageElement).src ?? (element as HTMLScriptElement).src ?? '';
      append('error', 'resource', `资源加载失败: <${element.tagName?.toLowerCase() ?? '?'}> ${url}`);
      return;
    }
    /*
     * event.error 才是带栈的那个对象。原实现只记了 message/filename/lineno，
     * 把栈丢掉了 —— 未捕获异常是 issue 里最常见的一类，没有栈等于没报。
     */
    const detail =
      event.error instanceof Error
        ? toText(event.error)
        : `${event.message}\n  at ${event.filename || '?'}:${String(event.lineno)}:${String(event.colno)}`;
    append('error', 'error', detail);
  };
  window.addEventListener('error', windowErrorHandler, true);

  rejectionHandler = (event: PromiseRejectionEvent): void => {
    append('error', 'rejection', toText(event.reason));
  };
  window.addEventListener('unhandledrejection', rejectionHandler);
}

/**
 * 仅在测试 / 热重载里使用。
 *
 * 应用运行期间**不调用**它：关掉拦截就会丢掉关闭之后的错误，
 * 而用户关面板的动作本身也可能触发问题。
 */
export function uninstallDebugLog(): void {
  if (!installed || !original) return;
  installed = false;
  console.debug = original.debug;
  console.log = original.log;
  console.info = original.info;
  console.warn = original.warn;
  console.error = original.error;
  original = null;
  if (windowErrorHandler) {
    window.removeEventListener('error', windowErrorHandler, true);
    windowErrorHandler = null;
  }
  if (rejectionHandler) {
    window.removeEventListener('unhandledrejection', rejectionHandler);
    rejectionHandler = null;
  }
}

export function getLogs(): readonly LogEntry[] {
  return buffer;
}

export function clearLogs(): void {
  buffer.length = 0;
  notifyNow();
}

export function subscribeLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 按文本去重后的错误摘要（报告与性能页共用）。 */
export function summarizeErrors(limit = 10): readonly ErrorSummary[] {
  const groups = new Map<string, ErrorSummary>();
  for (const entry of buffer) {
    if (entry.level !== 'error' && entry.level !== 'warn') continue;
    /* 上次会话的错误在报告里单独成段，不重复计入"本次摘要"。 */
    if (entry.source === 'prev') continue;
    const key = `${entry.level}\u0000${entry.text}`;
    const existing = groups.get(key);
    if (existing) {
      groups.set(key, {
        ...existing,
        count: existing.count + entry.count,
        firstAt: Math.min(existing.firstAt, entry.at),
        lastAt: Math.max(existing.lastAt, entry.lastAt),
      });
    } else {
      groups.set(key, {
        level: entry.level,
        source: entry.source,
        count: entry.count,
        firstAt: entry.at,
        lastAt: entry.lastAt,
        text: entry.text,
        ...(entry.context ? { context: entry.context } : {}),
      });
    }
  }
  return [...groups.values()]
    .sort((a, b) => (b.level === 'error' ? 1 : 0) - (a.level === 'error' ? 1 : 0) || b.count - a.count)
    .slice(0, limit);
}

// ─────────────────────────── 环境 ───────────────────────────

export interface DebugEnv {
  readonly os: string;
  readonly arch: string;
  readonly tauri: string | null;
  readonly webview: string;
  readonly window: string;
  readonly locale: string;
  readonly theme: string;
  readonly safeMode: boolean;
}

function parseOs(ua: string): string {
  const android = /Android ([\d.]+)/.exec(ua);
  if (android) return `Android ${android[1]}`;
  const windows = /Windows NT ([\d.]+)/.exec(ua);
  if (windows) return `Windows NT ${windows[1]}`;
  const mac = /Mac OS X ([\d_]+)/.exec(ua);
  if (mac) return `macOS ${mac[1].replace(/_/g, '.')}`;
  if (/Linux/.test(ua)) return 'Linux';
  return 'unknown';
}

function parseWebView(ua: string): string {
  const edge = /Edg\/([\d.]+)/.exec(ua);
  if (edge) return `WebView2 (Edge ${edge[1]})`;
  const chrome = /Chrome\/([\d.]+)/.exec(ua);
  if (chrome) return `Chromium ${chrome[1]}`;
  const firefox = /Firefox\/([\d.]+)/.exec(ua);
  if (firefox) return `Firefox ${firefox[1]}`;
  return 'unknown';
}

function parseArch(ua: string): string {
  if (/arm64|aarch64/i.test(ua)) return 'arm64';
  if (/x64|Win64|WOW64|x86_64/i.test(ua)) return 'x64';
  if (/arm/i.test(ua)) return 'arm';
  if (/i686|x86/i.test(ua)) return 'x86';
  return 'unknown';
}

/**
 * 采集环境。异步是因为 Tauri 版本与高熵 UA 值都是异步的；
 * 失败一律降级成 'unknown' —— 环境采集不能成为新的故障源。
 */
export async function collectEnvironment(base: {
  readonly locale: string;
  readonly theme: string;
  readonly safeMode: boolean;
}): Promise<DebugEnv> {
  const ua = navigator.userAgent;
  let architecture = parseArch(ua);
  let os = parseOs(ua);

  const data = (navigator as Navigator & {
    userAgentData?: {
      platform?: string;
      getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; platformVersion?: string }>;
    };
  }).userAgentData;
  if (data?.getHighEntropyValues) {
    try {
      const values = await data.getHighEntropyValues(['architecture', 'platformVersion']);
      if (values.architecture) architecture = values.architecture;
      if (values.platformVersion && /Windows/i.test(os)) os = `${os} (${values.platformVersion})`;
    } catch {
      /* 浏览器可能拒绝高熵值 */
    }
  }

  let tauri: string | null = null;
  try {
    const app = await import('@tauri-apps/api/app');
    tauri = await app.getTauriVersion();
  } catch {
    /* Web 形态没有 Tauri */
  }

  return {
    os,
    arch: architecture,
    tauri,
    webview: parseWebView(ua),
    window: `${String(window.innerWidth)}×${String(window.innerHeight)} @${String(window.devicePixelRatio)}x`,
    /* 'auto' 单独显示没有信息量：把系统语言一并写出来，issue 里能对上。 */
    locale: base.locale === 'auto' ? `auto (${navigator.language})` : base.locale,
    theme: base.theme,
    safeMode: base.safeMode,
  };
}

export interface LongTask {
  /** epoch 毫秒。**不能**直接存 entry.startTime（那是相对 timeOrigin 的）。 */
  readonly at: number;
  readonly duration: number;
}

export interface PluginSnapshot {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly reason?: string;
}

export interface DebugSnapshot {
  readonly version: string;
  readonly platform: string;
  readonly userAgent: string;
  readonly now: number;
  readonly env: DebugEnv | null;
  readonly doc: {
    readonly path: string | null;
    readonly dirty: boolean;
    readonly lines: number;
    readonly chars: number;
    readonly sourceMode: boolean;
    readonly vimMode: boolean;
    readonly vimSubMode: string | null;
    readonly recoveredFrom: string | null;
  };
  /** 配置白名单 —— 只放**标量偏好**，绝不放标签内容。 */
  readonly config: Readonly<Record<string, unknown>>;
  readonly plugins: readonly PluginSnapshot[];
  readonly fps: number;
  readonly heapMb: number | null;
  /** 面板打开后自己采的 EMA（仅本面板可见的样本）。 */
  readonly inputLatencyMs: number;
  /** 运行时常驻探针采到的最近一次超预算输入延迟 —— 包含面板打开之前的。 */
  readonly runtimeLatencyMs: number;
  readonly blockPct: number;
  readonly longTasks: readonly LongTask[];
  readonly budgetViolations: number;
  readonly budgetDetails: readonly BudgetViolation[];
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString();
}

function trimForReport(text: string, max = 600): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断）`;
}

/** 生成可直接贴进 issue 的 Markdown 报告。 */
export function formatReport(snapshot: DebugSnapshot): string {
  const lines: string[] = [];
  const sections: string[][] = [];
  const push = (section: string[]): void => {
    sections.push(section);
  };

  lines.push('### Aropyt 诊断报告');
  lines.push('');
  lines.push(
    '> 由 DEBUG 面板（F12）生成。不含文档正文，但**含本地文件路径与版本信息**，提交前请确认可以公开。请连同复现步骤一起提交。',
  );
  lines.push('');

  /* ── 1. 环境：issue 模板里的必填项 ── */
  const env = snapshot.env;
  const envLines: string[] = ['#### 环境', ''];
  envLines.push(`- 版本：${snapshot.version}`);
  envLines.push(`- 时间：${new Date(snapshot.now).toLocaleString()}`);
  if (env) {
    envLines.push(`- 系统：${env.os}`);
    envLines.push(`- 架构：${env.arch}`);
    envLines.push(`- 外壳：${env.tauri ? `Tauri ${env.tauri}` : '浏览器'}`);
    envLines.push(`- 内核：${env.webview}`);
    envLines.push(`- 窗口：${env.window}`);
    envLines.push(`- 界面：${env.locale} / ${env.theme}${env.safeMode ? ' / **安全模式**' : ''}`);
  } else {
    envLines.push(`- 平台：${snapshot.platform}`);
  }
  envLines.push('');
  push(envLines);

  /* ── 2. 错误摘要：维护者第一眼看的就是这里 ── */
  const summary = summarizeErrors();
  const errorLines: string[] = ['#### 错误摘要', ''];
  if (summary.length === 0) {
    errorLines.push('本次会话没有 error / warn。');
  } else {
    summary.forEach((item, index) => {
      const repeat = item.count > 1 ? ` ×${String(item.count)}` : '';
      const range =
        item.count > 1 ? `${timeOf(item.firstAt)} → ${timeOf(item.lastAt)}` : timeOf(item.firstAt);
      errorLines.push(`**${String(index + 1)}. [${item.level}]${repeat}** ${range} · 来源 _${item.source}_`);
      if (item.context) errorLines.push(`- 发生时的上下文：${item.context}`);
      errorLines.push('');
      errorLines.push('```');
      errorLines.push(trimForReport(item.text));
      errorLines.push('```');
      errorLines.push('');
    });
  }
  push(errorLines);

  /* ── 3. 上次会话：覆盖"崩溃时打不开面板"的盲区 ── */
  const previous = getPreviousSession();
  if (previous) {
    const prevLines: string[] = [
      `#### 上次会话的错误（记录于 ${new Date(previous.at).toLocaleString()}，版本 ${previous.version}）`,
      '',
    ];
    const seen = new Set<string>();
    for (const entry of previous.errors.slice(-10)) {
      const key = entry.text.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      const repeat = entry.count > 1 ? ` ×${String(entry.count)}` : '';
      prevLines.push(`- ${timeOf(entry.lastAt)}${repeat} [${entry.level}]`);
      prevLines.push('  ```');
      for (const line of trimForReport(entry.text, 400).split('\n')) prevLines.push(`  ${line}`);
      prevLines.push('  ```');
    }
    prevLines.push('');
    push(prevLines);
  }

  /* ── 4. 操作轨迹：回答"用户在哪一步" ── */
  push(['#### 操作轨迹（最近 30 条）', '', formatTimeline(30), '']);

  /* ── 5. 插件：功能不生效时最先要看的表 ── */
  const failed = snapshot.plugins.filter((plugin) => plugin.state === 'failed');
  const pluginLines: string[] = [
    `#### 插件（${String(snapshot.plugins.length)} 个，失败 ${String(failed.length)} 个）`,
    '',
  ];
  if (snapshot.plugins.length === 0) {
    pluginLines.push('无');
  } else {
    for (const plugin of snapshot.plugins) {
      const reason = plugin.reason ? ` · ${plugin.reason}` : '';
      pluginLines.push(`- \`${plugin.id}\` ${plugin.name} — **${plugin.state}**${reason}`);
    }
  }
  pluginLines.push('');
  push(pluginLines);

  /* ── 6. 文档与配置：状态，不是内容 ── */
  const doc = snapshot.doc;
  const configLines: string[] = [
    '#### 文档与配置',
    '',
    `- 文件：${doc.path ?? '（未命名）'}${doc.dirty ? ' ● 未保存' : ''}`,
    `- 规模：${String(doc.lines)} 行 / ${String(doc.chars)} 字符`,
    `- 模式：${doc.vimMode ? `vim（${doc.vimSubMode ?? 'normal'}）` : '普通'} · ${doc.sourceMode ? '源码' : '渲染'}`,
    `- 恢复自：${doc.recoveredFrom ?? '—'}`,
    '',
    '```json',
    JSON.stringify(snapshot.config, null, 2),
    '```',
    '',
  ];
  push(configLines);

  /* ── 7. 性能：区分"本次采样"与"常驻监控" ── */
  const perfLines: string[] = [
    '#### 性能',
    '',
    `- FPS：${String(snapshot.fps)}`,
    `- 输入延迟（面板内 EMA）：${String(snapshot.inputLatencyMs)}ms`,
    `- 输入延迟（运行时探针，超 ${String(8)}ms 才记录）：${snapshot.runtimeLatencyMs > 0 ? `${String(snapshot.runtimeLatencyMs)}ms` : '未超预算'}`,
    `- 堆内存：${snapshot.heapMb === null ? '不可用' : `${snapshot.heapMb.toFixed(1)} MB`}`,
    `- 主线程阻塞（最近 60s）：${String(snapshot.blockPct)}%`,
    `- 预算超支：${String(snapshot.budgetViolations)} 次`,
    `- 长任务：最近 50 个中 ${String(snapshot.longTasks.length)} 个（>50ms）`,
    '',
  ];
  if (snapshot.budgetDetails.length > 0) {
    perfLines.push('最近预算超支：', '');
    for (const item of snapshot.budgetDetails.slice(0, 5)) {
      perfLines.push(
        `- ${timeOf(item.at)} \`${item.label}\` 实际 ${String(Math.round(item.actualMs))}ms / 预算 ${String(item.budgetMs)}ms`,
      );
    }
    perfLines.push('');
  }
  if (snapshot.longTasks.length > 0) {
    perfLines.push('最近长任务：', '');
    for (const task of snapshot.longTasks.slice(-10)) {
      perfLines.push(`- ${timeOf(task.at)} · ${String(Math.round(task.duration))}ms`);
    }
    perfLines.push('');
  }
  push(perfLines);

  /* ── 8. 日志：最后放，且按长度截断 ── */
  const logLines: string[] = ['#### 日志', ''];
  /* timeline 已单独成段，prev 已单独成段 —— 日志段只留本次的原始流水。 */
  const visible = buffer.filter(
    (entry) => !entry.text.startsWith('[timeline]') && entry.source !== 'prev',
  );
  if (visible.length === 0) {
    logLines.push('无');
  } else {
    logLines.push('```');
    let used = lines.concat(...sections).join('\n').length + logLines.join('\n').length;
    let written = 0;
    for (const entry of visible.slice(-200)) {
      const repeat = entry.count > 1 ? ` ×${String(entry.count)}` : '';
      const line = `${timeOf(entry.lastAt)} [${entry.level}] [${entry.source}]${repeat} ${entry.text}`;
      if (used + line.length > MAX_REPORT_CHARS) {
        logLines.push(`…（已截断，完整日志见 DEBUG 面板；共 ${String(visible.length)} 条）`);
        break;
      }
      used += line.length;
      written += 1;
      logLines.push(line);
    }
    logLines.push('```');
    logLines.push('');
    logLines.push(`> 日志段共 ${String(written)} 条（缓冲 ${String(visible.length)} 条）。`);
  }
  push(logLines);

  for (const section of sections) lines.push(...section);
  return lines.join('\n');
}
