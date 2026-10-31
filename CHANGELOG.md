# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions follow
[Semantic Versioning](https://semver.org/).

Release notes for a single version (the GitHub Release body) live in
`docs/releases/<tag>.md`; this file keeps the cumulative view of every
release.

## [0.1.7] - 2026-10-31

> Release notes: `docs/releases/v0.1.8.md`.
> 
### Fixed

- **Backspace deleted an entire block**: a rendered block is one indivisible
  replacement range, so no cursor fits inside it. With the cursor hugging the
  boundary — especially the cell holding the block's trailing newline —
  `Backspace` / `Delete` treated the whole block as a single character. What
  users saw was "click once, press backspace, the block is gone"; task lists
  made it obvious, but paragraphs, headings and code blocks behaved the same.
  The test is now positional (`head ∈ [from-1, to+1]`) instead of "the
  cursor's line falls inside the block". The `to` side needs the extra
  position because a block node's `to` includes the trailing newline —
  pressing backspace at the start of the blank line after the block puts
  `head` exactly at `to`, yet what gets deleted is the block's own content
  (that single cell is what wiped the whole list in testing).
  Cost: when the cursor sits at the start of the blank line after a block,
  that block shows as source — which is precisely the position where
  backspace would hit it, so revealing it is necessary.

- **Ctrl+Z after switching documents restored the previous document**:
  `replaceDocument` replaced the whole text in one `dispatch`, and that step
  itself entered the undo history — pressing Ctrl+Z inside document B undid
  "swap A for B", so the content became **A** while the tab still said B, and
  further presses walked back through every document opened before. The
  replace now carries two annotations: `isolateHistory.of('before')` inserts
  a history boundary *before* the swap (the old document's edits can no
  longer map onto the new one), and `Transaction.addToHistory.of(false)` keeps
  the replace itself out of the stack. Undo *inside* a document is unaffected
  (verified: type, undo, undo again — it stops at the document's own text and
  never jumps to the previous file).

- **File-tree keyboard navigation was unreliable and left a highlight box**:
  three problems stacked up. 1) Navigation (`j`/`k`, ↑↓, Enter) only consulted
  `focusedRow`, which was assigned solely by mouse clicks and keyboard moves;
  focus entering the tree via Tab or programmatically left it `null`, so ↑↓
  restarted from row 0 and Enter landed on the same file — "opens one, can't
  open the second". 2) Opening a file calls `refresh()`, which rebuilds the
  whole tree; the old nodes are removed, focus falls back to `<body>`, and
  `keydown` can no longer reach `.explorer-tree`. 3) `--focused` drew an
  outline box that stayed behind after focus left the tree, so the list kept
  showing a box that looked like "this row is selected".
  Now: `focusin` covers every focus entry point (Tab / click / programmatic)
  and clicking a row selects it; the cursor is restored by `data-path` after a
  rebuild, and focus returns to the container only if it was inside the tree
  before the rebuild (opening a file must not steal focus from the editor);
  Enter falls back to the first row when nothing is focused; the indicator is
  a **2px inset bar plus a faint background**, scoped by `:focus-within` so it
  disappears once focus leaves the tree.
  The restore target also moved from "container" to "that specific row":
  container focus makes `Tab` restart at the first focusable child ("after
  opening a file, Tab always starts from the first item"), while landing back
  on the row continues from there.

### Removed

- **Every hand-drawn icon in `Icons.tsx` is gone**: the seven entries in
  `UI_ICONS` (`menu` / `close` / `eye` / `code` / `sun` / `moon` /
  `autoTheme`) had **zero references** — the buttons using them now show text,
  or moved to the generated `icon/*.svg` set. Icons now have a single source
  (`icon/` + `scripts/make-toolbar-icons.mjs`), so "two coordinate systems,
  one drawn by hand" cannot come back. Unknown names still render an **empty
  span of the same size** (button width and alignment depend on it); the
  fallback moved from the hand-drawn `code` to the generated `defaultPlugin`.
- `check:icons` follows: its two `UI_ICONS` assertions (parse the hand-drawn
  set, the fallback exists) are gone, and the "pasted but not wired" check
  gained an explicit `PENDING_ICONS` list — `export` and four file-type icons
  are not connected yet, recorded in one place instead of leaving the gate red
  and ignored.

### Fixed

- **Fountain title pages only accepted "key plus value on the same line"**:
  the spec allows the value on the following **indented** line (the usual way
  to write `Notes:`), but the test demanded a non-space character after the
  colon — so `Notes:` fell through as body text, and the all-caps draft notes
  beneath it could be mistaken for a character name, turning the rest of the
  script into dialogue. The styling was also just italic plus 70% opacity,
  with no centring, so it did not read as a cover.
  Now: only the eight keys in the spec are recognised (Title / Credit /
  Author / Source / Draft date / Contact / Notes / Copyright — no longer "any
  `Xxx:`", which also dimmed lines like `Name: Alice` written inside a
  scene); a key with no value absorbs the indented lines that follow;
  `Title:` is weighted separately (1.4em, bold, opaque) with space beneath it,
  and the remaining metadata lines are centred and dimmed.
  **The key names themselves are hidden** via an inline
  `Decoration.replace`: the page shows `Big Fish` / `written by` /
  `John August`. Keys visible read as a form; without them it reads as a
  cover. Three constraints: the replace only covers a prefix within one line
  (CM6 forbids ViewPlugin replacements spanning line breaks); a key whose
  value is empty is left alone (`Notes:` alone would become a blank,
  unclickable line); and the prefix reappears while the cursor is inside it or
  at the start of the value — otherwise Backspace there deletes the whole
  prefix as one character. A cursor at the very **start of the line** does not
  count as inside, or the first line would keep showing `Title:` every time a
  document opens with the selection at position 0.
- **`.tex` documents exported as a single line of file name**:
  `export_document` hard-coded the reader as `markdown`, so `\documentclass` /
  `\section` / `\begin{}` were swallowed as ordinary text — `test/basic-test.tex`
  (66 lines) exported as one line, `% basic-test.tex`. A `source` parameter now
  selects the reader (`markdown` / `latex`, whitelisted), and the front end
  picks it by extension: `.tex` / `.latex` / `.ltx` → `latex`, everything else
  → `markdown`.
  That exposed a second problem: LaTeX `\ref{}` becomes a typst `@sec:…`
  cross-reference, and typst refuses to reference a heading **without
  numbering** (`cannot reference heading without numbering`). Latex sources
  now pass `--number-sections` (LaTeX numbers sections by default anyway).
  Same file: markdown reader → 7 984 bytes (one line); latex reader with
  numbering → **56 788 bytes** (complete).
- **PDF export failed with `path contains invalid component "C:"`**:
  `--pdf-engine` was given an **absolute path** (the user had pointed it at
  `C:\Opt\typst.exe`, which is not on PATH). pandoc invokes the engine through
  a `\\?\` long-path prefix, so typst parsed the image it had **downloaded and
  cached** (`C:\…\Temp\media-…\<sha1>.png`) as a **relative** path and gave
  up. Verified on the same machine with the same typst 0.15.1:
  `--pdf-engine typst` (bare name) succeeds, `--pdf-engine=C:\Opt\typst.exe`
  fails with the same message every time. **Nothing to do with CJK**: a
  Chinese PDF produced 11 KB with an embedded CJK font and exit code 0, and
  docx / html / rtf were never affected — only PDF has an engine invocation.
  It also explains "English documents export fine": that document had no
  images, so typst never touched the cache path.
  The engine's directory is now **prepended to the child PATH** and only the
  bare name is passed (prepend, not append — the explicitly configured copy
  should win). A second layer: before PDF export, `](C:/…)` / `](D:\…)` are
  rewritten to `](file:///C:/…)` with backslashes normalised, covering
  documents that hard-code local absolute paths. PDF only — a `file:///` link
  inside a docx or html handed to someone else is worse than useless.
- **RTF exported as mojibake**: `export_document` never passed
  `--standalone`, so pandoc emitted a **fragment** rather than a document. The
  RTF began at `{\pard …}` with no `{\rtf1\ansi…}` header (416 bytes versus 862
  with `-s`), so every RTF reader opened it as plain text and the
  `\u20013 ?` Unicode escapes showed up verbatim — which reads as garbled
  Chinese. **The Chinese was never the problem**: `\uN?` is exactly how RTF
  represents non-ASCII. `--standalone` is now always passed; HTML benefits
  too (it previously lacked `<!DOCTYPE>` and `<meta charset>`), while docx and
  epub are container formats and unaffected.
- **The export icon was missing half of itself**: `icon/export.svg` contains
  one `<path>` plus one `<polygon>` (the arrow head is a polygon), and the
  icon generator only extracted `<path>` — so the generated icon kept the
  envelope outline and dropped the arrow. The generator now extracts
  `<polygon>` as well; `export` renders both shapes.

### Changed

- **The export button moved next to Save**: it used to be hard-coded on the
  right of the toolbar (after `toolbar-spacer`); it is now contributed by the
  `aropyt.file` plugin (`aropyt.file.export`, group `1`, order `4`), directly
  after Save. The implementation stays in the host (`aropyt.export.run`) —
  plugins have no native channel and cannot call pandoc. "Next to Save" is
  therefore decided by the menu's group/order, not by JSX placement.
- **Status-bar word counts go through `countStats`**: `App.tsx` ran its own
  regexes ("words" counted English only, "characters" counted CJK only),
  which disagreed with core — the same document produced two different numbers
  in two places. Both now follow core: words = Latin words + CJK characters,
  characters = non-whitespace characters (matching Typora). **Numbers will
  differ from earlier versions.**
- `countStats` moved from `markdown.ts` to a new `text-stats.ts` and is
  exported from the package root: `markdown.ts` deliberately stays out of the
  first-paint budget (it pulls in markdown-it and highlight.js), while the
  status bar recomputes counts on every render.
- `safeJsonParse` replaced two bare `JSON.parse` sites (collapsed view state,
  the legacy plugin-disable list). Both already meant "if it does not parse,
  treat it as absent" and leaned on an outer try; the function name now says
  so.

### Removed

- **15 legacy editing commands in `commands.ts`**: `toggleBold` /
  `toggleHeading` / `toggleItalic` / `toggleTaskList` / `insertLink` /
  `insertTable` / `indentSelection` … each dispatched its own transactions.
  Plugins had already moved to `EditorApi.wrapSelection` /
  `toggleLinePrefix` / `replaceSelection` (guarded, attributable to a plugin,
  same behaviour), leaving every one of these without a reference. Only
  `toggleLinePrefix` and `toggleWrap` remain — `EditorApi` is built on them.
  The file went from 216 to 116 lines.

### Added

- **Document export (docx / pdf / html / odt / epub / rtf)**: the toolbar's
  **Export…** button (right next to Save) asks for a format, asks for a
  location, and hands the conversion to **pandoc**. Content goes in over
  **stdin** (no temp file, so no path escaping to get wrong and nothing left
  behind on failure) and `--resource-path` points at the workspace root —
  without it `![](assets/a.png)` arrives in the docx as a broken image. A
  failed conversion reports pandoc's **stderr verbatim** (missing images and
  unclosed fenced divs are only explicable there) with a 120-second timeout as
  the backstop.
  **PDF runs typst** (`--pdf-engine=typst`): a single ~30 MB binary, two
  orders of magnitude lighter than TeX Live. **The engine is installed by the
  user and never bundled** (product decision); a missing typst disables PDF
  alone while every other format keeps working, and the check happens
  **before** the save dialog — a late failure would already have created a
  0-byte file. **No** MediaWiki / reST / OPML: they are interchange formats for
  specific downstream systems rather than documents people read (most wikis
  take markdown directly), yet each would take a slot in the menu.
- **pandoc and typst paths can be set by hand**: a new "Export tools" section
  in Settings, with a Browse button for each, the detected version shown live
  beside it, and an immediate re-probe. An empty path means "search PATH and
  the usual install locations" (Program Files, LocalAppData, cargo bin,
  homebrew, /usr/local/bin). Changing a path takes effect without a restart,
  and tool discovery is shared between pandoc and typst (`resolve_tool`).
- **Global failure guard wired into startup** (`installGlobalGuards`,
  `observeOnly`): records without intercepting — uncaught errors go into the
  failure count and leave an `uncaught` trace. It differs from
  `installDebugLog` by role: that one records what happened (detail into the
  panel), this one records that something we did not anticipate happened
  (count plus trace).
- **Idle preloading of katex and mermaid**: the first formula or diagram no
  longer waits for a dynamic import. `onIdle` rather than load-at-startup, so
  it does not compete with "open the first file" for bandwidth.
- The diagnostics report gained a **failed actions** section: failures used to
  be mixed into the 30-line timeline and had to be scanned line by line; they
  are pulled out so a maintainer sees which step broke first. The debug panel's
  Clear button now clears the timeline too (clearing only the log left the
  previous run's traces behind).

### Planned

- Version-to-version diff in edit history (v0.1.2 shipped single-version
  comparison; comparing two versions is still missing)
- Touch targets in the toolbar (about 26px today, below the 44px guideline)
- WebDAV sync: the user brings their own server; the client lands in `v0.1.9`

## [0.1.7] - 2026-10-30

> Release notes: `docs/releases/v0.1.7.md`.

### Added

- **`Ctrl/Cmd+Shift+O` opens a workspace**: runs the same command as the
  toolbar's "Open folder" (`aropyt.file.pickWorkspace`) through `runCommand`,
  so the layer that surfaces real error messages is reused — a failed pick
  tells you why instead of silently doing nothing.
- **The toolbar can be hidden entirely**: `Ctrl/Cmd+Shift+H`, or the "Show
  toolbar" switch in Settings. Hiding it also removes every button on it
  (open file, theme, source mode…); `.app-main` is a vertical flex container,
  so the editor moves up to the bottom edge of the tab bar (measured +35px,
  no gap). The state lives in `settings.toolbar.open` and survives a restart.
  There are **exactly two** ways back: this shortcut and the Settings switch —
  the toolbar's own buttons are gone by definition, so don't casually delete
  either one.
- **Click a fenced block to edit it in place (code and mermaid)**: in rendered
  mode, clicking a code block or diagram turns it into an editor (source
  pre-filled, all selected). **Blur commits**, `Esc` discards,
  `Ctrl/Cmd+Enter` also commits, and `Tab` inserts two spaces. No confirm or
  cancel row — clicking away is acceptance, so you don't have to scan past a
  row of buttons first, and unchanged content produces no empty undo step.
  The old interaction was "click once and the whole block turns back into
  source": to change one line you had to look at a screenful of backticks and
  the fence language tag. The caret lands at the **end of the text** instead
  of selecting everything — select-all means "click once, type one character,
  and the entire original content disappears".
- **mermaid editing comes with a live preview**: the editor is taller than
  the code-block one (nine rows and up) and full width, with a preview pane
  beneath it that updates as you type (260 ms debounce). Rendering is
  serialised and stale results are dropped by sequence number, so fast typing
  is never overwritten by an earlier render that returns late; syntax errors
  show mermaid's own message in the preview pane instead of leaving a blank
  box.
- **Hand-written HTML controls in documents got styles**: `<kbd>` is drawn as
  a keycap (monospace, outlined, thicker bottom edge, rounded), `<details>`
  summaries get a pointer cursor and hover feedback, and
  `<input type="checkbox">` uses the brand green via `accent-color`, matching
  the look of GFM task-list checkboxes.

### Fixed

- **Hand-written HTML controls ignored clicks in rendered mode**:
  `<input type="checkbox">` would not toggle and `<details>` would not open.
  CM6 calls `preventDefault` on mousedown over a widget (to place the caret at
  the edge of the replaced range), swallowing the browser's default
  behaviour — the previous round exempted only `.task-checkbox`, and the other
  controls in documents do not carry that class. Now `input` / `button` /
  `select` / `textarea` / `label` / `details` / `summary` all tell CM6 "this
  event is mine". `<a>` is deliberately not in the list: in the desktop shell
  clicking a link navigates the WebView, which needs its own policy.
- **The Microsoft Store badge only rendered English / Simplified / Traditional
  Chinese**: the static image at
  `get.microsoft.com/images/<locale>%20<variant>.svg` ships only a few
  locales, everything else 404s and the slot goes blank. It now uses the
  official web component (`ms-store-badge`), which has artwork for all nine
  languages. Three details: `theme` explicitly follows the **site** theme
  (the component's `auto` reads the OS preference, so switching theme inside
  the site would not apply); the element is rebuilt on language and theme
  changes (custom elements do not guarantee reacting to attribute changes);
  and if the script has not registered within six seconds (offline or
  blocked), a plain-text fallback link appears.
- Badge sizing: the component's `size` accepts only `large` / `small` —
  there is no medium. `large` hard-codes `img { height: 104px }` in its internal
  styles (too big above the fold), and `small` ships no sizing rule while its
  artwork is smaller to begin with (reaching 48px would mean upscaling a
  bitmap, which blurs). So we **keep `size="large"`** (the largest artwork)
  and use `ms-store-badge::part(img) { height: 48px }` to bring the height
  down to what the old static image had — shrinking is always sharper than
  enlarging, and 48px is the readable size the store guidelines suggest.

- **Clicking a LaTeX block in rendered mode put the caret one line lower**:
  two causes stacked up. First, block widgets such as `.cm-tex-table` and
  `.cm-tex-pagebreak` expressed spacing with `margin`, while CM6 measures
  widget height with `offsetHeight` (which excludes margins) — the real
  layout was one line taller than the height map, so every later click landed
  one line low. Second, KaTeX rendered asynchronously and never told CM6 to
  re-measure: a formula block went from "one line of placeholder source" to
  multi-line typeset output, adding cumulative drift. Widget spacing is now
  expressed with padding, and KaTeX calls `view.requestMeasure()` once it has
  filled in.
- **A newline inside a paragraph did nothing**: markdown-it defaults to
  `breaks: false`, where only two trailing spaces or a backslash count as a
  hard break. In the sample document `test/basic.md`, the line that literally
  says "this line ends with two spaces and should render as a soft break" has
  no spaces on disk (the character codes confirm it ends with `。`): trailing
  whitespace is too easily trimmed by saving, `git commit` and copy-paste.
  Now `breaks: true`: a single newline inside a paragraph renders as `<br>`,
  matching GitHub issue bodies, and continuation lines inside list items work
  the same way.
- **GitHub alert blocks were only "GitHub-flavoured"**: the whole block had a
  tinted background, the border used the generic quote colour instead of the
  type colour, and the body text was dimmed by the quote rule. The cause:
  `.markdown-alert` declared its own `background`, while the compiled
  `.ͼ1 .cm-md-block blockquote` (0,2,1) from the CM6 base theme outranked
  `.cm-md-block .markdown-alert` (0,2,0), replacing the type colour with
  `--md-border-strong` and tinting the body with `--md-muted` — the same
  properties were written in two places, so which one won depended only on
  generation order. The base theme's blockquote declarations are gone (styles
  are defined in `styles.css` only), the alert background is removed, the
  border and title take the type colour, and body text stays at normal
  contrast.
- Quote and alert colours plus border widths became independent tokens,
  **shared by both themes**: `--quote-border` (quote border, neutral light
  grey `#dfe2e5`), `--alert-note` / `--alert-tip` / `--alert-important` /
  `--alert-warning` / `--alert-caution` (the actual GitHub light-theme
  values), with `--quote-width` / `--alert-width` for widths. They used to
  borrow `--md-h1` / `--md-link` / `--md-h3` / `--md-h5` / `--md-danger` /
  `--md-accent` — document-semantic colours used in 60+ places, where a
  single tweak also repainted headings, links and focus rings.
  ⚠️ In both theme blocks (`:root[data-theme='light']` and
  `[data-theme='dark']`) these must be **written once each with identical
  values**: declaring them only in the light block makes them vanish entirely
  under the dark theme, which kills the whole
  `border-left: var(--alert-width) solid …` declaration and the border
  disappears (measured: width becomes 0 in dark mode).
- **The alert border width could not be adjusted**: the rule used the literal
  `border-left: 3px solid var(--alert-color)`, and `--alert-width` was never
  referenced — changing it to 3.5px or 8px had no effect at all. It is now
  `var(--alert-width)`, symmetric with the quote's `var(--quote-width)`.
  Note: the UA rounds `border-width` to whole device pixels, so `3.5px` at 1x
  renders as `3px`; use integers when tuning thickness.
- **A separately opened file could not be closed**: the `×` on its tab called
  `closeTab(path)` without `workspaceId`, and `closeTab` falls back to "the
  currently active workspace" when it cannot find a match — an external
  file's `workspaceId` is `null`, so it never matched, and only middle-click
  worked (that call passes `workspaceId`, which is why it did). The `×` now
  passes the tab's own `workspaceId`; `activateTab` / `closeTab` / `findTab`
  take `workspaceId` as **required** instead of optional (when optional,
  omitting it compiles fine and only shows up as "clicking does nothing"), so
  the compiler guarantees every call site passes it; `closeTab` also keeps a
  runtime fallback of "if the path is unique among tabs, just close it" and
  does not guess when the same file name is open in two projects.
  Also fixed: a separately opened file's **tab was not highlighted** (the
  render layer recomputed its own `path + workspaceId` check, diverging from
  runtime). The check now converges on `runtime.isTabActive()`; vim's `:q` /
  `:wq` also close by active tab.
- **Opening a single file no longer turns its folder into a workspace**:
  opening a file should mean "read this file". Registering the parent folder
  as a project as a side effect made the file tree suddenly fill up with
  sibling files the user never asked for, and that folder was written into
  `workspace.roots` and restored automatically on the next launch. Files now
  open as **external files** (`workspaceId: null`, no workspace colour bar on
  the tab) and save through `write_external_file` back to their original
  location; to make a folder a workspace, use "Open folder".
- Also fixed: with a workspace already open, tabs added by "Open file" **were
  not activated** (`activateTab` was missing an explicit `null` and searched
  the currently active workspace, which could never find this new tab that
  belongs to no project).
- External file saves previously gave **no success feedback at all**: that
  branch only handled failure messages, and since "open a single file" now
  always takes it, every `Ctrl+S` looked like "clicked and nothing happened".
  They now report "saved" the same way workspace files do.
- **Typing Chinese froze the entire editor**: the first error in the
  diagnostics report was the root cause —
  `RangeError: Decorations that replace line breaks may not be specified via
  plugins`. Upstream of it was a line in the ViewPlugin's `update`:
  `if (update.view.composing) return`. During IME composition the document
  changes while the decorations stay frozen in the old coordinate space; when
  CM6 sliced tiles with them, positions were out of range or spanned a line
  break — and once it threw, the tile index was corrupted, so every
  subsequent measure, click and scroll reported `TilePointer.advance` /
  `No tile at position <n>` and the editor stopped responding entirely (the
  remaining dozen entries in the report were all fallout). Now, as soon as
  the document changes, existing decorations are `map`ped to the new
  coordinates (position only, no DOM churn, so the candidate window is not
  interrupted); items still illegal after mapping (out of range, or a
  replace spanning lines) are dropped with a warning; a full rebuild happens
  as usual when composition ends. Decoration construction runs through the
  same legality check. Reproduced and regression-tested with CDP's
  `Input.imeSetComposition`: a two-line task list, typing the second
  composition character — it threw RangeError before the fix and produces
  zero errors after.
- **Task items could render as "☐ ] text"**: the checkbox replacement range
  was taken straight from the lezer `TaskMarker` node's `from`/`to`, and that
  boundary sometimes lands before the `]` — so `[ ` was replaced and the `]`
  was left stranded at the start of the line. Position is now derived from
  the line text: only a `[` within one cell of the node start, followed by
  exactly one character and then `]`, is accepted; when the shape does not
  match, the whole line stays as source rather than doing a half replacement
  (a misplaced bracket is harder to explain than no checkbox).

## [0.1.6] - 2026-10-29

> Release notes: `docs/releases/v0.1.6.md`.

### Added

- **Operation timeline in the DEBUG panel**: opening/closing files, creating tabs,
  save/cancel-save/save-failure, command execution and failure, focus-placement
  failure, and whether the last exit was normal each get an entry, capacity 200.
  The timeline is stored separately from the log buffer, so a plugin printing dozens
  of log lines cannot push out "what the user clicked".
- **Error summary in the diagnostics report**: deduplicated by text, with occurrence
  count, first/last time, and full stack, so maintainers no longer have to scan
  logs line by line.
- **Environment block in the diagnostics report**: OS, architecture, Tauri version,
  WebView engine, window size and scale, UI language, theme, safe mode — matching
  the required fields in the issue template.
- **Plugin status table in the diagnostics report**: including each plugin's status
  and failure reason.
- **Errors from the previous session**: errors are persisted to IndexedDB, so after
  a process kill or white screen and restart, the previous session's errors are
  still visible in logs and reports.
- `console.debug` is now captured — debug information plugins emitted via
  `logger.debug()` was previously completely invisible.
- Uncaught exceptions retain `event.error.stack` and column number; resource load
  failures (images/scripts) are also recorded.
- **Language detection**: the built-in table covers formats that already have file
  associations (Markdown / LaTeX / Fountain / plain text), and plugins can take over
  an extension via `contributes.languages` (plugin contributions take precedence
  over the built-in table).
- **Status bar and tabs show file type**: the status bar shows the current language;
  non-Markdown tabs carry a type badge, so `.fountain` / `.tex` no longer "look
  unsupported" after opening.
- **Editor switches parser by language** (Compartment): `.tex` / `.latex` now have
  syntax highlighting; `.fountain` uses a plain-text view (the official CodeMirror
  language pack does not include Fountain; rendering is provided by a later plugin).
- **Built-in Fountain screenplay plugin**: after opening a `.fountain` file, a
  "Scenes" list appears in the sidebar (scene headings and sections, with line
  numbers, click to jump); the editor distinguishes elements by line — scene
  headings bold, character names centred, dialogue indented, parentheticals and
  transitions right-aligned.
  The implementation only attaches classes to lines and does not change any
  characters; editing/undo/save all go through native paths.
- **`onLanguage:` activation event wired up**: this activation event had been declared
  in the plugin API for a long time, but nothing ever dispatched it — plugins were
  not activated when opening a document in a given language, and language-mounted
  rendering extensions could never attach. It is now dispatched uniformly by the
  activeFile event, covering tab switches, Save As, and crash recovery.
- **File tree lists all editable text**: the criterion changed to the core language
  table (`detectLanguage`) instead of hard-coded `.md/.markdown/.txt`. `.tex` /
  `.fountain` now appear in the tree and can be clicked open; images and binaries
  are still not listed. The empty-state text changed to "No editable files yet".
- **"Open file…" and "Save as…" support LaTeX / Fountain / plain text**: the dialog
  filters and file associations share the same extension list (`EDITABLE_EXTS`),
  no longer only `.md/.txt`.
- **Fountain element completion**: title page (`Key: Value`), notes `[[ … ]]`,
  comment blocks (boneyard), lyrics `~`, and page breaks `====` all have
  corresponding styles; `INT. …` inside comment blocks is no longer mistaken for a
  scene (comment blocks are checked before scenes).
- **Sidebar views shown by language**: view contributions gained a `languages`
  declaration (default: unrestricted); "Outline" only appears under Markdown,
  "Scenes" only under Fountain, and "Files" is unrestricted. The decision comes
  entirely from plugin declarations; the host does not know specific view ids —
  external plugins can use the same mechanism. With no file open, Markdown is
  assumed (the product default).
- **Multiple workspaces coexist**: opening a new folder is **additive** rather than
  replacing; the old project's tabs stay in the tab bar; clicking a tab switches
  back to its workspace (file tree, save routing, and `context.workspace` seen by
  plugins follow together).
- Each tab is coloured by **its own workspace** at the top (same workspace, same
  colour; active tab more solid), so two projects both containing `notes.md` are
  distinguishable in one tab bar.
- The native side changed workspaces from a single root to a registry:
  `set_workspace` returns `{ id, name, root }`, and file read/write/list commands
  carry `rootId`. This way interleaved async calls cannot land on the wrong root.
- Drafts and edit history are isolated per workspace (composite key
  `workspace id + path`); drafts saved by older versions under bare paths are
  migrated on read, so crash recovery after upgrade does not fail.
- **Workspace bar at the top of the sidebar**: one open workspace per row (colour
  dot + name), click to switch — the file tree changes root, and the editor opens
  that project's most recently used tab (or clears if none). The colour dot and the
  tab top colour bar share the same source, so you can directly match "this tab"
  with "that project". The close button also moved here from inside the file tree,
  managed per workspace.
- The workspace list is persisted as `workspace.roots: string[]`, and
  `workspace.active` is recorded; on startup each is restored, and the active one
  returns to the last used (no longer falling back to the end of the list). Old
  configs with only `workspace.lastId` are automatically compatible.
- Startup trace gained a `plugins plugins=N views=N commands=N` line: the view slot
  count is first-hand evidence for "why is the sidebar empty" — `views=0` means
  contribution aggregation failed; `views>0` while a plugin stays declared means
  onView was not dispatched. The two failures look similar but have completely
  different root causes.
- **Built-in LaTeX plugin**: after opening a `.tex` file, there is a "Structure"
  view (`\part` / `\chapter` / `\section` / `\subsection`, etc., indented by level,
  click to jump), and formulas are **rendered in place** with KaTeX — inline
  `$…$` / `\(…\)`, block `\[…\]` / `$$…$$` / `equation` / `align` / `gather` /
  `multline` / `displaymath` / `eqnarray`. When the cursor enters a formula it
  reverts to source, and re-typesets after leaving.
- **LaTeX document typesetting** (parts other than formulas): section headings are
  sized by level and the command itself is hidden; `\textbf` / `\emph` / `\textit` /
  `\texttt` / `\underline` / `\textsf` / `\textrm` inline commands become styles;
  `itemize` / `enumerate` become `•` and numbering (environment lines hidden,
  `\item` replaced by a symbol). Inline commands and formulas inside list items also
  work.
- **LaTeX document structure rendering**: title page (`\title` / `\author` /
  `\date` + `\today`), abstract (`abstract`), quote blocks (`quote` / `quotation`),
  code blocks (`verbatim` / `lstlisting` / `minted`, no parsing inside), **tables**
  (`table` / `tabular`: `&` separates columns, `\\` separates rows, `\toprule` /
  `\midrule` / `\bottomrule` draw lines, `\caption` is the table caption, column
  format `l/c/r` determines alignment), `\newpage` draws a page-break line;
  commands with no visible output such as `\maketitle` / `\tableofcontents` /
  `\label` / `\begin{document}` are hidden directly.
- **Inline command completion**: `\LaTeX` / `\TeX` / `\XeTeX`, etc. become text;
  `\ref` / `\eqref` / `\cite` keep the key name and are dimmed; `~` becomes a
  non-breaking space; `\%` `\&` `\_` `\#` `\$` `\{` `\}` are restored to characters;
  `\includegraphics` displays as a path placeholder.
- `%` comments and `\begin{}` / preamble lines are dimmed.

### Changed

- The diagnostics report was reordered to "Environment → Error summary → Previous
  session → Operation timeline → Plugins → Document and configuration → Performance
  → Logs", and **no longer includes tab bodies**: the old "settings snapshot"
  serialised the entire runtime state (including the full text of all tabs), which
  made the report exceed the issue character limit and truncated the log section in
  the middle.
- The performance page distinguishes two kinds of input latency: in-panel EMA
  sampling (only after the panel opens) and a runtime **always-on** probe (including
  over-budget records before the panel opened), plus new over-budget details
  (source + actual/budget value).
- Document size in the panel now uses CodeMirror document metadata (O(1)) instead of
  calling `getText().split('\n')` on every render.
- The log list renders independently and merges high-frequency notifications: FPS
  refreshing every second no longer redraws 500 log lines.
- "Copy report" moved to the title bar and is available on all three pages; copy
  failure now shows a message instead of silently doing nothing.
- **Non-Markdown documents no longer use the Markdown parser and in-place
  rendering**: previously `.fountain`'s `#` action lines were rendered as headings.
  These formats now use the source view (line numbers + monospace), and the
  source/rendered toggle is hidden — they have no second form.
- Language detection no longer only recognises `.md` / `.txt`: unnamed documents and
  unrecognised extensions still fall back to Markdown (the product default), but
  known formats get their own language id.
- When a plugin-contributed language entry has no display name, fall back to the
  name of the same entry in the built-in table — previously once a plugin declared
  `{ id: 'fountain' }`, the status bar showed lowercase `fountain` while the tab
  badge showed `Fountain`: the same language had two names in two places.
- Sidebar view titles changed to **render-layer translation**: the manifest keeps
  the original Chinese text (`Scenes` / `Structure`), and `commandTitle()` replaces
  it according to the current language. Previously `t()` was called at the top level
  of the manifest, when the language had not yet been read from configuration — after
  switching the UI to English, the sidebar still showed `Expand "Scenes"`, and
  switching language did not update it.
- **Non-Markdown documents also support source/rendered toggle**:
  `isRenderableLanguage` excludes only **plain text**; `.tex` / `.fountain` have
  Ctrl+/ and the toolbar switch like markdown. Plugin decorations automatically step
  aside in source mode (`EditorApi.sourceMode`).
- Rendering layer mounted by language: only markdown uses the inline renderer; for
  other languages "rendering" is entirely provided by plugin decorations. Previously
  the rendering layer was language-agnostic, so opening `.tex` parsed the body as
  markdown and replaced entire paragraphs with `cm-md-block` widgets — plugin
  decorations acted on replaced text, and users saw a page of wrong typesetting
  (which was also the direct cause of "tex only rendered formulas").
- The status bar no longer shows the current file's language: the type badge on the
  tab already states the format; writing the same thing in two places is just noise.
- The header no longer shows the workspace name (and the dirty dot for unnamed
  documents — every document now has a tab, and the tab itself shows the dirty dot).
  Workspace identity is now carried by the **colour bar at the top of the tab**:
  colour is hashed from the workspace id, same workspace same colour, active tab
  more solid, files without a workspace are uncoloured.

### Removed

- Removed the `[kd]` key diagnostics log in the app shell (it wrote an entry on every
  keypress with a modifier or function key, polluting the log buffer and slowing the
  panel).

### Fixed

- Long-task time displayed as 1970 — `entry.startTime` is a high-precision timestamp
  relative to `timeOrigin`, but was used as epoch; it is now converted to `Date.now()`
  at collection time.
- The "30-second window" for main-thread blocking ratio had a fixed denominator and
  did not decay over time, so the number stayed frozen after idle; changed to a true
  60-second sliding window.
- Log auto-scroll pulled users who were scrolling up back to the bottom; it now only
  follows when already at the bottom.
- The same error looping filled the 500-entry buffer and pushed out pre-crash
  context; it now merges counts, and eviction prioritises keeping errors (300
  separate quota).
- Fountain decorations no longer re-classify the whole document on **scroll**
  (previously every viewport change ran the state machine from the start of the
  document, causing frame drops when scrolling long scripts); classification results
  are recomputed only when text changes.
- Switching workspaces showed **two sets of files with the same names** in the file
  tree: two refreshes ran concurrently, and the later one appended rows to an already
  cleared container. Now the whole tree is built in an offscreen node first, then
  stale results are discarded by sequence number.
- The file tree header shows the directory name instead of the root path (under
  multiple workspaces the path would be truncated to an ellipsis).
- **Could not switch back after opening a second workspace**: the previous version
  only implemented the data layer for "coexistence", with no switching entry; users
  could only find a tab belonging to the old project in the tab bar. The workspace
  bar at the top of the sidebar now provides this entry.
- A sidebar view could **stay at "Activating plugin…" forever**: `onView` dispatch
  used a `requestedRef` for deduplication, and refs persist across remounts (HMR,
  collapse/expand, hide/show by language) — as long as the first activation failed,
  it would never dispatch a second time. It now dispatches on every render
  (`activateFor` itself is idempotent for already-active plugins), and if no
  provider is obtained after 3 seconds it shows "Plugin not activated" + a retry
  button instead of waiting forever.
- The DEBUG log list's React key was built from "source + time + first 40 chars of
  text"; multiple logs in the same millisecond or warnings with the same prefix
  would **collide keys**, and the panel reported "Encountered two children with the
  same key" every frame, wiping the log buffer after 122 times. Each log now has a
  session-unique id.
- `%s` placeholders in the diagnostics report are no longer left as-is: console
  arguments are formatted according to `%s/%d/%o/%c`, so React warnings can show the
  specific key and component stack.
- The language icons SVG in Settings used `stroke-width` / `clip-path` (React
  requires camelCase), causing two warnings every time Settings opened; also fixed
  the UK flag's `clipPath` reference id (`#a` did not match the defined `f-en-a`, so
  clipping never worked).
- **Two activation events for the same plugin running concurrently executed
  `activate()` twice** (opening `.tex` made `onLanguage` and `onView` arrive almost
  simultaneously): views registered twice, editor extensions injected twice,
  manifesting as duplicated line-level decoration classes
  (`cm-tex-section cm-tex-section`), and leaving an unreclaimable subscription. It
  is now deduplicated per plugin concurrency, and the two calls share the same
  Promise.
- Math environments such as `align` / `gather` **did not render at all**: previously
  `\begin{align}` was stripped and only the middle lines were handed to KaTeX, but
  `&` is an environment-level alignment marker and KaTeX errored directly
  (`Unexpected alignment tab`), so the most visible formula degraded to source. Now
  the complete environment is handed to KaTeX, and numbering `(1) (2)` is rendered
  too.
- **Reference-style images and reference-style links did not render**
  (`![logo][img-ref]` / `[text][ref]`): block-level rendering in the editor calls
  markdown-it block by block, and `[img-ref]: https://…` usually occupies its own
  line (belonging to another block), so when rendering block by block
  `env.references` was empty and the whole image degraded to plain text. Now the
  full document's reference definitions are fed to the engine once, the same env is
  shared between blocks, and the render cache is invalidated when definitions
  change.
- **Block-level rendered content previously had no styles at all**: `ul` /
  `blockquote` / `pre` / `table` inside `.cm-md-block` were generated by markdown-it
  and browser defaults applied directly — list indent 40px, quote only `1em 40px`
  margin, code block without border or background. Now filled in and aligned with
  `website/demo.html` values: list bottom margin 12px, item spacing 5px, quote 3px
  accent left border + 14px padding + dimmed text, code block 1px border +
  background + padding + **6px radius**, inline code gets a light background and
  small radius separately; table borders and header background, separators, and
  image `max-width: 100%` are also filled in.
- **An extra blank line between list items, quote vertical line longer than body
  text**: `.cm-md-block` is attached inside `.cm-content`, and CodeMirror's content
  layer is `white-space: pre-wrap` (source must preserve newlines). This value was
  inherited by the HTML inside widgets, so newlines between elements in markdown-it
  output (`</li>\n<li>`, `</p>\n</blockquote>`) became real newlines — measured li
  height 18px but item spacing 41px, and a three-level nested quote's vertical line
  was 20px longer than the last line. Block-level content now explicitly sets
  `white-space: normal`, and only `pre` keeps `pre`.
- **Task list button did nothing when clicked**: the command had its own loop that
  skipped empty lines, skipped lines already task items, and returned after
  processing one line. Combined, the result was — clicking the button on an empty
  document did nothing, existing task items could not be unchecked, and a multi-line
  selection only changed the first line. It now directly reuses
  `toggleLinePrefix('- [ ] ')` (which already handles "strip old prefix, add new
  prefix").
- **Task checkboxes are directly clickable**: checkboxes in rendered mode were
  previously `<input disabled>`, visible but not clickable, and users had to move the
  cursor into the line and type `x` manually; unchecked ones also used the browser
  default grey (reading as disabled). Now `appearance: none` is self-drawn (brand
  green thin border + solid green when checked + white checkmark), and clicking
  rewrites the three characters in place according to the mapping "Nth checkbox in
  block ↔ Nth `[ ]` in source", without entering source mode.
- The light theme's dark green `#0d7259` was uniformly replaced with `#4aa63d`
  (`--md-link` / `--md-h2` / `--md-syntax-string`); the website `--green` and demo
  page were synchronised.
- `toggleLinePrefix` did not recognise checkboxes when stripping prefixes: converting
  `- [x] content` to a task list produced `- [ ] [x] content`. Now the list prefix
  is stripped together with `[ ]` / `[x]`.
- The regression script's `set_workspace` stub now returns a workspace descriptor;
  the crash recovery script's IndexedDB open no longer hard-codes a version number,
  and draft keys follow the workspace prefix — otherwise the whole
  `npm run verify` would go red because the stub did not match the new contract.
- Errors are no longer captured after closing the debug panel (the original comment
  promised "restore native console after closing", but the implementation installed
  at startup and never uninstalled, the opposite of the comment); interception is
  now always on, and only explicitly uninstalled in tests.

## [0.1.5] - 2026-10-28

> Consistent with `docs/releases/v0.1.5.md`.

The workspace finally has an exit, and folders you never open can be put away.

### Added

- **Remove a folder from the workspace** — directory rows in the file tree now
  carry a `×` that appears on hover (always visible on touch devices, where
  hover does not exist). Removing hides the folder **and its whole subtree**;
  nothing on disk is touched. The list is persisted per workspace name, and
  `Restore removed directories` in the command palette brings everything back —
  removing would otherwise be a one-way street.
- **Close workspace** — the tree gained a header showing the workspace name
  with a close button (the command palette has `Close workspace` too). Closing
  also clears `workspace.lastId`, so a deliberately closed workspace does not
  reopen on the next launch; tabs are closed along with it, and unsaved tabs
  prompt first.

### Changed

- **MSI is no longer built.** The Windows download has always been the NSIS
  `setup.exe`; the MSI only cost a WiX run per tag. Release assets for Windows
  are now `*_x64-setup.exe` and `*_arm64-setup.exe`.
- **Microsoft Store package added to releases** —
  `Aropyt_<version>_x64_arm64.msixupload`, built by `src-tauri/msix/pack.ps1`
  + `bundle.ps1` from the same bare executables. Tauri has no MSIX target, so
  the package is assembled with `makeappx`: manifest + tiles + exe, then a
  bundle of both architectures, then the upload container. Unsigned on
  purpose — the Store re-signs it, which is what removes the code-signing
  certificate from the release path entirely.

### Fixed

- **File-tree keyboard navigation leaked a listener per click** — the
  `keydown` handler (and `focusedRow`) had been pasted *inside* the directory
  row's click handler. Every click on a directory added another listener, so
  a single `j` could move several rows, and the cursor reset to the top each
  time. Moved back to the mount scope.
- **Collapsing any directory could empty the tree on next launch** —
  `explorer.collapsed` was persisted as `null` to mean "nothing collapsed",
  but `Memento.get` uses `has(key)`, so it returned `null` instead of the
  fallback and `new Set(null)` threw. Now the key is deleted (`undefined`)
  and the read is defensive.

## [0.1.4] - 2026-10-27

> Consistent with `docs/releases/v0.1.4.md`.

Small fixes only. No new features.

### Fixed

- **Desktop icons looked undersized** — `npx tauri icon` was run to repair
  the Android icon, but it also rewrites the desktop PNGs and pads them to
  the mobile safe-area ratio (artwork covered ~80% of the canvas). Desktop
  icons are rendered edge to edge again via `scripts/make-icons.mjs`;
  `tauri icon` runs first for the icns, then the PNGs are overwritten.
- **Language preference was written but never read** — `normalizeSettings`
  validated `settings.locale` (the default, always valid) and never assigned
  `obj.locale`, so `"locale": "de"` in settings.jsonc had no effect and every
  restart fell back to "follow system". The check had also drifted inside the
  `obj.theme` branch, so it did not run when the file omitted a theme. Both
  fixed; `LOCALES` is now the single source of allowed values.
- **Source-mode toggle was hard to read** — the pressed state used link blue,
  which reads as a hyperlink rather than an engaged switch, most visibly in
  light themes. Now uses the body colour with a brand-tinted background.
- **APK still showed the Tauri icon** — the bundled icons have been correct
  since v0.1.3. A build showing the default icon is reusing an existing
  `src-tauri/gen/android` directory, since Tauri copies `icons/android/mipmap-*`
  into it only on first generation. Run `npx tauri android clean` before
  rebuilding.

## [0.1.3] - 2026-10-26

> Consistent with `docs/releases/v0.1.3.md`.

Eight interface languages, and a layout that works on a phone.

### Added

- **Eight interface languages** — Simplified Chinese / English / German / French /
  Japanese / Korean / Italian / Russian, 223 keys each, selectable from
  Settings › Language as a flag row (plus a globe for "follow system")
  - `t()` is a plain function over module-level state, not a React hook —
    runtime messages and plugin code need text outside the component tree
  - `TextKey = keyof typeof zh`; every dictionary is `Record<TextKey, string>`,
    so a missing key fails the build instead of falling back at runtime
  - Initial locale resolves at module load rather than defaulting to Chinese;
    imperative views render once and would otherwise stay in the wrong language
  - Command titles and category prefixes translate at render time (plugins
    declare them in a module-level manifest, where `t()` would freeze the
    language active at import)
- **Portrait layout**
  - > 900px — sidebar occupies layout width, open/closed state persists
  - ≤ 900px — sidebar becomes an overlay, closed by default, no longer
    written to settings when toggled
  - ≤ 1200px — toolbar wraps to a second row (it previously scrolled with
    its scrollbar hidden, so the last ten buttons were invisible)
  - ≤ 640px — status bar keeps word count and drops secondary items;
    settings / history / command panels go full-screen

### Fixed

- **APK shipped the Tauri logo** — `scripts/make-icons.mjs` only writes
  desktop icons and never touched `src-tauri/icons/android/`, which still
  held the `tauri init` defaults. Mobile assets are now generated with
  `npx tauri icon logo.svg` (five densities plus `mipmap-anydpi-v26`
  adaptive-icon layers). Reinstall the APK to pick it up.
- Flag icons blank for German, Italian, Russian, Korean — each source SVG has
  its own coordinate space (`gb` `0 0 60 30`, `de` `0 0 5 3`,
  `kr` `-72 -48 144 96`); pinning all of them to `0 0 900 600` shrank the
  artwork into a corner. Each flag keeps its own `viewBox` now.
- Several flags share `id="a"`; inlined side by side they collided. Every SVG
  id carries a locale prefix.
- Selected language always reported as "system" — `RuntimeState.locale` read
  from `configuration` while `updateSettings()` writes `currentSettings`.
- Outline and file-tree empty states kept the previous language after a
  switch — imperatively rendered views are now rebuilt on locale change.
- Sidebar open/closed state never reacted to window resizing — `isWideScreen()`
  read the width once; now driven by a `matchMedia` subscription.
- Narrow-screen status bar lost its word count — the flex spacer pushed it out
  of the container and `overflow: hidden` clipped from the right.

### Known limitations

- Third-party plugins are not translated; only built-in command titles and
  categories are mapped.
- Internal log lines, manifest validation errors and the debug report template
  stay in Chinese (their audience is developers; the keywords are greppable).
- Toolbar buttons are ~26px even on touch screens, below the 44px target.

## [0.1.2] - 2026-10-24

> Consistent with `docs/releases/v0.1.2.md`.

Edit History Diff, plus a batch of fixes accumulated since v0.1.1.

### Added

- **Edit History Diff** (`Ctrl+Shift+G` → Compare)
  - **Unified** view: old line no. / new line no. / sign / content
  - **Split** view: two equal-width columns, fixed divider; long lines
    scroll horizontally within their own column instead of crossing the midline
  - Hatched fill for empty side rows in Split view
  - Header: file name, `+N / −N` stats, Unified / Split toggle
  - Line-level LCS engine (`apps/web/src/lib/diff.ts`)

### Fixed

- `Ctrl+F` did nothing: `search()` extension present, `Mod-f` binding missing
- WebView native find hijacked `Ctrl+F`; intercepted and forwarded as app event
  (CM6 keymap skips `defaultPrevented` events)
- vim `:wq`: command unregistered / `:wq` resolves as `write` + `q` / 
  save-then-close race (saving is async); `onSaveRequest` now returns a `Promise`
- File-tree focus never reached the tree (stopPropagation, missing `tabindex`,
  wrong query selector); `j/k/Enter` navigation works after focus
- Status bar: stats to the right, version moved to Settings › About
- Debug panel: log search, full error stacks, settings snapshot in report,
  `[timeline]` markers
- **macOS DMG reported as "damaged"** (#1): `Contents/_CodeSignature/CodeResources`
  was missing from the bundle, so Gatekeeper treated it as corruption instead of
  an unsigned app. Fixed by enabling ad-hoc signing (`bundle.macOS.signingIdentity
  = "-"`) so `tauri build` emits a complete signature, and by adding a CI gate that
  fails the build when `codesign --verify --deep --strict` rejects the bundle

### Known limitations

- Diff compares a history version against the current document only
  (two-history-version comparison not yet supported)
- `:q` closes the current tab, not the whole application
- Heap memory depends on `performance.memory`

## [0.1.1] - 2026-10-23

> Consistent with `docs/releases/v0.1.1.md`.

Panel shortcuts, full vim keyboard, word counts, and DEBUG mode. Rendering is
the same as v0.1.0; this release focuses on "operational efficiency" and
"observability".

### Added

- **Panel shortcuts** (all toggle; press again to close; detection uses
  `event.code`)
  - `Ctrl/Cmd+Shift+X` plugin panel
  - `Ctrl/Cmd+Shift+G` edit history
  - `Ctrl/Cmd+Shift+,` settings
  - `Ctrl/Cmd+Shift+M` vim mode
  - `Ctrl/Cmd+Shift+E` focus editor
  - `Ctrl/Cmd+Shift+P` command palette
- **Full vim-mode keyboard**
  - ex commands: `:w` save, `:q` close current tab (with confirmation when
    unsaved), `:wq`
  - `Ctrl+F` opens editor search (does not bind `Ctrl+G` / `Shift+Ctrl+G`)
  - `Ctrl+Shift+B` opens the sidebar and moves focus into the file tree;
    `j`/`k`/`Enter` navigate
  - Status bar `-- NORMAL --` / `-- INSERT --` submode indicator
- **Word, line, and character counts**: bottom-right of the status bar
  `lines · words · chars`; Chinese counted by CJK characters, English by
  consecutive letters/digits, monospace layout prevents jitter
- **DEBUG mode** (`F12`, docked at the bottom)
  - Metrics: FPS / input latency (EMA smoothed) / heap memory / main-thread
    blocking count / version
  - Input latency and main-thread blocking are **only shown in the debug
    panel**, not in the status bar
  - Logs: `console.*` + uncaught exceptions + Promise rejections, ring buffer
    of 500 entries, collected from app startup; supports search and level
    filtering
  - Copy diagnostics report: includes settings snapshot, document state,
    performance metrics, and the last 200 log entries

### Fixed

- `Ctrl+Shift+B` could only close, not open (handler read a stale value from
  the render-time closure)
- `Ctrl+Shift+,` did nothing (`Shift+,` has key `<`; switched to `event.code`)
- DEBUG panel logs were empty (interception was installed only when the panel
  opened)
- DEBUG panel showed only one edge (`.app` grid implicit row height 0)
- `Ctrl+F` search was missing (the `search()` extension was present, but the
  keymap lacked `Mod-f`)

### Known limitations

- vim's `:q` closes the current tab, not the whole application
- Heap memory depends on `performance.memory` (WebView2 may show —)

## [0.1.0] - 2026-10-22

> Consistent with `docs/releases/v0.1.0.md`.

The plugin system went from "can load" to "can write": all five contribution
points are wired up, the command palette completes the single main entry point
for the command layer, and the load chain has five layers of fault tolerance.

### Added

- **Plugin contribution points**: `commands` / `keybindings` / `menus` / `views` /
  `configuration` all usable
  - Commands have three entries: toolbar buttons, command palette, keybindings
  - Keybindings use VSCode syntax (`Mod-Shift-D`), translated by the host into
    editor syntax
  - Views register `render(container)` panels in the sidebar
  - Configuration items are automatically rendered in the Settings "Plugin
    configuration" section; plugins can read and write them
- **Command palette** (`Ctrl/Cmd+Shift+P`): search, arrow-key selection, Enter
  to execute, shortcuts shown on the right; filters out internal commands that
  do not need a user-visible title
- **Plugin management panel**: list view with icon, status badge (enabled /
  disabled / load failed / not activated), version and id, failure reason,
  enable/disable/delete, import entry
- **Plugin configuration UI**: `ConfigurationService.listSchemas()` + Settings
  "Plugin configuration" section (boolean segmented buttons, number/text input
  fields)
- **`defaultPlugin` icon**: unified default icon when a plugin has no icon

### Changed

- Plugin loading moved into the startup sequence (`configuration.load` → restore
  workspace → `loadSettings`/`applySettings` → plugin load/activate → cold-start
  file), so the disable list and plugin configuration have values before that
- Popup UIs uniformly reuse `.settings-*` structure and styles (plugin panel,
  command palette)
- Toolbar command fallback icon changed to `defaultPlugin` when no `icon` is set
  (previously `code`)
- The status bar counts only plugins that failed to load (`failed`); plugins
  deliberately disabled by the user are no longer counted

### Fixed

Six independent defects in the plugin load chain, any one of which would make a
plugin "look installed but actually unusable":

- **Contributions overwritten**: external plugins each called `host.load()`, and
  load rebuilt everything, so the last plugin's contributions wiped out the
  built-in plugins (file tree / outline / formatting / file operations) — the
  toolbar went empty and the sidebar would not open
- **Activation too strict**: clicking a command also required an explicit
  `onCommand:<id>` declaration — changed to "declaring a command implies
  activation" (aligned with VSCode)
- **Lifecycle misplacement**: plugin loading and activation were written inside
  `regrantWorkspace()`, while normal startup goes through automatic workspace
  restoration and never passes through that function
- **Closure TDZ**: startup tasks accessed `const`s later in the function body
  during the synchronous body of `createRuntime`; `showMessage` in the catch was
  also unavailable at that time — errors were doubly silent
- **Fake activation**: when there was no `activate` export, the plugin was still
  marked `active`, with not a single command registered
- **Field name mismatch**: external plugins passed `{ module: { activate } }`
  while the interface had flat fields, and it was hidden by `as never` — the
  real root cause of the plugin system failing

Other fixes:

- **Disable not persisted**: `plugins.disabled` was only written, never read;
  and plugin loading happened before `applySettings`, so it read the default
  empty list
- **Toolbar residue after disabling**: `disable()` only cleared the command
  table and did not rebuild the contribution set
- **Command palette listed internal commands**: internal commands requiring
  parameters such as `aropyt.explorer.open` appeared in the palette
- **Plugin keybindings did not trigger**: CM6 requires the last letter to be
  lowercase (`Mod-Shift-d`); plugins writing `Mod-Shift-D` in VSCode style never
  matched
- **`Ctrl+Shift+B` could only close, not open**: a handler registered only once
  read the old value from the closure at first render
- **history icon clipped**: `history.svg`'s viewBox was `0 0 200 200`, but the
  conversion hard-coded 1024
- **`deactivate()` was never called**: the documentation promised "called on
  exit or disable"

### Known limitations

- Plugins are single files and cannot use npm dependencies
- Plugins run in the same process as the app, with no sandbox
- No hot reload (after modification, re-import and restart)
- `views` currently validates `sidebar`; `main` / `right` are unverified
- Production builds have no developer tools; plugin error details are viewed
  through the reason field in the plugin panel

## [0.0.9] - 2026-10-20

> Consistent with `docs/releases/v0.0.9.md`.

### Added

- **GitHub-style alert blocks**: `[!NOTE]` / `[!TIP]` / `[!IMPORTANT]` /
  `[!WARNING]` / `[!CAUTION]`, five sets of official Octicon icons and type
  colours (CSS mask + data URI, colours from semantic tokens, adaptive to light
  and dark themes)

### Changed

- **Tighter typographic rhythm**: body line height 1.2; blank lines between
  paragraphs compressed to 0.1em; reset UA default margins on `blockquote` /
  `pre` (1em 40px / 1em); paragraphs inside quotes and list items do not get
  paragraph spacing; alert block padding/margin tightened

### Fixed

- **Sidebar open/closed state not persisted**: sidebarOpen changed to a
  RuntimeState projection subscription. The original implementation used
  component-local state + read configuration only once when runtime was created,
  while configuration loads asynchronously — at that moment it got the default
  value and never updated afterwards (manifesting as "close the sidebar, restart
  and it is expanded again")

## [0.0.8] - 2026-10-19

> Consistent with `docs/releases/v0.0.8.md`; this section only categorises
> technically.

### Added

- **Android signed release APK** (Android 10+ / arm64): CI fully automated build —
  Gradle init script injects signing, `tauri icon` generates Android mipmaps,
  `fitsSystemWindows` fixes status bar overflow
- **Non-printing characters in source mode** (`Ctrl+/`): spaces as light middle
  dots, tabs as right arrows, control characters as escape symbols
  (`highlightSpecialChars` + custom line decorations)
- Toolbar icon updates: settings, plugin management, source mode (setting /
  plugin / invisible)

### Changed

- Settings panel title bar fixed, content area scrolls independently
- Outdated description text in the configuration section corrected ("write-back
  to file will be connected in the next version" → "writes back immediately")
- Whitespace markers use a dedicated colour token `--md-ws-dot` (semi-transparent,
  light and dark sets)

### Fixed

- Release process tag misplacement: `tagName` changed to the real tag (rc and
  release versions no longer confused)
- Windows MSI encoding: fileAssociations type name changed to English +
  `wix.language=zh-CN`
- Android installer icon is no longer the Tauri default icon

### Removed

- In-app i18n (multiple rounds of script rewriting corrupted the dictionaries;
  the full implementation slipped and no specific version is promised anymore)

## [0.0.7] - 2026-10-19

### Added

- **Edit history**: save creates a version, content-hash deduplication, eviction
  per file, one-click restore (automatically snapshots current content before
  restoring), manually named versions
- **Automatic version saving**: configurable interval (default 60 seconds)
- **Data export / import**: drafts and edit history packed as a single JSON
- Settings panel "Data backup" and "Edit history" sections

### Fixed

- Export did nothing: ACL did not authorise `dialog:allow-save` /
  `dialog:allow-ask`
- Export failed silently: errors reading IndexedDB were not caught
- CI: removed platform-specific `bundle.targets`

## [0.0.6] - 2026-10-18

### Added

- File associations: `.md` / `.markdown`, `.tex` / `.latex`, `.fountain`
  (registered during NSIS installation, custom SVG icons)
- Single instance: double-clicking a file while already running forwards it to
  the existing window

### Fixed

- Main-thread budget warning false positive during startup (grace period)

## [0.0.5] - 2026-10-17

### Added

- Settings panel: three-state theme, Vim toggle, configuration file path and
  open entry
- Configuration source of truth migrated to `~/.aropyt/settings.jsonc` (atomic
  write + invalid-value prompt)

## [0.0.4] - 2026-10-16

### Added

- Vim mode polish: NORMAL / INSERT / VISUAL status indicator, cursor shape,
  fixed source view in vim mode

## [0.0.3] - 2026-10-15

### Added

- Sidebar: file tree and outline (collapse, active file expansion, cross-session
  collapse state)
- View system: two channels — core built-in views and plugin-contributed views

## [0.0.2] - 2026-10-14

### Added

- Typora-style in-place rendering: block-level WYSIWYG, cursor line shows source,
  non-cursor lines rendered
- Markdown rendering pipeline: GFM, math formulas, code highlighting, task lists

## [0.0.1] - 2026-10-13

### Added

- Project skeleton: Tauri 2 + CodeMirror 6 + React 18
- Editor core, command registry, keybinding parsing, theme system
- Light and dark palettes and first-paint bundle budget gate

[Unreleased]: https://github.com/Geekstrange/Aropyt/compare/v0.1.7...HEAD
[0.1.7]: https://github.com/Geekstrange/Aropyt/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Geekstrange/Aropyt/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Geekstrange/Aropyt/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Geekstrange/Aropyt/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Geekstrange/Aropyt/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Geekstrange/Aropyt/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Geekstrange/Aropyt/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Geekstrange/Aropyt/compare/v0.0.9...v0.1.0
[0.0.9]: https://github.com/Geekstrange/Aropyt/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/Geekstrange/Aropyt/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/Geekstrange/Aropyt/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/Geekstrange/Aropyt/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/Geekstrange/Aropyt/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/Geekstrange/Aropyt/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/Geekstrange/Aropyt/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/Geekstrange/Aropyt/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/Geekstrange/Aropyt/releases/tag/v0.0.1