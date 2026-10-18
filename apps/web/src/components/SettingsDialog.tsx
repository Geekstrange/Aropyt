/**
 * 设置面板（v0.0.5）。
 *
 * 形态选择：**模态**而不是独立视图 —— 设置项还很少，视图槽位留给内容区；
 * 等插件开始贡献自己的设置页时再升级成视图（届时可以按 location 分组）。
 *
 * 这一版的边界：
 *  - 能改的：主题、vim 开关（走运行时既有 API，改动立即生效）
 *  - 只读展示：配置文件路径（+ 打开文件按钮）
 *  - 还没接：把改动写回 settings.jsonc —— 需要先让配置成为"真源"
 *    （现在 theme/vim 仍读 localStorage），那一步单独做，避免半套同步。
 */
import { useCallback, useSyncExternalStore, type JSX } from 'react';
import type { AropytRuntime, RuntimeState } from '../runtime.js';

interface SettingsDialogProps {
  readonly runtime: AropytRuntime;
  readonly settingsPath: string | null;
  readonly onClose: () => void;
}

/**
 * 订阅运行时状态。
 *
 * 上一版把 themePreference / vimMode 当 props 传进来 —— 那是**渲染时的快照**，
 * 点开关后组件不会重渲染，界面看起来"点了没反应"（用户实测）。
 * 状态必须订阅，不能用快照。
 */
function useRuntimeState(runtime: AropytRuntime): RuntimeState {
  const subscribe = useCallback(
    (listener: () => void) => runtime.subscribe(listener),
    [runtime],
  );
  const getSnapshot = useCallback(() => runtime.getState(), [runtime]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

const THEME_OPTIONS: { value: 'light' | 'dark' | 'auto'; label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'auto', label: '跟随系统' },
];

export function SettingsDialog({
  runtime,
  settingsPath,
  onClose,
}: SettingsDialogProps): JSX.Element {
  const state = useRuntimeState(runtime);
  const themePreference = state.themePreference;
  const vimMode = state.vimMode;
  return (
    <div className="settings-backdrop" role="presentation" onClick={onClose}>
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-dialog__header">
          <h2>设置</h2>
          <button type="button" className="settings-dialog__close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>

        <section className="settings-section">
          <h3>外观</h3>
          <div className="settings-row">
            <span className="settings-row__label">主题</span>
            <div className="settings-segmented">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={option.value === themePreference ? 'is-active' : ''}
                  aria-pressed={option.value === themePreference}
                  onClick={() => {
                    /*
                     * 直接写配置（而不是 theme.cycle()）——
                     * cycle 只改内存 + localStorage，不会落到 settings.jsonc；
                     * 配置成为真源后，主题也必须经由 updateSettings 走一遍。
                     */
                    runtime.updateSettings({ theme: option.value });
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h3>编辑</h3>
          <div className="settings-row">
            <span className="settings-row__label">Vim 模式</span>
            <button
              type="button"
              className={`settings-switch${vimMode ? ' is-on' : ''}`}
              aria-pressed={vimMode}
              onClick={() => runtime.toggleVimMode()}
            >
              <span className="settings-switch__knob" />
            </button>
          </div>
          <p className="settings-hint">
            vim 模式固定源码态（渲染态下整块 Markdown 只是一个 DOM 块，j/k 无法逐行移动）。
          </p>
        </section>

        <section className="settings-section">
          <h3>配置文件</h3>
          <div className="settings-row">
            <span className="settings-row__label">settings.jsonc</span>
            <code className="settings-path">{settingsPath ?? '浏览器模式：配置存于 IndexedDB'}</code>
          </div>
          <div className="settings-actions">
            <button
              type="button"
              className="settings-button"
              onClick={() => runtime.openSettingsFile()}
              disabled={settingsPath === null}
            >
              打开配置文件
            </button>
          </div>
          <p className="settings-hint">
            桌面版才有磁盘配置。界面里的修改目前只作用于本次会话，写回文件在下一版接入。
          </p>
        </section>
      </div>
    </div>
  );
}
