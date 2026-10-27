# Changelog

本项目的版本变更记录，格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

单版本的发布公告（GitHub Release 正文）在 `docs/releases/<tag>.md`，
这里保留所有版本的累积视图。

## [Unreleased]

### Planned

- 编辑历史的版本间 diff（v0.1.2 已完成单版本对比，尚缺版本间对比）
- 工具栏在触屏上的点按目标（当前约 26px，低于 44px 建议值）

## [0.1.4] - 2026-10-27

> Consistent with `docs/releases/v0.1.4.md`.

Small fixes only. No new features.

### Fixed

- **Desktop icons looked undersized** — `npx tauri icon` was run to repair
  the Android icon, but it also rewrites the desktop PNGs and pads them to
  the mobile safe-area ratio (artwork covered ~80% of the canvas). Desktop
  icons are rendered edge to edge again via `scripts/make-icons.mjs`;
  `tauri icon` runs first for the icns, then the PNGs are overwritten.
- **Language preference was written but never read** — `normalizeSettings`
  validated `settings.locale` (the default, always valid) and never assigned
  `obj.locale`, so `"locale": "de"` in settings.jsonc had no effect and every
  restart fell back to "follow system". The check had also drifted inside the
  `obj.theme` branch, so it did not run when the file omitted a theme. Both
  fixed; `LOCALES` is now the single source of allowed values.
- **Source-mode toggle was hard to read** — the pressed state used link blue,
  which reads as a hyperlink rather than an engaged switch, most visibly in
  light themes. Now uses the body colour with a brand-tinted background.
- **APK still showed the Tauri icon** — the bundled icons have been correct
  since v0.1.3. A build showing the default icon is reusing an existing
  `src-tauri/gen/android` directory, since Tauri copies `icons/android/mipmap-*`
  into it only on first generation. Run `npx tauri android clean` before
  rebuilding.

## [0.1.3] - 2026-10-26

> Consistent with `docs/releases/v0.1.3.md`.

Eight interface languages, and a layout that works on a phone.

### Added

- **Eight interface languages** — 简体中文 / English / Deutsch / Français /
  日本語 / 한국어 / Italiano / Русский, 223 keys each, selectable from
  Settings › Language as a flag row (plus a globe for "follow system")
  - `t()` is a plain function over module-level state, not a React hook —
    runtime messages and plugin code need text outside the component tree
  - `TextKey = keyof typeof zh`; every dictionary is `Record<TextKey, string>`,
    so a missing key fails the build instead of falling back at runtime
  - Initial locale resolves at module load rather than defaulting to Chinese;
    imperative views render once and would otherwise stay in the wrong language
  - Command titles and category prefixes translate at render time (plugins
    declare them in a module-level manifest, where `t()` would freeze the
    language active at import)
- **Portrait layout**
  - > 900px — sidebar occupies layout width, open/closed state persists
  - ≤ 900px — sidebar becomes an overlay, closed by default, no longer
    written to settings when toggled
  - ≤ 1200px — toolbar wraps to a second row (it previously scrolled with
    its scrollbar hidden, so the last ten buttons were invisible)
  - ≤ 640px — status bar keeps word count and drops secondary items;
    settings / history / command panels go full-screen

### Fixed

- **APK shipped the Tauri logo** — `scripts/make-icons.mjs` only writes
  desktop icons and never touched `src-tauri/icons/android/`, which still
  held the `tauri init` defaults. Mobile assets are now generated with
  `npx tauri icon logo.svg` (five densities plus `mipmap-anydpi-v26`
  adaptive-icon layers). Reinstall the APK to pick it up.
- Flag icons blank for German, Italian, Russian, Korean — each source SVG has
  its own coordinate space (`gb` `0 0 60 30`, `de` `0 0 5 3`,
  `kr` `-72 -48 144 96`); pinning all of them to `0 0 900 600` shrank the
  artwork into a corner. Each flag keeps its own `viewBox` now.
- Several flags share `id="a"`; inlined side by side they collided. Every SVG
  id carries a locale prefix.
- Selected language always reported as "system" — `RuntimeState.locale` read
  from `configuration` while `updateSettings()` writes `currentSettings`.
- Outline and file-tree empty states kept the previous language after a
  switch — imperatively rendered views are now rebuilt on locale change.
- Sidebar open/closed state never reacted to window resizing — `isWideScreen()`
  read the width once; now driven by a `matchMedia` subscription.
- Narrow-screen status bar lost its word count — the flex spacer pushed it out
  of the container and `overflow: hidden` clipped from the right.

### Known limitations

- Third-party plugins are not translated; only built-in command titles and
  categories are mapped.
- Internal log lines, manifest validation errors and the debug report template
  stay in Chinese (their audience is developers; the keywords are greppable).
- Toolbar buttons are ~26px even on touch screens, below the 44px target.

## [0.1.2] - 2026-10-24

> Consistent with `docs/releases/v0.1.2.md`.

Edit History Diff, plus a batch of fixes accumulated since v0.1.1.

### Added

- **Edit History Diff** (`Ctrl+Shift+G` → Compare)
  - **Unified** view: old line no. / new line no. / sign / content
  - **Split** view: two equal-width columns, fixed divider; long lines
    scroll horizontally within their own column instead of crossing the midline
  - Hatched fill for empty side rows in Split view
  - Header: file name, `+N / −N` stats, Unified / Split toggle
  - Line-level LCS engine (`apps/web/src/lib/diff.ts`)

### Fixed

- `Ctrl+F` did nothing: `search()` extension present, `Mod-f` binding missing
- WebView native find hijacked `Ctrl+F`; intercepted and forwarded as app event
  (CM6 keymap skips `defaultPrevented` events)
- vim `:wq`: command unregistered / `:wq` resolves as `write` + `q` /
  save-then-close race (saving is async); `onSaveRequest` now returns a `Promise`
- File-tree focus never reached the tree (stopPropagation, missing `tabindex`,
  wrong query selector); `j/k/Enter` navigation works after focus
- Status bar: stats to the right, version moved to Settings › About
- Debug panel: log search, full error stacks, settings snapshot in report,
  `[timeline]` markers
- **macOS DMG reported as "damaged"** (#1): `Contents/_CodeSignature/CodeResources`
  was missing from the bundle, so Gatekeeper treated it as corruption instead of
  an unsigned app. Fixed by enabling ad-hoc signing (`bundle.macOS.signingIdentity
  = "-"`) so `tauri build` emits a complete signature, and by adding a CI gate that
  fails the build when `codesign --verify --deep --strict` rejects the bundle

### Known limitations

- Diff compares a history version against the current document only
  (two-history-version comparison not yet supported)
- `:q` closes the current tab, not the whole application
- Heap memory depends on `performance.memory`

## [0.1.1] - 2026-10-23

> 与 `docs/releases/v0.1.1.md` 保持一致。

面板快捷键、vim 全键盘、字数统计与 DEBUG 模式。渲染与 v0.1.0 一致，本版聚焦
"操作效率"与"可观测性"。

### Added

- **面板快捷键**（全部 toggle，再按一次关闭；判断用 `event.code`）
  - `Ctrl/Cmd+Shift+X` 插件面板
  - `Ctrl/Cmd+Shift+G` 编辑历史
  - `Ctrl/Cmd+Shift+,` 设置
  - `Ctrl/Cmd+Shift+M` vim 模式
  - `Ctrl/Cmd+Shift+E` 聚焦编辑区
  - `Ctrl/Cmd+Shift+P` 命令面板
- **vim 模式全键盘**
  - ex 命令：`:w` 保存、`:q` 关闭当前标签（未保存时走确认）、`:wq`
  - `Ctrl+F` 打开编辑区查找（不绑定 `Ctrl+G` / `Shift+Ctrl+G`）
  - `Ctrl+Shift+B` 打开侧栏后焦点进入文件树，`j`/`k`/`Enter` 可导航
  - 状态栏 `-- NORMAL --` / `-- INSERT --` 子模式指示
- **字数、行数、词数统计**：状态栏右下角 `行 · 词 · 字`；中文按 CJK 计字、
  英文按连续字母数字计词，等宽排版防跳动
- **DEBUG 模式**（`F12`，底部停靠）
  - 指标：FPS / 输入延迟（EMA 平滑）/ 堆内存 / 主线程阻塞次数 / 版本
  - 输入延迟与主线程阻塞**只在调试面板显示**，不占状态栏
  - 日志：`console.*` + 未捕获异常 + Promise 拒绝，环形缓冲 500 条，
    应用启动即收集；支持搜索与级别过滤
  - 复制诊断报告：含设置快照、文档状态、性能指标与最近 200 条日志

### Fixed

- `Ctrl+Shift+B` 只能关不能开（handler 读渲染期闭包旧值）
- `Ctrl+Shift+,` 无效（`Shift+,` 的 key 是 `<`，改用 `event.code`）
- DEBUG 面板日志为空（拦截在面板打开时才安装）
- DEBUG 面板只露出一条边（`.app` grid 隐式行高度 0）
- `Ctrl+F` 查找丢失（`search()` 扩展在，但 keymap 缺 `Mod-f`）

### Known limitations

- vim 的 `:q` 关闭当前标签，不是整个应用
- 堆内存依赖 `performance.memory`（WebView2 可能显示 —）

## [0.1.0] - 2026-10-22

> 与 `docs/releases/v0.1.0.md` 保持一致。

插件系统从"能加载"走到"能写"：五个贡献点全部接通，命令面板补齐了
命令层的唯一主入口，加载链有五层容错。

### Added

- **插件贡献点**：`commands` / `keybindings` / `menus` / `views` /
  `configuration` 全部可用
  - 命令三个入口：工具栏按钮、命令面板、键位
  - 键位按 VSCode 写法（`Mod-Shift-D`），宿主翻译成编辑器语法
  - 视图在侧栏注册 `render(container)` 面板
  - 配置项在设置页「插件配置」区自动渲染，插件可读写
- **命令面板**（`Ctrl/Cmd+Shift+P`）：搜索、方向键选择、回车执行、
  右侧显示快捷键；过滤掉无需用户可见 title 的内部命令
- **插件管理面板**：列表视图，含图标、状态徽章（已启用/已禁用/
  加载失败/未激活）、版本与 id、失败原因、启用/禁用/删除、导入入口
- **插件配置 UI**：`ConfigurationService.listSchemas()` + 设置页
  「插件配置」区（boolean 分段按钮，number/text 输入框）
- **`defaultPlugin` 图标**：插件未设置图标时的统一默认图标

### Changed

- 插件加载移入启动序列（`configuration.load` → 恢复工作区 →
  `loadSettings`/`applySettings` → 插件加载/激活 → 冷启动文件），
  禁用名单与插件配置在此之前才有值
- 弹窗类 UI 统一复用 `.settings-*` 结构与样式（插件面板、命令面板）
- 工具栏命令未设 `icon` 时兜底改为 `defaultPlugin`（原为 `code`）
- 状态栏只统计加载失败的插件（`failed`），用户主动禁用不再计入

### Fixed

插件加载链的六个独立缺陷，任何一个都会让插件"看起来装了、实际不可用"：

- **贡献被覆盖**：外部插件逐个 `host.load()`，而 load 是全量重建，
  最后一个插件的贡献把内置插件（文件树/大纲/格式化/文件操作）冲掉 ——
  表现为工具栏清空、侧栏打不开
- **激活过严**：点命令时还要求显式声明 `onCommand:<id>` ——
  改为"声明了命令即隐含激活"（对齐 VSCode）
- **生命周期错位**：插件加载与激活曾写在 `regrantWorkspace()` 里，
  正常启动走自动恢复工作区，从不经过该函数
- **闭包 TDZ**：启动任务在 `createRuntime` 同步体早期访问函数体内后段
  的 const；catch 里的 `showMessage` 当时也不可用 —— 错误双重静默
- **假激活**：没有 `activate` 导出时仍置为 `active`，命令一条没注册
- **字段名不匹配**：外部插件传 `{ module: { activate } }` 而接口是平铺
  字段，且被 `as never` 掩盖 —— 插件系统失效的真正根因

其余修复：

- **禁用不持久**：`plugins.disabled` 只写不读；且插件加载早于
  `applySettings`，读到的是默认空名单
- **禁用后工具栏残留**：`disable()` 只清命令表、不重建贡献集
- **命令面板列出内部命令**：`aropyt.explorer.open` 等需要参数的内部命令
  出现在面板里
- **插件键位不触发**：CM6 要求末段字母小写（`Mod-Shift-d`），插件按
  VSCode 写 `Mod-Shift-D` 永远匹配不上
- **`Ctrl+Shift+B` 只能关不能开**：只注册一次的 handler 读到了首次渲染
  时闭包里的旧值
- **history 图标被裁切**：`history.svg` 的 viewBox 是 `0 0 200 200`，
  转制时写死成 1024
- **`deactivate()` 从未被调用**：文档承诺"退出或禁用时调用"

### Known limitations

- 插件为单文件，不能使用 npm 依赖
- 插件与应用同进程运行，没有沙箱
- 不支持热重载（修改后需重新导入并重启）
- `views` 目前验证了 `sidebar`；`main` / `right` 未验证
- 生产版无开发者工具，插件错误详情通过插件面板的原因字段查看

## [0.0.9] - 2026-10-20

> 与 `docs/releases/v0.0.9.md` 保持一致。

### Added

- **GitHub 风格警报块**：`[!NOTE]` / `[!TIP]` / `[!IMPORTANT]` /
  `[!WARNING]` / `[!CAUTION]`，五套官方 Octicon 图标与类型配色
  （CSS mask + data URI，颜色取语义令牌，深浅主题自适应）

### Changed

- **排版节奏收紧**：正文行高 1.2；段落间的空行压缩至 0.1em；
  重置 `blockquote` / `pre` 的 UA 默认 margin（1em 40px / 1em）；
  引用与列表项内部段落不吃段间距；警告块 padding/margin 收紧

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
