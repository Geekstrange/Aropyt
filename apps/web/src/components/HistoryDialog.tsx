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
      void runtime.windowService.showMessage('该版本已不存在（可能已被更早的版本淘汰）', { level: 'warning' });
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
      await runtime.snapshotHistory(label || '手动版本');
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
        aria-label="编辑历史"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-dialog__header">
          <h2>编辑历史</h2>
          <button type="button" className="settings-dialog__close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>

        <section className="settings-section">
          <div className="settings-row">
            <span className="settings-row__label">把当前内容存为版本</span>
            <div className="history-snapshot">
              <input
                type="text"
                value={label}
                placeholder="版本备注（可选）"
                onChange={(event) => setLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleSnapshot();
                }}
              />
              <button type="button" className="settings-button" disabled={busy} onClick={() => void handleSnapshot()}>
                保存版本
              </button>
            </div>
          </div>
          <p className="settings-hint">
            每次保存都会自动记录一个版本（内容未变不会重复记录）；每个文件保留最近
            {runtime.getSettings().history.limit} 个。当前文件：<code>{path}</code>
          </p>
        </section>

        {diff ? (
          <DiffView
            fileName={`${path} · 历史 → 当前`}
            before={diff.before}
            after={runtime.editor.getText()}
            onClose={() => setDiff(null)}
          />
        ) : null}

        <section className="settings-section" hidden={diff !== null}>
          <h3>版本（{versions.length}）</h3>
          {versions.length === 0 ? (
            <p className="settings-hint">还没有历史版本 —— 保存一次文件就会产生第一个版本。</p>
          ) : (
            <ul className="history-list">
              {versions.map((version, index) => (
                <li key={version.id} className="history-item">
                  <div className="history-item__main">
                    <span className="history-item__time">{formatTime(version.createdAt)}</span>
                    {version.label ? <span className="history-item__label">{version.label}</span> : null}
                    {index === 0 ? <span className="history-item__badge">最新</span> : null}
                    <span className="history-item__meta">{Math.round(version.size / 1024) || 1} KB</span>
                  </div>
                  <span className="history-item__actions">
                    <button
                      type="button"
                      className="settings-button"
                      disabled={busy}
                      onClick={() => void handleCompare(version.id)}
                    >
                      对比
                    </button>
                    <button
                      type="button"
                      className="settings-button"
                      disabled={busy}
                      onClick={() => void handleRestore(version.id)}
                    >
                      恢复
                    </button>
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
