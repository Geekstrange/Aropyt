/**
 * 设置面板（v0.1.1）。
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
import { useCallback, useSyncExternalStore, type JSX, type MouseEvent } from 'react';
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

/**
 * 用系统默认浏览器打开外链。
 *
 * 为什么不能只靠 `<a target="_blank">`：Tauri v2 的 WebView 对
 * `target="_blank"` 与 `window.open` 一律**静默拦截**（不跳转、不报错），
 * 这是它的安全策略。唯一官方出路是 opener 插件的 `openUrl()`，
 * 它把请求交给系统默认浏览器。
 *
 * 浏览器 / PWA 下没有 `__TAURI_INTERNALS__`，退回 `window.open`，
 * 同一份代码两种形态都能用。
 */
function openExternal(url: string): void {
  if ('__TAURI_INTERNALS__' in window) {
    void import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(url));
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
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

  /**
   * 接管链接左键点击：保留 `<a href>` 是为了右键"复制链接地址"、
   * 中键新开和键盘可达性，只把「左键单击」交给 openExternal。
   */
  const handleLink = (url: string) => (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    openExternal(url);
  };

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
          <h2>{"设置"}</h2>
          <button type="button" className="settings-dialog__close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="settings-dialog__body">

          <section className="settings-section">
            <h3>{"关于"}</h3>
            <div className="settings-row">
              <span className="settings-row__label">{"版本"}</span>
              <a
                className="settings-row__label settings-row__link"
                href="https://github.com/Geekstrange/Aropyt/releases"
                onClick={handleLink('https://github.com/Geekstrange/Aropyt/releases')}
              >
                {`Aropyt v${__APP_VERSION__}`}
              </a>
            </div>
            <div className="settings-row">
              <span className="settings-row__label">{"许可"}</span>
              <a
                className="settings-row__label settings-row__link"
                href="https://www.gnu.org/licenses/agpl-3.0.en.html"
                onClick={handleLink('https://www.gnu.org/licenses/agpl-3.0.en.html')}
              >
                {"AGPL-3.0"}
              </a>
            </div>
          </section>

          <section className="settings-section">
            <h3>{"外观"}</h3>
            <div className="settings-row">
              <span className="settings-row__label">{"主题"}</span>
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
              <span className="settings-row__label">{"Vim 模式"}</span>
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
            <h3>{"数据备份"}</h3>
            <div className="settings-row">
              <span className="settings-row__label">草稿与编辑历史</span>
              <div className="settings-actions" style={{ marginTop: 0 }}>
                <button type="button" className="settings-button" onClick={() => void runtime.exportBackup()}>
                  {"导出数据"}
                </button>
                <button type="button" className="settings-button" onClick={() => void runtime.importBackup()}>
                  {"导入数据"}
                </button>
              </div>
            </div>
            <p className="settings-hint">
              导出为单个 JSON 文件（含全部草稿与编辑历史），可用于换机器或重装系统。
              导入会覆盖现有数据，操作前请先导出一份。
            </p>
          </section>

          <section className="settings-section">
            <h3>{"编辑历史"}</h3>
            <div className="settings-row">
              <span className="settings-row__label">{"每文件保留版本数"}</span>
              <input
                type="number"
                className="history-number"
                min={10}
                max={200}
                value={state.historyLimit}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) runtime.updateSettings({ history: { limit: value } });
                }}
              />
            </div>
            <div className="settings-row">
              <span className="settings-row__label">{"自动保存版本"}</span>
              <button
                type="button"
                className={`settings-switch${state.historyAutoSave ? ' is-on' : ''}`}
                aria-pressed={state.historyAutoSave}
                onClick={() => runtime.updateSettings({ history: { autoSave: !state.historyAutoSave } })}
              >
                <span className="settings-switch__knob" />
              </button>
            </div>
            <div className="settings-row">
              <span className="settings-row__label">{"自动保存间隔（秒）"}</span>
              <input
                type="number"
                className="history-number"
                min={15}
                max={3600}
                disabled={!state.historyAutoSave}
                value={state.historyInterval}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) runtime.updateSettings({ history: { autoSaveInterval: value } });
                }}
              />
            </div>
            <p className="settings-hint">
              自动保存按间隔给当前内容记一个版本，内容没变不会重复记录。
              每个文件只保留最近的若干版本，更早的自动淘汰。
            </p>
          </section>

          <section className="settings-section">
            <h3>{"插件配置"}</h3>
            {runtime.pluginConfigSchemas().length === 0 ? (
              <div className="settings-row">
                <span className="settings-row__label">{"尚未有插件声明配置项"}</span>
              </div>
            ) : (
              runtime.pluginConfigSchemas().map((item) => {
                const current = runtime.getPluginConfig<unknown>(item.key, item.schema.default);
                const isBool = item.schema.type === 'boolean';
                return (
                  <div className="settings-row" key={item.key}>
                    <span className="settings-row__label">
                      {item.schema.description ?? item.key}
                    </span>
                    {isBool ? (
                      <div className="settings-segmented">
                        {[
                          { value: true, label: '开' },
                          { value: false, label: '关' },
                        ].map((option) => (
                          <button
                            key={String(option.value)}
                            type="button"
                            className={option.value === current ? 'is-active' : ''}
                            aria-pressed={option.value === current}
                            onClick={() => runtime.setPluginConfig(item.key, option.value)}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <input
                        className="settings-input"
                        type={item.schema.type === 'number' ? 'number' : 'text'}
                        // eslint-disable-next-line @typescript-eslint/no-base-to-string
                        defaultValue={current === undefined ? '' : String(current)}
                        onBlur={(event) => {
                          const raw = event.target.value;
                          runtime.setPluginConfig(
                            item.key,
                            item.schema.type === 'number' ? Number(raw) : raw,
                          );
                        }}
                      />
                    )}
                  </div>
                );
              })
            )}
          </section>

          <section className="settings-section">
            <h3>{"配置文件"}</h3>
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
          </section>
        </div>
      </div>
    </div>
  );
}