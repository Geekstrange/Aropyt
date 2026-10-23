import { useEffect, useMemo, useRef, useState } from 'react';
import type { AropytRuntime } from '../runtime';
import {
  clearLogs,
  formatReport,
  getLogs,
  subscribeLogs,
  type DebugSnapshot,
  type LogLevel,
} from '../debug/debug-log';

/**
 * DEBUG 面板（F12）—— **底部停靠**。
 *
 * 悬浮弹窗会盖住编辑区，且"打开之前的日志看不见"，两样都不适合一边
 * 操作一边观察。这里停靠在窗口底部（挤压编辑区），日志缓冲在应用启动
 * 时就开始收集（见 main.tsx 的 installDebugLog）。
 */
interface DebugPanelProps {
  runtime: AropytRuntime;
  version: string;
  onClose: () => void;
}

const LEVELS: readonly LogLevel[] = ['log', 'info', 'warn', 'error'];

export function DebugPanel({ version, onClose }: DebugPanelProps) {
  const [logs, setLogs] = useState(() => getLogs().slice());
  const [level, setLevel] = useState<LogLevel | 'all'>('all');
  const [fps, setFps] = useState(0);
  const [heapMb, setHeapMb] = useState<number | null>(null);
  const [longTasks, setLongTasks] = useState<{ at: number; duration: number }[]>([]);
  const [copied, setCopied] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLogs(getLogs().slice());
    return subscribeLogs(() => setLogs(getLogs().slice()));
  }, []);

  useEffect(() => {
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number): void => {
      frames += 1;
      if (now - last >= 1000) {
        setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
        const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
        setHeapMb(memory ? memory.usedJSHeapSize / 1048576 : null);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const observer =
      typeof PerformanceObserver === 'function'
        ? new PerformanceObserver((list) => {
            setLongTasks((previous) =>
              [
                ...previous,
                ...list.getEntries().map((entry) => ({ at: entry.startTime, duration: entry.duration })),
              ].slice(-50),
            );
          })
        : null;
    try {
      observer?.observe({ entryTypes: ['longtask'] });
    } catch {
      /* 部分 WebView 不支持 longtask */
    }
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [logs]);

  const snapshot = useMemo<DebugSnapshot>(
    () => ({
      version,
      platform: navigator.platform || 'unknown',
      userAgent: navigator.userAgent,
      now: Date.now(),
      fps,
      heapMb,
      longTasks,
    }),
    [version, fps, heapMb, longTasks],
  );

  const visible = level === 'all' ? logs : logs.filter((entry) => entry.level === level);

  const copyReport = (): void => {
    void navigator.clipboard.writeText(formatReport(snapshot)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <section className="debug-dock" aria-label="调试面板">
      <div className="debug-dock__bar">
        <strong className="debug-dock__title">调试</strong>
        <span className="debug-dock__metric">FPS {fps}</span>
        <span className="debug-dock__metric">
          {heapMb === null ? '堆 —' : `堆 ${heapMb.toFixed(1)}MB`}
        </span>
        <span className="debug-dock__metric">长任务 {longTasks.length}</span>
        <span className="debug-dock__metric">v{version}</span>

        <span className="debug-dock__spacer" />

        <div className="settings-segmented">
          {(['all', ...LEVELS] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={option === level ? 'is-active' : ''}
              aria-pressed={option === level}
              onClick={() => setLevel(option)}
            >
              {option === 'all' ? '全部' : option}
            </button>
          ))}
        </div>
        <button type="button" className="settings-button" onClick={copyReport}>
          {copied ? '已复制' : '复制报告'}
        </button>
        <button type="button" className="settings-button" onClick={clearLogs}>
          清空
        </button>
        <button type="button" className="settings-dialog__close" aria-label="关闭调试面板" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="debug-dock__logs" ref={listRef} role="log">
        {visible.length === 0 && <p className="debug-logs__empty">暂无日志</p>}
        {visible.map((entry, index) => (
          <div key={`${entry.at}-${index}`} className={`debug-logs__row debug-logs__row--${entry.level}`}>
            <span className="debug-logs__time">{new Date(entry.at).toLocaleTimeString()}</span>
            <span className="debug-logs__source">{entry.source}</span>
            <span className="debug-logs__text">{entry.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
