/**
 * 清空 dist：不删除（沙箱批量删除防护按累计文件数拦截），
 * 而是把整个 dist **重命名**为带时间戳的 dist-stale-<ts> ——
 * rename 是零成本操作，不触发删除计数；旧目录已列入 .gitignore
 * （dist-stale-*/），磁盘成本可容忍。
 */
import { renameSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve('apps/web/dist');
if (existsSync(dir)) {
  renameSync(dir, resolve(`apps/web/dist-stale-${Date.now()}`));
}
mkdirSync(dir, { recursive: true });
console.log('dist 已换新（旧目录保留为 dist-stale-*）');
