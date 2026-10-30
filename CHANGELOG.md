# Changelog

本项目的版本变更记录，格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

单版本的发布公告（GitHub Release 正文）在 `docs/releases/<tag>.md`，
这里保留所有版本的累积视图。

## [Unreleased]

### Added

- **文档里手写的 HTML 控件有了样式**：`<kbd>` 画成按键帽（等宽、描边、
  底边加粗、圆角）、`<details>` 的 summary 有手型光标与悬停反馈、
  `<input type="checkbox">` 用品牌绿 `accent-color`，与 GFM 任务列表的
  复选框观感一致。

### Fixed

- **手写 HTML 控件在渲染态点不动**：`<input type="checkbox">` 切不了、
  `<details>` 展不开。CM6 处理 widget 上的 mousedown 时会 `preventDefault`
  （为了把光标落到替换范围的边界），浏览器默认行为被吃掉 —— 上一轮只给
  `.task-checkbox` 开了例外，文档里其它控件的标签不是那个类。现在
  `input` / `button` / `select` / `textarea` / `label` / `details` / `summary`
  统一告诉 CM6"这次事件我自己处理"。`<a>` 不在列：桌面壳里点击链接会让
  WebView 导航，需要单独的处理策略。
- **官网的 Microsoft Store 徽章只显示英语 / 简中 / 繁中**：静态图
  `get.microsoft.com/images/<locale>%20<variant>.svg` 只提供少数语言，
  其余 locale 请求到 404，徽章位置直接空掉。改用官方 web component
  （`ms-store-badge`），九种语言都有官方美术。三个细节：`theme` 显式跟随
  **站点**主题（组件的 `auto` 读系统偏好，站内切主题不生效）；语言 / 主题
  切换时重建元素（自定义元素不保证响应属性变化）；脚本 6 秒内未注册
  （离线或被拦）则显示纯文本兜底链接。
- 徽章尺寸：组件的 `size` 只认 `large` / `small`，而 `large` 在内部样式里
  硬编码 `img { height: 104px }`，放在首屏里过大。改为 `size="small"` +
  `ms-store-badge::part(img) { height: 48px }` —— 与原来的静态图同高，
  也是商店指南建议的可读尺寸。

### Planned

- 编辑历史的版本间 diff（v0.1.2 已完成单版本对比，尚缺版本间对比）
- 工具栏在触屏上的点按目标（当前约 26px，低于 44px 建议值）

## [0.1.6] - 2026-10-29

> 发布公告见 `docs/releases/v0.1.6.md`。

### Added

- **DEBUG 面板的操作轨迹**：打开/关闭文件、新建标签、保存/取消保存/保存失败、
  命令执行与失败、焦点落点失败、上次退出是否正常，各自记一条，容量 200 条。
  轨迹与日志缓冲分开存，插件打几十行日志也不会把"用户点了什么"挤掉。
- **诊断报告的错误摘要**：按文本去重，给出出现次数、首次/末次时间、完整堆栈，
  维护者不必再逐行扫日志。
- **诊断报告的环境块**：系统、架构、Tauri 版本、WebView 内核、窗口尺寸与缩放、
  界面语言、主题、安全模式 —— 对应 issue 模板里的必填项。
- **诊断报告的插件状态表**：包含每个插件的状态与失败原因。
- **上次会话的错误**：error 落盘到 IndexedDB，进程被杀或白屏后重启，
  仍能在日志与报告中看到上一次会话的错误。
- `console.debug` 纳入捕获 —— 插件通过 `logger.debug()` 打的调试信息此前完全不可见。
- 未捕获异常保留 `event.error.stack` 与列号；资源加载失败（图片/脚本）也会记录。
- **语言识别**：内置表覆盖已经注册文件关联的格式（Markdown / LaTeX /
  Fountain / 纯文本），并支持插件通过 `contributes.languages` 接管某个
  扩展名（插件贡献优先于内置表）。
- **状态栏与标签显示文件类型**：状态栏显示当前语言；非 Markdown 标签带
  类型徽标，`.fountain` / `.tex` 打开后不再"看起来像没支持"。
- **编辑器按语言切换解析器**（Compartment）：`.tex` / `.latex` 现在有语法
  高亮；`.fountain` 使用纯文本视图（官方 CodeMirror 语言包不含 Fountain，
  渲染由后续插件提供）。
- **内置 Fountain 剧本插件**：`.fountain` 文件打开后，侧栏出现「场景」列表
  （场景标题与分节，显示行号，点击跳转）；编辑器按行区分元素 ——
  场景标题加粗、角色名居中、对白缩进、括注与转场右对齐。
  实现只往行上挂 class、不改任何字符，编辑/撤销/保存全部走原生路径。
- **`onLanguage:` 激活事件接线**：这个激活事件在插件 API 里声明了很久，
  但从来没有任何地方派发它 —— 打开某语言的文档时插件不会被激活，
  按语言挂载的渲染扩展也就永远挂不上。现在由 activeFile 事件统一派发，
  切标签、另存为、崩溃恢复都会覆盖到。
- **文件树列出所有可编辑文本**：判定改为内核语言表（`detectLanguage`），
  不再写死 `.md/.markdown/.txt`。`.tex` / `.fountain` 现在能在树里看到、
  点击打开；图片与二进制仍然不列。空状态文案相应改为「还没有可编辑的文件」。
- **"打开文件…"与"另存为…"支持 LaTeX / Fountain / 纯文本**：对话框过滤器
  与文件关联共用同一份扩展名列表（`EDITABLE_EXTS`），不再只有 `.md/.txt`。
- **Fountain 元素补全**：标题页（`Key: Value`）、笔记 `[[ … ]]`、
  注释块 boneyard、歌词 `~`、分页线 `====` 都有对应样式；注释块里的
  `INT. …` 不再被误判成场景（先判注释块、再判场景）。
- **侧栏视图按语言显示**：视图贡献新增 `languages` 声明（缺省不限），
  「大纲」只在 Markdown 下出现、「场景」只在 Fountain 下出现，
  「文件」不受限制。判定完全来自插件声明，宿主不认识具体视图 id ——
  外部插件同样可用。未打开文件时按 Markdown 处理（产品默认形态）。
- **多工作区并存**：打开新文件夹是**追加**而不是顶替，旧项目的标签留在
  标签栏里；点某个标签就切回它所属的工作区（文件树、保存路由、插件看到
  的 `context.workspace` 一起跟随）。
- 每个标签顶部按**自己所属的工作区**着色（同一工作区同色，激活标签更实），
  两个项目里都叫 `notes.md` 的文件在同一条标签栏里也能分辨。
- 原生侧工作区由单根改为注册表：`set_workspace` 返回 `{ id, name, root }`，
  文件读写/列举命令都带 `rootId`。这样异步调用交错时也不会落到别的根上。
- 草稿与编辑历史按工作区隔离（复合键 `工作区id + 路径`）；旧版本以裸路径
  保存的草稿在读取时自动迁移，升级后第一次崩溃恢复不会失效。
- **侧栏顶部的工作区条**：一行一个已打开的工作区（色点 + 名称），点一下
  切换 —— 文件树换根、编辑器打开该项目最近用的标签（没有就清空）。
  色点与标签顶部色条同源，能直接把"这个标签"与"那个项目"对上。
  关闭按钮也从文件树内部移到这里，按工作区各管各的。
- 工作区列表持久化为 `workspace.roots: string[]`，并记录 `workspace.active`；
  启动时逐个恢复，激活项回到上次用的那个（不再退回列表末尾）。
  旧配置只有 `workspace.lastId` 时自动兼容。
- 启动轨迹增加一条 `plugins plugins=N views=N commands=N`：视图槽位数量是
  "侧栏为什么没有内容"的第一手证据 —— `views=0` 说明贡献汇总失败，
  `views>0` 而插件停在 declared 说明 onView 没有派发到，两种故障表现相似
  但根因完全不同。
- **内置 LaTeX 插件**：`.tex` 文件打开后有「结构」视图（`\part` / `\chapter` /
  `\section` / `\subsection` 等，按层级缩进、点击跳转），编辑器里用 KaTeX
  **原地渲染公式** —— 行内 `$…$` / `\(…\)`，块级 `\[…\]` / `$$…$$` /
  `equation` / `align` / `gather` / `multline` / `displaymath` / `eqnarray`。
  光标进入公式时自动退回源码，离开后重新排版。
- **LaTeX 文档排版**（公式之外的部分）：章节标题按层级排字号并隐藏命令本身、
  `\textbf` / `\emph` / `\textit` / `\texttt` / `\underline` / `\textsf` /
  `\textrm` 行内命令换成样式、`itemize` / `enumerate` 换成 `•` 与编号
  （环境行隐藏、`\item` 替换为符号）。列表项里的行内命令与公式同样生效。
- **LaTeX 文档结构渲染**：标题页（`\title` / `\author` / `\date` + `\today`）、
  摘要（`abstract`）、引用块（`quote` / `quotation`）、代码块
  （`verbatim` / `lstlisting` / `minted`，内部不做任何解析）、
  **表格**（`table` / `tabular`：`&` 分列、`\\` 分行、`\toprule` /
  `\midrule` / `\bottomrule` 画线、`\caption` 作表题、列格式 `l/c/r` 决定对齐）、
  `\newpage` 画分页线；`\maketitle` / `\tableofcontents` / `\label` /
  `\begin{document}` 等没有可见输出的命令直接隐藏。
- **行内命令补全**：`\LaTeX` / `\TeX` / `\XeTeX` 等换成文字，`\ref` /
  `\eqref` / `\cite` 保留键名并淡化，`~` 换成不换行空格，`\%` `\&` `\_`
  `\#` `\$` `\{` `\}` 还原成字符，`\includegraphics` 显示为路径占位。
- `%` 注释与 `\begin{}` / 导言行淡化。

### Changed

- 诊断报告重排为「环境 → 错误摘要 → 上次会话 → 操作轨迹 → 插件 →
  文档与配置 → 性能 → 日志」，并**不再包含标签正文**：原来的"设置快照"
  序列化了整个运行时状态（含所有标签的全文），会让报告超过 issue 字符上限、
  把日志段截断在中间。
- 性能页区分两种输入延迟：面板内 EMA 采样（仅面板打开后）与运行时**常驻**
  探针（含面板打开之前的超预算记录），并新增预算超支明细（来源 + 实际/预算值）。
- 面板内的文档规模改用 CodeMirror 文档元数据（O(1)），不再每次渲染调用
  `getText().split('\n')`。
- 日志列表独立渲染并合并高频通知：FPS 每秒刷新不再重绘 500 行日志。
- "复制报告"移到标题栏，三个页都可用；复制失败会给出提示，不再静默无响应。
- **非 Markdown 文档不再套用 Markdown 解析器与原地渲染**：此前 `.fountain`
  的 `#` 动作行会被当成标题渲染。现在这些格式按源码视图处理（行号 +
  等宽），源码/渲染切换按钮也随之隐藏 —— 它们没有第二种形态。
- 语言识别不再只认 `.md` / `.txt`：未命名文档与无法识别的扩展名仍回退
  Markdown（产品默认形态），但已知格式会拿到自己的 language id。
- 插件贡献的语言条目没有显示名时，回退到内置表同名条目的名称 ——
  此前插件一旦声明 `{ id: 'fountain' }`，状态栏会显示小写 `fountain`
  而标签徽标显示 `Fountain`，同一个语言在两处两个名字。
- 侧栏视图标题改为**渲染层翻译**：manifest 里保留中文原文（`场景` / `结构`），
  由 `commandTitle()` 按当前语言替换。此前在 manifest 顶层调用 `t()`，
  而那时语言还没从配置读出来 —— 界面切成英文后侧栏仍显示
  `Expand "场景"`，且切换语言不会更新。
- **非 Markdown 文档也支持源码/渲染切换**：`isRenderableLanguage` 只把
  **纯文本**排除，`.tex` / `.fountain` 与 markdown 一样有 Ctrl+/ 与工具栏开关。
  插件装饰在源码模式下自动让路（`EditorApi.sourceMode`）。
- 渲染层按语言挂载：只有 markdown 使用内联渲染器；其它语言的"渲染"完全由
  插件装饰提供。此前渲染层与语言无关，打开 `.tex` 会把正文当成 markdown
  解析，整段替换成 `cm-md-block` widget —— 插件装饰作用在被替换掉的文本上，
  用户看到的是一片错误的排版（这也是"tex 只渲染了公式"的直接原因）。
- 状态栏不再显示当前文件的语言：标签上的类型徽标已经说明了格式，
  两处写同一件事只是噪声。
- 头部不再显示工作区名（以及未命名文档的脏点提示 —— 现在每个文档都有
  标签，脏点由标签自己显示）。工作区的标识改由**标签顶部的色条**承担：
  颜色由工作区 id 哈希得到，同一工作区同色，激活标签更实，
  没有工作区的文件不着色。

### Removed

- 删除应用外壳里的 `[kd]` 按键诊断日志（每次带修饰键或功能键按下都写一条，
  污染日志缓冲并拖慢面板）。

### Fixed

- 长任务时间显示为 1970 年 —— `entry.startTime` 是相对 `timeOrigin` 的
  高精度时间戳，被当成 epoch 使用；现在采集时就换成 `Date.now()`。
- 主线程阻塞占比的"30 秒窗口"是固定分母且不随时间衰减，空闲后数字仍停住；
  改为真正的 60 秒滑动窗口。
- 日志自动滚动会把正在向上翻阅的用户拽回底部；现在只在已贴底时跟随。
- 同一条错误循环出现时刷满 500 条缓冲、把崩溃前的上下文挤掉；现在合并计数，
  且淘汰时优先保留 error（300 条独立配额）。
- Fountain 装饰在**滚动**时不再重新分类全文（此前每次视口变化都从文档开头
  跑一遍状态机，长剧本滚动会掉帧）；分类结果只在文本变化时重算一次。
- 切换工作区时文件树会显示**两套同名文件**：两次刷新并发执行，后完成的
  那次把行追加到了已被清空的容器上。现在先在离屏节点里建整棵树，
  再用序号丢弃过期结果。
- 文件树的抬头显示目录名而不是根路径（多工作区下路径会被截成一段省略号）。
- 打开第二个工作区之后**无法切回去**：上一版只实现了"并存"的数据层，
  没有任何切换入口，用户只能从标签栏里找一个属于旧项目的标签。
  现在由侧栏顶部的工作区条承担这个入口。
- 侧栏视图可能**永远停在「正在激活插件…」**：`onView` 派发用了一个
  `requestedRef` 去重，而 ref 会跨重挂载（HMR、折叠再展开、按语言隐藏再出现）
  保留 —— 只要第一次激活没成功，就再也不会派发第二次。现在每次渲染都派发
  （`activateFor` 本身对已激活插件是幂等的），并且 3 秒仍未拿到 provider 时
  显示「插件未激活」+ 重试按钮，不再无限等待。
- DEBUG 日志列表的 React key 用「来源 + 时间 + 文本前 40 字」拼接，
  同一毫秒的多条日志或前缀相同的警告会**撞 key**，面板每帧报一次
  "Encountered two children with the same key"，122 次就把日志缓冲洗掉。
  现在每条日志带会话内唯一 id。
- 诊断报告里 `%s` 占位符不再原样保留：console 参数按 `%s/%d/%o/%c` 格式化，
  React 的警告因此能显示出具体 key 与组件栈。
- 设置页的语言图标 SVG 使用了 `stroke-width` / `clip-path`（React 要求
  camelCase），每次打开设置都刷两条警告；顺带修正了英国国旗 `clipPath`
  引用 id（`#a` 与定义的 `f-en-a` 不一致，裁剪一直没生效）。
- **同一插件的两个激活事件并发时会把 `activate()` 执行两次**（打开 `.tex`
  时 `onLanguage` 与 `onView` 几乎同时到达）：视图注册两次、编辑器扩展
  注入两次，表现为行级装饰的 class 重复（`cm-tex-section cm-tex-section`），
  并留下一份无法回收的订阅。现在按插件并发去重，两次调用共享同一个 Promise。
- `align` / `gather` 等数学环境**整块不渲染**：此前剥掉 `\begin{align}`
  只把中间几行交给 KaTeX，而 `&` 是环境级的对齐标记，KaTeX 直接报错
  （`Unexpected alignment tab`），最显眼的那段公式退化成源码。现在把完整
  环境交给 KaTeX，编号 `(1) (2)` 也一并渲染。
- **引用式图片与引用式链接不渲染**（`![logo][img-ref]` / `[文字][ref]`）：
  编辑区的块级渲染是逐块调 markdown-it 的，而 `[img-ref]: https://…`
  通常单独占一行（属于另一个块），逐块渲染时 `env.references` 为空，
  整条图片退化成纯文本。现在先把全文的引用定义喂一次引擎、块之间共享
  同一个 env，并让渲染缓存随定义变化失效。
- **块级渲染内容此前没有任何样式**：`.cm-md-block` 里的 `ul` / `blockquote` /
  `pre` / `table` 由 markdown-it 生成，浏览器默认值直接生效 —— 列表缩进
  40px、引用只有 `1em 40px` 的外边距、代码块没有边框与底色。现在补齐并
  对齐 `website/demo.html` 的数值：列表下边距 12px、项间 5px、引用 3px
  强调色左边框 + 14px 内边距 + 淡化文字、代码块 1px 边框 + 底色 + 内边距 +
  **6px 圆角**，行内代码单独给浅底与小圆角；表格边框与表头底色、分隔线、
  图片 `max-width: 100%` 一并补齐。
- **列表项之间多出一整行、引用竖线比正文长**：`.cm-md-block` 挂在
  `.cm-content` 里，而 CodeMirror 的内容层是 `white-space: pre-wrap`
  （源码要保留换行）。这个值被 widget 内的 HTML 继承，markdown-it 输出中
  元素之间的换行（`</li>\n<li>`、`</p>\n</blockquote>`）于是变成真实换行 ——
  实测 li 高 18px 而项间距 41px，三层嵌套引用的竖线比最后一行长 20px。
  现在块级内容显式 `white-space: normal`，只有 `pre` 保留 `pre`。
- **任务列表按钮点了没反应**：命令里自己写了一个循环，跳过空行、跳过
  已经是任务项的行、处理一行就 return。三者叠加的结果是——空文档上点
  按钮什么都不发生、已存在的任务项无法取消、多行选区只改第一行。
  现在直接复用 `toggleLinePrefix('- [ ] ')`（它本来就负责"剥旧前缀、加新前缀"）。
- **任务复选框可以直接点**：渲染态里的复选框此前是 `<input disabled>`，
  只能看到、点不动，用户必须把光标挪进那一行手打 `x`；未勾选还是浏览器
  默认的灰色（读起来像禁用）。现在 `appearance: none` 自绘（品牌绿细边框 +
  勾选用实心绿 + 白勾），点击按"块内第 N 个复选框 ↔ 源码里第 N 个
  `[ ]`"的映射就地改写三个字符，不必进入源码态。
- 浅色主题的深绿 `#0d7259` 统一换成 `#4aa63d`（`--md-link` / `--md-h2` /
  `--md-syntax-string`）；官网 `--green` 与 demo 页同步。
- `toggleLinePrefix` 剥前缀时不认复选框：把 `- [x] 内容` 转成任务列表
  会拼成 `- [ ] [x] 内容`。现在列表前缀连同 `[ ]` / `[x]` 一起剥掉。
- 回归脚本的 `set_workspace` 桩改为返回工作区描述符；崩溃恢复脚本的
  IndexedDB 打开不再写死版本号、草稿键跟随工作区前缀 —— 否则整套
  `npm run verify` 会因为桩与新契约不匹配而全红。
- 关闭调试面板后不再捕获错误（原注释承诺"关闭后恢复原生 console"，
  实际是启动即装且从不卸载，注释与实现相反）；拦截现在常驻，
  仅在测试中显式卸载。

## [0.1.5] - 2026-10-28

> Consistent with `docs/releases/v0.1.5.md`.

The workspace finally has an exit, and folders you never open can be put away.

### Added

- **Remove a folder from the workspace** — directory rows in the file tree now
  carry a `×` that appears on hover (always visible on touch devices, where
  hover does not exist). Removing hides the folder **and its whole subtree**;
  nothing on disk is touched. The list is persisted per workspace name, and
  `恢复已移除的目录` in the command palette brings everything back — removing
  would otherwise be a one-way street.
- **Close workspace** — the tree gained a header showing the workspace name
  with a close button (the command palette has `关闭工作区` too). Closing also
  clears `workspace.lastId`, so a deliberately closed workspace does not
  reopen on the next launch; tabs are closed along with it, and unsaved tabs
  prompt first.

### Changed

- **MSI is no longer built.** The Windows download has always been the NSIS
  `setup.exe`; the MSI only cost a WiX run per tag. Release assets for Windows
  are now `*_x64-setup.exe` and `*_arm64-setup.exe`.
- **Microsoft Store package added to releases** —
  `Aropyt_<version>_x64_arm64.msixupload`, built by `src-tauri/msix/pack.ps1`
  + `bundle.ps1` from the same bare executables. Tauri has no MSIX target, so
  the package is assembled with `makeappx`: manifest + tiles + exe, then a
  bundle of both architectures, then the upload container. Unsigned on
  purpose — the Store re-signs it, which is what removes the code-signing
  certificate from the release path entirely.

### Fixed

- **File-tree keyboard navigation leaked a listener per click** — the
  `keydown` handler (and `focusedRow`) had been pasted *inside* the directory
  row's click handler. Every click on a directory added another listener, so
  a single `j` could move several rows, and the cursor reset to the top each
  time. Moved back to the mount scope.
- **Collapsing any directory could empty the tree on next launch** —
  `explorer.collapsed` was persisted as `null` to mean "nothing collapsed",
  but `Memento.get` uses `has(key)`, so it returned `null` instead of the
  fallback and `new Set(null)` threw. Now the key is deleted (`undefined`)
  and the read is defensive.

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

[Unreleased]: https://github.com/Geekstrange/Aropyt/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/Geekstrange/Aropyt/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Geekstrange/Aropyt/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Geekstrange/Aropyt/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Geekstrange/Aropyt/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Geekstrange/Aropyt/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Geekstrange/Aropyt/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Geekstrange/Aropyt/compare/v0.0.9...v0.1.0
[0.0.9]: https://github.com/Geekstrange/Aropyt/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/Geekstrange/Aropyt/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/Geekstrange/Aropyt/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/Geekstrange/Aropyt/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/Geekstrange/Aropyt/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/Geekstrange/Aropyt/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/Geekstrange/Aropyt/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/Geekstrange/Aropyt/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/Geekstrange/Aropyt/releases/tag/v0.0.1
