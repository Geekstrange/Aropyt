/**
 * 内置插件：文件操作。
 *
 * 这个文件的存在本身就是"一切皆插件"的验收标准 ——
 * 连"打开文件夹"这种看起来天然属于外壳的动作，都必须写成插件。
 * 一旦它绕过插件 API 直接调运行时，插件生态就永远不可能长出来。
 *
 * 唯一的外壳协作是 window.pickWorkspaceFolder()：只有"弹系统选择器"
 * 这一步需要宿主代劳，选择之后的全部处理都在插件里。
 */

import type { PluginContext, PluginManifest } from '@aropyt/plugin-api';
import type { LoadablePlugin } from '@aropyt/core';

const manifest: PluginManifest = {
  id: 'aropyt.file',
  name: '文件',
  version: '0.1.0',
  engines: { aropyt: '^0.1.0' },
  activationEvents: ['onStartupFinished', 'onCommand:aropyt.file.save'],
  contributes: {
    commands: [
      { id: 'aropyt.file.pickWorkspace', title: '打开文件夹…', category: '文件', icon: 'openFolder' },
      { id: 'aropyt.file.openFile', title: '打开文件…', category: '文件', icon: 'openFile' },
      { id: 'aropyt.file.regrant', title: '恢复上次工作区', category: '文件' },
      /*
       * 与"打开文件夹"成对。没有这条命令时，"关闭工作区"这个状态根本没有
       * 入口 —— 用户只能靠再打开另一个文件夹来换，想回到初始态无路可走。
       */
      { id: 'aropyt.file.closeWorkspace', title: '关闭工作区', category: '文件' },
      { id: 'aropyt.file.save', title: '保存', category: '文件', icon: 'save' },
      { id: 'aropyt.file.export', title: '导出…', category: '文件', icon: 'export' },
    ],
    menus: {
      toolbar: [
        { command: 'aropyt.file.pickWorkspace', group: '1', order: 1 },
        { command: 'aropyt.file.openFile', group: '1', order: 2 },
        { command: 'aropyt.file.save', group: '1', order: 3 },
        /*
         * 导出紧跟在保存后面：两者是同一个心理动作（"把这篇东西弄出去"），
         * 挨着才找得到。实现放在宿主（`aropyt.export.run`）—— 它要调原生
         * pandoc，而插件 API 没有原生通道。
         */
        { command: 'aropyt.file.export', group: '1', order: 4 },
      ],
    },
  },
};

function activate(context: PluginContext): void {
  context.commands.register('aropyt.file.pickWorkspace', () => context.window.pickWorkspaceFolder());

  /*
   * 打开单个文件。与"打开文件夹"互补：
   * 文件夹选择器只显示子文件夹（用户在全是 .md 的目录里看到空列表），
   * 文件选择器只显示文件。两条路覆盖两种直觉。
   */
  context.commands.register('aropyt.file.openFile', () => context.window.openMarkdownFile());

  context.commands.register('aropyt.file.regrant', () => context.window.regrantLastWorkspaceFolder());

  /*
   * 关闭工作区。
   *
   * 返回值刻意不处理：用户取消（标签脏 + 点了取消）时宿主已经问过一遍，
   * 这里再弹一句"已取消"只会多一次噪音。
   */
  context.commands.register('aropyt.file.closeWorkspace', () => context.window.closeWorkspace());

  /*
   * 保存。
   *
   * 这里**不做任何前置拦截** —— 没有关联路径的未命名文档，由
   * `document.save()` 自己去问"存到哪"（另存为）。
   *
   * 早先这段写的是"path 为空就弹提示并 return"，理由是"另存为还没做"。
   * 那条提示把系统的功能缺口转嫁给了用户：用户只是想把正在写的东西存下来，
   * 却被要求先去左侧文件树里挑一个文件 —— 而"存到哪"正是保存这个动作
   * 本该问出来的事。**功能没做就老老实实做功能，别让用户绕路。**
   *
   * 现在 `save()` 的语义是完整的：有路径就写回原处，没有就问一个路径。
   * 命令层因此不需要知道文档有没有落过盘。
   */
  context.commands.register('aropyt.file.save', async () => {
    const document = context.editor.activeDocument;
    if (!document) return;
    await document.save();
  });

  /*
   * 导出：转发给宿主。
   *
   * 插件这一层什么都不做 —— 选格式、选路径、调 pandoc、报错提示全在
   * `runtime.exportDocument()` 里（宿主才有原生通道）。这里存在的唯一
   * 意义是让导出出现在工具栏与命令面板里，和其它文件类命令同组。
   */
  context.commands.register('aropyt.file.export', () => context.commands.execute('aropyt.export.run'));
}

export const filePlugin: LoadablePlugin = { manifest, activate };
