# Skill Atlas

An Electron + Express app that scans project folders for skills, agents, MCP servers,
tools, workflows and plugins, and maps how they connect. The same Express app serves both
the browser mode and the packaged Mac app.

## Commands

```bash
npm test           # node --test, ~0.2s — run before every commit
npm run app        # launch the Mac app from source
npm start          # browser mode on http://localhost:3210
npm run dist       # build the .dmg for both architectures
```

## Conventions

- **No new runtime dependencies** without a reason. Tests use the built-in `node:test`
  runner; the app depends only on express, d3 and js-yaml.
- **Tests build fixtures in temp dirs** (`test/helpers.js`) rather than committing fixture
  trees. Add cases there, not as files in the repo.
- **The server binds to loopback only** — the API reads arbitrary files and runs git. Keep
  it that way, keep the Host-header allowlist (it blocks DNS rebinding from a web page), and
  keep the containment check on the file endpoint.
- **Scanner detection is by convention.** Changing a pattern in `scanner.js` changes what
  every user sees; cover it with a test in `test/scanner.test.js` first.

## Writing skills, agents or plugins

Use the `authoring-skills` skill in `plugins/skill-atlas-conventions/` (symlinked into
`.claude/skills/` so it loads while working here; published via the repo's marketplace). Short version: package them as a
plugin, set `name` and `description` explicitly, give every skill and agent a `metadata`
block, declare `author` once on the plugin, and never hand-edit a version number — the
app's **Version** action writes all six places at once.
