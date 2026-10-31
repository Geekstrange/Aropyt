import type { EditorView } from '@codemirror/view';
import type { ChangeSpec, Line } from '@codemirror/state';

/**
 * 编辑器命令的**内核实现**。
 *
 * ⚠️ 这里只留两个函数：`toggleLinePrefix` 与 `toggleWrap`。
 *
 * 它们上面曾经还有一层"命令"（toggleBold / toggleHeading / insertLink /
 * insertTable / indentSelection… 共 15 个），每个都在自己的实现里直接
 * dispatch 事务。后来插件统一改走 `EditorApi.wrapSelection` /
 * `toggleLinePrefix` / `replaceSelection` —— 那套有了守卫、能归因到插件、
 * 也覆盖了同样的行为，旧函数于是全部零引用。
 *
 * 保留这两个是因为 `kernel/editor.ts` 的 `EditorApi` 就是拿它们实现的
 *（`wrapSelection` → `toggleWrap`，`toggleLinePrefix` → 同名）。
 * 新增编辑动作请走 `EditorApi`，不要在这里再堆一层。
 */

/** 取选区覆盖到的所有行（含首尾），这是所有"行级"命令的共同前提。 */
function selectedLines(view: EditorView): Line[] {
  const { state } = view;
  const { from, to } = state.selection.main;
  const first = state.doc.lineAt(from);
  const last = state.doc.lineAt(to);
  const lines: Line[] = [];
  for (let n = first.number; n <= last.number; n += 1) lines.push(state.doc.line(n));
  return lines;
}

function focusAndDispatch(view: EditorView, changes: ChangeSpec | ChangeSpec[], selection?: { anchor: number; head?: number }): void {
  view.dispatch(selection ? { changes, selection } : { changes });
  view.focus();
}

/**
 * 行首前缀切换。已经在前缀上就取消，否则加上 —— 标题/引用/列表共用这一套逻辑。
 * prefix 传函数是为了支持有序列表这种逐行变化的编号。
 */
export function toggleLinePrefix(view: EditorView, prefix: string | ((index: number, line: Line) => string)): boolean {
  const lines = selectedLines(view);
  const prefixOf = (index: number, line: Line) => (typeof prefix === 'string' ? prefix : prefix(index, line));

  const alreadyApplied = lines.every((line) => {
    if (typeof prefix === 'string') return line.text.startsWith(prefix);
    return /^\s*\d+\.\s/.test(line.text);
  });

  const changes: ChangeSpec[] = lines.map((line, index) => {
    if (alreadyApplied) {
      const stripped = typeof prefix === 'string'
        ? line.text.slice(prefix.length)
        : line.text.replace(/^\s*\d+\.\s/, '');
      return { from: line.from, to: line.to, insert: stripped };
    }
    /*
     * 剥掉已有的块级前缀。列表前缀要连复选框一起剥：
     * `- [x] 内容` 在切到任务列表时必须变成 `- [ ] 内容`，
     * 只剥 `- ` 会留下 `[x] `，结果拼成 `- [ ] [x] 内容`。
     */
    const stripped = line.text.replace(
      /^\s*(\d+\.\s|[-*+]\s(?:\[[ xX]\]\s)?|>\s|#{1,6}\s)/,
      '',
    );
    return { from: line.from, to: line.to, insert: prefixOf(index, line) + stripped };
  });

  focusAndDispatch(view, changes);
  return lines.length > 0;
}

/**
 * 包裹型标记切换：加粗、斜体、行内代码、删除线走同一套逻辑。
 * 三种情况：已包裹 → 拆掉；选区内自带标记 → 拆掉；其余 → 包上。
 */
export function toggleWrap(view: EditorView, open: string, close: string = open): void {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);

  if (range.empty) {
    const before = state.sliceDoc(Math.max(0, range.from - open.length), range.from);
    const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + close.length));

    if (before === open && after === close) {
      focusAndDispatch(
        view,
        [
          { from: range.from - open.length, to: range.from, insert: '' },
          { from: range.to, to: range.to + close.length, insert: '' },
        ],
        { anchor: range.from - open.length },
      );
      return;
    }

    focusAndDispatch(view, { from: range.from, insert: open + close }, { anchor: range.from + open.length });
    return;
  }

  if (selected.length >= open.length + close.length && selected.startsWith(open) && selected.endsWith(close)) {
    const inner = selected.slice(open.length, selected.length - close.length);
    focusAndDispatch(view, { from: range.from, to: range.to, insert: inner }, { anchor: range.from, head: range.from + inner.length });
    return;
  }

  const before = state.sliceDoc(Math.max(0, range.from - open.length), range.from);
  const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + close.length));

  if (before === open && after === close) {
    focusAndDispatch(
      view,
      [
        { from: range.from - open.length, to: range.from, insert: '' },
        { from: range.to, to: range.to + close.length, insert: '' },
      ],
      { anchor: range.from - open.length, head: range.to - open.length },
    );
    return;
  }

  focusAndDispatch(
    view,
    [
      { from: range.from, insert: open },
      { from: range.to, insert: close },
    ],
    { anchor: range.from + open.length, head: range.to + open.length },
  );
}
