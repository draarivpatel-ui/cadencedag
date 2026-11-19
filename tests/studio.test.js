"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Engine = require("../js/dag-engine.js");
const Svg = require("../js/ui-dag.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const html = read("index.html");
const css = read("styles.css");
const appJs = read("js/app.js");
const uiJs = read("js/ui-dag.js");

const AP = Engine.PRESET_WORKFLOWS.find((w) => w.id === "ap-robotics-week").tasks;
const makespan = (tasks, slip) => Engine.analyzeCriticalPath(tasks, slip).projectMakespanMin;
const b64 = (text) => Buffer.from(text, "utf8").toString("base64url");
const SETTINGS = ["wspt", 25, 5, 300, 3];
const linkFor = (payload) => `#plan=1.${b64(JSON.stringify(payload))}`;
const goodRow = (id, deps = []) => [id, `Task ${id}`, 30, 5, "General", deps];

/* ----------------------------- crash advisor ---------------------------- */

test("Advisor: every suggestion's predicted saving equals a full re-solve, on every preset", () => {
  for (const wf of Engine.PRESET_WORKFLOWS) {
    const advice = Engine.adviseCrash(wf.tasks);
    assert.ok(advice.moves.length > 0, wf.id);
    for (const move of advice.moves) {
      const applied = Engine.applyCrashMove(wf.tasks, move).tasks;
      assert.equal(makespan(applied), move.afterMin, move.moveId);
      assert.equal(move.beforeMin - move.afterMin, move.savedMin, move.moveId);
      assert.ok(move.savedMin > 0, move.moveId);
    }
  }
});

test("Advisor: predictions stay exact while a delay is active on the plan", () => {
  const slip = { taskId: "A6", slipMin: 30 };
  const advice = Engine.adviseCrash(AP, { slip });
  assert.equal(advice.baselineMin, 285);
  for (const move of advice.moves) {
    const result = Engine.applyCrashMove(AP, move);
    const activeSlip = move.kind === "split2" && move.taskId === "A6"
      ? { taskId: result.partIds[0], slipMin: 30 } : slip;
    assert.equal(makespan(result.tasks, activeSlip), move.afterMin, move.moveId);
  }
});

test("Advisor: the top suggestion matches an independent brute-force search", () => {
  for (const wf of Engine.PRESET_WORKFLOWS) {
    const advice = Engine.adviseCrash(wf.tasks);
    const base = makespan(wf.tasks);
    let bestSaved = 0;
    for (const task of wf.tasks) {
      const cuts = [10, 15, Math.max(1, Math.round(task.durationMin * 0.25))]
        .map((c) => Math.min(c, task.durationMin - 5)).filter((c) => c > 0);
      const candidates = cuts.map((c) => task.durationMin - c);
      const longHalf = Math.ceil(task.durationMin / 2) + 5;
      if (longHalf < task.durationMin) candidates.push(longHalf);
      for (const durationMin of candidates) {
        const trial = wf.tasks.map((t) => (t.id === task.id ? Object.assign({}, t, { durationMin }) : t));
        bestSaved = Math.max(bestSaved, base - makespan(trial));
      }
    }
    assert.equal(advice.best.savedMin, bestSaved, wf.id);
  }
});

test("Advisor: AP preset names A6 first, then reveals the secondary bottleneck", () => {
  const first = Engine.adviseCrash(AP);
  assert.equal(first.baselineMin, 255);
  assert.equal(first.best.moveId, "A6:split2");
  assert.equal(first.best.toMin, 40);
  assert.equal(first.best.savedMin, 30);
  assert.equal(first.best.newBottleneck, null);

  const split = Engine.applyCrashMove(AP, first.best).tasks;
  assert.equal(makespan(split), 225);
  const second = Engine.adviseCrash(split);
  const trim = second.moves.find((m) => m.moveId === "A2:trim10");
  assert.equal(trim.savedMin, 5);
  assert.equal(trim.lostToRivalMin, 5);
  assert.deepEqual(trim.newBottleneck.chain, ["A1", "A3", "A5", "A7", "A9"]);
  assert.equal(trim.newBottleneck.lengthMin, 220);
  assert.deepEqual(trim.newlyCriticalIds, ["A1", "A3", "A5", "A7"]);
});

test("Advisor: two tied chains block every single move and say why", () => {
  const tied = [
    { id: "A", durationMin: 40, weight: 5, deps: [] },
    { id: "B", durationMin: 40, weight: 5, deps: [] }
  ];
  const advice = Engine.adviseCrash(tied);
  assert.equal(advice.moves.length, 0);
  assert.equal(advice.best, null);
  assert.equal(advice.criticalPathCount, 2);
  assert.equal(advice.blockedByTiedChains, true);
});

test("Advisor: float tasks are never suggested because they cannot move the finish", () => {
  const critical = new Set(Engine.analyzeCriticalPath(AP).criticalTaskIds);
  for (const move of Engine.adviseCrash(AP).moves) assert.ok(critical.has(move.taskId), move.moveId);
});

test("Advisor: 25% trims land on whole minutes and respect the minimum duration", () => {
  const moves = Engine.adviseCrash(AP).moves;
  const a6 = moves.find((m) => m.moveId === "A6:trim25");
  assert.equal(a6.cutMin, 18);
  assert.equal(a6.toMin, 52);
  for (const move of moves) assert.ok(Number.isInteger(move.toMin), move.moveId);
  const short = [{ id: "S", durationMin: 12, weight: 5, deps: [] }];
  const options = Engine.adviseCrash(short, { minDurationMin: 5 }).moves;
  assert.ok(options.every((m) => m.toMin >= 5));
  assert.equal(options.find((m) => m.kind === "trim10").toMin, 5);
  // A 15m cut clamps to the same 7m as the 10m cut, so it is not listed twice.
  assert.equal(options.filter((m) => m.toMin === 5).length, 1);
});

test("Advisor: a split keeps prerequisites, rewires dependents and avoids id collisions", () => {
  const tasks = [
    { id: "P", durationMin: 10, weight: 4, deps: [] },
    { id: "X", durationMin: 60, weight: 8, deps: ["P"] },
    { id: "Xa", durationMin: 5, weight: 2, deps: [] },
    { id: "Z", durationMin: 10, weight: 4, deps: ["X"] }
  ];
  const move = Engine.adviseCrash(tasks).moves.find((m) => m.moveId === "X:split2");
  const { tasks: out, partIds } = Engine.applyCrashMove(tasks, move);
  assert.deepEqual(partIds, ["Xaa", "Xb"]);
  assert.equal(out.some((t) => t.id === "X"), false);
  for (const id of partIds) {
    const part = out.find((t) => t.id === id);
    assert.deepEqual(part.deps, ["P"]);
    assert.equal(part.weight, 4);
  }
  assert.deepEqual(out.find((t) => t.id === "Z").deps, partIds);
  // Work is conserved apart from the stated 5m handoff on each half.
  const sum = (list) => list.reduce((s, t) => s + t.durationMin, 0);
  assert.equal(sum(out), sum(tasks) + 10);
  assert.doesNotThrow(() => Engine.validateAndTopoSort(out));
});

test("Advisor: applying a move never mutates the input plan", () => {
  const before = JSON.stringify(AP);
  Engine.applyCrashMove(AP, Engine.adviseCrash(AP).best);
  assert.equal(JSON.stringify(AP), before);
  assert.throws(() => Engine.applyCrashMove(AP, { taskId: "NOPE", kind: "trim10", toMin: 1 }), /not in this plan/);
});

/* --------------------------- graph and shockwave ------------------------- */

test("Graph: upstream and downstream sets are transitive and topologically ordered", () => {
  const near = Engine.graphNeighborhood(AP, "A7");
  assert.deepEqual(near.upstream, ["A1", "A3", "A5"]);
  assert.deepEqual(near.downstream, ["A9"]);
  assert.deepEqual(near.directUpstream, ["A3", "A5"]);
  const root = Engine.graphNeighborhood(AP, "A2");
  assert.deepEqual(root.upstream, []);
  assert.deepEqual(root.downstream, ["A4", "A6", "A8", "A9"]);
});

test("Graph: an unknown id returns empty sets instead of throwing", () => {
  const near = Engine.graphNeighborhood(AP, "__proto__");
  assert.deepEqual([near.upstream, near.downstream], [[], []]);
});

test("Shockwave: a critical delay reaches the finish hop by hop", () => {
  const wave = Engine.traceDelayShockwave(AP, "A6", 30);
  assert.equal(wave.beforeMin, 255);
  assert.equal(wave.afterMin, 285);
  assert.equal(wave.finishShiftMin, 30);
  assert.equal(wave.absorbedMin, 0);
  assert.deepEqual(wave.affected.map((a) => [a.id, a.hop, a.shiftMin]), [["A6", 0, 30], ["A8", 1, 30], ["A9", 2, 30]]);
});

test("Shockwave: float absorbs a delay before it reaches the finish", () => {
  const wave = Engine.traceDelayShockwave(AP, "A5", 30);
  assert.equal(wave.finishShiftMin, 0);
  assert.equal(wave.absorbedMin, 30);
  assert.equal(wave.affected.find((a) => a.id === "A9").shiftMin, 0);
  const over = Engine.traceDelayShockwave(AP, "A5", 40);
  assert.equal(over.finishShiftMin, 5);
  assert.equal(over.absorbedMin, 35);
});

/* ------------------------------- history -------------------------------- */

test("History: undo and redo walk snapshots in order", () => {
  const h = Engine.createHistory();
  assert.equal(h.canUndo(), false);
  assert.equal(h.undo({ v: 1 }), null);
  h.commit({ v: 1 }, { v: 2 }, "first");
  h.commit({ v: 2 }, { v: 3 }, "second");
  assert.equal(h.undoLabel(), "second");
  const back = h.undo({ v: 3 });
  assert.deepEqual(back, { snapshot: { v: 2 }, label: "second" });
  assert.equal(h.redoLabel(), "second");
  assert.deepEqual(h.redo({ v: 2 }).snapshot, { v: 3 });
  assert.deepEqual(h.depth(), { undo: 2, redo: 0 });
});

test("History: identical snapshots record nothing and a new edit clears redo", () => {
  const h = Engine.createHistory();
  assert.equal(h.commit({ v: 1 }, { v: 1 }, "noop"), false);
  assert.equal(h.canUndo(), false);
  h.commit({ v: 1 }, { v: 2 }, "a");
  h.undo({ v: 2 });
  assert.equal(h.canRedo(), true);
  h.commit({ v: 1 }, { v: 9 }, "b");
  assert.equal(h.canRedo(), false);
});

test("History: snapshots are deep copies and depth is bounded", () => {
  const h = Engine.createHistory({ limit: 3 });
  const live = { tasks: [{ id: "A" }] };
  h.commit(live, { tasks: [] }, "edit");
  live.tasks[0].id = "MUTATED";
  assert.equal(h.undo({ tasks: [] }).snapshot.tasks[0].id, "A");
  const small = Engine.createHistory({ limit: 3 });
  for (let i = 0; i < 10; i++) small.commit({ v: i }, { v: i + 1 }, `e${i}`);
  assert.equal(small.depth().undo, 3);
  assert.equal(small.undo({ v: 10 }).label, "e9");
});

/* ------------------------------ share links ----------------------------- */

test("Share: every preset round-trips exactly through a link", () => {
  for (const wf of Engine.PRESET_WORKFLOWS) {
    const settings = { policy: "critical", focusBlockMin: 30, breakMin: 0, dayCapacityMin: 240, workers: 2 };
    const hash = Engine.encodePlanHash({ tasks: wf.tasks, doneTaskIds: [wf.tasks[0].id], settings });
    assert.match(hash, /^#plan=1\.[A-Za-z0-9_-]+$/);
    const out = Engine.decodePlanHash(hash);
    assert.equal(out.ok, true, wf.id);
    assert.deepEqual(out.plan.tasks, Engine.validateAndTopoSort(wf.tasks).tasks);
    assert.deepEqual(out.plan.doneTaskIds, [wf.tasks[0].id]);
    assert.deepEqual(out.plan.settings, settings);
  }
});

test("Share: non-ASCII titles and split plans survive the trip", () => {
  const tasks = [{ id: "U1", title: "Résumé für 日本語 🍊", durationMin: 25, weight: 4.5, category: "AP Prep", deps: [] }];
  const out = Engine.decodePlanHash(Engine.encodePlanHash({ tasks }));
  assert.equal(out.ok, true);
  assert.equal(out.plan.tasks[0].title, tasks[0].title);
  assert.equal(out.plan.tasks[0].weight, 4.5);
  const split = Engine.applyCrashMove(AP, Engine.adviseCrash(AP).best).tasks;
  assert.equal(Engine.decodePlanHash(Engine.encodePlanHash({ tasks: split })).ok, true);
});

test("Share: encoding strips markup from titles and refuses unsafe ids", () => {
  const dirty = [{ id: "A", title: "<img src=x onerror=alert(1)>Study", durationMin: 10, weight: 5, deps: [] }];
  const out = Engine.decodePlanHash(Engine.encodePlanHash({ tasks: dirty }));
  assert.equal(out.plan.tasks[0].title, "img src=x onerror=alert(1)Study");
  assert.throws(() => Engine.encodePlanHash({ tasks: [{ id: "Z<b>", durationMin: 10, weight: 5, deps: [] }] }), /cannot be shared/);
  assert.throws(() => Engine.encodePlanHash({ tasks: [{ id: "constructor", durationMin: 10, weight: 5, deps: [] }] }), /cannot be shared/);
});

const HOSTILE_LINKS = {
  "empty string": "",
  "wrong prefix": "#notplan=1.AAAA",
  "unknown version": "#plan=2.AAAA",
  "script in fragment": "#plan=1.<script>alert(1)</script>",
  "percent escapes": "#plan=1.%3Cscript%3E",
  "impossible base64 length": "#plan=1.A",
  "non-canonical padding bits": "#plan=1.WzFd_",
  "invalid utf-8": `#plan=1.${Buffer.from([0xff, 0xfe, 0xfd]).toString("base64url")}`,
  "not json": `#plan=1.${b64("{nope")}`,
  "json object instead of array": linkFor({ __proto__: { polluted: true } }),
  "wrong version inside": linkFor([2, [goodRow("A")], [], SETTINGS]),
  "extra top-level field": linkFor([1, [goodRow("A")], [], SETTINGS, "extra"]),
  "no tasks": linkFor([1, [], [], SETTINGS]),
  "__proto__ id": linkFor([1, [goodRow("__proto__")], [], SETTINGS]),
  "constructor id": linkFor([1, [goodRow("constructor")], [], SETTINGS]),
  "prototype id any case": linkFor([1, [goodRow("ProtoType")], [], SETTINGS]),
  "markup in id": linkFor([1, [goodRow("<svg>")], [], SETTINGS]),
  "duplicate id": linkFor([1, [goodRow("A"), goodRow("A")], [], SETTINGS]),
  "row with extra key field": linkFor([1, [[...goodRow("A"), "x"]], [], SETTINGS]),
  "object row": linkFor([1, [{ id: "A" }], [], SETTINGS]),
  "script title": linkFor([1, [["A", "<script>alert(1)</script>", 30, 5, "General", []]], [], SETTINGS]),
  "img onerror title": linkFor([1, [["A", "<img src=x onerror=alert(1)>", 30, 5, "General", []]], [], SETTINGS]),
  "control character title": linkFor([1, [["A", "bad\u0007title", 30, 5, "General", []]], [], SETTINGS]),
  "bidi override title": linkFor([1, [["A", "abc‮def", 30, 5, "General", []]], [], SETTINGS]),
  "oversized title": linkFor([1, [["A", "x".repeat(121), 30, 5, "General", []]], [], SETTINGS]),
  "empty title": linkFor([1, [["A", "", 30, 5, "General", []]], [], SETTINGS]),
  "string duration": linkFor([1, [["A", "T", "30", 5, "General", []]], [], SETTINGS]),
  "negative duration": linkFor([1, [["A", "T", -5, 5, "General", []]], [], SETTINGS]),
  "huge duration": linkFor([1, [["A", "T", 1e9, 5, "General", []]], [], SETTINGS]),
  "null weight": linkFor([1, [["A", "T", 30, null, "General", []]], [], SETTINGS]),
  "markup category": linkFor([1, [["A", "T", 30, 5, "<b>x</b>", []]], [], SETTINGS]),
  "dependency out of range": linkFor([1, [goodRow("A", [4])], [], SETTINGS]),
  "fractional dependency": linkFor([1, [goodRow("A"), goodRow("B", [0.5])], [], SETTINGS]),
  "string dependency": linkFor([1, [goodRow("A"), goodRow("B", ["A"])], [], SETTINGS]),
  "repeated dependency": linkFor([1, [goodRow("A"), goodRow("B", [0, 0])], [], SETTINGS]),
  "self dependency": linkFor([1, [goodRow("A", [0])], [], SETTINGS]),
  "dependency cycle": linkFor([1, [goodRow("A", [1]), goodRow("B", [0])], [], SETTINGS]),
  "done index out of range": linkFor([1, [goodRow("A")], [3], SETTINGS]),
  "repeated done index": linkFor([1, [goodRow("A")], [0, 0], SETTINGS]),
  "unknown policy": linkFor([1, [goodRow("A")], [], ["evil", 25, 5, 300, 3]]),
  "settings out of range": linkFor([1, [goodRow("A")], [], ["wspt", 25, 5, 300, 999]]),
  "settings wrong length": linkFor([1, [goodRow("A")], [], ["wspt", 25]]),
  "too many tasks": linkFor([1, Array.from({ length: 61 }, (_, i) => goodRow(`T${i}`)), [], SETTINGS]),
  "oversized link": `#plan=1.${"A".repeat(16001)}`
};

for (const [name, link] of Object.entries(HOSTILE_LINKS)) {
  test(`Share: rejects hostile link (${name})`, () => {
    const out = Engine.decodePlanHash(link);
    assert.equal(out.ok, false);
    assert.equal(typeof out.error, "string");
    assert.equal(out.plan, undefined);
  });
}

test("Share: non-string input and deterministic fuzz never throw or pass", () => {
  for (const value of [null, undefined, 7, {}, [], true]) assert.equal(Engine.decodePlanHash(value).ok, false);
  let seed = 20261121;
  const next = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (let i = 0; i < 2000; i++) {
    let body = "";
    const len = 1 + next(80);
    for (let c = 0; c < len; c++) body += alphabet[next(alphabet.length)];
    assert.equal(Engine.decodePlanHash(`#plan=1.${body}`).ok, false);
  }
});

test("Share: decoded tasks carry only allowlisted keys and never touch Object.prototype", () => {
  const smuggled = linkFor([1, [goodRow("A")], [], SETTINGS]).replace("#plan=1.", "");
  const out = Engine.decodePlanHash(`plan=1.${smuggled}`);
  assert.equal(out.ok, true);
  assert.deepEqual(Object.keys(out.plan.tasks[0]).sort(), ["category", "deps", "durationMin", "id", "title", "weight"]);
  assert.deepEqual(Object.keys(out.plan).sort(), ["doneTaskIds", "settings", "tasks"]);
  Engine.decodePlanHash(linkFor({ __proto__: { polluted: true }, constructor: { prototype: { polluted: true } } }));
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

/* --------------------------- renderer view states ------------------------ */

function fakeSvgNode(tag) {
  return {
    tagName: tag.toUpperCase(), attributes: {}, children: [], textContent: "",
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    get firstChild() { return this.children[0] || null; }
  };
}

function renderDag(selected, view) {
  const prev = global.document;
  global.document = { createElementNS: (_ns, tag) => fakeSvgNode(tag) };
  try {
    const svg = fakeSvgNode("svg");
    Svg.renderDagGraph(svg, Engine.analyzeCriticalPath(AP, view && view.slip), selected, view);
    return svg;
  } finally {
    if (prev === undefined) delete global.document; else global.document = prev;
  }
}
const nodeById = (svg, id) => svg.children.find((c) => c.attributes["data-id"] === id);

test("Renderer: a clicked node lights its prerequisites and dependents", () => {
  const svg = renderDag("A6", { related: Engine.graphNeighborhood(AP, "A6") });
  assert.equal(nodeById(svg, "A6").attributes["data-rel"], "selected");
  assert.equal(nodeById(svg, "A2").attributes["data-rel"], "upstream");
  assert.equal(nodeById(svg, "A9").attributes["data-rel"], "downstream");
  assert.equal(nodeById(svg, "A1").attributes["data-rel"], "other");
  assert.equal(nodeById(svg, "A6").attributes.class, "dag-node");
});

test("Renderer: the first paint has no relation highlights", () => {
  const svg = renderDag("A1", {});
  assert.equal(svg.children.some((c) => c.attributes["data-rel"]), false);
});

test("Renderer: a shockwave tags pushed and absorbed tasks and rings only when animating", () => {
  const shock = Engine.traceDelayShockwave(AP, "A5", 30);
  const still = renderDag("A5", { shock, slip: { taskId: "A5", slipMin: 30 } });
  assert.equal(nodeById(still, "A7").attributes["data-shock"], "push");
  assert.equal(nodeById(still, "A9").attributes["data-shock"], "absorb");
  assert.equal(nodeById(still, "A7").attributes["data-hop"], "1");
  assert.equal(still.children.some((c) => c.attributes.class === "shock-layer"), false);
  const moving = renderDag("A5", { shock, animate: true, slip: { taskId: "A5", slipMin: 30 } });
  const rings = moving.children.find((c) => c.attributes.class === "shock-layer");
  assert.equal(rings.children.length, shock.affected.length);
});

/* --------------------------- controller harness -------------------------- */

function makeEl(tag, id = "") {
  const listeners = {};
  const element = {
    tagName: tag.toUpperCase(), id, value: "", textContent: "", _innerHTML: "", style: {}, disabled: false, hidden: false,
    get className() { return this.attributes.class || ""; },
    set className(v) { this.attributes.class = String(v); },
    children: [], options: [], attributes: {},
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) { this._innerHTML = String(v); if (v === "") this.children = []; },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, f) { if (f === undefined ? !this._set.has(c) : f) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); }
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    dispatchEvent(ev) { for (const fn of listeners[ev.type] || []) fn(ev); },
    click() { this.dispatchEvent({ type: "click", target: element }); },
    appendChild(child) { this.children.push(child); if (this.tagName === "SELECT" && child.tagName === "OPTION") this.options.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); },
    get firstChild() { return this.children[0] || null; },
    closest() { return null; },
    focus() {},
    querySelector() { return null; }
  };
  return element;
}

function allText(el) {
  return [el.textContent || "", ...(el.children || []).map(allText)].join(" ");
}

function harness() {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const byId = new Map();
  for (const id of ids) {
    const tag = id.includes("select") ? "select" : id.includes("body") ? "tbody" : "div";
    const element = makeEl(tag, id);
    const valueMatch = html.match(new RegExp(`<[^>]*id="${id}"[^>]*\\bvalue="([^"]*)"`));
    if (valueMatch) element.value = valueMatch[1];
    byId.set(id, element);
  }
  byId.get("policy-select").value = "wspt";
  const storage = { data: {}, getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = v; } };
  const docListeners = [];
  const openMenus = [];
  const doc = {
    body: makeEl("body"),
    defaultView: { setInterval: () => 11, clearInterval: () => {} },
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => makeEl(tag),
    createElementNS: (_ns, tag) => makeEl(tag),
    querySelectorAll: (sel) => (sel === "details.menu[open]" ? openMenus : []),
    addEventListener(type, fn, capture) { docListeners.push({ type, fn, capture: Boolean(capture) }); }
  };
  const fireDoc = (type, ev, capture) => docListeners
    .filter((l) => l.type === type && l.capture === Boolean(capture))
    .forEach((l) => l.fn(ev));
  const svgCtx = { document: doc, Math, Number, Object, String, Array };
  svgCtx.globalThis = svgCtx;
  vm.runInNewContext(uiJs, svgCtx);
  const sandbox = {
    document: doc, Math, Number, Object, String, Array, Date, JSON, URL, Blob: function () {},
    localStorage: storage, CadenceDagEngine: Engine, CadenceDagSvg: svgCtx.CadenceDagSvg
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(appJs, sandbox);
  const ctrl = sandbox.CadenceDagApp.createController(doc);
  ctrl.init();
  ctrl.applyPreset("ap-robotics-week");
  return { byId, ctrl, storage, fireDoc, openMenus, finish: () => byId.get("kpi-makespan").textContent };
}

const key = (k, extra = {}) => {
  const ev = { key: k, target: makeEl("body"), prevented: false, preventDefault() { this.prevented = true; } };
  return Object.assign(ev, extra);
};

/* ------------------------- controller integration ------------------------ */

test("Studio: Apply Crash updates the plan, then undo and redo restore it exactly", () => {
  const { ctrl, finish, byId } = harness();
  const before = JSON.stringify(ctrl.state.tasks);
  assert.equal(finish(), "255 min");
  assert.equal(ctrl.applyCrash("A6:split2"), true);
  assert.equal(finish(), "225 min");
  assert.ok(ctrl.state.tasks.some((t) => t.id === "A6a"));
  assert.equal(byId.get("btn-undo").disabled, false);
  assert.equal(ctrl.undo(), true);
  assert.equal(finish(), "255 min");
  assert.equal(JSON.stringify(ctrl.state.tasks), before);
  assert.equal(byId.get("btn-redo").disabled, false);
  assert.equal(ctrl.redo(), true);
  assert.equal(finish(), "225 min");
});

test("Studio: a stale crash move is refused and records no undo step", () => {
  const { ctrl, finish } = harness();
  ctrl.applyCrash("A6:split2");
  ctrl.undo();
  ctrl.redo();
  assert.equal(ctrl.applyCrash("A6:split2"), false);
  assert.equal(finish(), "225 min");
});

test("Studio: the advisor shows the new bottleneck as text after the first crash", () => {
  const { ctrl, byId } = harness();
  ctrl.applyCrash("A6:split2");
  const text = allText(byId.get("advisor-list"));
  assert.match(text, /New bottleneck: A1 > A3 > A5 > A7 > A9 sets the finish, 5m of this cut is lost/);
});

test("Studio: edits, done, delete and add are all undoable", () => {
  const { ctrl, byId } = harness();
  ctrl.selectTask("A5");
  byId.get("inspector-duration").value = "45";
  byId.get("btn-save-task").click();
  assert.equal(ctrl.state.tasks.find((t) => t.id === "A5").durationMin, 45);
  ctrl.undo();
  assert.equal(ctrl.state.tasks.find((t) => t.id === "A5").durationMin, 25);

  byId.get("btn-toggle-done").click();
  assert.ok(ctrl.state.doneTaskIds.includes("A5"));
  ctrl.undo();
  assert.equal(ctrl.state.doneTaskIds.includes("A5"), false);

  ctrl.selectTask("A9");
  byId.get("btn-delete-task").click();
  assert.equal(ctrl.state.tasks.some((t) => t.id === "A9"), false);
  ctrl.undo();
  assert.equal(ctrl.state.tasks.some((t) => t.id === "A9"), true);

  byId.get("new-task-title").value = "Pack the robot";
  byId.get("new-task-deps").value = "A9";
  byId.get("btn-add-task").click();
  assert.ok(ctrl.state.tasks.some((t) => t.title === "Pack the robot"));
  ctrl.undo();
  assert.equal(ctrl.state.tasks.some((t) => t.title === "Pack the robot"), false);
});

test("Studio: an inline edit left by clicking elsewhere saves without eating the click", () => {
  const { ctrl, byId, fireDoc } = harness();
  ctrl.selectTask("A5");
  fireDoc("pointerdown", {}, true);
  byId.get("inspector-duration").value = "45";
  byId.get("inspector-duration").dispatchEvent({ type: "change" });
  // Nothing rebuilds between press and release.
  assert.equal(ctrl.state.tasks.find((t) => t.id === "A5").durationMin, 25);
  fireDoc("pointerup", {}, true);
  fireDoc("click", {}, true);
  assert.equal(ctrl.state.tasks.find((t) => t.id === "A5").durationMin, 45);
  assert.equal(ctrl.state.selectedTaskId, "A5");
  ctrl.selectTask("A6");
  assert.equal(ctrl.state.tasks.find((t) => t.id === "A5").durationMin, 45);
  ctrl.undo();
  assert.equal(ctrl.state.tasks.find((t) => t.id === "A5").durationMin, 25);
});

test("Studio: keyboard edits still save as soon as the field settles", () => {
  const { ctrl, byId } = harness();
  ctrl.selectTask("A5");
  byId.get("inspector-duration").value = "50";
  byId.get("inspector-duration").dispatchEvent({ type: "change" });
  assert.equal(ctrl.state.tasks.find((t) => t.id === "A5").durationMin, 50);
});

test("Studio: a chip rebuilt during its own click keeps the add-task menu open", () => {
  const { fireDoc, openMenus } = harness();
  const menu = { open: true, matches: (sel) => sel === "details.menu" };
  openMenus.push(menu);
  const detachedChip = { closest: () => null };
  fireDoc("click", { target: detachedChip, composedPath: () => [detachedChip, menu] });
  assert.equal(menu.open, true);
  fireDoc("click", { target: detachedChip, composedPath: () => [detachedChip] });
  assert.equal(menu.open, false);
});

test("Studio: saving unchanged fields adds no undo step", () => {
  const { ctrl, byId } = harness();
  ctrl.selectTask("A5");
  byId.get("btn-save-task").click();
  // The only step on the stack is still the preset load from the harness.
  ctrl.undo();
  assert.equal(ctrl.state.presetId, "hackathon-sprint");
  assert.equal(ctrl.canUndo(), false);
});

test("Studio: typed delay minutes land as one undo step", () => {
  const { ctrl, byId, finish } = harness();
  const select = byId.get("slip-task-select");
  const minutes = byId.get("slip-min-input");
  select.value = "A6";
  select.dispatchEvent({ type: "input" });
  for (const value of ["3", "30"]) {
    minutes.value = value;
    minutes.dispatchEvent({ type: "input" });
  }
  minutes.dispatchEvent({ type: "change" });
  assert.equal(finish(), "285 min");
  ctrl.undo();
  assert.equal(finish(), "255 min");
  assert.equal(ctrl.state.slipMin, 0);
});

test("Studio: the shockwave button stacks 15m, moves to the deadline and undoes", () => {
  const { ctrl, byId, finish } = harness();
  ctrl.selectTask("A6");
  byId.get("btn-shock").click();
  assert.equal(finish(), "270 min");
  assert.equal(byId.get("kpi-makespan").getAttribute("data-state"), "pushed");
  byId.get("btn-shock").click();
  assert.equal(ctrl.state.slipMin, 30);
  assert.equal(finish(), "285 min");
  assert.equal(byId.get("capybara-easter").getAttribute("data-mood"), "worried");
  ctrl.undo();
  assert.equal(ctrl.state.slipMin, 15);
  byId.get("btn-clear-delay").click();
  assert.equal(finish(), "255 min");
  assert.equal(byId.get("kpi-makespan").getAttribute("data-state"), "steady");
});

test("Studio: a delay absorbed by float keeps the capybara happy", () => {
  const { ctrl, byId, finish } = harness();
  ctrl.selectTask("A5");
  byId.get("btn-shock").click();
  assert.equal(finish(), "255 min");
  assert.equal(byId.get("capybara-easter").getAttribute("data-mood"), "happy");
  assert.match(byId.get("capybara-status").textContent, /float absorbed all 15m/);
});

test("Studio: splitting a delayed task carries the delay onto part A", () => {
  const { ctrl, byId, finish } = harness();
  ctrl.selectTask("A6");
  byId.get("btn-shock").click();
  assert.equal(finish(), "270 min");
  assert.equal(ctrl.applyCrash("A6:split2"), true);
  assert.equal(ctrl.state.slipTaskId, "A6a");
  assert.equal(finish(), "240 min");
});

test("Studio: prerequisite chips toggle dependencies and block cycles", () => {
  const { ctrl, byId } = harness();
  ctrl.selectTask("A5");
  const chips = () => byId.get("inspector-dep-chips").children;
  const chip = (id) => chips().find((c) => c.getAttribute("data-dep") === id);
  assert.equal(chips().some((c) => c.getAttribute("data-dep") === "A5"), false);
  assert.equal(chip("A3").getAttribute("aria-pressed"), "true");
  // A7 and A9 depend on A5, so choosing them would create a cycle.
  assert.equal(chip("A7").disabled, true);
  assert.equal(chip("A9").disabled, true);
  chip("A2").click();
  assert.deepEqual([...ctrl.state.tasks.find((t) => t.id === "A5").deps], ["A3", "A2"]);
  assert.equal(chip("A2").getAttribute("aria-pressed"), "true");
  ctrl.undo();
  assert.deepEqual([...ctrl.state.tasks.find((t) => t.id === "A5").deps], ["A3"]);
});

test("Studio: inspector shows upstream and downstream tasks", () => {
  const { ctrl, byId } = harness();
  ctrl.selectTask("A7");
  assert.equal(byId.get("inspector-upstream").textContent, "A1, A3, A5");
  assert.equal(byId.get("inspector-downstream").textContent, "A9");
  ctrl.selectTask("A2");
  assert.match(byId.get("inspector-upstream").textContent, /ready to start/);
});

test("Studio: new task chips fill the hidden prerequisite field", () => {
  const { ctrl, byId } = harness();
  byId.get("new-task-dep-chips").children.find((c) => c.getAttribute("data-dep") === "A9").click();
  assert.equal(byId.get("new-task-deps").value, "A9");
  byId.get("new-task-title").value = "Celebrate";
  byId.get("btn-add-task").click();
  const added = ctrl.state.tasks.find((t) => t.title === "Celebrate");
  assert.deepEqual([...added.deps], ["A9"]);
  assert.equal(byId.get("new-task-deps").value, "");
});

test("Keys: Ctrl or Cmd+Z undoes, Shift redoes, and text fields keep native undo", () => {
  const { ctrl, finish } = harness();
  ctrl.applyCrash("A6:split2");
  const z = key("z", { ctrlKey: true });
  ctrl.handleKey(z);
  assert.equal(z.prevented, true);
  assert.equal(finish(), "255 min");
  ctrl.handleKey(key("z", { metaKey: true, shiftKey: true }));
  assert.equal(finish(), "225 min");
  const typing = key("z", { metaKey: true, target: makeEl("input") });
  ctrl.handleKey(typing);
  assert.equal(typing.prevented, false);
  assert.equal(finish(), "225 min");
  ctrl.handleKey(key("y", { ctrlKey: true }));
  assert.equal(finish(), "225 min");
});

test("Keys: Space toggles the timer except on fields and activatable controls", () => {
  const { ctrl } = harness();
  const space = key(" ");
  ctrl.handleKey(space);
  assert.equal(space.prevented, true);
  assert.equal(ctrl.state.focus.running, true);
  ctrl.handleKey(key(" "));
  assert.equal(ctrl.state.focus.running, false);
  for (const tag of ["input", "textarea", "select", "button"]) {
    const ev = key(" ", { target: makeEl(tag) });
    ctrl.handleKey(ev);
    assert.equal(ev.prevented, false, tag);
    assert.equal(ctrl.state.focus.running, false, tag);
  }
  const node = makeEl("g");
  node.setAttribute("role", "button");
  ctrl.handleKey(key(" ", { target: node }));
  assert.equal(ctrl.state.focus.running, false);
});

test("Keys: ? opens the cheat sheet only outside text fields", () => {
  const { ctrl, byId } = harness();
  let opened = 0;
  byId.get("shortcut-dialog").showModal = () => { opened += 1; };
  ctrl.handleKey(key("?"));
  assert.equal(opened, 1);
  ctrl.handleKey(key("?", { target: makeEl("input") }));
  assert.equal(opened, 1);
});

test("Timer pill mirrors the focus timer and its play button", () => {
  const { ctrl, byId } = harness();
  assert.equal(byId.get("pill-countdown").textContent, "25:00");
  assert.match(byId.get("pill-task").textContent, /^A1: /);
  byId.get("pill-toggle").click();
  assert.equal(ctrl.state.focus.running, true);
  assert.ok(byId.get("timer-pill").classList.contains("is-running"));
  assert.equal(byId.get("pill-toggle").getAttribute("aria-label"), "Pause focus timer");
  byId.get("pill-toggle").click();
  assert.equal(ctrl.state.focus.running, false);
});

test("Share: importing a link replaces the plan and one undo brings the old plan back", () => {
  const { ctrl, finish, byId } = harness();
  const prevPolicy = ctrl.state.policy;
  const prevFocus = ctrl.state.focusBlockMin;
  const prevBreak = ctrl.state.breakMin;
  const prevCap = ctrl.state.dayCapacityMin;
  const prevWorkers = ctrl.state.workers;
  const study = Engine.PRESET_WORKFLOWS.find((w) => w.id === "exam-study-sprint").tasks;
  const link = Engine.encodePlanHash({ tasks: study, doneTaskIds: ["S1"], settings: { policy: "critical", focusBlockMin: 30, breakMin: 10, dayCapacityMin: 240, workers: 2 } });
  assert.equal(ctrl.importHash(link), true);
  assert.equal(ctrl.state.tasks.length, study.length);
  assert.deepEqual(ctrl.state.doneTaskIds, ["S1"]);
  assert.equal(ctrl.state.policy, "critical");
  assert.equal(ctrl.state.workers, 2);
  assert.equal(byId.get("workers-input").value, "2");
  assert.equal(byId.get("preset-select").value, "shared");
  ctrl.undo();
  assert.equal(finish(), "255 min");
  assert.ok(ctrl.state.tasks.some((t) => t.id === "A9"));
  assert.equal(ctrl.state.policy, prevPolicy);
  assert.equal(ctrl.state.focusBlockMin, prevFocus);
  assert.equal(ctrl.state.breakMin, prevBreak);
  assert.equal(ctrl.state.dayCapacityMin, prevCap);
  assert.equal(ctrl.state.workers, prevWorkers);
  assert.equal(byId.get("policy-select").value, prevPolicy);
  assert.equal(byId.get("focus-min-input").value, String(prevFocus));
  assert.equal(byId.get("break-min-input").value, String(prevBreak));
  assert.equal(byId.get("cap-min-input").value, String(prevCap));
  assert.equal(byId.get("workers-input").value, String(prevWorkers));
  ctrl.applyCrash("A6:split2");
  assert.match(byId.get("inspector-status").textContent, /applied/i);
  ctrl.undo();
  assert.equal(byId.get("inspector-status").textContent, "");
});

test("Share: a hostile link leaves the current plan untouched and reports why", () => {
  const { ctrl, finish, byId } = harness();
  const before = JSON.stringify(ctrl.state.tasks);
  assert.equal(ctrl.importHash(HOSTILE_LINKS["img onerror title"]), false);
  assert.equal(JSON.stringify(ctrl.state.tasks), before);
  assert.equal(finish(), "255 min");
  assert.match(byId.get("error-banner").textContent, /unsafe task title/);
});

test("Share: the current plan produces a link that decodes back to itself", () => {
  const { ctrl } = harness();
  ctrl.applyCrash("A6:split2");
  const out = Engine.decodePlanHash(ctrl.shareHash());
  assert.equal(out.ok, true);
  assert.equal(makespan(out.plan.tasks), 225);
});

test("XSS: a hostile title stays inert text in the advisor and print plan", () => {
  const { ctrl, byId } = harness();
  const evil = "<img src=x onerror=alert(1)>";
  ctrl.selectTask("A6");
  byId.get("inspector-title").value = evil;
  byId.get("btn-save-task").click();
  ctrl.selectTask("A2");
  const printRow = byId.get("print-body").children.find((tr) => allText(tr).includes("A6:"));
  assert.ok(allText(printRow).includes(evil));
  for (const sink of ["advisor-list", "print-body", "inspector-dep-chips", "new-task-dep-chips"]) {
    assert.equal(byId.get(sink).innerHTML, "", `${sink} is built from text nodes`);
  }
  assert.equal(ctrl.state.tasks.find((t) => t.id === "A6").title, evil);
});

test("Print: the one-page plan lists every remaining task in schedule order", () => {
  const { ctrl, byId } = harness();
  const rows = byId.get("print-body").children;
  assert.equal(rows.length, ctrl.state.tasks.length);
  assert.match(allText(rows[0]), /A1: AP Bio Free Response Set/);
  assert.match(byId.get("print-summary").textContent, /Finish in 255 minutes/);
  assert.equal(byId.get("print-title").textContent, "AP Exam & Robotics Build Week");
});

test("Capybara: reacts to crashes, critical completions, focus blocks and pets", () => {
  const { ctrl, byId } = harness();
  const mood = () => byId.get("capybara-easter").getAttribute("data-mood");
  ctrl.applyCrash("A6:split2");
  assert.equal(mood(), "party");
  assert.match(byId.get("capybara-status").textContent, /30m cleared off the critical path/);
  ctrl.undo();
  ctrl.selectTask("A2");
  byId.get("btn-toggle-done").click();
  assert.equal(mood(), "party");
  assert.match(byId.get("capybara-status").textContent, /A2 just cleared off the critical path/);
  byId.get("btn-timer-complete").click();
  assert.equal(mood(), "happy");
  for (let i = 0; i < 5; i++) byId.get("capybara-easter").click();
  assert.equal(mood(), "party");
  assert.match(byId.get("capybara-status").textContent, /tangerine party/);
});

/* ---------------------------- shipped contract --------------------------- */

test("Contract: every new control exists exactly once in the markup", () => {
  for (const id of ["btn-undo", "btn-redo", "timer-pill", "pill-toggle", "pill-countdown", "btn-shock",
    "btn-clear-delay", "btn-share-link", "share-url", "btn-print", "print-plan", "advisor-card",
    "advisor-list", "advisor-lens", "inspector-dep-chips", "new-task-dep-chips", "shortcut-dialog", "toast"]) {
    assert.equal((html.match(new RegExp(`\\bid="${id}"`, "g")) || []).length, 1, id);
  }
  assert.match(html, /id="capybara-easter"[^>]*role="button" tabindex="0"/);
});

test("Contract: the page locks itself to local resources", () => {
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp, "CSP meta present");
  for (const rule of ["default-src 'none'", "script-src 'self'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(csp[1].includes(rule), rule);
  }
  assert.equal(/@import|url\(\s*["']?https?:/i.test(css), false);
  assert.equal(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(appJs), false);
});

test("Contract: motion respects reduced-motion and the plan has a print layout", () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\)/);
  assert.match(css, /@media print/);
  assert.equal(/scroll-behavior:\s*smooth/.test(css), false);
});

test("Contract: shipped text has no long dashes or smart quotes, and the scanner works", () => {
  const banned = new RegExp("[" + [0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d].map((c) => String.fromCharCode(c)).join("") + "]");
  for (const code of [0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d]) {
    assert.equal(banned.test(`probe ${String.fromCharCode(code)} probe`), true, "scanner detects planted character");
  }
  for (const rel of ["index.html", "styles.css", "js/app.js", "js/dag-engine.js", "js/ui-dag.js",
    "README.md", "video/narration.txt", "video/steps.json", "tests/studio.test.js"]) {
    assert.equal(banned.test(read(rel)), false, rel);
  }
});
