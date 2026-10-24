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
 * DEBUG 面板（F12）—— **底部停靠**，三个标签页。
 *
 * "有用信息"的取舍标准：排查一个用户反馈时，第一眼想知道的是
 * **他当时的状态** —— 打开的什么文件、哪个标签、什么模式、
 * 有没有恢复草稿。所以「状态」页放这些，而不是堆运行时数字。
 *
 * 悬浮弹窗会盖住编辑区，且"打开之前的日志看不见"—— 停靠 +
 * 启动即收集（见 main.tsx 的 installDebugLog）。
 */
interface DebugPanelProps {
  runtime: AropytRuntime;
  version: string;
  onClose: () => void;
}

const LEVELS: readonly LogLevel[] = ['log', 'info', 'warn', 'error'];

type Tab = 'docs' | 'perf' | 'logs';

export function DebugPanel({ runtime, version, onClose }: DebugPanelProps) {
  const [logs, setLogs] = useState(() => getLogs().slice());
  const [level, setLevel] = useState<LogLevel | 'all'>('all');
  const [fps, setFps] = useState(0);
  const [heapMb, setHeapMb] = useState<number | null>(null);
  const [longTasks, setLongTasks] = useState<{ at: number; duration: number }[]>([]);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<Tab>('docs');
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

  // 输入延迟：keydown 到下一帧渲染的实际间隔（指数移动平均）。
  // >50ms 用户就能感觉到"跟手"变差 —— 这是"线程阻塞"最直接的体感指标。
  const [inputDelay, setInputDelay] = useState(0);
  useEffect(() => {
    let ema = 0;
    let pending = 0;
    const onKey = (): void => {
      pending = performance.now();
    };
    const tick = (now: number): void => {
      if (pending > 0) {
        const delay = now - pending;
        ema = ema === 0 ? delay : ema * 0.8 + delay * 0.2;
        setInputDelay(Math.round(ema));
        pending = 0;
      }
      raf2 = requestAnimationFrame(tick);
    };
    let raf2 = requestAnimationFrame(tick);
    window.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(raf2);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  useEffect(() => {
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [logs, tab]);

  const state = runtime.getState();
  const [search, setSearch] = useState('');
  const snapshotSettings = useMemo(() => {
    try {
      return JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }, [state]);

  const snapshot = useMemo<DebugSnapshot>(
    () => ({
      version,
      platform: navigator.platform || 'unknown',
      userAgent: navigator.userAgent,
      now: Date.now(),
      fps,
      heapMb,
      longTasks,
      settings: snapshotSettings,
      doc: { path: state.activePath, dirty: state.dirty },
    }),
    [version, fps, heapMb, longTasks, snapshotSettings, state.activePath, state.dirty],
  );

  const visible = logs.filter((entry) => {
    if (level !== 'all' && entry.level !== level) return false;
    if (search && !entry.text.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const copyReport = (): void => {
    void navigator.clipboard.writeText(formatReport(snapshot)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  // 线程阻塞占比：最近 50 个长任务的总时长 / 观测窗口（约 30s）。
  // >10% 说明主线程经常被卡住，"卡顿感"就有了数字来源。
  const blockPct = Math.min(
    100,
    Math.round(
      (longTasks.reduce((sum, task) => sum + task.duration, 0) / 30000) * 100,
    ),
  );

  const lineCount = runtime.editor.getText().length === 0 ? 0 : runtime.editor.getText().split('\n').length;

  return (
    <section className="debug-dock" aria-label="调试面板">
      <div className="debug-dock__bar">
        <div className="debug-dock__left">
          <strong className="debug-dock__title">调试</strong>
          <span className="debug-dock__metric">FPS {fps}</span>
          <span className="debug-dock__metric">延迟 {inputDelay}ms</span>
          <span className="debug-dock__metric">
            {heapMb === null ? '堆 —' : `堆 ${heapMb.toFixed(1)}MB`}
          </span>
          <span className="debug-dock__metric">长任务 {longTasks.length}</span>
          <span className="debug-dock__metric">v{version}</span>
        </div>

        <div className="debug-dock__tabs">
          {(
            [
              ['docs', '状态'],
              ['perf', '性能'],
              ['logs', '日志'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={tab === id ? 'debug-dock__tab is-active' : 'debug-dock__tab'}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="debug-dock__right">
          <button type="button" className="settings-dialog__close" aria-label="关闭调试面板" onClick={onClose}>
            ×
          </button>
        </div>
      </div>

      <div className="debug-dock__panel">
        {tab === 'docs' && (
          <div className="debug-grid">
            <div className="debug-cell">
              <h4>当前文档</h4>
              <dl>
                <div><dt>路径</dt><dd>{state.activePath ?? '（未命名）'}</dd></div>
                <div><dt>行数</dt><dd>{lineCount}</dd></div>
                <div><dt>字符</dt><dd>{runtime.editor.getText().length}</dd></div>
                <div><dt>未保存</dt><dd>{state.dirty ? '是' : '否'}</dd></div>
                <div><dt>恢复来源</dt><dd>{state.recoveredPath ?? '—'}</dd></div>
              </dl>
            </div>
            <div className="debug-cell">
              <h4>标签页（{state.tabs.length}）</h4>
              <ul>
                {state.tabs.map((t) => (
                  <li key={t.path}>
                    {t.path === state.activePath ? '▶ ' : ''}
                    {t.path}
                    {t.dirty ? ' ●' : ''}
                  </li>
                ))}
              </ul>
            </div>
            <div className="debug-cell">
              <h4>编辑器模式</h4>
              <dl>
                <div><dt>vim</dt><dd>{state.vimMode ? `开（${state.vimSubMode ?? 'normal'}）` : '关'}</dd></div>
                <div><dt>侧栏</dt><dd>{state.sidebarOpen ? '开' : '关'}</dd></div>
              </dl>
            </div>
            <div className="debug-cell">
              <h4>运行时</h4>
              <dl>
                <div><dt>版本</dt><dd>{version}</dd></div>
                <div><dt>平台</dt><dd>{navigator.platform || 'unknown'}</dd></div>
                
              </dl>
            </div>
          </div>
        )}

        {tab === 'perf' && (
          <div className="debug-perf">
            <div className="debug-metrics">
              <div><dt>FPS: {fps}</dt></div>
              <div><dt>输入延迟: {inputDelay}ms</dt></div>
              <div><dt>堆内存: {heapMb === null ? '—' : `${heapMb.toFixed(1)} MB`}</dt></div>
              <div><dt>线程阻塞: {blockPct}%</dt></div>
            </div>
            <h4>长任务（&gt;50ms，最近 50 个）</h4>
            {longTasks.length === 0 ? (
              <p className="debug-logs__empty">无</p>
            ) : (
              [...longTasks].reverse().map((task, index) => (
                <div key={`${task.at}-${index}`} className="debug-logs__row">
                  <span className="debug-logs__time">{new Date(task.at).toLocaleTimeString()}</span>
                  <span className="debug-logs__text">{Math.round(task.duration)}ms</span>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'logs' && (
          <>
            <div className="debug-toolbar">
              <span className="debug-dock__spacer" />
              <input
                type="text"
                className="debug-search__input"
                aria-label="搜索日志"
                placeholder="搜索日志…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
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
            </div>
            <div className="debug-dock__logs" ref={listRef}>
              {visible.length === 0 && <p className="debug-logs__empty">暂无日志</p>}
              {visible.map((entry, index) => (
                <div key={`${entry.at}-${index}`} className={`debug-logs__row debug-logs__row--${entry.level}`}>
                  <span className="debug-logs__time">{new Date(entry.at).toLocaleTimeString()}</span>
                  <span className="debug-logs__source">{entry.source}</span>
                  <span className="debug-logs__text">{entry.text}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}