# Aropyt

**Typora 式 Markdown 编辑器 —— 编辑区本身就是预览。**

跨平台（Windows / macOS / Linux / Android）、文件即真理、极致轻量。
浏览器形态仅为开发模式（`npm run dev`），发布形态统一 Tauri 2。

## 特点

### 块级所见即所得（WYSIWYG）

编辑区不是「源码 + 高亮」，而是**渲染本身**：文档按块切分，非光标块整体呈现为
markdown-it 渲染的真实 HTML（真表格布局、真标题排版），光标所在块自动切回源码
供编辑，移开即渲染 —— 与 Typora 相同的交互模型，且**编辑区与预览用的是同一个
渲染引擎**，所见即所得是架构保证，不是近似。

### 完整的 Markdown 渲染

- **代码块语法高亮**：highlight.js，常见语言开箱即用，配色跟随主题
- **数学公式**：`$…$` / `$$…$$` / `\(…\)` / `\[…\]` 四种定界符，KaTeX 排版
  （分数、根号、矩阵、`cases` / `aligned`、`\tag` 编号、`\partial` 等全套语法），
  引擎与字体按需加载，代码块里的 `$` 不会被误判
- **Mermaid 图表**：` ```mermaid ` 代码块直接渲染成 SVG（流程图 / 时序图 / 类图 /
  思维导图…），库按需加载；语法错误会显示具体原因，不静默失败
- **表格**：真实 `<table>` 布局，表头加重、行分隔、对齐
- **HTML 内联**：`<strong>` `<svg>` 等标签直接以真实元素呈现
- **链接 / 转义 / 任务列表 / 引用 / 图片**：全套 GFM 支持，裸 URL 自动链接

### Vim 模式

底部状态栏一键开关，指示器显示当前子模式（`NORMAL` / `INSERT` / `VISUAL`）。

- **normal 模式不误删字符**：`Backspace` / `Delete` 交给 vim，不进插入模式不动文本
- **恒为源码态**：渲染态下整块 Markdown 在 DOM 里只是一个块，行级光标无处可落
  （j/k 会跳过整段文字），所以 vim 模式固定源码态 —— 源码模式按钮隐藏、`Ctrl+/`
  不响应，退出 vim 自动回到渲染态
- **不吞宿主快捷键**：`Ctrl+Shift+B` / `Ctrl+Shift+N` / `Ctrl+Tab` / `Ctrl+0`
  在 vim 下照常可用；`Ctrl+B`（翻页）、`Ctrl+N`（插入补全）留给 vim
- **禁用鼠标选择**：vim 下单击定位光标可用，拖选/Shift 扩选被拦

### 设置与配置文件

- **设置面板**：工具栏齿轮入口，外观（浅色 / 深色 / 跟随系统）、编辑（Vim 开关）、配置文件
- **`~/.aropyt/settings.jsonc`**：用户配置的真源，JSONC 格式（可写注释）
  ```jsonc
  {
    "theme": "auto",           // light | dark | auto
    "editor": { "fontSize": 15 },
    "vim": { "enabled": false },
    "sidebar": { "open": true },
    "plugins": { "disabled": [] },
    "history": { "limit": 50 } // 编辑历史（v0.0.6）预留
  }
  ```
- 界面里的修改**立即写回文件**；手改文件重启后生效；非法值会提示而不是静默忽略
- 首次启动自动从旧的浏览器存储迁移（只做一次）

### 插件系统

VSCode 式声明式贡献 + 懒激活：大纲、文件树、格式化是内置插件；内核只保留
编辑器、文档模型与渲染管线。

- **可管理**：工具栏插件图标查看已导入插件，可启用/禁用（禁用立即生效并记住）
- **可导入**：选一个 `.js` 插件文件（导出 `manifest` + `activate`）即可扩展命令、
  工具栏按钮、视图、键位；示例见 `test/sample-plugin.js`
- 插件在渲染进程内运行（与 VS Code 插件同一信任模型），只导入可信插件

### 快捷键

| 快捷键 | 行为 |
| --- | --- |
| `Ctrl/Cmd + Shift + B` | 开关侧栏（状态会被记住） |
| `Ctrl/Cmd + Shift + N` | 新建标签 |
| `Ctrl/Cmd + Tab` | 切换标签（`+Shift` 反向） |
| `Ctrl/Cmd + 0` | 聚焦侧栏 |
| `Ctrl/Cmd + S` | 保存 |
| `Ctrl/Cmd + F` | 查找 / 替换 |
| `Ctrl/Cmd + /` | 源码 / 渲染模式切换（vim 模式下不生效） |
| 鼠标中键点标签 | 关闭标签 |

### 轻量与性能

- 首屏 ≤ 320 KB（gzip），markdown-it / highlight.js / mermaid / KaTeX 全部按需加载
- CodeMirror 6 视口虚拟化，长文档滚动零成本
- 装饰冻结：输入法（IME）组合期间不重算渲染，中文输入零干扰
- 帧预算监控：主线程卡顿可观测、可归因

### 安全与稳定

- **未保存确认**：关闭标签、关闭窗口前拦截确认（保存 / 不保存 / 取消）
- **草稿自动保存**：编辑内容持续落盘（IndexedDB），崩溃或异常退出后自动恢复
- 文档内容视为不可信输入，渲染管线与代码高亮在隔离环境执行

### 文件即真理

文档始终是磁盘上的纯 Markdown 源码。渲染只改变「怎么画」，复制粘贴出来
的永远是源码 —— 不锁定、不私有格式、可版本控制。

## 构建与运行

```bash
npm install
npm run dev              # 浏览器开发模式
npm run tauri dev        # 桌面开发模式
npm run tauri build      # 发布构建（唯一正确的打包方式）
npm run verify           # 全量验证（编译 + 行为闸门）
```

> ⚠️ 打包请用 `npm run tauri build`。`cargo build --release` 只编译 Rust，
> 前端资源的嵌入由 tauri CLI 负责 —— 手工组合会得到「源码改了、exe 还是旧行为」
> 的假象。

## 平台说明

- **Windows**：本仓库当前构建环境，直接 `npm run tauri build`
- **macOS / Linux / Android**：Tauri 2 多平台统一外壳，需在对应平台（或 CI）
  构建；Linux 依赖 WebKitGTK（详见 Tauri 官方文档）

## 许可证

AGPL-3.0
