import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { scanProject } from "../scanner.js";
import { makeProject, removeProject, byName, hasEdge } from "./helpers.js";

// One fixture project exercising every detector, scanned once for the whole suite.
const FIXTURE = {
  // --- skills ---
  "skills/deploy/SKILL.md": `---
name: deploy-service
description: Ship a service to production.
allowed-tools: [Bash, Read, mcp__github__create_pr]
metadata:
  version: 1.4.0
  author: Ada
---
# Deploy
Body text.
`,
  "skills/bare/SKILL.md": `# Bare skill

The first paragraph becomes the description.

A second paragraph that should be ignored.
`,
  ".claude/commands/db/migrate.md": `---
description: Run pending migrations.
---
`,
  ".cursor/rules/style.mdc": `---
description: House style.
globs: ["**/*.ts"]
---
`,

  // --- agents ---
  ".claude/agents/reviewer.md": `---
name: reviewer
description: Reviews diffs.
model: opus
tools: [Read, Grep, deploy-service]
---
`,
  "agents/README.md": "Not an agent, should be skipped.\n",

  // --- mcp ---
  ".mcp.json": JSON.stringify({
    mcpServers: {
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      remote: { url: "https://example.com/mcp" },
      streamer: { url: "https://example.com/sse" },
      off: { command: "noop", disabled: true },
    },
  }),

  // --- tools ---
  "src/server.ts": `server.tool("create_pr", { description: "open a PR" });\n`,
  "src/tools.py": `@mcp.tool()\nasync def summarize(text: str):\n    return text\n`,
  "src/tools.go": `var t = mcp.NewTool("go_lookup")\n`,

  // --- workflows ---
  "flows/nightly/WORKFLOW.md": `---
name: nightly-eval
description: Rerun the eval suite overnight.
entrypoint: run.sh
skills: [deploy-service]
agents: [reviewer]
---
`,

  // --- plugin ---
  "pkg/.claude-plugin/plugin.json": JSON.stringify({ name: "my-plugin", version: "0.3.0", author: "Ada" }),
  "pkg/skills/inside/SKILL.md": `---
name: inside-plugin
description: Lives inside the plugin folder.
---
`,

  // --- must be ignored ---
  "node_modules/evil/SKILL.md": `---
name: should-not-appear
description: Inside node_modules.
---
`,
};

describe("scanProject", () => {
  let root;
  let scan;

  before(async () => {
    root = await makeProject(FIXTURE);
    scan = await scanProject(root);
  });
  after(() => removeProject(root));

  describe("skills", () => {
    test("reads name, description and allowed tools from frontmatter", () => {
      const s = byName(scan.categories.skills, "deploy-service");
      assert.ok(s, "deploy-service not found");
      assert.equal(s.kind, "skill");
      assert.equal(s.description, "Ship a service to production.");
      assert.equal(s.path, "skills/deploy/SKILL.md");
      assert.deepEqual(s.meta.allowedTools, ["Bash", "Read", "mcp__github__create_pr"]);
      assert.equal(s.meta.author, "Ada");
    });

    test("takes metadata.version when there is no top-level version", () => {
      assert.equal(byName(scan.categories.skills, "deploy-service").meta.version, "1.4.0");
    });

    test("falls back to the folder name and first paragraph", () => {
      const s = byName(scan.categories.skills, "bare");
      assert.ok(s, "bare skill not found");
      assert.equal(s.description, "The first paragraph becomes the description.");
    });

    test("names a slash command after its path under .claude/commands", () => {
      const c = byName(scan.categories.skills, "/db:migrate");
      assert.ok(c, "slash command not found");
      assert.equal(c.kind, "command");
      assert.equal(c.description, "Run pending migrations.");
    });

    test("picks up cursor rules", () => {
      const r = byName(scan.categories.skills, "style");
      assert.ok(r, "cursor rule not found");
      assert.equal(r.kind, "cursor-rule");
      assert.deepEqual(r.meta.globs, ["**/*.ts"]);
    });
  });

  describe("agents", () => {
    test("reads frontmatter and marks .claude/agents entries", () => {
      const a = byName(scan.categories.agents, "reviewer");
      assert.ok(a, "reviewer not found");
      assert.equal(a.kind, "claude-agent");
      assert.equal(a.meta.model, "opus");
      assert.deepEqual(a.meta.tools, ["Read", "Grep", "deploy-service"]);
    });

    test("skips README.md inside an agents folder", () => {
      assert.equal(scan.categories.agents.some((a) => /readme/i.test(a.name)), false);
    });
  });

  describe("mcp servers", () => {
    test("infers stdio, http and sse transports", () => {
      assert.equal(byName(scan.categories.mcp, "github").kind, "stdio");
      assert.equal(byName(scan.categories.mcp, "remote").kind, "http");
      assert.equal(byName(scan.categories.mcp, "streamer").kind, "sse");
    });

    test("records the command line and the source file", () => {
      const g = byName(scan.categories.mcp, "github");
      assert.equal(g.description, "npx -y @modelcontextprotocol/server-github");
      assert.equal(g.meta.source, "claude-code");
    });

    test("keeps disabled servers but flags them", () => {
      assert.equal(byName(scan.categories.mcp, "off").meta.disabled, true);
    });
  });

  describe("tools", () => {
    test("finds definitions across the TypeScript, Python and Go patterns", () => {
      const found = scan.categories.tools.map((t) => t.name);
      for (const name of ["create_pr", "summarize", "go_lookup"]) {
        assert.ok(found.includes(name), `${name} not detected (got ${found.join(", ")})`);
      }
    });
  });

  describe("workflows", () => {
    test("reads a WORKFLOW.md manifest", () => {
      const w = byName(scan.categories.workflows, "nightly-eval");
      assert.ok(w, "workflow not found");
      assert.equal(w.description, "Rerun the eval suite overnight.");
      assert.deepEqual(w.meta.skills, ["deploy-service"]);
    });
  });

  describe("plugins", () => {
    test("reads the plugin manifest", () => {
      const p = byName(scan.categories.plugins, "my-plugin");
      assert.ok(p, "plugin not found");
      assert.equal(p.path, "pkg/.claude-plugin/plugin.json");
    });
  });

  describe("graph", () => {
    test("links an agent to the built-in tools it declares", () => {
      assert.ok(hasEdge(scan.graph, "reviewer", "Read", "uses"));
      assert.ok(hasEdge(scan.graph, "reviewer", "Grep", "uses"));
    });

    test("links an agent to a skill it names in tools", () => {
      assert.ok(hasEdge(scan.graph, "reviewer", "deploy-service", "uses"));
    });

    test("resolves an mcp__server__tool reference to both server and tool", () => {
      assert.ok(hasEdge(scan.graph, "deploy-service", "github", "uses"));
      assert.ok(hasEdge(scan.graph, "deploy-service", "create_pr", "uses"));
    });

    test("links a workflow manifest to the skills and agents it lists", () => {
      assert.ok(hasEdge(scan.graph, "nightly-eval", "deploy-service", "uses"));
      assert.ok(hasEdge(scan.graph, "nightly-eval", "reviewer", "uses"));
    });

    test("links a plugin to the items inside its folder", () => {
      assert.ok(hasEdge(scan.graph, "my-plugin", "inside-plugin", "contains"));
    });

    test("does not link a plugin to items outside its folder", () => {
      assert.equal(hasEdge(scan.graph, "my-plugin", "deploy-service", "contains"), false);
    });

    test("every edge points at a node that exists", () => {
      const ids = new Set(scan.graph.nodes.map((n) => n.id));
      for (const e of scan.graph.edges) {
        assert.ok(ids.has(e.source), `dangling source ${e.source}`);
        assert.ok(ids.has(e.target), `dangling target ${e.target}`);
      }
    });
  });

  describe("traversal", () => {
    test("ignores node_modules", () => {
      assert.equal(byName(scan.categories.skills, "should-not-appear"), undefined);
    });

    test("reports scan metadata", () => {
      assert.ok(scan.filesScanned > 0);
      assert.equal(scan.truncated, false);
      assert.ok(!Number.isNaN(Date.parse(scan.scannedAt)));
    });
  });
});

test("scanProject rejects a path that is not a directory", async () => {
  const root = await makeProject({ "a.txt": "hi" });
  await assert.rejects(() => scanProject(`${root}/a.txt`), /Not a directory/);
  await removeProject(root);
});

// Authors are the one metadata dimension the UI filters on, and most of them are
// inherited rather than declared, so pin down both halves.
describe("author resolution", () => {
  let root;
  let scan;

  before(async () => {
    root = await makeProject({
      "skills/plain/SKILL.md": `---
name: plain-author
description: Top-level author as a bare string.
author: Ada Lovelace
---
`,
      "skills/meta/SKILL.md": `---
name: meta-author
description: Author and email under metadata.
metadata:
  author: Ada Lovelace
  email: ada@example.com
---
`,
      "skills/object/SKILL.md": `---
name: object-author
description: Author as an object.
author:
  name: Ada Lovelace
  email: ada@example.com
---
`,
      // Plugin with an author; the skills below it do and do not declare their own.
      "pkg/.claude-plugin/plugin.json": JSON.stringify({ name: "pkg-plugin", author: "Grace Hopper" }),
      "pkg/skills/inherits/SKILL.md": `---
name: inherits-author
description: No author of its own.
---
`,
      "pkg/skills/keeps/SKILL.md": `---
name: keeps-own-author
description: Declares its own author.
author: Katherine Johnson
---
`,
      // MCP server whose folder carries a package.json, plus a tool defined in it.
      ".mcp.json": JSON.stringify({
        mcpServers: { local: { command: "node", args: ["servers/local/index.js"] } },
      }),
      "servers/local/package.json": JSON.stringify({ name: "local", author: "Alan Turing" }),
      "servers/local/index.js": `server.tool("local_thing", {});\n`,
    });
    scan = await scanProject(root);
  });
  after(() => removeProject(root));

  test("reads a bare top-level author", () => {
    assert.equal(byName(scan.categories.skills, "plain-author").meta.author, "Ada Lovelace");
  });

  test("combines metadata.author with metadata.email", () => {
    assert.equal(byName(scan.categories.skills, "meta-author").meta.author, "Ada Lovelace <ada@example.com>");
  });

  test("accepts the object form and renders it the same way", () => {
    assert.equal(byName(scan.categories.skills, "object-author").meta.author, "Ada Lovelace <ada@example.com>");
  });

  test("an item inside a plugin folder inherits the plugin's author", () => {
    const s = byName(scan.categories.skills, "inherits-author");
    assert.equal(s.meta.author, "Grace Hopper");
    assert.equal(s.meta.authorSource, "plugin pkg-plugin");
  });

  test("inheritance never overwrites a declared author", () => {
    const s = byName(scan.categories.skills, "keeps-own-author");
    assert.equal(s.meta.author, "Katherine Johnson");
    assert.equal(s.meta.authorSource, undefined);
  });

  test("an MCP server takes the author from a package manifest in its folder", () => {
    const m = byName(scan.categories.mcp, "local");
    assert.equal(m.meta.author, "Alan Turing");
    assert.equal(m.meta.authorSource, "package manifest");
  });

  test("tools defined in the server's tree take the server's author", () => {
    const t = byName(scan.categories.tools, "local_thing");
    assert.ok(t, "local_thing not detected");
    assert.equal(t.meta.author, "Alan Turing");
    assert.equal(t.meta.authorSource, "MCP server local");
  });

  test("the graph carries the resolved author onto every node", () => {
    const node = scan.graph.nodes.find((n) => n.name === "inherits-author");
    assert.equal(node.author, "Grace Hopper");
  });

  test("two spellings of one person stay distinct, as the filter groups on the exact string", () => {
    const authors = new Set(scan.categories.skills.map((s) => s.meta.author).filter(Boolean));
    assert.ok(authors.has("Ada Lovelace"));
    assert.ok(authors.has("Ada Lovelace <ada@example.com>"));
  });
});
