/**
 * 操作轨迹（timeline）—— issue 复现路径的唯一可信来源。
 *
 * 为什么与日志分开存：
 *   日志是 500 条的环形缓冲，插件打几十行 info 就能把"用户点了保存、
 *   然后崩了"这几条挤出去。轨迹只有关键动作，容量 200 条，且**不接收**
 *   普通 console 输出 —— 它记录的是"用户做了什么"，不是"程序说了什么"。
 *
 * 记录什么：只记能改变应用状态、且用户能描述出来的动作 ——
 *   打开/关闭文件、新建标签、保存及失败、命令执行、工作区切换、
 *   插件加载失败、打开调试面板。
 * 不记：滚动、输入、悬停（噪声，且高频）。
 */
export interface TraceEntry {
  readonly at: number;
  /** 动作名，稳定英文（issue 里可 grep）：open / close / save / command … */
  readonly action: string;
  readonly detail: string;
  /** 失败的动作标 true —— 报告里要与正常动作分开看。 */
  readonly failed?: boolean;
  /** 命令执行耗时（毫秒），只有 command 动作有。 */
  readonly ms?: number;
}

const MAX_ENTRIES = 200;
const buffer: TraceEntry[] = [];

/** 最近一次"会话开始"的时刻，报告用它区分本次与上次。 */
export const sessionStartedAt = Date.now();

export function trace(
  action: string,
  detail: string,
  extra?: { readonly failed?: boolean; readonly ms?: number },
): void {
  const entry: TraceEntry = {
    at: Date.now(),
    action,
    detail,
    ...(extra?.failed ? { failed: true } : {}),
    ...(extra?.ms === undefined ? {} : { ms: Math.round(extra.ms * 10) / 10 }),
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
}

export function getTimeline(): readonly TraceEntry[] {
  return buffer;
}

export function clearTimeline(): void {
  buffer.length = 0;
}

/**
 * 报告里的轨迹段。
 *
 * 失败动作**加粗标记**而不是靠颜色 —— Markdown 报告里颜色不存在，
 * 维护者是按纯文本扫的。
 */
export function formatTimeline(limit = 30): string {
  /* 走公开接口读，别让"读轨迹"有两条路径 */
  const entries = getTimeline().slice(-limit);
  if (entries.length === 0) return '无';

  const lines: string[] = [];
  for (const entry of entries) {
    const time = new Date(entry.at).toLocaleTimeString();
    const flag = entry.failed ? ' **[失败]**' : '';
    const ms = entry.ms === undefined ? '' : ` · ${String(entry.ms)}ms`;
    lines.push(`- ${time} \`${entry.action}\` ${entry.detail}${ms}${flag}`);
  }
  return lines.join('\n');
}

/** 本次会话里失败过的动作（报告摘要用）。 */
export function failedTraces(limit = 10): readonly TraceEntry[] {
  return buffer.filter((entry) => entry.failed).slice(-limit);
}
