const test = require("node:test");
const assert = require("node:assert/strict");
const Engine = require("../js/dag-engine.js");
const Svg = require("../js/ui-dag.js");

function makeSvgNode(tag, attrs) {
  return {
    tagName: tag.toUpperCase(),
    attributes: Object.assign({}, attrs || {}),
    children: [],
    textContent: "",
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    get firstChild() { return this.children[0] || null; }
  };
}

function withFakeDocument(fn) {
  const prevDoc = global.document;
  global.document = {
    createElementNS(_ns, tag) { return makeSvgNode(tag); }
  };
  try {
    return fn();
  } finally {
    if (prevDoc === undefined) delete global.document;
    else global.document = prevDoc;
  }
}

test("renderDagGraph clears previous children, sets viewBox, draws markers, edges, and selected stroke", () => {
  withFakeDocument(() => {
    const cpm = Engine.analyzeCriticalPath(Engine.PRESET_WORKFLOWS[0].tasks);
    const svg = makeSvgNode("svg");
    svg.appendChild(makeSvgNode("rect", { id: "stale" }));

    Svg.renderDagGraph(svg, cpm, "T2");
    assert.equal(svg.children.some((c) => c.attributes.id === "stale"), false);
    assert.ok(svg.attributes.viewBox && svg.attributes.viewBox.startsWith("0 0 "));
    assert.equal(svg.children[0].tagName, "DEFS");
    assert.equal(svg.children[0].children.length, 2);

    const edgePaths = svg.children.filter((c) => c.tagName === "PATH");
    const expectedEdgeCount = cpm.nodes.reduce((sum, n) => sum + n.deps.length, 0);
    assert.equal(edgePaths.length, expectedEdgeCount);
    assert.ok(edgePaths.some((p) => p.attributes.stroke === "#fb7185"));
    assert.ok(edgePaths.some((p) => p.attributes.stroke === "#475569"));

    const nodeGroups = svg.children.filter((c) => c.tagName === "G" && c.attributes.class === "dag-node");
    assert.equal(nodeGroups.length, cpm.nodes.length);
    const selectedGroup = nodeGroups.find((g) => g.attributes["data-id"] === "T2");
    assert.equal(selectedGroup.children[0].attributes.stroke, "#38bdf8");
    assert.equal(selectedGroup.children[0].attributes["stroke-width"], "2.4");
  });
});

test("renderGanttChart renders axis ticks, float ghost bars for slack tasks, and solid bars", () => {
  withFakeDocument(() => {
    const diamond = [
      { id: "A", title: "Root", durationMin: 20, weight: 8, deps: [] },
      { id: "B", title: "Critical", durationMin: 50, weight: 9, deps: ["A"] },
      { id: "C", title: "Slack", durationMin: 15, weight: 6, deps: ["A"] },
      { id: "D", title: "End", durationMin: 10, weight: 10, deps: ["B", "C"] }
    ];
    const cpm = Engine.analyzeCriticalPath(diamond);
    const svg = makeSvgNode("svg");
    Svg.renderGanttChart(svg, cpm);

    assert.ok(svg.attributes.viewBox && svg.attributes.viewBox.startsWith("0 0 800 "));
    const lines = svg.children.filter((c) => c.tagName === "LINE");
    assert.equal(lines.length, 6);

    const rects = svg.children.filter((c) => c.tagName === "RECT");
    // 4 active bars + 1 float ghost bar for node C
    assert.equal(rects.length, 5);
    assert.ok(rects.some((r) => r.attributes.fill === "rgba(148, 163, 184, 0.18)"));
    assert.ok(rects.some((r) => r.attributes.fill === "#fb7185"));
    assert.ok(rects.some((r) => r.attributes.fill === "#2dd4bf"));
  });
});
