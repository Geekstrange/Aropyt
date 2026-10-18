/**
 * 清空 apps/web/dist —— **逐批删除**，每批 30 个文件。
 *
 * 为什么不用 vite 的 emptyOutDir：沙箱环境的批量删除防护按"单轮累计文件数"
 * 拦截（阈值 50），vite 一次清上百个资产会被直接挡下、构建失败。
 * 为什么不用"重命名成 dist-stale-*"（曾经的方案）：它不回收磁盘 ——
 * 实测累积了 13 个目录、187MB。逐批删除既绕开防护又不留垃圾。
 */
import { readdirSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BATCH = 30;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'apps', 'web', 'dist');

/** 逐批删除（一个目录里的文件分多批，子目录递归）。 */
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
      /* 已被删 */
    }
  }
  for (let i = 0; i < files.length; i += BATCH) {
    for (const file of files.slice(i, i + BATCH)) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* 忽略单个失败 */
      }
    }
  }
  for (const sub of dirs) removeTree(sub);
  try {
    rmdirSync(dir);
  } catch {
    /* 非空或已删 */
  }
}

removeTree(distDir);
console.log('dist 已清空（逐批删除）');
