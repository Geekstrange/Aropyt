/**
 * 命令注册表。
 *
 * 这是惰性激活能成立的关键部件，也是"一切皆插件"落地的第一块砖。
 *
 * 机制：**声明与实现在时间上分离。**
 *
 *   1. 启动时只读插件清单，把所有 commands 贡献点登记进来 —— 命令立刻出现在
 *      命令面板和菜单里，但插件的代码一个字节都没加载。
 *   2. 用户真的触发了这个命令，注册表发现没有 handler，
 *      才回头要求宿主激活对应插件（`onCommand:` 事件）。
 *   3. 插件激活时调用 `register(id, handler)` 补上实现。
 *
 * 所以"装了 100 个插件但启动零开销"不是靠优化，是靠这个时序。
 */

import type {
  CommandContribution,
  CommandDescriptor,
  CommandsApi,
  Disposable,
  Event,
} from '@aropyt/plugin-api';

export interface DeclaredCommand {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  readonly keybinding?: string;
  readonly icon?: string;
  readonly source: 'builtin' | 'plugin';
  readonly pluginId: string | null;
}

type CommandHandler = (...args: unknown[]) => unknown;

/** 命令没有被实现时，向宿主请求激活。返回是否成功补上了 handler。 */
export type CommandActivator = (commandId: string) => Promise<boolean>;

export class CommandRegistry implements CommandsApi {
  readonly #declared = new Map<string, DeclaredCommand>();
  readonly #handlers = new Map<string, CommandHandler>();
  readonly #registerListeners = new Set<(descriptor: CommandDescriptor) => void>();
  #activator: CommandActivator | null = null;
  /** 正在激活中的命令，避免并发触发把插件激活跑两遍。 */
  readonly #activating = new Map<string, Promise<boolean>>();

  setActivator(activator: CommandActivator): void {
    this.#activator = activator;
  }

  /** 由宿主在解析插件清单时调用。此时插件的代码还不存在。 */
  declare(
    contribution: CommandContribution,
    owner: { source: 'builtin' | 'plugin'; pluginId: string | null },
    keybinding?: string,
  ): void {
    this.#declared.set(contribution.id, {
      id: contribution.id,
      title: contribution.title,
      category: contribution.category,
      icon: contribution.icon,
      keybinding,
      source: owner.source,
      pluginId: owner.pluginId,
    });
    this.#emit(contribution.id);
  }

  undeclareOwnedBy(pluginId: string): void {
    for (const [id, command] of this.#declared) {
      if (command.pluginId === pluginId) {
        this.#declared.delete(id);
        this.#handlers.delete(id);
        this.#emit(id);
      }
    }
  }

  register(id: string, handler: CommandHandler): Disposable {
    if (this.#handlers.has(id)) {
      throw new Error(`命令已被注册：${id}（插件必须使用全局唯一 id）`);
    }
    this.#handlers.set(id, handler);

    // 允许插件注册清单里没声明的命令，但要在描述里体现出来 ——
    // 否则命令会变成"存在但用户看不见"的隐形功能。
    if (!this.#declared.has(id)) {
      this.#declared.set(id, { id, title: id, source: 'plugin', pluginId: null });
      this.#emit(id);
    }

    return {
      dispose: () => {
        this.#handlers.delete(id);
      },
    };
  }

  async execute<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
    let handler = this.#handlers.get(id);

    if (!handler && this.#activator) {
      await this.#requestActivation(id);
      handler = this.#handlers.get(id);
    }

    if (!handler) throw new Error(`命令未注册或所属插件未激活：${id}`);
    return (await handler(...args)) as T;
  }

  async #requestActivation(id: string): Promise<boolean> {
    const existing = this.#activating.get(id);
    if (existing) return existing;

    const task = (this.#activator?.(id) ?? Promise.resolve(false)).finally(() => {
      this.#activating.delete(id);
    });
    this.#activating.set(id, task);
    return task;
  }

  getAll(): readonly CommandDescriptor[] {
    return [...this.#declared.values()].map((command) => ({
      id: command.id,
      title: command.title,
      category: command.category,
      keybinding: command.keybinding,
      source: command.source,
      pluginId: command.pluginId ?? undefined,
    }));
  }

  get onDidRegisterCommand(): Event<CommandDescriptor> {
    return (listener) => {
      this.#registerListeners.add(listener);
      return {
        dispose: () => {
          this.#registerListeners.delete(listener);
        },
      };
    };
  }

  /** UI 用：带图标的完整信息，比插件通过 API 能看到的更多。 */
  detail(id: string): DeclaredCommand | undefined {
    return this.#declared.get(id);
  }

  details(): readonly DeclaredCommand[] {
    return [...this.#declared.values()].sort(compareCommands);
  }

  hasHandler(id: string): boolean {
    return this.#handlers.has(id);
  }

  #emit(id: string): void {
    const command = this.#declared.get(id);
    if (!command) return;
    const descriptor: CommandDescriptor = {
      id: command.id,
      title: command.title,
      category: command.category,
      keybinding: command.keybinding,
      source: command.source,
      pluginId: command.pluginId ?? undefined,
    };
    for (const listener of this.#registerListeners) {
      try {
        listener(descriptor);
      } catch {
        // 监听器（通常是 UI）出错不能影响注册表本身。
      }
    }
  }
}

function compareCommands(a: DeclaredCommand, b: DeclaredCommand): number {
  const categoryA = a.category ?? '';
  const categoryB = b.category ?? '';
  if (categoryA !== categoryB) return categoryA.localeCompare(categoryB);
  return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
}
