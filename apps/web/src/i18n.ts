/**
 * 应用内 i18n（v0.0.8）。
 *
 * 设计：
 *  - 字典按语言分对象，key 是稳定的英文 id（不是原文 —— 原文会变，id 不会）。
 *  - 缺失 key 的回退顺序：当前语言 → en → key 本身（id 可读，宁多显示英文
 *    也不显示空白）。
 *  - 语言存 settings.jsonc（`locale` 字段），走配置真源，与应用其他设置同路。
 *  - 首版覆盖设置面板与历史面板的核心文案；工具栏/菜单逐步接入。
 */

export const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko", "de", "fr", "it", "ru"] as const;
export type Locale = (typeof LOCALES)[number];

/** 语言在本语言下的自称（设置下拉里显示用）。 */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  ja: "日本語",
  ko: "한국어",
  de: "Deutsch",
  fr: "Français",
  it: "Italiano",
  ru: "Русский",
};

type Dict = Record<string, string>;

const en: Dict = {
  "settings.title": "Settings",
  "settings.appearance": "Appearance",
  "settings.theme": "Theme",
  "settings.theme.light": "Light",
  "settings.theme.dark": "Dark",
  "settings.theme.auto": "System",
  "settings.language": "Language",
  "settings.editor": "Editor",
  "settings.editor.vim": "Vim mode",
  "settings.editor.vimHint": "Vim mode stays in source view — block rendering and line-based motion conflict by nature.",
  "settings.history.title": "Editing history",
  "settings.history.limit": "Versions kept per file",
  "settings.history.autoSave": "Auto-save versions",
  "settings.history.autoSaveInterval": "Auto-save interval (seconds)",
  "settings.history.hint": "Auto-save records a version every interval; unchanged content is deduplicated. Older versions are pruned automatically.",
  "settings.backup.title": "Data backup",
  "settings.backup.export": "Export data",
  "settings.backup.import": "Import data",
  "settings.backup.hint": "Exports all drafts and editing history as a single JSON file — for moving machines or reinstalling. Importing overwrites existing data, so export first.",
  "settings.config.title": "Config file",
  "settings.config.open": "Open config file",
  "history.title": "Editing history",
  "history.snapshot": "Save current as version",
  "history.snapshotPlaceholder": "Version note (optional)",
  "history.snapshotButton": "Save version",
  "history.restore": "Restore",
  "history.latest": "latest",
  "history.empty": "No versions yet — saving the file creates the first one.",
};

const zhCN: Dict = {
  "settings.title": "设置",
  "settings.appearance": "外观",
  "settings.theme": "主题",
  "settings.theme.light": "浅色",
  "settings.theme.dark": "深色",
  "settings.theme.auto": "跟随系统",
  "settings.language": "语言",
  "settings.editor": "编辑",
  "settings.editor.vim": "Vim 模式",
  "settings.editor.vimHint": "Vim 模式固定源码视图 —— 块渲染与行级光标本质冲突。",
  "settings.history.title": "编辑历史",
  "settings.history.limit": "每文件保留版本数",
  "settings.history.autoSave": "自动保存版本",
  "settings.history.autoSaveInterval": "自动保存间隔（秒）",
  "settings.history.hint": "自动保存按间隔给当前内容记一个版本，内容没变不会重复记录。每个文件只保留最近的若干版本，更早的自动淘汰。",
  "settings.backup.title": "数据备份",
  "settings.backup.export": "导出数据",
  "settings.backup.import": "导入数据",
  "settings.backup.hint": "导出为单个 JSON 文件（含全部草稿与编辑历史），可用于换机器或重装系统。导入会覆盖现有数据，操作前请先导出一份。",
  "settings.config.title": "配置文件",
  "settings.config.open": "打开配置文件",
  "history.title": "编辑历史",
  "history.snapshot": "把当前内容存为版本",
  "history.snapshotPlaceholder": "版本备注（可选）",
  "history.snapshotButton": "保存版本",
  "history.restore": "恢复",
  "history.latest": "最新",
  "history.empty": "还没有历史版本 —— 保存一次文件就会产生第一个版本。",
};

/** 繁體：与简体同构，词汇差异替换。 */
const zhTW: Dict = { ...zhCN };
zhTW["settings.title"] = "設定";
zhTW["settings.appearance"] = "外觀";
zhTW["settings.theme"] = "主題";
zhTW["settings.theme.light"] = "淺色";
zhTW["settings.theme.dark"] = "深色";
zhTW["settings.theme.auto"] = "跟隨系統";
zhTW["settings.language"] = "語言";
zhTW["settings.editor"] = "編輯";
zhTW["settings.editor.vim"] = "Vim 模式";
zhTW["settings.editor.vimHint"] = "Vim 模式固定原始碼檢視 —— 區塊渲染與行級游標本質衝突。";
zhTW["settings.history.title"] = "編輯歷史";
zhTW["settings.history.limit"] = "每檔案保留版本數";
zhTW["settings.history.autoSave"] = "自動儲存版本";
zhTW["settings.history.autoSaveInterval"] = "自動儲存間隔（秒）";
zhTW["settings.history.hint"] = "自動儲存按間隔給目前內容記一個版本，內容沒變不會重複記錄。每個檔案只保留最近的若干版本，更早的自動淘汰。";
zhTW["settings.backup.title"] = "資料備份";
zhTW["settings.backup.export"] = "匯出資料";
zhTW["settings.backup.import"] = "匯入資料";
zhTW["settings.backup.hint"] = "匯出為單一 JSON 檔案（含全部草稿與編輯歷史），可用於換機器或重裝系統。匯入會覆蓋現有資料，操作前請先匯出一份。";
zhTW["settings.config.title"] = "設定檔";
zhTW["settings.config.open"] = "開啟設定檔";
zhTW["history.title"] = "編輯歷史";
zhTW["history.snapshot"] = "把目前內容存為版本";
zhTW["history.snapshotPlaceholder"] = "版本備註（可選）";
zhTW["history.snapshotButton"] = "儲存版本";
zhTW["history.restore"] = "還原";
zhTW["history.latest"] = "最新";
zhTW["history.empty"] = "還沒有歷史版本 —— 儲存一次檔案就會產生第一個版本。";

const DICTS: Partial<Record<Locale, Dict>> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  // ja / ko / de / fr / it / ru：下一版补全，当前回退到英文
};

let current: Locale = "en";

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  current = locale;
}

/**
 * 翻译。回退顺序：当前语言 → en → key。
 * 组件里直接 `t("settings.theme")`，语言切换后重渲染即生效。
 */
export function t(key: string): string {
  return DICTS[current]?.[key] ?? DICTS.en?.[key] ?? key;
}
