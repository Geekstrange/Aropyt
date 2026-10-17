/**
 * 存储与配置。
 *
 * 两条设计约束：
 *
 * 1. **Memento 的 get 是同步的**（这与 VS Code 一致）。插件作者不该为了读一个
 *    配置项而 await —— 那会让每个插件的第一行代码都是异步的，进而在
 *    activate 里制造出一堆没必要的 async。所以内存里持一份缓存，
 *    写操作异步落盘。
 *
 * 2. **配置项由插件声明，由核心渲染。** 插件提供的是 schema（类型、默认值、
 *    取值范围、说明），设置页长什么样是核心的事。这是"声明式贡献点"
 *    在非 UI 场景下的同一套思路。
 */

import type {
  ConfigurationApi,
  ConfigurationContribution,
  ConfigurationPropertySchema,
  Disposable,
  Event,
  Memento,
} from '@aropyt/plugin-api';

import { idbGet, idbSet, STORE } from './idb.js';

/** 命名空间化的一小块键值存储。整块读、整块写 —— 配置的量级不值得做增量。 */
export class MementoStore implements Memento {
  readonly #cache = new Map<string, unknown>();
  #loaded = false;
  #flushChain: Promise<void> = Promise.resolve();

  constructor(private readonly namespace: string) {}

  async load(): Promise<void> {
    if (this.#loaded) return;
    const snapshot = await idbGet<Record<string, unknown>>(STORE.kv, this.namespace).catch(() => undefined);
    if (snapshot) {
      for (const [key, value] of Object.entries(snapshot)) this.#cache.set(key, value);
    }
    this.#loaded = true;
  }

  get<T>(key: string, fallback: T): T {
    return this.#cache.has(key) ? (this.#cache.get(key) as T) : fallback;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.#cache.delete(key);
    else this.#cache.set(key, value);
    await this.#persist();
  }

  keys(): readonly string[] {
    return [...this.#cache.keys()];
  }

  /**
   * 写操作串行化。
   *
   * 并发 flush 会让后写的旧快照覆盖先写的新快照 —— 这类 bug 极难复现，
   * 但会让用户的配置"莫名其妙回退"。串行化的成本可以忽略。
   */
  #persist(): Promise<void> {
    this.#flushChain = this.#flushChain.then(async () => {
      await idbSet(STORE.kv, this.namespace, Object.fromEntries(this.#cache));
    });
    return this.#flushChain;
  }
}

export interface ConfigurationEntry {
  readonly key: string;
  readonly schema: ConfigurationPropertySchema;
  readonly value: unknown;
  readonly ownerLabel: string;
}

export class ConfigurationStore implements ConfigurationApi {
  readonly #schemas = new Map<string, { schema: ConfigurationPropertySchema; ownerLabel: string }>();
  readonly #listeners = new Set<(payload: { key: string; value: unknown }) => void>();

  constructor(private readonly memento: MementoStore) {}

  async load(): Promise<void> {
    await this.memento.load();
  }

  get<T>(key: string, fallback: T): T {
    const stored = this.memento.get<unknown>(key, undefined);
    if (stored !== undefined) return stored as T;
    const declared = this.#schemas.get(key)?.schema.default;
    return declared !== undefined ? (declared as T) : fallback;
  }

  has(key: string): boolean {
    return this.memento.keys().includes(key) || this.#schemas.has(key);
  }

  async update(key: string, value: unknown, target: 'global' | 'workspace' = 'global'): Promise<void> {
    if (target === 'workspace') {
      // 工作区级配置需要工作区身份，M0 只有全局作用域。
      // 明确抛错好过静默写进全局 —— 静默会让用户以为作用域生效了。
      throw new Error('工作区级配置尚未实现，请使用 target: "global"');
    }
    const validation = this.#validate(key, value);
    if (validation) throw new Error(`配置项 ${key} 不合法：${validation}`);

    await this.memento.update(key, value);
    for (const listener of this.#listeners) {
      try {
        listener({ key, value });
      } catch {
        // 监听器出错不影响写入结果。
      }
    }
  }

  register(contribution: ConfigurationContribution, ownerLabel = '未命名插件'): Disposable {
    const keys: string[] = [];
    for (const [key, schema] of Object.entries(contribution.properties)) {
      this.#schemas.set(key, { schema, ownerLabel });
      keys.push(key);
    }

    return {
      dispose: () => {
        for (const key of keys) this.#schemas.delete(key);
      },
    };
  }

  get onDidChange(): Event<{ key: string; value: unknown }> {
    return (listener) => {
      this.#listeners.add(listener);
      return {
        dispose: () => {
          this.#listeners.delete(listener);
        },
      };
    };
  }

  /** UI 用：渲染设置页需要的全部信息。 */
  describeAll(): readonly ConfigurationEntry[] {
    return [...this.#schemas.entries()]
      .map(([key, { schema, ownerLabel }]) => ({
        key,
        schema,
        value: this.get(key, schema.default),
        ownerLabel,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  #validate(key: string, value: unknown): string | undefined {
    const declared = this.#schemas.get(key);
    if (!declared) return undefined;

    const { schema } = declared;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    if (actual !== schema.type) return `期望 ${schema.type}，收到 ${actual}`;

    if (schema.enum && !schema.enum.includes(value)) {
      return `不在允许的取值范围内：${schema.enum.join(' / ')}`;
    }
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) return `小于最小值 ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `大于最大值 ${schema.maximum}`;
    }
    return undefined;
  }
}
