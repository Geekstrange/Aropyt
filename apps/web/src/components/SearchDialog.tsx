/**
 * 全工作区搜索面板。
 *
 * 三个刻意的决定：
 *  1. **边打边搜**，但带 250ms 防抖 —— 每敲一个字母就发一次 IPC，一个
 *     长关键词会打十几次全盘遍历，而用户按下第三个字符时前两次的结果
 *     早就没用了；
 *  2. **结果按文件分组显示路径**，不是只给行号：跨文件搜索的全部意义是
 *     "这个关键词在哪几个文件里"，路径比行号重要；
 *  3. 点击结果**直接跳转并关闭面板**。搜索是"去那个地方"，不是"看一份
 *     报告"。
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useT } from '../i18n/useT';
import type { AropytRuntime, SearchHit } from '../runtime.js';
import { Icon } from './Icons.js';

interface SearchDialogProps {
  readonly runtime: AropytRuntime;
  readonly onClose: () => void;
}

/** 防抖窗口：短于这个值的连续输入合并成一次搜索。 */
const DEBOUNCE_MS = 250;

export function SearchDialog({ runtime, onClose }: SearchDialogProps): JSX.Element {
  const t = useT();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);

  /*
   * 用一个递增的序号丢弃过期响应：输入 "abc" 时会发出 a / ab / abc
   * 三次请求，如果 ab 的结果在 abc 之后返回，列表会闪一下旧数据。
   */
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(
    async (value: string): Promise<void> => {
      const current = sequence.current + 1;
      sequence.current = current;

      if (value.trim().length === 0) {
        setHits([]);
        setBusy(false);
        return;
      }

      setBusy(true);
      const result = await runtime.searchAcross(value);
      /* 期间又发起过一次搜索 → 这次的结果已经过期 */
      if (sequence.current !== current) return;
      setHits(result);
      setBusy(false);
    },
    [runtime],
  );

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(query), DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, run]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="settings-backdrop" role="presentation" onClick={onClose}>
      <div
        className="settings-dialog settings-dialog--wide"
        role="dialog"
        aria-label={t('search.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-dialog__header">
          <h2>{t('search.title')}</h2>
          <button
            type="button"
            className="settings-dialog__close"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>

        <section className="settings-section">
          <input
            className="settings-input"
            type="search"
            autoFocus
            spellCheck={false}
            placeholder={t('search.placeholder')}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />

          {busy ? <p className="settings-hint">{t('search.searching')}</p> : null}
          {!busy && query.trim().length > 0 && hits.length === 0 ? (
            <p className="settings-hint">{t('search.empty')}</p>
          ) : null}

          {hits.length > 0 ? (
            <ul className="history-list">
              {hits.map((hit) => (
                <li key={`${hit.path}:${hit.line}`} className="history-item">
                  <button
                    type="button"
                    className="search-hit"
                    onClick={() => {
                      void runtime.openAt(hit.path, hit.line);
                      onClose();
                    }}
                  >
                    <span className="search-hit__where">
                      {hit.path}:{hit.line}
                    </span>
                    <span className="search-hit__text">{hit.text.trim()}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </div>
  );
}
