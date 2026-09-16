const CATS = [
  { key: "skills", label: "Skills", color: "var(--skills)" },
  { key: "agents", label: "Agents", color: "var(--agents)" },
  { key: "mcp", label: "MCP servers", color: "var(--mcp)" },
  { key: "tools", label: "Tools", color: "var(--tools)" },
  { key: "workflows", label: "Workflows", color: "var(--workflows)" },
  { key: "plugins", label: "Plugins", color: "var(--plugins)" },
];
const catByKey = Object.fromEntries(CATS.map((c) => [c.key, c]));

const state = {
  projects: [],
  current: null, // full project with scan
  activeCat: null,
  activeKinds: new Set(),
  query: "",
  projectQuery: "",
  view: "list",
  hiddenCats: new Set(),
  hiddenRels: new Set(["mirror", "contains"]),
  hideIsolated: true,
  pinned: null,
  author: "",          // "" = all, "__none__" = items without an author, otherwise the author string
};
const NO_AUTHOR = "__none__";
const authorName = (a) => (a || "").replace(/\s*<.*>$/, "");
const authorOfItem = (it) => it.meta?.author || it.author || null;
function authorMatches(a) {
  if (!state.author) return true;
  if (state.author === NO_AUTHOR) return !a;
  return a === state.author;
}
const GRAPH_CATS = [...CATS, { key: "builtin", label: "Built-in tools", color: "var(--muted)" }];

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// ---------- api ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- toast ----------
let toastTimer;
function toast(msg, ms = 2500, wide = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("wide", wide);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------- projects ----------
async function loadProjects() {
  state.projects = await api("GET", "/api/projects");
  renderProjectList();
  $("sidebar-footer").textContent = `${state.projects.length} project${state.projects.length === 1 ? "" : "s"}`;
}

function renderProjectList() {
  const list = $("project-list");
  list.innerHTML = "";
  const q = state.projectQuery.toLowerCase();
  for (const p of state.projects) {
    if (q && !(p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))) continue;
    const li = el("li", "project-item" + (state.current?.id === p.id ? " active" : ""));
    li.append(el("div", "name", p.name), el("div", "path", p.path));
    const counts = el("div", "counts");
    for (const c of CATS) {
      const n = p.counts?.[c.key] || 0;
      if (!n) continue;
      const d = el("span", "dot", String(n));
      d.style.setProperty("--c", c.color);
      d.title = c.label;
      counts.append(d);
    }
    li.append(counts);
    if (p.error) li.append(el("div", "error", p.error));
    li.onclick = () => selectProject(p.id);
    list.append(li);
  }
}

async function selectProject(id) {
  state.current = await api("GET", `/api/projects/${id}`);
  state.activeCat = null;
  state.activeKinds = new Set();
  state.query = "";
  state.author = "";
  $("item-filter").value = "";
  closeDetail();
  renderProjectList();
  renderProject();
}

function renderProject() {
  const p = state.current;
  $("empty-state").hidden = !!p;
  $("project-view").hidden = !p;
  if (!p) return;
  $("project-name").textContent = p.name;
  $("project-path").textContent = p.path;
  const s = p.scan;
  $("project-meta").textContent = s
    ? `Scanned ${new Date(s.scannedAt).toLocaleString()} · ${s.filesScanned.toLocaleString()} files in ${s.durationMs} ms${s.truncated ? " · (truncated: too many files)" : ""}`
    : p.error ? `Scan failed: ${p.error}` : "Not scanned yet";

  const tiles = $("cat-tiles");
  tiles.innerHTML = "";
  for (const c of CATS) {
    const n = s?.categories?.[c.key]?.length || 0;
    const t = el("div", "tile" + (state.activeCat === c.key ? " active" : ""));
    t.style.setProperty("--c", c.color);
    t.append(el("div", "count", String(n)), el("div", "label", c.label));
    t.onclick = () => {
      state.activeCat = state.activeCat === c.key ? null : c.key;
      state.activeKinds = new Set();
      renderProject();
    };
    tiles.append(t);
  }
  renderReleaseButton();
  renderAuthorOptions();
  renderKindChips();
  renderItems();
  renderView();
}

function renderAuthorOptions() {
  const sel = $("author-filter");
  const cats = state.current?.scan?.categories || {};
  const counts = new Map();
  let none = 0;
  for (const items of Object.values(cats)) for (const it of items) {
    const a = authorOfItem(it);
    if (a) counts.set(a, (counts.get(a) || 0) + 1); else none++;
  }
  sel.innerHTML = "";
  const opt = (value, label) => { const o = document.createElement("option"); o.value = value; o.textContent = label; sel.append(o); };
  opt("", counts.size ? "All authors" : "No authors found");
  for (const [a, n] of [...counts.entries()].sort((x, y) => x[0].localeCompare(y[0]))) opt(a, `${authorName(a)} · ${n}`);
  if (counts.size && none) opt(NO_AUTHOR, `No author · ${none}`);
  sel.disabled = !counts.size;
  sel.value = state.author;
  if (sel.value !== state.author) { state.author = ""; sel.value = ""; }
}

function renderView() {
  const graphMode = state.view === "graph" || state.view === "flow";
  $("items").hidden = graphMode;
  $("kind-chips").hidden = graphMode;
  $("graph-wrap").hidden = !graphMode;
  for (const b of $("view-toggle").querySelectorAll("button")) b.classList.toggle("active", b.dataset.view === state.view);
  if (graphMode) renderGraph(); else Graph.destroy();
}

function renderGraph() {
  const graph = state.current?.scan?.graph;
  const container = $("graph");
  if (!graph) { container.innerHTML = '<div class="none">No graph data. Rescan the project.</div>'; return; }
  renderLegend(graph);
  const engine = state.view === "flow" ? Flow : Graph;
  $("graph-hint").textContent = state.view === "flow"
    ? "Left to right: plugins → workflows → agents → skills → MCP servers → tools. Scroll to zoom, drag to pan. Hover a node to trace its edges, click to pin the highlight and open the file. Category tiles focus on one category and its neighbours."
    : "Force layout. Scroll to zoom, drag the background to pan, drag nodes to rearrange. Hover a node to see its relationships, click it to open the file.";
  Graph.destroy();
  const stats = engine.render({
    container,
    graph,
    hiddenCats: state.hiddenCats,
    hiddenRels: state.hiddenRels,
    hideIsolated: state.hideIsolated,
    focusCat: state.activeCat,
    query: state.query,
    authorFilter: state.author ? (n) => authorMatches(n.author) : null,
    pinned: state.pinned,
    roles: state.current.roles || {},
    onPin: (id) => { state.pinned = id; },
    onSelect: (n) => {
      if (n.category === "builtin") return;
      const cat = catByKey[n.category];
      const item = (state.current.scan.categories[n.category] || []).find((it) => it.id === n.id);
      if (cat && item) openDetail(cat, item);
    },
  });
  if (stats) $("graph-stats").textContent = `${stats.nodeCount} nodes · ${stats.edgeCount} edges`;
}

function renderLegend(graph) {
  const legend = $("graph-legend");
  legend.innerHTML = "";
  const present = new Set(graph.nodes.map((n) => n.category));
  const catGroup = el("div", "lg-group");
  for (const c of GRAPH_CATS) {
    if (!present.has(c.key)) continue;
    const chip = el("button", "chip" + (state.hiddenCats.has(c.key) ? " off" : ""));
    chip.style.setProperty("--c", c.color);
    chip.append(el("span", "sw"), document.createTextNode(c.label));
    chip.onclick = () => { state.hiddenCats.has(c.key) ? state.hiddenCats.delete(c.key) : state.hiddenCats.add(c.key); renderGraph(); };
    catGroup.append(chip);
  }
  const relGroup = el("div", "lg-group");
  const presentRels = new Set(graph.edges.map((e) => e.rel));
  for (const [rel, st] of Object.entries(Graph.REL_STYLE)) {
    if (!presentRels.has(rel)) continue;
    const chip = el("button", "chip" + (state.hiddenRels.has(rel) ? " off" : ""));
    const ln = el("span", "ln" + (st.dash ? (st.dash.startsWith("2") ? " dotted" : " dashed") : ""));
    chip.append(ln, document.createTextNode(st.label));
    chip.title = REL_HELP[rel] || "";
    chip.onclick = () => { state.hiddenRels.has(rel) ? state.hiddenRels.delete(rel) : state.hiddenRels.add(rel); renderGraph(); };
    relGroup.append(chip);
  }
  const iso = el("button", "chip" + (state.hideIsolated ? "" : " active"), "show unconnected");
  iso.title = "Show nodes that have no relationships (e.g. permission rules)";
  iso.onclick = () => { state.hideIsolated = !state.hideIsolated; renderGraph(); };
  const stats = el("span", "graph-stats");
  stats.id = "graph-stats";
  legend.append(catGroup, el("span", null, "·"), relGroup, el("span", null, "·"), iso, stats);
}

const REL_HELP = {
  uses: "Declared in frontmatter: agent tools, skill allowed-tools, workflow skills/agents/tools",
  provides: "Tool defined in the MCP server's source tree",
  references: "The document's text mentions the other item by name or folder",
  contains: "Item lives inside the plugin's folder",
  mirror: "Same name and category at two different paths (e.g. a plugin copy)",
};

function visibleCategories() {
  const s = state.current?.scan?.categories || {};
  return CATS.filter((c) => !state.activeCat || c.key === state.activeCat).map((c) => ({ ...c, items: s[c.key] || [] }));
}

function renderKindChips() {
  const chips = $("kind-chips");
  chips.innerHTML = "";
  const kinds = new Map();
  for (const c of visibleCategories()) for (const it of c.items) if (authorMatches(authorOfItem(it))) kinds.set(it.kind, (kinds.get(it.kind) || 0) + 1);
  if (kinds.size < 2) return;
  for (const [kind, n] of [...kinds.entries()].sort()) {
    const chip = el("button", "chip" + (state.activeKinds.has(kind) ? " active" : ""), `${kind} · ${n}`);
    chip.onclick = () => {
      state.activeKinds.has(kind) ? state.activeKinds.delete(kind) : state.activeKinds.add(kind);
      renderKindChips();
      renderItems();
    };
    chips.append(chip);
  }
}

function matches(it) {
  if (state.activeKinds.size && !state.activeKinds.has(it.kind)) return false;
  if (!authorMatches(authorOfItem(it))) return false;
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return [it.name, it.description, it.path, it.kind].some((v) => (v || "").toLowerCase().includes(q));
}

function renderItems() {
  const wrap = $("items");
  wrap.innerHTML = "";
  let total = 0;
  for (const c of visibleCategories()) {
    const items = c.items.filter(matches);
    if (!items.length && (state.activeCat || state.query)) {
      if (state.activeCat) wrap.append(el("div", "none", `No ${c.label.toLowerCase()} found`));
      continue;
    }
    if (!items.length) continue;
    total += items.length;
    const g = el("section", "group");
    g.style.setProperty("--c", c.color);
    const h = el("h3", null, c.label);
    h.append(el("span", "n", `${items.length}`));
    g.append(h);
    const cards = el("div", "cards");
    for (const it of items) cards.append(renderCard(c, it));
    g.append(cards);
    wrap.append(g);
  }
  if (!total && !state.activeCat) {
    wrap.append(el("div", "none", state.query ? "Nothing matches your search" : "Nothing found in this project"));
  }
}

function renderCard(cat, it) {
  const card = el("div", "card");
  card.style.setProperty("--c", cat.color);
  const top = el("div", "top");
  top.append(el("span", "name", it.name), el("span", "kind", it.kind));
  card.append(top);
  if (it.description) card.append(el("div", "desc", it.description));
  card.append(el("div", "path", it.path));
  const tags = el("div", "tags");
  const m = it.meta || {};
  const tagList = [
    ...(m.tools || []).map((t) => `tool: ${t}`),
    ...(m.allowedTools || []).map((t) => `allows: ${t}`),
    ...(m.triggers || []).map((t) => `on: ${t}`),
    ...(m.env || []).map((t) => `env: ${t}`),
    ...(m.stages || []).map((t) => `stage: ${t}`),
    ...(m.steps || []).map((t) => `step: ${t.split(":")[0]}`),
    m.entrypoint ? `entry: ${m.entrypoint.split("/").pop()}` : null,
    m.model ? `model: ${m.model}` : null,
    m.author ? `by: ${m.author.replace(/\s*<.*>$/, "")}` : null,
    m.version ? `v${m.version}` : null,
    m.source ? `via: ${m.source}` : null,
    m.disabled ? "disabled" : null,
  ].filter(Boolean).slice(0, 8);
  for (const t of tagList) tags.append(el("span", "tag", t));
  if (tagList.length) card.append(tags);
  card.onclick = () => openDetail(cat, it);
  return card;
}

// ---------- detail ----------
async function openDetail(cat, it) {
  const d = $("detail");
  d.hidden = false;
  d.dataset.path = it.path;
  d.dataset.nodeId = it.id || "";
  renderRoleButtons();
  const vb = $("detail-version");
  vb.hidden = it.kind !== "plugin";
  vb.onclick = () => openVersionDialog(it);
  $("detail-title").textContent = it.name;
  $("detail-title").style.color = cat.color;
  $("detail-path").textContent = it.path;
  const meta = $("detail-meta");
  meta.innerHTML = "";
  const rows = [["Category", cat.label], ["Kind", it.kind]];
  if (it.description) rows.push(["Description", it.description]);
  for (const [k, v] of Object.entries(it.meta || {})) {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    rows.push([k, Array.isArray(v) ? v.join(", ") : String(v)]);
  }
  for (const [k, v] of rows) meta.append(el("dt", null, k), el("dd", null, v));
  const content = $("detail-content");
  content.textContent = "Loading…";
  try {
    const f = await api("GET", `/api/projects/${state.current.id}/file?path=${encodeURIComponent(it.path)}`);
    content.textContent = f.content;
    if (it.meta?.line) highlightLine(content, it.meta.line);
  } catch (e) {
    content.textContent = `Could not load file: ${e.message}`;
  }
}

function highlightLine(pre, line) {
  const lines = pre.textContent.split("\n");
  pre.innerHTML = "";
  lines.forEach((l, i) => {
    const span = el("span", null, l + "\n");
    if (i + 1 === line) {
      span.style.background = "rgba(108,140,255,.25)";
      span.style.display = "block";
      setTimeout(() => span.scrollIntoView({ block: "center" }), 0);
    }
    pre.append(span);
  });
}

function renderRoleButtons() {
  const id = $("detail").dataset.nodeId;
  const role = id ? (state.current?.roles || {})[id] : null;
  for (const [btnId, r] of [["detail-role-start", "start"], ["detail-role-end", "end"]]) {
    const b = $(btnId);
    b.hidden = !id;
    b.classList.toggle("active", role === r);
  }
}

async function setRole(role) {
  const id = $("detail").dataset.nodeId;
  if (!id || !state.current) return;
  const current = (state.current.roles || {})[id];
  const next = current === role ? null : role;
  try {
    const r = await api("PATCH", `/api/projects/${state.current.id}/roles`, { nodeId: id, role: next });
    state.current.roles = r.roles;
    renderRoleButtons();
    if (state.view === "flow") renderGraph();
    toast(next ? `Marked as ${next} point` : "Back to automatic role");
  } catch (e) {
    toast(e.message);
  }
}

function projectPlugins() {
  return (state.current?.scan?.categories?.plugins || []).filter((p) => p.kind === "plugin");
}
function renderReleaseButton() {
  const plugins = projectPlugins();
  const btn = $("release-btn");
  btn.hidden = plugins.length === 0;
  $("release-menu").hidden = true;
  btn.textContent = plugins.length === 1 ? `⬆ Release v${plugins[0].meta.version || "?"}` : "⬆ Release";
  btn.title = plugins.length === 1 ? `Cut a new release of ${plugins[0].name}` : `Cut a new release of one of ${plugins.length} plugins`;
}
$("release-btn").onclick = (e) => {
  e.stopPropagation();
  const plugins = projectPlugins();
  if (plugins.length === 1) { openVersionDialog(plugins[0]); return; }
  const menu = $("release-menu");
  if (!menu.hidden) { menu.hidden = true; return; }
  menu.innerHTML = "";
  for (const p of plugins) {
    const b = el("button");
    b.append(el("span", null, p.name), el("span", "v", `v${p.meta.version || "?"}`));
    b.onclick = () => { menu.hidden = true; openVersionDialog(p); };
    menu.append(b);
  }
  menu.hidden = false;
};
document.addEventListener("click", () => { $("release-menu").hidden = true; });

// ---------- plugin versioning ----------
let verInfo = null;
async function openVersionDialog(item) {
  const dlg = $("version-dialog");
  $("ver-error").textContent = "";
  try {
    const q = new URLSearchParams({ plugin: item.path, listedIn: item.meta?.listedIn || "" });
    verInfo = await api("GET", `/api/projects/${state.current.id}/version?${q}`);
  } catch (e) { toast(e.message); return; }
  const v = verInfo;
  $("ver-name").textContent = v.name;
  $("ver-current").textContent = v.current;
  $("ver-market").textContent = v.marketplaceVersion == null ? "not listed in a marketplace" : v.marketplaceVersion === v.current ? "marketplace matches" : `marketplace says ${v.marketplaceVersion}`;
  $("ver-tag").textContent = v.git.available ? (v.git.lastTag || "none") : "no git";
  $("ver-branch").textContent = v.git.available ? `${v.git.branch || "detached"} · ${v.git.uncommitted} uncommitted` : "";
  const changed = v.git.changedSinceTag || [];
  $("ver-changed-n").textContent = changed.length ? `· ${changed.length}` : "";
  const ul = $("ver-changed");
  ul.innerHTML = "";
  if (!v.git.available) ul.append(el("li", null, "Not a git repository"));
  else if (!changed.length) ul.append(el("li", null, "Nothing changed in the plugin folder"));
  for (const f of changed) ul.append(el("li", null, f.replace(v.pluginDir + "/", "")));
  $("ver-patch").textContent = v.next.patch; $("ver-minor").textContent = v.next.minor; $("ver-major").textContent = v.next.major;
  $("ver-custom").value = "";
  dlg.querySelector('input[name=bump][value=patch]').checked = true;
  const withMeta = v.files.filter((f) => f.hasMetadata).length;
  $("ver-files-n").textContent = String(withMeta);
  $("ver-files").checked = withMeta > 0; $("ver-files").disabled = withMeta === 0;
  $("ver-manifests-n").textContent = String(v.manifests.length);
  $("ver-manifests").checked = v.manifests.length > 0; $("ver-manifests").disabled = v.manifests.length === 0;
  $("ver-commit").checked = false; $("ver-gittag").checked = false;
  $("ver-commit").disabled = $("ver-gittag").disabled = !v.git.available;
  const names = changed.map((f) => f.replace(v.pluginDir + "/", "")).filter((f) => /SKILL\.md$|agents\//.test(f)).map((f) => f.replace(/\/SKILL\.md$/, "").replace(/^skills\/|^agents\/|\.md$/g, ""));
  $("ver-changelog").value = names.length ? `- Updated: ${[...new Set(names)].join(", ")}` : "";
  updateVersionPreview();
  dlg.showModal();
}
function chosenVersion() {
  const bump = document.querySelector('input[name=bump]:checked')?.value;
  return bump === "custom" ? $("ver-custom").value.trim() : verInfo?.next[bump];
}
function updateVersionPreview() {
  const ver = chosenVersion() || "?";
  $("ver-tagname").textContent = `${verInfo?.git.tagPrefix || "v"}${ver}`;
  const commit = $("ver-commit").checked, tag = $("ver-gittag").checked;
  $("ver-submit").textContent = commit && tag ? `Write, commit & tag ${ver}` : commit ? `Write & commit ${ver}` : tag ? `Write & tag ${ver}` : `Write files for ${ver}`;
}
async function submitVersion(e) {
  e.preventDefault();
  const version = chosenVersion();
  if (!/^\d+\.\d+\.\d+$/.test(version || "")) { $("ver-error").textContent = "Version must look like 1.2.3"; return; }
  const btn = $("ver-submit");
  btn.disabled = true;
  try {
    const r = await api("POST", `/api/projects/${state.current.id}/version`, {
      pluginPath: verInfo.pluginPath, listedIn: verInfo.listedIn, version,
      changelog: $("ver-changelog").value,
      updateFileVersions: $("ver-files").checked, updateManifests: $("ver-manifests").checked,
      commit: $("ver-commit").checked, tag: $("ver-gittag").checked,
    });
    $("version-dialog").close();
    await loadProjects();
    state.current = await api("GET", `/api/projects/${state.current.id}`);
    renderProject();
    closeDetail();
    const lines = [`Released ${verInfo.name} v${r.version} · ${r.written.length} files written`];
    if (r.git.commit) lines.push(r.git.commit.ok ? "Committed." : `Commit failed: ${r.git.commit.out}`);
    if (r.git.tag) lines.push(r.git.tag.ok ? `Tagged ${r.git.tag.name}.` : `Tag failed: ${r.git.tag.out}`);
    if (r.git.error) lines.push(r.git.error);
    if (r.git.hint) lines.push(`Next: ${r.git.hint}`);
    toast(lines.join("\n"), 8000, true);
  } catch (err) {
    $("ver-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function closeDetail() {
  $("detail").hidden = true;
}

// ---------- add project dialog ----------
function openAddDialog() {
  $("add-path").value = "";
  $("add-name").value = "";
  $("add-error").textContent = "";
  $("add-dialog").showModal();
  $("add-path").focus();
}

async function submitAdd(e) {
  e.preventDefault();
  const btn = $("add-submit");
  btn.disabled = true;
  btn.textContent = "Scanning…";
  $("add-error").textContent = "";
  try {
    const p = await api("POST", "/api/projects", { path: $("add-path").value, name: $("add-name").value });
    $("add-dialog").close();
    await loadProjects();
    await selectProject(p.id);
    toast(p.existed ? "Project already added — rescanned" : "Project added and scanned");
  } catch (err) {
    $("add-error").textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Add & scan";
  }
}

async function browse() {
  const btn = $("browse-btn");
  btn.disabled = true;
  try {
    const r = window.native ? { path: await window.native.pickFolder() } : await api("POST", "/api/pick-folder");
    if (r.path) $("add-path").value = r.path;
  } catch (err) {
    $("add-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------- wiring ----------
$("add-project-btn").onclick = openAddDialog;
$("empty-add-btn").onclick = openAddDialog;
$("add-cancel").onclick = () => $("add-dialog").close();
$("add-form").onsubmit = submitAdd;
$("browse-btn").onclick = browse;
$("add-path").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("add-form").requestSubmit(); } });
$("project-filter").oninput = (e) => { state.projectQuery = e.target.value; renderProjectList(); };
$("item-filter").oninput = (e) => { state.query = e.target.value; renderItems(); if (state.view !== "list") renderGraph(); };
$("author-filter").onchange = (e) => { state.author = e.target.value; renderKindChips(); renderItems(); if (state.view !== "list") renderGraph(); };
$("detail-close").onclick = closeDetail;
$("detail-role-start").onclick = () => setRole("start");
$("version-form").onsubmit = submitVersion;
$("ver-cancel").onclick = () => $("version-dialog").close();
for (const id of ["ver-commit", "ver-gittag", "ver-custom"]) $(id).oninput = updateVersionPreview;
document.querySelectorAll('input[name=bump]').forEach((r) => (r.onchange = updateVersionPreview));
$("ver-custom").onfocus = () => { document.querySelector('input[name=bump][value=custom]').checked = true; updateVersionPreview(); };
$("detail-role-end").onclick = () => setRole("end");
$("view-toggle").onclick = (e) => {
  const v = e.target.closest("button")?.dataset.view;
  if (!v || v === state.view) return;
  state.view = v;
  renderView();
};
// Re-layout the graph when its container changes size (window resize, detail panel opening/closing).
let lastGraphW = 0, resizeTimer;
new ResizeObserver((entries) => {
  const w = Math.round(entries[0].contentRect.width);
  if (!w || w === lastGraphW) return;
  lastGraphW = w;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if ((state.view === "graph" || state.view === "flow") && state.current) renderGraph(); }, 150);
}).observe($("graph"));
$("detail-open").onclick = () => {
  const rel = $("detail").dataset.path;
  api("POST", `/api/projects/${state.current.id}/open`, { path: rel }).catch((e) => toast(e.message));
};
$("reveal-btn").onclick = () => {
  api("POST", `/api/projects/${state.current.id}/open`, { path: "", reveal: false }).catch((e) => toast(e.message));
};

// Menu commands from the Electron shell
if (window.native) {
  document.documentElement.classList.add("native-app");
  window.native.onCommand((cmd) => {
    if (cmd === "add-project") return openAddDialog();
    if (cmd === "rescan") return state.current && $("rescan-btn").click();
    if (cmd === "release") return state.current && !$("release-btn").hidden && $("release-btn").click();
    if (cmd === "focus-search") return (state.current ? $("item-filter") : $("project-filter")).focus();
    if (cmd.startsWith("view:") && state.current) { state.view = cmd.slice(5); renderView(); }
  });
}
$("rescan-btn").onclick = async () => {
  const btn = $("rescan-btn");
  btn.disabled = true;
  btn.textContent = "Scanning…";
  try {
    state.current = await api("POST", `/api/projects/${state.current.id}/scan`);
    await loadProjects();
    renderProject();
    toast("Rescan complete");
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Rescan";
  }
};
$("remove-btn").onclick = async () => {
  if (!confirm(`Remove "${state.current.name}" from the list? (Files on disk are not touched.)`)) return;
  await api("DELETE", `/api/projects/${state.current.id}`);
  state.current = null;
  closeDetail();
  await loadProjects();
  renderProject();
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("detail").hidden) closeDetail();
});

loadProjects().catch((e) => toast(e.message));
