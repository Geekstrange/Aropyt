/**
 * 内置插件：文件树。
 *
 * 走 `ViewProvider.render` 这条路 —— 插件自己画 DOM，容器是核心给的受控节点。
 * 另一条路是 `data()`（核心渲染成列表/树），它更适合设置项这类纯数据视图，
 * 计划随设置页一起落地。
 *
 * 插件拿不到 shell，所以它通过 `commands.execute` 打开文件；
 * 这也顺带验证了"命令是插件之间唯一的协作方式"这条设计是否成立。
 */

import type { PluginContext, PluginManifest, ViewContext, ViewProvider } from '@aropyt/plugin-api';
import { t } from '../i18n';
import type { LoadablePlugin } from '@aropyt/core';

const manifest: PluginManifest = {
  id: 'aropyt.explorer',
  name: t('view.treeTitle'),
  version: '0.1.0',
  engines: { aropyt: '^0.1.0' },
  activationEvents: ['onView:aropyt.explorer'],
  contributes: {
    commands: [
      /*
       * 「恢复已移除的目录」必须能被命令面板找到，否则"从工作区移除"就成了
       * 一条单行道：目录一旦移除，除了改 memento 没有任何找回的办法。
       */
      { id: 'aropyt.explorer.restore', title: '恢复已移除的目录', category: '文件' },
    ],
    views: [{ id: 'aropyt.explorer', title: '文件', location: 'sidebar', order: 1 }],
  },
};

interface Entry {
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'directory';
}

const MARKDOWN = /\.(md|markdown|txt)$/i;

/**
 * 折叠状态在 memento 里的键。
 *
 * 存进工作区存储而不是内存里的 Set：Set 活不过视图卸载，
 * 而"上次把哪些目录折起来了"恰恰是用户会期待被记住的东西 ——
 * 尤其大工作区里谁都记不住自己折过什么。重启后原样恢复，
 * 是这类"看不见的状态"唯一说得通的表现方式。
 */
const COLLAPSED_KEY = 'explorer.collapsed';

/**
 * 已从工作区移除的目录（只影响显示，磁盘上的文件一个都不动）。
 *
 * 之所以在键名后面再挂一个工作区名：`PluginContext.storage.workspace` 看起来
 * 是按工作区隔离的 Memento，实际底层只按 `plugin:<id>` 存一个键（见
 * `mementoFor`），换工作区不会自动分桶。不做前缀的话，在 A 项目里移除的
 * 目录到了 B 项目里也一起消失 —— 而且症状极难归因（"某些目录就是看不见"）。
 *
 * 代价是同名目录（两个都叫 notes）共用一份移除列表。可以接受：
 * 移除只是"别显示"，误伤时命令面板一条「恢复已移除的目录」就能全部找回。
 */
const removedKey = (root: string): string => `explorer.removed:${root}`;

/**
 * 取活动文件的父目录路径（POSIX 风格，带尾斜杠）。
 *
 * 目录的 `path` 是 `notes`、`notes/sub`，而活动文件是 `notes/a.md`，
 * 所以要拼出 `notes/` 才能比对。写成带尾斜杠的形式，
 * 是为了让 `notes` 不会误匹配到 `notes-2`。
 */
function parentOf(activePath: string | null): string | null {
  if (!activePath) return null;
  const cut = activePath.lastIndexOf('/');
  return cut === -1 ? '' : activePath.slice(0, cut + 1);
}

function activate(context: PluginContext): void {
  const provider: ViewProvider = {
    render(container: HTMLElement, viewContext: ViewContext) {
      return mount(container, context, viewContext);
    },
  };

  context.subscriptions.push(
    context.window.registerView(
      { id: 'aropyt.explorer', title: '文件', location: 'sidebar', order: 1 },
      provider,
    ),
  );
}

function mount(container: HTMLElement, context: PluginContext, viewContext: ViewContext): { dispose(): void } {
  /*
   * 折叠集合的初值从全局存储读。
   *
   * 读的是 global 而不是 workspace：这个 key 存的是"用户在折叠哪些目录"，
   * 属于**界面偏好**而不是项目数据。换一个工作区时恢复成默认展开更合理
   * （新项目没人想先折上一百层），但同一工作区反复开关必须保持原样。
   */
  const collapsed = new Set<string>(context.storage.global.get<string[]>(COLLAPSED_KEY, []) ?? []);
  let disposed = false;

  const persistCollapsed = (): void => {
    /*
     * 存 undefined（= 删除这个键）表示"全展开"而不是存空数组。
     *
     * 区别在于体积：一个折了几十个目录的工作区，展开态数组也是同样的几十个路径。
     * 而恢复时全展开是绝大多数情况下的默认，不需要任何数据。
     *
     * ⚠️ 不能用 null 表示"没有"：Memento.get 用 `has(key)` 判断，
     * 存了 null 之后 get 返回的是 null 而不是 fallback，`new Set(null)`
     * 会直接抛 "not iterable" —— 于是"折过一次目录"的用户下次启动
     * 整个文件树都是空的，且没有任何报错来源可循。
     */
    void context.storage.global.update(COLLAPSED_KEY, collapsed.size > 0 ? [...collapsed] : undefined);
  };

  /*
   * 移除列表跟着工作区走，所以它是一对可变状态而不是常量：
   * 换工作区（或关闭工作区）时必须整体重载，否则上一个项目的移除记录
   * 会被套用到新项目上。
   */
  let removedRoot: string | null = null;
  let removed = new Set<string>();

  const loadRemoved = (): void => {
    removedRoot = context.workspace.rootPath;
    removed = new Set<string>(
      removedRoot ? (context.storage.global.get<string[]>(removedKey(removedRoot), []) ?? []) : [],
    );
  };

  const persistRemoved = (): void => {
    if (!removedRoot) return;
    // undefined = 删除键（见 persistCollapsed 里为什么不能用 null）
    void context.storage.global.update(
      removedKey(removedRoot),
      removed.size > 0 ? [...removed] : undefined,
    );
  };

  const body = document.createElement('div');
  // 专属类：ViewHost 的容器也叫 .view-body，querySelector 会先命中容器而不是这里
  body.className = 'explorer-tree';
  // tabindex=-1 让它可编程聚焦（keydown 也挂在它上面）—— 没有它 focus() 无效
  body.setAttribute('tabindex', '-1');
  container.append(body);

  const empty = (text: string) => {
    const node = document.createElement('div');
    node.className = 'view-empty';
    node.textContent = text;
    body.append(node);
  };

  /**
   * 工作区抬头：目录名 + 关闭按钮。
   *
   * 树本身只渲染根目录的**子项**，根目录叫什么一直无处可见；而"关闭工作区"
   * 如果只挂在命令面板里，等于没入口（用户不会去搜一个自己不知道存在的命令）。
   */
  const buildHeader = (rootName: string): HTMLElement => {
    const header = document.createElement('div');
    header.className = 'explorer-header';

    const name = document.createElement('span');
    name.className = 'explorer-header__name';
    name.textContent = rootName;
    // 长目录名会被省略号截断，悬停要能看到全名
    name.title = rootName;
    header.append(name);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'explorer-header__close';
    close.textContent = '×';
    close.title = t('toolbar.closeWorkspace');
    close.setAttribute('aria-label', t('toolbar.closeWorkspace'));
    close.addEventListener('click', () => {
      void context.window.closeWorkspace();
    });
    header.append(close);

    return header;
  };

  const removeFromWorkspace = (path: string): void => {
    removed.add(path);
    persistRemoved();
    void refresh();
  };

  const renderEntry = (
    entry: Entry,
    depth: number,
    activePath: string | null,
    forcedOpen = false,
  ) => {
    if (entry.kind === 'file' && !MARKDOWN.test(entry.name)) return;

    const isDir = entry.kind === 'directory';
    /*
     * 视觉上是否收起：折叠集合说了算。
     * forcedOpen 单独管"要不要真的展开子树"—— 两者在同一行上必须一致，
     * 否则会出现箭头朝下而子树空着（或者反过来）的错位状态。
     */
    const isCollapsed = isDir && !forcedOpen && collapsed.has(entry.path);

    const row = document.createElement('button');
    row.className = 'tree-item' + (entry.path === activePath ? ' tree-item--active' : '');
    row.style.paddingLeft = `${10 + depth * 12}px`;
    row.type = 'button';

    /*
     * 折叠箭头。
     *
     * 原来只有"点整行折叠"，没有任何视觉暗示 —— 用户根本不知道目录能点，
     * 于是只能一个个文件点开去试。加了箭头之后，
     * "哪些行是可展开的"一眼可见，缩进层级也对齐了。
     *
     * 画法用 CSS 边框三角而不是 SVG：它要跟着文字颜色走（继承 currentColor），
     * 且旋转靠 transform，不占额外的资源请求。文件行则渲染一个**空占位**
     * 而不是不留空 —— 不留空会让文件名的缩进比目录名浅一格，
     * 树看起来是歪的。
     */
    const twisty = document.createElement('span');
    twisty.className =
      'tree-item__twisty' + (isDir ? '' : ' tree-item__twisty--leaf');
    if (isDir) {
      twisty.classList.toggle('tree-item__twisty--collapsed', isCollapsed);
      // 箭头有语义（展开/收起），screen reader 也该读得到
      twisty.setAttribute('aria-hidden', 'false');
      row.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    } else {
      twisty.setAttribute('aria-hidden', 'true');
    }
    row.append(twisty);

    const label = document.createElement('span');
    label.className = 'tree-item__label';
    /*
     * 目录名后面那个 "/" 是历史包袱。
     *
     * 有了箭头和缩进之后它变成纯噪音 —— VSCode / Typora / Obsidian
     * 都不加，而且长目录名加个斜杠更容易被截断成"…/"。
     */
    label.textContent = entry.name;
    row.append(label);

    /*
     * 目录行右侧的「移除」动作。
     *
     * 用 span + role=button 而不是真正的 <button>：row 本身已经是 <button>，
     * 嵌套按钮是非法 HTML，浏览器会把内层按钮提到外层之外，点击行为随之错乱。
     *
     * 只在悬停 / 聚焦时露出（见 CSS），但不做 display:none —— 触摸屏没有
     * 悬停这回事，`@media (hover: none)` 里让它常显。
     */
    if (isDir) {
      const action = document.createElement('span');
      action.className = 'tree-item__action';
      action.setAttribute('role', 'button');
      action.setAttribute('aria-label', t('view.removeFromWorkspace'));
      action.title = t('view.removeFromWorkspace');
      action.textContent = '×';
      action.addEventListener('click', (event) => {
        // 不拦的话这一下会同时触发整行的折叠/展开
        event.stopPropagation();
        removeFromWorkspace(entry.path);
      });
      row.append(action);
    }

    /*
     * 单击 = 开在**预览标签**里（斜体），而且会替换掉上一个预览标签。
     *
     * 这是"在文件树里连着翻几个文件看看"时该有的行为：
     * 标签栏不会越点越长，只有最后看的那个留在那儿。
     */
    row.addEventListener('click', () => {
      if (isDir) {
        if (collapsed.has(entry.path)) collapsed.delete(entry.path);
        else collapsed.add(entry.path);
        persistCollapsed();
        void refresh();
        return;
      }
      void viewContext.executeCommand('aropyt.explorer.open', entry.path, { preview: true });
    });

    /*
     * 双击 = 开在**固定标签**里（非斜体）。
     *
     * 双击会先触发两次 click，所以此刻那个文件大概率已经是个预览标签了 ——
     * 这一次用"固定"方式打开会顺手把它**转正**，最终结果正确。
     * 中间那一瞬的斜体是 VSCode 也有的，不必消除（消除反而要引入延时判断，
     * 让单击变迟钝）。
     */
    row.addEventListener('dblclick', () => {
      if (isDir) return;
      void viewContext.executeCommand('aropyt.explorer.open', entry.path, { preview: false });
    });

    body.append(row);
  };

  const renderTree = async (dirPath: string, depth: number, activePath: string | null) => {
    const entries = await context.workspace.list(dirPath);
    for (const entry of entries) {
      /*
       * 已移除的目录连同子树一起不渲染。
       *
       * 只过滤掉这一行是不够的 —— 子项在下一层递归里，跳过父级就自然断了，
       * 这正是我们想要的（移除整棵子树，而不是只藏一层）。
       */
      if (removed.has(entry.path)) continue;

      const typed: Entry = { path: entry.path, name: entry.name, kind: entry.kind };
      /*
       * 展开判定要算上"活动文件所在目录必须可见"这条临时规则。
       *
       * 只改箭头不改遍历的话会出现"箭头朝下但子树是折的"——
       * 视觉与行为不一致，比不做这个功能更容易让人困惑。
       * 所以可见性用同一个函数算，两边共用一个真相。
       */
      const forcedOpen =
        typed.kind === 'directory' && typed.path + '/' === parentOf(activePath);
      renderEntry(typed, depth, activePath, forcedOpen);
      if (typed.kind === 'directory' && (forcedOpen || !collapsed.has(typed.path))) {
        await renderTree(typed.path, depth + 1, activePath);
      }
    }
  };

  const refresh = async () => {
    if (disposed) return;
    body.replaceChildren();

    const root = context.workspace.rootPath;
    if (!root) {
      /*
       * 先指向「打开文件」，理由同 file.ts：
       * 文件夹选择器只列子目录，只装着 .md 的目录在它眼里是空的。
       */
      empty(t('view.noWorkspace'));
      return;
    }

    body.append(buildHeader(root));

    try {
      const activePath = context.editor.activeFile;
      await renderTree('', 0, activePath);
      if (!body.querySelector('.tree-item')) {
        /*
         * 区分两种"空"。
         *
         * 全都移除光了却提示"工作区里还没有 markdown 文件"，会把人引向
         * "是不是文件丢了" —— 而真相是目录被自己藏起来了，一条命令就能找回来。
         */
        empty(removed.size > 0 ? t('view.allRemoved') : t('view.noMarkdown'));
      }
    } catch (error) {
      console.error(error);
      /*
       * 要把**真实错误**显示出来。
       *
       * 原来是一句笼统的"可能是授权已过期" —— 而读取失败的成因很多：
       * 目录被删、权限不足、原生侧命令报错、工作区没登记上。
       * 一律归因于"授权过期"会把人引到完全错误的方向（尤其原生端
       * 根本没有"授权"这个概念）。现在附带原文，用户截图就能定位。
       */
      const detail = error instanceof Error ? error.message : String(error);
      empty(t('view.readWorkspaceFailed', { detail }));
    }
  };

  /*
   * 键盘导航：vim 用户的"开侧栏 → j/k 移动 → Enter 打开"闭环。
   *
   * 面板需要 tabindex=-1 才能接收焦点；没有焦点就没有 keydown。
   * 移动基于**当前可见行**（折叠的目录里行不存在，天然跳过）。
   * 高亮用 .tree-item--focused，与"活动文件"高亮（aria-current）是两回事 ——
   * 前者是键盘光标，后者是文档状态。
   *
   * ⚠️ 这段必须挂在 mount 作用域，**不能挂在行的 click 处理器里**。
   * 曾经它被误粘进 click 内部，后果是每点一次目录就多挂一个 keydown 监听
   * （事件叠加、同一次按键移动好几行），而且 `focusedRow` 每次点击都重新
   * 声明，键盘光标永远回到起点。
   */
  let focusedRow: HTMLElement | null = null;

  const visibleRows = (): HTMLElement[] =>
    Array.from(body.querySelectorAll<HTMLElement>('.tree-item'));

  const setFocus = (row: HTMLElement | null): void => {
    focusedRow?.classList.remove('tree-item--focused');
    focusedRow = row;
    row?.classList.add('tree-item--focused');
    row?.scrollIntoView({ block: 'nearest' });
  };

  body.addEventListener('keydown', (event: KeyboardEvent) => {
    const rows = visibleRows();
    if (rows.length === 0) return;
    const index = focusedRow ? rows.indexOf(focusedRow) : -1;
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      setFocus(rows[Math.min(index + 1, rows.length - 1)] ?? rows[0]);
      return;
    }
    if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      setFocus(rows[Math.max(index - 1, 0)] ?? rows[0]);
      return;
    }
    if (event.key === 'Enter' && focusedRow) {
      event.preventDefault();
      focusedRow.click();
    }
  });

  loadRemoved();
  void refresh();

  const workspaceSub = context.workspace.onDidChangeWorkspace(() => {
    /*
     * 换工作区要重载移除列表。
     *
     * 顺序不能反：先重载再刷新，否则会先按上一个项目的移除记录渲染一遍，
     * 用户看到的是"刚打开的目录里少了一半东西"。
     */
    loadRemoved();
    void refresh();
  });
  const activeSub = context.editor.onDidChangeActiveFile(() => {
    void refresh();
  });

  // 目录行也要能被点击折叠/打开，所以 explorer 需要一个内部命令来打开文件。
  const openDisposable = context.commands.register(
    'aropyt.explorer.open',
    (path: unknown, options: unknown) => {
      if (typeof path !== 'string') return undefined;
      const preview =
        typeof options === 'object' && options !== null && 'preview' in options
          ? Boolean((options as { preview?: unknown }).preview)
          : false;
      return context.editor.openDocument(path, { preview });
    },
  );

  /*
   * 恢复全部已移除的目录。
   *
   * 做成"一次全恢复"而不是 QuickPick 选单个：移除是低风险的整理动作，
   * 数量通常是个位数，逐个拣选反而更慢。真需要精细恢复时，删掉
   * memento 里的那个键也行 —— 但这不该是用户要记住的操作。
   */
  const restoreDisposable = context.commands.register('aropyt.explorer.restore', async () => {
    if (removed.size === 0) {
      await context.window.showMessage(t('view.nothingToRestore'), { level: 'info' });
      return;
    }
    const count = removed.size;
    removed.clear();
    persistRemoved();
    await refresh();
    await context.window.showMessage(t('view.restoredAll', { n: String(count) }), { level: 'info' });
  });

  return {
    dispose() {
      disposed = true;
      workspaceSub.dispose();
      activeSub.dispose();
      openDisposable.dispose();
      restoreDisposable.dispose();
      container.replaceChildren();
    },
  };
}

export const explorerPlugin: LoadablePlugin = { manifest, activate };
