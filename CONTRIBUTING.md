# Contributing to Skill Atlas

Thanks for considering a contribution — patches, bug reports and new scanner detectors are
all welcome.

## Getting set up

```bash
git clone https://github.com/SamYuen101234/skill-atlas.git
cd skill-atlas
npm install
npm test           # node --test, ~0.2s — should pass before you touch anything
npm start           # browser mode on http://localhost:3210
npm run app         # or launch the Mac app from source
```

No build step is required to iterate: `server.js` and `scanner.js` run directly under
Node, and `public/` is served as-is.

## Before opening a PR

- Run `npm test` — it's fast, run it before every commit.
- Keep runtime dependencies as they are (express, d3, js-yaml) unless the change genuinely
  needs a new one; say why in the PR description if it does.
- Add fixtures under `test/helpers.js` (temp dirs built at test time), not as committed
  fixture trees in the repo.
- If you change a detection pattern in `scanner.js`, add a case to
  `test/scanner.test.js` first — that pattern decides what every user sees when they scan
  a folder, so it needs a test either way.
- If your change touches how skills/agents/plugins are authored or versioned, see the
  `authoring-skills` skill in `plugins/skill-atlas-conventions/` — it documents the
  `metadata`, `author` and versioning conventions the scanner expects.

## What's useful to work on

- **New detectors** — another AI-tooling convention the scanner should recognize (open an
  issue first if it's not obvious, so the pattern can be discussed).
- **Scanner accuracy** — false positives/negatives in what counts as a skill, agent, MCP
  server, tool, workflow or plugin.
- **Graph and UI polish** — the flow diagram and relationship graph in `public/`.
- **Docs** — the README's "What it finds" and "Making your own workflow discoverable"
  sections drift as detectors change; PRs that keep them in sync are welcome even without
  a code change attached.

## Reporting bugs / requesting features

Open an issue with what you scanned, what you expected Skill Atlas to find, and what it
found instead (or attach a screenshot for UI issues). See the issue templates for the
fields that are most useful to fill in.

## Code style

Match the surrounding file. There's no linter enforced yet — clarity and consistency with
existing code beats a particular style rule.
