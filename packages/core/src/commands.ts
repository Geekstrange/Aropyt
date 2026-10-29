import type { EditorView } from '@codemirror/view';
import type { ChangeSpec, Line } from '@codemirror/state';

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
 * 行首前缀切换。已经在前缀上就取消，否则加上 —— 加粗/标题/引用/列表共用这一套逻辑。
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

export function toggleHeading(view: EditorView, level: number): void {
  const prefix = `${'#'.repeat(level)} `;
  const lines = selectedLines(view);
  const already = lines.every((line) => line.text.startsWith(prefix));
  const changes: ChangeSpec[] = lines.map((line) => {
    const stripped = line.text.replace(/^\s*#{1,6}\s/, '');
    return { from: line.from, to: line.to, insert: already ? stripped : prefix + stripped };
  });
  focusAndDispatch(view, changes);
}

export function toggleBulletList(view: EditorView): void {
  toggleLinePrefix(view, '- ');
}

export function toggleOrderedList(view: EditorView): void {
  toggleLinePrefix(view, (index) => `${index + 1}. `);
}

export function toggleTaskList(view: EditorView): void {
  const lines = selectedLines(view);
  const already = lines.every((line) => /^\s*[-*+]\s\[[ xX]\]\s/.test(line.text));
  const changes: ChangeSpec[] = lines.map((line) => {
    if (already) {
      return { from: line.from, to: line.to, insert: line.text.replace(/^(\s*)[-*+]\s\[[ xX]\]\s/, '$1') };
    }
    const stripped = line.text.replace(/^\s*(\d+\.\s|[-*+]\s|>\s)/, '');
    return { from: line.from, to: line.to, insert: `- [ ] ${stripped}` };
  });
  focusAndDispatch(view, changes);
}

export function toggleBlockquote(view: EditorView): void {
  toggleLinePrefix(view, '> ');
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

export function toggleBold(view: EditorView): void {
  toggleWrap(view, '**');
}

export function toggleItalic(view: EditorView): void {
  toggleWrap(view, '*');
}

export function toggleStrikethrough(view: EditorView): void {
  toggleWrap(view, '~~');
}

export function toggleInlineCode(view: EditorView): void {
  toggleWrap(view, '`');
}

export function insertLink(view: EditorView): void {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);
  if (selected) {
    focusAndDispatch(view, { from: range.from, to: range.to, insert: `[${selected}](url)` }, { anchor: range.from + selected.length + 3, head: range.from + selected.length + 6 });
    return;
  }
  const text = '链接文字';
  focusAndDispatch(view, { from: range.from, insert: `[${text}](url)` }, { anchor: range.from + 1, head: range.from + 1 + text.length });
}

export function insertImage(view: EditorView): void {
  const range = view.state.selection.main;
  focusAndDispatch(view, { from: range.from, insert: '![图片描述](图片地址)' }, { anchor: range.from + 2, head: range.from + 6 });
}

export function insertCodeBlock(view: EditorView): void {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);
  const from = state.doc.lineAt(range.from).from;
  const needsLeadingBreak = from > 0 && state.sliceDoc(from - 1, from) !== '\n';
  const fence = `${needsLeadingBreak ? '\n' : ''}\`\`\`\n${selected}\n\`\`\`\n`;
  const langAnchor = from + (needsLeadingBreak ? 1 : 0) + 3;
  focusAndDispatch(view, { from, to: state.doc.lineAt(range.to).to, insert: fence }, { anchor: langAnchor });
}

export function insertTable(view: EditorView): void {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.from);
  const template = ['| 列 1 | 列 2 | 列 3 |', '| --- | --- | --- |', '|  |  |  |', ''].join('\n');
  const prefix = line.text.trim() === '' ? '' : '\n';
  focusAndDispatch(view, { from: line.to, insert: `${prefix}${template}` });
}

export function insertHorizontalRule(view: EditorView): void {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.from);
  const prefix = line.text.trim() === '' ? '' : '\n';
  focusAndDispatch(view, { from: line.to, insert: `${prefix}\n---\n\n` });
}

/** Tab / Shift-Tab 缩进，列表里用得最多。 */
export function indentSelection(view: EditorView, outdent: boolean): void {
  const lines = selectedLines(view);
  const changes: ChangeSpec[] = lines.map((line) => {
    if (outdent) {
      const stripped = line.text.replace(/^(\t| {1,2})/, '');
      return { from: line.from, to: line.to, insert: stripped };
    }
    if (line.text.trim() === '') return { from: line.from, insert: '' };
    return { from: line.from, insert: '\t' };
  });
  focusAndDispatch(view, changes);
}
