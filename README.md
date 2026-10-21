<div align="center">

# Aropyt

**A Typora-style Markdown editor where the editing area *is* the preview.**

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue?style=flat-square&logo=gnu&logoColor=white)](https://www.gnu.org/licenses/agpl-3.0)
[![Latest Release](https://img.shields.io/github/v/release/Geekstrange/Aropyt?label=release&style=flat-square&logo=github&logoColor=white)](https://github.com/Geekstrange/Aropyt/releases/latest)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-lightgrey?style=flat-square&logo=tauri&logoColor=white)](https://github.com/Geekstrange/Aropyt/releases/latest)
[![Website](https://img.shields.io/badge/website-aropyt.com-5bb44e?style=flat-square&logo=googlechrome&logoColor=white)](https://aropyt.com)

</div>

---

## Why Aropyt?

Most Markdown editors force a choice: either a split pane (source on the left, preview on the right) or a proprietary document format that locks your writing inside an app. Aropyt refuses both.

- **No split pane.** The editing area renders Markdown as you type — tables are real tables, headings are real headings. Move the cursor into a block and it becomes editable source; move away and it renders again.
- **No lock-in.** Your document is a plain `.md` file on disk. Always. Rendering only changes *how it is drawn*, never *what is stored*.
- **No subscription.** Free and open source, forever, under AGPL-3.0.

If you have used Typora, the editing model will feel immediately familiar. What Aropyt adds on top: **tabs**, **editing history with one-click restore**, **first-class Vim mode**, **a plugin system**, and **a fully open-source codebase**.

> **Status**: actively developed. Windows is the primary build target; macOS, Linux and Android share the same Tauri 2 shell and are built via CI. The browser build (`npm run dev`) exists for development only — every release is a native app.

---

## Quick start

```bash
# Clone and run the desktop app in development mode
git clone https://github.com/Geekstrange/Aropyt.git
cd Aropyt
npm install
npm run tauri dev

# Build a production release
npm run tauri build
```

Prebuilt binaries for all platforms are on the [Releases](https://github.com/Geekstrange/Aropyt/releases/latest) page.

---

## Features

### The editing model

**Block-level WYSIWYG.** The document is split into blocks. Every block except the one under the cursor is rendered as real HTML by markdown-it — actual `<table>` layout, actual heading typography. When the cursor enters a block it switches back to source for editing, and renders again on blur. The same interaction model as Typora.

Crucially, **the editor and the preview share a single rendering engine**. What-you-see-is-what-you-get is an architectural guarantee, not an approximation.

**Full Markdown, honestly rendered.**

| Feature | What you get |
| --- | --- |
| Code blocks | Syntax highlighting via highlight.js — common languages out of the box, theme-aware |
| Math | `$…$`, `$$…$$`, `\(…\)`, `\[…\]` — four delimiters, KaTeX typesetting (fractions, roots, matrices, `cases`/`aligned`, `\tag`, `\partial`, full grammar) |
| Diagrams | ` ```mermaid ` blocks render to SVG — flowcharts, sequence diagrams, class diagrams, mind maps. Engine loads on demand |
| Tables | Real `<table>` layout, weighted headers, row separators, alignment |
| Inline HTML | `<strong>`, `<svg>` and friends render as real elements |
| GFM | Links, escapes, task lists, blockquotes, images, bare-URL auto-linking |

Engine and fonts load on demand; `$` inside code blocks is never misparsed; Mermaid syntax errors surface the specific cause instead of failing silently.

### Tabs and editing history

**Tabs.** `Ctrl/Cmd + Tab` to switch, `Ctrl/Cmd + Shift + N` to open a new one, middle-click to close. The active tab is remembered across restarts.

**Editing history — every save is a version.**

- **Automatic**: recorded on every save; unchanged content is not recorded twice
- **Periodic snapshots**: capture the current state on a timer (default: 60 s), so a crash mid-writing cannot lose your work
- **Named milestones**: mark important checkpoints manually
- **One-click restore**: the current content is saved *before* restoring — no operation ever loses content
- **Bounded retention**: each file keeps its most recent N versions (configurable, default 50); older ones are pruned

Open the history panel from the clock icon in the toolbar.

### Vim mode

Toggle from the status bar; the indicator shows the current sub-mode (`NORMAL` / `INSERT` / `VISUAL`).

- **Normal mode never deletes text accidentally.** `Backspace` and `Delete` are handed to Vim; nothing is touched outside insert mode
- **Always in source view.** In rendered mode a whole block is a single DOM node, so there is no place for a line-level cursor to land (`j`/`k` would skip entire paragraphs). Vim mode therefore locks to source view — the source-mode button hides, `Ctrl+/` is ignored, and exiting Vim returns you to rendered view automatically
- **Host shortcuts are preserved.** `Ctrl+Shift+B`, `Ctrl+Shift+N`, `Ctrl+Tab`, `Ctrl+0` keep working under Vim; `Ctrl+B` (page down) and `Ctrl+N` (insert completion) are left to Vim
- **Mouse selection disabled.** Single-click to place the cursor still works; drag-select and Shift-extend are intercepted

### Plugins

VSCode-style declarative contributions with lazy activation. Outline, file tree and formatting ship as built-in plugins; the kernel is kept to the editor, the document model and the rendering pipeline.

- **Manageable.** The plugin icon in the toolbar lists imported plugins; each can be enabled/disabled (disabling takes effect immediately and is remembered)
- **Importable.** Select a `.js` plugin file exporting `manifest` + `activate` to extend commands, toolbar buttons, views and keybindings. See [`test/sample-plugin.js`](test/sample-plugin.js)
- **Trust model.** Plugins run inside the renderer process (same model as VS Code extensions) — only import plugins you trust

### Files, associations and portability

- **Files as the source of truth.** Documents are always plain Markdown on disk. Copy out is always source text. No lock-in, no proprietary format, fully version-controllable
- **File associations.** Installed builds register **Markdown** (`.md`/`.markdown`), **LaTeX** (`.tex`/`.latex`) and **Fountain screenplays** (`.fountain`). Double-click to open, edit and **save back in place** (atomic write, 8 MB limit). Each type has its own icon, written to the registry by the installer
- **CLI.** `Aropyt.exe note.md` works too
- **Portable builds.** Provided, but do **not** register associations
- **Known gap.** Double-clicking a file while Aropyt is already running does not yet focus the existing window — planned for the next release

### Configuration

The source of truth for user configuration is **`~/.aropyt/settings.jsonc`** — JSONC format, so comments are allowed:

```jsonc
{
  "theme": "auto",           // light | dark | auto
  "editor": { "fontSize": 15 },
  "vim": { "enabled": false },
  "sidebar": { "open": true },
  "plugins": { "disabled": [] },
  "history": { "limit": 50 } // editing history (reserved for v0.0.7)
}
```

- Changes made in the Settings panel (gear icon) are **written back immediately**
- Manual edits take effect on restart
- Invalid values surface an error instead of being silently ignored
- On first launch, settings are migrated once from legacy browser storage
- **Export / import**: all drafts and editing history pack into a single JSON file — switching machines or reinstalling the OS never loses content

### Under the hood

- **First paint ≤ 320 KB** (gzipped); markdown-it, highlight.js, Mermaid and KaTeX all load on demand
- **CodeMirror 6 viewport virtualization** keeps long-document scrolling essentially free
- **IME-safe rendering.** Decoration recomputation is frozen during IME composition — zero interference for CJK input
- **Frame-budget monitoring.** Main-thread stalls are observable and attributable
- **Untrusted input by default.** Document content is treated as untrusted; the rendering pipeline and code highlighting run in an isolated environment
- **Crash-safe.** Unsaved-change confirmation on tab/window close (Save / Don't Save / Cancel); drafts are continuously persisted to IndexedDB and recovered automatically after abnormal exits

---

## Keyboard shortcuts

**Navigation**

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + Shift + B` | Toggle sidebar (state is remembered) |
| `Ctrl/Cmd + 0` | Focus sidebar |
| `Ctrl/Cmd + Tab` | Switch tab (`+Shift` for reverse) |
| Middle-click on a tab | Close the tab |

**Editing**

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + S` | Save |
| `Ctrl/Cmd + F` | Find / replace |
| `Ctrl/Cmd + /` | Toggle source / rendered mode (ignored in Vim mode) |

**Tabs**

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + Shift + N` | New tab |
| `Ctrl/Cmd + Tab` | Next tab |

---

## Building from source

```bash
npm install
npm run dev              # browser development mode
npm run tauri dev        # desktop development mode
npm run tauri build      # production build (the only supported packaging path)
npm run verify           # full verification (compile + behavioral gates)
```

> ⚠️ **Always build with `npm run tauri build`.** `cargo build --release` only compiles the Rust side — embedding front-end assets is the Tauri CLI's job. Assembling the two by hand produces the illusion that "the source changed but the exe still behaves the old way".

### Platform notes

- **Windows** — the current build environment for this repository. Just run `npm run tauri build`
- **macOS / Linux / Android** — Tauri 2 provides a unified shell across platforms. Build on the target platform or in CI. Linux requires WebKitGTK (see the [Tauri documentation](https://v2.tauri.app/start/prerequisites/))

---

## Plugin development

A plugin is **a single `.js` file** (ES module) that exports a `manifest` and an `activate` function.

```js
export const manifest = {
  id: 'com.example.wordcount',
  name: 'Word count',
  version: '0.1.0',
  engines: { aropyt: '>=0.1.0' },
  contributes: { commands: [{ id: 'wordcount.run', title: 'Count words' }] },
};

export function activate(ctx) {
  ctx.commands.register('wordcount.run', () => {
    ctx.ui.showMessage(`Words: ${ctx.editor.getText().split(/\s+/).filter(Boolean).length}`);
  });
}
```

Import via **Settings → Plugins → Import plugin…**, then restart.

### Manifest

| Field | Required | Description |
|---|---|---|
| `id` | yes | Reverse-DNS identifier, unique across all plugins |
| `name` | yes | Display name in the plugin manager |
| `version` | no | Semver string |
| `engines.aropyt` | no | Minimum host version (semver range) |
| `contributes` | no | Declarative contributions (below) |

### Contribution points

| Point | Shape | Notes |
|---|---|---|
| `commands` | `{ id, title, icon?, category? }[]` | `title` shows in tooltips and hover hints |
| `keybindings` | `{ command, key, when? }[]` | CodeMirror key syntax, e.g. `Mod-Shift-k` |
| `views` | `{ id, title, location, order? }[]` | `location`: `sidebar` / `main` / `right` |
| `menus` | `{ [location]: { command, group?, order? }[] }` | Adds entries to existing menus |
| `configuration` | `{ [key]: { type, default, description } }` | Rendered in Settings |

### Lifecycle

1. **Declared** — only `manifest` is read; no plugin code runs.
2. **Activated** — `activate(ctx)` runs on demand (first command use or when its view opens).
3. **Deactivated** — `deactivate()` on shutdown or when disabled.

Contributions register **before** `activate`, so a plugin whose `activate` throws still shows its commands (disabled, with the error in the manager).

### Rules and limits

- **Same process as the app.** No sandbox — a plugin can touch the DOM. Treat third-party plugins like browser extensions.
- **No editor internals.** `ctx` is the only entry point; `EditorView` / `EditorState` are not exposed. The one exception: a native CodeMirror 6 extension via `ctx.editor.addExtension`.
- **Failure isolation.** Every plugin's contribution registration and `activate()` are wrapped in `try/catch`. A broken plugin is marked *failed* and **does not affect other plugins or the built-in UI**.
- **Import-time validation.** `contributes` is checked structurally before the file is stored; invalid shapes are rejected with a reason instead of crashing the next launch.
- **API version gate.** Plugins declaring an older `engines.aropyt` are disabled with an explicit reason.

### Debugging

Watch the console for `[plugin-host] <id>` prefixed errors. The plugin manager shows each plugin's state — *declared / active / disabled / failed* — with the failure reason.

## Contributing

Issues and pull requests are welcome. Before opening a PR:

1. Run `npm run verify` — it covers compilation and behavioral gates
2. Keep changes scoped and describe the *why* in the PR body
3. For feature work, open an issue first to align on direction

If Aropyt is useful to you, a ⭐ on GitHub helps others find it.

---

## License

[AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.en.html). Aropyt is free software; you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

---

<div align="center">
<sub>Built with <a href="https://tauri.app">Tauri 2</a>, <a href="https://codemirror.net">CodeMirror 6</a>, <a href="https://github.com/markdown-it/markdown-it">markdown-it</a>, <a href="https://katex.org">KaTeX</a> and <a href="https://mermaid.js.org">Mermaid</a>.</sub>
</div>