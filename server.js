import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanProject } from "./scanner.js";
import { versionInfo, bumpVersion } from "./versioning.js";

import { pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Strips the port, tolerating bracketed IPv6 literals.
export function isLoopbackHost(hostHeader) {
  const h = String(hostHeader || "").trim().toLowerCase();
  if (!h) return false;
  const host = h.startsWith("[") ? h.replace(/\]:\d+$/, "]") : h.replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(host);
}

function hostAllowlist(req, res, next) {
  if (isLoopbackHost(req.headers.host)) return next();
  res.status(403).json({ error: "Forbidden: requests must be addressed to localhost" });
}

// Build the HTTP app. dataDir holds projects.json (browser mode: ./data, app mode: Application Support).
export function createApp({ dataDir = path.join(__dirname, "data") } = {}) {
const DATA_DIR = dataDir;
const DB_FILE = path.join(DATA_DIR, "projects.json");

const app = express();

// Only answer requests addressed to a loopback host. Binding to 127.0.0.1 keeps other
// machines out, but a web page can still reach this port through DNS rebinding: a domain
// whose record flips to 127.0.0.1 becomes same-origin with the server in the browser.
// Such requests arrive with the attacker's domain in the Host header, so reject them.
app.use(hostAllowlist);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/vendor/d3.min.js", express.static(path.join(__dirname, "node_modules/d3/dist/d3.min.js")));

// ---------- persistence ----------
let db = { projects: [] };

async function loadDb() {
  try {
    db = JSON.parse(await fs.readFile(DB_FILE, "utf8"));
    if (!Array.isArray(db.projects)) db = { projects: [] };
  } catch {
    db = { projects: [] };
  }
}

async function saveDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

// Resolve relPath inside root. Rejects lexical escapes ("../x") and symlinks that point
// out of the project. Returns { abs } or { error, status }.
async function resolveInside(root, relPath) {
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return { error: "Invalid path", status: 400 };
  let real, realRoot;
  try { real = await fs.realpath(abs); realRoot = await fs.realpath(root); } catch { return { error: "File not readable", status: 404 }; }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { error: "Invalid path", status: 400 };
  return { abs: real };
}

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function findProject(id) {
  return db.projects.find((p) => p.id === id);
}

function summary(p) {
  const c = p.scan?.categories || {};
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    addedAt: p.addedAt,
    scannedAt: p.scan?.scannedAt || null,
    counts: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.length])),
    error: p.error || null,
  };
}

async function runScan(p) {
  try {
    p.scan = await scanProject(p.path);
    p.error = null;
  } catch (e) {
    p.error = e.message;
  }
  await saveDb();
}

// ---------- routes ----------
app.get("/api/projects", (_req, res) => {
  res.json(db.projects.map(summary));
});

app.post("/api/projects", async (req, res) => {
  const raw = String(req.body?.path || "").trim();
  if (!raw) return res.status(400).json({ error: "path is required" });
  const abs = path.resolve(expandHome(raw));
  try {
    const st = await fs.stat(abs);
    if (!st.isDirectory()) return res.status(400).json({ error: "Path is not a directory" });
  } catch {
    return res.status(400).json({ error: "Directory does not exist" });
  }
  const existing = db.projects.find((p) => p.path === abs);
  if (existing) {
    await runScan(existing);
    return res.json({ ...summary(existing), existed: true });
  }
  const project = {
    id: crypto.randomUUID().slice(0, 8),
    name: String(req.body?.name || "").trim() || path.basename(abs),
    path: abs,
    addedAt: new Date().toISOString(),
    scan: null,
    error: null,
  };
  db.projects.push(project);
  await runScan(project);
  res.status(201).json(summary(project));
});

app.get("/api/projects/:id", (req, res) => {
  const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  res.json({ ...summary(p), scan: p.scan, roles: p.roles || {} });
});

app.post("/api/projects/:id/scan", async (req, res) => {
  const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  await runScan(p);
  res.json({ ...summary(p), scan: p.scan, roles: p.roles || {} });
});

app.patch("/api/projects/:id", async (req, res) => {
  const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  if (typeof req.body?.name === "string" && req.body.name.trim()) p.name = req.body.name.trim();
  await saveDb();
  res.json(summary(p));
});

// Manual start/end overrides for the flow graph: { nodeId, role: "start" | "end" | null }
app.patch("/api/projects/:id/roles", async (req, res) => {
  const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  const { nodeId, role } = req.body || {};
  if (typeof nodeId !== "string" || !nodeId) return res.status(400).json({ error: "nodeId is required" });
  if (role != null && role !== "start" && role !== "end") return res.status(400).json({ error: "role must be start, end or null" });
  p.roles = p.roles || {};
  if (role == null) delete p.roles[nodeId]; else p.roles[nodeId] = role;
  await saveDb();
  res.json({ roles: p.roles });
});

// Plugin versioning
app.get("/api/projects/:id/version", async (req, res) => {
  const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  try {
    res.json(await versionInfo(p.path, String(req.query.plugin || ""), req.query.listedIn ? String(req.query.listedIn) : null));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/projects/:id/version", async (req, res) => {
  const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  try {
    const result = await bumpVersion(p.path, req.body || {});
    await runScan(p);
    res.json({ ...result, counts: summary(p).counts });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/projects/:id", async (req, res) => {
  const idx = db.projects.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  db.projects.splice(idx, 1);
  await saveDb();
  res.status(204).end();
});

// Read a file inside a project (for the detail viewer). Rejects paths and symlinks outside the project.
app.get("/api/projects/:id/file", async (req, res) => {
  const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  const relPath = String(req.query.path || "");
  const { abs, error, status } = await resolveInside(p.path, relPath);
  if (error) return res.status(status).json({ error });
  try {
    const st = await fs.stat(abs);
    if (st.size > 1024 * 1024) return res.status(413).json({ error: "File too large to display" });
    const content = await fs.readFile(abs, "utf8");
    res.json({ path: relPath, content });
  } catch {
    res.status(404).json({ error: "File not readable" });
  }
});

// Native folder picker (macOS only). Falls back to 501 elsewhere.
app.post("/api/pick-folder", (_req, res) => {
  if (process.platform !== "darwin") return res.status(501).json({ error: "Folder picker only available on macOS" });
  const script = 'set f to POSIX path of (choose folder with prompt "Select a project folder")\nreturn f';
  execFile("osascript", ["-e", script], { timeout: 120000 }, (err, stdout) => {
    if (err) return res.json({ path: null, cancelled: true });
    res.json({ path: stdout.trim().replace(/\/$/, "") });
  });
});

// Open a file or folder in Finder / default app (macOS).
app.post("/api/projects/:id/open", async (req, res) => {
  const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  const relPath = String(req.body?.path || "");
  const { abs, error, status } = await resolveInside(p.path, relPath);
  if (error) return res.status(status).json({ error });
  if (process.platform !== "darwin") return res.status(501).json({ error: "Only supported on macOS" });
  const args = req.body?.reveal ? ["-R", abs] : [abs];
  execFile("open", args, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Internal error" });
});

app.loadDb = loadDb;
return app;
}

// Start listening. Binds to loopback only: the API can read any file on disk and run git.
export async function startServer({ dataDir, port = Number(process.env.PORT) || 3210, host = "127.0.0.1" } = {}) {
  const app = createApp({ dataDir });
  await app.loadDb();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve({ server, port: server.address().port, host }));
    server.on("error", reject);
  });
}

// `node server.js` → browser mode
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port, host } = await startServer();
  console.log(`Skill Atlas running at http://${host}:${port}`);
}
