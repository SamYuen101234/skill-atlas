// Plugin version bumping: reads/writes plugin.json, marketplace.json, frontmatter metadata.version,
// pyproject.toml and CHANGELOG.md, with optional git commit + tag.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(root, args) {
  try {
    const { stdout } = await exec("git", ["-C", root, ...args], { maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, out: stdout.trim(), raw: stdout };
  } catch (e) {
    return { ok: false, out: (e.stderr || e.message || "").trim() };
  }
}

function parseSemver(v) {
  const m = String(v || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function nextVersion(current, bump) {
  const p = parseSemver(current) || [0, 0, 0];
  if (bump === "major") return `${p[0] + 1}.0.0`;
  if (bump === "minor") return `${p[0]}.${p[1] + 1}.0`;
  if (bump === "patch") return `${p[0]}.${p[1]}.${p[2] + 1}`;
  return null;
}

function assertInside(root, relPath) {
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error("Path outside project");
  return abs;
}

async function readJson(abs) {
  return JSON.parse(await fs.readFile(abs, "utf8"));
}

async function walk(absDir, out = []) {
  let entries = [];
  try { entries = await fs.readdir(absDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "__pycache__") continue;
    const p = path.join(absDir, e.name);
    if (e.isDirectory()) await walk(p, out); else out.push(p);
  }
  return out;
}

// Files inside the plugin that carry a version.
async function versionedFiles(root, pluginDirAbs) {
  const files = await walk(pluginDirAbs);
  const md = [], toml = [];
  for (const f of files) {
    const base = path.basename(f);
    if (base === "SKILL.md" || (/\.md$/.test(base) && /(^|\/)agents\//.test(path.relative(root, f).split(path.sep).join("/")))) md.push(f);
    if (base === "pyproject.toml" || base === "package.json") toml.push(f);
  }
  return { md, toml };
}

function frontmatterVersion(text) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const meta = fm[1].match(/^metadata:\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m);
  if (!meta) return null;
  const v = meta[1].match(/^[ \t]+version:[ \t]*["']?([^"'\r\n]+)["']?/m);
  return v ? v[1].trim() : "";
}

function setFrontmatterVersion(text, version) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const meta = fm[1].match(/^metadata:\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m);
  if (!meta) return null;
  let block = meta[1];
  if (/^[ \t]+version:/m.test(block)) block = block.replace(/^([ \t]+)version:.*$/m, `$1version: "${version}"`);
  else block = block.replace(/\s*$/, "") + `\n  version: "${version}"\n`;
  const newFm = fm[1].replace(meta[0], `metadata:\n${block}`);
  return text.replace(fm[1], newFm);
}

export async function versionInfo(root, pluginRel, listedInRel) {
  const pluginAbs = assertInside(root, pluginRel);
  if (!pluginRel.endsWith(".claude-plugin/plugin.json")) throw new Error("Not a plugin manifest");
  const plugin = await readJson(pluginAbs);
  const pluginDirAbs = path.dirname(path.dirname(pluginAbs));
  const pluginDirRel = path.relative(root, pluginDirAbs).split(path.sep).join("/");

  let marketplaceVersion = null;
  if (listedInRel) {
    try {
      const mk = await readJson(assertInside(root, listedInRel));
      marketplaceVersion = (mk.plugins || []).find((p) => p.name === plugin.name)?.version ?? null;
    } catch { /* ignore */ }
  }

  const { md, toml } = await versionedFiles(root, pluginDirAbs);
  const files = [];
  for (const f of md) {
    const v = frontmatterVersion(await fs.readFile(f, "utf8"));
    files.push({ path: path.relative(root, f).split(path.sep).join("/"), version: v, hasMetadata: v !== null });
  }
  const manifests = [];
  for (const f of toml) {
    const text = await fs.readFile(f, "utf8");
    const v = path.basename(f) === "package.json" ? (JSON.parse(text).version ?? null) : (text.match(/^version\s*=\s*["']([^"']+)["']/m)?.[1] ?? null);
    manifests.push({ path: path.relative(root, f).split(path.sep).join("/"), version: v });
  }

  // git context
  const gitInfo = { available: false };
  const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.ok) {
    gitInfo.available = true;
    const tagPrefix = `${plugin.name}-v`;
    const tag = await git(root, ["describe", "--tags", "--match", `${tagPrefix}*`, "--abbrev=0"]);
    gitInfo.lastTag = tag.ok ? tag.out : null;
    gitInfo.tagPrefix = tagPrefix;
    const changed = new Set();
    if (gitInfo.lastTag) {
      const d = await git(root, ["diff", "--name-only", `${gitInfo.lastTag}..HEAD`, "--", pluginDirRel]);
      if (d.ok) d.out.split("\n").filter(Boolean).forEach((f) => changed.add(f));
    }
    const st = await git(root, ["status", "--porcelain", "--", pluginDirRel]);
    const uncommitted = st.ok ? st.raw.split("\n").filter((l) => l.length > 3).map((l) => l.slice(3).replace(/^.* -> /, "").trim()) : [];
    uncommitted.forEach((f) => changed.add(f));
    gitInfo.changedSinceTag = [...changed].sort();
    gitInfo.uncommitted = uncommitted.length;
    const br = await git(root, ["branch", "--show-current"]);
    gitInfo.branch = br.ok ? br.out : null;
  }

  const current = plugin.version || "0.0.0";
  return {
    name: plugin.name,
    pluginPath: pluginRel,
    pluginDir: pluginDirRel,
    current,
    marketplaceVersion,
    listedIn: listedInRel || null,
    next: { patch: nextVersion(current, "patch"), minor: nextVersion(current, "minor"), major: nextVersion(current, "major") },
    files,
    manifests,
    changelogExists: await fs.stat(path.join(pluginDirAbs, "CHANGELOG.md")).then(() => true).catch(() => false),
    git: gitInfo,
  };
}

export async function bumpVersion(root, opts) {
  const { pluginPath, listedIn, version, changelog, updateFileVersions, updateManifests, commit, tag } = opts;
  if (!parseSemver(version)) throw new Error("Version must look like 1.2.3");
  const info = await versionInfo(root, pluginPath, listedIn);
  const written = [];
  const pluginAbs = assertInside(root, pluginPath);
  const pluginDirAbs = path.dirname(path.dirname(pluginAbs));

  // plugin.json
  const plugin = await readJson(pluginAbs);
  plugin.version = version;
  await fs.writeFile(pluginAbs, JSON.stringify(plugin, null, 2) + "\n");
  written.push(pluginPath);

  // marketplace.json entry
  if (listedIn) {
    const mkAbs = assertInside(root, listedIn);
    const mk = await readJson(mkAbs);
    const entry = (mk.plugins || []).find((p) => p.name === plugin.name);
    if (entry) {
      entry.version = version;
      await fs.writeFile(mkAbs, JSON.stringify(mk, null, 2) + "\n");
      written.push(listedIn);
    }
  }

  // frontmatter metadata.version in skills / agents
  if (updateFileVersions) {
    for (const f of info.files) {
      if (!f.hasMetadata) continue;
      const abs = assertInside(root, f.path);
      const text = await fs.readFile(abs, "utf8");
      const next = setFrontmatterVersion(text, version);
      if (next && next !== text) { await fs.writeFile(abs, next); written.push(f.path); }
    }
  }

  // pyproject.toml / package.json inside the plugin
  if (updateManifests) {
    for (const m of info.manifests) {
      const abs = assertInside(root, m.path);
      const text = await fs.readFile(abs, "utf8");
      let next;
      if (path.basename(abs) === "package.json") {
        const j = JSON.parse(text); j.version = version; next = JSON.stringify(j, null, 2) + "\n";
      } else {
        next = text.replace(/^(version\s*=\s*)["'][^"']*["']/m, `$1"${version}"`);
      }
      if (next !== text) { await fs.writeFile(abs, next); written.push(m.path); }
    }
  }

  // CHANGELOG.md
  const clAbs = path.join(pluginDirAbs, "CHANGELOG.md");
  const date = new Date().toISOString().slice(0, 10);
  const body = (changelog || "").trim() || "- No notes.";
  let cl = await fs.readFile(clAbs, "utf8").catch(() => "");
  const section = `## ${version} - ${date}\n\n${body}\n\n`;
  if (!cl.trim()) cl = `# Changelog\n\n${section}`;
  else if (/^# /m.test(cl)) cl = cl.replace(/^(# .*\r?\n)(\r?\n)?/m, `$1\n${section}`);
  else cl = section + cl;
  await fs.writeFile(clAbs, cl);
  written.push(path.relative(root, clAbs).split(path.sep).join("/"));

  // git
  const result = { version, written, git: {} };
  if ((commit || tag) && info.git.available) {
    const tagName = `${info.git.tagPrefix}${version}`;
    if (commit) {
      const add = await git(root, ["add", "--", ...written]);
      const c = add.ok ? await git(root, ["commit", "-m", `${plugin.name} v${version}\n\n${body}`]) : add;
      result.git.commit = c;
    }
    if (tag) {
      const t = await git(root, ["tag", "-a", tagName, "-m", `${plugin.name} v${version}`]);
      result.git.tag = { ...t, name: tagName };
    }
    result.git.hint = `git push origin ${info.git.branch || "HEAD"}${tag ? ` ${tagName}` : ""}`;
  } else if (commit || tag) {
    result.git.error = "Not a git repository";
  }
  return result;
}
