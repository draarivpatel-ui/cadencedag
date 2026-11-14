(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CadenceDagSvg = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, text) {
    if (typeof document === "undefined") return null;
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        node.setAttribute(k, String(v));
      }
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderDagGraph(svg, cpm, selectedId) {
    if (!svg || typeof document === "undefined") return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const nodes = cpm.nodes || [];
    const layers = new Map();
    for (const n of nodes) {
      if (!layers.has(n.layer)) layers.set(n.layer, []);
      layers.get(n.layer).push(n);
    }

    const numCols = Math.max(1, cpm.maxLayer + 1);
    const maxRows = Math.max(1, ...Array.from(layers.values()).map((a) => a.length));
    const nodeW = 152;
    const nodeH = 56;
    const colGap = 54;
    const rowGap = 24;
    const padX = 28;
    const padY = 28;

    const W = Math.max(760, padX * 2 + numCols * nodeW + (numCols - 1) * colGap);
    const H = Math.max(260, padY * 2 + maxRows * nodeH + (maxRows - 1) * rowGap);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

    const defs = el("defs");
    const markerNorm = el("marker", { id: "arr-norm", markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: "auto" });
    markerNorm.appendChild(el("path", { d: "M0,1 L7,4 L0,7 Z", fill: "#475569" }));
    const markerCrit = el("marker", { id: "arr-crit", markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: "auto" });
    markerCrit.appendChild(el("path", { d: "M0,1 L7,4 L0,7 Z", fill: "#fb7185" }));
    defs.appendChild(markerNorm);
    defs.appendChild(markerCrit);
    svg.appendChild(defs);

    const pos = new Map();
    for (let col = 0; col < numCols; col++) {
      const colNodes = layers.get(col) || [];
      const colH = colNodes.length * nodeH + Math.max(0, colNodes.length - 1) * rowGap;
      const startY = (H - colH) / 2;
      colNodes.forEach((n, rowIdx) => {
        pos.set(n.id, {
          x: padX + col * (nodeW + colGap),
          y: startY + rowIdx * (nodeH + rowGap)
        });
      });
    }

    // Draw edges
    for (const n of nodes) {
      const dst = pos.get(n.id);
      for (const depId of n.deps) {
        const src = pos.get(depId);
        const srcNode = cpm.nodeMap.get(depId);
        if (!src || !dst) continue;
        const critEdge = Boolean(n.isCritical && srcNode && srcNode.isCritical && Math.abs(srcNode.efMin - n.esMin) < 1e-6);
        const x1 = src.x + nodeW;
        const y1 = src.y + nodeH / 2;
        const x2 = dst.x;
        const y2 = dst.y + nodeH / 2;
        const cx = (x1 + x2) / 2;
        svg.appendChild(
          el("path", {
            d: `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`,
            fill: "none",
            stroke: critEdge ? "#fb7185" : "#475569",
            "stroke-width": critEdge ? 2.4 : 1.5,
            "marker-end": critEdge ? "url(#arr-crit)" : "url(#arr-norm)"
          })
        );
      }
    }

    // Draw nodes
    for (const n of nodes) {
      const p = pos.get(n.id);
      const isSel = n.id === selectedId;
      const g = el("g", { class: "dag-node", "data-id": n.id });
      g.appendChild(
        el("rect", {
          x: p.x,
          y: p.y,
          width: nodeW,
          height: nodeH,
          rx: 9,
          fill: n.isCritical ? "#26121b" : "#111b2a",
          stroke: isSel ? "#38bdf8" : n.isCritical ? "#fb7185" : "#2b3c54",
          "stroke-width": isSel ? 2.4 : 1.6
        })
      );
      g.appendChild(
        el(
          "text",
          { x: p.x + 10, y: p.y + 19, fill: n.isCritical ? "#fda4af" : "#e2e8f0", "font-size": 11.5, "font-weight": 700 },
          `${n.id}: ${n.title.length > 17 ? n.title.slice(0, 16) + "..." : n.title}`
        )
      );
      g.appendChild(
        el(
          "text",
          { x: p.x + 10, y: p.y + 37, fill: "#94a3b8", "font-size": 10.5 },
          `${n.effectiveDurationMin}m | Float ${n.totalFloatMin}m | W${n.weight}`
        )
      );
      svg.appendChild(g);
    }
  }

  function renderGanttChart(svg, cpm) {
    if (!svg || typeof document === "undefined") return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const nodes = cpm.nodes || [];
    const maxT = Math.max(10, cpm.projectMakespanMin);
    const W = 800;
    const rowH = 28;
    const padL = 175;
    const padR = 26;
    const padT = 24;
    const padB = 34;
    const H = Math.max(200, padT + padB + nodes.length * rowH);
    const plotW = W - padL - padR;

    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

    const xOf = (m) => padL + (m / maxT) * plotW;

    for (let i = 0; i <= 5; i++) {
      const tVal = (maxT * i) / 5;
      const xPx = xOf(tVal);
      svg.appendChild(el("line", { x1: xPx, y1: padT, x2: xPx, y2: H - padB, stroke: "#1f2a38", "stroke-width": 1 }));
      svg.appendChild(el("text", { x: xPx, y: H - padB + 16, "text-anchor": "middle", fill: "#94a3b8", "font-size": 11 }, `${Math.round(tVal)}m`));
    }

    nodes.forEach((n, idx) => {
      const y = padT + idx * rowH + 4;
      svg.appendChild(
        el("text", { x: padL - 10, y: y + 14, "text-anchor": "end", fill: "#cbd5e1", "font-size": 11 }, `${n.id} ${n.title.slice(0, 18)}`)
      );

      // Total float ghost bar [ES, LF]
      if (n.totalFloatMin > 0) {
        svg.appendChild(
          el("rect", {
            x: xOf(n.esMin),
            y: y + 4,
            width: Math.max(2, xOf(n.lfMin) - xOf(n.esMin)),
            height: 12,
            rx: 4,
            fill: "rgba(148, 163, 184, 0.18)"
          })
        );
      }

      // Active task bar [ES, EF]
      svg.appendChild(
        el("rect", {
          x: xOf(n.esMin),
          y: y + 2,
          width: Math.max(3, xOf(n.efMin) - xOf(n.esMin)),
          height: 16,
          rx: 4,
          fill: n.isCritical ? "#fb7185" : "#2dd4bf"
        })
      );
    });
  }

  return { renderDagGraph, renderGanttChart };
});
