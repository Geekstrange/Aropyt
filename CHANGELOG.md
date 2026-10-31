# Changelog

本项目的版本变更记录，格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

单版本的发布公告（GitHub Release 正文）在 `docs/releases/<tag>.md`，
这里保留所有版本的累积视图。

## [Unreleased]

### Fixed

- **按退格会删掉整个块**：块在渲染态是一个**整体替换区间**，区间内部放不了
  光标 —— 光标紧贴块边界（尤其是块尾换行那一格）时，`Backspace` / `Delete`
  会把整块当成一个字符删掉。用户看到的是"点一下、按退格，整块没了"，
  ToDo 列表最显眼，但段落、标题、代码块同样存在。
  现在判定从"光标所在行落在块内"改为 `head ∈ [from-1, to+1]`：紧贴边界
  时块切回源码，删的就只是普通字符。`to` 侧特意放宽一格 —— 块节点的
  `to` 包含尾部换行，用户在"块后空行行首"按退格时 `head` 正好等于 `to`，
  删的却是块里的内容（实测正是这一格导致整列表消失）。
  代价：光标停在块后空行的行首时，上一个块会以源码形式显示 —— 那是
  "退格会命中它"的位置，显形是必要的。

- **切换文档后按 Ctrl+Z 会退回上一个文档**：`replaceDocument` 用一次
  `dispatch` 整篇替换，而这一步本身进了撤销历史 —— 在 B 文档里按 Ctrl+Z
  撤销的正是"把 A 换成 B"，于是内容变回 **A**、标签却还是 B；一直按会
  一路退回之前打开过的每一个文档。现在这次替换带两个注解：
  `isolateHistory.of('before')` 在替换**之前**插一个历史边界（旧文档的
  编辑记录不会再作用到新文档上），`Transaction.addToHistory.of(false)`
  让替换本身不入栈。文档**内部**的撤销不受影响（实测：输入后 Ctrl+Z
  正常回退，再按一次停在本文档原文，不会跳回旧文档）。

- **文件树的键盘操作不可靠，而且会留下一个高亮框**：三个问题叠在一起 ——
  1）键盘导航（`j`/`k`、↑↓、Enter）只认 `focusedRow`，而它原来仅在
     鼠标点击 / 键盘移动时赋值。用 Tab 或程序聚焦进树时它是 `null`，
     ↑↓ 从第 0 行重来、Enter 落到同一个文件 —— 表现为"用 Enter 打开一个
     之后就打不开第二个了"；
  2）打开文件会 `refresh()` 重建整棵树，旧节点被移除、焦点回到 `<body>`，
     之后 `keydown` 到不了 `.explorer-tree`，整段键盘通路失效；
  3）`--focused` 原来画的是 outline 框，而且焦点离开后框还挂着 ——
     打开文件后列表里一直吊着一个框，看起来像"这一行被选中了"。
  现在：`focusin` 覆盖所有聚焦入口（Tab / 点击 / 程序），点行即选中；
  刷新后按 `data-path` 找回键盘光标，并在"刷新前焦点本来就在树里"时把
  焦点还给容器（否则打开文件会把焦点从编辑器抢走）；Enter 在没有光标行
  时兜底到第一行；光标指示改成**左侧 2px 竖条 + 淡背景**并用
  `:focus-within` 限定 —— 焦点不在树里就不显示。
  焦点恢复的落点也从"容器"改成"具体那一行"：还到容器上时，按 `Tab`
  会从容器内第一个可聚焦元素重来（"打开文件后继续用 Tab 总是从第一个
  开始"），落回原行才会接着往下走。

### Removed

- **`Icons.tsx` 里的手绘图标全部删除**：`UI_ICONS` 那 7 个（`menu` / `close` /
  `eye` / `code` / `sun` / `moon` / `autoTheme`）在源码里**零引用** ——
  对应的按钮后来要么改用文字，要么切到了 `icon/*.svg` 生成的那一套。
  现在图标只有一个来源（`icon/` + `scripts/make-toolbar-icons.mjs`），
  不会再有"两套坐标系各画一份"的局面；未知图标名仍渲染**同尺寸空 span**
  （按钮宽度与对齐依赖这个占位），兜底从手绘的 `code` 换成生成物里的
  `defaultPlugin`。
- `check:icons` 同步：删掉两条基于 `UI_ICONS` 的断言（解析手绘集合、
  兜底项存在），"白贴"检查新增显式 `PENDING_ICONS` 名单 —— `export` 与
  四个文件类型图标尚未接线，登记在这一处，而不是让闸门长期红着被无视。

### Fixed

- **`.tex` 文档导出只剩一行文件名**：`export_document` 把读入格式写死成
  `markdown`，于是 LaTeX 源码里的 `\documentclass` / `\section` / `\begin{}`
  全被当成普通文字吞掉 —— 实测 `test/basic-test.tex`（66 行）导出成 PDF
  只剩一行 `% basic-test.tex`。现在新增 `source` 参数（`--from` 白名单：
  `markdown` / `latex`），前端按扩展名传：`.tex` / `.latex` / `.ltx` →
  `latex`，其余 → `markdown`。
  顺带修好随之暴露的第二个坑：LaTeX 的 `\ref{}` 会被 pandoc 转成 typst 的
  `@sec:…` 交叉引用，而 typst 要求被引用的标题**有编号**，否则直接报
  `cannot reference heading without numbering`。latex 源现在带
  `--number-sections`（LaTeX 文档本来默认就编号）。
  同一份文件实测：markdown 读入 → 7984 字节（一行）；latex 读入 + 编号
  → **56788 字节**（内容完整）。
- **PDF 导出报 `path contains invalid component "C:"`**：`--pdf-engine` 传的是
  **绝对路径**（设置里指定了 `C:\Opt\typst.exe`，它不在 PATH 上）。pandoc 用
  `\\?\` 长路径前缀调起引擎，typst 因此把它**自己下载的图片缓存**
  （`C:\…\Temp\media-…\<sha1>.png`）当成**相对路径**解析，直接失败。
  同一台机器、同一个 typst 0.15.1 实测：`--pdf-engine typst`（名字）→ 成功，
  `--pdf-engine=C:\Opt\typst.exe`（绝对路径）→ 必炸，报错逐字一致。
  **与中文无关**：中文 PDF 实测 11KB、嵌入中文字体、退出码 0；docx / html /
  rtf 也都不受影响 —— 只有 PDF 有引擎调用这一步。
  也解释了"全英就能成功"：那份文档里没有图，typst 不会去加载缓存路径。
  现在把引擎所在目录 **prepend 进子进程 PATH、只传名字**（prepend 而非
  append：用户显式指定的那份应该优先）。另加一层防御：PDF 导出前把
  `](C:/…)` / `](D:\…)` 改写成 `](file:///C:/…)`（反斜杠一并转正斜杠），
  覆盖"文档里写死本地绝对路径"的情况 —— 只对 PDF 生效，因为 docx / html
  里塞 `file:///` 链接，发给别人打不开，反而更糟。
- **RTF 导出中文乱码**：`export_document` 没传 `--standalone`，pandoc 输出的是
  **片段**而不是完整文档 —— RTF 以 `{\pard …}` 开头、没有 `{\rtf1\ansi…}`
  文件头（实测：416 字节 vs 加 `-s` 后的 862 字节），任何 RTF 阅读器都会
  把它当纯文本打开，于是 `\u20013 ?` 这类 Unicode 转义原样显示，看起来就是
  乱码。**中文本身不是原因**：`\uN?` 正是 RTF 表示非 ASCII 字符的正确写法。
  现在统一加 `--standalone`，HTML 一并受益（此前缺 `<!DOCTYPE>` 与
  `<meta charset>`）；docx / epub 是容器格式，加不加无差别。
- **导出图标缺了一半**：`icon/export.svg` 是「一个 `<path>` + 一个
  `<polygon>`」（箭头的三角形用 polygon 画），而图标生成器只提取
  `<path>` —— 生成出来的图标只剩信封轮廓、没有箭头。
  生成器现在同时提取 `<polygon>`，`export` 的产物变成 path + polygon 两个图形。

### Changed

- **导出按钮挪到保存右边**：原先硬编码在工具栏右侧（`toolbar-spacer` 之后），
  现在改由 `aropyt.file` 插件贡献（`aropyt.file.export`，group `1`、
  order `4`），位置紧跟「保存」。实现仍在宿主（`aropyt.export.run`）——
  插件拿不到原生通道，调不了 pandoc。这样"挨着保存"由菜单的
  group/order 决定，而不是靠 JSX 里的摆放顺序。
- **状态栏字数统计统一走 `countStats`**：原来 `App.tsx` 自己写了一遍正则
  （"词"只算英文、"字"只算中文），与 core 的口径不同 —— 同一份文档会在
  两个地方得到两个数字。现在统一成：词 = 西文词 + 中日文字数，
  字 = 非空白字符数（与 Typora 一致）。**数字会与旧版不同**。
- `countStats` 从 `markdown.ts` 挪到新的 `text-stats.ts` 并从包根入口导出：
  `markdown.ts` 刻意不进首屏预算（带 markdown-it + highlight.js），
  而状态栏每次重渲染都要算字数。
- `safeJsonParse` 接上了两处裸 `JSON.parse`（视图折叠状态、旧版插件禁用
  名单）：它们本来就是"解析失败就当没写过"，靠外层 try 兜着；
  现在把意图写进函数名。

### Removed

- **`commands.ts` 里 15 个旧编辑命令**：`toggleBold` / `toggleHeading` /
  `toggleItalic` / `toggleTaskList` / `insertLink` / `insertTable` /
  `indentSelection` … 每个都在自己的实现里直接 dispatch 事务。插件早已
  统一走 `EditorApi.wrapSelection` / `toggleLinePrefix` / `replaceSelection`
  （有守卫、能归因到插件、覆盖同样的行为），这些函数于是全部零引用。
  只留 `toggleLinePrefix` 与 `toggleWrap` —— `EditorApi` 正是拿它们实现的。
  文件从 216 行降到 116 行。

### Added

- **全局兜底守卫接到启动流程**（`installGlobalGuards`，`observeOnly`）：
  只记录、不拦截 —— 未捕获异常归入失败计数并留一条 `uncaught` 轨迹。
  它与 `installDebugLog` 分工不同：后者记"发生了什么"（明细进面板），
  前者记"我们没预料到的事发生了"（计数 + 轨迹）。
- **空闲预热 katex / mermaid**：首次插入公式或图表时不必再等一次动态
  import；用 `onIdle` 而不是启动即加载，避免和"打开第一个文件"抢带宽。
- 诊断报告新增「失败动作」段：失败项本来混在 30 条轨迹里要一行行扫，
  单独提出来让维护者第一眼看到是哪一步炸的；调试面板的「清空」连带
  清空轨迹（只清日志会留下上一轮的记录）。

### Planned

- 编辑历史的版本间 diff（v0.1.2 已完成单版本对比，尚缺版本间对比）
- 工具栏在触屏上的点按目标（当前约 26px，低于 44px 建议值）
- 文件导出（docx / html / epub）：首选 pandoc，PDF 需另配 typst 之类引擎

## [0.1.7] - 2026-10-30

> 发布公告见 `docs/releases/v0.1.7.md`。

### Added

- **文件导出（docx / pdf / html / odt / epub / rtf）**：工具栏「导出…」
  （就在「保存」右边）→ 选格式 → 选位置，转换由 **pandoc** 完成。内容经
  **stdin** 传入（不落临时文件，也就没有路径转义与清理问题），
  `--resource-path` 指向工作区根 —— 否则 `![](assets/a.png)` 在 docx 里
  全是断图。失败时把 pandoc 的 **stderr 原样**带出来（缺图、fenced div
  未闭合这类问题只有它说得清），并对 120 秒超时兜底。
  **PDF 走 typst**（`--pdf-engine=typst`）：单文件约 30MB，比 TeX Live
  轻两个数量级。**引擎由用户自行安装，不随应用打包**（产品决策）；
  缺 typst 时只有 PDF 不可用、其它格式照常，且在选择保存路径**之前**
  就拦下 —— 否则用户选完位置、等几秒才被告知缺引擎，磁盘上还会留个空文件。
  **不含** MediaWiki / reST / OPML：它们是"特定下游系统的交换格式"，
  不是给人读的文档（wiki 大多直接吃 markdown），却要在菜单里占三个位置。
- **pandoc / typst 路径可在设置里手动指定**：设置页新增「导出工具」一节，
  两个「浏览…」按钮直接选可执行文件，旁边实时显示探测到的版本；路径留空
  则自动查 PATH 与常见安装位置（Program Files、LocalAppData、cargo bin、
  homebrew、/usr/local/bin）。改完路径**立刻重探**，不需要重启。
  探测逻辑泛化为 `resolve_tool`（pandoc / typst 共用）。
- **`Ctrl/Cmd+Shift+O` 打开工作区**：与工具栏「打开文件夹」走同一个命令
  （`aropyt.file.pickWorkspace`），并经 `runCommand` 复用那层"把真实错误
  带出来"的处理 —— 选目录失败时用户能看到原因，而不是静默无反应。
- **工具栏可整体隐藏**：`Ctrl/Cmd+Shift+H` 切换，或设置页「显示工具栏」开关。
  隐藏后工具栏上的全部按钮（打开文件、主题、源码模式…）一并消失，
  `.app-main` 是纵向 flex，编辑区自动顶到标签栏下沿（实测 +35px，无空位）。
  状态存进 `settings.toolbar.open`，重启保持。
  恢复入口**只有两个**：这个快捷键与设置页开关 —— 工具栏自己没了，
  别再顺手删掉其中一个。
- **围栏块点击就地编辑（代码块与 mermaid）**：渲染态里点一下代码块或图表，
  它自己变成编辑框（预填源码、自动全选）。**失焦即提交**，`Esc` 放弃，
  `Ctrl/Cmd+Enter` 也可提交，`Tab` 插入两个空格。没有确定/取消按钮 ——
  点走就是接受，不必先扫过一排按钮；内容没改动时不会产生空的撤销步。
  原来的交互是"点一下整块变回源码"：为了改一行要先看满屏的反引号与
  fence 语言标记。插入符落在**文末**而不是全选 —— 全选意味着"点一下、
  敲第一个字符，原有内容整段消失"。
- **mermaid 编辑时带实时预览**：编辑区比代码块更高（9 行起）并撑满宽度，
  下方一块预览区随输入更新（260ms 防抖）。渲染串行化 + 序号丢弃过期结果，
  快速输入时不会被先返回的旧图覆盖；语法错误直接把 mermaid 的报错显示在
  预览区，而不是留一块空白。
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
- 徽章尺寸：组件的 `size` 只认 `large` / `small`，没有"中号"——`large` 在
  内部样式里硬编码 `img { height: 104px }`（首屏里过大），`small` 又不带
  尺寸规则、素材本身偏小（想放到 48px 得靠放大，位图放大会糊）。
  现在**保留 `size="large"`**（素材是最大份的），只用
  `ms-store-badge::part(img) { height: 48px }` 把高度压到与原来的静态图
  同高 —— 缩小永远比放大清晰，48px 也是商店指南建议的可读尺寸。

- **LaTeX 渲染态点击后插入符跳到下一行**：两个原因叠加。一是
  `.cm-tex-table` / `.cm-tex-pagebreak` 这类 block widget 用 `margin`
  表达间距，而 CM6 用 `offsetHeight` 测量 widget 高度（不含 margin）——
  实际布局比高度图高，之后每一行的点击坐标都往下偏一行。二是 KaTeX
  异步渲染完成后没有通知 CM6 重测：公式块从"一行源码占位"变成多行排版
  结果，同样造成累积偏移。现在 widget 间距一律用 padding 表达，KaTeX
  填充后调用 `view.requestMeasure()`。
- **段落内的换行不生效**：markdown-it 默认 `breaks: false` —— 只有行尾
  两个空格或反斜杠才算硬换行。实测示例文档 `test/basic.md` 里写着"这一行
  末尾有两个空格，应当渲染为软换行"的那行，磁盘上一个空格都没有（字符码
  确认末尾直接是 `。`）：行尾空格在保存、`git commit`、复制粘贴时太容易
  被 trim。现在改为 `breaks: true`：段落内单个换行即渲染为 `<br>`，
  与 GitHub issue 正文一致；列表项内的续行同样生效。
- **GitHub 警告块此前只是"GitHub 风味"**：整块铺着淡底色，竖线用的是通用
  引用色而不是类型色，正文还被引用块规则淡化。原因是 `.markdown-alert`
  自己声明了 `background`，而 CM6 baseTheme 编译出的
  `.ͼ1 .cm-md-block blockquote`（0,2,1）压过了
  `.cm-md-block .markdown-alert`（0,2,0），把类型色换成 `--md-border-strong`
  又把正文染成 `--md-muted` —— 同一批属性在两处各写一份，谁赢只取决于
  生成顺序。现在删掉 baseTheme 里的 blockquote 声明（样式只在 styles.css
  定义一处），警告块去掉底色，竖线与标题按类型着色，正文保持正常文字色。
- 引用与警告块的颜色、竖线宽度改为可独立调节的令牌，且**深浅主题共用**：
  `--quote-border`（引用竖线，中性浅灰 `#dfe2e5`）、`--alert-note` /
  `--alert-tip` / `--alert-important` / `--alert-warning` / `--alert-caution`
  （取 GitHub 亮色主题的实际值），宽度是 `--quote-width` / `--alert-width`。
  此前它们借用 `--md-h1` / `--md-link` / `--md-h3` / `--md-h5` / `--md-danger`
  / `--md-accent` —— 那些是文档语义色，全项目 60+ 处在用，调一处会连带改标题、
  链接与焦点环。
  ⚠️ 两个主题块（`:root[data-theme='light']` 与 `[data-theme='dark']`）里
  要**各写一份、值保持一致**：只写在浅色那处时，深色主题下这些变量整体
  消失，`border-left: var(--alert-width) solid …` 整条失效、竖线不见
  （实测深色下宽度变 0）。
- **警告块竖线宽度调不动**：规则里写的是字面量
  `border-left: 3px solid var(--alert-color)`，`--alert-width` 从未被引用 ——
  改 3.5px、8px 都没有任何反应。现在改成 `var(--alert-width)`，与普通引用的
  `var(--quote-width)` 对称。另注：`border-width` 会被 UA 取整到整数设备
  像素，1x 屏上 `3.5px` 实际渲染为 `3px`，调粗细请用整数。
- **单独打开的文件关不掉**：标签上的 `×` 调 `closeTab(path)` 时省略了
  `workspaceId`，而 `closeTab` 在找不到就退回"当前激活工作区"来查 ——
  外部文件的 `workspaceId` 是 `null`，永远匹配不上，只能靠中键关闭
  （中键那条调用传了 `workspaceId`，所以有效）。现在 `×` 带上标签自己的
  `workspaceId`；`activateTab` / `closeTab` / `findTab` 的 `workspaceId`
  一律从**可选改成必填**（可选时漏传不报错、只表现为"点了没反应"），
  由编译器保证每个调用点传全；`closeTab` 另保留"路径在标签里唯一就直接关"
  的运行期兜底，同名文件开在两个项目里时不猜。
  顺带修好：单独打开的文件**标签不高亮**（渲染层自己重算了一份
  `path + workspaceId` 判定，与 runtime 分叉了）。判定统一收敛到
  `runtime.isTabActive()`；vim 的 `:q` / `:wq` 也改为按激活标签关。
- **打开单个文件不再把它的目录变成工作区**：打开一个文件只是"读这个文件"，
  顺手把父目录注册成项目，会让文件树突然多出一堆用户没要求打开的兄弟
  文件，这个目录还会写进 `workspace.roots`、下次启动自动恢复。现在文件
  以**外部文件**身份打开（`workspaceId: null`，标签不带工作区色条），
  保存走 `write_external_file` 写回原位置；想让某个目录成为工作区，
  用「打开文件夹」。
- 顺带修好：已经打开过工作区时，"打开文件"加入的标签**不会被激活**
  （`activateTab` 少了显式的 `null`，按当前激活工作区去查，永远找不到
  这个不属于任何项目的新标签）。
- 外部文件的保存此前**没有任何成功反馈**：那条分支只处理失败提示，而
  "打开单个文件"现在固定走它，于是每次 `Ctrl+S` 都像"点了没反应"。
  现在与工作区文件一致地显示已保存。
- **输入中文时整个编辑区卡死**：诊断报告里的第一条错误是根因 ——
  `RangeError: Decorations that replace line breaks may not be specified
  via plugins`。它的上游是 ViewPlugin `update` 里那句
  `if (update.view.composing) return`：IME 组合期间文档在变，装饰却被
  冻结在旧坐标系上，CM6 拿它们切 tile 时位置越界或跨了换行 —— 抛错之后
  tile 索引全乱，之后每一次测量、点击、滚动都报 `TilePointer.advance` /
  `No tile at position <n>`，编辑区彻底不动（报告里剩下十几条全是连锁）。
  现在文档一变就先把已有装饰 `map` 到新坐标（只改位置、不动 DOM，不会
  打断候选词），映射后仍非法（越界 / 跨行 replace）的单项丢弃并记一条
  warn；组合结束后照常完整重建。装饰构建完也统一过一遍同样的合法性检查。
  复现与回归都用 CDP 的 `Input.imeSetComposition`：两行任务列表、在行内
  敲第二个组合字符，修复前必抛 RangeError，修复后零错误。
- **任务列表可能渲染成「☐ ] 未完」**：复选框的替换范围直接取了 lezer
  `TaskMarker` 节点的 `from`/`to`，而该边界在某些输入状态下会落在 `]`
  之前 —— `[ ` 被替换、`]` 孤零零留在行首。现在按行内文本定位：只认
  "节点起点附近一格内的 `[`，且恰好隔一个字符就是 `]`"，形状对不上就
  整行保持源码，绝不做半截替换（错位比不渲染更难解释）。

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

[Unreleased]: https://github.com/Geekstrange/Aropyt/compare/v0.1.7...HEAD
[0.1.7]: https://github.com/Geekstrange/Aropyt/compare/v0.1.6...v0.1.7
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
