import { useEffect, useMemo, useRef, useState } from 'react';
import type { AropytRuntime } from '../runtime';

/**
 * 命令面板（v0.1.0）。
 *
 * 插件系统缺了它就不成立：一个插件可以声明几十条命令，工具栏放不下，
 * 没有面板它们就永远无法执行（VSCode 的 Ctrl+Shift+P 是同一角色）。
 *
 * 交互：输入过滤 / ↑↓ 选择 / Enter 执行 / Esc 关闭。
 * 视觉与设置弹窗同构（.settings-backdrop / .settings-dialog）。
 */
interface CommandPaletteProps {
  runtime: AropytRuntime;
  onClose: () => void;
}

export function CommandPalette({ runtime, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo(() => runtime.commands.details(), [runtime]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((command) => {
      const haystack = `${command.title} ${command.category ?? ''} ${command.id}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [commands, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 过滤结果变化时把选中项拉回第一行，避免"索引越界 + 回车执行错项"
  useEffect(() => {
    setIndex(0);
  }, [query]);

  const run = (commandId: string): void => {
    onClose();
    void runtime.commands.execute(commandId).catch(() => undefined);
  };

  return (
    <div className="settings-backdrop" role="presentation" onClick={onClose}>
      <div
        className="settings-dialog palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette__input"
          type="text"
          value={query}
          placeholder="输入命令名称…"
          aria-label="搜索命令"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setIndex((value) => Math.min(value + 1, Math.max(filtered.length - 1, 0)));
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setIndex((value) => Math.max(value - 1, 0));
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              const target = filtered[index];
              if (target) run(target.id);
            }
          }}
        />

        <ul className="palette__list">
          {filtered.length === 0 && <li className="palette__empty">没有匹配的命令</li>}
          {filtered.map((command, position) => (
            <li key={command.id}>
              <button
                type="button"
                className={`palette__item${position === index ? ' palette__item--active' : ''}`}
                onMouseEnter={() => setIndex(position)}
                onClick={() => run(command.id)}
              >
                <span className="palette__title">
                  {command.category ? `${command.category}: ` : ''}
                  {command.title}
                </span>
                {command.keybinding && <span className="palette__key">{command.keybinding}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
