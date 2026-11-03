# Aropyt v<version> — <subtitle>

<One paragraph, two to four lines: what this release is about. Write it in
English — this file is published verbatim as the GitHub Release body. Describe
what a user will notice, not which files changed.>

## <Section: one capability, one platform, or one group of fixes>

<Prose. CHANGELOG.md already lists every entry; this file explains the shape
of the release. Keep the "why" next to the "what" — "backspace deleted an
entire block" tells a reader more than "fixed block deletion".>

## <Another section>

- Bullet lists for parallel items.
- Tables for format or platform matrices.
- Keep the same order as CHANGELOG.md so the two files can be reconciled.

## Upgrading

<What a user must do. Write "Nothing to migrate." when nothing is needed.
Always cover: newly required external tools, new config keys, and behaviour
changes that could surprise someone mid-document.>

<!--
Structure notes — this block never reaches the published page.

· The heading is always `# Aropyt v<version> — <subtitle>`. The subtitle has
  to stand on its own; see v0.1.7's "Edit Where You Read": it describes what
  changed about the experience, not what the feature is called.
· After the heading, **one blank line**, then the intro paragraph (two to four
  lines), then another blank line before the first section.
· Sections use `##` plus a **descriptive title** ("Backspace no longer deletes
  a block"). Do not use Added / Fixed / Changed as headings — those are
  CHANGELOG's grouping, and what a reader wants here is "what will I notice
  after upgrading".
· The number of sections follows the content; `## Upgrading` is always last.
· Everything in English: this file is published verbatim as the GitHub Release
  body.
· **Do not write "Install / Known limitations / License"**: install steps
  differ per platform, limitations differ per version, and the license lives
  in the repository root and in every package — repeating them here only
  drifts from release to release.
· Do not write "What's next": that belongs in issues and milestones; in
  release notes it turns into an empty promise (v0.1.8 had such a section;
  it was removed).
-->

