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
import { setLocale } from '../i18n';
import { useT } from '../i18n/useT';

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

const THEME_OPTIONS = [
  { value: 'light', key: 'settings.theme.light' },
  { value: 'dark', key: 'settings.theme.dark' },
  { value: 'auto', key: 'settings.theme.auto' },
] as const;

export function SettingsDialog({
  runtime,
  settingsPath,
  onClose,
}: SettingsDialogProps): JSX.Element {
  const t = useT();
  const state = useRuntimeState(runtime);
  const themePreference = state.themePreference;
  const localePreference = state.locale ?? 'auto';
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
        aria-label={t('settings.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-dialog__header">
          <h2>{t('settings.title')}</h2>
          <button type="button" className="settings-dialog__close" aria-label={t('common.close')} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="settings-dialog__body">

          <section className="settings-section">
            <div className="settings-row">
              <div className="settings-segmented settings-segmented--flags">
                <button
                  type="button"
                  className={localePreference === 'auto' ? 'is-active' : ''}
                  aria-pressed={localePreference === 'auto'}
                  aria-label={t('settings.language.auto')}
                  onClick={() => { runtime.updateSettings({ locale: 'auto' }); setLocale('auto'); }}
                ><svg viewBox='0 0 1152 1024' className='settings-flag settings-flag--auto' aria-hidden='true'><path d="M621.504 669.12L488.64 540.608l1.536-1.472a891.968 891.968 0 0 0 194.304-334.4h153.408V102.4H471.36V0H366.592v102.4H0v101.888h584.96A800.768 800.768 0 0 1 418.944 478.72a800.704 800.704 0 0 1-120.96-171.52H193.28a897.344 897.344 0 0 0 156.032 233.408l-266.624 257.088 74.368 72.64 261.888-256 162.816 159.232 39.744-104.448zM916.416 409.6h-104.832L576 1024h104.704l58.624-153.6h248.768l59.2 153.6H1152l-235.584-614.4v-0.064z m-137.28 358.4L864 546.24 948.864 768h-169.728z" p-id="11117"></path></svg></button>
                <button
                  key="zh"
                  type="button"
                  className={localePreference === 'zh' ? 'is-active' : ''}
                  aria-pressed={localePreference === 'zh'}
                  aria-label="中文"
                  onClick={() => { runtime.updateSettings({ locale: 'zh' }); setLocale('zh'); }}
                ><svg viewBox='0 0 900 600' className='settings-flag' aria-hidden='true'><path fill="#EE1C25" d="M0 0h900v600H0"/><g transform="matrix(3 0 0 3 150 150)"><path id="f-zh-a" fill="#FF0" d="m0-30 17.634 54.27-46.166-33.54h57.064l-46.166 33.54Z"/></g><use href="#f-zh-a" transform="rotate(23.036 2.784 766.082)"/><use href="#f-zh-a" transform="rotate(45.87 38.201 485.396)"/><use href="#f-zh-a" transform="rotate(69.945 29.892 362.328)"/><use href="#f-zh-a" transform="rotate(20.66 -590.66 957.955)"/></svg></button>
                <button
                  key="en"
                  type="button"
                  className={localePreference === 'en' ? 'is-active' : ''}
                  aria-pressed={localePreference === 'en'}
                  aria-label="English"
                  onClick={() => { runtime.updateSettings({ locale: 'en' }); setLocale('en'); }}
                ><svg viewBox='0 0 60 30' className='settings-flag' aria-hidden='true'><clipPath id="f-en-a"><path d="M0 0v30h60V0z"/></clipPath><clipPath id="f-en-b"><path d="M30 15h30v15zv15H0zH0V0zV0h30z"/></clipPath><g clipPath="url(#f-en-a)"><path d="M0 0v30h60V0z" fill="#012169"/><path d="m0 0 60 30m0-30L0 30" stroke="#fff" strokeWidth="6"/><path d="m0 0 60 30m0-30L0 30" clipPath="url(#f-en-b)" stroke="#C8102E" strokeWidth="4"/><path d="M30 0v30M0 15h60" stroke="#fff" strokeWidth="10"/><path d="M30 0v30M0 15h60" stroke="#C8102E" strokeWidth="6"/></g></svg></button>
                <button
                  key="de"
                  type="button"
                  className={localePreference === 'de' ? 'is-active' : ''}
                  aria-pressed={localePreference === 'de'}
                  aria-label="Deutsch"
                  onClick={() => { runtime.updateSettings({ locale: 'de' }); setLocale('de'); }}
                ><svg viewBox='0 0 5 3' className='settings-flag' aria-hidden='true'><path d="M0 0h5v3H0z"/><path fill="#D00" d="M0 1h5v2H0z"/><path fill="#FFCE00" d="M0 2h5v1H0z"/></svg></button>
                <button
                  key="fr"
                  type="button"
                  className={localePreference === 'fr' ? 'is-active' : ''}
                  aria-pressed={localePreference === 'fr'}
                  aria-label="Français"
                  onClick={() => { runtime.updateSettings({ locale: 'fr' }); setLocale('fr'); }}
                ><svg viewBox='0 0 900 600' className='settings-flag' aria-hidden='true'><path fill="#CE1126" d="M0 0h900v600H0"/><path fill="#fff" d="M0 0h600v600H0"/><path fill="#002654" d="M0 0h300v600H0"/></svg></button>
                <button
                  key="ja"
                  type="button"
                  className={localePreference === 'ja' ? 'is-active' : ''}
                  aria-pressed={localePreference === 'ja'}
                  aria-label="日本語"
                  onClick={() => { runtime.updateSettings({ locale: 'ja' }); setLocale('ja'); }}
                ><svg viewBox='0 0 900 600' className='settings-flag' aria-hidden='true'><path fill="#fff" d="M0 0h900v600H0z"/><circle fill="#bc002d" cx="450" cy="300" r="180"/></svg></button>
                <button
                  key="ko"
                  type="button"
                  className={localePreference === 'ko' ? 'is-active' : ''}
                  aria-pressed={localePreference === 'ko'}
                  aria-label="한국어"
                  onClick={() => { runtime.updateSettings({ locale: 'ko' }); setLocale('ko'); }}
                ><svg viewBox='-72 -48 144 96' className='settings-flag' aria-hidden='true'><path fill="#fff" d="M-72-48v96H72v-96z"/><g stroke="#000" strokeWidth="4"><path d="M-34.946-37.72-48.26-17.75m4.992 3.328 13.313-19.97m4.992 3.329-13.312 19.969m63.236 42.157 6.101-9.152m1.11-1.664 6.101-9.153m4.993 3.328-6.102 9.153m-1.11 1.664-6.101 9.152m4.992 3.329 6.102-9.153m1.11-1.664 6.1-9.153M-48.259 17.75l13.313 19.97m4.992-3.329-6.102-9.152m-1.109-1.664-6.102-9.153m4.993-3.328 13.312 19.97m63.236-42.158-6.101-9.153m-1.11-1.664-6.101-9.152m4.992-3.328 13.313 19.969m4.992-3.328-6.102-9.153m-1.11-1.664-6.1-9.153"/></g><path fill="#cd2e3a" d="M9.985 6.656A18 18 0 1 1-19.97-13.313a24 24 0 1 1 39.938 26.626"/><path fill="#0047a0" d="M0 0a12 12 0 1 1 19.97 13.313 24 24 0 1 1-39.94-26.626A12 12 0 1 0 0 0"/></svg></button>
                <button
                  key="it"
                  type="button"
                  className={localePreference === 'it' ? 'is-active' : ''}
                  aria-pressed={localePreference === 'it'}
                  aria-label="Italiano"
                  onClick={() => { runtime.updateSettings({ locale: 'it' }); setLocale('it'); }}
                ><svg viewBox='0 0 3 2' className='settings-flag' aria-hidden='true'><path fill="#009246" d="M0 0h3v2H0z"/><path fill="#fff" d="M1 0h2v2H1z"/><path fill="#ce2b37" d="M2 0h1v2H2z"/></svg></button>
                <button
                  key="ru"
                  type="button"
                  className={localePreference === 'ru' ? 'is-active' : ''}
                  aria-pressed={localePreference === 'ru'}
                  aria-label="Русский"
                  onClick={() => { runtime.updateSettings({ locale: 'ru' }); setLocale('ru'); }}
                ><svg viewBox='0 0 9 6' className='settings-flag' aria-hidden='true'><path fill="#fff" d="M0 0h9v3H0z"/><path fill="#d52b1e" d="M0 3h9v3H0z"/><path fill="#0039a6" d="M0 2h9v2H0z"/></svg></button>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3>{t('settings.about')}</h3>
            <div className="settings-row">
              <span className="settings-row__label">{t('settings.version')}</span>
              <a
                className="settings-row__label settings-row__link"
                href="https://github.com/Geekstrange/Aropyt/releases"
                onClick={handleLink('https://github.com/Geekstrange/Aropyt/releases')}
              >
                {`v${__APP_VERSION__}`}
              </a>
            </div>
            <div className="settings-row">
              <span className="settings-row__label">{t('settings.license')}</span>
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
            <h3>{t('settings.appearance')}</h3>
            <div className="settings-row">
              <span className="settings-row__label">{t('settings.theme')}</span>
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
                    {t(option.key)}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3>{t('settings.edit')}</h3>
            <div className="settings-row">
              <span className="settings-row__label">{t('settings.vim')}</span>
              <button
                type="button"
                className={`settings-switch${vimMode ? ' is-on' : ''}`}
                aria-pressed={vimMode}
                onClick={() => runtime.toggleVimMode()}
              >
                <span className="settings-switch__knob" />
              </button>
            </div>
            {/*
             * 工具栏开关。这里必须是"关掉之后还能打开"的入口之一 ——
             * 另一个是 Ctrl/Cmd+Shift+H（工具栏隐藏后它自身的按钮全没了）。
             */}
            <div className="settings-row">
              <span className="settings-row__label">{t('settings.toolbar')}</span>
              <button
                type="button"
                className={`settings-switch${state.toolbarOpen ? ' is-on' : ''}`}
                aria-pressed={state.toolbarOpen}
                onClick={() => runtime.toggleToolbar()}
              >
                <span className="settings-switch__knob" />
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h3>{t('settings.backup')}</h3>
            <div className="settings-row">
              <span className="settings-row__label">{t('settings.draftsAndHistory')}</span>
              <div className="settings-actions" style={{ marginTop: 0 }}>
                <button type="button" className="settings-button" onClick={() => void runtime.exportBackup()}>
                  {t('settings.export')}
                </button>
                <button type="button" className="settings-button" onClick={() => void runtime.importBackup()}>
                  {t('settings.import')}
                </button>
              </div>
            </div>
            <p className="settings-hint">{t('settings.backupHint')}</p>
          </section>

          <section className="settings-section">
            <h3>{t('settings.history')}</h3>
            <div className="settings-row">
              <span className="settings-row__label">{t('settings.historyLimit')}</span>
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
              <span className="settings-row__label">{t('settings.autoSave')}</span>
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
              <span className="settings-row__label">{t('settings.autoSaveInterval')}</span>
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
            <p className="settings-hint">{t('settings.autoSaveHint')}</p>
          </section>

          <section className="settings-section">
            <h3>{t('settings.pluginConfig')}</h3>
            {runtime.pluginConfigSchemas().length === 0 ? (
              <div className="settings-row">
                <span className="settings-row__label">{t('settings.noPluginConfig')}</span>
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
                          { value: true, label: t('common.on') },
                          { value: false, label: t('common.off') },
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
            <h3>{t('settings.configFile')}</h3>
            <div className="settings-row">
              <span className="settings-row__label">settings.jsonc</span>
              <code className="settings-path">{settingsPath ?? t('settings.browserConfig')}</code>
            </div>
            <div className="settings-actions">
              <button
                type="button"
                className="settings-button"
                onClick={() => runtime.openSettingsFile()}
                disabled={settingsPath === null}
              >{t('settings.openConfigFile')}</button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}