/**
 * 行级 diff（LCS）。
 *
 * 只做"行"这一层：Markdown 的字级差异对用户没有意义 —— 改一个字就是
 * 整行变了，看的人想知道的是"哪几行被动了"。
 *
 * 输出是扁平的三态行序列（equal / add / del），与大多数 diff 工具一致，
 * 既可以直接画统一视图，也能两两配对成左右分栏。
 */
export type DiffKind = 'equal' | 'add' | 'del';

export interface DiffLine {
  readonly t: DiffKind;
  readonly text: string;
  /** 旧文件行号（add 行没有）。 */
  oldNo?: number;
  /** 新文件行号（del 行没有）。 */
  newNo?: number;
}

/** 行级 LCS，返回统一视图的行序列。 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');

  // LCS 表：n*m 的 Uint32。Markdown 文档很少过万行，这个规模可以接受。
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ t: 'equal', text: a[i], oldNo: oldNo++, newNo: newNo++ });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ t: 'del', text: a[i], oldNo: oldNo++ });
      i += 1;
    } else {
      rows.push({ t: 'add', text: b[j], newNo: newNo++ });
      j += 1;
    }
  }
  while (i < n) {
    rows.push({ t: 'del', text: a[i], oldNo: oldNo++ });
    i += 1;
  }
  while (j < m) {
    rows.push({ t: 'add', text: b[j], newNo: newNo++ });
    j += 1;
  }
  return rows;
}

export function diffStats(rows: readonly DiffLine[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const row of rows) {
    if (row.t === 'add') add += 1;
    else if (row.t === 'del') del += 1;
  }
  return { add, del };
}

export interface SplitRow {
  readonly left: DiffLine | null;
  readonly right: DiffLine | null;
}

/**
 * 折成左右分栏：连续的 del 块与 add 块按行对齐配对，
 * 少的一侧留空（画斜纹表示"这一侧没有对应行"）。
 */
export function toSplitRows(rows: readonly DiffLine[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];

  const flush = (): void => {
    const count = Math.max(dels.length, adds.length);
    for (let k = 0; k < count; k += 1) {
      out.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
    dels = [];
    adds = [];
  };

  for (const row of rows) {
    if (row.t === 'del') dels.push(row);
    else if (row.t === 'add') adds.push(row);
    else {
      flush();
      out.push({ left: row, right: row });
    }
  }
  flush();
  return out;
}
