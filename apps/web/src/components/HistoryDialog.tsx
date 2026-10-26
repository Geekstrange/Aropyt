/**
 * 编辑历史面板（v0.0.7）。
 *
 * 第一版只做闭环：**列出保存过的版本 → 恢复 → 手动存版本**。
 * diff 视图留到下一步（需要引入 jsdiff 并按需加载）—— 先把"能找回内容"
 * 这条最核心的价值做通，比先做漂亮的 diff 更重要。
 *
 * 一个刻意的行为：**恢复前会自动把当前内容存成版本**，所以点恢复
 * 永远不会让你丢掉手上的编辑（代价是历史里多一条"恢复前快照"）。
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { useT } from '../i18n/useT';
import type { HistorySummary } from '@aropyt/core';
import type { AropytRuntime } from '../runtime.js';
import { DiffView } from './DiffView.js';

interface HistoryDialogProps {
  readonly runtime: AropytRuntime;
  readonly path: string;
  readonly onClose: () => void;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${date.getMonth() + 1}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function HistoryDialog({ runtime, path, onClose }: HistoryDialogProps): JSX.Element {
  const t = useT();
  const [versions, setVersions] = useState<HistorySummary[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  /** 当前正在对比的版本（null = 显示列表）。 */
  const [diff, setDiff] = useState<{ readonly id: string; readonly before: string } | null>(null);

  const refresh = useCallback(async () => {
    const list = await runtime.listHistory(path);
    setVersions(list);
  }, [runtime, path]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 与当前文档对比：before = 历史版本全文，after = 编辑器当前内容。 */
  const handleCompare = async (id: string): Promise<void> => {
    const before = await runtime.readHistory(id).catch(() => null);
    if (before === null) {
      void runtime.windowService.showMessage(t('history.gone'), { level: 'warning' });
      return;
    }
    setDiff({ id, before });
  };

  const handleRestore = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await runtime.restoreHistory(id);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleSnapshot = async (): Promise<void> => {
    setBusy(true);
    try {
      await runtime.snapshotHistory(label || t('history.manual'));
      setLabel('');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-backdrop" role="presentation" onClick={onClose}>
      <div
        className={diff ? 'settings-dialog history-dialog settings-dialog--wide' : 'settings-dialog history-dialog'}
        role="dialog"
        aria-modal="true"
        aria-label={t('history.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-dialog__header">
          <h2>{t('history.title')}</h2>
          <button type="button" className="settings-dialog__close" aria-label={t('common.close')} onClick={onClose}>
            ×
          </button>
        </header>

        <section className="settings-section">
          <div className="settings-row">
            <span className="settings-row__label">{t('history.saveAsVersion')}</span>
            <div className="history-snapshot">
              <input
                type="text"
                value={label}
                placeholder={t('history.note')}
                onChange={(event) => setLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleSnapshot();
                }}
              />
              <button type="button" className="settings-button" disabled={busy} onClick={() => void handleSnapshot()}>{t('history.saveVersion')}</button>
            </div>
          </div>
          <p className="settings-hint">{t('history.autoNote', { n: runtime.getSettings().history.limit })} <code>{path}</code></p>
        </section>

        {diff ? (
          <DiffView
            fileName={t('history.compare', { path })}
            before={diff.before}
            after={runtime.editor.getText()}
            onClose={() => setDiff(null)}
          />
        ) : null}

        <section className="settings-section" hidden={diff !== null}>
          <h3>{t('history.versions',{n:versions.length})}</h3>
          {versions.length === 0 ? (
            <p className="settings-hint">{t('history.empty')}</p>
          ) : (
            <ul className="history-list">
              {versions.map((version, index) => (
                <li key={version.id} className="history-item">
                  <div className="history-item__main">
                    <span className="history-item__time">{formatTime(version.createdAt)}</span>
                    {version.label ? <span className="history-item__label">{version.label}</span> : null}
                    {index === 0 ? <span className="history-item__badge">{t('history.latest')}</span> : null}
                    <span className="history-item__meta">{Math.round(version.size / 1024) || 1} KB</span>
                  </div>
                  <span className="history-item__actions">
                    <button
                      type="button"
                      className="settings-button"
                      disabled={busy}
                      onClick={() => void handleCompare(version.id)}
                    >{t('history.compareTab')}</button>
                    <button
                      type="button"
                      className="settings-button"
                      disabled={busy}
                      onClick={() => void handleRestore(version.id)}
                    >{t('history.restoreTab')}</button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
