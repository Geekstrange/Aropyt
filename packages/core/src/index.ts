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
export { initUpstreamRenderer, mountUpstreamHost, upstreamRenderExtensions } from './editor-upstream/adapter.js';
export * from './safety.js';
// 纯函数，无依赖 —— 状态栏每次渲染都要用，必须留在根入口。
export * from './text-stats.js';
export * from './performance.js';
// 语言识别属于内核职责（文档身份），渲染不属于 —— 见 languages.ts 的说明。
export * from './languages.js';

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

export {
  MAX_VERSION_BYTES,
  clearHistory,
  getVersion,
  hashText,
  listVersions,
  recordRemoteVersion,
  recordVersion,
  type HistorySummary,
  type HistoryVersion,
} from './kernel/history.js';
export { applyBackup, assembleBackup, type BackupFile } from './kernel/backup.js';

/*
 * 同步的**纯逻辑**（决策表 + 执行器）。
 *
 * 放在 core 而不是 `apps/web`：开源版用 WebDAV、商业版用自建云 API，
 * 但"哪些文件该上传、哪些该下载、什么算冲突"对两者完全一样。传输层
 * 依赖 `SyncBackend` 接口，各自实现；这一层不该被两端各抄一份。
 *
 * `dav.ts` / `host.ts` 留在 `apps/web` 侧 —— WebDAV 只是开源版的能力，
 * 商业版不会需要它。
 */
export {
  actionKey,
  causeKey,
  hashBytes,
  /*
   * `hashText` 不在这里再导一次：`kernel/history.ts` 已经提供了同名的
   * 函数（同一套 FNV-1a，只是喂的是 UTF-16 码元）。两个同名导出会让
   * `index.ts` 报 Duplicate identifier，而且调用方分不清该用哪个 ——
   * 同步一律用 `hashBytes`，文本哈希留给编辑历史。
   */
  planSync,
  summarize,
  summaryKey,
  type SyncAction,
  type SyncActionKind,
  type SyncCause,
  type SyncInput,
  type SyncSummary,
} from './sync/engine.js';
export {
  conflictPath,
  runSync,
  type BaseEntry,
  type RemoteMeta,
  type SyncBackend,
  type SyncRunResult,
  type SyncStepResult,
} from './sync/runner.js';
