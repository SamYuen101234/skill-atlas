---
name: authoring-skills
description: Write or restructure a skill, agent, workflow or plugin so Skill Atlas indexes it correctly. Use when creating a SKILL.md, adding an agent, packaging things as a Claude Code plugin, adding version or author metadata, or when asked why something is missing from the scan or shows "No author".
allowed-tools: [Read, Write, Edit, Grep, Glob]
metadata:
  version: 0.1.0
  author: Sam Yuen
---

# Authoring skills, agents and plugins

Skill Atlas finds things by convention. Anything that does not match the shapes below is
invisible to it, so write to these and the item shows up with its author and version
attached.

## Package it as a plugin

Versioning and author inheritance both hang off the plugin, so start there. The minimum:

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json        { "name": "my-plugin", "version": "0.1.0", "author": "Name" }
├── skills/
│   └── my-skill/
│       └── SKILL.md
└── agents/
    └── my-agent.md
```

Declare `author` once in `plugin.json`. Everything inside the folder inherits it, so
individual files only need an `author` when someone other than the plugin owner owns them.

## SKILL.md

```markdown
---
name: my-skill
description: What it does, and when to reach for it.
allowed-tools: [Read, Bash, mcp__github__create_pr]
metadata:
  version: 0.1.0
  author: Sam Yuen
---
# My skill
Body.
```

- `name` falls back to the folder name, `description` to the first paragraph — set both
  explicitly rather than relying on that.
- `description` is what makes the skill trigger. Write when to use it, not just what it is.
- `allowed-tools` is what draws the `uses` edges in the graph. Built-ins (`Read`, `Bash`, …)
  become grey nodes; `mcp__server__tool` resolves to both the server and the tool.
- Include a `metadata` block even if you leave the version out — a release only stamps files
  that already have one.

## Agents

A `.md` file under an `agents/` folder (or `.claude/agents/`, `.agents/`, `.github/agents/`).
`README.md` is skipped.

```markdown
---
name: reviewer
description: Reviews diffs before they go out.
model: opus
tools: [Read, Grep, my-skill]
metadata:
  version: 0.1.0
---
```

`tools` behaves like `allowed-tools`: naming another skill or agent links the two.

## Workflows

Add a `WORKFLOW.md` to the workflow folder — the heuristic that guesses from folder names is
a fallback, not the goal.

```markdown
---
name: nightly-eval
description: Rerun the eval suite overnight.
entrypoint: run.sh
skills: [my-skill]
agents: [reviewer]
---
```

`skills` and `agents` are resolved by name and become `uses` edges.

## MCP servers

Declared in `.mcp.json`. A server takes its author from a `pyproject.toml` or
`package.json` in the folder its command points at, and passes it to the tools defined
there — so give that folder an author rather than annotating each tool.

## Graph roles

Mark entry and exit points with `role: start` or `role: end` in frontmatter. Nothing is
inferred: cross-references are often bidirectional, so in/out degree is a poor signal.

## Two things that quietly go wrong

- **Author spelling.** The filter groups on the exact string, so `Sam Yuen` and
  `Sam Yuen <sam@example.com>` are two separate entries that look identical. Pick one form
  and set it on the plugin.
- **A skill outside the plugin folder.** It still gets indexed, but it inherits nothing and
  a release will not stamp it.

## Cutting a release

Do not hand-edit version numbers: a version lives in six places and they drift. Open the
plugin in Skill Atlas and press **Version** (⇧⌘R), which writes `plugin.json`, the
marketplace entry, every `metadata.version`, the package manifests and `CHANGELOG.md`
together, and can commit and tag. See `README.md` → Plugin versioning.
