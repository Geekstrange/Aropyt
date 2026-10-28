/**

// KaTeX 样式预热（数学公式渲染用）：core 包的 tsconfig 对 CSS 子路径无声明，
// 放在 web 层（有 vite/client 类型）。动态 import → 独立 chunk，不进首屏。
// 动态 import('xxx.css') 会被 Vite 静默丢弃（实测产物里无 CSS）——
// 用 ?url 拿到构建产物的地址，运行时插 <link>：独立 chunk、不进首屏、
// 字体路径由构建期正确重写。

 * 应用层服务：窗口/界面 API 与语言扩展点的实现。
 *
 * 注意这些类住在 apps/web 而不是 packages/core ——
 * 它们是"某一个宿主"的具体实现，不是内核。内核只定义接口（见 plugin-api），
 * 具体怎么渲染由宿主决定。Tauri 壳将来会提供同一套接口的另一份实现。
 */

import { autocompletion, type CompletionContext as CmContext, type CompletionSource } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';

import type {
  CompletionItem,
  ImportedFile,
  CompletionProvider,
  CompletionRequest,
  Disposable,
  Event,
  InputBoxOptions,
  LanguagesApi,
  MarkdownItPlugin,
  MessageLevel,
  MessageAction,
  MessageOptions,
  OutlineItem,
  QuickPickItem,
  QuickPickOptions,
  SaveAsOptions,
  StatusBarItem,
  ViewContribution,
  ViewProvider,
  WindowApi,
} from '@aropyt/plugin-api';

import { guardSync } from '@aropyt/core';

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

type MarkdownEngine = typeof import('@aropyt/core/markdown');

export interface ViewRegistration {
  readonly id: string;
  /** 带 pluginId 的贡献点。归属信息由宿主的门面注入，插件自己不需要声明。 */
  readonly contribution: ViewContribution & { readonly pluginId: string | null };
  readonly provider: ViewProvider;
}

export interface Toast {
  readonly id: number;
  readonly level: MessageLevel;
  readonly message: string;
  /**
   * 可选的动作按钮。
   *
   * 接口（`MessageOptions.actions`）早就声明了这个能力，但实现里只写了
   * `return options?.actions?.[0]` —— 声明了却从不渲染，也没有任何调用点，
   * 是一处"承诺了但没兑现"的半个功能。现在它是真的：
   * 渲染成按钮，点了先关提示再执行回调。
   */
  readonly actions?: readonly MessageAction[];
}

class StatusBarItemImpl implements StatusBarItem {
  text: string;
  tooltip?: string;
  icon?: string;
  command?: string;
  order: number;
  visible = true;

  constructor(_alignment: 'left' | 'right', private readonly onChange: () => void) {
    this.text = '';
    this.order = 0;
  }

  show(): void {
    this.visible = true;
    this.onChange();
  }

  hide(): void {
    this.visible = false;
    this.onChange();
  }

  dispose(): void {
    this.visible = false;
    this.onChange();
  }
}

/**
 * 宿主注入的窗口能力。
 *
 * 抽成具名类型而不是内联在 `bindHost` 上：这几项在私有字段、注入方法、
 * 运行时实现三处都要出现，内联写法一旦加一项就很容易漏掉其中一处 ——
 * 而漏掉的那处会以"类型不匹配"的形式在别的地方报错，定位绕远。
 *
 * 共同点：**只有外壳做得到**（弹系统选择器、读写工作区之外的路径）。
 * 但它们都不把绝对路径交给插件 —— 选择器返回的东西由宿主消化掉。
 */
export interface WindowHostBindings {
  pickWorkspaceFolder(): Promise<boolean>;
  regrantLastWorkspaceFolder(): Promise<boolean>;
  closeWorkspace(): Promise<boolean>;
  importImage(targetDir: string): Promise<ImportedFile | null>;
  openMarkdownFile(): Promise<boolean>;
}

export class WindowService implements WindowApi {
  #host: WindowHostBindings | null = null;
  readonly #views = new Map<string, ViewRegistration>();
  readonly #coreViews = new Map<string, ViewContribution>();
  #statusItems: StatusBarItemImpl[] = [];
  #toasts: Toast[] = [];
  #choiceResolvers = new Map<number, (label?: string) => void>();
  #listeners = new Set<() => void>();
  #revision = 0;
  #toastSeq = 0;
  #activeTheme: 'light' | 'dark' = 'dark';
  readonly #themeListeners = new Set<(theme: 'light' | 'dark') => void>();

  // ── React 订阅：只暴露 revision，读的时候直接取字段 ──
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get revision(): number {
    return this.#revision;
  }

  get viewRegistrations(): readonly ViewRegistration[] {
    return [...this.#views.values()];
  }

  get statusItems(): readonly StatusBarItem[] {
    return this.#statusItems.filter((item) => item.visible);
  }

  get toasts(): readonly Toast[] {
    return this.#toasts;
  }

  #bump(): void {
    this.#revision += 1;
    for (const listener of this.#listeners) listener();
  }

  // ── WindowApi ──

  /**
   * 由运行时注入宿主能力。
   * 这两个方法必须走宿主：只有外壳知道怎么弹系统选择器、怎么重新授权。
   */
  bindHost(host: WindowHostBindings): void {
    this.#host = host;
  }

  async pickWorkspaceFolder(): Promise<boolean> {
    if (!this.#host) throw new Error('宿主尚未注入工作区能力');
    return this.#host.pickWorkspaceFolder();
  }

  async regrantLastWorkspaceFolder(): Promise<boolean> {
    if (!this.#host) throw new Error('宿主尚未注入工作区能力');
    return this.#host.regrantLastWorkspaceFolder();
  }

  /** 关闭工作区：与"打开"同源，都要走宿主才改得了运行时的绑定状态。 */
  async closeWorkspace(): Promise<boolean> {
    if (!this.#host) throw new Error('宿主尚未注入工作区能力');
    return this.#host.closeWorkspace();
  }

  /**
   * 导入外部图片。
   *
   * 与上面两个同理：只有外壳能弹系统选择器、也只有外壳能读写工作区之外的路径。
   * 但**绝对路径不会交给插件** —— 原生侧读完之后只回传工作区内的相对路径。
   */
  async importImage(targetDir = 'assets'): Promise<ImportedFile | null> {
    if (!this.#host) throw new Error('宿主尚未注入工作区能力');
    return this.#host.importImage(targetDir);
  }

  async openMarkdownFile(): Promise<boolean> {
    if (!this.#host) throw new Error('宿主尚未注入工作区能力');
    return this.#host.openMarkdownFile();
  }

  registerView(contribution: ViewContribution, provider: ViewProvider, pluginId: string | null = null): Disposable {
    const owned = { ...contribution, pluginId };
    this.#views.set(contribution.id, { id: contribution.id, contribution: owned, provider });
    this.#bump();
    return {
      dispose: () => {
        this.#views.delete(contribution.id);
        this.#bump();
      },
    };
  }

  /**
   * 登记内核固有的视图（当前只有预览）。
   *
   * 与 registerView 分开是因为语义不同：内核视图**立即可用**，
   * 不依赖插件激活，也不参与懒激活调度。
   *
   * 这两条通道并存是必要的 —— 见ViewHost 里的说明：
   * 插件视图必须先经"清单声明 → 派发 onView → 激活"才能出现，
   * 而内核视图天生就在，不走那条链路。
   */
  registerCoreView(contribution: ViewContribution, provider: ViewProvider): Disposable {
    const disposable = this.registerView(contribution, provider, null);
    this.#coreViews.set(contribution.id, contribution);
    this.#bump();
    return {
      dispose: () => {
        this.#coreViews.delete(contribution.id);
        disposable.dispose();
      },
    };
  }

  /**
   * 内核固有视图的贡献点。
   *
   * 布局必须能直接读到它们，而不能只读 host.contributions.views ——
   * 那个集合只装插件清单里声明的槽位，预览既然不走插件系统就不会出现在里面。
   * 两条通道并存正是「内核固有 + 插件贡献」这个结构的必然结果。
   */
  get coreViews(): readonly ViewContribution[] {
    return [...this.#coreViews.values()];
  }

  createStatusBarItem(alignment: 'left' | 'right'): StatusBarItem {
    const item = new StatusBarItemImpl(alignment, () => this.#bump());
    this.#statusItems.push(item);
    this.#bump();
    return item;
  }

  async showMessage(message: string, options?: MessageOptions): Promise<string | undefined> {
    const id = ++this.#toastSeq;
    /*
     * 带 actions 的提示要**等用户真的点了**才返回，并且返回值必须是
     * **被点击那个 action 的 label**。
     *
     * 上一版直接 `return actions[0].label` —— 点"保存并关闭"也返回
     * "不保存并关闭"（第一个），于是"有提示但保不住文件"（用户实测打回）。
     */
    let resolveChoice: ((label?: string) => void) | null = null;
    const actions = options?.actions?.map((action) => ({
      ...action,
      run: () => {
        /*
         * ⚠️ 先把这个 id 的 resolver 摘掉，再 resolve(label)。
         *
         * 宿主点按钮时的顺序是 `dismiss(id)` → `action.run()`。
         * dismiss 会把等待中的 Promise 以 undefined（= 取消）结算掉，
         * 之后 run 里的 resolve(label) 就无效了 —— Promise 只能结算一次。
         * 症状：按钮"点了没反应"（关闭标签/退出软件的确认全被判成取消）。
         */
        this.#choiceResolvers.delete(id);
        resolveChoice?.(action.label);
        action.run();
      },
    }));
    this.#toasts = [
      ...this.#toasts,
      { id, level: options?.level ?? 'info', message, actions },
    ];
    this.#bump();
    // 5 秒自动消失。错误类留久一点，但仍然要自己走 ——
    // 一个永远不消失的提示条会变成用户学会忽略的东西。
    /*
     * 带动作的提示**不自动消失**。
     *
     * 自动关掉等于把"要不要丢弃"这个问题替用户回答了"不要"，
     * 而且他还没来得及看清内容写的是什么。让用户自己决定什么时候关。
     */
    if (!options?.actions?.length) {
      setTimeout(() => this.dismiss(id), options?.level === 'error' ? 8000 : 5000);
      return undefined;
    }
    // 提示被关掉（用户不要这些动作）→ resolve(undefined) 表示"取消"
    return new Promise<string | undefined>((resolve) => {
      resolveChoice = resolve;
      this.#choiceResolvers.set(id, resolve);
    });
  }

  dismiss(id: number): void {
    // 关掉提示 = 取消：让等待中的 showMessage 以 undefined 结束
    const resolver = this.#choiceResolvers.get(id);
    if (resolver) {
      this.#choiceResolvers.delete(id);
      resolver(undefined);
    }
    const next = this.#toasts.filter((toast) => toast.id !== id);
    if (next.length !== this.#toasts.length) {
      this.#toasts = next;
      this.#bump();
    }
  }

  get activeTheme(): 'light' | 'dark' {
    return this.#activeTheme;
  }

  get onDidChangeTheme(): Event<'light' | 'dark'> {
    return (listener) => {
      this.#themeListeners.add(listener);
      return {
        dispose: () => {
          this.#themeListeners.delete(listener);
        },
      };
    };
  }

  async openExternal(url: string): Promise<void> {
    // rel="noopener noreferrer" 是必须的：否则目标页能通过 window.opener
    // 反向操纵我们的页面。
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  // 下面三个 M0 不实现。明确抛错好过返回一个假的成功 ——
  // 假的成功会让插件以为文件已经存下去了。

  async showQuickPick(_items: readonly QuickPickItem[], _options?: QuickPickOptions): Promise<QuickPickItem | undefined> {
    throw new Error('showQuickPick 计划在 M1 实现');
  }

  async showInputBox(_options?: InputBoxOptions): Promise<string | undefined> {
    throw new Error('showInputBox 计划在 M1 实现');
  }

  async saveAs(_options: SaveAsOptions): Promise<string | null> {
    throw new Error('saveAs 计划在 M1 实现（将接到 File System Access 的 showSaveFilePicker）');
  }
}

// ─────────────────────────── 语言扩展点 ───────────────────────────

const CM_COMPLETION_TYPE: Record<NonNullable<CompletionItem['kind']>, string> = {
  keyword: 'keyword',
  snippet: 'snippet',
  text: 'text',
  reference: 'variable',
};

export class LanguagesService implements LanguagesApi {
  readonly #providers = new Map<string, CompletionProvider[]>();
  readonly #highlighters = new Set<string>();
  #engine: Promise<MarkdownEngine> | null = null;
  #pendingPlugins: MarkdownItPlugin[] = [];
  #listeners = new Set<() => void>();
  #revision = 0;

  /**
   * 渲染引擎按需加载。
   *
   * markdown-it（约 30KB）+ highlight.js（约 35KB）**不进首屏**：
   * 它们只在预览视图真正开始渲染时才被动态 import。
   * 这不只是包体优化，也是稳定性措施 —— 渲染逻辑可以整体下沉到 Worker，
   * 而 Worker 必须是独立 chunk 才谈得上隔离。
   *
   * M0 用 markdown-it。将来换 WASM 版或加 KaTeX / Mermaid，只改这一处，
   * 插件一行不用动 —— 这正是它待在 API 里而不是被插件直接 import 的原因。
   */
  #loadEngine(): Promise<MarkdownEngine> {
    this.#engine ??= import('@aropyt/core/markdown').then((module) => {
      // 期间排队的插件扩展在这里补挂，避免"注册早于加载"时静默丢失。
      for (const plugin of this.#pendingPlugins) module.md.use(plugin as Parameters<typeof module.md.use>[0]);
      this.#pendingPlugins = [];
      return module;
    });
    return this.#engine;
  }

  async renderMarkdown(source: string): Promise<string> {
    const engine = await this.#loadEngine();
    return guardSync({ scope: 'markdown-it' }, () => engine.renderMarkdown(source), `<p>${escapeHtml(source)}</p>`);
  }

  async extractOutline(source: string): Promise<readonly OutlineItem[]> {
    const engine = await this.#loadEngine();
    return engine.extractOutline(source);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get revision(): number {
    return this.#revision;
  }

  get registeredHighlighters(): readonly string[] {
    return [...this.#highlighters];
  }

  #bump(): void {
    this.#revision += 1;
    for (const listener of this.#listeners) listener();
  }

  registerMarkdownItPlugin(plugin: MarkdownItPlugin): Disposable {
    // 引擎还没加载就先排队。插件不应自己 new 一个 markdown-it 实例 ——
    // 否则它的语法扩展根本不会出现在预览里。
    if (!this.#engine) {
      this.#pendingPlugins.push(plugin);
      return { dispose: () => undefined };
    }

    void this.#engine.then((engine) => {
      guardSync({ scope: 'markdown-it' }, () => {
        engine.md.use(plugin as Parameters<typeof engine.md.use>[0]);
        return true;
      }, false);
    });

    return { dispose: () => undefined };
  }

  registerHighlighter(languageId: string): Disposable {
    // 编辑器侧已经用 @codemirror/language-data 的全部语言（懒加载）。
    // 这里记录插件的意图，供 M2 换成按需白名单时使用。
    this.#highlighters.add(languageId);
    this.#bump();
    return {
      dispose: () => {
        this.#highlighters.delete(languageId);
        this.#bump();
      },
    };
  }

  registerCompletionProvider(languageId: string, provider: CompletionProvider): Disposable {
    const list = this.#providers.get(languageId) ?? [];
    list.push(provider);
    this.#providers.set(languageId, list);
    this.#bump();

    return {
      dispose: () => {
        const current = this.#providers.get(languageId);
        if (!current) return;
        const index = current.indexOf(provider);
        if (index >= 0) current.splice(index, 1);
        this.#bump();
      },
    };
  }

  /**
   * 把 markdown 层的补全请求适配成 CodeMirror 的 CompletionSource。
   *
   * 这是"插件 API 不出现任何 CodeMirror 类型"的具体兑现处：
   * 插件给的是 (请求 → 候选项)，内核负责翻译成 CM 的形状。
   * 反过来做（直接把 CM 的 CompletionSource 暴露给插件）就等于漏了内核实现。
   */
  completionExtension(): Extension {    if (this.#providers.size === 0) return [];

    const sources: CompletionSource[] = [];
    for (const [languageId, providers] of this.#providers) {
      for (const provider of providers) {
        sources.push((context: CmContext) => this.#toSource(context, languageId, provider));
      }
    }
    return autocompletion({ override: sources });
  }

  #toSource(context: CmContext, languageId: string, provider: CompletionProvider): ReturnType<CompletionSource> | null {
    const word = context.matchBefore(/[\p{L}\p{N}_#/[\].-]*/u);
    if (!word || (word.from === word.to && !context.explicit)) return null;

    const request: CompletionRequest = {
      text: context.state.doc.toString(),
      from: word.from,
      to: word.to,
      language: languageId,
    };

    return Promise.resolve(provider.provide(request)).then((items) => ({
      from: word.from,
      options: items.map((item) => ({
        label: item.label,
        detail: item.detail,
        type: CM_COMPLETION_TYPE[item.kind ?? 'text'],
        boost: item.kind === 'snippet' ? 1 : 0,
      })),
      validFor: /^[\p{L}\p{N}_#/[\].-]*$/u,
    }));
  }
}
