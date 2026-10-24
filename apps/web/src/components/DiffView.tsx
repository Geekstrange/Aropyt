import { useMemo, useState } from 'react';
import { diffLines, diffStats, toSplitRows, type DiffLine } from '../lib/diff';

/**
 * 编辑历史 Diff 视图。
 *
 * 设计要点（对齐 v0.1.2 设计稿）：
 * - **Unified**：旧行号 / 新行号 / 符号 / 内容 四列，行级配色
 * - **Split**：左右两栏，缺行的一侧画斜纹（"这一侧没有对应行"）
 * - 顶部固定：文件名 + `+N / −N` 统计 + 视图切换
 *
 * 行号各占一列而不是合并："这一行在旧文件是第几行、在新文件是第几行"
 * 是 review 时最常查的信息，合并成一列后就没法回答了。
 */
export interface DiffViewProps {
  readonly fileName: string;
  readonly before: string;
  readonly after: string;
  readonly onClose?: () => void;
}

type View = 'unified' | 'split';

const SIGN: Record<DiffLine['t'], string> = { add: '+', del: '−', equal: ' ' };

export function DiffView({ fileName, before, after, onClose }: DiffViewProps) {
  const [view, setView] = useState<View>('unified');
  const rows = useMemo(() => diffLines(before, after), [before, after]);
  const stats = useMemo(() => diffStats(rows), [rows]);
  const split = useMemo(() => toSplitRows(rows), [rows]);

  return (
    <section className="diff-scope diff" aria-label="版本对比">
      <header className="diff-head">
        <span className="diff-file mono">{fileName}</span>
        <span className="diff-stats">
          <span className="stat add mono">+{stats.add}</span>
          <span className="stat del mono">−{stats.del}</span>
        </span>
        <div className="diff-toggle" role="tablist" aria-label="Diff 视图">
          <button
            type="button"
            data-view="unified"
            className={view === 'unified' ? 'active' : ''}
            aria-selected={view === 'unified'}
            onClick={() => setView('unified')}
          >
            Unified
          </button>
          <button
            type="button"
            data-view="split"
            className={view === 'split' ? 'active' : ''}
            aria-selected={view === 'split'}
            onClick={() => setView('split')}
          >
            Split
          </button>
        </div>
        {onClose && (
          <button type="button" className="settings-dialog__close" aria-label="关闭对比" onClick={onClose}>
            ×
          </button>
        )}
      </header>

      <div className="diff-body">
        {view === 'unified'
          ? rows.map((row, index) => (
              <div key={index} className={`drow ${row.t}`}>
                <span className="ln">{row.t === 'add' ? '' : row.oldNo}</span>
                <span className="ln">{row.t === 'del' ? '' : row.newNo}</span>
                <span className="sign">{SIGN[row.t]}</span>
                <code className="tx">{row.text}</code>
              </div>
            ))
          : split.map((pair, index) => (
              <div key={index} className="drow split">
                <Side line={pair.left} side="left" />
                <Side line={pair.right} side="right" />
              </div>
            ))}
      </div>
    </section>
  );
}

function Side({ line, side }: { line: DiffLine | null; side: 'left' | 'right' }) {
  if (!line) {
    return (
      <div className="side empty">
        <span className="ln" />
        <span className="sign" />
        <code className="tx" />
      </div>
    );
  }
  const cls = line.t === 'del' ? 'del' : line.t === 'add' ? 'add' : '';
  const no = side === 'left' ? line.oldNo : line.newNo;
  return (
    <div className={`side ${cls}`}>
      <span className="ln">{no ?? ''}</span>
      <span className="sign">{SIGN[line.t]}</span>
      <code className="tx">{line.text}</code>
    </div>
  );
}
