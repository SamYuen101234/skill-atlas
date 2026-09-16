# Skill Atlas

[![Release](https://github.com/SamYuen101234/skill-atlas/actions/workflows/release.yml/badge.svg)](https://github.com/SamYuen101234/skill-atlas/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Mac app (also runnable in a browser): add project folders, scan them, and browse
everything AI‑agent related that they contain — skills, agents, MCP servers, tools,
workflows and plugins — as a list, a layered flow diagram or a relationship graph.
Everything runs locally; nothing is uploaded anywhere.

## Install

Download the `.dmg` for your Mac from the [latest release](https://github.com/SamYuen101234/skill-atlas/releases/latest)
— `arm64` for Apple Silicon, `x64` for Intel — open it and drag **Skill Atlas** to Applications.

The build is **not signed with an Apple Developer ID**, so Gatekeeper blocks the first
launch. To open it:

- **Right-click** (or Control-click) the app in Applications → **Open** → **Open** in the dialog. Once only.
- If macOS says the app is "damaged" (the quarantine flag on a downloaded unsigned app), clear it:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/Skill Atlas.app"
  ```

See [SIGNING.md](SIGNING.md) for how to produce a signed and notarized build that opens
with a normal double-click.

## What it finds

| Category  | Detected from |
|-----------|---------------|
| Skills    | `SKILL.md` files (Agent Skills spec), `.claude/commands/**/*.md` slash commands, `.cursor/rules/*.mdc` |
| Agents    | Markdown files in `.claude/agents/`, `agents/`, `.agents/`, `.github/agents/`, `.cursor/agents/` (frontmatter: name, description, model, tools) |
| MCP       | `.mcp.json`, `.claude/settings*.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`, `.claude-plugin/plugin.json`, `mcp.json`, `claude_desktop_config.json` |
| Tools     | Tool definitions in source: MCP TS SDK `server.tool(...)`, Python `@mcp.tool` / `@tool`, LangChain `Tool(name=...)`, Anthropic/OpenAI tool schemas, Vercel AI SDK `tool({...})`, Go `mcp.NewTool`, Rust `#[tool]`; plus Claude Code permission rules and hooks in `.claude/settings*.json` |
| Workflows | `WORKFLOW.md` or `workflow.yaml`/`workflow.json` manifests, script-workflow folders (see below), GitHub Actions, GitLab CI, `workflows/` folders (YAML, JSON, n8n exports), Prefect `@flow`, Airflow `@dag`, Temporal `@workflow.defn` |
| Plugins   | `.claude-plugin/plugin.json`; a `marketplace.json` listing that points at a plugin folder in the project is merged into that plugin (shown as `listedIn`), other listings appear on their own |

### Making your own workflow discoverable

Two ways, in order of preference:

1. **Add a `WORKFLOW.md` manifest** to the workflow folder. It mirrors `SKILL.md`: YAML frontmatter plus an optional markdown body.

   ```markdown
   ---
   name: prompt-tuning-loop
   description: Tune AutoQM prompts, rerun the batch eval, and build the comparison workbook.
   entrypoint: run_test_pipeline.sh
   steps:
     - ingest: merge per-tenant CSVs into staging Snowflake
     - batch: run transcripts through the AutoQM endpoint
     - eval: score results with the eval model
     - report: build the old-vs-new comparison workbook
   inputs: [company_info.json, config/autoqm_config.json]
   outputs: [test_runs/<run>/summary.json]
   skills: [multi-tenant-batch-eval, build-comparison-workbook]
   agents: [aq-eval-planner]
   ---
   # Prompt tuning loop
   Free-form notes go here.
   ```

   Only `name` and `description` matter for display; the rest is shown as metadata. A `workflow.yaml` / `workflow.json` with `name`, `description`, `entrypoint` and `steps` works the same way.

2. **Rely on the heuristic.** A folder is reported as a `script-workflow` when its name (or the runner's name) contains *workflow*, *pipeline* or *orchestrat*, and it contains a runner script: `run*.sh`, `run*.py`, `main.py`, `pipeline.py`, `workflow.py`, `Makefile`, `Justfile` or `Taskfile.yml`. The description comes from the runner's leading comment block or the folder's README; subfolders with code are listed as stages and `VAR="${VAR:-default}"` lines are listed as env vars.

Folders such as `node_modules`, `.git`, `dist`, `.venv` are skipped.

## Build from source

Requires Node 20+.

```bash
npm install
npm run app        # launch the Mac app from source
npm run pack       # unpacked .app in release/mac-arm64/ (fast, for testing)
npm run dist       # release/Skill Atlas-<version>-<arch>.dmg + .zip
```

The app runs the same local server on a random loopback port and shows the UI in a native window with a menu: **File → Add Project** (⌘O), **Rescan** (⌘R), **Release Plugin** (⇧⌘R), **View → List / Flow / Network** (⌘1 / ⌘2 / ⌘3), **Search** (⌘F). Folder picking and "Open" / "Finder" use native dialogs. Project data lives in `~/Library/Application Support/Skill Atlas/data/projects.json`; the first launch from a source checkout copies the browser-mode list from `./data/` if present.

The `.dmg` is unsigned unless you add Apple signing credentials to the build; see [SIGNING.md](SIGNING.md).
Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds both architectures and
attaches them to a GitHub Release (signed and notarized if the Apple secrets are configured).

## Run in a browser

```bash
npm start
```

Open <http://localhost:3210>. Set `PORT` to use a different port. The server binds to `127.0.0.1` only, because the API can read any file on disk and run git.

Click **+ Add project**, paste a path (`~` is expanded) or use **Browse…** to pick a folder with the native macOS dialog. The project is scanned immediately. Use **Rescan** after changing files. Click any card to see the file contents and its metadata; **Open** launches it in the default app.

Projects and their last scan are stored in `data/projects.json`.

## Relationship graph

Two graph views are available from the toggle at the top right of a project:

- **Flow** (recommended): a layered left-to-right diagram with one column per category, in the order plugins → workflows → agents → skills → MCP servers → tools → built-in tools. Edges flow between columns; same-column references arc on the right. Node order within a column is chosen to reduce crossings. Hover a node to trace its edges, click to pin the highlight and open the file, click the background to unpin.
- **Network**: a force-directed layout of the same data, useful for spotting clusters.

**Start and end points.** The flow view fills marked nodes solid with their category colour (a marked skill is solid blue, an agent solid purple, …); start points get a ▶ before the name and end points a ■ after it. The counters at the top left of the canvas highlight each group. Roles are marked explicitly: open a node and press **Start** or **End** in the detail panel (stored per project in `data/projects.json`), or declare `role: start` / `role: end` in a skill or agent's frontmatter. There is no automatic detection, because cross-references between skills and agents are often bidirectional and make in/out degree a poor signal.

**Author filter.** The toolbar has an author dropdown built from `metadata.author` / `author` in skill, agent and workflow frontmatter and from `author` in plugin manifests. MCP servers take the author from a `pyproject.toml` or `package.json` in their folder (resolved from the command in `.mcp.json`) and pass it on to the tools they provide; anything inside a plugin folder with no author of its own inherits the plugin's author. The detail panel shows where an inherited author came from. It filters the list, the kind chips and both graph views; "No author" shows items without one.

In both views: scroll to zoom, drag the background to pan, legend chips toggle categories and edge types, the category tiles focus the graph on one category plus its direct neighbours, and the search box highlights matching nodes.

Edges are derived during the scan:

| Edge | Meaning |
|------|---------|
| uses | Declared in frontmatter: agent `tools`, skill `allowed-tools`, workflow manifest `skills` / `agents` / `tools`. Built-in Claude Code tools (Read, Bash, …) appear as grey nodes. |
| provides | A tool is defined in the MCP server's source tree (resolved from the server's command/args, or a folder named after the server). |
| references | A skill, agent or workflow document mentions another item by name or folder. |
| contains | The item lives inside a plugin's folder. |
| mirror | Same name and category at two paths, e.g. a plugin copy. Hidden by default. |

Unconnected nodes (typically permission rules) are hidden by default; toggle **show unconnected** in the legend.

## Plugin versioning

Open a plugin card and press **Version** to cut a release. The dialog shows the current version (and whether the marketplace listing agrees), the last git tag for that plugin, and every file in the plugin folder changed since it. Pick patch / minor / major or type a version, write a changelog entry (pre-filled with the changed skills and agents), and choose what to update:

- `plugin.json` and the plugin's entry in `marketplace.json` (always)
- `metadata.version` in every SKILL.md and agent file that has a `metadata` block
- `pyproject.toml` / `package.json` inside the plugin
- `CHANGELOG.md` in the plugin folder (created if missing, new section prepended)
- optionally a git commit of exactly those files and an annotated tag `<plugin>-v<version>`

The app never pushes; the result shows the `git push` command to run.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/projects` | List projects with counts |
| POST   | `/api/projects` `{path, name?}` | Add (or rescan an existing) project |
| GET    | `/api/projects/:id` | Full scan result |
| POST   | `/api/projects/:id/scan` | Rescan |
| PATCH  | `/api/projects/:id` `{name}` | Rename |
| DELETE | `/api/projects/:id` | Remove from list |
| GET    | `/api/projects/:id/file?path=` | Read a file inside the project |
| POST   | `/api/pick-folder` | Native folder picker (macOS) |
