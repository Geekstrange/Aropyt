/**
 * 内置插件：格式化命令与工具栏。
 *
 * 全部走 `editor` 的语义操作（wrapSelection / toggleLinePrefix），
 * 一个字节的 CodeMirror 都不碰 —— 这既是 API 设计的验证，也是它成立的证明。
 * 唯一用到逃生舱的是块级代码块插入，因为它需要多行选区操作。
 */

import type { PluginContext, PluginManifest } from '@aropyt/plugin-api';
import type { LoadablePlugin } from '@aropyt/core';

const manifest: PluginManifest = {
  id: 'aropyt.formatting',
  name: '格式化',
  version: '0.1.0',
  engines: { aropyt: '^0.1.0' },
  // 纯命令类插件：只有真的按下快捷键才会激活，启动时零开销。
  activationEvents: [
    'onStartupFinished',
    'onCommand:aropyt.bold',
    'onCommand:aropyt.italic',
    'onCommand:aropyt.strikethrough',
    'onCommand:aropyt.inlineCode',
    'onCommand:aropyt.link',
    'onCommand:aropyt.h1',
    'onCommand:aropyt.h2',
    'onCommand:aropyt.h3',
    'onCommand:aropyt.bulletList',
    'onCommand:aropyt.orderedList',
    'onCommand:aropyt.taskList',
    'onCommand:aropyt.blockquote',
    'onCommand:aropyt.codeBlock',
    'onCommand:aropyt.table',
    'onCommand:aropyt.image',
  ],
  contributes: {
    commands: [
      { id: 'aropyt.bold', title: '加粗', category: '格式', icon: 'bold' },
      { id: 'aropyt.italic', title: '斜体', category: '格式', icon: 'italic' },
      { id: 'aropyt.strikethrough', title: '删除线', category: '格式', icon: 'strikethrough' },
      { id: 'aropyt.inlineCode', title: '行内代码', category: '格式', icon: 'inlineCode' },
      { id: 'aropyt.link', title: '插入链接', category: '格式', icon: 'link' },
      { id: 'aropyt.h1', title: '一级标题', category: '格式', icon: 'h1' },
      { id: 'aropyt.h2', title: '二级标题', category: '格式', icon: 'h2' },
      { id: 'aropyt.h3', title: '三级标题', category: '格式', icon: 'h3' },
      { id: 'aropyt.bulletList', title: '无序列表', category: '格式', icon: 'bulletList' },
      { id: 'aropyt.orderedList', title: '有序列表', category: '格式', icon: 'orderedList' },
      { id: 'aropyt.taskList', title: '任务列表', category: '格式', icon: 'taskList' },
      { id: 'aropyt.blockquote', title: '引用', category: '格式', icon: 'quote' },
      { id: 'aropyt.codeBlock', title: '代码块', category: '格式', icon: 'codeBlock' },
      { id: 'aropyt.table', title: '插入表格', category: '格式', icon: 'table' },
      { id: 'aropyt.mathBlock', title: '插入公式', category: '格式', icon: 'formula' },
      { id: 'aropyt.image', title: '插入图像', category: '格式', icon: 'image' },
    ],
    keybindings: [
      { command: 'aropyt.bold', key: 'Mod-b' },
      { command: 'aropyt.italic', key: 'Mod-i' },
      { command: 'aropyt.link', key: 'Mod-k' },
    ],
    menus: {
      toolbar: [
        { command: 'aropyt.bold', group: '2', order: 1 },
        { command: 'aropyt.italic', group: '2', order: 2 },
        { command: 'aropyt.strikethrough', group: '2', order: 3 },
        { command: 'aropyt.inlineCode', group: '2', order: 4 },
        { command: 'aropyt.link', group: '2', order: 5 },
        { command: 'aropyt.h1', group: '3', order: 1 },
        { command: 'aropyt.h2', group: '3', order: 2 },
        { command: 'aropyt.h3', group: '3', order: 3 },
        { command: 'aropyt.bulletList', group: '4', order: 1 },
        { command: 'aropyt.orderedList', group: '4', order: 2 },
        { command: 'aropyt.taskList', group: '4', order: 3 },
        { command: 'aropyt.blockquote', group: '4', order: 4 },
        { command: 'aropyt.codeBlock', group: '5', order: 1 },
        { command: 'aropyt.table', group: '5', order: 2 },
        { command: 'aropyt.image', group: '5', order: 3 },
      ],
    },
  },
};

function activate(context: PluginContext): void {
  const { commands, editor } = context;

  commands.register('aropyt.bold', () => editor.wrapSelection('**'));
  commands.register('aropyt.italic', () => editor.wrapSelection('*'));
  commands.register('aropyt.strikethrough', () => editor.wrapSelection('~~'));
  commands.register('aropyt.inlineCode', () => editor.wrapSelection('`'));

  commands.register('aropyt.link', () => {
    const selection = editor.getSelection();
    if (selection && selection.text.length > 0) {
      editor.replaceSelection(`[${selection.text}](url)`);
      return;
    }
    editor.insertText('[链接文字](url)');
  });

  commands.register('aropyt.h1', () => editor.toggleLinePrefix('# '));
  commands.register('aropyt.h2', () => editor.toggleLinePrefix('## '));
  commands.register('aropyt.h3', () => editor.toggleLinePrefix('### '));

  commands.register('aropyt.bulletList', () => editor.toggleLinePrefix('- '));
  commands.register('aropyt.orderedList', () => editor.toggleLinePrefix((index) => `${index + 1}. `));

  commands.register('aropyt.taskList', () => {
    // 任务列表不是纯前缀切换（要插入 [ ]），所以走插入语义。
    const selection = editor.getSelection();
    if (!selection) return;
    for (let line = selection.startLine; line <= selection.endLine; line += 1) {
      const text = editor.getLine(line);
      if (text === null || text.trim() === '') continue;
      if (/^\s*[-*+]\s\[[ xX]\]\s/.test(text)) continue;
      editor.toggleLinePrefix('- [ ] ');
      return;
    }
  });

  commands.register('aropyt.blockquote', () => editor.toggleLinePrefix('> '));

  commands.register('aropyt.codeBlock', () => {
    const selection = editor.getSelection();
    const body = selection?.text ?? '';
    editor.insertText(`\n\`\`\`\n${body}\n\`\`\`\n`);
  });

  commands.register('aropyt.table', () => {
    editor.insertText('\n| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |\n');
  });

  /*
   * 插入图像。
   *
   * 插件只做两件事：向宿主"要"一张导入好的图片，然后往光标处写一行
   * markdown 语法。选文件、读工作区之外的字节、写进 assets/ ——
   * 全部在宿主侧完成，插件拿到的只是一个工作区内的相对路径。
   *
   * 这样即使插件被完全控制，也够不到工作区之外的文件。
   */
  commands.register('aropyt.image', async () => {
    /*
     * 若当前有选中文字，就用它当 alt —— 这是编辑器里一个很自然的期待：
     * 先写"架构图"，选中，再插入图片，得到 `![架构图](assets/xxx.png)`。
     * 没有选中时退回文件名（去掉扩展名）。
     *
     * 要在导入**之前**取，因为导入过程会让编辑器失焦，
     * 回来时选区可能已经不在原处。
     */
    const selected = editor.getSelection()?.text?.trim() ?? '';

    const imported = await context.window.importImage('assets');
    if (!imported) return;

    const alt = selected || imported.name.replace(/\.[^.]+$/, '');
    /*
     * 逐段编码而不是整串 encodeURI：路径分隔符 `/` 必须保留，
     * 而空格、中文、`#` 这类字符必须编码，否则 markdown 解析会截断链接。
     */
    const href = imported.path.split('/').map(encodeURIComponent).join('/');

    const syntax = `![${alt}](${href})`;
    // 有选中就替换掉它（选中内容已升级成 alt），否则插在光标处。
    if (selected) editor.replaceSelection(syntax);
    else editor.insertText(syntax);
  });
}

export const formattingPlugin: LoadablePlugin = { manifest, activate };
