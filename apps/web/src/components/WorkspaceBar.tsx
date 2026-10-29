/**
 * 侧栏顶部的工作区条。
 *
 * ── 为什么需要它 ────────────────────────────────────────────
 * 多工作区并存之后，"打开第二个工作区"不再顶替第一个，但界面上没有
 * 任何地方能看到**一共有哪几个工作区**：文件树只显示当前激活那个，
 * 想切回去只能从标签栏里找某个属于它的标签。工作区名原来藏在文件树
 * 内部的抬头里，既不是切换入口，层级也在 Files / Outline 之下。
 *
 * 这里把它提到侧栏最顶部：一行一个工作区，颜色点与标签顶部色条同色
 * （`workspaceAccent`），点一下就切过去。切换会连带换掉文件树与
 * 编辑器里的文档 —— 具体行为由 runtime.activateWorkspace 负责。
 */

import { useCallback, useSyncExternalStore, type JSX } from 'react';

import { t } from '../i18n';
import { workspaceAccent } from '../lib/workspace-color';
import type { AropytRuntime, RuntimeState } from '../runtime.js';

function useRuntimeState(runtime: AropytRuntime): RuntimeState {
  const subscribe = useCallback((listener: () => void) => runtime.subscribe(listener), [runtime]);
  const getSnapshot = useCallback(() => runtime.getState(), [runtime]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

interface WorkspaceBarProps {
  readonly runtime: AropytRuntime;
}

export function WorkspaceBar({ runtime }: WorkspaceBarProps): JSX.Element | null {
  const state = useRuntimeState(runtime);

  if (state.workspaces.length === 0) return null;

  return (
    <div className="workspace-bar" role="listbox" aria-label={t('workspace.list')}>
      {state.workspaces.map((workspace) => {
        const active = workspace.id === state.activeWorkspaceId;
        return (
          <div
            key={workspace.id}
            className={`workspace-bar__item${active ? ' workspace-bar__item--active' : ''}`}
          >
            <button
              type="button"
              role="option"
              aria-selected={active}
              className="workspace-bar__switch"
              title={workspace.name}
              onClick={() => {
                runtime.activateWorkspace(workspace.id);
              }}
            >
              <span
                className="workspace-bar__dot"
                style={{ background: workspaceAccent(workspace.id) }}
                aria-hidden="true"
              />
              <span className="workspace-bar__name">{workspace.name}</span>
            </button>
            <button
              type="button"
              className="workspace-bar__close"
              title={t('toolbar.closeWorkspace')}
              aria-label={t('toolbar.closeWorkspace')}
              onClick={() => {
                void runtime.closeWorkspace(workspace.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
