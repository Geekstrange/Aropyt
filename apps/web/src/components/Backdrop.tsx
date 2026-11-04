/**
 * 弹窗遮罩：点击空白处关闭，但**只认真正的"点空白"**。
 *
 * ── 为什么要判断 mousedown ────────────────────────────────
 * 直接挂 `onClick={onClose}` 会把两类操作都当成"点了空白处"：
 *
 *   1. 在对话框里选中文字，拖到外面松手 —— `click` 落在遮罩上；
 *   2. 在对话框里按下、手滑移出去再松开 —— 同上。
 *
 * 两者都**不是**用户想关窗。用户反馈"点击空白处容易误触"，实际是这两种
 * 拖拽被误判成了点击。
 *
 * 判断方式：`mousedown` 与 `click` 的 `target` 都必须是遮罩本身。拖拽时
 * `mousedown` 落在对话框内的元素上，于是整条链路不算点击。
 *
 * 这是各家的通行做法 —— 遮罩的"点击关闭"是个便利，不该在拖拽时触发。
 */

import { useRef, type JSX, type ReactNode } from 'react';

interface BackdropProps {
  readonly onClose?: () => void;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Backdrop({ onClose, className, children }: BackdropProps): JSX.Element {
  /** 这一次交互是不是从遮罩本身开始的。 */
  const fromSelf = useRef(false);

  return (
    <div
      className={className ? `settings-backdrop ${className}` : 'settings-backdrop'}
      role="presentation"
      onMouseDown={(event) => {
        fromSelf.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const isBlank = fromSelf.current && event.target === event.currentTarget;
        fromSelf.current = false;
        if (isBlank) onClose?.();
      }}
    >
      {children}
    </div>
  );
}
