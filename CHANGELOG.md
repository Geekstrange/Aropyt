# Changelog

本项目的版本变更记录，格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

单版本的发布公告（GitHub Release 正文）在 `docs/releases/<tag>.md`，
这里保留所有版本的累积视图。

## [Unreleased]

### Planned

- 段落间距优化（行距与段距分层）—— 方案已定，待排期
- 编辑历史的版本间 diff
- 完整的多语言界面（English / 简体中文 / 繁體中文 / 日本語 / 한국어 /
  Deutsch / Français / Italiano / Русский）—— **已跳票**，
  待核心体验稳定后再排期

## [0.0.9] - 2026-10-20

> 与 `docs/releases/v0.0.9.md` 保持一致。

### Added

- **GitHub 风格警报块**：`[!NOTE]` / `[!TIP]` / `[!IMPORTANT]` /
  `[!WARNING]` / `[!CAUTION]`，五套官方 Octicon 图标与类型配色
  （CSS mask + data URI，颜色取语义令牌，深浅主题自适应）

### Fixed

- **侧栏开合状态不持久**：sidebarOpen 改为 RuntimeState 投影订阅。
  原实现是组件局部 state + 只在 runtime 创建时读一次配置，而配置异步
  加载 —— 那一刻拿到的是默认值，之后永不更新（表现为"关掉侧栏、
  重启又展开"）

## [0.0.8] - 2026-10-19

> 与 `docs/releases/v0.0.8.md` 保持一致；本节只做技术向归类。

### Added

- **Android 正式签名 APK**（Android 10+ / arm64）：CI 全自动构建 —
  Gradle init script 注入签名、`tauri icon` 生成 Android mipmap、
  `fitsSystemWindows` 修复状态栏溢出
- **源码模式非打印字符**（`Ctrl+/`）：空格为浅色中点、制表符为向右箭头、
  控制字符为转义符号（`highlightSpecialChars` + 自定义行装饰）
- 工具栏图标更新：设置、插件管理、源码模式（setting / plugin / invisible）

### Changed

- 设置面板标题栏固定，内容区独立滚动
- 配置区过时说明文字修正（"写回文件在下一版接入" → "会立即写回"）
- 空白字符标记使用专用颜色令牌 `--md-ws-dot`（半透明，深浅两套）

### Fixed

- 发布流程 tag 错位：`tagName` 改用真实 tag（rc 与正式版不再混淆）
- Windows MSI 编码：fileAssociations 类型名改英文 + `wix.language=zh-CN`
- Android 安装包图标不再是 Tauri 默认图标

### Removed

- 应用内 i18n（多轮脚本改写导致字典损坏；完整实现已跳票，
  不再承诺具体版本）

## [0.0.7] - 2026-10-19

### Added

- **编辑历史**：保存即版本、内容哈希去重、按文件淘汰、一键恢复
  （恢复前自动快照当前内容）、手动命名版本
- **自动保存版本**：可设间隔（默认 60 秒）
- **数据导出 / 导入**：草稿与编辑历史打包为单个 JSON
- 设置面板「数据备份」与「编辑历史」分区

### Fixed

- 导出无反应：ACL 未授权 `dialog:allow-save` / `dialog:allow-ask`
- 导出静默失败：读取 IndexedDB 的错误未被捕获
- CI：移除平台特定的 `bundle.targets`

## [0.0.6] - 2026-10-18

### Added

- 文件关联：`.md` / `.markdown`、`.tex` / `.latex`、`.fountain`
  （NSIS 安装时注册，自定义 SVG 图标）
- 单实例：已运行时双击文件转发到现有窗口

### Fixed

- 主线程预算提示在启动阶段误报（宽限期）

## [0.0.5] - 2026-10-17

### Added

- 设置面板：主题三态、Vim 开关、配置文件路径与打开入口
- 配置真源迁移到 `~/.aropyt/settings.jsonc`（原子写 + 非法值提示）

## [0.0.4] - 2026-10-16

### Added

- Vim 模式打磨：NORMAL / INSERT / VISUAL 状态指示、光标形状、
  vim 模式下固定源码视图

## [0.0.3] - 2026-10-15

### Added

- 侧栏：文件树与大纲（折叠、活动文件展开、跨会话折叠状态）
- 视图系统：内核固有视图与插件贡献视图两条通道

## [0.0.2] - 2026-10-14

### Added

- Typora 式原地渲染：块级所见即所得，光标行显形、非光标行渲染
- Markdown 渲染管线：GFM、数学公式、代码高亮、任务列表

## [0.0.1] - 2026-10-13

### Added

- 项目骨架：Tauri 2 + CodeMirror 6 + React 18
- 编辑器内核、命令注册表、键位解析、主题系统
- 深浅色板与首屏包体预算闸门

[Unreleased]: https://github.com/Geekstrange/Aropyt/compare/v0.0.9...HEAD
[0.0.9]: https://github.com/Geekstrange/Aropyt/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/Geekstrange/Aropyt/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/Geekstrange/Aropyt/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/Geekstrange/Aropyt/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/Geekstrange/Aropyt/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/Geekstrange/Aropyt/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/Geekstrange/Aropyt/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/Geekstrange/Aropyt/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/Geekstrange/Aropyt/releases/tag/v0.0.1
