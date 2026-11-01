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
结构说明 —— 这一块不会出现在发布页上。

· 标题固定 `# Aropyt v<version> — <subtitle>`。副标题要能独立读懂，参考
  v0.1.7 的 "Edit Where You Read"：说的是"这一版改变了什么体验"，不是功能名。
· 标题后**一个空行**，接引导段（2–4 行英文），再一个空行进第一节。
· 章节用 `##` + **描述性标题**（"Backspace no longer deletes a block"）。
  不要用 Added / Fixed / Changed 当标题 —— 那是 CHANGELOG 的分组，
  读者在这儿要的是"我升级后会感觉到什么"。
· 章节数量按内容定；`## Upgrading` 永远是最后一节。
· 全文英文：这份文件会原样发布成 GitHub Release 正文。
· **不写「安装 / 已知限制 / 许可证」**：安装方式随平台变、限制随版本变、
  许可证在仓库根和每个发布包里都有 —— 写在这里只会逐版漂移。
· 不写「下一版计划」：那是 issue / milestone 的事，写进发布说明只会
  变成空头承诺（v0.1.8 曾有一节，已删）。
-->
