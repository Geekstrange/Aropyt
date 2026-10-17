/**
 * 视图槽位 —— 布局容器的实现。
 *
 * 这是内核保留的"布局槽位"职责：核心决定视图摆在哪、标题叫什么、
 * 容器多大、命令怎么执行，插件只往容器里画东西。
 *
 * 关键约束：容器是**受控节点**。插件的 DOM 出不去这个节点，
 * 它拿不到 window、拿不到 document.body，因此即使某个插件有 bug，
 * 也污染不了应用外壳。
 *
 * ── 槽位从哪来（踩过的坑） ─────────────────────────────────
 * 槽位必须来自**插件清单的视图声明**，不能只来自运行时的 registerView。
 * 因为 registerView 发生在插件 activate() 里，而插件激活靠 onView:<id> 事件，
 * 而该事件的语义是"这个槽位要用了"。如果槽位列表只统计已注册视图，
 * 就形成死锁：没有视图 → 不派发事件 → 插件不激活 → 永远没有视图。
 * 症状是状态栏显示"插件 0/5"、侧栏全空、且没有任何报错。
 *
 * 所以这里读host.contributions.views（启动时从 manifest 汇总，零成本），
 * 再据此反向触发激活。
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react';

import type { Disposable, Event, ViewContext } from '@aropyt/plugin-api';
import { guardSync } from '@aropyt/core';

import type { ViewRegistration } from '../services.js';
import type { AropytRuntime } from '../runtime.js';

interface MountedViewProps {
  readonly viewId: string;
  readonly title: string;
  readonly pluginId: string | null;
  readonly registration: ViewRegistration | undefined;
  readonly runtime: AropytRuntime;
  /** 面板内容是否已折叠（只留标题栏）。 */
  readonly collapsed: boolean;
  readonly onToggleCollapse: () => void;

}

function MountedView({
  viewId,
  title,
  pluginId,
  registration,
  runtime,
  collapsed,
  onToggleCollapse,
}: MountedViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const provider = registration?.provider;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    // 先清空：占位的"正在激活插件…"和插件画出的内容不能叠在一起。
    container.replaceChildren();

    if (!provider) {
      // 占位符也由**这里**创建，而不是 React。
      //
      // 原因：view-body 是 React 渲染的节点，如果它还有 JSX 子节点，
      // React 就会认为那些子节点归自己管；而我们在这个 effect 里
      // 调 replaceChildren() 已经把 React 的子节点删掉了，
      // 之后 React 再去删除它们就会抛
      // "Failed to execute 'removeChild': node is not a child of this node"。
      //
      // 结论：这个容器对 React 必须是**空的**，内部一律由命令式代码管理。
      // 混用两种所有权必然崩，且报错信息完全不指向真正的原因。
      const note = document.createElement('div');
      note.className = 'view-empty';
      note.textContent = runtime.getState().safeMode
        ? '安全模式已禁用全部插件，移除地址栏的 ?safe 后重试。'
        : '正在激活插件…';
      container.append(note);
      return () => container.replaceChildren();
    }

    if (!provider.render) {
      // data() 渲染路径随设置页一起落地。这里明确说明，
      // 而不是留一个空视图让人以为插件坏了。
      const note = document.createElement('div');
      note.className = 'view-empty';
      note.textContent = '此视图仅提供 data()，通用列表渲染计划在 M1 落地。';
      container.append(note);
      return () => container.replaceChildren();
    }

    const viewContext: ViewContext = {
      viewId,
      capabilities: runtime.getState().capabilities.snapshot,
      configuration: runtime.configuration,
      executeCommand: <T,>(commandId: string, ...args: unknown[]) =>
        runtime.commands.execute<T>(commandId, ...args),
      onDidResize: createResizeEvent(container),
    };

    const disposable = guardSync<Disposable | undefined>(
      { scope: 'view.render', pluginId },
      () => provider.render!(container, viewContext),
      undefined,
    );

    return () => {
      // 插件的 dispose 抛异常不能阻止我们清空容器 ——
      // 否则下次挂载会看到两个视图叠在一起。
      guardSync({ scope: 'view.render', pluginId }, () => {
        disposable?.dispose();
      }, undefined);
      container.replaceChildren();
    };
  }, [provider, viewId, pluginId, runtime]);

  return (
    <section className={collapsed ? 'view view--collapsed' : 'view'}>
      {/*
       * 标题栏整条可点，用来折叠 / 展开这个面板 —— 与 VSCode 的约定一致，
       * 也是"只想看文件树、不想看大纲"这类诉求最直接的入口。
       *
       * 用 `<button>` 而不是给 `<header>` 挂 onClick：它是一个
       * **disclosure 控件**，键盘可聚焦、可回车触发、带 aria-expanded，
       * 这些语义原生就有，自己接键盘事件只会漏掉其中几项。
       */}
      {/*
       * 标题栏整条是 disclosure 按钮（键盘可聚焦、aria-expanded），
       * 与 VSCode 一致。
       */}
      <button
        type="button"
        className="view-header"
        aria-expanded={!collapsed}
        title={collapsed ? `展开「${title}」` : `折叠「${title}」`}
        onClick={onToggleCollapse}
      >
        <span className={collapsed ? 'twisty' : 'twisty twisty--expanded'} aria-hidden="true" />
        <span className="view-header__title">{title}</span>
      </button>
      {/*
       * 折叠时**只隐藏、不卸载**：这块容器是插件用命令式代码填的
       * （见上面 effect），卸载会连同插件在里面的状态一起丢掉，
       * 再展开要重渲染一遍。用 CSS 隐藏既保住了状态，也保住了滚动位置。
       */}
      <div className="view-body" ref={containerRef} />
    </section>
  );
}

function createResizeEvent(container: HTMLElement): Event<{ width: number; height: number }> {
  return (listener) => {
    if (typeof ResizeObserver === 'undefined') return { dispose: () => undefined };

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      listener({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(container);

    return {
      dispose: () => observer.disconnect(),
    };
  };
}

/** useSyncExternalStore：只有 revision 变化才重渲染，避免每次 setState 都重画整棵树。 */
function useWindowRevision(runtime: AropytRuntime): number {
  const subscribe = useCallback(
    (listener: () => void) => runtime.windowService.subscribe(listener),
    [runtime],
  );
  const getSnapshot = useCallback(() => runtime.windowService.revision, [runtime]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/*
 * 面板折叠状态的存储键。按 location 分开存：
 * 侧栏（文件 / 大纲）与右侧面板（预览）是两组独立的偏好，
 * 共用一个集合的话，折叠侧栏的"文件"会连带把同名的右侧视图也折了。
 */
const COLLAPSE_STORAGE_KEY = 'aropyt.viewColumn.collapsed';

/**
 * 读取已折叠的面板 id。
 *
 * 为什么是 localStorage 而不是配置系统：配置走 IndexedDB 是异步的，
 * 首帧拿不到，用户会看到面板先展开再"啪"地收起。这与主题偏好的
 * 取舍完全一样（见 theme.ts 的说明）—— 同步存储才能首帧就对。
 *
 * 整个过程必须容错：隐私模式 / 存储被禁用时 localStorage 会直接抛异常，
 * 而"读不到偏好"不该让侧栏整块渲染不出来。
 */
function readCollapsedViewIds(location: string): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(`${COLLAPSE_STORAGE_KEY}.${location}`);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === 'string'));
  } catch {
    return new Set();
  }
}

function persistCollapsedViewIds(location: string, ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(`${COLLAPSE_STORAGE_KEY}.${location}`, JSON.stringify([...ids]));
  } catch {
    // 写不进去只意味着"下次启动记不住"，本次会话的状态是对的 ——
    // 不该因为一次持久化失败弹提示打断用户。
  }
}

interface ViewColumnProps {
  readonly runtime: AropytRuntime;
  readonly location: 'sidebar' | 'panel';
  readonly side: 'left' | 'right';
  /** 窄屏下是否展开。宽屏时CSS 忽略这个值。 */
  readonly open: boolean;
}

export function ViewColumn({ runtime, location, side, open }: ViewColumnProps): JSX.Element | null {
  const revision = useWindowRevision(runtime);

  // 惰性初始化：首次渲染前就把偏好读进来，避免"先展开再收起"的闪动。
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() =>
    readCollapsedViewIds(location),
  );

  const toggleCollapse = useCallback(
    (viewId: string) => {
      setCollapsedIds((previous) => {
        const next = new Set(previous);
        if (next.has(viewId)) next.delete(viewId);
        else next.add(viewId);
        /*
         * 状态先落、持久化随后 —— 顺序反过来的话，localStorage 一旦抛异常
         * （配额满 / 隐私模式），界面会"点了没反应"，而真正的原因
         * 只是一个无关紧要的存储失败。
         */
        persistCollapsedViewIds(location, next);
        return next;
      });
    },
    [location],
  );

  // 槽位有两个来源，必须合并：
  //
  //   1. 内核固有视图（预览）—— windowService.coreViews，**天生可用**，
  //      不需要激活，也不该走去激活那条路。
  //   2. 插件声明的视图 —— host.contributions.views，需要经
  //      "派发 onView → 插件激活 → registerView"才拿到 provider。
  //
  // 只读第2 个会让预览凭空消失（它不再出现在插件清单里）；
  // 只读第 1 个则所有插件视图都不显示。两条通道并存是"内核固有 + 插件贡献"
  // 这个结构的必然结果，不是可以合并掉的历史包袱。
  const declared = [
    ...runtime.windowService.coreViews.map((view) => ({ ...view, pluginId: null, builtin: true })),
    ...runtime.host.contributions.views.map((view) => ({ ...view, builtin: false })),
  ]
    .filter((view) => view.location === location)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // 用 id 列表做依赖，避免每次渲染都生成新数组导致 effect 空转。
  const signature = declared.map((view) => view.id).join('|');
  const declaredRef = useRef(declared);
  declaredRef.current = declared;

  const requestedRef = useRef(new Set<string>());
  useEffect(() => {
    for (const view of declaredRef.current) {
      // 内核固有视图不需要激活 —— 派发 onView 给它是无意义的。
      if (view.builtin) continue;
      if (requestedRef.current.has(view.id)) continue;
      requestedRef.current.add(view.id);
      void runtime.host.activateFor(`onView:${view.id}`).catch((error: unknown) => {
        console.error(`激活视图 ${view.id} 所属插件失败`, error);
        void runtime.windowService.showMessage(`视图「${view.title}」加载失败`, { level: 'error' });
      });
    }
  }, [runtime, signature]);

  const registrations = new Map(
    runtime.windowService.viewRegistrations.map((registration) => [registration.id, registration]),
  );

  if (declared.length === 0) return null;
  void revision;


  return (
    <aside
      className={`view-column view-column--${side}`}
      data-open={open ? 'true' : 'false'}
    >
      {declared.map((view) => (
        <MountedView
          key={view.id}
          viewId={view.id}
          title={view.title}
          pluginId={view.pluginId ?? null}
          registration={registrations.get(view.id)}
          runtime={runtime}
          collapsed={collapsedIds.has(view.id)}
          onToggleCollapse={() => toggleCollapse(view.id)}
        />
      ))}
    </aside>
  );
}