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
 * ── 只有一套图标：icon/*.svg ──────────────────────────────
 *
 * 全部来自 `icon/`（1024 单位、纯填充），由
 * `scripts/make-toolbar-icons.mjs` 生成到 `toolbar-icons.tsx`。
 * 新增图标请**加 SVG 并登记到生成器的 NAME_MAP**，不要手绘一份：
 * 两套坐标系（16 单位 stroke / 1024 单位 fill）混用正是当初难维护的原因。
 *
 * ⚠️ 名字是图标源与代码之间唯一的联系：命令清单里写 `icon: 'xxx'`，
 * 这里按名字查不到就渲染成一个空 span —— 按钮变成空白块，且零报错。
 * 所以图标名一律由 `npm run check:icons` 盯着，不要靠肉眼核对。
 *
 * 这里曾有一组手绘的 16 单位界面图标（menu / close / eye / code /
 * sun / moon / autoTheme）—— 对应按钮后来要么改用文字、要么切到了
 * iconfont 那套，全部零引用，已删除。
 */
export function Icon({ name, size = 16 }: IconProps): JSX.Element {
  const icon = TOOLBAR_ICONS[name];

  /*
   * 查不到时渲染**同样大小的空 span**，而不是返回 null：
   * 按钮的宽度与对齐依赖这个占位，返回 null 会让工具栏在图标缺失时整体错位。
   * 空着不报错是刻意的（缺图标是资源问题，不该让界面崩掉），
   * 但名字对不对由 `npm run check:icons` 负责。
   */
  if (!icon) return <span style={{ width: size, height: size, display: 'inline-block' }} />;

  return (
    <svg
      width={size}
      height={size}
      /*
       * ⚠️ viewBox 是**每个图标自己的**，不能统一写 1024 ——
       * h1 的网格是 1047 宽，写死 1024 会把它右边缘裁掉 2.29%（实测）。
       */
      viewBox={icon.viewBox}
      aria-hidden="true"
      focusable="false"
      style={{ flex: '0 0 auto' }}
    >
      {icon.node}
    </svg>
  );
}
