/**
 * 应用外壳（React 层）。
 *
 * 刻意很薄：它只做三件事 —— 摆布局槽位、按贡献点渲染工具栏、显示状态。
 * 任何一个按钮的行为都不在这里写死，全都是"执行某个命令"。
 *
 * 换句话说：如果哪天 React 被换掉，插件生态毫发无损。
 * 这就是"插件 API 框架无关"带来的自由。
 *
 * 另一点重要：编辑器宿主节点是**常驻**的，运行时创建前后它都不卸载。
 * 如果把宿主放进条件渲染里，React 会在运行时建好后把那个节点连同
 * CodeMirror 实例一起销毁 —— 这类 bug 表现为"启动后编辑器空白且无报错"。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type RefObject,
} from 'react';

import { createRuntime, type AropytRuntime, type RuntimeState } from './runtime.js';
import { Icon } from './components/Icons.js';
import { PluginsPanel } from './components/plugins-panel';
import { CommandPalette } from './components/CommandPalette';
import { DebugPanel } from './components/DebugPanel';
import { ViewColumn } from './components/ViewHost.js';
import { SettingsDialog } from './components/SettingsDialog.js';
import { HistoryDialog } from './components/HistoryDialog.js';

export function App(): JSX.Element {
  const editorHostRef = useRef<HTMLDivElement>(null);
  const [runtime, setRuntime] = useState<AropytRuntime | null>(null);
  // 侧栏与面板各自独立开关，对应 VS Code 的 Toggle Primary/Secondary Side Bar。
  //
  // 默认值随宽度走：宽屏（桌面）面板默认打开，因为 Typora 的核心体验
  // 就是编辑器与预览并排；窄屏（Android）默认全关，否则一进来就被
  // 两个覆盖层糊住屏幕，连字都打不了。
  /*
   * 侧栏开关：**保存用户的选择**（localStorage 同步读取，首帧就生效）。
   * 没存过才回落到"宽屏默认打开"—— 用户手动关过就尊重用户。
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  /*
   * 侧栏开关**不在组件里存 state**：真源是 settings.jsonc 的
   * sidebar.open，经 RuntimeState 投影订阅（v0.0.9）。
   *
   * 旧实现是 useState + 只在 runtime 变化时 Effect 读一次 —— 配置异步
   * 加载，那一刻拿到的是默认值（open: true），之后永不更新，表现为
   * "配置写 false、界面照样展开"。
   */
  /*
   * Ctrl/Cmd+Shift+P 打开命令面板。
   *
   * 用 window 的**捕获阶段**监听：编辑器（CM6）在冒泡阶段处理键盘，
   * 捕获阶段先拿到，才不会被它吞掉。
   */
  useEffect(() => {
    /*
     * 面板类快捷键统一在**捕获阶段**处理：
     *   ① CM6 / vim 在冒泡阶段处理按键，捕获阶段才抢得到；
     *   ② 全部是 **toggle** —— 再按一次关闭（与 Ctrl+Shift+B 一致）。
     * 逗号用 event.code === 'Comma'：Shift+, 在美式布局上 event.key 是 "<"，
     * 用它判断永远匹配不上（实测 Ctrl+Shift+, 无效的原因）。
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      // 诊断：所有带修饰键或功能键的按键都记录（不只 Ctrl+Shift+B）
      if (event.ctrlKey || event.metaKey || event.altKey || event.key.length > 1) {
        console.log('[kd]', event.code, 'key=', event.key, 'shift=', event.shiftKey, 'alt=', event.altKey, 'ctrl=', event.ctrlKey);
      }
      /*
       * Ctrl+Shift+B：侧栏开合 + 焦点。
       * **必须在 capture handler 最前** —— 后面各分支都会 stopPropagation，
       * 冒泡 handler（下面的 onKeyDown）永远收不到。
       */
      if (event.code === 'KeyB' && (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && runtime) {
        event.preventDefault();
        event.stopPropagation();
        const next = !runtime.getState().sidebarOpen;
        console.log('[focus] KeyB →', next ? 'open' : 'close');
        void runtime.updateSettings({ sidebar: { open: next } });
        if (next) {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const panel = document.querySelector<HTMLElement>('.view-column--left .explorer-tree');
              if (!panel) {
                console.warn('[focus] panel NOT FOUND');
                return;
              }
              const style = getComputedStyle(panel);
              console.log('[focus] display=', style.display, 'visibility=', style.visibility, 'tabindex=', panel.getAttribute('tabindex'));
              panel.focus();
              console.log('[focus] activeElement=', document.activeElement?.className || 'NONE', 'same=', document.activeElement === panel);
            }),
          );
        }
        return;
      }
      // F12：调试面板（不需要修饰键，也不进命令面板 —— 它的存在感要低）
      if (event.code === 'F12' && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        setDebugOpen((value) => !value);
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || !event.shiftKey || event.altKey || !runtime) return;
      const code = event.code;
      const toggle = (setter: (update: (value: boolean) => boolean) => void): void => {
        event.preventDefault();
        event.stopPropagation();
        setter((value) => !value);
      };

      if (code === 'KeyP') return toggle(setPaletteOpen);
      if (code === 'KeyX') return toggle(setPluginsOpen);
      if (code === 'KeyG') return toggle(setHistoryOpen);
      if (code === 'Comma') return toggle(setSettingsOpen);
      if (code === 'KeyM') {
        event.preventDefault();
        event.stopPropagation();
        runtime.toggleVimMode();
        return;
      }
      if (code === 'KeyE') {
        event.preventDefault();
        event.stopPropagation();
        runtime.editor.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    // 应用内查找：WebView 的 Ctrl+F 被拦截后转发到这里
    const onSearch = (): void => {
      (runtime?.editor as unknown as { openSearch?: () => void } | undefined)?.openSearch?.();
    };
    window.addEventListener('aropyt:search', onSearch);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('aropyt:search', onSearch);
    };
  }, [runtime]);

  const liveState = useMaybeRuntimeState(runtime);
  const sidebarOpen = liveState?.sidebarOpen ?? isWideScreen();

  useEffect(() => {
    const host = editorHostRef.current;
    if (!host) return undefined;

    // ?safe 打开安全模式：禁用全部插件，对应 VS Code 的 --disable-extensions。
    // 插件把编辑器搞挂时，这是唯一还能进去的路。
    const safeMode = new URLSearchParams(window.location.search).has('safe');

    const instance = createRuntime({ editorHost: host, safeMode });
    setRuntime(instance);
    return () => instance.dispose();
  }, []);

  /*
   * 宿主级快捷键：
   *   Ctrl/Cmd+Shift+B   切换侧栏
   *   Ctrl/Cmd+Shift+N   新建标签
   *   Ctrl/Cmd+Tab       切换下一个标签（Shift 反向）
   *   Ctrl/Cmd+0         聚焦侧栏
   *
   * 为什么侧栏/新建要带 Shift：Ctrl-B 与 Ctrl-N 在 vim 里分别是
   * "向上翻页"与"插入模式补全"，抢走它们会直接破坏 vim 老用户的肌肉记忆。
   * 带 Shift 的组合 vim 不用，宿主安全接管。
   */
  useEffect(() => {
    /*
     * **只用捕获阶段一个 handler**（之前是"捕获阶段 stopPropagation + 冒泡
     * 阶段执行"——stopPropagation 会把事件从传播链上摘掉，冒泡阶段根本
     * 收不到，于是所有快捷键集体失效，用户实测六项全废）。
     *
     * 捕获阶段先于 CM6/vim 的键位层（它们监听的是 contentDOM 上的冒泡），
     * 所以这里 preventDefault + stopPropagation 才能压过 vim 的 Prec.highest。
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!runtime) return;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey) return;
      const shift = event.shiftKey;
      const key = event.key.toLowerCase();

      if (key === 'n' && shift) {
        event.preventDefault();
        event.stopPropagation();
        runtime.createUntitledTab();
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        runtime.activateRelativeTab(shift ? -1 : 1);
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        event.stopPropagation();
        const target =
          document.querySelector<HTMLElement>(
            '.view-column [tabindex]:not([tabindex="-1"]), .view-column button, .view-column [role="treeitem"]',
          ) ?? document.querySelector<HTMLElement>('.view-column');
        target?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [runtime]);

  /*
   * 关闭窗口拦截（桌面壳）：有未保存修改时先确认，防误关丢内容。
   *
   * 浏览器开发模式下 import('@tauri-apps/api/window') 会失败 —— 静默
   * catch，Web 形态本来就没有"关窗口"这件事。
   * destroy() 而不是 close()：close 会再次触发 onCloseRequested，
   * 形成"确认→close→再确认"的死循环。
   */
  useEffect(() => {
    if (!runtime) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const off = await win.onCloseRequested(async (event) => {
          const snap = runtime.getState();
          const anyDirty = snap.dirty || snap.tabs.some((tab) => tab.dirty);
          if (!anyDirty) return;
          event.preventDefault();
          const choice = await runtime.windowService.showMessage(
            '有未保存的修改，确定要退出吗？',
            {
              level: 'warning',
              actions: [
                { label: '保存并退出', run: () => {} },
                { label: '不保存退出', run: () => {} },
              ],
            },
          );
          if (choice === undefined) return; // 取消
          if (choice === '保存并退出') await runtime.saveActiveFile();
          await win.destroy();
        });
        if (disposed) off();
        else unlisten = off;
      } catch {
        /* 浏览器开发模式：没有 Tauri 窗口 API */
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [runtime]);

  return (
    <div className={debugOpen ? 'app app--debug' : 'app'}>
      {liveState?.safeMode && (
        <div className="safe-banner" role="status">
          安全模式：所有插件已停用（上次启动可能异常）。可在「插件」面板里删除可疑插件后重启。
        </div>
      )}
      <header className="app-header">
        <button
          type="button"
          className="icon-button"
          title="侧栏"
          aria-label="侧栏"
          aria-pressed={sidebarOpen}
          onClick={() => void runtime?.updateSettings({ sidebar: { open: !sidebarOpen } })}
        >
          <Icon name={sidebarOpen ? 'sidebarActive' : 'sidebar'} />
        </button>
        {/*
         * 这里原来还有 logo + "Aropyt" 品牌标记，已删除。
         *
         * 理由是**信息量为零**：桌面形态下原生窗口标题栏已经写着软件名，
         * WebView 里再写一遍是同一句话；移动端则由启动器图标承担识别。
         * 而logo.svg 是 3.2KB 的path 数据 + 一条 public 资源，
         * 为了显示一个到处都有的名字而常驻首屏，不划算。
         *
         * 侧栏按钮仍在原位：它是**布局开关**，删掉品牌标记不该顺带删掉它。
         */}
        {runtime && <Header runtime={runtime} />}
      </header>

      <Shell
            onOpenPlugins={() => setPluginsOpen(true)}
        runtime={runtime}
        editorHostRef={editorHostRef}
        sidebarOpen={sidebarOpen}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHistory={() => setHistoryOpen(true)}
      />
      {historyOpen && runtime && runtime.getState().activePath && (
        <HistoryDialog
          runtime={runtime}
          path={runtime.getState().activePath ?? ''}
          onClose={() => setHistoryOpen(false)}
        />
      )}


      {paletteOpen && runtime && (
        <CommandPalette runtime={runtime} onClose={() => setPaletteOpen(false)} />
      )}

      {pluginsOpen && runtime && (
        <PluginsPanel
          runtime={runtime}
          records={runtime.getState().plugins}
          onClose={() => setPluginsOpen(false)}
        />
      )}

      {settingsOpen && runtime && (
        <SettingsDialog
          runtime={runtime}
          settingsPath={runtime.settingsPath}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/*
       * 调试面板：停靠在内容区下方（不是悬浮弹窗）—— 一边操作一边看。
       */}
      {debugOpen && runtime && (
        <DebugPanel runtime={runtime} version={__APP_VERSION__} onClose={() => setDebugOpen(false)} />
      )}

      <footer className="status-bar">
        {runtime ? <StatusBar runtime={runtime} /> : <span className="status-item">正在启动…</span>}
      </footer>

      {runtime && <Toasts runtime={runtime} />}
    </div>
  );
}


/**
 * 主体布局。**无条件渲染**，即使运行时还没起来。
 *
 * 关键在编辑器宿主那个 div：它必须在整个生命周期里是**同一个 DOM 节点**。
 * 如果按 `runtime ? <带编辑器> : <空工具栏>` 这样分两支渲染，
 * React 会在运行时创建后把旧分支卸载 —— 连同一个 CodeMirror 实例一起销毁。
 * 表现是"启动后编辑器空白且没有任何报错"，所以这里不能图省事拆分支。
 *
 * 单独抽一个组件只是为了能调用 useRuntimeState（面板开合归运行时所有：
 * 打开面板会连带把编辑区逼成源码模式），而 App 顶层拿不到状态快照，
 * hook 又不能条件调用。
 */
function Shell({
  runtime,
  editorHostRef,
  sidebarOpen,
  onOpenSettings,
  onOpenHistory,
  onOpenPlugins,
}: {
  readonly runtime: AropytRuntime | null;
  readonly editorHostRef: RefObject<HTMLDivElement>;
  readonly sidebarOpen: boolean;
  readonly onOpenSettings: () => void;
  readonly onOpenHistory: () => void;
  readonly onOpenPlugins: () => void;
}): JSX.Element {
  return (
    <div className="app-body">
      {runtime && <ViewColumn runtime={runtime} location="sidebar" side="left" open={sidebarOpen} />}

      <main className="app-main">
        {runtime ? <Toolbar runtime={runtime} onOpenSettings={onOpenSettings} onOpenHistory={onOpenHistory} onOpenPlugins={onOpenPlugins} /> : <div className="toolbar" />}
        <div className="app-editor" ref={editorHostRef} />
      </main>

    </div>
  );
}

/** runtime 为 null 时也能订阅的空实现。 */
function useMaybeRuntimeState(runtime: AropytRuntime | null): RuntimeState | null {
  const subscribe = useCallback(
    (listener: () => void) => (runtime ? runtime.subscribe(listener) : () => undefined),
    [runtime],
  );
  const getSnapshot = useCallback(() => runtime?.getState() ?? null, [runtime]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

function useRuntimeState(runtime: AropytRuntime): RuntimeState {
  const state = useMaybeRuntimeState(runtime);
  // 调用点都已经判过runtime 非空，这里拿到 null 只可能是逻辑漏判，
  // 与其静默渲染空白不如立刻暴露。
  if (!state) throw new Error('useRuntimeState 在 runtime 为 null 时被调用');
  return state;
}

function useWindowRevision(runtime: AropytRuntime): number {
  const subscribe = useCallback((listener: () => void) => runtime.windowService.subscribe(listener), [runtime]);
  const getSnapshot = useCallback(() => runtime.windowService.revision, [runtime]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

function runCommand(runtime: AropytRuntime, commandId: string): void {
  void runtime.commands.execute(commandId).catch((error: unknown) => {
    console.error(error);
    /*
     * 提示里必须带上**真实错误信息**，不能只给命令 id。
     *
     * 原来只显示 `命令执行失败：aropyt.file.pickWorkspace` ——
     * 那条提示把"哪个命令挂了"说清楚了，却把"为什么挂"完全藏起来，
     * 于是无论什么问题看起来都一模一样。实际那次是
     * `window.showMessage is not a function`，但光看提示根本无从判断。
     *
     * 定位信息（命令 id）放前面是为了多个提示堆叠时仍能扫读。
     */
    const detail = error instanceof Error ? error.message : String(error);
    void runtime.windowService.showMessage(
      `命令执行失败：${commandId}\n${detail}`,
      { level: 'error' },
    );
  });
}

function Header({ runtime }: { readonly runtime: AropytRuntime }): JSX.Element {
  const state = useRuntimeState(runtime);

  return (
    <>
      <span className="app-workspace">
        {state.workspace ? state.workspace.name : '未打开工作区'}
        {/*
         * 当前文件名不再显示 —— 标签栏就在旁边，激活标签上写着它，
         * 这里再重复一遍是同一句话。
         *
         * 脏点（●）保留：标签上的脏点只标"那个标签"是否未保存，
         * 这里的 ● 是未命名文档（它没有标签）唯一的未保存提示 ——
         * 去掉它，未命名文档改了字就再也看不到任何脏标记了。
         */}
        {state.dirty ? ' ●' : ''}
      </span>
      {/*
       * 标签栏就在**工作目录名这一行**里，紧跟着目录名、吃掉中间的剩余宽度 ——
       * 这正是用户要的布局：打开的是哪个目录、现在开着哪些文件，一眼同排。
       * 它在 spacer 之前，所以右侧的「能力说明 / 主题」按钮仍靠最右。
       */}
      {runtime && <TabBar runtime={runtime} />}
      <span className="app-header-spacer" />
      {state.limitations.length > 0 && (
        <button
          type="button"
          className="button"
          title={state.limitations.join('\n')}
          onClick={() =>
            void runtime.windowService.showMessage(state.limitations.join('\n'), { level: 'info' })
          }
        >
          平台能力说明
        </button>
      )}
    </>
  );
}

function isWideScreen(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 901px)').matches;
}

interface ToolbarProps {
  readonly runtime: AropytRuntime;
  readonly onOpenSettings: () => void;
  readonly onOpenHistory: () => void;
  readonly onOpenPlugins: () => void;
}

function Toolbar({ runtime, onOpenSettings, onOpenHistory, onOpenPlugins }: ToolbarProps): JSX.Element {
  const state = useRuntimeState(runtime);
  const details = new Map(runtime.commands.details().map((item) => [item.id, item]));
  const groups = groupToolbar(state.toolbar);

  return (
    <div className="toolbar" role="toolbar" aria-label="工具栏">
      {groups.map((group, index) => (
        <ToolbarGroup
          key={group.key}
          commands={group.commands}
          details={details}
          onRun={(commandId) => runCommand(runtime, commandId)}
          withSeparator={index > 0}
        />
      ))}
      <span className="toolbar-spacer" />


      {/* 编辑历史 */}
      <button
        type="button"
        className="tool-button"
        title="编辑历史"
        aria-label="编辑历史"
        onClick={onOpenHistory}
        disabled={!state.activePath || Boolean(state.activePath?.startsWith('__untitled__'))}
      >
        <Icon name="history" />
      </button>

      {/* 设置面板入口 */}
      <button
        type="button"
        className="tool-button"
        title="设置"
        aria-label="设置"
        onClick={onOpenSettings}
      >
        <Icon name="setting" />
      </button>

      {/*
       * 插件管理入口（v0.0.3）：列出全部插件的启用状态与原因。
       * 完整的管理面板（启用/禁用开关）是下一步 —— 目前这条入口
       * 至少让"某个功能为什么没生效"可被用户看到。
       */}
      <button
        type="button"
        className="tool-button"
        title="插件管理"
        aria-label="插件管理"
        onClick={onOpenPlugins}
      >
        <Icon name="plugin" />
      </button>

      {/*
       * 视图开关不进命令注册表，也不该来自插件贡献 ——
       * 否则"关掉源码模式"会依赖某个插件是否装上了。
       * 快捷键 Ctrl+/ 已在内核的 keymap 里绑好。
       *
       * 按钮状态用 preferredSourceMode（用户自己的选择）而不是 sourceMode
       * （实际生效）：一旦两者会因为外部强制而分叉，用 sourceMode 的按钮
       * 就会亮着、点了没反应 —— 那比不显示状态更糟。
       *
       * 现在**没有任何东西会强制源码模式**（预览面板不再拽着编辑区），
       * 所以 preferredSourceMode 就是 sourceMode，禁用态也一并去掉。
       */}
      {/*
       * vim 模式下**不显示**源码模式按钮：vim 恒为源码态（块渲染与
       * 行级光标本质冲突），按钮留着只会让人以为能切、点不动又困惑。
       * 需要源码/渲染切换时先关掉 vim。
       */}
      {!state.vimMode && (
        <button
          type="button"
          className={`tool-button${state.sourceMode ? ' tool-button--on' : ''}`}
          title={state.sourceMode ? '退出源码模式 (Ctrl+/)' : '源码模式 (Ctrl+/)'}
          aria-label={state.sourceMode ? '退出源码模式' : '进入源码模式'}
          aria-pressed={state.sourceMode}
          onClick={() => runtime.toggleSourceMode()}
        >
          <Icon name="invisible" />
        </button>
      )}

      {/*
       * 预览面板开关**已从工具栏移除**。
       *
       * 原来的按钮提示写着"打开预览面板（编辑区切到源码模式）"——
       * 那条耦合本身就是问题的来源：Typora 式的编辑体验是**边写边看渲染**，
       * 编辑区永远该是渲染态，不该因为旁边多了一栏就被拽成源码。
       * 面板本身还在，改由 Ctrl+Shift+V 开关（见 runtime），
       * 打开它不会影响编辑区的模式。
       */}
    </div>
  );
}

interface DeclaredCommandLike {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
}

interface ToolbarGroupProps {
  readonly commands: readonly string[];
  readonly details: ReadonlyMap<string, DeclaredCommandLike>;
  readonly onRun: (commandId: string) => void;
  readonly withSeparator: boolean;
}

function ToolbarGroup({ commands, details, onRun, withSeparator }: ToolbarGroupProps): JSX.Element {
  return (
    <>
      {withSeparator && <span className="toolbar-separator" />}
      {commands.map((commandId) => {
        const detail = details.get(commandId);
        return (
          <button
            key={commandId}
            type="button"
            className="tool-button"
            title={detail?.title ?? commandId}
            aria-label={detail?.title ?? commandId}
            onClick={() => onRun(commandId)}
          >
            <Icon name={detail?.icon ?? 'defaultPlugin'} />
          </button>
        );
      })}
    </>
  );
}

function StatusBar({ runtime }: { readonly runtime: AropytRuntime }): JSX.Element {
  const state = useRuntimeState(runtime);
  /*
   * 只统计**加载失败**的插件。用户主动禁用的（state === 'disabled'）
   * 不是故障 —— 之前两者混在一起，禁用插件后左下角反而出现
   * "1 个功能模块未能加载"，像是出错了（实测）。
   */
  const failedPlugins = state.plugins.filter((record) => record.state === 'failed');
  return (
    <>
      {/*
       * vim 模式指示器（左下角，用户约定）：开启显示 vim-mode 图标，
       * 未开启显示品牌色绿点（--md-brand-green）。它本身就是开关。
       */}
      <button
        type="button"
        className="status-bar__vim"
        aria-pressed={state.vimMode}
        title={state.vimMode ? 'vim 模式已开启（点击关闭）' : 'vim 模式未开启（点击开启）'}
        onClick={() => runtime.toggleVimMode()}
      >
        {state.vimMode ? (
          /*
           * vim-mode 图标 + 子模式文字（NORMAL / INSERT / VISUAL）。
           * 用户要的就是这个组合：图标标识"处于 vim 模式"，文字说明
           * "在 vim 的哪个子模式里"。
           */
          <>
            <Icon name="vimMode" />
            <span className="status-bar__vim-mode">
              {state.vimSubMode ? state.vimSubMode.toUpperCase() : 'NORMAL'}
            </span>
          </>
        ) : (
          <span
            className="status-bar__dot"
            aria-hidden="true"
            style={{
              background: state.dirty
                ? 'var(--md-state-red)'
                : state.recoveredPath === state.activePath && state.recoveredPath !== null
                  ? 'var(--md-state-yellow)'
                  : 'var(--md-brand-green)',
            }}
          />
        )}
      </button>
      {/*
       * 「插件 4/4」已移除。
       *
       * 它原本是`activePlugins / plugins.length`，对用户毫无意义：
       * 4 个全是内置的基础功能（文件、编辑、表格、预览），
       * 不是用户装的扩展。"4/4"读起来像"你装了 4 个插件，只启动了 4 个"，
       * 会让人去找插件商店 —— 而这个产品目前根本没有那东西。
       *
       * 真正需要暴露的是**异常**：插件被禁用了（多半是加载失败），
       * 那个必须留在状态栏，而且要能点开看到原因。
       */}
      {failedPlugins.length > 0 && (
        <button
          type="button"
          className="status-item status-item--warn status-item--button"
          title={failedPlugins
            .map((record) => `${record.manifest.name}：${record.reason}`)
            .join('\n')}
          onClick={() =>
            void runtime.windowService.showMessage(
              failedPlugins
                .map((record) => `${record.manifest.name}：${record.reason}`)
                .join('\n'),
              { level: 'warning' },
            )
          }
        >
          {failedPlugins.length} 个插件加载失败
        </button>
      )}
            <span className="status-bar__spacer" />
      {(() => {
        const text = runtime.editor.getText();
        const lines = text.length === 0 ? 1 : text.split('\n').length;
        const words = (text.match(/[A-Za-z0-9_'-]+/g) ?? []).length;
        const chars = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
        return (
          <span className="status-bar__stats" title="行 / 词 / 字">
            {lines} 行 · {words} 词 · {chars} 字
          </span>
        );
      })()}
    </>
  );
}

/** 取路径里最后一段，标签上只显示文件名。 */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * 标签栏。
 *
 * 两种标签用**斜体**区分，这是 VSCode 的约定：
 *
 *   斜体（预览标签）—— 在文件树里单击打开的。**至多一个**，
 *     下一次单击会把它顶掉，所以"随手翻几个文件看看"不会塞满标签栏。
 *   正体（固定标签）—— 双击打开的、或者被编辑过的。不会被顶掉。
 *
 * 斜体不是装饰，是**状态指示**：它告诉用户"这个标签是临时的，
 * 你一旦动了它、或者点了别的文件，它就会变"。少了这个提示，
 * 用户没法预判自己刚才那次单击会不会把什么东西挤走。
 */
function TabBar({ runtime }: { readonly runtime: AropytRuntime }): JSX.Element | null {
  const state = useRuntimeState(runtime);
  /*
   * tabs 为空时**也渲染**：右侧的「+」是新建文档的入口，
   * 一张标签都没有时它恰恰最有用。
   */
  if (!runtime) return null;

  return (
    <div className="tab-bar" role="tablist" aria-label="打开的文件">
      {state.tabs.map((tab) => {
        const active = tab.path === state.activePath;
        const dirty = active && state.dirty;
        // 未命名标签：__untitled__-1 → Untitled.md，-2 → Untitled 2.md（同 VSCode 习惯）
        const untitledMatch = /^__untitled__-(\d+)$/.exec(tab.path);
        const name = untitledMatch
          ? (untitledMatch[1] === '1' ? 'Untitled.md' : `Untitled ${untitledMatch[1]}.md`)
          : baseName(tab.path);
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={active}
            className={
              'tab' +
              (active ? ' tab--active' : '') +
              (tab.preview ? ' tab--preview' : '')
            }
            title={tab.preview ? `${tab.path}（预览，编辑后固定）` : tab.path}
            onClick={() => runtime.activateTab(tab.path)}
          >
            <span
              className="tab__label"
              onMouseDown={(event) => {
                // 中键按下的默认行为是"自动滚动"（图标+拖动）—— 不拦掉它，
                // auxclick 永远不会到来（用户实测：中键变成拖拽滚动）
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                event.stopPropagation();
                runtime.closeTab(tab.path);
              }}
            >
              {name}
            </span>
            {dirty && (
              <span className="tab__dirty" aria-label="未保存">
                ●
              </span>
            )}
            <button
              type="button"
              className="tab__close"
              aria-label={`关闭 ${name}`}
              onClick={(event) => {
                // 不冒泡：否则关标签会顺手把它激活一下，看起来像"点两次"
                event.stopPropagation();
                runtime.closeTab(tab.path);
              }}
              onAuxClick={(event) => {
                // 中键关闭（浏览器/VSCode 的通用手势）
                if (event.button !== 1) return;
                event.preventDefault();
                event.stopPropagation();
                runtime.closeTab(tab.path);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      {/*
       * 新建标签。放在标签列表的最右 —— 与浏览器/VSCode 同位，
       * "在最后一个标签旁边开新的"是这条视觉惯例的语义。
       * 已有未命名标签时点击会直接激活它，不会堆出两张未命名。
       */}
      <button
        type="button"
        className="tab-add"
        aria-label="新建标签页"
        title="新建标签页"
        onClick={() => runtime.createUntitledTab()}
      >
        +
      </button>
    </div>
  );
}

function Toasts({ runtime }: { readonly runtime: AropytRuntime }): JSX.Element | null {
  useWindowRevision(runtime);
  const toasts = runtime.windowService.toasts;
  if (toasts.length === 0) return null;

  return (
    <div className="toasts">

      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast${
            toast.level === 'error' ? ' toast--error' : toast.level === 'warning' ? ' toast--warning' : ''
          }`}
        >
          {/*
           * 文字区负责关闭，按钮区不冒泡 ——
           * 否则点「丢弃」会顺手把提示关掉又执行动作，看起来像"点了两次"。
           */}
          <span className="toast__text" onClick={() => runtime.windowService.dismiss(toast.id)}>
            {toast.message}
          </span>
          {toast.actions && toast.actions.length > 0 && (
            <span className="toast__actions">
              {toast.actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className="toast__action"
                  onClick={() => {
                    /*
                     * ⚠️ 顺序不能反：先 run（结算真实选择），再 dismiss。
                     * dismiss 会把等待中的 showMessage 以 undefined（取消）
                     * 结算，Promise 只能结算一次 —— 先 dismiss 等于把所有
                     * 按钮都变成"取消"（关闭标签不保存、退出软件退不掉）。
                     */
                    action.run();
                    runtime.windowService.dismiss(toast.id);
                  }}
                >
                  {action.label}
                </button>
              ))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function groupToolbar(
  items: readonly { command: string; group: string; order: number }[],
): readonly { key: string; commands: readonly string[] }[] {
  const buckets = new Map<string, string[]>();
  for (const item of items) {
    const bucket = buckets.get(item.group) ?? [];
    bucket.push(item.command);
    buckets.set(item.group, bucket);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, commands]) => ({ key, commands }));
}

