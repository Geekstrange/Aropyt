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
import type { LoadablePlugin } from '@aropyt/core';

const manifest: PluginManifest = {
  id: 'aropyt.explorer',
  name: '文件树',
  version: '0.1.0',
  engines: { aropyt: '^0.1.0' },
  activationEvents: ['onView:aropyt.explorer'],
  contributes: {
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
 * 折叠状态在memento 里的键。
 *
 * 存进工作区存储而不是内存里的 Set：Set 活不过视图卸载，
 * 而"上次把哪些目录折起来了"恰恰是用户会期待被记住的东西 ——
 * 尤其大工作区里谁都记不住自己折过什么。重启后原样恢复，
 * 是这类"看不见的状态"唯一说得通的表现方式。
 */
const COLLAPSED_KEY = 'explorer.collapsed';

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
   * 折叠集合的初值从工作区存储读。
   *
   * 读的是global 而不是 workspace：这个 key 存的是"用户在折叠哪些目录"，
   * 属于**界面偏好**而不是项目数据。换一个工作区时恢复成默认展开更合理
   * （新项目没人想先折上一百层），但同一工作区反复开关必须保持原样。
   */
  const collapsed = new Set<string>(context.storage.global.get<string[]>(COLLAPSED_KEY, []));
  let disposed = false;

  const persistCollapsed = (): void => {
    /*
     * 存 null 表示"全展开"而不是存空数组。
     *
     * 区别在于体积：一个折了几十个目录的工作区，展开态数组也是同样的几十个路径。
     * 而恢复时全展开是绝大多数情况下的默认，不需要任何数据。
     */
    void context.storage.global.update(COLLAPSED_KEY, collapsed.size > 0 ? [...collapsed] : null);
  };

  const body = document.createElement('div');
  body.className = 'view-body';
  container.append(body);

  const empty = (text: string) => {
    const node = document.createElement('div');
    node.className = 'view-empty';
    node.textContent = text;
    body.append(node);
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

    /*
     * 活动文件所在的目录必须强制展开。
     *
     * 不这么做的话：折叠 `docs/` 之后在里面打开一个文件，
     * 文件树里看不到任何高亮项 —— 用户会以为文件没打开，
     * 甚至怀疑编辑器坏了。而这个"看不见当前文件在哪"的状态
     * 只有一种成因，就是折叠与选中互相不知情。
     *
     * 注意这是**临时**展开（forcedOpen 不写回 collapsed），
     * 所以下次刷新它还是会折回去 —— 用户主动折起来的意图
     * 不该被一次打开动作永久改掉。
     */

    body.append(row);
  };

  const renderTree = async (dirPath: string, depth: number, activePath: string | null) => {
    const entries = await context.workspace.list(dirPath);
    for (const entry of entries) {
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

    if (!context.workspace.rootPath) {
      /*
       * 先指向「打开文件」，理由同 file.ts：
       * 文件夹选择器只列子目录，只装着 .md 的目录在它眼里是空的。
       */
      empty('尚未打开工作区。点顶部工具栏的「打开文件…」或「打开文件夹…」开始。');
      return;
    }

    try {
      const activePath = context.editor.activeFile;
      await renderTree('', 0, activePath);
      if (body.childElementCount === 0) empty('工作区里还没有 markdown 文件。');
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
      empty(`读取工作区失败：${detail}`);
    }
  };

  void refresh();

  const workspaceSub = context.workspace.onDidChangeWorkspace(() => {
    void refresh();
  });
  const activeSub = context.editor.onDidChangeActiveFile(() => {
    void refresh();
  });

  // 目录行也要能被点击折叠/打开，所以 explorer 需要一个内部命令来打开文件。
  const openDisposable = context.commands.register(
    'aropyt.explorer.open',
    (path: unknown, options: unknown) => {
      // TEMP-DEBUG
      console.log('[tabs-debug] cmd', JSON.stringify(path), JSON.stringify(options));
      if (typeof path !== 'string') return undefined;
      const preview =
        typeof options === 'object' && options !== null && 'preview' in options
          ? Boolean((options as { preview?: unknown }).preview)
          : false;
      return context.editor.openDocument(path, { preview });
    },
  );

  return {
    dispose() {
      disposed = true;
      workspaceSub.dispose();
      activeSub.dispose();
      openDisposable.dispose();
      container.replaceChildren();
    },
  };
}

export const explorerPlugin: LoadablePlugin = { manifest, activate };
