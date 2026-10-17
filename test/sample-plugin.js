/**
 * Aropyt 示例插件 —— 用来验证「插件管理 → 导入插件…」链路。
 *
 * 导入方式：工具栏 plugins 图标 → 导入插件… → 选这个文件 → 重启应用。
 * 生效后命令面板/工具栏会出现「插入日期」。
 *
 * 插件是单个 ES 模块，必须导出：
 *   - manifest：id / name / version / activationEvents / contributes
 *   - activate(context)：注册命令、视图等
 * 可选导出 deactivate() 做清理。
 *
 * ⚠️ 插件代码在渲染进程里以完整权限运行（与 VS Code 插件同一信任模型，
 * 不是沙箱）—— 只导入你信任的插件。
 */
export const manifest = {
  id: 'sample.insert-date',
  name: '示例：插入日期',
  version: '0.0.1',
  description: '演示插件能力：注册一条插入当前日期的命令',
  activationEvents: ['onStartupFinished'],
  contributes: {
    commands: [
      { id: 'sample.insertDate', title: '插入当前日期', category: '示例', icon: 'save' },
    ],
    menus: {
      toolbar: [{ command: 'sample.insertDate', group: '6', order: 1 }],
    },
  },
};

export function activate(context) {
  context.commands.register('sample.insertDate', () => {
    context.editor.insertText(new Date().toLocaleString('zh-CN'));
  });
}
