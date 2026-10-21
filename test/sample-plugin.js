/**
 * Aropyt 全场景综合测试插件
 *
 * 覆盖全部五个贡献点 + 生命周期 + 配置读写 + 错误边界：
 *
 *   commands      insertDate / hello / toggleUppercase / throwError
 *   keybindings   Mod-Shift-D → insertDate
 *   menus         toolbar 上放一个按钮
 *   views         sidebar 里一个面板
 *   configuration sample.uppercase（布尔开关）
 *   activate      注册全部命令、视图、配置订阅
 *   deactivate    应用退出或禁用插件时调用
 *
 * 导入方式：设置 → 插件管理 → 导入插件…，选择本文件，重启应用。
 *
 * ⚠️ 插件代码在渲染进程里以完整权限运行（与 VS Code 同一信任模型，
 * 不是沙箱）—— 只导入你信任的插件。
 *
 * 验收清单（导入并重启后逐项确认）：
 *   1. 工具栏出现「插入当前日期」按钮，点击插入时间戳
 *   2. Ctrl/Cmd+Shift+D 同样插入时间戳
 *   3. 「打个招呼」→ 弹输入框 → 显示问候
 *   4. 「切换自动大写」后，配置项 sample.uppercase 变 true，再插入日期为大写
 *   5. 侧栏出现「示例面板」，正文为一行来源说明
 *   6. 「故意抛错」→ 显示错误提示，但编辑器与其它插件不受影响
 *   7. 退出应用 → 控制台出现 [sample] deactivate（有 devtools 时可见）
 */
export const manifest = {
  id: 'sample.everything',
  name: '示例：全场景测试',
  version: '0.1.0',
  description: '覆盖命令 / 键位 / 菜单 / 视图 / 配置与生命周期的综合示例',
  activationEvents: ['onStartupFinished'],
  contributes: {
    commands: [
      { id: 'sample.insertDate', title: '插入此刻时间', category: '示例' },
      { id: 'sample.hello', title: '打个招呼', category: '示例' },
      { id: 'sample.toggleUppercase', title: '切换自动大写', category: '示例' },
      { id: 'sample.throwError', title: '故意抛错（错误边界）', category: '示例' },
    ],
    keybindings: [{ command: 'sample.insertDate', key: 'Mod-Shift-D' }],
    menus: {
      toolbar: [{ command: 'sample.insertDate', group: '6', order: 1 }],
    },
    views: [{ id: 'sample.panel', title: '示例面板', location: 'sidebar' }],
    // ⚠️ configuration 是 { properties: { ... } } —— 多包一层 properties，
    // 直接写扁平对象会让注册时 Object.entries(undefined) 抛错（实测）。
    configuration: {
      properties: {
        'sample.uppercase': {
          type: 'boolean',
          default: false,
          description: '插入日期时转成大写',
        },
      },
    },
  },
};

export function activate(context) {
  console.log('[sample] activate', context.pluginId, context.pluginVersion);

  // ── 命令 ────────────────────────────────────────────────
  context.commands.register('sample.insertDate', () => {
    const uppercase = context.workspace.configuration.get('sample.uppercase', false);
    const text = new Date().toLocaleString('zh-CN');
    context.editor.insertText(uppercase ? text.toUpperCase() : text);
  });

  context.commands.register('sample.hello', async () => {
    const name = await context.window.showInputBox({
      prompt: '你的名字？',
      value: '世界',
    });
    void context.window.showMessage(`你好，${name ?? '陌生人'}！`, { level: 'info' });
  });

  context.commands.register('sample.toggleUppercase', async () => {
    const next = !context.workspace.configuration.get('sample.uppercase', false);
    await context.workspace.configuration.update('sample.uppercase', next);
    void context.window.showMessage(`自动大写：${next ? '开' : '关'}`, { level: 'info' });
  });

  context.commands.register('sample.throwError', () => {
    throw new Error('这是故意抛出的错误（用于验证错误边界）');
  });

  // ── 视图（侧栏面板）──────────────────────────────────────
  context.subscriptions.push(
    context.window.registerView(
      { id: 'sample.panel', title: '示例面板', location: 'sidebar' },
      {
        render(container) {
          container.textContent = '来自插件 sample.everything 的侧栏视图。';
          container.style.padding = '12px';
          container.style.fontSize = '12px';
          container.style.opacity = '0.8';
          return { dispose() {} };
        },
      },
    ),
  );

  // ── 配置变更订阅 ────────────────────────────────────────
  context.subscriptions.push(
    context.workspace.configuration.onDidChange(({ key, value }) => {
      console.log('[sample] config changed:', key, value);
    }),
  );
}

export function deactivate() {
  console.log('[sample] deactivate');
}
