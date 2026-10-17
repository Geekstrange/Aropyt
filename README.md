# Aropyt

**Typora 式 Markdown 编辑器 —— 编辑区本身就是预览。**

跨平台（Windows / macOS / Linux / Android）、文件即真理、极致轻量。
浏览器形态仅为开发模式（`npm run dev`），发布形态统一 Tauri 2。

> 许可证: AGPL-3.0

## 特点

### 块级所见即所得（WYSIWYG）

编辑区不是「源码 + 高亮」，而是**渲染本身**：文档按块切分，非光标块整体呈现为
markdown-it 渲染的真实 HTML（真表格布局、真标题排版），光标所在块自动切回源码
供编辑，移开即渲染 —— 与 Typora 相同的交互模型，且**编辑区与预览用的是同一个
渲染引擎**，所见即所得是架构保证，不是近似。

### 完整的 Markdown 渲染

- **代码块语法高亮**：highlight.js，常见语言开箱即用，配色跟随主题
- **Mermaid 图表**：` ```mermaid ` 代码块直接渲染成 SVG（流程图 / 时序图 / 类图 /
  思维导图…），库按需加载，不用不下载
- **表格**：真实 `<table>` 布局，表头加重、行分隔、对齐
- **HTML 内联**：`<strong>` `<svg>`等标签直接以真实元素呈现
- **链接 / 转义 / 任务列表 / 引用 / 图片**：全套 GFM 支持，裸 URL 自动链接

### Vim 模式

底部状态栏一键开关 normal / insert / visual 操作方式；指示器常驻左下角
（开启显示 vim 图标，关闭显示品牌色绿点）。

### 轻量与性能

- 首屏 ≤ 300 KB（gzip），markdown-it / highlight.js / mermaid 全部按需加载
- CodeMirror 6 视口虚拟化，长文档滚动零成本
- 装饰冻结：输入法（IME）组合期间不重算渲染，中文输入零干扰
- 帧预算监控：主线程卡顿可观测、可归因

### 文件即真理

文档始终是磁盘上的纯 Markdown 源码。渲染只改变「怎么画」，复制粘贴出来
的永远是源码 —— 不锁定、不私有格式、可版本控制。

### 插件系统

VSCode 式声明式贡献 + 懒激活：大纲、文件树、格式化都是插件；内核只保留
编辑器、文档模型与渲染管线。插件拿到的是稳定的 API 面，摸不到编辑器内部。

## 构建与运行

```bash
npm install
npm run dev          # 浏览器开发模式
npm run tauri dev    # 桌面开发模式
npm run tauri build  # 发布构建
npm run verify       # 全量验证（编译 + 12 项行为闸门）
```

## 平台说明

- **Windows**：本仓库当前构建环境，直接 `npm run tauri build`
- **macOS / Linux / Android**：Tauri 2 多平台统一外壳，需在对应平台（或 CI）
  构建；Linux 依赖 WebKitGTK（详见 Tauri 官方文档）

## 许可证

AGPL-3.0
