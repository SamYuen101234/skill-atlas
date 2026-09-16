import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startServer } from "../server.js";
import { makeProject, removeProject } from "./helpers.js";

const FIXTURE = {
  "skills/demo/SKILL.md": `---
name: demo
description: A demo skill.
---
# Demo
`,
  ".mcp.json": JSON.stringify({ mcpServers: { github: { command: "npx", args: ["server-github"] } } }),
  "secret-ish.txt": "readable, inside the project\n",
};

describe("HTTP API", () => {
  let server, base, dataDir, projectRoot;

  const api = async (method, urlPath, body) => {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-atlas-data-"));
    projectRoot = await makeProject(FIXTURE);
    // Port 0: let the OS pick, exactly as the Electron shell does.
    const started = await startServer({ dataDir, port: 0, host: "127.0.0.1" });
    server = started.server;
    base = `http://${started.host}:${started.port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await removeProject(projectRoot);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  // Each test starts from an empty project list.
  beforeEach(async () => {
    const { body } = await api("GET", "/api/projects");
    for (const p of body) await api("DELETE", `/api/projects/${p.id}`);
  });

  const addFixture = async () => {
    const { status, body } = await api("POST", "/api/projects", { path: projectRoot });
    assert.equal(status, 201);
    return body;
  };

  test("binds to loopback only", () => {
    assert.equal(server.address().address, "127.0.0.1");
  });

  test("starts with no projects", async () => {
    const { status, body } = await api("GET", "/api/projects");
    assert.equal(status, 200);
    assert.deepEqual(body, []);
  });

  test("adds a project and scans it immediately", async () => {
    const p = await addFixture();
    assert.equal(p.path, projectRoot);
    assert.equal(p.name, path.basename(projectRoot));
    assert.ok(p.counts.skills >= 1, "expected the demo skill in the counts");
    assert.ok(p.counts.mcp >= 1, "expected the github server in the counts");
  });

  test("defaults the name to the folder name and honours an explicit one", async () => {
    const { body } = await api("POST", "/api/projects", { path: projectRoot, name: "Custom" });
    assert.equal(body.name, "Custom");
  });

  test("rescans an already-added path instead of duplicating it", async () => {
    await addFixture();
    const { status, body } = await api("POST", "/api/projects", { path: projectRoot });
    assert.equal(status, 200);
    assert.equal(body.existed, true);
    const list = await api("GET", "/api/projects");
    assert.equal(list.body.length, 1);
  });

  test("rejects a missing path", async () => {
    const { status, body } = await api("POST", "/api/projects", {});
    assert.equal(status, 400);
    assert.match(body.error, /path is required/);
  });

  test("rejects a directory that does not exist", async () => {
    const { status, body } = await api("POST", "/api/projects", { path: "/no/such/place-xyz" });
    assert.equal(status, 400);
    assert.match(body.error, /does not exist/);
  });

  test("rejects a path that is a file", async () => {
    const { status, body } = await api("POST", "/api/projects", { path: path.join(projectRoot, "secret-ish.txt") });
    assert.equal(status, 400);
    assert.match(body.error, /not a directory/i);
  });

  test("returns the full scan for one project", async () => {
    const p = await addFixture();
    const { status, body } = await api("GET", `/api/projects/${p.id}`);
    assert.equal(status, 200);
    assert.ok(body.scan.categories.skills.some((s) => s.name === "demo"));
    assert.ok(Array.isArray(body.scan.graph.nodes));
  });

  test("404s for an unknown project id", async () => {
    for (const url of ["/api/projects/nope", "/api/projects/nope/file?path=a.txt"]) {
      assert.equal((await api("GET", url)).status, 404);
    }
  });

  test("renames a project", async () => {
    const p = await addFixture();
    const { body } = await api("PATCH", `/api/projects/${p.id}`, { name: "Renamed" });
    assert.equal(body.name, "Renamed");
  });

  test("reads a file inside the project", async () => {
    const p = await addFixture();
    const { status, body } = await api("GET", `/api/projects/${p.id}/file?path=secret-ish.txt`);
    assert.equal(status, 200);
    assert.match(body.content, /readable, inside the project/);
  });

  describe("file endpoint containment", () => {
    const escapes = [
      "../../../../etc/passwd",
      "/etc/passwd",
      "skills/../../../../etc/passwd",
    ];
    for (const attempt of escapes) {
      test(`refuses to read ${attempt}`, async () => {
        const p = await addFixture();
        const { status, body } = await api("GET", `/api/projects/${p.id}/file?path=${encodeURIComponent(attempt)}`);
        assert.equal(status, 400, `expected 400 for ${attempt}`);
        assert.match(body.error, /Invalid path/);
      });
    }

    test("404s rather than 400s for a missing file that is inside the project", async () => {
      const p = await addFixture();
      const { status } = await api("GET", `/api/projects/${p.id}/file?path=nope.txt`);
      assert.equal(status, 404);
    });
  });

  test("deletes a project and forgets it", async () => {
    const p = await addFixture();
    assert.equal((await api("DELETE", `/api/projects/${p.id}`)).status, 204);
    assert.equal((await api("GET", `/api/projects/${p.id}`)).status, 404);
    assert.equal((await api("DELETE", `/api/projects/${p.id}`)).status, 404);
  });

  test("persists the project list to disk", async () => {
    const p = await addFixture();
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, "projects.json"), "utf8"));
    assert.ok(saved.projects.some((x) => x.id === p.id && x.path === projectRoot));
  });

  test("serves the browser UI", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Skill Atlas/);
  });
});
