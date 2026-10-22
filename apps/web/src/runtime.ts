/**
 * 运行时 —— 应用外壳的装配点。
 *
 * 这里做的事只有四件，而且一件都不该出现在插件里：
 *   1. 探测平台能力
 *   2. 创建编辑器实例、命令注册表、配置存储
 *   3. 装插件（含内置插件）
 *   4. 维护"崩溃恢复日志"和"保存"这两条数据安全链路
 *
 * 反过来，凡是能被插件 API 表达的，一律不放这里。
 * 比如"打开文件夹"看起来像外壳动作，但它最终就是
 * `window.pickWorkspaceFolder()` + 文件操作，所以放在 aropyt.file 插件里。
 */

import { Compartment } from '@codemirror/state';

import {
  describeLimitations,
  detectCapabilities,
  importImageNative,
  openNativeFolderAsWorkspace,
  pickMarkdownFileNative,
  pickSavePathNative,
  preferredProvider,
  regrantLastWorkspace,
  restoreWorkspace,
  type CapabilityReport,
  type Workspace,
} from '@aropyt/capabilities';

import {
  BUDGETS,
  CommandRegistry,
  ConfigurationStore,
  EditorAdapter,
  FrameBudgetMonitor,
  MementoStore,
  PluginHost,
  STORE,
  createEditor,
  createInputLatencyProbe,
  debounce,
  idbDelete,
  idbGet,
  idbSet,
  requestPersistentStorage,
  type LoadablePlugin,
  type PluginRecord,
  type BudgetViolation,
  getVersion,
  listVersions,
  recordVersion,
  applyBackup,
  assembleBackup,
} from '@aropyt/core';

import type { DocumentRef, ImportedFile, Memento, PluginManifest } from '@aropyt/plugin-api';

import { LanguagesService, WindowService } from './services.js';
import { createThemeService, type ResolvedTheme, type ThemePreference, type ThemeService } from './theme.js';
import { builtinPlugins } from './builtin/index.js';
/** 配置补丁：允许只给嵌套对象的一部分。 */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

import {
  browserSettingsIo,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type AppSettings,
  type SettingsIo,
} from './config/settings.js';
import { createTauriSettingsIo, hasTauri, invokeNative } from './config/tauri-io.js';

export interface ToolbarItem {
  readonly command: string;
  readonly pluginId: string | null;
  readonly group: string;
  readonly order: number;
}

/**
 * 编辑器里的一个标签页。
 *
 * `preview` 就是 VSCode 的"预览标签"：在文件树里**单击**打开的是它，
 * 标签文字显示为斜体，而且**会被下一次单击替换**，而不是越点越多。
 * 双击打开、或者对预览标签动了内容，它就"转正"（斜体消失）。
 *
 * 有了这一层，"随手翻几个文件看看"不会把标签栏塞满，
 * 而"我正在改的那个文件"也不会被下一次单击顶掉 ——
 * 这两个诉求本来是矛盾的，用两个状态区分开才是正解。
 */
export interface EditorTab {
  readonly path: string;
  /** 与 `activeLanguage` 同义：未知语言时是 null。 */
  readonly language: string | null;
  readonly preview: boolean;
  /**
   * 缓冲区内容。
   *
   * 必须跟着标签走：整个应用只有**一个** EditorView 实例，切换标签时
   * 编辑器里的文档会被整篇换掉。如果不把内容存回标签，切走再切回来
   * 就会读到磁盘版本 —— 而中间那些没保存的修改**直接消失**。
   * 这不是"体验问题"，是数据丢失。
   */
  readonly text: string;
  readonly dirty: boolean;
}

export interface RuntimeState {
  readonly capabilities: CapabilityReport;
  readonly limitations: readonly string[];
  readonly workspace: Workspace | null;
  readonly activePath: string | null;
  readonly dirty: boolean;
  /** 打开着的标签页，按打开顺序。 */
  readonly tabs: readonly EditorTab[];
  /** vim 模式是否开启。 */
  readonly vimMode: boolean;
  /** vim 子模式（NORMAL/INSERT/VISUAL…），未开 vim 时 null。 */
  readonly vimSubMode: string | null;
  /** 编辑历史：每文件保留的版本数。 */
  readonly historyLimit: number;
  /** 编辑历史：是否自动保存版本。 */
  readonly historyAutoSave: boolean;
  /** 编辑历史：自动保存间隔（秒）。 */
  readonly historyInterval: number;
  /** 侧栏是否展开（真源：settings.sidebar.open）。 */
  readonly sidebarOpen: boolean;
  /** 恢复自草稿/崩溃日志的文件路径；null = 本次会话没有恢复过。状态栏黄点用它，且只在**当前激活**文件是它时才亮。 */
  readonly recoveredPath: string | null;
  readonly plugins: readonly PluginRecord[];
  readonly toolbar: readonly ToolbarItem[];
  /** 源码模式开启中：显示原始标记，关闭内联渲染。 */
  readonly sourceMode: boolean;
  /** 用户自己选定的源码模式（不含预览面板的强制）。持久化偏好要用这个。 */
  readonly preferredSourceMode: boolean;
  /** 预览面板是否打开。 */
  /** 用户偏好（light / dark / auto）。 */
  readonly themePreference: ThemePreference;
  /** 实际生效的主题。auto 已被解析成具体值。 */
  readonly theme: ResolvedTheme;
  readonly lastInputLatencyMs: number;
  readonly budgetViolations: number;
  /** 最近若干次超预算明细（最多 5 条，新的在前）。 */
  readonly budgetDetails: readonly BudgetViolation[];
  /** 安全模式（?safe）：全部插件禁用，对应 VS Code 的 --disable-extensions。 */
  readonly safeMode: boolean;
}

export interface AropytRuntime {
  readonly commands: CommandRegistry;
  readonly theme: ThemeService;
  readonly configuration: ConfigurationStore;
  readonly host: PluginHost;
  readonly editor: EditorAdapter;
  readonly windowService: WindowService;
  readonly languages: LanguagesService;

  subscribe(listener: () => void): () => void;
  getState(): RuntimeState;

  pickWorkspace(): Promise<Workspace | null>;
  regrantWorkspace(): Promise<boolean>;
  /**
   * 打开文件。
   *
   * `preview` 对应"文件树里单击"：开在预览标签里（斜体），
   * 而且会替换掉已有的预览标签。默认 false（双击 / 命令打开）——
   * 那是用户的明确选择，不该被下一次单击顶掉。
   */
  openFile(path: string, options?: { readonly preview?: boolean }): Promise<void>;
  /** 激活一个已打开的标签。 */
  activateTab(path: string): void;
  /** 关闭一个标签；关的是当前标签时自动激活相邻的那个。 */
  closeTab(path: string): void;
  /** 新建一个空白未命名标签；若未命名标签已存在则直接激活它。 */
  createUntitledTab(): void;
  /** 按打开顺序循环切换标签（Ctrl+Tab / Ctrl+Shift+Tab）。 */
  activateRelativeTab(delta: number): void;
  /** 用系统默认程序打开 settings.jsonc（浏览器模式下提示路径不存在）。 */
  openSettingsFile(): void;
  /** 配置文件路径（浏览器模式为 null）。 */
  readonly settingsPath: string | null;
  /** 当前生效的配置（settings.jsonc 的真源快照）。 */
  getSettings(): AppSettings;
  /** 合并写入配置：应用到运行时并落盘（失败会提示，不会静默丢）。 */
  updateSettings(patch: DeepPartial<AppSettings>): void;
  /** 打开工作区之外的文件（文件关联 / 命令行传入）。 */
  openExternalPath(path: string): Promise<void>;
  /** 某个文件的编辑历史（新→旧）。 */
  listHistory(path: string): Promise<import('@aropyt/core').HistorySummary[]>;
  /** 把某个历史版本恢复进编辑器（当前内容会先存为新版本，不丢）。 */
  restoreHistory(id: string): Promise<void>;
  /** 把当前内容存成一个**命名版本**（里程碑）。 */
  snapshotHistory(label: string): Promise<void>;
  /** 导出草稿与编辑历史为 JSON（用户选保存位置）。 */
  exportBackup(): Promise<void>;
  /** 从 JSON 导入（覆盖现有草稿与历史，导入后需重启）。 */
  importBackup(): Promise<void>;
  /** vim 模式开关（normal/insert/visual 操作方式）。持久化在 localStorage。 */
  toggleVimMode(): void;
  /**
   * 插件启用/禁用。
   * 禁用**立即生效**（撤销该插件的命令/视图声明）并写入 localStorage；
   * 启用只记偏好 —— 插件的贡献声明要重新走一遍加载流程，重启后生效。
   */
  setPluginEnabled(pluginId: string, enabled: boolean): void;
  /** 选择本地 .js 插件文件导入（存 IndexedDB，重启后加载生效）。 */
  importExternalPlugin(): void;
  deleteExternalPlugin(pluginId: string): Promise<void>;
  /** 内置插件的 id 集合 —— 插件管理面板只展示外部导入的插件。 */
  readonly builtinPluginIds: ReadonlySet<string>;
  /** 源码模式（原始标记可见）。webdev 与排障时需要。 */
  toggleSourceMode(): void;
  /**
   * 开合预览面板。
   *
   * 走运行时而不是留在 React 里，是因为"打开面板要把编辑区逼成源码模式"
   * 这件事必须由**编辑器状态**负责 —— React 只知道面板开没开，
   * 它不知道编辑器当前是哪种模式，也就不可能自己算出生效模式。
   * 两处各算一次必然会漂（按钮亮着但编辑区是渲染态）。
   */
  saveActiveFile(): Promise<void>;
  markSaved(): void;
  dispose(): void;
}

export interface RuntimeOptions {
  readonly editorHost: HTMLElement;
  readonly safeMode?: boolean;
  readonly plugins?: readonly LoadablePlugin[];
}

interface DraftRecord {
  readonly text: string;
  readonly at: number;
}

const API_VERSION = '^0.1.0';
const DRAFT_KEY = '__untitled__';
/**
 * "上次是正常退出"的标记键（localStorage，同步）。
 *
 * ── 为什么必须有它 ──────────────────────────────────────────
 * 崩溃恢复的草稿**跨会话**留在 IndexedDB 里。重开之后，只凭
 * "草稿比文件新"这一条判据分不清两种完全不同的来历：
 *
 *   1. 上次是真崩了（进程被杀、断电）—— 草稿是崩溃现场唯一的副本
 *   2. 上次是用户正常关掉的，但当时有没保存的修改
 *
 * 两种情况都该恢复内容，**但措辞必须不同**。用户明明是正常关掉应用，
 * 重开却被告知"已从崩溃恢复日志中还原" —— 他会以为文件坏了，
 * 而这正是之前报上来的现象。
 *
 * 机制：`dispose()` 时写下标记，启动时**读走并立即删掉**（消费掉）。
 * 被强杀时 `dispose` 不会执行，标记自然不存在 → 判定为崩溃。
 * 用 localStorage 而不是 IndexedDB，是因为启动时要**同步**拿到它 ——
 * 异步读的话第一次 `openFile` 可能赶在它前面。
 */
const CLEAN_EXIT_KEY = 'aropyt.cleanExit';

function consumeCleanExitFlag(): boolean {
  try {
    const value = localStorage.getItem(CLEAN_EXIT_KEY);
    localStorage.removeItem(CLEAN_EXIT_KEY);
    return value !== null;
  } catch {
    // 读不到就按"崩溃"处理：措辞保守一点没有代价，
    // 反过来（漏报崩溃）会让用户以为内容不该恢复。
    return false;
  }
}

export function createRuntime(options: RuntimeOptions): AropytRuntime {
  const capabilities = detectCapabilities();
  const limitations = describeLimitations(capabilities);

  const commands = new CommandRegistry();
  const configuration = new ConfigurationStore(new MementoStore('config'));
  const windowService = new WindowService();
  const theme = createThemeService();
  const languages = new LanguagesService();

  const mementos = new Map<string, MementoStore>();
  const mementoFor = (id: string): Memento => {
    let store = mementos.get(id);
    if (!store) {
      store = new MementoStore(`plugin:${id}`);
      void store.load();
    }
    return store;
  };

  const state: {
    workspace: Workspace | null;
    activePath: string | null;
    dirty: boolean;
    /** 打开着的标签页。 */
    tabs: EditorTab[];
    /** vim 模式是否开启。 */
    vimMode: boolean;
    recoveredPath: string | null;
    lastInputLatencyMs: number;
    budgetViolations: number;
    /** 最近若干次超预算的明细，供状态栏说明来源。 */
    budgetDetails: BudgetViolation[];
  } = {
    workspace: null,
    activePath: null,
    dirty: false,
    tabs: [],
    vimMode: localStorage.getItem('aropyt.vimMode') === 'on',
    recoveredPath: null,
    lastInputLatencyMs: 0,
    budgetViolations: 0,
    budgetDetails: [],
  };

  const listeners = new Set<() => void>();
  let revision = 0;
  let cached: { rev: number; value: RuntimeState } | null = null;

  // 快照必须按 revision 缓存：React 的 useSyncExternalStore 要求
  // getSnapshot 在两次通知之间返回同一个引用，否则会无限重渲染。
  const buildState = (): RuntimeState => ({
    capabilities,
    limitations,
    workspace: state.workspace,
    activePath: state.activePath,
    dirty: state.dirty,
    tabs: state.tabs,
    vimMode: state.vimMode,
    vimSubMode: lastVimSubMode,
    historyLimit: currentSettings.history.limit,
    historyAutoSave: currentSettings.history.autoSave,
    historyInterval: currentSettings.history.autoSaveInterval,
    sidebarOpen: currentSettings.sidebar.open,
    recoveredPath: state.recoveredPath,
    plugins: host.records,
    sourceMode: editor.sourceMode,
    preferredSourceMode: editor.preferredSourceMode,
    themePreference: theme.preference,
    theme: theme.resolved,
    toolbar: (host.contributions.menus['toolbar'] ?? []).map((item) => ({
      command: item.command,
      pluginId: item.pluginId,
      group: item.group ?? '0',
      order: item.order ?? 0,
    })),
    lastInputLatencyMs: state.lastInputLatencyMs,
    budgetViolations: state.budgetViolations,
    // 倒序快照：状态栏按"最近 → 最早"展示，直接切片即可。
    // 拷贝一份：把内部数组直接暴露出去，调用方一 sort 就把运行时状态改了。
    budgetDetails: [...state.budgetDetails].reverse(),
    safeMode: options.safeMode ?? false,
  });

  const notify = () => {
    revision += 1;
    for (const listener of listeners) listener();
  };
  const workspaceListeners = new Set<(payload: { rootPath: string | null }) => void>();
  const emitWorkspaceChange = () => {
    for (const listener of workspaceListeners) {
      try {
        listener({ rootPath: state.workspace?.name ?? null });
      } catch {
        /* 插件监听器出错不影响工作区切换 */
      }
    }
  };

  const completionSlot = new Compartment();

  /*
   * 图片资源缓存。
   *
   * 渲染层每次重算装饰都会来问一次同一个地址，而每问一次就要
   * 读一遍磁盘、再做一遍 base64 —— 那是把"移动一下光标"变成磁盘 IO。
   * 键是文档里写的原始地址（可能是未解码的），值是可以直接塞进 src 的 URL。
   *
   * 何时失效：换工作区时整体清空。刻意不做"文件被外部修改就重新读"——
   * 那要么引入文件监视（内核里没有这个东西），要么每次重算都去 stat，
   * 两者都比"换工作区时失效"贵得多，而收益只是"外部改了图立刻看到"。
   */
  const assetCache = new Map<string, string>();

  const MIME_BY_EXT: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    avif: 'image/avif',
    ico: 'image/x-icon',
  };

  async function resolveAsset(url: string): Promise<string | null> {
    const cached = assetCache.get(url);
    if (cached) return cached;

    const workspace = state.workspace;
    if (!workspace) return null;

    // 文档里写的可能是 %20 这类编码，也可能带 ./ 前缀，先归一化。
    let relative: string;
    try {
      relative = decodeURIComponent(url).replace(/^\.\//, '');
    } catch {
      relative = url.replace(/^\.\//, '');
    }

    try {
      const bytes = await workspace.readBytes(relative);
      const ext = relative.slice(relative.lastIndexOf('.') + 1).toLowerCase();
      const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
      /*
       * 用 data URL 而不是 blob URL。
       *
       * blob URL 要自己管生命周期（revokeObjectURL），而图片一旦
       * 被 CM6 复用就会脱离我们的引用范围 —— 提前 revoke 会让图片
       * 突然变成裂图，不 revoke 就是内存泄漏。data URL 没有这个问题，
       * 代价只是 base64 膨胀 33%，而文档里的配图通常不大。
       */
      const dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
      assetCache.set(url, dataUrl);
      return dataUrl;
    } catch (error) {
      console.warn('[aropyt] 读取图片失败（渲染态会显示占位）', relative, error);
      return null;
    }
  }

  /** 换工作区时图片缓存必须整体失效 —— 否则同名的相对路径会显示上一个工作区的图。 */
  const resetAssetCache = (): void => {
    assetCache.clear();
  };

  const documentRef: DocumentRef = {
    get path() {
      return state.activePath;
    },
    get isDirty() {
      return state.dirty;
    },
    getText: () => editor.getText(),
    save: () => saveActiveFile(),
  };

  /*
   * 正在装载文档的标记。
   *
   * `openFile` 里的 `replaceDocument` 本质是一次**整篇替换**，CM6 会把它
   * 当成普通的文档变更，于是 `onDocChange` 被触发 —— 结果"打开文件"
   * 这个动作被记成了一次编辑：既把文档标脏，又往崩溃恢复日志里写一份
   * 与磁盘完全相同的内容。
   *
   * 那份草稿的 `at` 比文件 mtime 新，看起来就像"上次退出前有未落盘的修改"，
   * 于是每次打开都会提示"已从崩溃恢复日志中还原未保存的内容" ——
   * 用户从没崩溃过，却被告知恢复了东西。
   *
   * 装载不是编辑，这里把两者分开。
   */
  let loadingDocument = false;

  /*
   * 这次会话开始时，把"上次是否正常退出"消费掉（读走即删）。
   *
   * 放在创建 runtime 的最开头：`openFile` 可能在任意时刻被调用，
   * 而它要用这个标记决定提示措辞。用 localStorage 就是为了能同步读到。
   */
  const lastExitWasClean = consumeCleanExitFlag();

  /*
   * 落下"正常退出"标记。
   *
   * ⚠️ 光靠 `dispose()` 是不够的。`dispose` 只在 **React 卸载组件**时执行，
   * 而**关窗口 / 重载页面**时浏览器直接销毁整个 JS 环境，React 根本没有
   * 机会跑 cleanup —— 那样每次正常关闭都会被误判成崩溃
   * （实测：重载页面后打开文件，提示仍然是"已从崩溃恢复日志中还原"）。
   *
   * `pagehide` 是浏览器**保证**在卸载前派发的，把它当作"正常离开"的信号。
   * 崩溃（进程被杀、断电、崩溃退出）不会派发它，所以判定依然成立 ——
   * 这正是"能不能区分崩溃"的关键：不是看我们有没有清理，
   * 而是看**离开前那个钩子有没有机会执行**。
   */
  const markCleanExit = (): void => {
    try {
      localStorage.setItem(CLEAN_EXIT_KEY, String(Date.now()));
    } catch {
      /* 写不进去只影响下次的措辞，不该打断退出流程 */
    }
  };
  window.addEventListener('pagehide', markCleanExit);

  const editor = createEditor({
    vimMode: state.vimMode,
    parent: options.editorHost,
    platform: capabilities.platform,
    capabilities: capabilities.snapshot,
    onModeChange: () => notify(),
    onDocChange: (text) => {
      if (loadingDocument) return;
      state.dirty = true;
      /*
       * 注意：这里**不要**动 state.tabs —— 曾经为了同步 tab.dirty 加过
       * tabs.map，结果打坏了崩溃恢复链路（check:crash 实测：
       * "未保存的修改没有被恢复"）。
       * closeTab 的未保存确认改用全局 state.dirty 兜底（激活标签场景
       * 覆盖绝大多数情况），不需要维护 tab.dirty 的实时同步。
       */
      /*
       * **编辑使预览标签转正**（斜体消失）。
       *
       * 这是整条规则里最要紧的一条：预览标签会被"下一次单击"替换掉，
       * 而用户一旦开始改东西，它就绝不能再被顶走 ——
       * 否则"点开看看、顺手改了两个字、又点了另一个文件"就会静默丢内容。
       * VSCode 也是这么做的，理由相同。
       */
      if (state.tabs.some((tab) => tab.path === state.activePath && tab.preview)) {
        state.tabs = state.tabs.map((tab) =>
          tab.path === state.activePath ? { ...tab, preview: false } : tab,
        );
      }
      persistDraft(state.activePath ?? DRAFT_KEY, text);
      notify();
    },
    onSaveRequest: () => {
      void commands.execute('aropyt.file.save').catch((error: unknown) => {
        void windowService.showMessage('保存失败', { level: 'error' });
        console.error(error);
      });
    },
    // 渲染态要把 `![](相对路径)` 画成真图，而相对路径在 WebView 里取不到，
    // 只能由宿主把字节读出来转成 data URL。内核不知道工作区在哪。
    resolveAsset: (url) => resolveAsset(url),
    extraExtensions: [completionSlot.of([])],
  });
  editor.bindDocument(documentRef);
  editor.bindOpener((path, options) => openFile(path, options));

  /*
   * 分栏预览面板已**整体移除**（视图注册 + Ctrl+Shift+V 入口）。
   *
   * 用户的判断是对的：Typora 式编辑里"编辑区本身就是预览"，再挂一栏
   * iframe 渲染是**第二套渲染管线** —— 两边各显示一半（原地渲染没覆盖的
   * 只有那一栏有），既重复又不一致。
   *
   * `languages.renderMarkdown` 保留：它是 plugin-api 承诺给插件的能力，
   * markdown-it 仍然是懒加载、不进首屏。
   */

  // 崩溃恢复日志。
  // 防抖 300ms 是取舍：再短会把 IndexedDB 写满，再长崩溃时丢的内容太多。
  // maxWait 2s 保证连续输入的用户不会一直不落盘。
  const persistDraft = debounce(
    (path: string, text: string) => {
      const record: DraftRecord = { text, at: Date.now() };
      void idbSet(STORE.drafts, path, record).catch(() => undefined);
    },
    BUDGETS.walDebounceMs,
    { maxWaitMs: 2000 },
  );

  const monitor = new FrameBudgetMonitor({
    onViolation: (violation) => {
      state.budgetViolations += 1;
      // 只留最近 5 条明细：状态栏要能说清"是哪一次、哪个来源、多长"，
      // 只有一个计数的话用户看到"预算超支 3 次"完全无从判断。
      state.budgetDetails.push(violation);
      if (state.budgetDetails.length > 5) state.budgetDetails.shift();
      console.warn(
        `[预算超支] ${violation.label} 实际 ${violation.actualMs}ms > 预算 ${violation.budgetMs}ms`,
      );
      notify();
    },
  });
  monitor.observe();

  const latencyProbe = createInputLatencyProbe((ms) => {
    state.lastInputLatencyMs = ms;
  });

  const host = new PluginHost({
    platform: capabilities.platform,
    shell: capabilities.shell,
    capabilities: capabilities.snapshot,
    apiVersion: API_VERSION,
    commands,
    configuration,
    window: windowService,
    languages,
    editor,
    getWorkspace: () => state.workspace,
    onDidChangeWorkspace: (listener) => {
      workspaceListeners.add(listener);
      return {
        dispose: () => {
          workspaceListeners.delete(listener);
        },
      };
    },
    mementoFor,
    onStateChange: () => notify(),
    safeMode: options.safeMode ?? false,
  });

  /*
   * 清单登记必须**同步**完成，不能塞进下面的异步启动块。
   *
   * load() 只读清单、不执行插件代码（真正昂贵的是 activate，那个仍然是异步的），
   * 所以它没有异步的必要。放进异步块会导致：React 首帧渲染时
   * host.contributions 还是空的 → 布局读不到任何插件视图 → 侧栏整个不出现。
   * 而后续也没有任何通知触发重渲染，于是它就一直是空的。
   *
   * 表现为"面板有、侧栏没有"，很容易误以为是插件没加载 —— 实际加载了，
   * 只是登记得比第一帧晚。
   */
  host.load(options.plugins ?? builtinPlugins);


  // 主题变化要触发一次状态通知，否则工具栏按钮的图标不会更新
  // （data-theme 已经改了，界面配色会跟着变，但按钮显示的还是旧状态）。
  theme.onDidChange(() => notify());

  notify();

  // 宿主注入的窗口能力：插件调用 window.pickWorkspaceFolder() 时走到这里。
  windowService.bindHost({
    pickWorkspaceFolder: async () => (await pickWorkspace()) !== null,
    regrantLastWorkspaceFolder: () => regrantWorkspace(),
    importImage: (targetDir) => importImage(targetDir),
    openMarkdownFile: () => openMarkdownFile(),
  });

  // 补全扩展在插件激活后需要重配 —— 用 Compartment 才能不重建编辑器。
  languages.subscribe(() => {
    const extension = languages.completionExtension();
    editor.view.dispatch({ effects: completionSlot.reconfigure(extension) });
  });

  const runtime: AropytRuntime = {
    commands,
    configuration,
    host,
    editor,
    windowService,
    languages,
    theme,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getState() {
      if (cached && cached.rev === revision) return cached.value;
      const value = buildState();
      cached = { rev: revision, value };
      return value;
    },

    pickWorkspace,
    regrantWorkspace,
    openFile,
    activateTab,
    closeTab,
    createUntitledTab,
    toggleVimMode,
    activateRelativeTab,
    openSettingsFile,
    getSettings() {
      return currentSettings;
    },
    updateSettings,
    openExternalPath,
    listHistory,
    restoreHistory,
    snapshotHistory,
    exportBackup,
    importBackup,
    get settingsPath() {
      return settingsPathValue;
    },
    setPluginEnabled,
    importExternalPlugin,
    deleteExternalPlugin,
    builtinPluginIds: new Set(builtinPlugins.map((plugin) => plugin.manifest.id)),
    saveActiveFile,
    markSaved() {
      state.dirty = false;
      notify();
    },

    toggleSourceMode() {
      /*
       * 取反 **实际生效** 的 sourceMode，不是 preferredSourceMode。
       * vim 强制源码期间 preferred 一直停在 false（用户没主动切过），
       * 用它取反永远是"设成 true" —— 已经是源码态时点了没反应，
       * 表现为"关闭源码模式关不掉，要开关一次 vim 才行"（用户实测）。
       */
      editor.setSourceMode(!editor.sourceMode);
      notify();
    },

    dispose() {
      /*
       * React 卸载路径上也补一次（`pagehide` 覆盖的是浏览器卸载路径），
       * 两条路都落下标记，才不会因为"走了哪条退出路径"而判错。
       */
      window.removeEventListener('pagehide', markCleanExit);
      markCleanExit();
      latencyProbe.dispose();
      monitor.dispose();
      persistDraft.cancel();
      editor.destroy();
    },
  };

  // ── 工作区 ──

  async function pickWorkspace(): Promise<Workspace | null> {
    /*
     * 必须用 preferredProvider()，不能像原来那样写死 fsa / opfs。
     *
     * 原来这里是 `fsaProvider.isAvailable() ? fsaProvider : opfsProvider...`，
     * 结果是**发出去的 Tauri 应用从来不用原生适配器** —— 它在 WebView 里
     * 试着调浏览器的 showDirectoryPicker。优先级列表（tauri → fsa → opfs）
     * 早就定义在能力层里了，运行时却没走它。
     *
     * 这类"能力层建好了但没接线"的问题不会报错，只会在真机上表现为
     * 一个莫名其妙的浏览器 API 异常。
     */
    const provider = preferredProvider();
    if (!provider) {
      await windowService.showMessage(
        '当前环境既没有原生文件系统，也不支持打开本地文件夹，且没有可用的沙箱存储。',
        { level: 'error' },
      );
      return null;
    }

    const workspace = await provider.pick();
    if (!workspace) return null;

    state.workspace = workspace;
    resetAssetCache();
    state.activePath = null;

    /*
     * 先宣布状态变化，再落配置 —— 顺序很重要。
     *
     * 原来这两次 `await configuration.update(...)` 排在 `emitWorkspaceChange()`
     * **之前**。配置写入只是记账（把上次工作区记下来供下次启动恢复），
     * 而"工作区变了"是用户立刻要看到的结果。让记账挡在结果前面，
     * 就有了一条很脆的因果链：配置写入一旦变慢或卡住（IndexedDB 在某些
     * WebView 里并不总是可靠），文件树就永远不刷新 —— 而且不报错，
     * 用户看到的是"选了文件夹，左边一片空白"。
     *
     * 现在改成：状态先落、事件先发，配置随后异步写、失败也不影响使用。
     */
    emitWorkspaceChange();
    notify();

    void configuration
      .update('workspace.lastName', workspace.name)
      // 完整的 id 也要记 —— 原生侧恢复需要根路径，而根路径只存在于
      // Rust 的 managed state 里，进程一退就没了。只存 name（目录名）
      // 不够：同名目录在不同位置很常见。
      .then(() => configuration.update('workspace.lastId', workspace.id))
      .catch((error: unknown) => {
        // 记不住只是下次启动不自动恢复，不该影响本次会话
        console.warn('[aropyt] 记录上次工作区失败', error);
      });

    return workspace;
  }

  /**
   * 选一个 Markdown 文件并打开：工作区 = 它所在的目录。
   *
   * 为什么需要这条而不只有"打开文件夹"：Windows 的文件夹选择器
   * 只显示子文件夹，用户在一个只装着 .md 文件的目录里看到的是空列表，
   * 很自然地会以为"没有匹配项"然后取消 —— 日志里三次"用户取消"
   * 正是这个模式。文件选择器恰好相反：显示文件、不显示目录。
   * 两条路互补，按直觉走哪条都能到。
   */
  async function openMarkdownFile(): Promise<boolean> {
    const picked = await pickMarkdownFileNative();
    if (!picked) return false;

    // 路径分隔符两种都处理：原生侧给的是反斜杠，但历史配置里可能是正斜杠。
    const segments = picked.split(/[\\/]/).filter(Boolean);
    const fileName = segments.pop();
    if (!fileName) return false;
    const parent = segments.join('\\');

    const workspace = await openNativeFolderAsWorkspace(parent);
    if (!workspace) {
      await windowService.showMessage('打开文件所在目录失败。', { level: 'error' });
      return false;
    }

    state.workspace = workspace;
    resetAssetCache();
    state.activePath = null;
    emitWorkspaceChange();
    notify();

    void configuration
      .update('workspace.lastName', workspace.name)
      .then(() => configuration.update('workspace.lastId', workspace.id))
      .catch((error: unknown) => {
        console.warn('[aropyt] 记录上次工作区失败', error);
      });

    // 打开用户选的那个文件（而不是停在"未打开文件"状态）
    await openFile(fileName);
    return true;
  }

  /**
   * 把工作区之外的一张图片导入进来。
   *
   * 三件事只有宿主能做，所以它不在插件里：
   *   1. 弹系统文件选择器；
   *   2. 读工作区之外的字节（插件拿不到那个路径，也不该拿到）；
   *   3. 写进工作区的 assets/ 目录（走的是同一套路径穿越防护）。
   * 插件最终只拿到一个工作区内的相对路径。
   */
  async function importImage(targetDir: string): Promise<ImportedFile | null> {
    if (!state.workspace) {
      await windowService.showMessage('请先打开一个文件夹作为工作区。', { level: 'warning' });
      return null;
    }

    const imported = await importImageNative(targetDir);
    if (!imported) return null;

    // 图片落盘后必须让文件树刷新 —— 否则新出现的 assets/ 目录不会显示，
    // 用户会以为导入失败（而文件其实已经写进去了）。
    emitWorkspaceChange();
    notify();
    return imported;
  }

  async function openFile(
    path: string,
    options?: { readonly preview?: boolean },
  ): Promise<void> {
    const workspace = state.workspace;
    if (!workspace) {
      await windowService.showMessage('请先打开一个文件夹作为工作区。', { level: 'warning' });
      return;
    }

    const preview = options?.preview ?? false;

    /*
     * 已经在标签里 → 只切换激活，不重新读盘。
     *
     * 重读会把用户在这个标签里未保存的修改冲掉，那是数据丢失。
     * （VSCode 也是这个行为：切回一个已打开的标签不会重新加载。）
     */
    const already = state.tabs.find((tab) => tab.path === path);
    if (already) {
      /*
       * 用"固定"的方式打开一个预览标签时，顺手把它转正 ——
       * 用户双击了它，意图很明确：这个我要留着。
       */
      if (!preview && already.preview) {
        state.tabs = state.tabs.map((tab) =>
          tab.path === path ? { ...tab, preview: false } : tab,
        );
        /*
         * ⚠️ 转正之后必须 notify。
         *
         * 下面的 activateTab 会因为"这个标签已经是激活状态"而**提前返回**
         * （短路是它该有的行为，省掉无意义的重载），于是转正只发生在
         * 数据里 —— 如果不在这里通知，UI 上的斜体就永远不会消失。
         * 实测正是如此：双击后内容没变、标签也没重绘，静得像什么都没发生。
         */
        notify();
      }
      activateTab(path);
      return;
    }

    /*
     * 开新标签之前，先把当前标签的缓冲区存回去。
     *
     * 少这一步的后果是：在 A 里改了字没保存 → 点开 B → 再点回 A，
     * A 的修改就没了（编辑器是同一个实例，内容会被 B 顶掉）。
     */
    syncActiveTabBuffer();

    let content: string;
    try {
      content = await workspace.read(path);
    } catch (error) {
      await windowService.showMessage(`无法读取 ${path}`, { level: 'error' });
      console.error(error);
      return;
    }

    /*
     * 崩溃恢复：只有草稿**确实比磁盘上的文件新**才用它。
     *
     * 这段的判断原来只写了 `draft.text !== content`，而上面那行注释
     * 说的"如果草稿比磁盘上的内容新"根本没有落实 —— 于是任何一份
     * 残留草稿（哪怕比文件还旧）都会覆盖磁盘内容。用户看到的是
     * "提示恢复了未保存内容，而文件内容货不对板"。
     *
     * `at` 与 `stat.mtime` 都是毫秒（Rust 侧用 `as_millis()`），可直接比。
     *
     * stat 失败时**不恢复**：宁可这次少救一份草稿，也不能拿一份来历
     * 不明的文本去覆盖磁盘 —— 前者是可恢复的遗憾，后者是数据损坏。
     */
    const draft = await idbGet<DraftRecord>(STORE.drafts, path).catch(() => undefined);
    if (draft && draft.text !== content) {
      const stat = await workspace.stat(path).catch(() => undefined);
      if (stat && draft.at > stat.mtime) {
        const when = new Date(draft.at).toLocaleString();
        content = draft.text;
        /*
         * 措辞按"上次是怎么结束的"分流。
         *
         * 内容该恢复就恢复（它确实是用户的心血），但**不能对正常关闭的
         * 用户说"崩溃恢复"** —— 他会以为文件坏了、以为是软件出了问题，
         * 而实际上只是上次关掉时没保存。
         *
         * 带上**这份草稿是什么时候写的**，用户一看就知道它是不是
         * 自己想要的那一份；再给一个「丢弃」的出口 ——
         * 此前这份内容只能靠"保存"来覆盖，而用户恰恰不想要它。
         */
        /*
         * 状态栏黄点：绑定**恢复的这份文件**（recoveredPath）——
         * 上一版用全局布尔，打开别的文件也黄、且永不复位（实测打回）。
         * 现在：黄点只在"当前激活的文件就是恢复来源"时亮；
         * 打开别的文件自然不亮，切回来仍亮（它还是未保存的恢复内容），
         * 保存成功后清掉。
         */
        state.recoveredPath = path;
        notify();
        void windowService.showMessage(
          lastExitWasClean
            ? `这份文件上次关闭时（${when}）有未保存的修改，已恢复当时的编辑。`
            : `已从崩溃恢复日志中还原未保存的内容（${when}）。`,
          {
            level: 'warning',
            actions: [
              {
                label: '丢弃，改用磁盘上的版本',
                run: () => {
                  /*
                   * 丢弃 = 回到磁盘内容 + 删掉草稿。
                   *
                   * 必须走 `replaceDocument` 并把 `loadingDocument` 打开 ——
                   * 否则这次"换回磁盘版本"会被当作用户编辑，又写出一份
                   * 一模一样的草稿，下次打开继续提示（那就成了死循环）。
                   */
                  const workspaceNow = state.workspace;
                  if (!workspaceNow) return;
                  void workspaceNow
                    .read(path)
                    .then(async (diskText) => {
                      loadingDocument = true;
                      try {
                        editor.replaceDocument(diskText);
                      } finally {
                        loadingDocument = false;
                      }
                      persistDraft.cancel();
                      await idbDelete(STORE.drafts, path).catch(() => undefined);
                      state.dirty = false;
                      notify();
                      await windowService.showMessage('已改用磁盘上的版本。', { level: 'info' });
                    })
                    .catch((error: unknown) => {
                      console.error(error);
                      void windowService.showMessage('读取磁盘内容失败。', { level: 'error' });
                    });
                },
              },
            ],
          },
        );
      }
    }

    /*
     * 顺序很关键：**先把 activePath 指到新文件，再换文档**。
     *
     * `replaceDocument` 会触发 `onDocChange`（虽然现在被 loadingDocument
     * 挡住了，但顺序仍是唯一的正确写法）。曾经这里把 `state.activePath = path`
     * 放在 `replaceDocument` 之后，而当时 `onDocChange` 没有挡住装载 ——
     * 于是"打开 B"写出来的草稿挂在 A 的路径下（activePath 还是 A），
     * 下次打开 A 就会拿 B 的内容覆盖它。
     */
    state.activePath = path;
    editor.setActiveFile(path, guessLanguage(path));
    loadingDocument = true;
    try {
      editor.replaceDocument(content);
    } finally {
      loadingDocument = false;
    }
    state.dirty = false;

    /*
     * 落标签。
     *
     * 预览标签的规则是"**至多一个**，且新的顶掉旧的"——
     * 这正是"在文件树里连着点几个文件看看"时想要的行为：
     * 标签栏不会越点越长，只有最后看的那个留在那儿。
     *
     * 固定标签一律追加，因为它代表用户的明确选择，不能悄悄顶掉别人。
     */
    const language = guessLanguage(path);
    const tab: EditorTab = { path, language, preview, text: content, dirty: false };
    if (preview) {
      const previewIndex = state.tabs.findIndex((item) => item.preview);
      state.tabs =
        previewIndex >= 0
          ? state.tabs.map((item, index) => (index === previewIndex ? tab : item))
          : [...state.tabs, tab];
    } else {
      state.tabs = [...state.tabs, tab];
    }

    notify();
  }

  /**
   * 把编辑器里的当前内容存回它所属的标签。
   *
   * 只在切换 / 关闭标签时调用，而不是每次敲键都同步 ——
   * 后者会让每次输入都复制一遍整篇文本，长文档下这是白白的开销。
   * 切换点是唯一的"内容会离开编辑器"的时刻，守住它就够了。
   */
  function syncActiveTabBuffer(): void {
    const path = state.activePath;
    if (!path) return;
    const text = editor.getText();
    const dirty = state.dirty;
    state.tabs = state.tabs.map((tab) =>
      tab.path === path ? { ...tab, text, dirty } : tab,
    );
  }

  /**
   * 激活标签。
   *
   * **从标签的缓冲区取内容，不重新读盘** —— 重读会把未保存的修改冲掉，
   * 也会让"切回来"这个动作凭空多一次磁盘 IO。
   */
  function activateTab(path: string): void {
    if (state.activePath === path) return;
    const tab = state.tabs.find((item) => item.path === path);
    if (!tab) return;

    syncActiveTabBuffer();
    state.activePath = path;
    editor.setActiveFile(path, tab.language);
    loadingDocument = true;
    try {
      editor.replaceDocument(tab.text);
    } finally {
      loadingDocument = false;
    }
    state.dirty = tab.dirty;
    notify();
  }

  /**
   * 关闭标签。
   *
   * 关掉当前标签时必须**挑一个邻居激活**，不能让编辑器停在"无文档但
   * 标签栏还有别的标签"的状态 —— 那种状态下用户点任何东西都像没反应。
   * 挑邻居而不是跳到第一个：靠得近的通常就是他接下来想看的那个。
   */
  async function closeTab(path: string): Promise<void> {
    /*
     * 先把激活标签的缓冲区（文本 + dirty）写回 tab —— tab.dirty 平时
     * 不会随编辑实时更新（那会打坏崩溃恢复链路，实测过），只在切走/
     * 关闭前同步一次。不调这一步，"关闭非激活但改过的标签"检测不到脏，
     * 会静默丢内容（闸门用例实测暴露）。
     */
    syncActiveTabBuffer();
    const index = state.tabs.findIndex((item) => item.path === path);
    if (index < 0) return;

    /*
     * 未保存确认：标签带脏标记时先问，防误关丢改动。
     * showMessage 的返回值是被点击 action 的 label；undefined = 用户
     * 直接关掉提示 = 取消。
     */
    const closing = state.tabs[index];
    if (closing.dirty) {
      const name = path.startsWith('__untitled__') ? '未命名文档' : (path.split(/[\\/]/).pop() ?? path);
      const actions = [
        {
          label: '不保存并关闭',
          run: () => {
            /* 直接关；未命名文档的草稿已自动保存，不会真丢 */
          },
        },
      ];
      const isCurrent = state.activePath === path;
      if (isCurrent && !path.startsWith('__untitled__')) {
        actions.push({ label: '保存并关闭', run: () => {} });
      }
      const choice = await windowService.showMessage(`「${name}」有未保存的修改。`, {
        level: 'warning',
        actions,
      });
      if (choice === undefined) return;
      if (choice === '保存并关闭') await saveActiveFile();
    }

    const closingActive = state.activePath === path;
    // 关掉当前标签之前先把它缓冲区的修改存回来 ——
    // 虽然它马上要走了，但用户在它里面的修改不该凭空消失
    // （万一他反悔，草稿与缓冲区仍然是可用的证据）。
    if (closingActive) syncActiveTabBuffer();

    const next = state.tabs.filter((item) => item.path !== path);
    state.tabs = next;

    if (!closingActive) {
      notify();
      return;
    }

    const neighbour = next[index] ?? next[index - 1] ?? null;
    if (!neighbour) {
      /*
       * 一个标签都不剩。此时编辑器留一份空白未命名文档，
       * 而不是把最后的内容也清掉 —— 那会让"关标签"看起来像"删了东西"。
       */
      state.activePath = null;
      loadingDocument = true;
      try {
        editor.replaceDocument('');
      } finally {
        loadingDocument = false;
      }
      state.dirty = false;
      notify();
      return;
    }

    /*
     * 先把 activePath 清掉，再交给 activateTab。
     *
     * activateTab 开头有"路径相同就直接返回"的短路 —— 而此刻
     * activePath 还指着刚被关掉的那个路径，不清的话它会认为
     * "已经在这个标签上了"，于是什么都不做，编辑器停在已关闭文档的内容上。
     */
    state.activePath = null;
    activateTab(neighbour.path);
  }

  /**
   * 新建空白未命名标签（Tab 栏的「+」按钮）。
   *
   * **每次点击都开一个新的** —— 与浏览器 / VSCode 一致：连开三个草稿
   * 是真实诉求（"这段先放一边，开个新的记另一件事"），把第二次点击
   * 变成"激活已有的"是上一版的设计错误（用户实测后打回）。
   *
   * 路径用 `__untitled__-N` 递增序号（tabs 按 path 索引，重复会互相顶替）；
   * 与草稿键 DRAFT_KEY 同前缀，未命名文档的保存/草稿机制天然兼容。
   * 显示名在 TabBar 里特判（Untitled.md / Untitled 2.md / …）。
   */
  function createUntitledTab(): void {
    syncActiveTabBuffer();
    let maxN = 0;
    for (const item of state.tabs) {
      const match = /^__untitled__-(\d+)$/.exec(item.path);
      if (match) maxN = Math.max(maxN, Number(match[1]));
    }
    const path = `__untitled__-${maxN + 1}`;
    const tab: EditorTab = {
      path,
      language: 'markdown',
      preview: false,
      text: '',
      dirty: false,
    };
    state.tabs = [...state.tabs, tab];
    state.activePath = path;
    editor.setActiveFile(path, 'markdown');
    loadingDocument = true;
    try {
      editor.replaceDocument('');
    } finally {
      loadingDocument = false;
    }
    state.dirty = false;
    notify();
  }

  /** 被用户手动禁用的插件 id 集合（localStorage 持久化）。 */
  /** 插件禁用集合的真源是配置（settings.jsonc 的 plugins.disabled）。 */
  function loadDisabledPlugins(): string[] {
    return currentSettings.plugins.disabled;
  }

  function saveDisabledPlugins(ids: string[]): void {
    updateSettings({ plugins: { disabled: ids } });
  }

  function setPluginEnabled(pluginId: string, enabled: boolean): void {
    const current = new Set(loadDisabledPlugins());
    if (enabled) {
      current.delete(pluginId);
      saveDisabledPlugins([...current]);
      void windowService.showMessage(
        `已记录启用「${pluginId}」。插件贡献需要重新声明，**重启应用后生效**。`,
        { level: 'info' },
      );
      return;
    }
    current.add(pluginId);
    saveDisabledPlugins([...current]);
    // 立即生效：撤销该插件的命令/视图，并把状态标成 disabled
    host.disable(pluginId, '用户手动禁用');
    void windowService.showMessage(`已禁用「${pluginId}」。`, { level: 'info' });
  }

  /*
   * ── 外部插件（用户导入）────────────────────────────────────
   *
   * 存储：IndexedDB 的 kv store，单键 `aropyt.externalPlugins` 存数组
   *（插件数量很少，没必要单开一个 object store 与版本升级）。
   * 执行：Blob URL 动态 import —— 插件代码在渲染进程里以完整权限运行，
   * 与 VS Code 插件同级别信任模型（不是沙箱）。CSP 已放开 `blob:`。
   */
  /*
 * 外部插件存储键（模块作用域）。
 *
 * 原来是 createRuntime 函数体内的 const —— 启动 IIFE 在函数同步体早期
 * 就被调用，而 const 初始化在函数体后段：闭包一访问就是 TDZ
 * ReferenceError；再叠加启动早期 showMessage 不可用，错误彻底隐身，
 * 症状是"插件列表空白、没有任何提示"（实测两轮）。
 */
const EXTERNAL_PLUGINS_KEY = 'aropyt.externalPlugins';

interface StoredExternalPlugin {
    manifest: PluginManifest;
    code: string;
  }

  async function readExternalPlugins(): Promise<StoredExternalPlugin[]> {
    try {
      return (await idbGet<StoredExternalPlugin[]>(STORE.kv, EXTERNAL_PLUGINS_KEY)) ?? [];
    } catch (error) {
      /* 读不到要能看见 —— 之前的 catch(() => undefined) 把错误变成了"没有插件" */
      console.error('[plugins] 读取外部插件存储失败', error);
      return [];
    }
  }

  async function loadExternalPlugins(): Promise<void> {
    const rows = await readExternalPlugins();
    const externals: LoadablePlugin[] = [];

    for (const row of rows) {
      try {
        const url = URL.createObjectURL(new Blob([row.code], { type: 'text/javascript' }));
        try {
          const mod = (await import(/* @vite-ignore */ url)) as {
            activate?: (context: unknown) => void | Promise<void>;
            deactivate?: () => void | Promise<void>;
          };
          if (typeof mod.activate !== 'function') continue;
          /*
           * ⚠️ 必须是**平铺字段**（manifest / activate / deactivate）——
           * LoadablePlugin 的接口就是这样定义的。之前写成
           * `{ manifest, module: { activate } }`，而 host.load() 读的是
           * `plugin.activate` → 永远是 undefined → 走"假激活"分支：
           * 面板显示已启用，但一条命令都没注册（实测多轮的根因）。
           */
          externals.push({
            manifest: row.manifest,
            activate: mod.activate as never,
            deactivate: mod.deactivate,
          });
        } finally {
          URL.revokeObjectURL(url);
        }
      } catch (error) {
        /*
         * 单个外部插件加载失败只影响它自己 —— 但**不能跳过记录**：
         * 用户需要在插件面板里看到"这个插件坏了"以及原因，
         * 否则只能靠猜。
         */
        console.error('[plugins] 外部插件加载失败', row.manifest?.id, error);
      }
    }

    if (externals.length > 0) {
      /*
       * ⚠️ 必须与内置插件**合并后一次性 load**。
       *
       * `host.load()` 每次都会 `#rebuildContributions(accepted)`，用传入的
       * 这组插件**重建**整个贡献集。之前是"每个外部插件单独 load 一次"，
       * 结果最后一个外部插件的贡献把内置插件（explorer / outline / file /
       * formatting）的贡献全部覆盖掉 —— 工具栏清空、侧栏打不开、
       * 文件操作只剩保存，重启必复发（v0.0.9 实测事故的直接原因）。
       */
      host.load([...(options.plugins ?? builtinPlugins), ...externals]);

      /*
       * 应用用户的禁用名单（settings.jsonc 的 plugins.disabled）。
       *
       * 之前禁用只写了配置、从来没人读 —— 面板点"禁用"、重启后照样启用
       * （实测）。必须在 load 之后、activateFor 之前把名单里那些插件
       * 主动 disable 掉，否则"已禁用"只是一次性的内存状态。
       */
      const disabledIds = new Set(currentSettings.plugins.disabled);
      for (const plugin of externals) {
        if (disabledIds.has(plugin.manifest.id)) {
          host.disable(plugin.manifest.id, '已在插件面板中禁用');
        }
      }
    }
  }


/**
 * 校验插件清单的贡献声明（导入前）。
 *
 * 只做结构检查 —— 不执行插件代码、不 import 模块。目的是把"注定会让
 * 宿主启动失败"的清单挡在存储之外：结构合法之后，即使插件的
 * activate 抛错，也只会影响它自己（plugin-host 已逐插件隔离）。
 */
function validateContributions(manifest: PluginManifest): void {
  const contributes = manifest.contributes as Record<string, unknown> | undefined;
  if (contributes === undefined) return;
  if (contributes === null || typeof contributes !== 'object') {
    throw new Error('manifest.contributes 必须是对象');
  }

  /*
   * 结构分两类，别混（第一版把它们全当数组，导致正规插件被拒）：
   *   数组：commands / keybindings / views
   *   对象：menus（值必须是数组）/ configuration（值必须是对象）
   */
  for (const key of ['commands', 'keybindings', 'views']) {
    const value = contributes[key];
    if (value !== undefined && !Array.isArray(value)) {
      throw new Error(`contributes.${key} 必须是数组`);
    }
  }

  const menus = contributes.menus as Record<string, unknown> | undefined;
  if (menus !== undefined) {
    if (menus === null || typeof menus !== 'object' || Array.isArray(menus)) {
      throw new Error('contributes.menus 必须是对象（键是菜单位置，值是数组）');
    }
    for (const [location, items] of Object.entries(menus)) {
      if (!Array.isArray(items)) {
        throw new Error(`contributes.menus.${location} 必须是数组`);
      }
    }
  }

  const configuration = contributes.configuration as
    | { properties?: Record<string, unknown> }
    | undefined;
  if (configuration !== undefined) {
    if (
      configuration === null ||
      typeof configuration !== 'object' ||
      Array.isArray(configuration)
    ) {
      throw new Error('contributes.configuration 必须是对象');
    }
    /*
     * 必须是 `{ properties: { ... } }` —— 扁平写法会在注册时
     * Object.entries(undefined) 抛 "Cannot convert undefined or null
     * to object"，把整个插件的贡献声明打掉（实测）。
     */
    const properties = configuration.properties;
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
      throw new Error('contributes.configuration 需要一个 properties 对象');
    }
  }

  for (const command of (contributes.commands as unknown[] | undefined) ?? []) {
    const item = command as { id?: unknown; title?: unknown };
    if (typeof item?.id !== 'string' || typeof item?.title !== 'string') {
      throw new Error('commands 每一项都需要 id 与 title（字符串）');
    }
  }

  const VIEW_LOCATIONS = ['sidebar', 'main', 'right'];
  for (const view of (contributes.views as unknown[] | undefined) ?? []) {
    const item = view as { id?: unknown; title?: unknown; location?: unknown };
    if (typeof item?.id !== 'string' || typeof item?.title !== 'string') {
      throw new Error('views 每一项都需要 id 与 title（字符串）');
    }
    if (typeof item?.location !== 'string' || !VIEW_LOCATIONS.includes(item.location)) {
      throw new Error(`views 的 location 必须是 ${VIEW_LOCATIONS.join(' / ')} 之一`);
    }
  }
}


  /**
   * 删除外部插件（v0.1.0）。
   *
   * 安全模式存在的意义就是"坏了能自救" —— 所以删除必须能从 UI 完成，
   * 不能依赖改文件或重装。删除后立即记入禁用名单（本次运行不再激活），
   * 重启时它已不在存储里，贡献彻底消失。
   */
  async function deleteExternalPlugin(pluginId: string): Promise<void> {
    const rows = await readExternalPlugins();
    const next = rows.filter((row) => row.manifest?.id !== pluginId);
    await idbSet(STORE.kv, EXTERNAL_PLUGINS_KEY, next);

    const disabled = new Set(currentSettings.plugins.disabled);
    disabled.add(pluginId);
    updateSettings({ plugins: { disabled: [...disabled] } });

    void windowService.showMessage(`已删除插件「${pluginId}」，重启后彻底移除。`, {
      level: 'info',
    });
  }

  function importExternalPlugin(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.js,.mjs';
    input.onchange = () => {
      void (async () => {
        const file = input.files?.[0];
        if (!file) return;
        const code = await file.text();
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        try {
          const mod = (await import(/* @vite-ignore */ url)) as {
            manifest?: PluginManifest;
            activate?: unknown;
          };
          const manifest = mod.manifest;
          if (!manifest?.id || !manifest?.name) {
            throw new Error('插件缺少 manifest（需要 id 与 name）');
          }
          if (typeof mod.activate !== 'function') {
            throw new Error('插件缺少 activate 导出');
          }
          /*
           * 贡献声明预校验（v0.1.0）。
           *
           * 坏插件在入库前就要拦住 —— 写进存储后再崩，用户只能清数据
           * （这是 v0.0.9 那个"导入插件后工具栏全空"事故的教训）。
           * 这里只校验结构，不执行任何插件代码。
           */
          validateContributions(manifest);
          const rows = await readExternalPlugins();
          const next = [
            ...rows.filter((row) => row.manifest.id !== manifest.id),
            { manifest, code },
          ];
          await idbSet(STORE.kv, EXTERNAL_PLUGINS_KEY, next);
          void windowService.showMessage(
            `已导入插件「${manifest.name}」。重启应用后生效。`,
            { level: 'info' },
          );
        } catch (error) {
          void windowService.showMessage(
            `导入失败：${error instanceof Error ? error.message : '未知错误'}`,
            { level: 'error' },
          );
        } finally {
          URL.revokeObjectURL(url);
        }
      })();
    };
    input.click();
  }

  /**
   * vim 模式开关。开关状态落 localStorage（同步，下一帧就生效，
   * 也在下次启动时先于编辑器创建被读到）。
   */
  /** vim 子模式：从编辑器读，轮询比较（库没有模式变更回调可用）。 */
  function readVimSubMode(): string | null {
    return editor.getVimSubMode();
  }

  let lastVimSubMode: string | null = null;
  setInterval(() => {
    const next = readVimSubMode();
    if (next !== lastVimSubMode) {
      lastVimSubMode = next;
      notify();
    }
  }, 250);

  /*
   * ── 用户配置（settings.jsonc）────────────────────────────
   * 桌面壳读写 appConfigDir/settings.jsonc；浏览器开发模式回落 IndexedDB。
   * 第一版只在启动时读取/生成，UI 里的修改下一轮接入。
   */
  let settingsIo: SettingsIo = browserSettingsIo;
  let settingsPathValue: string | null = null;
  /** 配置的真相：运行时状态由它派生（theme / vim / sidebar）。 */
  let currentSettings: AppSettings = structuredClone(DEFAULT_SETTINGS);

  /** 把配置应用到运行时（启动与每次修改都走这里，保证单一入口）。 */
  function applySettings(next: AppSettings): void {
    currentSettings = next;
    theme.set(next.theme);
    if (state.vimMode !== next.vim.enabled) {
      state.vimMode = next.vim.enabled;
      editor.setVimMode(next.vim.enabled);
    }
    restartHistoryTimer();
  }

  /*
   * 编辑历史的**自动保存**：每 interval 秒把当前内容记一个版本。
   * 内容没变不会产生新版本（recordVersion 有哈希去重），成本几乎为零。
   * interval 改变（配置更新）时要重启定时器 —— 统一走
   * applySettings → restartHistoryTimer，保证单一入口。
   */
  let historyTimer: ReturnType<typeof setInterval> | null = null;

  function restartHistoryTimer(): void {
    if (historyTimer) {
      clearInterval(historyTimer);
      historyTimer = null;
    }
    if (!currentSettings.history.autoSave) return;
    const ms = Math.max(10, currentSettings.history.autoSaveInterval) * 1000;
    historyTimer = setInterval(() => void recordCurrentVersion(), ms);
  }

  function mergeSettings(patch: DeepPartial<AppSettings>): AppSettings {
    return {
      ...currentSettings,
      ...patch,
      editor: { ...currentSettings.editor, ...(patch.editor ?? {}) },
      vim: { ...currentSettings.vim, ...(patch.vim ?? {}) },
      sidebar: { ...currentSettings.sidebar, ...(patch.sidebar ?? {}) },
      plugins: { ...currentSettings.plugins, ...(patch.plugins ?? {}) },
      history: { ...currentSettings.history, ...(patch.history ?? {}) },
    };
  }

  function updateSettings(patch: DeepPartial<AppSettings>): void {
    const next = mergeSettings(patch);
    applySettings(next);
    notify();
    // 落盘失败必须可见：这是"界面改了但下次启动又回去了"的唯一原因
    void saveSettings(settingsIo, next).catch((error: unknown) => {
      const detail =
        error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
      void windowService.showMessage(`配置保存失败：${detail}`, { level: 'error' });
    });
  }
  /** 配置文件初始化失败的原因（桌面壳下失败必须如实报出来，不能伪装成"浏览器模式"）。 */
  let settingsInitError: string | null = null;

  function openSettingsFile(): void {
    if (!settingsPathValue) {
      void windowService.showMessage(
        hasTauri()
          ? `配置文件不可用：${settingsInitError ?? '未知原因'}`
          : '浏览器模式下没有配置文件（桌面版才有磁盘配置）。',
        { level: hasTauri() ? 'error' : 'info' },
      );
      return;
    }
    void settingsIo.openExternal().catch((error: unknown) => {
      /*
       * Tauri 的 IPC 错误经常是**字符串**而不是 Error（权限拒绝就是
       * "opener.open_path not allowed"）。上一版只取 error.message，
       * 于是全都显示成"未知错误"，把排查引向错误方向。
       */
      const detail =
        error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
      void windowService.showMessage(`打开配置文件失败：${detail}（路径：${settingsPathValue}）`, {
        level: 'error',
      });
    });
  }

  /*
   * ── 编辑历史（v0.0.7）────────────────────────────────────
   * 保存即版本；恢复前先把当前内容存成新版本，所以任何操作都不丢内容。
   * 未命名文档没有稳定标识，不记录历史（__untitled__ 每次序号都不同）。
   */
  function historyKey(): string | null {
    const path = state.activePath;
    if (!path || path.startsWith('__untitled__')) return null;
    return path;
  }

  async function recordCurrentVersion(label?: string): Promise<void> {
    const key = historyKey();
    if (!key) return;
    // 外部文件用绝对路径作为键（与工作区相对路径天然区分）
    await recordVersion(key, editor.getText(), currentSettings.history.limit, label).catch(() => undefined);
  }

  async function listHistory(path: string) {
    return listVersions(path).catch(() => []);
  }

  async function restoreHistory(id: string): Promise<void> {
    const version = await getVersion(id).catch(() => null);
    if (!version) {
      void windowService.showMessage('该版本已不存在（可能已被更早的版本淘汰）', { level: 'warning' });
      return;
    }
    /*
     * 恢复前先给**当前内容**留一个版本 —— 否则"恢复到旧版"这个动作本身
     * 就把最新的编辑抹掉了，这是编辑历史最不可接受的失败方式。
     */
    await recordCurrentVersion(`恢复前快照 ${new Date().toLocaleTimeString()}`);
    loadingDocument = true;
    try {
      editor.replaceDocument(version.text);
    } finally {
      loadingDocument = false;
    }
    state.dirty = true;
    notify();
  }

  async function snapshotHistory(label: string): Promise<void> {
    await recordCurrentVersion(label.trim() || '手动版本');
    notify();
  }

  async function exportBackup(): Promise<void> {
    /*
     * 整个函数包一层统一错误处理：
     * assembleBackup（读 IndexedDB）、对话框、写文件，任何一步抛错
     * 都必须显示出来 —— onClick 那边是 `void` 调用，不接 Promise，
     * 这里不兜住就成了 unhandled rejection，表现是"点了没反应"（实测）。
     */
    try {
      const data = await assembleBackup();
      const date = new Date().toISOString().slice(0, 10);
      const picked = await invokeNative<string | null>('plugin:dialog|save', {
        options: {
          defaultPath: `aropyt-backup-${date}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        },
      });
      if (!picked) return;
      await invokeNative('backup_write', { path: picked, text: JSON.stringify(data, null, 2) });
      void windowService.showMessage(`数据已导出到 ${picked}`, { level: 'info' });
    } catch (error: unknown) {
      const detail =
        error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
      void windowService.showMessage(`导出失败：${detail}`, { level: 'error' });
    }
  }

  async function importBackup(): Promise<void> {
    try {
      await importBackupInner();
    } catch (error: unknown) {
      const detail =
        error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
      void windowService.showMessage(`导入失败：${detail}`, { level: 'error' });
    }
  }

  async function importBackupInner(): Promise<void> {
    const picked = await invokeNative<string | null>('plugin:dialog|open', {
      options: { multiple: false, filters: [{ name: 'JSON', extensions: ['json'] }] },
    }).catch((error: unknown) => {
      throw new Error(
        error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error),
      );
    });
    if (!picked) return;
    const text = await invokeNative<string>('backup_read', { path: picked }).catch((error: unknown) => {
      throw new Error(
        error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error),
      );
    });
    let data: import('@aropyt/core').BackupFile;
    try {
      data = JSON.parse(text) as import('@aropyt/core').BackupFile;
    } catch {
      throw new Error('备份文件不是有效的 JSON');
    }
    const counts = `草稿 ${Object.keys(data.drafts ?? {}).length} 份 · 历史 ${(data.history ?? []).length} 个版本`;
    const ok = await invokeNative<boolean>('plugin:dialog|ask', {
      options: {
        title: '导入数据',
        message: `将导入 ${counts}，并**覆盖**当前所有草稿与编辑历史。确定继续？`,
        kind: 'warning',
        okButtonLabel: '导入',
        cancelButtonLabel: '取消',
      },
    }).catch(() => false);
    if (!ok) return;
    const result = await applyBackup(data);
    void windowService.showMessage(
      `导入完成：${result.drafts} 份草稿、${result.history} 个历史版本。重启应用后生效。`,
      { level: 'info' },
    );
  }

  /**
   * 打开工作区之外的文件。
   *
   * 文件关联（双击 .md）与命令行传入都走这里：读文件 → 建标签 → 激活。
   * 标签的 path 就是**绝对路径**，与工作区文件的相对路径天然区分开
   * （保存逻辑据此走 write_external_file）。
   */
  async function openExternalPath(path: string): Promise<void> {
    try {
      const text = await invokeNative<string>('read_external_file', { path });
      if (!state.tabs.some((tab) => tab.path === path)) {
        state.tabs.push({
          path,
          language: guessLanguage(path),
          preview: false,
          text,
          dirty: false,
        });
      }
      activateTab(path);
    } catch (error: unknown) {
      const detail =
        error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
      void windowService.showMessage(`打开文件失败：${detail}`, { level: 'error' });
    }
  }

  function activateRelativeTab(delta: number): void {
    if (state.tabs.length < 2) return;
    const index = state.tabs.findIndex((tab) => tab.path === state.activePath);
    if (index < 0) return;
    const next = state.tabs[(index + delta + state.tabs.length) % state.tabs.length];
    if (next) void activateTab(next.path);
  }

  function toggleVimMode(): void {
    // 走配置系统：settings.jsonc 才是真源（不再单独写 localStorage）
    updateSettings({ vim: { enabled: !state.vimMode } });
  }

  /**
   * 给"另存为"对话框猜一个默认文件名。
   *
   * 从文档第一个标题取名字比一律叫"Untitled.md"友好得多 ——
   * 用户通常就是照着标题命名的，改两个字比从空白框开始想快。
   *
   * 必须把 Windows 文件名里非法的字符剔除（`\ / : * ? " < > |`），
   * 否则标题里带个问号就会让保存对话框弹出失败。
   */
  function suggestedFileName(): string {
    const firstLine = (editor.getText().split('\n')[0] ?? '').trim();
    const heading = /^#{1,6}\s+(.+)$/.exec(firstLine)?.[1];
    const base = (heading ?? '')
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    return base ? `${base}.md` : 'Untitled.md';
  }

  async function saveActiveFile(): Promise<void> {
    /*
     * 保存即版本：把**当前内容**记一条历史（去重逻辑在 recordVersion 里，
     * 内容没变不会产生新版本）。放在最前面是因为"要保存的内容"就是
     * 此刻编辑器里的文本 —— 与后续走哪条分支（工作区/外部/另存为）无关。
     */
    void recordCurrentVersion();
    let workspace = state.workspace;
    let path = state.activePath;

    /*
     * 外部文件（文件关联打开的）走独立通道：
     * 它的 path 是**绝对路径**，而工作区 API 只接受相对路径（Rust 侧
     * 拒绝绝对路径是防路径穿越的设计）。直接调 write_external_file
     * 写回原位置 —— 这正是"双击 .md 编辑后 Ctrl+S"该有的行为。
     */
    if (path && /^[a-zA-Z]:[\\/]|^\//.test(path)) {
      const text = editor.getText();
      try {
        await invokeNative('write_external_file', { path, text });
        // EditorTab 是只读结构：替换对象而不是就地改字段
        state.tabs = state.tabs.map((item) =>
          item.path === path ? { ...item, text, dirty: false } : item,
        );
        state.dirty = false;
      } catch (error: unknown) {
        const detail =
          error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
        await windowService.showMessage(`保存失败：${detail}`, { level: 'error' });
      }
      notify();
      return;
    }
    /*
     * 未命名标签（__untitled__-N）没有磁盘身份，必须强制走"另存为"。
     * 上一版只判了 `!path` —— 加号按钮引入带序号的未命名标签后，
     * path 非空，保存会直接把 `__untitled__-2` 当文件名写进工作区。
     */
    if (path && path.startsWith('__untitled__')) path = null;

    /*
     * 记下"保存前草稿挂在哪个键上"。
     *
     * 未命名文档的草稿键是 `__untitled__`，而另存为之后 `activePath`
     * 变成了新文件名 —— 保存成功时若只删新键的草稿，那份 `__untitled__`
     * 就永远留在库里，下次启动会被当成"上次未保存的内容"再恢复一遍。
     * 落盘之后它的使命就结束了，两个键都得清。
     */
    const draftKeyBeforeSave = path ?? DRAFT_KEY;

    /*
     * 没有关联路径 = 未命名文档（刚启动的应用就是这个状态）。
     *
     * 保存它只缺一个"存到哪"，这就是另存为。此前这条分支只弹一句
     * "请先在左侧文件树里点一个 markdown 文件再保存"—— 那等于
     * **把系统的限制说成用户的错**：用户只是想把正在写的东西存下来，
     * 而"存到哪"本来就该由保存这个动作问出来。
     *
     * 拿到路径后要**重建工作区**：工作区 API 的契约是只接受相对根目录的
     * 路径（Rust 侧 `resolve` 直接拒绝绝对路径，那是防路径穿越的设计）。
     * 所以把目标文件所在目录作为新的根、文件名作为相对路径 ——
     * 与"打开文件"走的是同一套做法，行为一致。
     */
    if (!path) {
      const picked = await pickSavePathNative(suggestedFileName());
      if (!picked) return; // 用户取消：不是一个错误，静默返回

      const segments = picked.split(/[\\/]/).filter(Boolean);
      const fileName = segments.pop();
      if (!fileName) {
        await windowService.showMessage('这个保存位置不可用，请换一个。', { level: 'error' });
        return;
      }

      const opened = await openNativeFolderAsWorkspace(segments.join('\\'));
      if (!opened) {
        await windowService.showMessage('无法写入这个位置。', { level: 'error' });
        return;
      }

      workspace = opened;
      state.workspace = opened;
      resetAssetCache();
      path = fileName;
      state.activePath = path;
      editor.setActiveFile(path, guessLanguage(picked));
      /*
       * 另存为之后这个文档才算有了身份，给它建一个**固定**标签。
       *
       * 之前它没有标签（未命名文档不在标签栏里），现在它是磁盘上一个
       * 真实的文件了 —— 而且不该是预览标签：用户刚刚明确选了保存位置，
       * 下一次单击文件树不该把它顶掉。
       */
      state.tabs = [
        ...state.tabs,
        {
          path,
          language: guessLanguage(picked),
          preview: false,
          text: editor.getText(),
          dirty: true,
        },
      ];
      emitWorkspaceChange();
      notify();
    }

    if (!workspace) {
      await windowService.showMessage('请先打开一个文件夹作为工作区。', { level: 'warning' });
      return;
    }

    try {
      // createWritable 内部是"写临时文件 → close 时提交"，等价于原子替换。
      // 这是 Web 侧唯一能拿到的原子性保证，且是浏览器给的，不是我实现的。
      await workspace.write(path, editor.getText());
    } catch (error) {
      await windowService.showMessage(`保存失败：${path}`, { level: 'error' });
      console.error(error);
      return;
    }

    /*
     * ⚠️ 必须**先取消待执行的草稿写入，再删草稿**。
     *
     * `persistDraft` 是 300ms 防抖的。保存几乎总是紧跟在输入之后，
     * 所以此刻大概率有一个还没触发的写入挂在那里 —— 顺序反过来的话，
     * 它会在这之后把刚删掉的草稿**又写回去**，而且 `at` 是更新后的时刻。
     *
     * 那份草稿的内容与磁盘相同（所以下次打开不会误恢复），但它带着
     * 一个"比文件新"的时间戳；一旦文件之后在别处被改动，
     * 这份草稿就会被判定成"未保存的修改"而覆盖磁盘。
     */
    persistDraft.cancel();
    await idbDelete(STORE.drafts, path).catch(() => undefined);
    if (draftKeyBeforeSave !== path) {
      // 另存为：把"未命名"那个槽也清掉（见上面 draftKeyBeforeSave 的说明）
      await idbDelete(STORE.drafts, draftKeyBeforeSave).catch(() => undefined);
    }
    editor.notifySaved(path);
    state.dirty = false;
    // 缓冲区跟着更新：`dirty` 归零这件事也得落回标签，
    // 否则切走再切回来时它还以为这份是脏的。
    syncActiveTabBuffer();
    notify();

    /*
     * 保存成功也必须有反馈。
     *
     * 状态栏那个"脏点"消失太安静了：点击保存后如果什么都不动，
     * 用户无法区分"保存成功"与"保存根本没发生" —— 而这个项目里
     * 后者恰恰是最常见的静默故障。宁可多一条 5 秒自动消失的提示。
     */
    await windowService.showMessage(`已保存 ${path}`, { level: 'info' });
  }

  async function regrantWorkspace(): Promise<boolean> {
    /*
     * 先尝试走完整的恢复流程，再退回 FSA 的重新授权。
     *
     * 顺序有讲究：FSA 的"重新授权"依赖 IndexedDB 里的目录句柄，
     * 而原生侧根本没有句柄 —— 它只需要路径，恢复是直接成功的。
     * 原来直接调 regrantLastWorkspace()，在 Tauri 下必然返回 null，
     * 于是用户看到"没有可恢复的文件夹"，尽管那个文件夹明明还在。
     */
    const lastId = configuration.get<string | null>('workspace.lastId', null);
    const restored = await restoreWorkspace(lastId);
    const workspace =
      restored.status === 'restored' ? restored.workspace : await regrantLastWorkspace();

    if (!workspace) {
      await windowService.showMessage('没有可恢复的文件夹，或用户拒绝了授权。', { level: 'warning' });
      return false;
    }
    state.workspace = workspace;
    resetAssetCache();
    state.activePath = null;
    emitWorkspaceChange();
    notify();
    return true;
  }

  // ── 启动 ──

  void (async () => {
    void requestPersistentStorage();
    /*
     * ⚠️ 配置必须先加载完，再加载插件。
     *
     * `plugins.disabled`（用户在插件面板里禁用的名单）就在配置里 ——
     * 之前插件加载跑在 configuration.load() 之前，读到的是默认空名单，
     * 于是"禁用插件、重启后照样启用"（实测）。
     */
    await configuration.load();


    /*
     * 必须把上次工作区的位置传进去。
     *
     * 原来这里是无参调用 —— FSA 能从 IndexedDB 自己找回目录句柄，所以看着没事；
     * 但原生侧没有可恢复的"句柄"，只有路径，无参恢复必然返回 none。
     * 于是 Tauri 下每次启动都是"未打开工作区"。
     */
    const lastId = configuration.get<string | null>('workspace.lastId', null);
    const restored = await restoreWorkspace(lastId);
    if (restored.status === 'restored') {
      state.workspace = restored.workspace;
      resetAssetCache();
      emitWorkspaceChange();
    } else if (restored.status === 'needs-regrant') {
      // 不静默弹权限框。等用户点击"恢复上次工作区"。
      notify();
    }

    // 只有真正需要视图或工具栏的插件在启动时激活；
    // 纯命令类插件等 onCommand 触发，启动开销为零。
    /*
     * 恢复用户的手动禁用：localStorage 里记的插件 id 在加载后立刻禁用，
     * 否则"禁用"只在本次会话有效、重启又全回来了。
     */
    for (const pluginId of loadDisabledPlugins()) {
      host.disable(pluginId, '用户手动禁用');
    }
    /*
     * 用户配置：桌面壳读写 appConfigDir/settings.jsonc，浏览器回落 IndexedDB。
     * 首次启动会把旧的 localStorage 值迁移进配置文件（只做一次）。
     */
    if (hasTauri()) {
      try {
        const io = await createTauriSettingsIo();
        settingsIo = io;
        settingsPathValue = io.path;
      } catch (error) {
        settingsPathValue = null;
        settingsInitError = error instanceof Error ? error.message : String(error);
      }
    }
    const loaded = await loadSettings(settingsIo).catch(() => null);
    if (loaded) {
      applySettings(loaded.settings);
      if (loaded.problems.unknownKeys.length > 0 || loaded.problems.invalidValues.length > 0) {
        void windowService.showMessage(
          `settings.jsonc 有 ${loaded.problems.unknownKeys.length + loaded.problems.invalidValues.length} 处问题，已按默认值处理`,
          { level: 'warning' },
        );
      }
    }
    /*
     * 插件加载与激活 —— **必须排在 loadSettings + applySettings 之后**。
     *
     * 用户在插件面板禁用插件写的是 settings.jsonc 的 plugins.disabled；
     * `currentSettings` 只有经过 applySettings 才带上真实值。之前这段
     * 排在 configuration.load() 之后（但仍在 loadSettings 之前），
     * 读到的 disabled 恒为空 → 禁用永远不生效（实测两轮）。
     */
    try {
      await loadExternalPlugins();
    } catch (error) {
      console.error('[plugins] 外部插件加载失败', error);
      void windowService.showMessage(
        `插件加载失败：${error instanceof Error ? error.message : String(error)}`,
        { level: 'warning' },
      );
    }
    await host.activateFor('onStartupFinished');

    const launchFile = await invokeNative<string | null>('take_launch_file').catch(() => null);
    if (launchFile) await openExternalPath(launchFile);
    notify();
  })();

  return runtime;
}

function guessLanguage(path: string): string | null {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'txt') return 'text';
  return null;
}

/**
 * Uint8Array → base64。
 *
 * 不能写成 `btoa(String.fromCharCode(...bytes))`：参数展开在数组长度
 * 超过约 6 万时会栈溢出（`Maximum call stack size exceeded`），
 * 而一张稍大的截图就有几十万字节 —— 那个报错看起来完全不像"图太大"。
 * 分块后再拼，块大小取 8KB：远低于上限，又不会产生太多中间字符串。
 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
