/**
 * 运行时 API —— 插件作者唯一能拿到的东西。
 *
 * 第三条哲学：能力受限（capability-restricted）。
 *
 *   VS Code 给插件的是 Node 进程和一份 proxied API；我们给的是这个对象。
 *   两者的共同点是 —— 插件【拿不到内部实现】。
 *
 * 具体到编辑器：这里【没有】 EditorView，没有 EditorState，没有 state.doc。
 * 插件只能做语义操作："把选中的这段围起来"，而不是"在偏移量 42 插入两个星号"。
 *
 * 为什么这个约束值得付出代价：一旦 `editor` 暴露真实实例，就等于
 * 把内核的内部结构冻结成公开契约。改一次内核 = 所有插件全挂。
 * VS Code 能十年不换 Monaco 的对外形态，就是因为插件从来看不见 Monaco。
 *
 * 唯一的例外是 registerExtension()。CodeMirror 的 Extension 本身就是
 * 声明式、可组合、无法直接篡改状态的 —— 它是少见的"既强大又安全"的扩展点，
 * 所以值得开这个口子，代价是这一处需要版本锁定。
 */

import type {
  CapabilityName,
  ConfigurationContribution,
  ViewContribution,
} from './manifest.js';

export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (e: T) => void) => Disposable;

/**
 * 宿主操作系统。
 *
 * 这里刻意**不**包含"外壳技术"（Tauri / 浏览器）。外壳是打包方式，
 * 操作系统才是插件真正需要判断的东西 —— 一个"是否显示托盘图标"的插件
 * 该问的是"我在 Windows 上吗"，而不是"我跑在 Tauri 里吗"。
 *
 * 早期版本把 `tauri` / `web-desktop` / `web-android` 混在一个枚举里，
 * 结果是插件无法表达"我在任何桌面系统上都要这个功能"——
 * 它只能逐个枚举外壳，而每加一种打包方式就要改所有插件。
 *
 * 不做浏览器 standalone 形态，所以没有 `web-other`。
 */
export type PlatformKind = 'windows' | 'macos' | 'linux' | 'android';

/**
 * 外壳类型 —— 即"代码是怎么被打包和运行的"。
 *
 * 与 PlatformKind 正交：Tauri 应用在四个操作系统上都跑，
 * 但只有 Tauri 外壳才有原生文件系统、托盘、全局快捷键。
 * 浏览器形态保留为**开发模式**（npm run dev 直接调试，无需 Rust 工具链），
 * 但不再是发布目标。
 */
export type ShellKind = 'tauri' | 'browser';

/** 当前平台的能力快照。键一定存在，值表示是否可用。 */
export type CapabilitySnapshot = Readonly<Record<CapabilityName, boolean>>;

// ─────────────────────────────── 命令 ───────────────────────────────

export interface CommandDescriptor {
  readonly id: string;
  readonly title: string;
  /** i18n key；有值时渲染层用它取当前语言标题。 */
  readonly titleKey?: string;
  readonly category?: string;
  readonly keybinding?: string;
  readonly source: 'builtin' | 'plugin';
  readonly pluginId?: string;
}

export interface CommandsApi {
  register(id: string, handler: (...args: unknown[]) => unknown): Disposable;
  execute<T = unknown>(id: string, ...args: unknown[]): Promise<T>;
  getAll(): readonly CommandDescriptor[];
  readonly onDidRegisterCommand: Event<CommandDescriptor>;
}

// ───────────────────────────── 编辑器 ─────────────────────────────

export interface SelectionInfo {
  readonly text: string;
  readonly anchor: number;
  readonly head: number;
  readonly startLine: number;
  readonly endLine: number;
}

export interface DocumentChangeEvent {
  readonly path: string;
  readonly text: string;
  readonly version: number;
}

export interface EditorExtensionEnv {
  readonly platform: PlatformKind;
  readonly capabilities: CapabilitySnapshot;
}

/**
 * 当前文档。
 *
 * 参照 VS Code 的 TextDocument：保存是文档自己的行为，不是编辑器实例的行为，
 * 也不是"某个内置插件的特殊能力"。
 *
 * 宿主实现要保证 save() 的原子性：
 *   桌面壳 → 写临时文件 → fsync → rename / ReplaceFileW
 *   Web 端 → File System Access 的 createWritable 提交语义
 * 两者都保证"断电时磁盘上要么是完整旧内容、要么是完整新内容"。
 */
export interface DocumentRef {
  /** 工作区内的相对路径。未落盘的新文档为 null。 */
  readonly path: string | null;
  readonly isDirty: boolean;
  getText(): string;
  save(): Promise<void>;
}

export interface EditorApi {
  readonly activeFile: string | null;
  readonly activeLanguage: string | null;
  /**
   * 当前是否处于源码模式。
   *
   * 渲染类扩展必须据此让路：源码模式的语义是"看到原始标记"，
   * 插件这时再替换/隐藏字符，等于把用户明确要求的源码视图又盖住。
   */
  readonly sourceMode: boolean;
  /** 当前文档。宿主在打开文件后 bindDocument。 */
  readonly activeDocument: DocumentRef | null;

  readonly onDidChangeActiveFile: Event<{ readonly path: string | null; readonly language: string | null }>;
  readonly onDidChangeDocument: Event<DocumentChangeEvent>;
  readonly onDidSaveDocument: Event<{ readonly path: string }>;

  getText(): string;
  getLine(lineNumber: number): string | null;
  getSelection(): SelectionInfo | null;

  insertText(text: string): void;
  replaceSelection(text: string): void;
  replaceDocument(text: string): void;

  /** 语义化包裹。插件说"围起来"，核心决定怎么改文档、怎么回填选区。 */
  wrapSelection(prefix: string, suffix?: string): void;

  /** 按行切换前缀。返回是否真的产生了改动 —— 便于插件做状态反馈。 */
  toggleLinePrefix(prefix: string | ((index: number) => string)): boolean;

  /** 跳转到某一行。大纲、搜索结果、错误定位都靠它。 */
  revealLine(lineNumber: number): void;

  /**
   * 打开工作区中的一个文档。
   *
   * 和 save() 一样，这是文档级操作而非编辑器操作 —— 文件树、大纲、搜索结果
   * 点击全都要用它，所以它必须在 API 里，不能是某个内置插件的私有能力。
   * 宿主负责读取内容、做崩溃恢复、设置当前文件。
   */
  /**
   * 打开文档。
   *
   * `preview` 为 true 时开在**预览标签**里（斜体、会被下一次预览打开替换）——
   * 对应"在文件树里单击"。默认 false 表示这是用户的明确选择，不该被顶掉。
   */
  openDocument(path: string, options?: { readonly preview?: boolean }): Promise<void>;

  /**
   * 逃生舱：注入原生 CodeMirror Extension。
   * 内核唯一允许插件触碰编辑器内部的地方。返回的 Disposable 会随插件卸载自动回收。
   */
  registerExtension(factory: (env: EditorExtensionEnv) => unknown): Disposable;
}

// ───────────────────────────── 工作区 ─────────────────────────────

export type FileKind = 'file' | 'directory';
export type FileChangeType = 'created' | 'changed' | 'deleted';

export interface FileStat {
  readonly path: string;
  readonly kind: FileKind;
  readonly size: number;
  readonly mtime: number;
}

export interface FileChangeEvent {
  readonly path: string;
  readonly type: FileChangeType;
}

export interface ConfigurationApi {
  get<T>(key: string, fallback: T): T;
  has(key: string): boolean;
  update(key: string, value: unknown, target?: 'global' | 'workspace'): Promise<void>;
  readonly onDidChange: Event<{ readonly key: string; readonly value: unknown }>;
  /** 插件声明自己的配置项。核心负责渲染设置页、做类型校验、持久化。 */
  register(schema: ConfigurationContribution): Disposable;
}

/**
 * 工作区的文件操作契约。
 *
 * 定义在插件 API 里而不是能力层，是因为它同时被两端需要：
 * 插件通过 WorkspaceApi 使用它，宿主通过实现它来对接各平台。
 * 放在任何一侧都会让另一侧依赖它 —— 依赖方向必须单一。
 */
export interface WorkspaceFileStat {
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'directory';
  readonly size: number;
  readonly mtime: number;
}

export interface WorkspaceFileHandle {
  readonly id: string;
  readonly name: string;
  readonly providerId: string;
  stat(path: string): Promise<WorkspaceFileStat>;
  list(dirPath: string): Promise<readonly WorkspaceFileStat[]>;
  read(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  write(path: string, content: string): Promise<void>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  createDirectory(path: string): Promise<void>;
  remove(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
}

export interface WorkspaceApi {
  readonly rootPath: string | null;
  readonly name: string | null;
  /** 当前工作区由哪个适配器提供：`fsa` / `opfs` / `tauri`。 */
  readonly providerId: string;

  readonly onDidChangeWorkspace: Event<{ readonly rootPath: string | null }>;
  readonly onDidChangeFile: Event<readonly FileChangeEvent[]>;

  stat(path: string): Promise<WorkspaceFileStat>;
  list(dirPath: string): Promise<readonly WorkspaceFileStat[]>;
  readFile(path: string): Promise<string>;
  readFileBytes(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  writeFileBytes(path: string, data: Uint8Array): Promise<void>;
  createDirectory(path: string): Promise<void>;
  delete(path: string, options?: { readonly recursive?: boolean }): Promise<void>;

  /** 解析相对路径。webdev 场景下 `../assets/x.png` 必须相对文档位置解析。 */
  resolvePath(path: string, relativeTo?: string): string;

  readonly configuration: ConfigurationApi;
}

// ────────────────────────── 窗口与界面 ──────────────────────────

export type MessageLevel = 'info' | 'warning' | 'error';

/**
 * 提示条上的一个动作按钮。
 *
 * 这是"提示"与"选择"之间的缺口补丁：有些提示只有配上"要不要这么做"
 * 才有意义 —— 比如恢复了未保存的内容之后问"要不要丢弃"。
 * 没有它，用户就只剩一个选择：点掉提示，然后自己想办法收拾。
 */
export interface MessageAction {
  readonly label: string;
  /** 用户点击时执行。提示会先关闭，再调用它。 */
  readonly run: () => void;
}

export interface MessageOptions {
  readonly level?: MessageLevel;
  readonly actions?: readonly MessageAction[];
  readonly detail?: string;
}

export interface QuickPickItem {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly icon?: string;
  readonly value?: unknown;
}

export interface QuickPickOptions {
  readonly title?: string;
  readonly placeholder?: string;
  readonly matchOnDescription?: boolean;
}

export interface InputBoxOptions {
  readonly prompt?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly password?: boolean;
  /** 返回字符串表示校验失败的原因，返回 undefined 表示通过。 */
  readonly validate?: (value: string) => string | undefined;
}

export interface StatusBarItem {
  text: string;
  tooltip?: string;
  icon?: string;
  /** 点击时执行的命令 id。 */
  command?: string;
  order: number;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface ViewContext {
  readonly viewId: string;
  readonly capabilities: CapabilitySnapshot;
  readonly configuration: ConfigurationApi;
  executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T>;
  /** 容器尺寸变化时通知插件 —— 移动端横竖屏切换会用到。 */
  readonly onDidResize: Event<{ readonly width: number; readonly height: number }>;
}

/**
 * 视图提供者，两种形态：
 *
 * - 只实现 `data()`：核心把数据渲染成列表 / 树。首选 —— 天然跨平台，
 *   移动端能自动换成触摸友好的形态，可访问性也由核心保证。
 * - 实现 `render()`：核心给一个受控的 DOM 容器。插件的 DOM 出不去这个容器，
 *   拿不到宿主窗口，样式也已被隔离。这是"自定义"与"安全"之间的折中。
 */
export interface ViewProvider {
  data?(): Promise<readonly unknown[]>;
  render?(container: HTMLElement, context: ViewContext): Disposable;
}

export interface SaveAsOptions {
  readonly suggestedName: string;
  readonly content: string | Uint8Array;
  readonly mimeType?: string;
}

export interface ImportedFile {
  /** 工作区内的相对路径，如 `assets/photo.png`。 */
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
}

export interface WindowApi {
  showMessage(message: string, options?: MessageOptions): Promise<string | undefined>;
  showQuickPick(items: readonly QuickPickItem[], options?: QuickPickOptions): Promise<QuickPickItem | undefined>;
  showInputBox(options?: InputBoxOptions): Promise<string | undefined>;
  createStatusBarItem(alignment: 'left' | 'right'): StatusBarItem;
  registerView(contribution: ViewContribution, provider: ViewProvider): Disposable;
  /**
   * 请求宿主切换工作区（打开文件夹）。
   *
   * 之所以放进 API 而不是留在外壳：打开文件夹这个动作的**后续处理**
   * （重建文件树、重置未保存状态、重新解析配置）全都可以用 API 表达，
   * 只有"弹出系统选择器"这一步需要外壳代劳。
   * 返回 true 表示用户确实选了一个工作区。
   */
  pickWorkspaceFolder(): Promise<boolean>;
  /** 恢复上次使用的工作区。授权已过期时需要用户手势。 */
  regrantLastWorkspaceFolder(): Promise<boolean>;

  /**
   * 关闭当前工作区（只解绑，不动磁盘上的文件）。
   *
   * 与 pickWorkspaceFolder 是一对：一个进、一个出。没有它，用户只能靠
   * "再打开另一个文件夹"来换工作区 —— 想回到"没有工作区"这个初始态
   * 则完全无路可走。
   *
   * 返回 false 表示没有工作区可关，或者标签里有未保存改动、用户在确认框里取消。
   */
  closeWorkspace(): Promise<boolean>;

  /**
   * 把工作区之外的一张图片导入进来，返回它在工作区内的**相对路径**。
   *
   * 为什么不给插件"选一个文件"+"拷贝一个绝对路径"两个更通用的能力：
   * 那样插件就能读写工作区之外的任意位置，而导入图片这件事本身
   * 完全不需要这种自由。绝对路径从不离开宿主，边界就守住了。
   *
   * 返回 null 表示用户取消。目标文件重名时宿主会自动改名而不是覆盖。
   */
  importImage(targetDir?: string): Promise<ImportedFile | null>;

  /**
   * 选一个 Markdown 文件并打开它。
   *
   * 工作区会被设为该文件所在的目录 —— 用户从此既能编辑这个文件，
   * 也能在文件树里看到它的邻居。
   *
   * 为什么要有这条：文件夹选择器只显示**子文件夹**，用户在一个
   * 只装着 .md 文件的目录里会看到空列表，以为出了问题；
   * 而文件选择器恰好显示文件。两条路互补，用户按直觉走哪条都行。
   *
   * 返回 false 表示用户取消。
   */
  openMarkdownFile(): Promise<boolean>;
  /**
   * 另存为。核心负责把它接到各平台的原生能力上：
   * Tauri 走原生文件对话框，桌面浏览器走 File System Access，Android 走 SAF。
   */
  saveAs(options: SaveAsOptions): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  readonly activeTheme: 'light' | 'dark';
  readonly onDidChangeTheme: Event<'light' | 'dark'>;
}

// ──────────────────────── 语言与渲染扩展点 ────────────────────────

/**
 * markdown-it 实例的结构化子集。
 * 只声明我们承诺稳定的部分 —— 插件不应依赖未声明的成员，
 * 这样内核换渲染引擎时才有退路。
 */
export interface MarkdownItLike {
  use(plugin: unknown, ...params: unknown[]): MarkdownItLike;
  readonly renderer: { rules: Record<string, unknown> };
  readonly core: {
    readonly ruler: {
      before(beforeName: string, ruleName: string, fn: (state: never) => void): void;
      after(afterName: string, ruleName: string, fn: (state: never) => void): void;
    };
  };
}

export type MarkdownItPlugin = (md: MarkdownItLike) => void;

export interface CompletionItem {
  readonly label: string;
  readonly kind?: 'keyword' | 'snippet' | 'text' | 'reference';
  readonly detail?: string;
  readonly insertText?: string;
  readonly documentation?: string;
}

/**
 * 补全请求。
 *
 * 刻意是"文档 + 选区"这种文档级语义，而不是 CodeMirror 的形状。
 * 如果这里直接暴露 CompletionContext，就等于漏了内核实现，
 * 而 CodeMirror 恰好是最容易被改动的那个依赖。
 * 内核负责把 CM 的补全上下文翻译成这个结构（见 apps/web 的 LanguagesService）。
 */
export interface CompletionRequest {
  readonly text: string;
  readonly from: number;
  readonly to: number;
  readonly language: string | null;
}

export interface CompletionProvider {
  readonly triggerCharacters?: readonly string[];
  provide(request: CompletionRequest): readonly CompletionItem[] | Promise<readonly CompletionItem[]>;
}

export interface OutlineItem {
  readonly level: number;
  readonly text: string;
  /** 1 起算，与 editor.getLine / revealLine 一致。 */
  readonly line: number;
}

export interface LanguagesApi {
  /**
   * 把 markdown 渲染成 HTML。
   *
   * 为什么在 API 里而不是让插件直接 import markdown-it：
   * 渲染器是可能被替换的（M0 用 markdown-it，将来可能换 WASM 版），
   * 一旦插件直接 import 具体实现，替换渲染器就等于生态重写。
   * 这条方法就是替换点。
   *
   * 返回的 HTML 是**不可信内容**，宿主负责把它放进隔离容器里渲染。
   */
  renderMarkdown(source: string): Promise<string>;

  /** 从 markdown 源码抽取大纲。刻意解析源码而不是解析 DOM —— 用户经常处于半截语法状态。 */
  extractOutline(source: string): Promise<readonly OutlineItem[]>;

  registerMarkdownItPlugin(plugin: MarkdownItPlugin): Disposable;
  registerHighlighter(languageId: string): Disposable;
  registerCompletionProvider(languageId: string, provider: CompletionProvider): Disposable;
}

// ───────────────────────────── 存储 ─────────────────────────────

export interface Memento {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Promise<void>;
  keys(): readonly string[];
}

export interface StorageApi {
  /** 跨工作区共享。 */
  readonly global: Memento;
  /** 跟随工作区。没有打开工作区时为 null。 */
  readonly workspace: Memento | null;
}

// ────────────────────────── 插件主入口 ──────────────────────────

export interface Logger {
  debug(message: string, ...args: readonly unknown[]): void;
  info(message: string, ...args: readonly unknown[]): void;
  warn(message: string, ...args: readonly unknown[]): void;
  error(message: string, error?: unknown): void;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly apiVersion: string;
  /** 插件所在目录的绝对路径，用于读取自带资源。 */
  readonly extensionPath: string;
  readonly globalStoragePath: string;
  readonly workspaceStoragePath: string | null;

  readonly platform: PlatformKind;
  /**
   * 外壳类型。`browser` 只出现在开发模式（npm run dev）。
   * 插件若要读写工作区之外的路径、或调用原生能力，必须先判这个 ——
   * 因为浏览器形态下那些路径根本不存在。
   */
  readonly shell: ShellKind;
  /** 平台能力快照。插件应据此决定降级行为，而不是假定能力存在。 */
  readonly capabilities: CapabilitySnapshot;

  readonly commands: CommandsApi;
  readonly editor: EditorApi;
  readonly workspace: WorkspaceApi;
  readonly window: WindowApi;
  readonly languages: LanguagesApi;
  readonly storage: StorageApi;
  readonly logger: Logger;

  /** 所有 Disposable 都可以塞进来，插件卸载时核心统一回收。 */
  readonly subscriptions: Disposable[];
}

export interface PluginModule {
  activate?(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
