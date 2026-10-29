/**
 * 插件宿主。
 *
 * 它做三件事，而且刻意不多做：
 *
 *   1. 收集声明式贡献点（插件的代码此时一行都没跑）
 *   2. 按 activationEvents 惰性激活
 *   3. 给每个插件构造一个"门面 API"——注入 pluginId、挂上守卫
 *
 * 第 3 点是安全设计的核心：插件拿到的不是内核实例的引用，
 * 而是我们手工组装的对象。这样"归因"和"兜底"可以强制执行，
 * 而不是依赖插件自觉。
 */

import type {
  CapabilitySnapshot,
  CommandContribution,
  CommandDescriptor,
  CommandsApi,
  ConfigurationApi,
  Contributions,
  Disposable,
  Event,
  EditorApi,
  KeybindingContribution,
  LanguageContribution,
  LanguagesApi,
  Memento,
  PlatformKind,
  ShellKind,
  PluginContext,
  PluginManifest,
  ViewContribution,
  ViewProvider,
  WindowApi,
  WorkspaceApi,
  WorkspaceFileHandle,
} from '@aropyt/plugin-api';

import { DisposableStore, FailureTracker, guardAsync, guardSync, setFailureTracker } from '../safety.js';
import type { CommandRegistry } from './commands.js';
import type { ConfigurationStore } from './storage.js';
import type { EditorAdapter } from './editor.js';

export interface PluginModuleLike {
  activate?(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export interface LoadablePlugin {
  readonly manifest: PluginManifest;
  /**
   * 内置插件直接给出 activate/deactivate。
   * 外部插件将来走"读 plugin.json → 动态 import()"，宿主会把它规约成同一个形状，
   * 差别对上层不可见 —— 这正是加载器该干的事。
   */
  activate?(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export type PluginState = 'declared' | 'active' | 'disabled' | 'failed';

export interface PluginRecord {
  readonly manifest: PluginManifest;
  readonly module: PluginModuleLike;
  state: PluginState;
  reason?: string;
  failureCount: number;
}

export interface AggregatedContributions {
  readonly commands: readonly (CommandContribution & { readonly pluginId: string | null; readonly source: 'builtin' | 'plugin' })[];
  readonly keybindings: readonly (KeybindingContribution & { readonly pluginId: string | null })[];
  readonly views: readonly (ViewContribution & { readonly pluginId: string | null })[];
  /**
   * 语言贡献：扩展名 / 文件名 → language id。
   *
   * 宿主把它交给 `detectLanguage`，插件因此可以接管某个扩展名
   * （例如给 .fountain 一个专属 id），而不需要改内核。
   */
  readonly languages: readonly (LanguageContribution & { readonly pluginId: string | null })[];
  readonly menus: Readonly<Record<string, readonly { command: string; pluginId: string | null; group?: string; order?: number }[]>>;
}

export interface PluginHostServices {
  readonly platform: PlatformKind;
  readonly shell: ShellKind;
  readonly capabilities: CapabilitySnapshot;
  readonly apiVersion: string;
  readonly commands: CommandRegistry;
  readonly configuration: ConfigurationStore;
  readonly window: WindowApi;
  readonly languages: LanguagesApi;
  readonly editor: EditorAdapter;
  readonly getWorkspace: () => WorkspaceFileHandle | null;
  /** 宿主提供的工作区变更事件。Web 端拿不到文件监听，所以只有工作区本身的变化。 */
  readonly onDidChangeWorkspace: Event<{ readonly rootPath: string | null }>;
  readonly mementoFor: (pluginId: string) => Memento;
  readonly onStateChange: (record: PluginRecord) => void;
  /** 安全模式：全部插件都不加载。对应 VS Code 的 --disable-extensions。 */
  readonly safeMode: boolean;
}

export class PluginHost {
  readonly #records = new Map<string, PluginRecord>();
  readonly #contexts = new Map<string, { context: PluginContext; store: DisposableStore }>();
  #configDisposables: readonly Disposable[] = [];
  readonly #stateListeners = new Set<(record: PluginRecord) => void>();
  /** 正在激活中的插件，避免并发触发把 activate() 跑两遍。 */
  readonly #activating = new Map<string, Promise<boolean>>();
  #contributions: AggregatedContributions = {
    commands: [],
    keybindings: [],
    views: [],
    languages: [],
    menus: {},
  };

  readonly #failures: FailureTracker;

  constructor(private readonly services: PluginHostServices) {
    this.#failures = new FailureTracker(3, 60_000, (pluginId, count) => {
      const reason = `连续 ${count} 次异常，已自动禁用`;
      this.disable(pluginId, reason);

      /*
       * 必须显式告诉用户插件被禁用了。
       *
       * 禁用会连带撤销该插件声明的全部命令 —— 工具栏上对应的按钮
       * 会**静默**退回通用图标，用户看到的是"图标莫名其妙变了"，
       * 而真正的原因（某个插件被自动禁用）完全不可见。
       * 状态栏确实有个"N 个已禁用"的提示，但它太小、太容易被忽略，
       * 且与"图标变了"之间没有任何视觉关联。
       */
      const name = this.#records.get(pluginId)?.manifest.name ?? pluginId;
      void this.services.window
        .showMessage(
          `插件「${name}」${reason}。使用 ?safe 启动可跳过全部插件。`,
          { level: 'warning' },
        )
        .catch(() => undefined);
    });
    setFailureTracker(this.#failures);
    this.services.commands.setActivator((commandId) => this.#activateOwnerOfCommand(commandId));
  }

  get contributions(): AggregatedContributions {
    return this.#contributions;
  }

  get records(): readonly PluginRecord[] {
    return [...this.#records.values()];
  }

  onDidChangeState(listener: (record: PluginRecord) => void): Disposable {
    this.#stateListeners.add(listener);
    return {
      dispose: () => {
        this.#stateListeners.delete(listener);
      },
    };
  }

  /**
   * 登记插件。此时**只读清单，不执行代码**。
   *
   * 安全模式下插件只进 records 不进贡献点，也不生成 API 版本门控提示 ——
   * 因为在安全模式里"这个插件装了什么"本身就是不该展示的信息。
   */
  load(plugins: readonly LoadablePlugin[]): void {
    if (this.services.safeMode) {
      for (const { manifest } of plugins) {
        this.#records.set(manifest.id, {
          manifest,
          module: { activate: undefined, deactivate: undefined },
          state: 'disabled',
          reason: '安全模式已启用，所有插件均被禁用',
          failureCount: 0,
        });
      }
      return;
    }

    /*
     * 逐插件隔离（v0.1.0）。
     *
     * 外部插件的 manifest 来自运行时（可能被手改、可能是坏的 JS 产物），
     * 不能按 TS 类型信任。之前的实现里任何一处抛错都会中断整个循环，
     * 后面的插件（包括内置 explorer / outline / file / formatting）
     * 全部不加载 —— 表现就是"工具栏清空、侧栏打不开、文件菜单只剩保存"，
     * 而且重启后必然复发，只能卸载软件（实测）。
     *
     * 现在的规则：**一个插件坏，只影响它自己**。
     */
    let unmet: Map<string, readonly string[]> = new Map();
    try {
      unmet = this.#checkCapabilities(plugins);
    } catch (error) {
      console.error('[plugin-host] 能力检查失败，降级为全部通过', error);
    }

    const accepted: LoadablePlugin[] = [];

    for (const plugin of plugins) {
      const manifest = plugin?.manifest;
      if (
        !manifest ||
        typeof manifest.id !== 'string' ||
        manifest.id.length === 0 ||
        typeof manifest.name !== 'string'
      ) {
        console.error('[plugin-host] 跳过非法插件清单', manifest);
        continue;
      }
      const missing = unmet.get(plugin.manifest.id);
      if (missing && missing.length > 0) {
        this.#records.set(plugin.manifest.id, {
          manifest: plugin.manifest,
          module: { activate: plugin.activate, deactivate: plugin.deactivate },
          state: 'disabled',
          reason: `当前平台不满足所需能力：${missing.join('、')}`,
          failureCount: 0,
        });
        continue;
      }
      this.#records.set(plugin.manifest.id, {
        manifest: plugin.manifest,
        module: { activate: plugin.activate, deactivate: plugin.deactivate },
        state: 'declared',
        failureCount: 0,
      });
      accepted.push(plugin);
    }

    this.#rebuildContributions(accepted);
  }

  /**
   * 触发式激活：把事件名与插件的 activationEvents 做匹配。
   * 未激活的插件不会被调用 —— 这就是"装了 100 个插件启动零开销"的实现。
   */
  async activateFor(event: string): Promise<void> {
    if (this.services.safeMode) return;

    for (const record of this.#records.values()) {
      if (record.state !== 'declared') continue;
      if (!(record.manifest.activationEvents as readonly string[]).includes(event)) continue;
      await this.activate(record.manifest.id);
    }
  }

  async activate(pluginId: string): Promise<boolean> {
    /*
     * **并发去重**：同一个插件可能在同一帧里被两个激活事件同时命中
     * （打开 .tex 时 `onLanguage:latex` 与 `onView:…structure` 几乎同时到达）。
     *
     * 没有这一层时，`record.state` 在 `await activate()` 完成前一直是
     * declared，两次调用都会通过检查 —— 结果视图注册两次、编辑器扩展
     * 注入两次。实测表现是行级装饰的 class 重复（`cm-tex-section
     * cm-tex-section`），以及多一份无法回收的订阅。
     */
    const existing = this.#activating.get(pluginId);
    if (existing) return existing;

    const task = this.#activateOnce(pluginId).finally(() => {
      this.#activating.delete(pluginId);
    });
    this.#activating.set(pluginId, task);
    return task;
  }

  async #activateOnce(pluginId: string): Promise<boolean> {
    const record = this.#records.get(pluginId);
    if (!record || record.state !== 'declared') return false;

    if (!record.module.activate) {
      /*
       * 没有 activate 导出**不是**"激活成功"。
       *
       * 之前这里直接置 active —— 面板显示"已启用"，但插件没有机会注册
       * 任何命令处理器，点命令永远报"未注册"（实测多轮的假象）。
       */
      record.state = 'failed';
      record.reason = '插件没有导出 activate 函数';
      this.#notify(record);
      return false;
    }

    const store = new DisposableStore();
    const context = this.#createContext(pluginId, store);

    /*
     * 先不置 active：activate 失败必须留下痕迹。
     *
     * 之前先设 state='active' 再 await，而异常被 guardAsync 吞掉 ——
     * 结果插件"看起来是启用的"，但它的命令处理器一个都没注册，
     * 点命令只报"未注册或未激活"，面板上也没有任何原因（实测）。
     */
    try {
      await record.module.activate(context);
      record.state = 'active';
      this.#contexts.set(pluginId, { context, store });

      /*
       * 激活后校验：清单里声明的命令是否真的注册上了。
       * "激活成功但处理器缺失"是最难查的一类故障（表现与"未激活"相同），
       * 在这里直接暴露成 failed + 具体命令名。
       */
      const missing = (record.manifest.contributes?.commands ?? [])
        .map((command) => command.id)
        .filter((id) => !this.services.commands.has(id));
      if (missing.length > 0) {
        record.state = 'failed';
        record.reason = `激活后未注册这些命令：${missing.join(', ')}`;
      }
    } catch (error) {
      store.dispose();
      record.state = 'failed';
      record.reason = `激活失败：${error instanceof Error ? error.message : String(error)}`;
      console.error(`[plugin-host] 插件 ${pluginId} 激活失败`, error);
    }

    this.#notify(record);
    return record.state === 'active';
  }

  async deactivate(pluginId: string): Promise<void> {
    const entry = this.#contexts.get(pluginId);
    const record = this.#records.get(pluginId);
    if (!entry || !record) return;

    await guardAsync({ scope: 'plugin.deactivate', pluginId }, () => record.module.deactivate?.(), undefined);
    // 无论如何都要回收 —— 插件 deactivate 抛异常不代表它的订阅可以留着。
    entry.store.dispose();
    this.#contexts.delete(pluginId);

    record.state = 'declared';
    record.failureCount = 0;
    this.#failures.reset(pluginId);
    this.#notify(record);
  }

  disable(pluginId: string, reason: string): void {
    const record = this.#records.get(pluginId);
    if (!record) return;
    record.state = 'disabled';
    record.reason = reason;
    this.services.commands.undeclareOwnedBy(pluginId);
    void this.#deactivateAllResources(pluginId);

    /*
     * 必须重建贡献集 —— 否则工具栏按钮、菜单项、视图槽位全部残留
     * （undeclareOwnedBy 只清命令表，不清 #contributions）。
     * 实测症状：插件已"禁用"，但工具栏上它的按钮还在，点了报未注册。
     */
    this.#rebuildContributions(
      [...this.#records.values()]
        .filter((item) => item.state !== 'disabled')
        .map((item) => ({
          manifest: item.manifest,
          activate: item.module.activate,
          deactivate: item.module.deactivate,
        })) as never,
    );

    this.#notify(record);
  }

  async #deactivateAllResources(pluginId: string): Promise<void> {
    const entry = this.#contexts.get(pluginId);
    if (!entry) return;
    const record = this.#records.get(pluginId);
    if (record) {
      await guardAsync({ scope: 'plugin.deactivate', pluginId }, () => record.module.deactivate?.(), undefined);
    }
    entry.store.dispose();
    this.#contexts.delete(pluginId);
  }

  // ─────────────────────────── 门面 API ───────────────────────────

  #createContext(pluginId: string, store: DisposableStore): PluginContext {
    const services = this.services;
    const record = this.#records.get(pluginId)!;

    // 插件看到的是一个普通数组（跟 VS Code 一致），但回收权归 store。
    // 这样即使插件忘记 dispose 自己的订阅，卸载时也不会泄漏。
    const subscriptions: Disposable[] = [];
    store.add({
      dispose: () => {
        for (let i = subscriptions.length - 1; i >= 0; i -= 1) subscriptions[i].dispose();
        subscriptions.length = 0;
      },
    });

    const context: PluginContext = {
      pluginId,
      pluginVersion: record.manifest.version,
      apiVersion: services.apiVersion,
      extensionPath: '',
      globalStoragePath: '',
      workspaceStoragePath: services.getWorkspace() ? '' : null,
      platform: services.platform,
      shell: services.shell,
      capabilities: services.capabilities,
      commands: createCommandsFacade(services.commands, pluginId),
      editor: createEditorFacade(services.editor, pluginId),
      workspace: createWorkspaceFacade(services.getWorkspace, services.configuration, services.onDidChangeWorkspace),
      window: createWindowFacade(services.window, pluginId),
      languages: services.languages,
      storage: {
        global: services.mementoFor(pluginId),
        workspace: services.getWorkspace() ? services.mementoFor(`${pluginId}@workspace`) : null,
      },
      logger: createLogger(pluginId),
      subscriptions,
    };

    return context;
  }

  async #activateOwnerOfCommand(commandId: string): Promise<boolean> {
    for (const record of this.#records.values()) {
      if (record.state !== 'declared') continue;
      const owns = record.manifest.contributes?.commands?.some((command) => command.id === commandId);
      /*
       * **声明了命令 = 隐含 onCommand 激活**（与 VS Code 一致）。
       *
       * 之前还要求插件显式写 `activationEvents: ['onCommand:<id>']`，
       * 结果是"命令出现在工具栏、点了却报未激活" —— 用户没理由知道
       * 要为每个命令重复声明一次。onCommand 声明仍然有效，只是不再是
       * 前置条件。
       */
      if (owns) return this.activate(record.manifest.id);
    }
    return false;
  }

  #checkCapabilities(plugins: readonly LoadablePlugin[]): Map<string, readonly string[]> {
    const unmet = new Map<string, readonly string[]>();
    for (const plugin of plugins) {
      const required = plugin.manifest.capabilities?.required ?? [];
      const missing = required.filter((name) => !this.services.capabilities[name]);
      if (missing.length > 0) unmet.set(plugin.manifest.id, missing);
    }
    return unmet;
  }

  #rebuildContributions(plugins: readonly LoadablePlugin[]): void {
    const commands: (AggregatedContributions['commands'][number])[] = [];
    const keybindings: (AggregatedContributions['keybindings'][number])[] = [];
    const views: (AggregatedContributions['views'][number])[] = [];
    const languages: (AggregatedContributions['languages'][number])[] = [];
    const menus: Record<string, { command: string; pluginId: string | null; group?: string; order?: number }[]> = {};
    const configDisposables: Disposable[] = [];

    // 先收键位再声明命令：声明要在键位确定之后，否则命令面板里会先出现一个没有快捷键的版本。
    const keyByCommand = new Map<string, string>();
    for (const { manifest } of plugins) {
      for (const keybinding of manifest.contributes?.keybindings ?? []) {
        keyByCommand.set(keybinding.command, keybinding.key);
      }
    }

    for (const { manifest } of plugins) {
      /*
       * **逐插件隔离**：贡献声明（命令/视图/菜单/配置）任何一处抛错，
       * 只把这个插件标成加载失败，继续处理后面的插件。
       * 没有这层保护时，一个外部插件的非法声明会让内置插件的贡献
       * 全部丢失（v0.0.9 实测的"工具栏清空"事故）。
       */
      try {
      const pluginId = manifest.id;
      const contributes: Contributions = manifest.contributes ?? {};

      for (const command of contributes.commands ?? []) {
        commands.push({ ...command, pluginId, source: 'plugin' });
        this.services.commands.declare(command, { source: 'plugin', pluginId }, keyByCommand.get(command.id));
      }
      for (const keybinding of contributes.keybindings ?? []) {
        keybindings.push({ ...keybinding, pluginId });
      }
      for (const view of contributes.views ?? []) {
        views.push({ ...view, pluginId });
      }
      /*
       * 语言贡献必须在这里汇总，而不是等插件激活 —— 打开文件时
       * 插件可能还没激活（onLanguage: 激活事件正是靠这份表派发的）。
       */
      for (const language of contributes.languages ?? []) {
        languages.push({ ...language, pluginId });
      }
      for (const [location, items] of Object.entries(contributes.menus ?? {})) {
        for (const item of items ?? []) {
          const bucket = (menus[location] ??= []);
          bucket.push({ command: item.command, pluginId, group: item.group, order: item.order });
        }
      }
      if (contributes.configuration) {
        // 配置项在插件未激活时也必须出现在设置页里，所以它的注册
        // 不挂在插件上下文上，而是挂在宿主自己身上。
        configDisposables.push(
          this.services.configuration.register(contributes.configuration, pluginId),
        );
      }
      } catch (error) {
        /*
         * 这个插件的贡献声明有问题 —— 只标记它自己，继续处理下一个。
         * 内置插件排在外部插件之前，所以即使外部插件全坏，工具栏与
         * 侧栏仍然完整（v0.1.0 的隔离目标）。
         */
        const record = this.#records.get(manifest.id);
        if (record) {
          record.state = 'disabled';
          record.reason = `贡献声明失败：${error instanceof Error ? error.message : String(error)}`;
          this.#notify(record);
        }
        console.error(`[plugin-host] 插件 ${manifest.id} 的贡献声明失败`, error);
      }
    }

    for (const disposable of this.#configDisposables) disposable.dispose();
    this.#configDisposables = configDisposables;
    this.#contributions = { commands, keybindings, views, languages, menus };
  }

  #notify(record: PluginRecord): void {
    for (const listener of this.#stateListeners) {
      guardSync({ scope: 'event', pluginId: record.manifest.id }, () => listener(record), undefined);
    }
    this.services.onStateChange(record);
  }
}

function createLogger(pluginId: string): PluginContext['logger'] {
  const prefix = `[${pluginId}]`;
  return {
    debug: (message, ...args) => console.debug(prefix, message, ...args),
    info: (message, ...args) => console.info(prefix, message, ...args),
    warn: (message, ...args) => console.warn(prefix, message, ...args),
    error: (message, error) => console.error(prefix, message, error),
  };
}

function createCommandsFacade(registry: CommandRegistry, pluginId: string): CommandsApi {
  return {
    register(id: string, handler: (...args: unknown[]) => unknown): Disposable {
      // 插件的命令处理器一律包守卫。插件抛错绝不能冒泡到内核，
      // 否则一个格式按钮的 bug 就能让整个编辑器打不开。
      return registry.register(id, (...args: unknown[]) =>
        guardAsync(
          // track: false —— 命令失败多半是环境原因（取消选择框、权限、
          // 磁盘），不该累积成"插件坏了"从而被自动禁用。
          // 详见 safety.ts 的 GuardOptions.track。
          { scope: 'command', pluginId, track: false },
          () => handler(...args),
          undefined,
        ),
      );
    },
    execute: <T = unknown>(id: string, ...args: unknown[]) => registry.execute<T>(id, ...args),
    getAll: () => registry.getAll(),
    get onDidRegisterCommand(): Event<CommandDescriptor> {
      return registry.onDidRegisterCommand;
    },
  };
}

/**
 * 给窗口服务套一层"注入插件身份"的门面。
 *
 * ── 为什么用 Proxy 而不是展开运算符 ──────────────────────────
 * 这里原来的写法是 `{ ...window, registerView: ... }`，看起来没问题，
 * 实际**丢掉了除 registerView 之外的全部方法**。
 *
 * 原因：`WindowService` 是 class，它的方法定义在**原型**上，
 * 而对象展开只复制**自有可枚举属性**。于是插件拿到的 window 门面里
 * `showMessage` / `pickWorkspaceFolder` / `regrantLastWorkspaceFolder` /
 * `createStatusBarItem` 全是 undefined。
 *
 * 症状极具误导性：点"打开文件夹"报
 * `命令执行失败：aropyt.file.pickWorkspace`，点"保存"报同样的错 ——
 * 看起来像命令注册或权限问题，实际是
 * `TypeError: window.showMessage is not a function`。
 *
 * Proxy 转发所有成员，未来给 WindowApi 加方法也不会再被静默丢掉 ——
 * 这正是展开运算符做不到的：它要求有人记得同步维护一份成员清单。
 */
function createWindowFacade(window: WindowApi, pluginId: string): WindowApi {
  // 第三个参数是宿主内部用来记录归属的，不在公开契约里 ——
  // 插件自己不需要（也不应该）声明自己是谁。
  const internal = window as WindowApi & {
    registerView(contribution: ViewContribution, provider: ViewProvider, pluginId: string | null): Disposable;
  };

  return new Proxy(window, {
    get(target, prop) {
      if (prop === 'registerView') {
        return (contribution: ViewContribution, provider: ViewProvider) =>
          internal.registerView(contribution, provider, pluginId);
      }

      // receiver 传 target 而不是默认的代理对象：
      // WindowService 的 getter（如 viewRegistrations）内部访问 #私有字段，
      // 以代理为 this 会直接抛 "Cannot read private member"。
      const value = Reflect.get(target, prop, target);
      // 方法要绑定到真实实例，理由同上。
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as WindowApi;
}

function createEditorFacade(adapter: EditorAdapter, pluginId: string): EditorApi {
  return {
    get activeFile() {
      return adapter.activeFile;
    },
    get activeLanguage() {
      return adapter.activeLanguage;
    },
    get activeDocument() {
      return adapter.activeDocument;
    },
    get onDidChangeActiveFile() {
      return adapter.onDidChangeActiveFile;
    },
    get onDidChangeDocument() {
      return adapter.onDidChangeDocument;
    },
    get onDidSaveDocument() {
      return adapter.onDidSaveDocument;
    },
    get sourceMode() {
      return adapter.sourceMode;
    },
    getText: () => adapter.getText(),
    getLine: (lineNumber) => adapter.getLine(lineNumber),
    getSelection: () => adapter.getSelection(),
    insertText: (text) => adapter.insertText(text),
    replaceSelection: (text) => adapter.replaceSelection(text),
    replaceDocument: (text) => adapter.replaceDocument(text),
    wrapSelection: (prefix, suffix) => adapter.wrapSelection(prefix, suffix),
    toggleLinePrefix: (prefix) => adapter.toggleLinePrefix(prefix),
    revealLine: (lineNumber) => adapter.revealLine(lineNumber),
    /*
     * ⚠️ 门面转发必须逐参数透传，包括后加的 options。
     *
     * 这里曾经只写 `(path) => adapter.openDocument(path)` ——
     * 后来给 openDocument 加了 preview 参数，**门面没有任何机制提醒
     * 这里要同步**，于是参数静默地丢在这一层。
     * 症状极具迷惑性：命令层收到了 `{"preview":true}`（有 log 为证），
     * 到 openFile 却是 undefined，中间隔着两层桥接，肉眼排查要翻很久。
     *
     * 教训与"门面不能用展开运算符转发实例"同源：**门面是手写的桥，
     * 每加一个参数就要多修一处，改签名时必须全项目搜一遍调用点。**
     */
    openDocument: (path, options) => adapter.openDocument(path, options),
    registerExtension: (factory) => adapter.registerExtension(factory, { pluginId }),
  };
}

function createWorkspaceFacade(
  getWorkspace: () => WorkspaceFileHandle | null,
  configuration: ConfigurationApi,
  onDidChangeWorkspace: Event<{ readonly rootPath: string | null }>,
): WorkspaceApi {
  const require = (): WorkspaceFileHandle => {
    const workspace = getWorkspace();
    if (!workspace) throw new Error('当前没有打开工作区');
    return workspace;
  };

  return {
    get rootPath() {
      return getWorkspace()?.name ?? null;
    },
    get name() {
      return getWorkspace()?.name ?? null;
    },
    get providerId() {
      return getWorkspace()?.providerId ?? 'none';
    },
    onDidChangeWorkspace,
    // Web 端拿不到文件外部变更监听（那是 Tauri 的能力优势）。
    // 返回一个永不触发的事件是**事实**而不是占位实现 ——
    // 上层据此判断"文件树不会自动刷新"，这是正确的信息。
    onDidChangeFile: () => ({ dispose: () => undefined }),
    configuration,
    stat: (path) => require().stat(path),
    list: (dirPath) => require().list(dirPath),
    readFile: (path) => require().read(path),
    readFileBytes: (path) => require().readBytes(path),
    writeFile: (path, content) => require().write(path, content),
    writeFileBytes: (path, data) => require().writeBytes(path, data),
    createDirectory: (path) => require().createDirectory(path),
    delete: (path, options) => require().remove(path, options),
    resolvePath: (path, relativeTo) => {
      if (path.startsWith('/')) return path;
      const segments = (relativeTo ?? '').split('/').filter(Boolean);
      segments.pop();
      for (const segment of path.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') segments.pop();
        else segments.push(segment);
      }
      return segments.join('/');
    },
  };
}
