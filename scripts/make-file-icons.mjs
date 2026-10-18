/**
 * 把文件类型图标（SVG）渲染成 PNG。
 *
 * Tauri 的 `bundle.fileAssociations.icon` 只接受位图（png/ico），
 * 不接受 SVG —— 所以需要这一步。渲染用 @resvg/resvg-js，
 * 按目标尺寸直接渲染（不是先转大图再缩，边缘更干净）。
 *
 * 用法：node scripts/make-file-icons.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src-tauri', 'icons', 'files');
mkdirSync(outDir, { recursive: true });

/** 源 SVG → 输出名。尺寸统一 256（Windows 关联图标常用的清晰档位）。 */
const JOBS = [
  { src: 'mdFile.svg', out: 'markdown.png' },
  { src: 'texFile.svg', out: 'latex.png' },
  { src: 'fountainFile.svg', out: 'fountain.png' },
];

const SIZE = 256;

const { Resvg } = await import('@resvg/resvg-js');

for (const job of JOBS) {
  const svg = readFileSync(join(root, 'icon', job.src), 'utf8');
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: SIZE },
    // 透明背景：图标在资源管理器里要贴得住任何底色
    background: 'rgba(0,0,0,0)',
  });
  const png = resvg.render().asPng();
  writeFileSync(join(outDir, job.out), png);
  console.log(`${job.src} → icons/files/${job.out} (${png.length} bytes)`);
}
