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
  #contributions: AggregatedContributions = {
    commands: [],
    keybindings: [],
    views: [],
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

    const unmet = this.#checkCapabilities(plugins);
    const accepted: LoadablePlugin[] = [];

    for (const plugin of plugins) {
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
    const record = this.#records.get(pluginId);
    if (!record || record.state !== 'declared') return false;

    if (!record.module.activate) {
      record.state = 'active';
      this.#notify(record);
      return true;
    }

    const store = new DisposableStore();
    const context = this.#createContext(pluginId, store);

    record.state = 'active';
    this.#contexts.set(pluginId, { context, store });

    await guardAsync({ scope: 'plugin.activate', pluginId }, () => record.module.activate!(context), undefined);

    this.#notify(record);
    return true;
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
      const activatesOnCommand = record.manifest.activationEvents.includes(`onCommand:${commandId}`);
      if (owns && activatesOnCommand) return this.activate(record.manifest.id);
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
    }

    for (const disposable of this.#configDisposables) disposable.dispose();
    this.#configDisposables = configDisposables;
    this.#contributions = { commands, keybindings, views, menus };
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
