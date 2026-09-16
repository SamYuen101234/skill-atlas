// Interactive relationship graph (D3 force layout in SVG).
(function () {
  const REL_STYLE = {
    uses:       { dash: null,   width: 1.4, arrow: true,  label: "uses" },
    provides:   { dash: null,   width: 1.8, arrow: true,  label: "provides" },
    references: { dash: "2,3",  width: 1,   arrow: true,  label: "references" },
    contains:   { dash: "6,3",  width: 1,   arrow: true,  label: "contains" },
    mirror:     { dash: "4,4",  width: 1,   arrow: false, label: "mirror" },
  };
  const COLOR = { skills: "var(--skills)", agents: "var(--agents)", mcp: "var(--mcp)", tools: "var(--tools)", workflows: "var(--workflows)", plugins: "var(--plugins)", builtin: "var(--muted)" };
  const LABEL = { skills: "Skill", agents: "Agent", mcp: "MCP server", tools: "Tool", workflows: "Workflow", plugins: "Plugin", builtin: "Built-in tool" };

  let sim = null;

  function destroy() {
    if (sim) sim.stop();
    sim = null;
  }

  /**
   * opts: { graph:{nodes,edges}, container, hiddenCats:Set, hiddenRels:Set, focusCat, query, onSelect(node) }
   */
  function render(opts) {
    destroy();
    const { container, graph } = opts;
    container.innerHTML = "";
    const width = container.clientWidth || 800;
    const height = Math.max(420, container.clientHeight || 600);

    // ----- filter -----
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
    let nodes = graph.nodes.filter((n) => nodeIds.has(n.id)).map((n) => ({ ...n }));
    let byId = new Map(nodes.map((n) => [n.id, n]));
    let links = rels.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => ({ ...e }));
    const degree = new Map();
    for (const l of links) { degree.set(l.source, (degree.get(l.source) || 0) + 1); degree.set(l.target, (degree.get(l.target) || 0) + 1); }
    if (opts.hideIsolated) {
      nodes = nodes.filter((n) => degree.get(n.id));
      byId = new Map(nodes.map((n) => [n.id, n]));
      links = links.filter((e) => byId.has(e.source) && byId.has(e.target));
    }
    const neighbors = new Map();
    for (const l of links) {
      if (!neighbors.has(l.source)) neighbors.set(l.source, new Set());
      if (!neighbors.has(l.target)) neighbors.set(l.target, new Set());
      neighbors.get(l.source).add(l.target);
      neighbors.get(l.target).add(l.source);
    }
    const radius = (n) => 6 + Math.sqrt(degree.get(n.id) || 0) * 2.2;

    if (!nodes.length) {
      container.innerHTML = '<div class="none">Nothing to show with the current filters</div>';
      return;
    }

    // ----- svg -----
    const svg = d3.select(container).append("svg").attr("width", width).attr("height", height).attr("viewBox", [0, 0, width, height]);
    const defs = svg.append("defs");
    defs.append("marker").attr("id", "arrow").attr("viewBox", "0 -4 8 8").attr("refX", 8).attr("refY", 0)
      .attr("markerWidth", 6).attr("markerHeight", 6).attr("orient", "auto")
      .append("path").attr("d", "M0,-4L8,0L0,4").attr("class", "arrow-head");
    const g = svg.append("g");
    const zoom = d3.zoom().scaleExtent([0.15, 4]).on("zoom", (ev) => g.attr("transform", ev.transform));
    svg.call(zoom);
    let fitted = false;
    function fit() {
      if (fitted) return;
      fitted = true;
      const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
      const pad = 60;
      const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad + 120, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
      const k = Math.min(1.2, 0.95 / Math.max((x1 - x0) / width, (y1 - y0) / height));
      const t = d3.zoomIdentity.translate(width / 2 - k * (x0 + x1) / 2, height / 2 - k * (y0 + y1) / 2).scale(k);
      svg.transition().duration(500).call(zoom.transform, t);
    }

    const link = g.append("g").selectAll("line").data(links).join("line")
      .attr("class", (d) => `edge edge-${d.rel}`)
      .attr("stroke-width", (d) => REL_STYLE[d.rel]?.width || 1)
      .attr("stroke-dasharray", (d) => REL_STYLE[d.rel]?.dash || null)
      .attr("marker-end", (d) => (REL_STYLE[d.rel]?.arrow ? "url(#arrow)" : null));

    const node = g.append("g").selectAll("g").data(nodes).join("g").attr("class", "node").style("cursor", "pointer");
    node.append("circle").attr("r", radius).style("fill", (d) => COLOR[d.category] || "var(--muted)");
    node.append("text").text((d) => d.name.length > 34 ? d.name.slice(0, 32) + "…" : d.name).attr("x", (d) => radius(d) + 4).attr("y", 4);

    // ----- tooltip -----
    const tip = d3.select(container).append("div").attr("class", "graph-tip").style("display", "none");
    function showTip(ev, d) {
      const out = links.filter((l) => l.source.id === d.id).map((l) => `→ ${REL_STYLE[l.rel].label} <b>${esc(l.target.name)}</b>`);
      const inn = links.filter((l) => l.target.id === d.id).map((l) => `← ${REL_STYLE[l.rel].label === "mirror" ? "mirror" : REL_STYLE[l.rel].label + " by"} <b>${esc(l.source.name)}</b>`);
      tip.style("display", "block").html(
        `<div class="t-name" style="color:${COLOR[d.category]}">${esc(d.name)}</div>` +
        `<div class="t-kind">${LABEL[d.category]} · ${esc(d.kind)}</div>` +
        (d.path ? `<div class="t-path">${esc(d.path)}</div>` : "") +
        (out.length || inn.length ? `<div class="t-rels">${[...out, ...inn].slice(0, 14).join("<br>")}${out.length + inn.length > 14 ? "<br>…" : ""}</div>` : "")
      );
      moveTip(ev);
    }
    function moveTip(ev) {
      const r = container.getBoundingClientRect();
      const x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
      tip.style("left", Math.min(x, r.width - 320) + "px").style("top", Math.min(y, r.height - 40) + "px");
    }

    // ----- highlighting -----
    const q = (opts.query || "").toLowerCase();
    function applyDim(focusId) {
      node.classed("dim", (d) => {
        if (focusId) return d.id !== focusId && !neighbors.get(focusId)?.has(d.id);
        if (q) return !(d.name.toLowerCase().includes(q) || d.path.toLowerCase().includes(q) || d.kind.toLowerCase().includes(q));
        return false;
      });
      node.classed("hit", (d) => !!q && !focusId && (d.name.toLowerCase().includes(q) || d.path.toLowerCase().includes(q)));
      link.classed("dim", (l) => {
        if (focusId) return l.source.id !== focusId && l.target.id !== focusId;
        return false;
      }).classed("lit", (l) => !!focusId && (l.source.id === focusId || l.target.id === focusId));
    }

    node.on("mouseenter", (ev, d) => { showTip(ev, d); applyDim(d.id); })
      .on("mousemove", moveTip)
      .on("mouseleave", () => { tip.style("display", "none"); applyDim(null); })
      .on("click", (ev, d) => { ev.stopPropagation(); opts.onSelect?.(d); });

    node.call(d3.drag()
      .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on("end", (ev, d) => { if (!ev.active) sim.alphaTarget(0); if (!opts.pin) { d.fx = null; d.fy = null; } }));

    // ----- simulation -----
    sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id((d) => d.id).distance((l) => l.rel === "mirror" ? 50 : 120).strength(0.4))
      .force("charge", d3.forceManyBody().strength(-420).distanceMax(600))
      .force("collide", d3.forceCollide().radius((d) => radius(d) + 10 + Math.min(d.name.length, 34) * 2.2).iterations(2))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("x", d3.forceX(width / 2).strength(0.04))
      .force("y", d3.forceY(height / 2).strength(0.04))
      .on("tick", () => {
        link.attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
          .attr("x2", (d) => shorten(d).x).attr("y2", (d) => shorten(d).y);
        node.attr("transform", (d) => `translate(${d.x},${d.y})`);
      })
      .on("end", fit);
    // Pre-run most of the layout so the first frame is already spread out, then fit right away.
    sim.tick(200);
    fit();
    // Pull the arrow tip back to the target circle's edge.
    function shorten(d) {
      const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
      const len = Math.hypot(dx, dy) || 1;
      const r = radius(d.target) + 2;
      return { x: d.target.x - (dx / len) * r, y: d.target.y - (dy / len) * r };
    }
    applyDim(null);
    return { nodeCount: nodes.length, edgeCount: links.length };
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  window.Graph = { render, destroy, REL_STYLE, LABEL };
})();
