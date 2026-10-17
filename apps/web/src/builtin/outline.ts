/**
 * 内置插件：大纲。
 *
 * 它的实现只有十几行，因为两件事都由 API 承担了：
 *   - 大纲抽取 → languages.extractOutline（解析源码而不是 DOM）
 *   - 跳转     → editor.revealLine
 *
 * 这正是"薄内核 + 厚 API"应该有的样子：功能简单不是因为功能不重要，
 * 而是因为它不需要绕过任何抽象。
 */

import type { PluginContext, PluginManifest } from '@aropyt/plugin-api';
import type { LoadablePlugin } from '@aropyt/core';

const manifest: PluginManifest = {
  id: 'aropyt.outline',
  name: '大纲',
  version: '0.1.0',
  engines: { aropyt: '^0.1.0' },
  activationEvents: ['onView:aropyt.outline'],
  contributes: {
    views: [{ id: 'aropyt.outline', title: '大纲', location: 'sidebar', order: 2 }],
  },
};

/**
 * 大纲的折叠状态**不跨会话保留**。
 *
 * 与文件树的区别值得写清：文件树用路径当键，路径在文档之间也是稳定的，
 * 所以那个能记；大纲里能用的键只有序号或标题文本，前者换个文档就指错，
 * 后者会因重名与改名失效。所以这里只活在本次挂载周期内。
 * 文件树的同类常量见 explorer.ts。
 */

interface OutlineEntry {
  /** 大纲里的唯一序号。折叠状态用它当键，不用标题文本（标题会重名也会改）。 */
  readonly index: number;
  readonly text: string;
  readonly level: number;
  readonly line: number;
}

/**
 * 判断每个条目是否应当被折叠隐藏。
 *
 * 大纲没有显式的父子结构，只有一个扁平的"标题 + 层级"列表。
 * 折叠规则因此只能是：**比它深的后续条目都是它的子节点**，
 * 直到遇到同级或更浅的标题。
 *
 * 一次线性扫描就够：从后往前记住"下一个更浅或同级的位置"，
 * 即每个条目的子树结束下标。返回 `endIndex`，渲染时按下标区间跳过。
 */
function computeSubtreeEnds(items: readonly OutlineEntry[]): readonly number[] {
  const ends: number[] = new Array(items.length).fill(items.length);
  const stack: number[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const level = items[i].level;
    /*
     * 弹掉所有"层级 >= 当前"的栈顶。
     *
     * 用 >= 而不是 >：同级的上一个标题不是父节点，
     * 只有严格更深的才把自己收进来当子节点。
     */
    while (stack.length > 0 && items[stack[stack.length - 1]].level >= level) {
      stack.pop();
    }
    if (stack.length > 0) {
      const parent = stack[stack.length - 1];
      // 当前条目是它的子节点：父节点的子树至少要覆盖到当前位置。
      ends[parent] = i + 1;
    }
    stack.push(i);
  }

  return ends;
}


function activate(context: PluginContext): void {
  context.subscriptions.push(
    context.window.registerView(
      { id: 'aropyt.outline', title: '大纲', location: 'sidebar', order: 2 },
      {
        render(container, viewContext) {
          const body = document.createElement('div');
          body.className = 'view-body';
          container.append(body);

          let disposed = false;
          // 文档变化很频繁，但大纲不需要跟着每一次按键重算。
          let pending: ReturnType<typeof setTimeout> | null = null;

          /*
           * 折叠集合记的是**条目序号**而不是标题文本。
           *
           * 用文本会有两个问题：一是标题可以改名（改了名状态就丢），
           * 二是同名标题到处是（`## 概述` 可能有三个）。
           * 序号在一次挂载周期内稳定，重绘时只要重建映射即可。
           *
           * 不写进 memento：序号只在当前这份文档里有意义，
           * 跨文件沿用会指到别的文档的标题上 —— 展开一堆不相干的标题，
           * 比不记忆更难解释。文件树用的是**路径**，那个能跨会话。
           */
          const collapsed = new Set<number>();
          const lastItems = new Map<number, OutlineEntry>();

          let seq = 0;
          const refresh = async () => {
            if (disposed) return;
            const ticket = ++seq;

            const raw = await context.languages.extractOutline(context.editor.getText());
            if (disposed || ticket !== seq) return;

            const items: OutlineEntry[] = raw.map((item, index) => ({
              index,
              text: item.text,
              level: item.level,
              line: item.line,
            }));
            const ends = computeSubtreeEnds(items);

            // 只保留当前文档里仍存在的序号，防止旧状态无限堆积。
            for (const key of [...collapsed]) {
              if (!lastItems.has(key)) collapsed.delete(key);
            }

            body.replaceChildren();
            if (items.length === 0) {
              const empty = document.createElement('div');
              empty.className = 'view-empty';
              empty.textContent = '当前文档还没有标题。';
              body.append(empty);
              return;
            }

            /*
             * 用"跳过区间"而不是给每行判可见性。
             *
             * 前者遇到多层嵌套天然正确（折叠一个 h2 会连带跳过
             * 它的 h3、h4……），后者要在每行问"我是不是被某个祖先折着"
             * —— 那需要向上回溯，且在折叠态变化时容易漏算一层。
             */
            let i = 0;
            while (i < items.length) {
              const item = items[i];
              lastItems.set(item.index, item);
              const hasChildren = ends[i] > i + 1;
              const isCollapsed = collapsed.has(item.index) && hasChildren;

              const row = document.createElement('button');
              row.type = 'button';
              row.className = 'tree-item tree-item--outline';
              row.style.paddingLeft = `${10 + (item.level - 1) * 10}px`;
              if (isCollapsed) row.classList.add('tree-item--collapsed');

              const twisty = document.createElement('span');
              twisty.className = hasChildren
                ? 'tree-item__twisty' + (isCollapsed ? ' tree-item__twisty--collapsed' : '')
                : 'tree-item__twisty tree-item__twisty--leaf';
              twisty.setAttribute('aria-hidden', hasChildren ? 'false' : 'true');
              row.append(twisty);

              const label = document.createElement('span');
              label.className = 'tree-item__label';
              label.textContent = item.text;
              row.append(label);

              if (hasChildren) row.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');

              const toggle = (): void => {
                if (collapsed.has(item.index)) collapsed.delete(item.index);
                else collapsed.add(item.index);
                void refresh();
              };

              /*
               * 箭头：折叠 / 展开。
               *
               * `stopPropagation` 是这里的关键 —— 没有它，点击会继续冒泡到
               * 整行的 handler，于是"点箭头"变成"折叠 + 跳转"一起发生。
               *
               * 用 span 而不是 button：整行已经是 `<button>`（负责跳转），
               * 按钮里嵌按钮是非法 HTML，浏览器会把它拆开，布局跟着乱。
               * 键盘那条路由下面的方向键承担。
               */
              if (hasChildren) {
                twisty.addEventListener('click', (event) => {
                  event.stopPropagation();
                  toggle();
                });
              }

              /*
               * 整行点击 = **跳到那个标题**。
               *
               * 这里原来写的是"有子节点就折叠、没有才跳转"，结果是
               * 只要标题带下级（多数文档都如此）就永远跳不过去 ——
               * 用户报的"点击节点不会跳转"正是这个。
               *
               * 折叠与跳转是两个不同的意图，该由两个不同的落点承担：
               * 箭头管折叠，行管跳转。这也和 VSCode / Obsidian 的树一致。
               */
              row.addEventListener('click', () => {
                context.editor.revealLine(item.line);
              });

              /*
               * 键盘走 VSCode 树的约定：← 收起、→ 展开。
               *
               * 有了这条，箭头不做成 button 也不会留下"键盘用户无法折叠"
               * 的缺口 —— 而且比重做一套嵌套控件简单得多。
               */
              if (hasChildren) {
                row.addEventListener('keydown', (event) => {
                  if (event.key === 'ArrowLeft' && !isCollapsed) {
                    event.preventDefault();
                    toggle();
                  } else if (event.key === 'ArrowRight' && isCollapsed) {
                    event.preventDefault();
                    toggle();
                  }
                });
              }

              body.append(row);

              if (isCollapsed) {
                // 子树整段跳过。仍要把序号登记进 lastItems，
                // 否则下次重绘会把这些条目当成"已不存在"清掉折叠状态。
                for (let k = i + 1; k < ends[i]; k += 1) lastItems.set(items[k].index, items[k]);
                i = ends[i];
                continue;
              }
              i += 1;
            }
          };

          const schedule = () => {
            if (pending) clearTimeout(pending);
            pending = setTimeout(() => {
              pending = null;
              void refresh();
            }, 200);
          };

          void refresh();

          const docSub = context.editor.onDidChangeDocument(schedule);
          const fileSub = context.editor.onDidChangeActiveFile(() => {
            void refresh();
          });
          const resizeSub = viewContext.onDidResize(() => undefined);

          return {
            dispose() {
              disposed = true;
              if (pending) clearTimeout(pending);
              docSub.dispose();
              fileSub.dispose();
              resizeSub.dispose();
              container.replaceChildren();
            },
          };
        },
      },
    ),
  );
}

export const outlinePlugin: LoadablePlugin = { manifest, activate };
