/**
 * 图标 —— 全部内联 SVG + currentColor。
 *
 * 不用图标字体、不用图标库：整个应用用不到几十个图标，
 * 为此背一个图标包的体积在"轻量"面前不成立。
 * currentColor 让它们自动跟随主题与状态色，也不需要为深浅色各画一套。
 *
 * 工具栏那批格式图标是**生成**的（见 toolbar-icons.ts），
 * 只有界面结构图标（菜单、主题、预览这些开关）才手写在这里 ——
 * 前者是设计资源，后者是界面的一部分，两者维护节奏不同。
 * 判据：**表达"内容格式"的图标必须有图标源，纯 UI 开关不必。**
 *
 * ⚠️ 名字是两套图标之间**唯一**的联系：命令清单里写 `icon: 'xxx'`，
 * 这里按名字查不到就渲染成一个空 span —— 按钮变成空白块，且零报错。
 * 所以图标名一律由 `npm run check:icons` 盯着，不要靠肉眼核对。
 */

import type { JSX } from 'react';

import { TOOLBAR_ICONS } from './toolbar-icons.js';

interface IconProps {
  readonly name: string;
  readonly size?: number;
}

/*
 * ── 两类图标，两套坐标 ────────────────────────────────────
 *
 * 界面图标：手绘在 16x16 网格上，用 stroke 描边 —— 这类图标要跟文字
 * 对齐、要能在 16px 下看清楚，描边比填充更可控。
 *
 * 工具栏格式图标：来自 icon/*.svg（1024 单位、纯填充），由
 * scripts/make-toolbar-icons.mjs 生成到 toolbar-icons.ts。
 * 两套坐标不混用，各自按自己的 viewBox 渲染。
 */
const UI_ICONS: Record<string, JSX.Element> = {
  /*
   * 这里原本有三个手绘件：folder / file / save。
   *
   * 现在全部退役了 —— 对应图标都有了 icon/*.svg 源（由生成器产出
   * openFolder / openFile / save），手绘版本永远不会被查到，
   * 留着只会让人以为工具栏用的还是这里这套。
   *
   * 留下来的这些是**界面结构图标**：它们不表达内容格式，
   * 而是这层 UI 自己的开关（菜单、主题、预览），没有对应的图标源，
   * 也不需要跟工具栏那套共用坐标。
   */

  // 汉堡菜单 / 关闭：窄屏下的侧栏与预览开关
  menu: <path d="M2 4h12M2 8h12M2 12h12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />,
  close: <path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />,

  // 眼睛：预览开关
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </>
  ),

  /*
   * 主题三态图标。
   *
   * 为什么给"跟随系统"单独一个显示器图标而不是复用太阳/月亮：
   * 三态循环里如果只有两种图形，用户看到同一个图标会以为按钮坏了。
   */
  sun: (
    <>
      <circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.3v1.8M8 12.9v1.8M1.3 8h1.8M12.9 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </>
  ),
  moon: (
    <path
      d="M13.4 9.7A5.7 5.7 0 0 1 6.3 2.6a5.9 5.9 0 1 0 7.1 7.1z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  ),
  autoTheme: (
    <>
      <rect x="1.8" y="2.9" width="12.4" height="8.2" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 13.5h4M8 11.1v2.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </>
  ),

  // 源码模式图标 + 未知图标名的兜底
  code: <path d="m5.5 5-3 3 3 3m5-6 3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />,
};

export function Icon({ name, size = 16 }: IconProps): JSX.Element {
  // 工具栏图标（1024 单位）优先，退回手绘的界面图标（16 单位）。
  const toolbar = TOOLBAR_ICONS[name];
  const shape = toolbar?.node ?? UI_ICONS[name];

  if (!shape) return <span style={{ width: size, height: size, display: 'inline-block' }} />;

  return (
    <svg
      width={size}
      height={size}
      /*
       * 两套图标坐标不同：工具栏那批来自 iconfont（各自一个网格），
       * 手绘的是 16 单位。用各自的 viewBox 才能都填满给定尺寸。
       *
       * ⚠️ 工具栏的 viewBox 是**每个图标自己的**，不能统一写 1024 ——
       * h1 的网格是 1047 宽，写死 1024 会把它右边缘裁掉 2.29%（实测）。
       */
      viewBox={toolbar ? toolbar.viewBox : '0 0 16 16'}
      aria-hidden="true"
      focusable="false"
      style={{ flex: '0 0 auto' }}
    >
      {shape}
    </svg>
  );
}
