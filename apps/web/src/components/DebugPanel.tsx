import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
} from 'react';
import { useT } from '../i18n/useT';
import type { AropytRuntime, RuntimeState } from '../runtime';
import {
  clearLogs,
  collectEnvironment,
  formatReport,
  getLogs,
  subscribeLogs,
  type DebugEnv,
  type DebugSnapshot,
  type LogEntry,
  type LogLevel,
} from '../debug/debug-log';
import { clearTimeline } from '../debug/timeline';

/**
 * DEBUG 面板（F12）—— **底部停靠**，三个标签页。
 *
 * 信息取舍的标准只有一条：**能不能用来定位一个 issue**。
 * 所以「状态」页放复现上下文（文件、模式、插件、环境），
 * 「性能」页区分"面板内采样"与"运行时常驻监控"，
 * 「日志」页的错误不会被普通日志挤掉，且报告可一键复制。
 *
 * 停靠而非悬浮：悬浮会盖住编辑区，且"打开之前的日志看不见"。
 * 拦截在启动时就安装（见 main.tsx），面板只负责展示。
 */
interface DebugPanelProps {
  readonly runtime: AropytRuntime;
  readonly version: string;
  readonly onClose: () => void;
}

const LEVELS: readonly LogLevel[] = ['debug', 'log', 'info', 'warn', 'error'];

type Tab = 'docs' | 'perf' | 'logs';
type CopyState = 'idle' | 'ok' | 'fail';

export function DebugPanel({ runtime, version, onClose }: DebugPanelProps): JSX.Element {
  const t = useT();
  const [level, setLevel] = useState<LogLevel | 'all'>('all');
  const [search, setSearch] = useState('');
  const [fps, setFps] = useState(0);
  const [heapMb, setHeapMb] = useState<number | null>(null);
  const [longTasks, setLongTasks] = useState<{ at: number; duration: number }[]>([]);
  const [inputDelay, setInputDelay] = useState(0);
  const [env, setEnv] = useState<DebugEnv | null>(null);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [tab, setTab] = useState<Tab>('docs');

  const subscribe = useCallback((listener: () => void) => runtime.subscribe(listener), [runtime]);
  const getSnapshot = useCallback(() => runtime.getState(), [runtime]);
  const state = useSyncExternalStore(subscribe, getSnapshot);

  /*
   * 环境里的 Tauri 版本与高熵 UA 只能异步拿；采集失败一律降级，
   * 不能让"报告缺一项"变成新的故障。
   */
  useEffect(() => {
    let cancelled = false;
    void collectEnvironment({
      locale: state.locale,
      theme: state.theme,
      safeMode: state.safeMode,
    }).then((value) => {
      if (!cancelled) setEnv(value);
    });
    return () => {
      cancelled = true;
    };
  }, [state.locale, state.theme, state.safeMode]);

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
                /*
                 * `entry.startTime` 是**相对 timeOrigin** 的高精度时间戳，
                 * 不是 epoch。直接 new Date(startTime) 会显示成 1970 年。
                 * 采集时就换成 Date.now()，长度才是唯一要留下的原始值。
                 */
                ...list.getEntries().map((entry) => ({ at: Date.now(), duration: entry.duration })),
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

  /*
   * 输入延迟：keydown 到下一帧渲染的实际间隔（指数移动平均）。
   * 这是**面板可见的样本**，只在面板打开后才有 —— 报告里另有
   * runtime 常驻探针采到的 `lastInputLatencyMs`，两者含义不同，
   * 不能混成一个数字。
   */
  useEffect(() => {
    let ema = 0;
    let pending = 0;
    let raf = 0;
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
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    window.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  /*
   * 规模用 CodeMirror 的文档元数据，**不要** `getText()`：
   * toString() + split('\n') 是 O(N)，在千行文档上每秒执行一次，
   * 面板自己就会变成卡顿来源。`lines` / `length` 都是 O(1)。
   */
  const doc = runtime.editor.view.state.doc;
  const lineCount = doc.lines;
  const charCount = doc.length;

  /*
   * 线程阻塞占比：**真正的 60 秒滑动窗口**。
   *
   * 原来用"最近 50 条总时长 / 30000"，既没有时间裁剪、也不会随空闲
   * 衰减 —— 空闲十分钟后数字仍然停在那里，看起来像"一直卡"。
   */
  const blockPct = useMemo(() => {
    const since = Date.now() - 60_000;
    const total = longTasks
      .filter((task) => task.at >= since)
      .reduce((sum, task) => sum + task.duration, 0);
    return Math.min(100, Math.round((total / 60_000) * 100));
  }, [longTasks, fps]);

  const snapshot = useMemo<DebugSnapshot>(
    () => ({
      version,
      platform: navigator.platform || 'unknown',
      userAgent: navigator.userAgent,
      now: Date.now(),
      env,
      doc: {
        path: state.activePath,
        dirty: state.dirty,
        lines: lineCount,
        chars: charCount,
        sourceMode: state.sourceMode,
        vimMode: state.vimMode,
        vimSubMode: state.vimSubMode,
        recoveredFrom: state.recoveredPath,
      },
      /*
       * 配置**白名单**：只摘标量与标签路径。
       * 整个 RuntimeState 里有每个标签的完整正文，序列化进去会让报告
       * 超过 issue 的字符上限，把真正的日志截断在中间。
       */
      config: pickConfig(state),
      plugins: state.plugins.map((record) => ({
        id: record.manifest.id,
        name: record.manifest.name,
        state: record.state,
        ...(record.reason ? { reason: record.reason } : {}),
      })),
      fps,
      heapMb,
      inputLatencyMs: inputDelay,
      runtimeLatencyMs: state.lastInputLatencyMs,
      blockPct,
      longTasks,
      budgetViolations: state.budgetViolations,
      budgetDetails: state.budgetDetails,
    }),
    [
      version,
      env,
      state,
      lineCount,
      charCount,
      fps,
      heapMb,
      inputDelay,
      blockPct,
      longTasks,
    ],
  );

  const copyReport = useCallback(async (): Promise<void> => {
    const ok = await copyText(formatReport(snapshot));
    setCopyState(ok ? 'ok' : 'fail');
    window.setTimeout(() => setCopyState('idle'), 1800);
  }, [snapshot]);

  const failedPlugins = state.plugins.filter((record) => record.state === 'failed');

  return (
    <section className="debug-dock" aria-label={t('debug.title')}>
      <div className="debug-dock__bar">
        <div className="debug-dock__left">
          <strong className="debug-dock__title">{t('debug.shortTitle')}</strong>
          <span className="debug-dock__metric">FPS {fps}</span>
          <span className="debug-dock__metric">{t('debug.latency', { ms: inputDelay })}</span>
          <span className="debug-dock__metric">
            {heapMb === null ? t('debug.heapDash') : `${t('debug.heap')} ${heapMb.toFixed(1)}MB`}
          </span>
          <span className="debug-dock__metric">{t('debug.longTasks', { n: longTasks.length })}</span>
          {state.budgetViolations > 0 && (
            <span className="debug-dock__metric status-item--warn">
              {t('debug.blocking', { pct: blockPct })}
            </span>
          )}
          <span className="debug-dock__metric">v{version}</span>
        </div>

        <div className="debug-dock__tabs">
          {(
            [
              ['docs', t('debug.tab.state')],
              ['perf', t('debug.tab.perf')],
              ['logs', t('debug.tab.logs')],
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
          {/* 复制报告放在标题栏：三个页都可能需要它，不该藏在日志页里 */}
          <button type="button" className="settings-button" onClick={() => void copyReport()}>
            {copyState === 'ok'
              ? t('debug.copied')
              : copyState === 'fail'
                ? t('debug.copyFailed')
                : t('debug.copyReport')}
          </button>
          <button type="button" className="settings-dialog__close" aria-label={t('debug.close')} onClick={onClose}>
            ×
          </button>
        </div>
      </div>

      <div className="debug-dock__panel">
        {tab === 'docs' && (
          <div className="debug-grid">
            <div className="debug-cell">
              <h4>{t('debug.doc')}</h4>
              <dl>
                <div><dt>{t('debug.path')}</dt><dd>{state.activePath ?? t('debug.untitled')}</dd></div>
                <div><dt>{t('debug.lines')}</dt><dd>{lineCount}</dd></div>
                <div><dt>{t('debug.chars')}</dt><dd>{charCount}</dd></div>
                <div><dt>{t('tabs.unsaved')}</dt><dd>{state.dirty ? t('common.yes') : t('common.no')}</dd></div>
                <div><dt>{t('debug.recoveredFrom')}</dt><dd>{state.recoveredPath ?? '—'}</dd></div>
              </dl>
            </div>
            <div className="debug-cell">
              <h4>{t('debug.tabs', { n: state.tabs.length })}</h4>
              <ul>
                {state.tabs.map((tabItem) => (
                  <li key={tabItem.path}>
                    {tabItem.path === state.activePath ? '▶ ' : ''}
                    {tabItem.path}
                    {tabItem.dirty ? ' ●' : ''}
                  </li>
                ))}
              </ul>
            </div>
            <div className="debug-cell">
              <h4>{t('debug.editorMode')}</h4>
              <dl>
                <div><dt>vim</dt><dd>{state.vimMode ? `${t('common.on')} (${state.vimSubMode ?? 'normal'})` : t('common.off')}</dd></div>
                <div><dt>source</dt><dd>{state.sourceMode ? t('common.on') : t('common.off')}</dd></div>
                <div><dt>{t('toolbar.sidebar')}</dt><dd>{state.sidebarOpen ? t('common.on') : t('common.off')}</dd></div>
              </dl>
            </div>
            <div className="debug-cell">
              <h4>{t('toolbar.plugins')}</h4>
              <dl>
                <div>
                  <dt>total</dt>
                  <dd>{state.plugins.length}</dd>
                </div>
                <div>
                  <dt>failed</dt>
                  <dd>{failedPlugins.length === 0 ? '—' : failedPlugins.map((item) => item.manifest.id).join(', ')}</dd>
                </div>
                {failedPlugins.map((item) => (
                  <div key={item.manifest.id}>
                    <dt>{item.manifest.id}</dt>
                    <dd>{item.reason ?? t('debug.none')}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="debug-cell">
              <h4>{t('debug.runtime')}</h4>
              <dl>
                <div><dt>{t('debug.version')}</dt><dd>{version}</dd></div>
                <div><dt>{t('debug.platform')}</dt><dd>{navigator.platform || 'unknown'}</dd></div>
                <div><dt>window</dt><dd>{env?.window ?? '…'}</dd></div>
                <div><dt>kernel</dt><dd>{env?.webview ?? '…'}</dd></div>
                <div><dt>shell</dt><dd>{env ? (env.tauri ? `Tauri ${env.tauri}` : 'browser') : '…'}</dd></div>
                <div><dt>locale</dt><dd>{state.locale} · {state.theme}</dd></div>
                <div><dt>safe</dt><dd>{state.safeMode ? t('common.on') : t('common.off')}</dd></div>
              </dl>
            </div>
          </div>
        )}

        {tab === 'perf' && (
          <div className="debug-perf">
            <dl className="debug-metrics">
              <div><dt>FPS</dt><dd>{fps}</dd></div>
              <div><dt>{t('debug.inputLatency', { ms: inputDelay })}</dt><dd>panel</dd></div>
              <div>
                <dt>input (runtime)</dt>
                <dd>{state.lastInputLatencyMs > 0 ? `${state.lastInputLatencyMs}ms` : '—'}</dd>
              </div>
              <div><dt>{t('debug.heapMem', { v: heapMb === null ? '—' : `${heapMb.toFixed(1)} MB` })}</dt><dd /></div>
              <div><dt>{t('debug.blocking', { pct: blockPct })}</dt><dd>60s</dd></div>
              <div><dt>budget</dt><dd>{state.budgetViolations}</dd></div>
            </dl>

            <h4>budget violations</h4>
            {state.budgetDetails.length === 0 ? (
              <p className="debug-logs__empty">{t('debug.none')}</p>
            ) : (
              state.budgetDetails.map((item, index) => (
                <div key={`${item.at}-${index}`} className="debug-logs__row">
                  <span className="debug-logs__time">{new Date(item.at).toLocaleTimeString()}</span>
                  <span className="debug-logs__source">{item.label}</span>
                  <span className="debug-logs__text">
                    {Math.round(item.actualMs)}ms / {item.budgetMs}ms
                  </span>
                </div>
              ))
            )}

            <h4>{t('debug.longTaskHint')}</h4>
            {longTasks.length === 0 ? (
              <p className="debug-logs__empty">{t('debug.none')}</p>
            ) : (
              [...longTasks].reverse().map((task) => (
                <div key={`${task.at}-${task.duration}`} className="debug-logs__row">
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
                aria-label={t('debug.searchLogs')}
                placeholder={t('debug.searchPlaceholder')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
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
                    {option === 'all' ? t('debug.all') : option}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="settings-button"
                onClick={() => {
                  /*
                   * 连带清空操作轨迹：面板里"清空"的语义是"从现在开始观察"，
                   * 只清日志会留下上一轮的轨迹 —— 复现一次之后按清空，
                   * 报告里仍混着不相干的记录。
                   */
                  clearLogs();
                  clearTimeline();
                }}
              >
                {t('debug.clear')}
              </button>
            </div>
            <LogList level={level} search={search} />
          </>
        )}
      </div>
    </section>
  );
}

/**
 * 日志列表单独成组件并 memo 化。
 *
 * 目的不是"少写代码"，而是**隔离观测者与被观测对象**：FPS 每秒
 * 更新一次，如果和 500 行日志在同一个渲染里，每次刷新都要 diff 整个
 * 列表 —— 面板自己就会制造长任务，而它正站在"测卡顿"的位置上。
 */
const LogList = memo(function LogList({
  level,
  search,
}: {
  readonly level: LogLevel | 'all';
  readonly search: string;
}): JSX.Element {
  const t = useT();
  const [logs, setLogs] = useState<readonly LogEntry[]>(() => getLogs().slice());
  const listRef = useRef<HTMLDivElement>(null);
  /** 用户往上翻时不能再被新日志拽回底部。 */
  const stickToBottom = useRef(true);

  useEffect(() => {
    setLogs(getLogs().slice());
    return subscribeLogs(() => setLogs(getLogs().slice()));
  }, []);

  useEffect(() => {
    const element = listRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [logs]);

  const visible = logs.filter((entry) => {
    if (level !== 'all' && entry.level !== level) return false;
    if (search && !entry.text.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div
      className="debug-dock__logs"
      ref={listRef}
      onScroll={() => {
        const element = listRef.current;
        if (!element) return;
        stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
    >
      {visible.length === 0 && <p className="debug-logs__empty">{t('debug.noLogs')}</p>}
      {visible.map((entry) => (
        <div
          /* id 是唯一键；老数据（上次会话落盘）没有 id 时退回时间 + 长度兜底 */
          key={entry.id ?? `${entry.source}-${entry.at}-${entry.text.length}`}
          className={`debug-logs__row debug-logs__row--${entry.level}`}
        >
          <span className="debug-logs__time">{new Date(entry.lastAt).toLocaleTimeString()}</span>
          <span className="debug-logs__source">{entry.source}</span>
          <span className="debug-logs__text">
            {entry.text}
            {entry.count > 1 ? ` ×${entry.count}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
});

/** 只摘标量偏好与标签路径 —— 绝不把正文带进报告。 */
function pickConfig(state: RuntimeState): Record<string, unknown> {
  return {
    locale: state.locale,
    themePreference: state.themePreference,
    theme: state.theme,
    sourceMode: state.sourceMode,
    preferredSourceMode: state.preferredSourceMode,
    vimMode: state.vimMode,
    vimSubMode: state.vimSubMode,
    sidebarOpen: state.sidebarOpen,
    safeMode: state.safeMode,
    history: {
      limit: state.historyLimit,
      autoSave: state.historyAutoSave,
      interval: state.historyInterval,
    },
    workspace: state.workspace?.name ?? null,
    tabs: state.tabs.map((tab) => ({ path: tab.path, dirty: tab.dirty, preview: tab.preview })),
  };
}

/**
 * 复制到剪贴板，失败时退回到隐式 textarea。
 *
 * 桌面 WebView 里 clipboard 可能因为没有用户手势或权限策略而拒绝；
 * 原实现没有 catch，按钮点了毫无反应，看起来像坏了。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 走下面的兜底 */
  }
  try {
    const area = window.document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    window.document.body.appendChild(area);
    area.select();
    const ok = window.document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
