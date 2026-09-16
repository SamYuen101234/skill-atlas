// Scans a project directory for skills, agents, MCP servers, tools and workflows.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".turbo",
  ".venv", "venv", "env", "__pycache__", ".mypy_cache", ".pytest_cache",
  "target", "vendor", ".cache", ".idea", ".vscode-test", "coverage", ".tox",
  "Pods", "DerivedData", ".gradle", ".dart_tool", "site-packages",
]);
const MAX_DEPTH = 10;
const MAX_FILES = 40000;
const MAX_SOURCE_BYTES = 512 * 1024;
// Config JSON is read whole, and a long-lived ~/.claude.json outgrows the source limit.
const MAX_JSON_BYTES = 8 * 1024 * 1024;

// Claude Code's own runtime state inside ~/.claude. None of it is authored content and
// transcripts alone can run to tens of thousands of files, so the global scan skips it.
const GLOBAL_RUNTIME_DIRS = [
  "projects", "sessions", "session-env", "shell-snapshots", "statsig", "todos",
  "file-history", "backups", "logs", "downloads", "ide", "tool-results", "history",
];

const SOURCE_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".rb", ".java", ".kt", ".cs"]);
const WORKFLOW_EXT = new Set([".yml", ".yaml"]);

// ---------- helpers ----------

// include: paths relative to root to walk, instead of everything (missing ones are skipped).
// ignore: paths relative to root to skip, on top of the built-in directory-name list.
async function walk(root, { include, ignore } = {}) {
  const files = [];
  const skip = new Set(ignore || []);
  async function visit(dir, depth) {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || (skip.size && skip.has(rel(root, full)))) continue;
        await visit(full, depth + 1);
      } else if (e.isFile()) {
        files.push(full);
      }
    }
  }
  if (!include) {
    await visit(root, 0);
    return files;
  }
  for (const name of include) {
    const full = path.join(root, name);
    let st;
    try { st = await fs.stat(full); } catch { continue; }
    if (st.isDirectory()) await visit(full, name.split("/").length);
    else if (st.isFile()) files.push(full);
  }
  return files;
}

function rel(root, p) {
  return path.relative(root, p).split(path.sep).join("/");
}

async function readText(p, limit = MAX_SOURCE_BYTES) {
  try {
    const stat = await fs.stat(p);
    if (stat.size > limit) return null;
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text };
  let data = {};
  try {
    data = yaml.load(m[1]) || {};
    if (typeof data !== "object") data = {};
  } catch {
    // tolerate sloppy frontmatter: key: value lines only
    // Tolerant line parser: top-level "key: value" plus one level of indented nested maps.
    const scalar = (raw) => {
      const val = raw.trim();
      try { const parsed = yaml.load(val); if (parsed != null && typeof parsed !== "object" || Array.isArray(parsed)) return parsed; } catch { /* keep raw */ }
      return val;
    };
    let current = null;
    for (const line of m[1].split(/\r?\n/)) {
      const nested = line.match(/^\s+([\w-]+):\s*(.*)$/);
      if (nested && current) { data[current][nested[1]] = scalar(nested[2]); continue; }
      const kv = line.match(/^([\w-]+):\s*(.*)$/);
      if (!kv) continue;
      if (kv[2].trim() === "") { data[kv[1]] = {}; current = kv[1]; continue; }
      data[kv[1]] = scalar(kv[2]);
      current = null;
    }
  }
  return { data, body: text.slice(m[0].length) };
}

function stripJsonComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(stripJsonComments(text));
    } catch {
      return null;
    }
  }
}

function firstParagraph(body) {
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  const para = [];
  for (const l of lines) {
    if (!l) {
      if (para.length) break;
      continue;
    }
    if (l.startsWith("#") && !para.length) continue;
    if (/^[-*]\s*\[[^\]]*\]\(#/.test(l) && !para.length) continue; // skip table-of-contents links
    para.push(l);
  }
  return para.join(" ").slice(0, 300);
}

function authorOf(data) {
  const a = data.author ?? data.metadata?.author;
  if (!a) return undefined;
  if (typeof a === "object") return [a.name, a.email ? `<${a.email}>` : ""].filter(Boolean).join(" ");
  const email = data.metadata?.email;
  return email ? `${a} <${email}>` : String(a);
}

function toList(v) {
  if (v == null) return [];
  const one = (x) => {
    if (x && typeof x === "object") {
      if (x.name) return String(x.name) + (x.description ? `: ${x.description}` : "");
      return Object.entries(x).map(([k, val]) => `${k}: ${typeof val === "object" ? JSON.stringify(val) : val}`).join(", ");
    }
    return String(x);
  };
  if (Array.isArray(v)) return v.map(one);
  if (typeof v === "object") return Object.entries(v).map(([k, val]) => `${k}: ${val}`);
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

// ---------- category scanners ----------

async function scanSkills(root, files) {
  const items = [];
  for (const f of files) {
    const r = rel(root, f);
    const base = path.basename(f);
    const lower = r.toLowerCase();

    // Agent Skills spec: <dir>/SKILL.md
    if (base === "SKILL.md") {
      const text = await readText(f);
      if (text == null) continue;
      const { data, body } = parseFrontmatter(text);
      items.push({
        name: data.name || path.basename(path.dirname(f)),
        description: data.description || firstParagraph(body),
        kind: "skill",
        path: r,
        meta: {
          version: data.version,
          license: data.license,
          allowedTools: toList(data["allowed-tools"] || data.allowedTools),
          userInvocable: data["user-invocable"],
          role: data.role || (data.entry === true ? "start" : undefined),
          author: authorOf(data),
        },
      });
      items[items.length - 1].meta.version = data.version ?? data.metadata?.version;
      continue;
    }

    // Claude Code slash commands: .claude/commands/**/*.md
    if (base.endsWith(".md") && /(^|\/)\.claude\/commands\//.test(lower)) {
      const text = await readText(f);
      if (text == null) continue;
      const { data, body } = parseFrontmatter(text);
      const cmdName = r.replace(/^.*\.claude\/commands\//, "").replace(/\.md$/, "").replace(/\//g, ":");
      items.push({
        name: data.name || `/${cmdName}`,
        description: data.description || firstParagraph(body),
        kind: "command",
        path: r,
        meta: { allowedTools: toList(data["allowed-tools"]), argumentHint: data["argument-hint"] },
      });
      continue;
    }

    // Cursor rules and other prompt-style skills
    if (base.endsWith(".mdc") && /(^|\/)\.cursor\/rules\//.test(lower)) {
      const text = await readText(f);
      if (text == null) continue;
      const { data, body } = parseFrontmatter(text);
      items.push({
        name: base.replace(/\.mdc$/, ""),
        description: data.description || firstParagraph(body),
        kind: "cursor-rule",
        path: r,
        meta: { globs: toList(data.globs), alwaysApply: data.alwaysApply },
      });
    }
  }
  return items;
}

async function scanAgents(root, files) {
  const items = [];
  for (const f of files) {
    const r = rel(root, f);
    const lower = r.toLowerCase();
    if (!lower.endsWith(".md")) continue;
    const base = path.basename(f);
    const isAgentsMd = base.toUpperCase() === "AGENTS.MD";
    const inAgentsDir = /(^|\/)(\.claude\/agents|agents|\.agents|\.github\/agents|\.cursor\/agents)\//.test(lower);
    if (!inAgentsDir && !isAgentsMd) continue;
    if (!isAgentsMd && base.toUpperCase() === "README.MD") continue;
    const text = await readText(f);
    if (text == null) continue;
    const { data, body } = parseFrontmatter(text);
    items.push({
      name: data.name || (isAgentsMd ? r : path.basename(f, ".md")),
      description: data.description || firstParagraph(body) || (isAgentsMd ? "Project-wide instructions for AI coding agents." : undefined),
      kind: isAgentsMd ? "agents-md" : lower.includes(".claude/agents") ? "claude-agent" : "agent",
      path: r,
      meta: {
        model: data.model,
        tools: toList(data.tools),
        color: data.color,
        permissionMode: data.permissionMode,
        role: data.role || (data.entry === true ? "start" : undefined),
        author: authorOf(data),
        version: data.version ?? data.metadata?.version,
      },
    });
  }
  return items;
}

const MCP_FILE_PATTERNS = [
  { test: (r) => r === ".mcp.json" || r.endsWith("/.mcp.json"), key: "mcpServers", source: "claude-code" },
  { test: (r) => /(^|\/)\.claude\/settings(\.local)?\.json$/.test(r), key: "mcpServers", source: "claude-settings" },
  { test: (r) => /(^|\/)\.cursor\/mcp\.json$/.test(r), key: "mcpServers", source: "cursor" },
  { test: (r) => /(^|\/)\.vscode\/mcp\.json$/.test(r), key: "servers", source: "vscode" },
  { test: (r) => /(^|\/)\.gemini\/settings\.json$/.test(r), key: "mcpServers", source: "gemini" },
  { test: (r) => /(^|\/)\.claude-plugin\/plugin\.json$/.test(r), key: "mcpServers", source: "claude-plugin" },
  { test: (r) => /(^|\/)mcp\.json$/.test(r), key: "mcpServers", source: "generic" },
  { test: (r) => /(^|\/)claude_desktop_config\.json$/.test(r), key: "mcpServers", source: "claude-desktop" },
  // User-scope servers (`claude mcp add -s user`) land in ~/.claude.json, next to the config dir.
  { test: (r) => /(^|\/)\.claude\.json$/.test(r), key: "mcpServers", source: "claude-user" },
];

async function scanMcp(root, files) {
  const items = [];
  for (const f of files) {
    const r = rel(root, f);
    const pat = MCP_FILE_PATTERNS.find((p) => p.test(r));
    if (!pat) continue;
    const text = await readText(f, MAX_JSON_BYTES);
    if (text == null) continue;
    const json = parseJson(text);
    if (!json || typeof json !== "object") continue;
    const servers = json[pat.key] || json.mcpServers || json.servers;
    if (!servers || typeof servers !== "object") continue;
    for (const [name, cfg] of Object.entries(servers)) {
      if (!cfg || typeof cfg !== "object") continue;
      const transport = cfg.type || (cfg.url ? (cfg.url.includes("/sse") ? "sse" : "http") : "stdio");
      const command = cfg.command ? [cfg.command, ...(cfg.args || [])].join(" ") : cfg.url || "";
      items.push({
        name,
        description: command,
        kind: transport,
        path: r,
        meta: {
          source: pat.source,
          command: cfg.command,
          args: cfg.args || [],
          url: cfg.url,
          env: Object.keys(cfg.env || {}),
          disabled: cfg.disabled === true,
        },
      });
    }
  }
  return items;
}

// Tool definitions inside source code. Heuristic regexes per ecosystem.
const TOOL_PATTERNS = [
  // MCP TypeScript SDK: server.tool("name", ...) / server.registerTool("name", ...)
  { re: /\b(?:server|mcp|app)\.(?:tool|registerTool)\(\s*["'`]([\w.-]+)["'`]/g, kind: "mcp-tool" },
  // FastMCP / MCP Python: @mcp.tool() / @server.tool(name="x") / @tool
  { re: /@(?:\w+\.)?tool(?:\(\s*(?:(?:name\s*=\s*)?["']([\w.-]+)["'])?[^)]*\))?\s*\r?\n\s*(?:async\s+)?def\s+(\w+)/g, kind: "python-tool" },
  // LangChain / generic: Tool(name="x") or StructuredTool(name="x")
  { re: /\b(?:Structured)?Tool\(\s*name\s*=\s*["']([\w.-]+)["']/g, kind: "langchain-tool" },
  // Anthropic / OpenAI style tool schema objects: { name: "x", input_schema / parameters
  { re: /["']?name["']?\s*:\s*["']([\w.-]+)["']\s*,[\s\S]{0,400}?["']?(?:input_schema|inputSchema|parameters)["']?\s*:/g, kind: "tool-schema" },
  // Vercel AI SDK: tool({ description }) assigned to a key
  { re: /\b(\w+)\s*:\s*tool\(\s*\{/g, kind: "ai-sdk-tool" },
  // Go MCP SDK: mcp.NewTool("name"
  { re: /\bmcp\.NewTool\(\s*"([\w.-]+)"/g, kind: "go-mcp-tool" },
  // Rust rmcp: #[tool(name = "x")] or #[tool(description = ...)] fn name
  { re: /#\[tool(?:\([^)]*?name\s*=\s*"([\w.-]+)"[^)]*\))?[^\]]*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g, kind: "rust-tool" },
];

async function scanTools(root, files) {
  const items = [];
  const seen = new Set();
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!SOURCE_EXT.has(ext)) continue;
    const r = rel(root, f);
    if (/\.(test|spec)\.[jt]sx?$/.test(r) || /(^|\/)tests?\//.test(r)) continue;
    const text = await readText(f);
    if (text == null) continue;
    // Cheap prefilter before the regex battery. Substring, not \btool\b: that missed
    // Go's mcp.NewTool( and any file whose only marker is the plural "Tools".
    if (!/tool/i.test(text)) continue;
    for (const { re, kind } of TOOL_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const name = m[1] || m[2];
        if (!name || name.length < 2) continue;
        const lineStart = text.lastIndexOf("\n", m.index) + 1;
        if (/^\s*(\/\/|#|\*|\/\*)/.test(text.slice(lineStart, m.index + 1))) continue; // skip comments
        const line = text.slice(0, m.index).split("\n").length;
        const key = `${r}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ name, description: `${kind} defined at ${r}:${line}`, kind, path: r, meta: { line } });
      }
    }
  }

  // Tools referenced by Claude Code settings (permissions / hooks)
  for (const f of files) {
    const r = rel(root, f);
    if (!/(^|\/)\.claude\/settings(\.local)?\.json$/.test(r)) continue;
    const json = parseJson((await readText(f)) || "");
    if (!json) continue;
    const allow = json.permissions?.allow || [];
    for (const rule of allow) {
      const key = `${r}:perm:${rule}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ name: rule, description: "Allowed tool rule in Claude Code settings", kind: "permission", path: r, meta: {} });
    }
    const hooks = json.hooks || {};
    for (const [event, groups] of Object.entries(hooks)) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of g.hooks || []) {
          const label = `${event}${g.matcher ? ` [${g.matcher}]` : ""}`;
          items.push({ name: label, description: h.command || h.type || "", kind: "hook", path: r, meta: { matcher: g.matcher } });
        }
      }
    }
  }
  return items;
}

// Runner scripts that mark a folder as a script-based workflow.
const RUNNER_FILES = /^(run[\w.-]*\.(sh|py|ps1)|main\.py|pipeline\.py|workflow\.py|Makefile|Justfile|Taskfile\.ya?ml)$/i;
const WORKFLOW_DIR = /(workflow|pipeline|orchestrat)/i;
const TRIPLE = /^("""|''')/;

function firstCommentBlock(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith("#!") || /^(set |#\s*-\*-)/.test(t)) { if (out.length) break; continue; }
    if (t.startsWith("#") || t.startsWith("//")) { out.push(t.replace(/^(#|\/\/)\s?/, "")); continue; }
    if (TRIPLE.test(t)) { out.push(t.slice(3).replace(/("""|''')$/, "")); continue; }
    break;
  }
  return out.join(" ").trim().slice(0, 300);
}

async function scanWorkflowManifests(root, files, items, claimedDirs) {
  for (const f of files) {
    const r = rel(root, f);
    const base = path.basename(f);
    const dir = path.dirname(f);

    // Explicit manifest: <dir>/WORKFLOW.md (same idea as SKILL.md)
    if (base === "WORKFLOW.md") {
      const text = await readText(f);
      if (text == null) continue;
      const { data, body } = parseFrontmatter(text);
      claimedDirs.add(dir);
      items.push({
        name: data.name || path.basename(dir),
        description: data.description || firstParagraph(body),
        kind: "workflow-manifest",
        path: r,
        meta: {
          author: authorOf(data),
          entrypoint: data.entrypoint,
          steps: toList(data.steps),
          inputs: toList(data.inputs),
          outputs: toList(data.outputs),
          tools: toList(data.tools),
          skills: toList(data.skills),
          agents: toList(data.agents),
        },
      });
      continue;
    }

    // Explicit manifest: <dir>/workflow.(yml|yaml|json) with steps/stages
    if (/^workflow\.(ya?ml|json)$/i.test(base) && !/(^|\/)\.github\//.test(r)) {
      const text = await readText(f);
      if (text == null) continue;
      let doc = null;
      try { doc = base.endsWith(".json") ? parseJson(text) : yaml.load(text); } catch { /* ignore */ }
      if (!doc || typeof doc !== "object") continue;
      const steps = doc.steps || doc.stages || doc.jobs || [];
      claimedDirs.add(dir);
      items.push({
        name: doc.name || path.basename(dir),
        description: doc.description || "",
        kind: "workflow-manifest",
        path: r,
        meta: {
          entrypoint: doc.entrypoint,
          steps: Array.isArray(steps) ? steps.map((s) => (typeof s === "string" ? s : s.name || s.id || s.run || "")).filter(Boolean) : Object.keys(steps),
        },
      });
    }
  }
}

async function scanScriptWorkflows(root, files, items, claimedDirs) {
  // Group files by directory; a directory whose name looks like a workflow and
  // that contains a runner script is reported as a script-based workflow.
  const byDir = new Map();
  for (const f of files) {
    const dir = path.dirname(f);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(path.basename(f));
  }
  for (const [dir, names] of byDir) {
    if (dir === root || claimedDirs.has(dir)) continue;
    const dirName = path.basename(dir);
    const r = rel(root, dir);
    if (/(^|\/)\.(github|gitlab|claude|cursor)(\/|$)/.test(r)) continue;
    const runner = names.find((n) => RUNNER_FILES.test(n));
    if (!runner) continue;
    if (!WORKFLOW_DIR.test(dirName) && !WORKFLOW_DIR.test(runner)) continue;

    // Stages = subdirectories that contain code
    const prefix = dir + path.sep;
    const stages = new Set();
    let scriptCount = 0;
    for (const f of files) {
      if (!f.startsWith(prefix)) continue;
      const restParts = f.slice(prefix.length).split(path.sep);
      const ext = path.extname(f).toLowerCase();
      if (SOURCE_EXT.has(ext) || ext === ".sh") scriptCount++;
      if (restParts.length > 1 && (SOURCE_EXT.has(ext) || ext === ".sh")) stages.add(restParts[0]);
    }
    const runnerText = (await readText(path.join(dir, runner))) || "";
    const readme = names.find((n) => /^readme\.md$/i.test(n));
    let description = firstCommentBlock(runnerText);
    if (!description && readme) description = firstParagraph((await readText(path.join(dir, readme))) || "");
    items.push({
      name: dirName,
      description: description || `Script workflow with entrypoint ${runner}`,
      kind: "script-workflow",
      path: `${r}/${runner}`,
      meta: {
        entrypoint: `${r}/${runner}`,
        stages: [...stages].sort(),
        scripts: scriptCount,
        envVars: [...new Set([...runnerText.matchAll(/^([A-Z][A-Z0-9_]+)="?\$\{\1:-/gm)].map((m) => m[1]))].slice(0, 30),
      },
    });
  }
}

async function scanWorkflows(root, files) {
  const items = [];
  const claimedDirs = new Set();
  await scanWorkflowManifests(root, files, items, claimedDirs);
  await scanScriptWorkflows(root, files, items, claimedDirs);
  for (const f of files) {
    const r = rel(root, f);
    const ext = path.extname(f).toLowerCase();

    // GitHub Actions
    if (WORKFLOW_EXT.has(ext) && /(^|\/)\.github\/workflows\//.test(r)) {
      const text = await readText(f);
      if (text == null) continue;
      let doc = null;
      try { doc = yaml.load(text); } catch { /* ignore */ }
      const on = doc?.on ?? doc?.true; // yaml 1.1 parses bare `on` as true in some loaders
      const triggers = on == null ? [] : typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on);
      items.push({
        name: doc?.name || path.basename(f, ext),
        description: triggers.length ? `Triggers: ${triggers.join(", ")}` : "",
        kind: "github-actions",
        path: r,
        meta: { triggers, jobs: Object.keys(doc?.jobs || {}) },
      });
      continue;
    }

    // GitLab CI
    if (/(^|\/)\.gitlab-ci\.ya?ml$/.test(r)) {
      items.push({ name: ".gitlab-ci", description: "GitLab CI pipeline", kind: "gitlab-ci", path: r, meta: {} });
      continue;
    }

    // Generic workflows directory (n8n exports, custom yaml/json workflows)
    if (/(^|\/)workflows?\//.test(r) && (WORKFLOW_EXT.has(ext) || ext === ".json") && !/^workflow\.(ya?ml|json)$/i.test(path.basename(f))) {
      const text = await readText(f);
      if (text == null) continue;
      let name = path.basename(f, ext);
      let description = "";
      let kind = "workflow";
      if (ext === ".json") {
        const json = parseJson(text);
        if (json && Array.isArray(json.nodes) && json.connections) {
          kind = "n8n";
          name = json.name || name;
          description = `${json.nodes.length} nodes`;
        } else if (json?.name) {
          name = json.name;
          description = json.description || "";
        }
      } else {
        try {
          const doc = yaml.load(text);
          if (doc && typeof doc === "object") {
            name = doc.name || name;
            description = doc.description || "";
          }
        } catch { /* ignore */ }
      }
      items.push({ name, description, kind, path: r, meta: {} });
      continue;
    }

    // Prefect / Airflow / Temporal style workflow definitions in code
    if (ext === ".py") {
      const text = await readText(f);
      if (text == null) continue;
      const flowRe = /@(?:flow|dag|workflow\.defn|workflow)\b[^\n]*\n\s*(?:async\s+)?(?:def|class)\s+(\w+)/g;
      let m;
      while ((m = flowRe.exec(text))) {
        const line = text.slice(0, m.index).split("\n").length;
        items.push({ name: m[1], description: `Code-defined workflow at ${r}:${line}`, kind: "python-workflow", path: r, meta: { line } });
      }
    }
  }
  return items;
}

async function scanPlugins(root, files) {
  const plugins = [];
  const listings = [];
  for (const f of files) {
    const r = rel(root, f);
    if (!/(^|\/)\.claude-plugin\/(plugin|marketplace)\.json$/.test(r)) continue;
    const json = parseJson((await readText(f)) || "");
    if (!json) continue;
    if (r.endsWith("marketplace.json")) {
      const marketDir = path.dirname(path.dirname(r));
      for (const p of json.plugins || []) {
        const src = typeof p.source === "string" ? p.source : null;
        const localDir = src && /^\.{0,2}\//.test(src) ? path.posix.normalize(path.posix.join(marketDir || ".", src)) : null;
        listings.push({
          name: p.name, description: p.description || "", kind: "marketplace-plugin", path: r,
          meta: { marketplace: json.name, source: p.source, version: p.version, author: authorOf(p) || authorOf({ author: json.owner }) },
          localDir,
        });
      }
    } else {
      const dir = path.posix.dirname(path.posix.dirname(r));
      plugins.push({ name: json.name || path.basename(dir), description: json.description || "", kind: "plugin", path: r, meta: { version: json.version, author: authorOf(json) }, dir });
    }
  }
  // A marketplace listing whose source points at a plugin folder in this project describes the same
  // plugin as that folder's plugin.json: merge them into one item.
  const items = [];
  for (const pl of plugins) {
    const listing = listings.find((l) => l.localDir && (l.localDir === pl.dir || l.localDir === "./" + pl.dir));
    if (listing) {
      listing.merged = true;
      pl.meta.marketplace = listing.meta.marketplace;
      pl.meta.listedIn = listing.path;
      pl.meta.version = pl.meta.version || listing.meta.version;
      pl.meta.author = pl.meta.author || listing.meta.author;
      if (!pl.description) pl.description = listing.description;
    }
    delete pl.dir;
    items.push(pl);
  }
  for (const l of listings) {
    if (l.merged) continue;
    delete l.localDir;
    items.push(l);
  }
  return items;
}

// ---------- authors ----------

// Directories (relative to root) that an MCP server's command/args point into.
async function mcpServerDirs(root, m) {
  const dirs = new Set();
  for (const arg of [m.meta.command, ...(m.meta.args || [])]) {
    if (!arg || typeof arg !== "string") continue;
    const expanded = arg.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, path.dirname(path.resolve(root, m.path)));
    const abs = path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded);
    if (!abs.startsWith(root + path.sep)) continue;
    try { const st = await fs.stat(abs); dirs.add(rel(root, st.isDirectory() ? abs : path.dirname(abs))); } catch { /* not a path */ }
  }
  return [...dirs];
}

// Author from a package manifest (pyproject.toml, package.json) in dir or its parents, up to root.
async function manifestAuthor(root, dir) {
  let cur = dir;
  for (let i = 0; i < 6; i++) {
    const py = await readText(path.join(root, cur, "pyproject.toml"));
    if (py) {
      // PEP 621: authors = [{ name = "...", email = "..." }]   Poetry: authors = ["Name <email>"]
      const m = py.match(/^\s*authors\s*=\s*\[([\s\S]*?)\]/m);
      if (m) {
        const body = m[1];
        const name = body.match(/name\s*=\s*["']([^"']+)["']/)?.[1];
        const email = body.match(/email\s*=\s*["']([^"']+)["']/)?.[1];
        if (name) return email ? `${name} <${email}>` : name;
        const plain = body.match(/["']([^"']+)["']/)?.[1];
        if (plain) return plain;
      }
    }
    const pkg = parseJson((await readText(path.join(root, cur, "package.json"))) || "");
    if (pkg?.author) return authorOf({ author: pkg.author });
    if (cur === "." || cur === "") break;
    cur = path.posix.dirname(cur);
  }
  return undefined;
}

// Fill in authors that are implied rather than declared:
//  1. an MCP server takes the author of the package manifest in its folder, and its tools take the server's author
//  2. anything inside a plugin folder with no author of its own inherits the plugin's author
async function applyAuthorInheritance(root, categories) {
  for (const m of categories.mcp || []) {
    const dirs = await mcpServerDirs(root, m);
    if (!m.meta.author) {
      for (const d of dirs) {
        const a = await manifestAuthor(root, d);
        if (a) { m.meta.author = a; m.meta.authorSource = "package manifest"; break; }
      }
    }
    if (!m.meta.author) continue;
    for (const t of categories.tools || []) {
      if (t.kind === "permission" || t.kind === "hook" || t.meta.author) continue;
      if (dirs.some((d) => t.path.startsWith(d + "/")) || t.path.split("/").includes(m.name)) {
        t.meta.author = m.meta.author;
        t.meta.authorSource = `MCP server ${m.name}`;
      }
    }
  }
  for (const p of categories.plugins || []) {
    if (p.kind !== "plugin" || !p.meta.author) continue;
    const dir = p.path.replace(/\/\.claude-plugin\/plugin\.json$/, "");
    if (dir === p.path) continue;
    for (const items of Object.values(categories)) for (const it of items) {
      if (it === p || it.meta.author || it.kind === "permission" || it.kind === "hook") continue;
      if (it.path.startsWith(dir + "/")) { it.meta.author = p.meta.author; it.meta.authorSource = `plugin ${p.name}`; }
    }
  }
}

// ---------- relationship graph ----------

const BUILTIN_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "Bash", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite", "NotebookEdit", "Skill"]);

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\// ---------- entry ----------");
}

async function buildGraph(root, categories) {
  const nodes = [];
  const edges = [];
  const edgeKeys = new Set();
  const idOf = (cat, item) => `${cat}:${item.path}#${item.name}`;

  for (const [cat, items] of Object.entries(categories)) {
    for (const it of items) {
      it.id = idOf(cat, it);
      const entry = (cat === "skills" && (it.kind === "command" || it.meta.userInvocable === true))
        || (cat === "workflows" && ["script-workflow", "workflow-manifest", "github-actions"].includes(it.kind));
      nodes.push({ id: it.id, name: it.name, category: cat, kind: it.kind, path: it.path, entry, role: it.meta?.role, author: it.meta?.author || null });
    }
  }
  const builtinIds = new Map();
  function builtin(name) {
    if (!builtinIds.has(name)) {
      const id = `builtin:${name}`;
      builtinIds.set(name, id);
      nodes.push({ id, name, category: "builtin", kind: "builtin-tool", path: "" });
    }
    return builtinIds.get(name);
  }
  function addEdge(source, target, rel, via) {
    if (!source || !target || source === target) return;
    const key = `${source}|${target}|${rel}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ source, target, rel, via });
  }

  const all = Object.entries(categories).flatMap(([cat, items]) => items.map((it) => ({ cat, it })));
  const byName = new Map();
  for (const { cat, it } of all) {
    const k = it.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push({ cat, it });
  }
  const findByName = (name, cats) => (byName.get(String(name).toLowerCase()) || []).filter((x) => !cats || cats.includes(x.cat));

  // Resolve a tool reference string ("Read", "mcp__server__tool", "server:tool") to node ids.
  function resolveToolRef(ref) {
    const ids = [];
    const m = String(ref).match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/) || String(ref).match(/^([\w.-]+):([\w.-]+)$/);
    if (m) {
      for (const x of findByName(m[1], ["mcp"])) ids.push(x.it.id);
      for (const x of findByName(m[2], ["tools"])) ids.push(x.it.id);
      return ids;
    }
    const base = String(ref).replace(/\(.*\)$/, "");
    if (BUILTIN_TOOLS.has(base)) return [builtin(base)];
    for (const x of findByName(base, ["tools", "mcp", "skills"])) ids.push(x.it.id);
    return ids;
  }

  // 1. Plugins contain items under their folder
  for (const p of categories.plugins || []) {
    if (p.kind !== "plugin") continue;
    const dir = p.path.replace(/\/\.claude-plugin\/plugin\.json$/, "");
    if (dir === p.path) continue;
    for (const { it } of all) {
      if (it !== p && it.path.startsWith(dir + "/")) addEdge(p.id, it.id, "contains");
    }
  }

  // 2. Declared tool usage (agents, skills, workflow manifests)
  for (const a of categories.agents || []) for (const t of a.meta.tools || []) for (const id of resolveToolRef(t)) addEdge(a.id, id, "uses");
  for (const s of categories.skills || []) for (const t of s.meta.allowedTools || []) for (const id of resolveToolRef(t)) addEdge(s.id, id, "uses");
  for (const w of categories.workflows || []) {
    for (const t of w.meta.tools || []) for (const id of resolveToolRef(t)) addEdge(w.id, id, "uses");
    for (const n of w.meta.skills || []) for (const x of findByName(n, ["skills"])) addEdge(w.id, x.it.id, "uses");
    for (const n of w.meta.agents || []) for (const x of findByName(n, ["agents"])) addEdge(w.id, x.it.id, "uses");
  }

  // 3. MCP servers provide the tools defined in their source tree
  for (const m of categories.mcp || []) {
    const dirs = await mcpServerDirs(root, m);
    for (const t of categories.tools || []) {
      if (t.kind === "permission" || t.kind === "hook") continue;
      const inDir = dirs.some((d) => t.path.startsWith(d + "/"));
      const nameMatch = t.path.split("/").includes(m.name);
      if (inDir || nameMatch) addEdge(m.id, t.id, "provides");
    }
  }

  // 4. Mirrors: same name and category at different paths (e.g. plugin copy vs .claude copy)
  for (const group of byName.values()) {
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      if (group[i].cat === group[j].cat && group[i].cat !== "tools") addEdge(group[i].it.id, group[j].it.id, "mirror");
    }
  }

  // 5. Mentions: a document that names another item references it
  const docs = all.filter(({ cat, it }) => ["skills", "agents"].includes(cat) || (cat === "workflows" && ["workflow-manifest", "script-workflow"].includes(it.kind)));
  const targets = all.filter(({ it }) => !["permission", "hook"].includes(it.kind) && it.name.length >= 4);
  const targetRes = targets.map(({ it }) => {
    const alts = new Set([it.name]);
    const dir = path.dirname(it.path);
    if (dir && dir !== "." && !/^\.(claude|cursor)$/.test(dir)) alts.add(dir.split("/").pop());
    return { it, re: new RegExp(`(^|[^\\w-])(${[...alts].map(escapeRe).join("|")})(?=$|[^\\w-])`, "m") };
  });
  for (const { it: doc } of docs) {
    const text = await readText(path.join(root, doc.path));
    if (!text) continue;
    const body = text.replace(/^---[\s\S]*?\n---\n?/, "");
    for (const { it, re } of targetRes) {
      if (it === doc || it.name.toLowerCase() === doc.name.toLowerCase()) continue;
      if (re.test(body)) addEdge(doc.id, it.id, "references");
    }
  }

  return { nodes, edges };
}

// ---------- entry ----------

// opts is passed through to walk(): { include, ignore } narrows what is visited.
export async function scanProject(root, opts = {}) {
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error("Not a directory");
  const started = Date.now();
  const files = await walk(root, opts);
  const [skills, agents, mcp, tools, workflows, plugins] = await Promise.all([
    scanSkills(root, files),
    scanAgents(root, files),
    scanMcp(root, files),
    scanTools(root, files),
    scanWorkflows(root, files),
    scanPlugins(root, files),
  ]);
  const byName = (a, b) => a.name.localeCompare(b.name);
  const categories = {
    skills: skills.sort(byName),
    agents: agents.sort(byName),
    mcp: mcp.sort(byName),
    tools: tools.sort(byName),
    workflows: workflows.sort(byName),
    plugins: plugins.sort(byName),
  };
  await applyAuthorInheritance(root, categories);
  const graph = await buildGraph(root, categories);
  return {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    filesScanned: files.length,
    truncated: files.length >= MAX_FILES,
    categories,
    graph,
  };
}

// ---------- global (user-level) config ----------

// Where Claude Code keeps user-level config: ~/.claude, or $CLAUDE_CONFIG_DIR if set.
export function globalConfigDir() {
  const override = (process.env.CLAUDE_CONFIG_DIR || "").trim();
  return override ? path.resolve(expandHome(override)) : path.join(os.homedir(), ".claude");
}

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

// The skills, agents, commands, plugins and MCP servers installed for the user rather than
// for one project. Scanned from the config dir's parent (normally the home directory) so
// that every path is reported as ".claude/..." and the existing detection patterns — which
// all key off that prefix — apply unchanged. Only the config dir and its sibling
// .claude.json are walked; the rest of the home directory is never read.
export async function scanGlobal({ dir = globalConfigDir() } = {}) {
  const root = path.dirname(dir);
  const name = path.basename(dir);
  const scan = await scanProject(root, {
    include: [name, ".claude.json"],
    ignore: GLOBAL_RUNTIME_DIRS.map((d) => `${name}/${d}`),
  });
  return { ...scan, root, dir };
}

// Paths a global scan can produce, and the only ones the server will read back for it.
export function isGlobalPath(dir, relPath) {
  const prefix = path.basename(dir);
  return relPath === ".claude.json" || relPath === prefix || relPath.startsWith(prefix + "/");
}
