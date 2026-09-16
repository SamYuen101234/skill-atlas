---
paths:
  - "**/SKILL.md"
  - "**/agents/**/*.md"
  - "**/.claude-plugin/plugin.json"
  - "**/WORKFLOW.md"
---

# Conventions for skill, agent and plugin files

These files are indexed by convention. When creating or editing one:

- Set `name` and `description` explicitly. Do not rely on the fallbacks (folder name, first
  paragraph). A `description` should say *when* to use the thing, not only what it is.
- Keep a `metadata` block on every `SKILL.md` and agent. A release only stamps
  `metadata.version` into files that already have the block.
- Do not hand-edit a version number. It lives in `plugin.json`, the marketplace entry, each
  `metadata.version`, the package manifests and `CHANGELOG.md`; the app's **Version** action
  writes all of them together.
- Set `author` once on the plugin and let the contents inherit it. If a file needs its own,
  match the existing spelling exactly — the author filter groups on the literal string.
- Keep skills and agents inside the plugin folder. Outside it they inherit no author and no
  release will stamp them.

For the full shapes, see the `authoring-skills` skill.
