/**
 * 把文件类型图标（SVG）打包成 Windows **ICO**。
 *
 * 为什么自己拼 ICO 而不引库：ICO 容器格式很简单，Vista 以后支持直接内嵌
 * PNG 数据（不再需要 BMP/掩码）。40 行无依赖，比引一个转换库更可控。
 *
 * 多尺寸是必须的 —— 资源管理器在 16/32/48/256 各种视图下都会取图标，
 * 只放 256 会被缩小成糊图。
 *
 * 用法：node scripts/make-file-ico.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src-tauri', 'icons', 'files');
mkdirSync(outDir, { recursive: true });

const JOBS = [
  { src: 'mdFile.svg', out: 'markdown.ico' },
  { src: 'texFile.svg', out: 'latex.ico' },
  { src: 'fountainFile.svg', out: 'fountain.ico' },
];

const SIZES = [16, 24, 32, 48, 64, 128, 256];

const { Resvg } = await import('@resvg/resvg-js');

/** 按 ICO 规范拼容器（每个条目内嵌 PNG）。 */
function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  for (const png of pngBuffers) {
    const entry = Buffer.alloc(16);
    // 256 在 ICONDIRENTRY 里用 0 表示
    entry.writeUInt8(png.size >= 256 ? 0 : png.size, 0);
    entry.writeUInt8(png.size >= 256 ? 0 : png.size, 1);
    entry.writeUInt8(0, 2); // colorCount
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bitCount
    entry.writeUInt32LE(png.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...pngBuffers.map((p) => p.data)]);
}

for (const job of JOBS) {
  const svg = readFileSync(join(root, 'icon', job.src), 'utf8');
  const pngs = SIZES.map((size) => {
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: size },
      background: 'rgba(0,0,0,0)',
    });
    return { size, data: resvg.render().asPng() };
  });
  const ico = buildIco(pngs);
  writeFileSync(join(outDir, job.out), ico);
  console.log(`${job.src} → icons/files/${job.out} (${SIZES.join('/')} · ${ico.length} bytes)`);
}
