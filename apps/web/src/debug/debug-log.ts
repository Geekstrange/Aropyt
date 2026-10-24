/**
 * DEBUG 模式（F12）—— 日志捕获。
 *
 * 目标不是"开发者工具"，而是**让用户能交出一份有信息量的 issue 报告**：
 *   - 拦截 console.* 与未捕获异常（含插件抛的）
 *   - 环形缓冲最近 500 条，内存占用可控
 *   - 导出成一段可直接粘贴的 Markdown（环境 + 性能 + 日志）
 *
 * 只在 DEBUG 面板打开时安装拦截，关闭后恢复原生 console ——
 * 不让"不调试的用户"承担任何额外开销。
 */
export type LogLevel = 'log' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly at: number;
  readonly level: LogLevel;
  /** 来源：console / error / rejection / plugin */
  readonly source: string;
  readonly text: string;
}

const MAX_ENTRIES = 500;
const buffer: LogEntry[] = [];
const listeners = new Set<() => void>();
let installed = false;
let original: Pick<Console, 'log' | 'info' | 'warn' | 'error'> | null = null;

function push(level: LogLevel, source: string, args: unknown[]): void {
  const text = args
    .map((value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(' ');
  buffer.push({ at: Date.now(), level, source, text });
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  for (const listener of listeners) listener();
}

export function installDebugLog(): void {
  if (installed) return;
  installed = true;
  original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  console.log = (...args: unknown[]) => {
    push('log', 'console', args);
    original?.log(...args);
  };
  console.info = (...args: unknown[]) => {
    push('info', 'console', args);
    original?.info(...args);
  };
  console.warn = (...args: unknown[]) => {
    push('warn', 'console', args);
    original?.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    push('error', 'console', args);
    original?.error(...args);
  };
  window.addEventListener('error', (event) => {
    push('error', 'error', [event.message, event.filename, event.lineno]);
  });
  window.addEventListener('unhandledrejection', (event) => {
    push('error', 'rejection', [event.reason]);
  });
}

export function uninstallDebugLog(): void {
  if (!installed || !original) return;
  installed = false;
  console.log = original.log;
  console.info = original.info;
  console.warn = original.warn;
  console.error = original.error;
  original = null;
}

export function getLogs(): readonly LogEntry[] {
  return buffer;
}

export function clearLogs(): void {
  buffer.length = 0;
  for (const listener of listeners) listener();
}

export function subscribeLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface DebugSnapshot {
  readonly version: string;
  readonly platform: string;
  readonly userAgent: string;
  readonly now: number;
  readonly fps: number;
  readonly heapMb: number | null;
  readonly longTasks: readonly { readonly at: number; readonly duration: number }[];
  /** 当前生效的设置快照 —— 复现 bug 的必要上下文。 */
  readonly settings?: Record<string, unknown>;
  /** 文档状态（路径/行数/未保存）。 */
  readonly doc?: { readonly path: string | null; readonly dirty: boolean };
}

/** 生成可直接贴进 issue 的 Markdown 报告。 */
export function formatReport(snapshot: DebugSnapshot): string {
  const lines: string[] = [];
  lines.push('### Aropyt 诊断报告');
  lines.push('');
  lines.push(`- 版本：${snapshot.version}`);
  lines.push(`- 平台：${snapshot.platform}`);
  lines.push(`- 时间：${new Date(snapshot.now).toLocaleString()}`);
  lines.push(`- FPS：${snapshot.fps}`);
  lines.push(`- 堆内存：${snapshot.heapMb === null ? '不可用' : `${snapshot.heapMb.toFixed(1)} MB`}`);
  lines.push(`- 长任务：${snapshot.longTasks.length} 个`);
  lines.push(`- UA：\`${snapshot.userAgent}\``);
  if (snapshot.doc) {
    lines.push(`- 文档：${snapshot.doc.path ?? '（未命名）'}${snapshot.doc.dirty ? ' ● 未保存' : ''}`);
  }
  if (snapshot.settings) {
    lines.push('');
    lines.push('#### 设置快照');
    lines.push('```json');
    lines.push(JSON.stringify(snapshot.settings, null, 2));
    lines.push('```');
  }
  lines.push('');
  lines.push('#### 长任务（>50ms，最近 10 个）');
  if (snapshot.longTasks.length === 0) {
    lines.push('无');
  } else {
    for (const task of snapshot.longTasks.slice(-10)) {
      lines.push(`- ${new Date(task.at).toLocaleTimeString()} · ${Math.round(task.duration)}ms`);
    }
  }
  lines.push('');
  lines.push(`#### 日志（最近 ${Math.min(buffer.length, 200)} 条）`);
  lines.push('```');
  for (const entry of buffer.slice(-200)) {
    const time = new Date(entry.at).toLocaleTimeString();
    lines.push(`${time} [${entry.level}] [${entry.source}] ${entry.text}`);
  }
  lines.push('```');
  return lines.join('\n');
}
