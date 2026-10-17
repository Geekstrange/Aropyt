/**
 * 把 icon/*.svg 转成工具栏图标模块。
 *
 * ── 为什么要生成而不是手抄 ──────────────────────────────────
 * 这批图标是 1024 单位的 iconfont 路径，`d` 属性动辄几百字符。
 * 手抄进 TSX 既容易抄错，也没法在你更新图标后同步 ——
 * 生成器让"图标来源"始终是 icon/ 目录里的 SVG，代码只是一个投影。
 *
 * ── 转换规则 ──────────────────────────────────────────────
 *   1. viewBox 统一成 0 0 1024 1024（原始尺寸）
 *   2. 去掉 fill 属性，改为 `fill="currentColor"` ——
 *      iconfont 导出的路径不带 fill，默认渲染成黑色，
 *      放进深色界面里就是一团黑。currentColor 让它跟随文字色，
 *      也顺带让深浅色主题自动生效。
 *   3. 剥掉 `p-id` / `t` 这类导出工具留下的属性（对渲染无用，且是噪音）
 *
 * 用法：npm run build:icons:toolbar
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC_DIR = resolve('icon');
// 必须是 .tsx —— 生成的内容里有 JSX，而 TypeScript 只对 .tsx 启用 JSX 解析。
// 写成 .ts 会报一堆 '>' expected，看着像生成器写坏了，其实是扩展名的问题。
const OUT = resolve('apps/web/src/components/toolbar-icons.tsx');

/** 中文文件名 → 命令清单里用的图标名。 */
const NAME_MAP = {
  bold: 'bold',
  italic: 'italic',
  strikethrough: 'strikethrough',
  inlineCode: 'inlineCode',
  link: 'link',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  bulletList: 'bulletList',
  orderedList: 'orderedList',
  taskList: 'taskList',
  quote: 'quote',
  codeBlock: 'codeBlock',
  table: 'table',
  image: 'image',
  // 文件三件套：同一套语言画出来的，粗细一致。
  openFolder: 'openFolder',
  openFile: 'openFile',
  save: 'save',
  // 侧栏开关：普通态线框，激活态实心（同一形状的两种视觉重量）
  leftSidebar: 'sidebar',
  'leftSidebar-active': 'sidebarActive',
  // vim 模式指示（状态栏左下角）
  'vim-mode': 'vimMode',
  formula: 'formula',
  plugins: 'plugins',
};

function convert(file) {
  const raw = readFileSync(file, 'utf8');

  /*
   * viewBox 必须**逐个取**，不能统一写 1024。
   *
   * 这批图标名义上是 1024 网格，但有 3 个不是：h1 是 1047 宽、
   * openFolder 1052、taskList 1034。之前 `Icon` 组件把 toolbar 图标的
   * viewBox 写死成 `0 0 1024 1024`，代价实测（浏览器 getBBox）：
   *
   *   h1         路径到 x=1047.4 → 右侧被裁 23.4 单位（宽度的 2.29%）
   *   openFolder 路径到 x=1029.7 → 裁 5.7 单位（0.56%，看不出来）
   *   taskList   路径到 x=1011.7 → 不裁，只是整体放大 1%
   *
   * 也就是说 H1 的右边缘一直在被静默切掉 —— 16px 下约 0.37px，
   * 没人会看出来，但它就是错的。现在把真实 viewBox 一起生成出去。
   */
  const viewBox = /viewBox="([^"]+)"/.exec(raw)?.[1];
  if (!viewBox) return null;

  // 取出所有 path 的 d。这个图标集只有 path，没有 circle/rect。
  const paths = [...raw.matchAll(/<path[^>]*\sd="([^"]+)"[^>]*\/?>/g)].map((m) => m[1]);
  if (paths.length === 0) return null;

  // 单个 path 直接输出；多个包一层 Fragment
  if (paths.length === 1) {
    return { viewBox, node: `<path d="${paths[0]}" fill="currentColor" />` };
  }

  const elements = paths.map((d) => `        <path d="${d}" fill="currentColor" />`);
  return { viewBox, node: `(\n      <>\n${elements.join('\n')}\n      </>\n    )` };
}

const entries = [];
const missing = [];

for (const file of readdirSync(SRC_DIR)) {
  if (!file.endsWith('.svg')) continue;
  const key = NAME_MAP[basename(file, '.svg')];
  if (!key) {
    missing.push(file);
    continue;
  }
  const converted = convert(resolve(SRC_DIR, file));
  if (converted) entries.push({ key, ...converted, file });
}

entries.sort((a, b) => a.key.localeCompare(b.key));

/**
 * 生成结果（纯函数，不落盘）。
 *
 * 抽出来是为了让 `check:icons` 能拿到**内存里的结果**去和磁盘上的文件比对 ——
 * "图标源改了但忘了重新生成"是这套生成器唯一的失败模式，
 * 而它的表现完全静默：新图标就是不出现在界面上。
 */
export function buildToolbarIcons() {
  const body = entries
    .map(
      ({ key, node, viewBox, file }) =>
        `  // ${file}  (viewBox ${viewBox})\n  ${key}: {\n    viewBox: '${viewBox}',\n    node: ${node},\n  },`,
    )
    .join('\n');

  const output = `/**
 * 工具栏图标 —— **自动生成，不要手改**。
 *
 * 来源：仓库根目录的 icon/*.svg
 * 重新生成：npm run build:icons:toolbar
 *
 * 这些是 1024 单位的 iconfont 路径。两条与手写图标不同的约定：
 *   1. viewBox 是各图标自己的真实网格（多数是 0 0 1024 1024，但有例外），
 *      所以 viewBox 必须跟着图标一起生成 —— 写死成 1024 会把宽于 1024 的
 *      图标右侧裁掉（h1 就这样被裁过 2.29%）。
 *   2. fill 一律是 currentColor。iconfont 导出的路径不带 fill，
 *      默认会渲染成黑色，放进深色界面就是一团黑。
 */

import type { JSX } from 'react';

export interface ToolbarIcon {
  /** 该图标自己的坐标网格。不同图标的宽度可能不同，不能统一。 */
  readonly viewBox: string;
  readonly node: JSX.Element;
}

export const TOOLBAR_ICONS: Record<string, ToolbarIcon> = {
${body}
};
`;

  return { output, entries, missing };
}

/**
 * 只在**直接运行**时写文件。被 check-icons.mjs import 时若有副作用，
 * 就会在"检查"里顺手改写被检查的对象 —— 那样的闸门永远绿。
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  if (missing.length > 0) {
    console.error(
      `icon/ 里有未登记映射的文件（请在 NAME_MAP 里补上）：\n  ${missing.join('\n  ')}`,
    );
    process.exit(1);
  }
  if (entries.length === 0) {
    console.error('icon/ 里没有可用的 svg —— 生成器什么都没做，请先确认目录没被清空。');
    process.exit(1);
  }

  writeFileSync(OUT, buildToolbarIcons().output, 'utf8');
  console.log(`已生成 ${entries.length} 个图标 -> ${OUT}`);
  console.log(`  ${entries.map((e) => e.key).join(', ')}`);
}
