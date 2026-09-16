import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { startServer, isLoopbackHost } from "../server.js";
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
    // Without this the suite would scan the real ~/.claude of whoever runs it.
    process.env.CLAUDE_CONFIG_DIR = path.join(dataDir, "no-such-config");
    projectRoot = await makeProject(FIXTURE);
    // Port 0: let the OS pick, exactly as the Electron shell does.
    const started = await startServer({ dataDir, port: 0, host: "127.0.0.1" });
    server = started.server;
    base = `http://${started.host}:${started.port}`;
  });

  after(async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
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

  describe("Host header allowlist (DNS rebinding)", () => {
    // A page on evil.example whose DNS record flips to 127.0.0.1 reaches this port with
    // its own domain in the Host header. Nothing should be served to it.
    // fetch() silently replaces a custom Host header, so go through node:http.
    const withHost = (host, method, urlPath, body) => new Promise((resolve, reject) => {
      const url = new URL(base);
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({
        hostname: url.hostname, port: url.port, method, path: urlPath,
        headers: { host, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
      }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });

    test("refuses API reads addressed to a foreign host", async () => {
      const { status, text } = await withHost("evil.example:3210", "GET", "/api/projects");
      assert.equal(status, 403);
      assert.match(JSON.parse(text).error, /localhost/);
    });

    test("refuses API writes addressed to a foreign host", async () => {
      const { status } = await withHost("evil.example:3210", "POST", "/api/projects", { path: projectRoot });
      assert.equal(status, 403);
      const { body } = await api("GET", "/api/projects");
      assert.equal(body.length, 0, "the project must not have been added");
    });

    test("refuses to serve the UI to a foreign host", async () => {
      const { status } = await withHost("evil.example", "GET", "/");
      assert.equal(status, 403);
    });

    test("still serves loopback hosts", async () => {
      for (const host of ["localhost:3210", "127.0.0.1:3210", "[::1]:3210", "LOCALHOST"]) {
        const { status } = await withHost(host, "GET", "/api/projects");
        assert.equal(status, 200, `expected 200 for Host: ${host}`);
      }
    });

    test("isLoopbackHost", () => {
      for (const ok of ["localhost", "localhost:3210", "127.0.0.1", "127.0.0.1:65535", "[::1]", "[::1]:3210"]) {
        assert.equal(isLoopbackHost(ok), true, ok);
      }
      for (const bad of ["", undefined, "evil.example", "evil.example:3210", "localhost.evil.example", "127.0.0.1.evil.example", "127.0.0.2", "[::2]:3210", "10.0.0.1:3210"]) {
        assert.equal(isLoopbackHost(bad), false, String(bad));
      }
    });
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

    test("refuses to follow a symlink that points outside the project", async () => {
      const p = await addFixture();
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "skill-atlas-outside-"));
      await fs.writeFile(path.join(outside, "secret.txt"), "outside\n");
      await fs.symlink(path.join(outside, "secret.txt"), path.join(projectRoot, "link.txt"));
      await fs.symlink(outside, path.join(projectRoot, "linkdir"));
      try {
        for (const attempt of ["link.txt", "linkdir/secret.txt"]) {
          const { status, body } = await api("GET", `/api/projects/${p.id}/file?path=${encodeURIComponent(attempt)}`);
          assert.equal(status, 400, `expected 400 for ${attempt}`);
          assert.match(body.error, /Invalid path/);
        }
      } finally {
        await fs.rm(path.join(projectRoot, "link.txt"), { force: true });
        await fs.rm(path.join(projectRoot, "linkdir"), { force: true });
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    test("404s rather than 400s for a missing file that is inside the project", async () => {
      const p = await addFixture();
      const { status } = await api("GET", `/api/projects/${p.id}/file?path=nope.txt`);
      assert.equal(status, 404);
    });
  });

  describe("global config", () => {
    let fakeHome;

    before(async () => {
      fakeHome = await makeProject({
        ".claude/skills/global-demo/SKILL.md": "---\nname: global-demo\ndescription: A user-level skill.\n---\n",
        ".claude/settings.json": JSON.stringify({ mcpServers: { linear: { command: "linear-mcp" } } }),
        ".claude/projects/repo/transcript.jsonl": "{}\n",
        ".ssh/id_rsa": "PRIVATE KEY\n",
      });
      process.env.CLAUDE_CONFIG_DIR = path.join(fakeHome, ".claude");
    });

    after(async () => {
      process.env.CLAUDE_CONFIG_DIR = path.join(dataDir, "no-such-config");
      await removeProject(fakeHome);
    });

    test("adds the global config as a project and scans it", async () => {
      const { status, body } = await api("POST", "/api/global");
      assert.equal(status, 201);
      assert.equal(body.global, true);
      assert.equal(body.dir, path.join(fakeHome, ".claude"));
      assert.equal(body.path, fakeHome);
      assert.equal(body.counts.skills, 1);
      assert.equal(body.counts.mcp, 1);
    });

    test("refreshes the existing entry instead of adding a second one", async () => {
      const first = (await api("POST", "/api/global")).body;
      const { status, body } = await api("POST", "/api/global");
      assert.equal(status, 200);
      assert.equal(body.existed, true);
      assert.equal(body.id, first.id);
      assert.equal((await api("GET", "/api/projects")).body.length, 1);
    });

    test("rescans through the normal scan route", async () => {
      const p = (await api("POST", "/api/global")).body;
      const { status, body } = await api("POST", `/api/projects/${p.id}/scan`);
      assert.equal(status, 200);
      assert.equal(body.scan.categories.skills[0].name, "global-demo");
    });

    test("serves a file from inside the config folder", async () => {
      const p = (await api("POST", "/api/global")).body;
      const rel = ".claude/skills/global-demo/SKILL.md";
      const { status, body } = await api("GET", `/api/projects/${p.id}/file?path=${encodeURIComponent(rel)}`);
      assert.equal(status, 200);
      assert.match(body.content, /global-demo/);
    });

    test("refuses to read the rest of the home directory", async () => {
      const p = (await api("POST", "/api/global")).body;
      for (const attempt of [".ssh/id_rsa", "", ".claude.json.bak"]) {
        const { status, body } = await api("GET", `/api/projects/${p.id}/file?path=${encodeURIComponent(attempt)}`);
        assert.equal(status, 400, `expected 400 for "${attempt}"`);
        assert.match(body.error, /Invalid path/);
      }
    });

    test("adding the home directory as a normal project does not hijack the global entry", async () => {
      const g = (await api("POST", "/api/global")).body;
      const { status, body } = await api("POST", "/api/projects", { path: fakeHome });
      assert.equal(status, 201);
      assert.notEqual(body.id, g.id);
      assert.equal(body.global, false);
    });

    test("404s when the config folder does not exist", async () => {
      process.env.CLAUDE_CONFIG_DIR = path.join(fakeHome, "absent");
      const { status, body } = await api("POST", "/api/global");
      assert.equal(status, 404);
      assert.match(body.error, /No global config folder/);
      process.env.CLAUDE_CONFIG_DIR = path.join(fakeHome, ".claude");
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
// Its own server and data dir: the "removed on purpose" flag is persistent, so these
// cases cannot share state with each other or with the suite above.
describe("global config auto-add", () => {
  let server, base, dataDir, fakeHome;

  const api = async (method, urlPath, body) => {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const start = async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-atlas-auto-"));
    const started = await startServer({ dataDir, port: 0, host: "127.0.0.1" });
    server = started.server;
    base = `http://${started.host}:${started.port}`;
  };

  before(async () => {
    fakeHome = await makeProject({
      ".claude/skills/auto/SKILL.md": "---\nname: auto\ndescription: A user-level skill.\n---\n",
    });
    process.env.CLAUDE_CONFIG_DIR = path.join(fakeHome, ".claude");
    await start();
  });

  after(async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    await new Promise((r) => server.close(r));
    await removeProject(fakeHome);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("appears in the list without anyone asking for it", async () => {
    const { body } = await api("GET", "/api/projects");
    assert.equal(body.length, 1);
    assert.equal(body[0].global, true);
    assert.equal(body[0].counts.skills, 1, "it should arrive already scanned");
  });

  test("is added at most once, however often the list is fetched", async () => {
    await api("GET", "/api/projects");
    const { body } = await api("GET", "/api/projects");
    assert.equal(body.filter((p) => p.global).length, 1);
  });

  test("keeps its id across listings, so a selected entry does not move", async () => {
    const first = (await api("GET", "/api/projects")).body[0].id;
    assert.equal((await api("GET", "/api/projects")).body[0].id, first);
  });

  test("sits at the top of the list", async () => {
    await api("POST", "/api/projects", { path: fakeHome });
    const { body } = await api("GET", "/api/projects");
    assert.equal(body[0].global, true);
    assert.equal(body.length, 2);
  });

  test("stays gone once removed, instead of coming back on the next listing", async () => {
    const g = (await api("GET", "/api/projects")).body.find((p) => p.global);
    assert.equal((await api("DELETE", `/api/projects/${g.id}`)).status, 204);
    const { body } = await api("GET", "/api/projects");
    assert.equal(body.filter((p) => p.global).length, 0);
  });

  test("the removal survives a restart", async () => {
    await new Promise((r) => server.close(r));
    const started = await startServer({ dataDir, port: 0, host: "127.0.0.1" });
    server = started.server;
    base = `http://${started.host}:${started.port}`;
    const { body } = await api("GET", "/api/projects");
    assert.equal(body.filter((p) => p.global).length, 0, "a removed entry must not reappear");
  });

  test("asking for it explicitly brings it back", async () => {
    const { status, body } = await api("POST", "/api/global");
    assert.equal(status, 201);
    assert.equal(body.global, true);
    const list = (await api("GET", "/api/projects")).body;
    assert.equal(list.filter((p) => p.global).length, 1);
  });
});

describe("global config auto-add with no config folder", () => {
  let server, base, dataDir;

  before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-atlas-auto-none-"));
    process.env.CLAUDE_CONFIG_DIR = path.join(dataDir, "absent");
    const started = await startServer({ dataDir, port: 0, host: "127.0.0.1" });
    server = started.server;
    base = `http://${started.host}:${started.port}`;
  });

  after(async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    await new Promise((r) => server.close(r));
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("adds nothing, and does not wedge the listing", async () => {
    const res = await fetch(`${base}/api/projects`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});
