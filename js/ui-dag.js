(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CadenceDagSvg = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const ELLIPSIS = "…";

  // Palette shared with styles.css. Tests pin the critical, edge, float,
  // worker and ghost colors, so change them together.
  const C = {
    critical: "#fb7185",
    criticalText: "#fda4af",
    float: "#2dd4bf",
    work: "#38bdf8",
    selected: "#38bdf8",
    edge: "#475569",
    grid: "#24282e",
    axis: "#a3abb6",
    text: "#eceef1",
    textSoft: "#c9ced6",
    textMuted: "#a3abb6",
    nodeFill: "#17191d",
    nodeFillCrit: "#2a171b",
    nodeStroke: "#3a3f47",
    ink: "#0e0f11",
    ghost: "rgba(148, 163, 184, 0.18)",
    idle: "rgba(148, 163, 184, 0.14)",
    lane: "rgba(148, 163, 184, 0.035)"
  };

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

  function clear(svg) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
  }

  function clip(str, max) {
    const s = String(str);
    return s.length > max ? s.slice(0, Math.max(1, max - 1)).trimEnd() + ELLIPSIS : s;
  }

  // Greedy word wrap into at most `lines` lines of `max` characters.
  function wrap(str, max, lines) {
    const words = String(str).split(/\s+/).filter(Boolean);
    const out = [];
    let cur = "";
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const next = cur ? cur + " " + w : w;
      if (next.length <= max) { cur = next; continue; }
      if (cur) out.push(cur);
      cur = w;
      if (out.length === lines - 1) {
        cur = words.slice(i).join(" ");
        break;
      }
    }
    if (cur) out.push(cur);
    return out.slice(0, lines).map((line) => clip(line, max));
  }

  const NICE_STEPS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 960, 1440];

  // Round an axis up to exactly `intervals` clean steps (5m, 10m, 30m, 1h ...).
  function niceAxis(maxVal, intervals) {
    const need = Math.max(1, maxVal) / intervals;
    let step = NICE_STEPS.find((s) => s >= need);
    if (!step) step = Math.ceil(need / 1440) * 1440;
    return { step, max: step * intervals, intervals };
  }

  // Smallest clean step that covers maxVal in at most `maxIntervals` ticks,
  // so the axis ends close to the makespan instead of far past it.
  function fitAxis(maxVal, maxIntervals) {
    const v = Math.max(1, maxVal);
    const step = NICE_STEPS.find((s) => Math.ceil(v / s) <= maxIntervals) || Math.ceil(v / maxIntervals / 1440) * 1440;
    const intervals = Math.max(1, Math.ceil(v / step));
    return { step, max: step * intervals, intervals };
  }

  // Hours only when every tick lands on a whole hour; otherwise minutes.
  function formatTick(min, step) {
    if (min === 0) return "0";
    if (step % 60 === 0) return `${min / 60}h`;
    return `${min}m`;
  }

  function measureWidth(svg, fallback) {
    let w = 0;
    try {
      // The scroll frame is the true available width; the svg itself may be
      // wider than its frame after a previous render.
      w = Number(svg.parentNode && svg.parentNode.clientWidth) || Number(svg.clientWidth) || 0;
      if (!w && typeof svg.getBoundingClientRect === "function") w = svg.getBoundingClientRect().width || 0;
    } catch (_err) {
      w = 0;
    }
    return w > 200 ? Math.round(w) : fallback;
  }

  function measureHeight(svg) {
    try {
      return Math.round(Number(svg.parentNode && svg.parentNode.clientHeight) || 0);
    } catch (_err) {
      return 0;
    }
  }

  // Orders each column by the mean row of its prerequisites so edges cross
  // less. Ties keep critical tasks first, then id order, so layout is stable.
  function orderLayers(nodes, numCols) {
    const layers = new Map();
    for (const n of nodes) {
      if (!layers.has(n.layer)) layers.set(n.layer, []);
      layers.get(n.layer).push(n);
    }
    const rowOf = new Map();
    for (let col = 0; col < numCols; col++) {
      const colNodes = layers.get(col) || [];
      const rank = (n) => {
        const rows = n.deps.map((d) => rowOf.get(d)).filter((r) => r !== undefined);
        return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.MAX_SAFE_INTEGER;
      };
      colNodes.sort((a, b) => {
        const ra = rank(a), rb = rank(b);
        if (ra !== rb) return ra - rb;
        if (a.isCritical !== b.isCritical) return a.isCritical ? -1 : 1;
        return String(a.id).localeCompare(String(b.id));
      });
      colNodes.forEach((n, row) => rowOf.set(n.id, row - (colNodes.length - 1) / 2));
    }
    return layers;
  }

  function nodeTooltipText(n) {
    return `${n.id}: ${n.title} | ES ${n.esMin}m, EF ${n.efMin}m | LS ${n.lsMin}m, LF ${n.lfMin}m | ` +
      `Total Float ${n.totalFloatMin}m | Free Float ${n.freeFloatMin}m | w/p ${n.wsptRatio.toFixed(2)} (w ${n.weight}, p ${n.effectiveDurationMin}m)`;
  }

  /**
   * view is optional: { related, shock, animate }. related is a
   * graphNeighborhood result that lights the selected task's prerequisites and
   * dependents. shock is a traceDelayShockwave result, and animate plays the
   * wave once on the render that introduced it.
   */
  function renderDagGraph(svg, cpm, selectedId, view) {
    if (!svg || typeof document === "undefined") return;
    clear(svg);

    const nodes = cpm.nodes || [];
    const numCols = Math.max(1, cpm.maxLayer + 1);
    const layers = orderLayers(nodes, numCols);
    const opts = view || {};
    const upstream = new Set(opts.related ? opts.related.upstream : []);
    const downstream = new Set(opts.related ? opts.related.downstream : []);
    const hasFocus = Boolean(opts.related && selectedId);
    const shockById = new Map(opts.shock ? opts.shock.affected.map((a) => [a.id, a]) : []);
    const relOf = (id) => {
      if (!hasFocus) return "";
      if (id === selectedId) return "selected";
      if (upstream.has(id)) return "upstream";
      if (downstream.has(id)) return "downstream";
      return "other";
    };
    const maxRows = Math.max(1, ...Array.from(layers.values()).map((a) => a.length));
    // Size nodes to the rendered width so text stays near 1:1 scale.
    const targetW = measureWidth(svg, 960);
    const padX = 22;
    const padY = 26;
    const colGap = numCols > 5 ? 34 : 44;
    const nodeH = 80;
    // Rows spread into the available frame height, within a readable range.
    const frameH = measureHeight(svg);
    const spareH = frameH - padY * 2 - maxRows * nodeH;
    const rowGap = maxRows > 1 ? Math.max(22, Math.min(64, Math.floor(spareH / (maxRows - 1)))) : 22;
    const nodeW = Math.max(132, Math.min(196, Math.floor((targetW - padX * 2 - (numCols - 1) * colGap) / numCols)));
    const titleChars = Math.max(12, Math.floor((nodeW - 22) / 6.4));

    const W = Math.max(targetW, padX * 2 + numCols * nodeW + (numCols - 1) * colGap);
    const H = Math.max(220, measureHeight(svg), padY * 2 + maxRows * nodeH + (maxRows - 1) * rowGap);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    // Drawn at 1:1 so node text stays readable; the frame scrolls on phones.
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);

    const defs = el("defs");
    const markerNorm = el("marker", { id: "arr-norm", markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: "auto" });
    markerNorm.appendChild(el("path", { d: "M0,1 L7,4 L0,7 Z", fill: C.edge }));
    const markerCrit = el("marker", { id: "arr-crit", markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: "auto" });
    markerCrit.appendChild(el("path", { d: "M0,1 L7,4 L0,7 Z", fill: C.critical }));
    defs.appendChild(markerNorm);
    defs.appendChild(markerCrit);
    svg.appendChild(defs);

    // Center the graph horizontally when it is narrower than the canvas.
    const graphW = numCols * nodeW + (numCols - 1) * colGap;
    const offsetX = Math.max(padX, (W - graphW) / 2);

    const pos = new Map();
    for (let col = 0; col < numCols; col++) {
      const colNodes = layers.get(col) || [];
      const colH = colNodes.length * nodeH + Math.max(0, colNodes.length - 1) * rowGap;
      const startY = (H - colH) / 2;
      colNodes.forEach((n, rowIdx) => {
        pos.set(n.id, {
          x: offsetX + col * (nodeW + colGap),
          y: startY + rowIdx * (nodeH + rowGap)
        });
      });
    }

    // Draw edges, non-critical first so critical edges sit on top.
    const edges = [];
    for (const n of nodes) {
      const dst = pos.get(n.id);
      for (const depId of n.deps) {
        const src = pos.get(depId);
        const srcNode = cpm.nodeMap.get(depId);
        if (!src || !dst) continue;
        const critEdge = Boolean(n.isCritical && srcNode && srcNode.isCritical && Math.abs(srcNode.efMin - n.esMin) < 1e-6);
        let rel = "";
        if (hasFocus) {
          if ((n.id === selectedId || upstream.has(n.id)) && upstream.has(depId)) rel = "upstream";
          else if ((depId === selectedId || downstream.has(depId)) && downstream.has(n.id)) rel = "downstream";
          else rel = "other";
        }
        const from = shockById.get(depId);
        const to = shockById.get(n.id);
        const wave = from && to && from.shiftMin > 0 && to.shiftMin > 0 ? from.hop : -1;
        edges.push({ src, dst, critEdge, rel, wave });
      }
    }
    edges.sort((a, b) => Number(a.critEdge) - Number(b.critEdge));
    for (const { src, dst, critEdge, rel, wave } of edges) {
      const x1 = src.x + nodeW;
      const y1 = src.y + nodeH / 2;
      const x2 = dst.x - 2;
      const y2 = dst.y + nodeH / 2;
      const bend = Math.max(18, (x2 - x1) * 0.5);
      const attrs = {
        class: "dag-edge",
        d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`,
        fill: "none",
        stroke: critEdge ? C.critical : C.edge,
        "stroke-width": critEdge ? 2.2 : 1.4,
        "stroke-opacity": critEdge ? 1 : 0.85,
        "marker-end": critEdge ? "url(#arr-crit)" : "url(#arr-norm)"
      };
      if (rel) attrs["data-rel"] = rel;
      if (wave >= 0) {
        attrs["data-wave"] = "1";
        attrs["data-hop"] = Math.min(wave, 8);
        if (opts.animate) attrs["data-animate"] = "1";
      }
      svg.appendChild(el("path", attrs));
    }

    // Draw nodes as instrument cards.
    for (const n of nodes) {
      const p = pos.get(n.id);
      const isSel = n.id === selectedId;
      const shock = shockById.get(n.id);
      const rel = relOf(n.id);
      const nodeAttrs = {
        class: "dag-node",
        "data-id": n.id,
        tabindex: "0",
        role: "button",
        "aria-label": `Inspect ${n.id}: ${n.title}`
      };
      if (rel) nodeAttrs["data-rel"] = rel;
      if (shock) {
        nodeAttrs["data-shock"] = shock.shiftMin > 0 ? "push" : "absorb";
        nodeAttrs["data-hop"] = Math.min(shock.hop, 8);
        if (opts.animate) nodeAttrs["data-animate"] = "1";
      }
      const g = el("g", nodeAttrs);
      g.appendChild(el("title", null, nodeTooltipText(n)));
      g.appendChild(
        el("rect", {
          x: p.x,
          y: p.y,
          width: nodeW,
          height: nodeH,
          rx: 10,
          fill: n.isCritical ? C.nodeFillCrit : C.nodeFill,
          stroke: isSel ? C.selected : n.isCritical ? C.critical : C.nodeStroke,
          "stroke-width": isSel ? 2.4 : 1.4
        })
      );
      // Left accent rail: rose for critical, teal for float.
      g.appendChild(el("rect", {
        x: p.x + 1, y: p.y + 10, width: 3, height: nodeH - 20, rx: 1.5,
        fill: n.isCritical ? C.critical : C.float, opacity: n.isCritical ? 0.95 : 0.7
      }));
      if (isSel) {
        g.appendChild(el("rect", {
          x: p.x - 4, y: p.y - 4, width: nodeW + 8, height: nodeH + 8, rx: 13,
          fill: "none", stroke: C.selected, "stroke-opacity": 0.28, "stroke-width": 4
        }));
      }
      g.appendChild(el("text", {
        x: p.x + 13, y: p.y + 19, fill: n.isCritical ? C.criticalText : C.text,
        "font-size": 11.5, "font-weight": 700, class: "svg-mono"
      }, n.id));
      const pushed = shock && shock.shiftMin > 0;
      const tag = shock
        ? (pushed ? `+${shock.shiftMin}m` : "absorbed")
        : (n.isCritical ? "0m float" : `${n.totalFloatMin}m float`);
      g.appendChild(el("text", {
        x: p.x + nodeW - 11, y: p.y + 19, "text-anchor": "end",
        fill: pushed || (!shock && n.isCritical) ? C.criticalText : C.float,
        "font-size": 10.5, "font-weight": pushed ? 750 : 600, class: "svg-mono"
      }, tag));
      const lines = wrap(n.title, titleChars, 2);
      lines.forEach((line, i) => {
        g.appendChild(el("text", {
          x: p.x + 13, y: p.y + 37 + i * 14, fill: C.text, "font-size": 11.5, "font-weight": 560
        }, line));
      });
      g.appendChild(el("text", {
        x: p.x + 13, y: p.y + nodeH - 11, fill: C.textMuted, "font-size": 10, class: "svg-mono"
      }, `${n.effectiveDurationMin}m  w${n.weight}  ES ${n.esMin}`));
      svg.appendChild(g);
    }

    // One expanding ring per affected task, staggered by graph distance.
    if (opts.animate && opts.shock) {
      const rings = el("g", { class: "shock-layer", "aria-hidden": "true" });
      for (const a of opts.shock.affected) {
        const p = pos.get(a.id);
        if (!p) continue;
        rings.appendChild(el("circle", {
          class: "shock-ring",
          cx: p.x + nodeW / 2, cy: p.y + nodeH / 2, r: 46,
          fill: "none",
          stroke: a.shiftMin > 0 ? C.critical : C.float,
          "stroke-width": 2,
          "data-hop": Math.min(a.hop, 8)
        }));
      }
      svg.appendChild(rings);
    }
  }

  function renderGanttChart(svg, cpm) {
    if (!svg || typeof document === "undefined") return;
    clear(svg);

    const nodes = cpm.nodes || [];
    const makespan = Math.max(1, cpm.projectMakespanMin);
    const axis = niceAxis(Math.max(10, makespan), 5);
    const maxT = axis.max;
    const W = 800;
    const rowH = 28;
    const padL = 222;
    const padR = 30;
    const padT = 30;
    const padB = 30;
    const H = Math.max(200, padT + padB + nodes.length * rowH);
    const plotW = W - padL - padR;

    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

    const xOf = (m) => padL + (m / maxT) * plotW;

    // Row bands live in a nested group so the top level holds only data marks.
    const bands = el("g", { class: "gantt-bands" });
    nodes.forEach((n, idx) => {
      if (idx % 2 === 0) {
        bands.appendChild(el("rect", { x: 12, y: padT + idx * rowH, width: W - 24, height: rowH, rx: 6, fill: C.lane }));
      }
    });
    svg.appendChild(bands);

    for (let i = 0; i <= 5; i++) {
      const tVal = axis.step * i;
      const xPx = xOf(tVal);
      svg.appendChild(el("line", { x1: xPx, y1: padT - 6, x2: xPx, y2: H - padB, stroke: C.grid, "stroke-width": 1 }));
      svg.appendChild(el("text", { x: xPx, y: H - padB + 17, "text-anchor": "middle", fill: C.axis, "font-size": 10.5, class: "svg-mono" }, formatTick(tVal, axis.step)));
    }

    // Project finish marker.
    const fx = xOf(makespan);
    svg.appendChild(el("path", { d: `M${fx},${padT - 8} L${fx},${H - padB}`, stroke: C.critical, "stroke-width": 1.2, "stroke-dasharray": "3 4", fill: "none", opacity: 0.8 }));
    svg.appendChild(el("text", { x: fx, y: padT - 13, "text-anchor": fx > W - 70 ? "end" : "middle", fill: C.criticalText, "font-size": 10.5, "font-weight": 600, class: "svg-mono" }, `finish ${makespan}m`));

    nodes.forEach((n, idx) => {
      const y = padT + idx * rowH;
      const cy = y + rowH / 2;
      svg.appendChild(el("text", { x: 24, y: cy + 4, fill: n.isCritical ? C.criticalText : C.text, "font-size": 11, "font-weight": 700, class: "svg-mono" }, n.id));
      svg.appendChild(el("text", { x: 58, y: cy + 4, fill: C.textSoft, "font-size": 11 }, clip(n.title, 26)));

      // Total float ghost bar [ES, LF]
      if (n.totalFloatMin > 0) {
        const ghost = el("rect", {
          x: xOf(n.esMin),
          y: cy - 6,
          width: Math.max(2, xOf(n.lfMin) - xOf(n.esMin)),
          height: 12,
          rx: 4,
          fill: C.ghost
        });
        ghost.appendChild(el("title", null, nodeTooltipText(n)));
        svg.appendChild(ghost);
      }

      // Active task bar [ES, EF]
      const barW = Math.max(3, xOf(n.efMin) - xOf(n.esMin));
      const bar = el("rect", {
        x: xOf(n.esMin),
        y: cy - 7,
        width: barW,
        height: 14,
        rx: 4,
        fill: n.isCritical ? C.critical : C.float
      });
      bar.appendChild(el("title", null, nodeTooltipText(n)));
      svg.appendChild(bar);
      if (barW >= 34) {
        svg.appendChild(el("text", {
          x: xOf(n.esMin) + 6, y: cy + 3.5, fill: C.ink, "font-size": 9.5, "font-weight": 700, class: "svg-mono", "pointer-events": "none"
        }, `${n.effectiveDurationMin}m`));
      }
      if (n.totalFloatMin > 0 && xOf(n.lfMin) - xOf(n.efMin) >= 44) {
        svg.appendChild(el("text", {
          x: xOf(n.lfMin) - 5, y: cy + 3.5, "text-anchor": "end", fill: C.textMuted, "font-size": 9.5, class: "svg-mono", "pointer-events": "none"
        }, `+${n.totalFloatMin}m`));
      }
    });
  }

  /**
   * Parallel worker swimlane Gantt. Each worker gets one horizontal lane with
   * assigned task bars and shaded idle gaps from lane start to makespan.
   */
  function renderWorkerSwimlanes(svg, multi) {
    if (!svg || typeof document === "undefined" || !multi) return;
    clear(svg);

    const ledger = multi.ledger || [];
    const makespan = Math.max(1, multi.makespanMin);
    const axis = fitAxis(makespan, 6);
    const W = 800;
    const rowH = 40;
    const padL = 64;
    const padR = 30;
    const padT = 30;
    const padB = 30;
    const H = Math.max(140, padT + padB + ledger.length * rowH);
    const plotW = W - padL - padR;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const xOf = (m) => padL + (m / axis.max) * plotW;
    const nodeMap = multi.cpm && multi.cpm.nodeMap;
    const isCrit = (id) => Boolean(nodeMap && nodeMap.get(id) && nodeMap.get(id).isCritical);

    const lanes = el("g", { class: "swim-lanes" });
    ledger.forEach((_w, row) => {
      lanes.appendChild(el("rect", { x: padL - 4, y: padT + row * rowH + 5, width: plotW + 8, height: rowH - 10, rx: 7, fill: C.lane }));
    });
    svg.appendChild(lanes);

    for (let i = 0; i <= axis.intervals; i++) {
      const tVal = axis.step * i;
      const xPx = xOf(tVal);
      svg.appendChild(el("line", { x1: xPx, y1: padT - 4, x2: xPx, y2: H - padB, stroke: C.grid, "stroke-width": 1 }));
      svg.appendChild(el("text", { x: xPx, y: H - padB + 17, "text-anchor": "middle", fill: C.axis, "font-size": 10.5, class: "svg-mono" }, formatTick(tVal, axis.step)));
    }

    const fx = xOf(makespan);
    svg.appendChild(el("path", { d: `M${fx},${padT - 6} L${fx},${H - padB}`, stroke: C.critical, "stroke-width": 1.2, "stroke-dasharray": "3 4", fill: "none", opacity: 0.8 }));
    svg.appendChild(el("text", { x: fx, y: padT - 11, "text-anchor": fx > W - 70 ? "end" : "middle", fill: C.criticalText, "font-size": 10.5, "font-weight": 600, class: "svg-mono" }, `finish ${multi.makespanMin}m`));

    const idleRect = (worker, from, to, y) => {
      const idle = el("rect", {
        x: xOf(from), y: y + 3,
        width: Math.max(1, xOf(to) - xOf(from)),
        height: 16, rx: 3, fill: C.idle
      });
      idle.appendChild(el("title", null, `W${worker} idle ${from}m to ${to}m (${to - from}m)`));
      svg.appendChild(idle);
    };

    ledger.forEach((w, row) => {
      const y = padT + row * rowH + 9;
      svg.appendChild(el("text", { x: padL - 14, y: y + 15, "text-anchor": "end", fill: C.text, "font-size": 11, "font-weight": 700, class: "svg-mono" }, `W${w.worker}`));

      // Shade idle gaps between the worker's tasks (plus the trailing gap).
      let cursor = 0;
      for (const t of w.tasks) {
        if (t.startMin > cursor) idleRect(w.worker, cursor, t.startMin, y);
        const barW = Math.max(3, xOf(t.endMin) - xOf(t.startMin));
        const bar = el("rect", {
          x: xOf(t.startMin), y: y + 1,
          width: barW,
          height: 20, rx: 5, fill: isCrit(t.id) ? C.critical : C.work
        });
        bar.appendChild(el("title", null, `W${w.worker}: ${t.id} ${t.title} [${t.startMin}, ${t.endMin}]m (${t.durationMin}m)`));
        svg.appendChild(bar);
        if (barW >= 26) {
          svg.appendChild(el("text", {
            x: xOf(t.startMin) + 6, y: y + 15, fill: C.ink, "font-size": 10, "font-weight": 700, class: "svg-mono", "pointer-events": "none"
          }, barW >= 70 ? `${t.id} ${t.durationMin}m` : t.id));
        }
        cursor = t.endMin;
      }
      if (cursor < makespan) idleRect(w.worker, cursor, makespan, y);
    });
  }

  return { renderDagGraph, renderGanttChart, renderWorkerSwimlanes };
});
