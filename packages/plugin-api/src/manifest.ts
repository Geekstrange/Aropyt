/**
 * 插件清单 —— 声明式贡献点（declarative contribution points）。
 *
 * 这是从 VS Code 学来的第一条哲学，也是最容易被抄漏的一条：
 *
 *   插件不参与 UI 构建，只做两件事 —— 【声明】它有什么，【提供数据】给它。
 *   工具栏按钮长什么样、菜单怎么排序、设置页怎么渲染，全部由核心决定。
 *
 * 为什么这条重要：一旦允许插件自由构建 UI，核心就再也无法保证
 * 一致性、可访问性、键盘导航和多平台自适应。VS Code 的界面十年不散架，
 * 靠的就是这个约束。
 *
 * 第二条哲学在 activationEvents 里：惰性激活。装了 100 个插件，
 * 只要触发条件没命中，就一个字节都不加载。这是"插件化"与"轻量"能共存的唯一原因。
 */

/** 平台能力名。与能力适配层的探测结果一一对应。 */
export type CapabilityName =
  | 'native-fs'
  | 'file-watch'
  | 'global-shortcut'
  | 'tray'
  | 'file-associations'
  | 'clipboard-image-to-disk'
  | 'auto-update'
  | 'worker';

/**
 * 能力声明。插件自己说清楚"我需要什么"，核心在加载前裁决。
 *
 * 这是把「平台能力分层」从一种无奈变成一种设计：Android 上没有系统托盘，
 * 那不是 bug，那是插件声明了 `tray` 而当前平台不满足，于是插件被禁用、
 * 并在设置页里明确告诉用户原因 —— 对应我们一直在用的「保留入口 + 升级提示」模式。
 */
export interface PluginCapabilities {
  /** 缺任何一项就不加载插件，并在 UI 中说明原因。 */
  readonly required?: readonly CapabilityName[];
  /** 缺失时降级运行，插件自己负责探测。 */
  readonly optional?: readonly CapabilityName[];
}

/**
 * 激活事件。决定插件代码何时被首次载入。
 *
 * 通配符 `*` 会让插件在启动时就加载 —— 除非万不得已，别用。
 * 插件的启动成本是可以被声明式地控制到零的，关键在于作者是否愿意。
 */
export type ActivationEvent =
  | '*'
  | 'onStartupFinished'
  | `onCommand:${string}`
  | `onView:${string}`
  | `onLanguage:${string}`
  | `onWorkspaceContains:${string}`
  | `onPlugin:${string}`;

export interface CommandContribution {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  readonly enablement?: string;
  readonly icon?: string;
}

export interface KeybindingContribution {
  readonly command: string;
  /** 规范写法，如 `Ctrl+Shift+V`。核心在运行时翻译为各平台按键。 */
  readonly key: string;
  readonly when?: string;
}

export type MenuLocation =
  | 'toolbar'
  | 'commandPalette'
  | 'editor/context'
  | 'explorer/context'
  | 'view/title'
  | 'statusbar';

export interface MenuItemContribution {
  readonly command: string;
  readonly when?: string;
  readonly group?: string;
  readonly order?: number;
}

export type ViewLocation = 'sidebar' | 'panel' | 'statusbar';

export interface ViewContribution {
  readonly id: string;
  readonly title: string;
  readonly location: ViewLocation;
  readonly icon?: string;
  readonly order?: number;
  readonly when?: string;
}

export interface ConfigurationPropertySchema {
  readonly type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  readonly default?: unknown;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly enumDescriptions?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly scope?: 'application' | 'window' | 'resource';
}

export interface ConfigurationContribution {
  readonly title?: string;
  readonly properties: Readonly<Record<string, ConfigurationPropertySchema>>;
}

export interface ThemeContribution {
  readonly id: string;
  readonly label: string;
  readonly uiTheme: 'light' | 'dark';
  /** 一组 CSS 自定义属性。内核只认变量名，不认识具体色值。 */
  readonly variables: Readonly<Record<`--${string}`, string>>;
}

/**
 * 语言贡献点。既用于语法解析，也用于生成 `onLanguage:` 激活事件，
 * 还用于让用户在"文件类型"里手动切换。
 */
export interface LanguageContribution {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly extensions?: readonly string[];
  readonly filenames?: readonly string[];
  readonly firstLine?: string;
}

export interface FileHandlerContribution {
  readonly id: string;
  readonly label: string;
  readonly extensions: readonly string[];
}

export interface Contributions {
  readonly commands?: readonly CommandContribution[];
  readonly keybindings?: readonly KeybindingContribution[];
  readonly menus?: Readonly<Partial<Record<MenuLocation, readonly MenuItemContribution[]>>>;
  readonly views?: readonly ViewContribution[];
  readonly configuration?: ConfigurationContribution;
  readonly themes?: readonly ThemeContribution[];
  readonly languages?: readonly LanguageContribution[];
  readonly fileHandlers?: readonly FileHandlerContribution[];
}

export interface PluginManifest {
  /** 反域名风格，全局唯一：`aropyt.markdown-preview` */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: string;
  readonly license?: string;
  readonly repository?: string;
  readonly icon?: string;

  /**
   * 宿主 API 版本范围。发布即承诺 —— 这是插件生态里最容易被忽视的兼容负担。
   * API 一旦对外发布，破坏性变更就需要走弃用期，而不是直接改。
   */
  readonly engines: { readonly aropyt: string };

  /** 相对插件根目录的 ESM 入口。省略则视为"纯声明式插件"，不需要代码。 */
  readonly main?: string;

  readonly activationEvents: readonly ActivationEvent[];
  readonly capabilities?: PluginCapabilities;
  readonly contributes?: Contributions;
}

/** 纯声明式插件清单（无 main），例如只贡献一套主题或一个语法定义。 */
export interface DeclarativePluginManifest extends PluginManifest {
  readonly contributes: Contributions;
}
