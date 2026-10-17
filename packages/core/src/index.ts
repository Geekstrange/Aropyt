/**
 * @aropyt/core —— 编辑器内核。
 *
 * 纯 Web，零平台 API：不 import 任何 Node / Electron / Tauri 模块。
 * 这是它能同时跑在桌面壳、Android 壳和浏览器里的前提，不是可选项。
 *
 * 内核刻意保持薄。只有这几件事不可插件化：
 *   文档模型与文件抽象 / CodeMirror 实例 / 插件加载与激活调度 /
 *   命令注册表与键位 / 配置系统 / 布局槽位
 * 其余一切（包括内置的预览、工具栏、文件树、搜索、导出、主题）
 * 都必须走 @aropyt/plugin-api 实现 —— 一个后门都不能开。
 * 一旦官方功能绕过插件 API，插件生态就注定长不成。
 *
 * 依赖方向：capabilities → core。单方向，不许反向。
 */

export * from './theme.js';
// 注意：markdown 渲染管线**故意不从根入口导出**。
// 它要从 '@aropyt/core/markdown' 单独引入，这样 markdown-it + highlight.js
// 才会被 Rollup 切成独立的懒加载 chunk，而不是被根入口拖进首屏。
// 从根入口 re-export 它，等于让整个渲染引擎进入首屏预算 —— 这是很容易犯的错。
export * from './commands.js';
// Typora 式原地渲染。这是产品的默认编辑形态：
// 编辑区本身即预览，没有并排的第二栏。
export { inlineRender, type InlineRenderConfig } from './wysiwyg/inline-render.js';
export * from './safety.js';
export * from './performance.js';

export * from './kernel/idb.js';
export * from './kernel/commands.js';
export * from './kernel/storage.js';
export * from './kernel/editor.js';
export * from './kernel/plugin-host.js';
/*
 * 内核固有视图曾有一个"分栏预览面板"（kernel/preview.ts）—— 已整体移除：
 * Typora 式编辑里编辑区本身就是预览，再挂一栏 iframe 渲染是第二套
 * 渲染管线，两边各显示一半，反而制造不一致。
 */
