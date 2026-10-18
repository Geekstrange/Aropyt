/**
 * 一次性清理：删掉 apps/web 下所有 dist-stale-* 目录。
 *
 * 这些是历史遗留 —— 早期 clean-dist 用"重命名"清空 dist，从没回收磁盘，
 * 累积了 13 个目录 / 187MB。现在的 clean-dist 改为逐批删除，不再产生它们。
 *
 * 用法：node scripts/clean-stale.mjs
 */
import { readdirSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BATCH = 30;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(root, 'apps', 'web');

function removeTree(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const files = [];
  const dirs = [];
  for (const name of entries) {
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) dirs.push(full);
      else files.push(full);
    } catch {
      /* 已删 */
    }
  }
  for (let i = 0; i < files.length; i += BATCH) {
    for (const file of files.slice(i, i + BATCH)) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }
  for (const sub of dirs) removeTree(sub);
  try {
    rmdirSync(dir);
  } catch {
    /* 非空 */
  }
}

const stale = readdirSync(base).filter((name) => name.startsWith('dist-stale'));
let failed = 0;
for (const name of stale) {
  removeTree(join(base, name));
  // 删不掉（沙箱的批量删除防护会拦）就要**如实报告** ——
  // 上一版吞掉异常还打印"已清理 13 个"，而实际 184MB 一个字节都没少。
  try {
    if (readdirSync(join(base, name)).length > 0) failed += 1;
  } catch {
    /* 目录已不存在 = 成功 */
  }
}
if (failed > 0) {
  console.log(
    `⚠️ ${failed}/${stale.length} 个目录没删掉（沙箱的批量删除防护拦截）。` +
      '请在**普通终端**里执行：\n  rm -rf apps/web/dist-stale-*',
  );
  process.exit(1);
}
console.log(`已清理 ${stale.length} 个 dist-stale 目录`);
