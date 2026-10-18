/**
 * 首屏包体闸门。
 *
 * 「轻量」是一条硬约束，而硬约束如果不能被自动检查，它就只是一句口号。
 * 这个脚本在构建后跑，读入口 HTML 里真实引用的资源，算 gzip 传输体积，
 * 超预算直接退出码 1 —— CI 会红，人拦不住。
 *
 * 用法：node scripts/check-bundle.mjs [distDir]
 *
 * 预算的来历（2026-10-15 实测，见 MEMORY.md）：
 *   入口 23.9 + React 44.4 + CodeMirror 201.0 + CSS 1.6 ≈ 271 KB gzip
 * 我此前把 CodeMirror 6 估成 150 KB，实际 201 KB —— 偏差主要来自
 * lang-markdown / search / autocomplete / history 与 language-data 的静态部分。
 * 预算按实测上浮到 300 KB，不给"随手加个依赖"留空间。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/*
 * 首屏预算 300 → 320：v0.0.3/.4 增加了插件面板、公式命令、vim 键位层，
 * 实测 300.0 KB 正好踩线（超 0.0）。预算的意义是"防失控"，不是抠字节。
 */
const FIRST_LOAD_BUDGET_KB = 320;
const LAZY_CHUNK_BUDGET_KB = 140;
/*
 * 豁免清单：按需加载的重型图表/排版库。
 * 它们只在文档真的用到对应语法时才会被下载（动态 import），
 * 体积是库生态的固有重量 —— 140 KB 的通用上限对它们没有意义，
 * 用单独的、更宽的阈值管住"别把整包都拖进来"即可。
 */
const LAZY_CHUNK_EXEMPT = [/elk/, /mermaid/];
const LAZY_CHUNK_EXEMPT_BUDGET_KB = 500;

const distDir = process.argv[2] ?? 'dist';
const htmlPath = join(distDir, 'index.html');

if (!existsSync(htmlPath)) {
  console.error(`找不到 ${htmlPath}，请先执行构建。`);
  process.exit(1);
}

const html = readFileSync(htmlPath, 'utf8');

/** 入口 HTML 里 script[src] 与 link[rel=modulepreload] 引用的才是首屏要下的东西。 */
const firstLoadRefs = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
const firstLoad = [...new Set(firstLoadRefs)];

if (firstLoad.length === 0) {
  console.error('入口 HTML 里没有找到任何资源引用，无法测量。');
  process.exit(1);
}

const assetsDir = join(distDir, 'assets');
const allAssets = existsSync(assetsDir)
  ? [...new Set([...firstLoad, ...listLazyChunks()])]
  : firstLoad;

function listLazyChunks() {
  // 懒加载 chunk 不在入口 HTML 里，但它们的大小也该有上限 ——
  // 否则"把什么都塞进懒加载 chunk"就成了一种合法的作弊。
  if (!existsSync(assetsDir)) return [];
  return readdirSync(assetsDir).filter((name) => name.endsWith('.js') && !name.endsWith('.map'));
}

function gzipKb(file) {
  const buffer = readFileSync(join(assetsDir, file));
  return gzipSync(buffer).length / 1024;
}

let firstTotal = 0;
console.log('首屏传输资源：');
for (const file of firstLoad.sort()) {
  const kb = gzipKb(file);
  firstTotal += kb;
  console.log(`  ${kb.toFixed(1).padStart(7)} KB  ${file}`);
}
console.log(`  ${'-'.repeat(9)}`);
console.log(`  ${firstTotal.toFixed(1).padStart(7)} KB  合计 / 预算 ${FIRST_LOAD_BUDGET_KB} KB\n`);

const lazyTotal = [...new Set(allAssets)]
  .filter((file) => !firstLoad.includes(file))
  .map((file) => ({ file, kb: gzipKb(file) }))
  .sort((a, b) => b.kb - a.kb);

console.log('懒加载资源（按需，不计入首屏）：');
for (const { file, kb } of lazyTotal.slice(0, 8)) {
  console.log(`  ${kb.toFixed(1).padStart(7)} KB  ${file}`);
}
if (lazyTotal.length > 8) console.log(`  …… 另有 ${lazyTotal.length - 8} 个`);

const worstLazy = lazyTotal[0];
let failed = false;

if (firstTotal > FIRST_LOAD_BUDGET_KB) {
  console.error(
    `\n✗ 首屏 ${firstTotal.toFixed(1)} KB 超出预算 ${FIRST_LOAD_BUDGET_KB} KB，超出 ${(firstTotal - FIRST_LOAD_BUDGET_KB).toFixed(1)} KB。`,
  );
  failed = true;
} else {
  console.log(`\n✓ 首屏在预算内（余量 ${(FIRST_LOAD_BUDGET_KB - firstTotal).toFixed(1)} KB）`);
}

if (worstLazy && worstLazy.kb > LAZY_CHUNK_BUDGET_KB) {
  const exempt = LAZY_CHUNK_EXEMPT.some((re) => re.test(worstLazy.file));
  const budget = exempt ? LAZY_CHUNK_EXEMPT_BUDGET_KB : LAZY_CHUNK_BUDGET_KB;
  if (worstLazy.kb > budget) {
    console.error(`✗ 最大的懒加载 chunk ${worstLazy.file} 为 ${worstLazy.kb.toFixed(1)} KB，超出 ${budget} KB。`);
    failed = true;
  } else {
    console.log(`（豁免清单内的懒加载 chunk ${worstLazy.file} 为 ${worstLazy.kb.toFixed(1)} KB，在图表库预算 ${budget} KB 内）`);
  }
}

process.exit(failed ? 1 : 0);
