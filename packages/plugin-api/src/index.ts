/**
 * @aropyt/plugin-api
 *
 * 插件作者唯一允许 import 的包。零运行时依赖 —— 只有类型，
 * 编译后不产生任何 JS，插件不会因为引入它而多背一克重量。
 *
 * 这个包的存在本身就是一条架构约束：插件没有 import 内核实现的途径。
 * 比运行时检查更硬 —— 用包边界做物理隔离。
 */

export type {
  ActivationEvent,
  CapabilityName,
  CommandContribution,
  ConfigurationContribution,
  ConfigurationPropertySchema,
  Contributions,
  DeclarativePluginManifest,
  FileHandlerContribution,
  KeybindingContribution,
  LanguageContribution,
  MenuItemContribution,
  MenuLocation,
  PluginCapabilities,
  PluginManifest,
  ThemeContribution,
  ViewContribution,
  ViewLocation,
} from './manifest.js';

export type {
  CapabilitySnapshot,
  CommandDescriptor,
  CommandsApi,
  CompletionItem,
  CompletionProvider,
  CompletionRequest,
  ConfigurationApi,
  Disposable,
  DocumentRef,
  DocumentChangeEvent,
  EditorApi,
  EditorExtensionEnv,
  Event,
  FileChangeEvent,
  FileChangeType,
  FileKind,
  FileStat,
  ImportedFile,
  InputBoxOptions,
  LanguagesApi,
  Logger,
  MarkdownItLike,
  MarkdownItPlugin,
  Memento,
  MessageAction,
  MessageLevel,
  MessageOptions,
  OutlineItem,
  PlatformKind,
  PluginContext,
  PluginModule,
  QuickPickItem,
  QuickPickOptions,
  ShellKind,
  SaveAsOptions,
  SelectionInfo,
  StatusBarItem,
  StorageApi,
  ViewContext,
  ViewProvider,
  WindowApi,
  WorkspaceApi,
  WorkspaceFileHandle,
  WorkspaceFileStat,
} from './api.js';
