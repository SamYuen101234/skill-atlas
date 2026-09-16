// Layered left-to-right flow graph: one column per category, edges drawn as curves.
(function () {
  const ORDER = ["plugins", "workflows", "agents", "skills", "mcp", "tools", "builtin"];
  const COLOR = { skills: "var(--skills)", agents: "var(--agents)", mcp: "var(--mcp)", tools: "var(--tools)", workflows: "var(--workflows)", plugins: "var(--plugins)", builtin: "var(--muted)" };
  const LABEL = { skills: "Skills", agents: "Agents", mcp: "MCP servers", tools: "Tools", workflows: "Workflows", plugins: "Plugins", builtin: "Built-in tools" };
  const NODE_H = 30, GAP_Y = 12, GAP_X = 110, HEADER_H = 34, PAD = 24, MAX_LABEL = 30;
  const REL_STYLE = window.Graph ? window.Graph.REL_STYLE : {};

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const short = (s) => (s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + "…" : s);
  const textW = (s) => Math.max(70, short(s).length * 6.6 + 26);

  function render(opts) {
    const { container, graph } = opts;
    container.innerHTML = "";
    const width = container.clientWidth || 800;
    const height = Math.max(420, container.clientHeight || 600);

    // ----- filter (same rules as the network view) -----
    const rels = graph.edges.filter((e) => !opts.hiddenRels.has(e.rel));
    let nodeIds = new Set(graph.nodes.filter((n) => !opts.hiddenCats.has(n.category) && (!opts.authorFilter || opts.authorFilter(n))).map((n) => n.id));
    if (opts.focusCat) {
      const focus = new Set(graph.nodes.filter((n) => n.category === opts.focusCat && nodeIds.has(n.id)).map((n) => n.id));
      const keep = new Set(focus);
      for (const e of rels) {
        if (focus.has(e.source) && nodeIds.has(e.target)) keep.add(e.target);
        if (focus.has(e.target) && nodeIds.has(e.source)) keep.add(e.source);
      }
      nodeIds = keep;
    }
    const overrides = opts.roles || {};
    const roleOf = (n) => { const m = overrides[n.id]; return m === "start" || m === "end" ? m : (n.role === "start" || n.role === "end" ? n.role : null); };
    let nodes = graph.nodes.filter((n) => nodeIds.has(n.id)).map((n) => ({ ...n, w: textW(n.name) + (roleOf(n) ? 16 : 0), h: NODE_H }));
    let byId = new Map(nodes.map((n) => [n.id, n]));
    let links = rels.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => ({ ...e }));
    const degree = new Map();
    for (const l of links) { degree.set(l.source, (degree.get(l.source) || 0) + 1); degree.set(l.target, (degree.get(l.target) || 0) + 1); }
    if (opts.hideIsolated) {
      nodes = nodes.filter((n) => degree.get(n.id));
      byId = new Map(nodes.map((n) => [n.id, n]));
      links = links.filter((e) => byId.has(e.source) && byId.has(e.target));
    }
    if (!nodes.length) {
      container.innerHTML = '<div class="none">Nothing to show with the current filters</div>';
      return;
    }
    // Start / end roles are explicit only: marked in the app (per project) or declared in frontmatter.
    // Automatic detection was dropped because cross-references between skills and agents are
    // often bidirectional, which makes in/out degree a poor signal.
    for (const n of nodes) {
      const manual = overrides[n.id];
      const role = roleOf(n);
      n.isStart = role === "start";
      n.isEnd = role === "end";
      n.roleWhy = manual ? "marked manually" : role ? "declared in frontmatter" : "";
    }
    const startCount = nodes.filter((n) => n.isStart).length, endCount = nodes.filter((n) => n.isEnd).length;
    const neighbors = new Map();
    for (const l of links) {
      if (!neighbors.has(l.source)) neighbors.set(l.source, new Set());
      if (!neighbors.has(l.target)) neighbors.set(l.target, new Set());
      neighbors.get(l.source).add(l.target);
      neighbors.get(l.target).add(l.source);
    }

    // ----- columns -----
    const cols = ORDER.filter((c) => nodes.some((n) => n.category === c)).map((c) => ({ key: c, nodes: nodes.filter((n) => n.category === c) }));
    const colIndex = new Map(cols.map((c, i) => [c.key, i]));
    for (const c of cols) c.nodes.sort((a, b) => a.name.localeCompare(b.name)).forEach((n, i) => (n.order = i));

    // Barycenter sweeps to reduce crossings: order each column by the mean order of its neighbours.
    for (let sweep = 0; sweep < 6; sweep++) {
      const seq = sweep % 2 === 0 ? cols : [...cols].reverse();
      for (const c of seq) {
        for (const n of c.nodes) {
          const nb = [...(neighbors.get(n.id) || [])].map((id) => byId.get(id)).filter((m) => m && m.category !== n.category);
          n.bary = nb.length ? nb.reduce((s, m) => s + m.order / Math.max(1, cols[colIndex.get(m.category)].nodes.length - 1), 0) / nb.length : n.order / Math.max(1, c.nodes.length - 1);
        }
        c.nodes.sort((a, b) => a.bary - b.bary || a.name.localeCompare(b.name)).forEach((n, i) => (n.order = i));
      }
    }

    // ----- coordinates -----
    let x = PAD;
    let maxH = 0;
    for (const c of cols) {
      c.w = Math.max(...c.nodes.map((n) => n.w), 90);
      c.x = x;
      c.h = c.nodes.length * (NODE_H + GAP_Y) - GAP_Y;
      maxH = Math.max(maxH, c.h);
      x += c.w + GAP_X;
    }
    const totalW = x - GAP_X + PAD;
    const totalH = HEADER_H + PAD + maxH + PAD;
    for (const c of cols) {
      const y0 = HEADER_H + PAD + (maxH - c.h) / 2;
      c.nodes.forEach((n, i) => { n.x = c.x; n.y = y0 + i * (NODE_H + GAP_Y); n.w = c.w; });
    }

    // ----- svg -----
    const svg = d3.select(container).append("svg").attr("width", width).attr("height", height).attr("viewBox", [0, 0, width, height]);
    svg.append("defs").append("marker").attr("id", "flow-arrow").attr("viewBox", "0 -4 8 8").attr("refX", 8).attr("refY", 0)
      .attr("markerWidth", 6).attr("markerHeight", 6).attr("orient", "auto")
      .append("path").attr("d", "M0,-4L8,0L0,4").attr("class", "arrow-head");
    const g = svg.append("g");
    const zoom = d3.zoom().scaleExtent([0.15, 3]).on("zoom", (ev) => g.attr("transform", ev.transform));
    svg.call(zoom);
    const k = Math.min(1, 0.96 / Math.max(totalW / width, totalH / height));
    svg.call(zoom.transform, d3.zoomIdentity.translate((width - totalW * k) / 2, (height - totalH * k) / 2).scale(k));

    // Column headers + lanes
    const lane = g.append("g").selectAll("g").data(cols).join("g");
    lane.append("rect").attr("class", "lane").attr("x", (c) => c.x - 10).attr("y", HEADER_H).attr("width", (c) => c.w + 20).attr("height", PAD + maxH + PAD).attr("rx", 10);
    lane.append("text").attr("class", "lane-title").attr("x", (c) => c.x + c.w / 2).attr("y", HEADER_H - 12).attr("text-anchor", "middle")
      .style("fill", (c) => COLOR[c.key]).text((c) => `${LABEL[c.key]} · ${c.nodes.length}`);

    // Edges
    function pathFor(l) {
      const s = byId.get(l.source), t = byId.get(l.target);
      const si = colIndex.get(s.category), ti = colIndex.get(t.category);
      const sy = s.y + NODE_H / 2, ty = t.y + NODE_H / 2;
      if (ti > si) { // forward: right side of source -> left side of target
        const sx = s.x + s.w, tx = t.x;
        const dx = Math.max(40, (tx - sx) / 2);
        return `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;
      }
      if (ti < si) { // backward: left side of source -> right side of target
        const sx = s.x, tx = t.x + t.w;
        const dx = Math.max(40, (sx - tx) / 2);
        return `M${sx},${sy} C${sx - dx},${sy} ${tx + dx},${ty} ${tx},${ty}`;
      }
      // same column: arc on the right side
      const sx = s.x + s.w, tx = t.x + t.w;
      const bulge = 40 + Math.abs(ty - sy) * 0.25;
      return `M${sx},${sy} C${sx + bulge},${sy} ${tx + bulge},${ty} ${tx},${ty}`;
    }
    const link = g.append("g").selectAll("path").data(links).join("path")
      .attr("class", (d) => `edge edge-${d.rel}`)
      .attr("d", pathFor)
      .attr("fill", "none")
      .attr("stroke-width", (d) => REL_STYLE[d.rel]?.width || 1)
      .attr("stroke-dasharray", (d) => REL_STYLE[d.rel]?.dash || null)
      .attr("marker-end", (d) => (REL_STYLE[d.rel]?.arrow !== false ? "url(#flow-arrow)" : null));

    // Nodes
    const node = g.append("g").selectAll("g").data(nodes).join("g").attr("class", "fnode").attr("transform", (d) => `translate(${d.x},${d.y})`).style("cursor", "pointer");
    node.append("rect").attr("width", (d) => d.w).attr("height", NODE_H).attr("rx", 7).style("stroke", (d) => COLOR[d.category]);
    node.append("circle").attr("cx", 13).attr("cy", NODE_H / 2).attr("r", 4).style("fill", (d) => COLOR[d.category]);
    node.append("text").attr("x", 24).attr("y", NODE_H / 2 + 4).text((d) => (d.isStart ? "▶ " : "") + short(d.name) + (d.isEnd ? " ■" : ""));
    node.append("title").text((d) => d.name);
    // Start / end points are filled solid with their category colour.
    node.classed("is-start", (d) => d.isStart).classed("is-end", (d) => d.isEnd);
    node.filter((d) => d.isStart || d.isEnd).select("rect").style("fill", (d) => COLOR[d.category]);

    // Role legend inside the canvas, click to highlight
    let pinned = opts.pinned && byId.has(opts.pinned) ? opts.pinned : null;
    let roleFilter = null;
    const roleBar = d3.select(container).append("div").attr("class", "role-bar");
    const roleChips = [["start", `▶ ${startCount} start point${startCount === 1 ? "" : "s"}`], ["end", `■ ${endCount} end point${endCount === 1 ? "" : "s"}`]];
    const chips = roleBar.selectAll("button").data(roleChips).join("button").attr("class", (d) => `chip role-chip role-${d[0]}`).text((d) => d[1])
      .on("click", (ev, d) => { roleFilter = roleFilter === d[0] ? null : d[0]; chips.classed("active", (c) => c[0] === roleFilter); applyDim(pinned); });
    if (!startCount && !endCount) roleBar.append("span").attr("class", "role-hint").text("Click a node, then Start / End in the panel to mark it");

    // ----- tooltip + highlight -----
    const tip = d3.select(container).append("div").attr("class", "graph-tip").style("display", "none");
    function showTip(ev, d) {
      const out = links.filter((l) => l.source === d.id).map((l) => `→ ${REL_STYLE[l.rel]?.label || l.rel} <b>${esc(byId.get(l.target).name)}</b>`);
      const inn = links.filter((l) => l.target === d.id).map((l) => `← ${l.rel === "mirror" ? "mirror" : (REL_STYLE[l.rel]?.label || l.rel) + " by"} <b>${esc(byId.get(l.source).name)}</b>`);
      tip.style("display", "block").html(
        `<div class="t-name" style="color:${COLOR[d.category]}">${esc(d.name)}</div>` +
        `<div class="t-kind">${LABEL[d.category]} · ${esc(d.kind)}</div>` +
        (d.isStart ? `<div class="t-role">▶ Start point — ${d.roleWhy}</div>` : "") +
        (d.isEnd ? `<div class="t-role">■ End point — ${d.roleWhy}</div>` : "") +
        (d.path ? `<div class="t-path">${esc(d.path)}</div>` : "") +
        (out.length || inn.length ? `<div class="t-rels">${[...out, ...inn].slice(0, 14).join("<br>")}${out.length + inn.length > 14 ? "<br>…" : ""}</div>` : "")
      );
      moveTip(ev);
    }
    function moveTip(ev) {
      const r = container.getBoundingClientRect();
      const px = ev.clientX - r.left + 14, py = ev.clientY - r.top + 14;
      tip.style("left", Math.min(px, r.width - 320) + "px").style("top", Math.min(py, r.height - 40) + "px");
    }
    const q = (opts.query || "").toLowerCase();
    const matches = (d) => !!q && (d.name.toLowerCase().includes(q) || d.path.toLowerCase().includes(q) || d.kind.toLowerCase().includes(q));
    const roleMatch = (d) => roleFilter === "start" ? d.isStart : roleFilter === "end" ? d.isEnd : true;
    function applyDim(focusId) {
      node.classed("dim", (d) => focusId ? d.id !== focusId && !neighbors.get(focusId)?.has(d.id) : (q ? !matches(d) : !roleMatch(d)));
      node.classed("hit", (d) => !focusId && matches(d));
      link.classed("dim", (l) => focusId ? l.source !== focusId && l.target !== focusId : (q ? !(matches(byId.get(l.source)) || matches(byId.get(l.target))) : (roleFilter ? !(roleMatch(byId.get(l.source)) || roleMatch(byId.get(l.target))) : false)))
        .classed("lit", (l) => !!focusId && (l.source === focusId || l.target === focusId));
      link.filter((l) => !!focusId && (l.source === focusId || l.target === focusId)).raise();
    }
    node.on("mouseenter", (ev, d) => { showTip(ev, d); applyDim(d.id); })
      .on("mousemove", moveTip)
      .on("mouseleave", () => { tip.style("display", "none"); applyDim(pinned); })
      .on("click", (ev, d) => { ev.stopPropagation(); pinned = pinned === d.id ? null : d.id; opts.onPin?.(pinned); applyDim(pinned); opts.onSelect?.(d); });
    svg.on("click", () => { pinned = null; opts.onPin?.(null); applyDim(null); });
    applyDim(pinned);
    return { nodeCount: nodes.length, edgeCount: links.length };
  }

  window.Flow = { render, destroy() {} };
})();
