/**
 * dump Markdown 的语法树：节点名 × 父节点 × 出现次数 × 文本样例。
 *
 * 用途：找出**真正没被渲染层覆盖**的节点，而不是靠看视口里"好像有样式"
 * （那会漏掉视口外的元素 —— 上一次就是这么漏掉删除线、任务列表、
 * 链接和公式的）。
 *
 * 解析器配置必须与编辑器完全一致，否则 dump 出来的树是另一棵树：
 *   @codemirror/lang-markdown 的 markdownLanguage
 *     = commonmark.configure([GFM, Subscript, Superscript, Emoji, …])
 *   其中 GFM = [Table, TaskList, Strikethrough, Autolink]
 *
 * 用法：node scripts/dump-md-tree.mjs [文件]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parser, GFM, Subscript, Superscript, Emoji } from '@lezer/markdown';

const file = process.argv[2] ?? 'test/test.md';
const source = readFileSync(resolve(file), 'utf8');

// 与编辑器一致（见 @codemirror/lang-markdown 的 markdownLanguage）
const tree = parser.configure([GFM, Subscript, Superscript, Emoji]).parse(source);

/** 节点名 → { 次数, 父节点集合, 样例 } */
const stats = new Map();
const cursor = tree.cursor();
do {
  const name = cursor.name;
  const parent = cursor.node.parent?.name ?? '(root)';
  let entry = stats.get(name);
  if (!entry) {
    entry = { count: 0, parents: new Set(), samples: [] };
    stats.set(name, entry);
  }
  entry.count += 1;
  entry.parents.add(parent);
  if (entry.samples.length < 2) {
    const text = source.slice(cursor.from, Math.min(cursor.to, cursor.from + 46)).replace(/\n/g, '\\n');
    entry.samples.push(text);
  }
} while (cursor.next());

const rows = [...stats.entries()].sort((a, b) => b[1].count - a[1].count);
console.log(`文件：${file}（${source.split('\n').length} 行）\n`);
console.log('节点名'.padEnd(22) + '次数'.padStart(6) + '  父节点 / 样例');
console.log('─'.repeat(96));
for (const [name, e] of rows) {
  const parents = [...e.parents].join(',');
  console.log(
    name.padEnd(22) +
      String(e.count).padStart(6) +
      '  ← ' + parents.padEnd(18) +
      ' ' + e.samples[0],
  );
}
console.log('\n共 ' + rows.length + ' 种节点');
