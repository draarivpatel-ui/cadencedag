"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Engine = require("../js/dag-engine.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const html = read("index.html");
const appJs = read("js/app.js");
const uiJs = read("js/ui-dag.js");

const AP = Engine.PRESET_WORKFLOWS.find((w) => w.id === "ap-robotics-week").tasks;
const makespan = (tasks, slip) => Engine.analyzeCriticalPath(tasks, slip).projectMakespanMin;
const b64 = (text) => Buffer.from(text, "utf8").toString("base64url");
const SETTINGS = ["wspt", 25, 5, 300, 3];
const linkFor = (payload) => `#plan=1.${b64(JSON.stringify(payload))}`;
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-6, `${label}: ${a} !== ${b}`);

/* ---------- A: crossover proof is independent of the implementation ------- */

test("Wave2-A: every response-curve point equals an exact CPM re-solve under an active delay", () => {
  for (const wf of Engine.PRESET_WORKFLOWS) {
    const slip = { taskId: wf.tasks[0].id, slipMin: 20 };
    for (const task of wf.tasks) {
      const bn = Engine.analyzeBottleneck(wf.tasks, task.id, { slip });
      for (const p of bn.points) {
        const trial = wf.tasks.map((t) => (t.id === task.id ? Object.assign({}, t, { durationMin: p.durationMin }) : t));
        near(makespan(trial, slip), p.makespanMin, `${wf.id}:${task.id}@${p.deltaMin}`);
      }
      // Sample mid-kink deltas the curve does not draw.
      for (const d of [bn.minDeltaMin, (bn.minDeltaMin + bn.crossoverDeltaMin) / 2, bn.crossoverDeltaMin, (bn.crossoverDeltaMin + bn.maxDeltaMin) / 2, bn.maxDeltaMin]) {
        const dur = Math.round((task.durationMin + d) * 100) / 100;
        if (dur <= 0) continue;
        const trial = wf.tasks.map((t) => (t.id === task.id ? Object.assign({}, t, { durationMin: dur }) : t));
        near(makespan(trial, slip), Math.max(bn.rivalMin, bn.throughMin + d), `${wf.id}:${task.id} mid@${d}`);
      }
    }
  }
});

test("Wave2-A: the curve stays exact when the slip is on the previewed task itself", () => {
  const slip = { taskId: "A6", slipMin: 25 };
  const bn = Engine.analyzeBottleneck(AP, "A6", { slip });
  for (const p of bn.points) {
    const trial = AP.map((t) => (t.id === "A6" ? Object.assign({}, t, { durationMin: p.durationMin }) : t));
    near(makespan(trial, slip), p.makespanMin, `A6 self-slip @${p.deltaMin}`);
  }
});

test("Wave2-A: a disconnected island task previews against the rival main chain", () => {
  const tasks = [
    { id: "M1", durationMin: 100, weight: 5, deps: [] },
    { id: "M2", durationMin: 50, weight: 5, deps: ["M1"] },
    { id: "I1", durationMin: 30, weight: 5, deps: [] }
  ];
  const bn = Engine.analyzeBottleneck(tasks, "I1");
  assert.equal(bn.rivalMin, 150, "the rival chain is the main island");
  assert.equal(bn.throughMin, 30);
  assert.equal(bn.crossoverDeltaMin, 120);
  for (const d of [-20, 0, 60, 120, 150]) {
    const trial = tasks.map((t) => (t.id === "I1" ? Object.assign({}, t, { durationMin: 30 + d }) : t));
    near(makespan(trial), Math.max(150, 30 + d), `island@${d}`);
  }
});

/* --------------------------- B: structural stress ------------------------- */

test("Wave2-B: disconnected islands get honest float and stay scheduled", () => {
  const tasks = [
    { id: "M1", durationMin: 100, weight: 5, deps: [] },
    { id: "M2", durationMin: 50, weight: 5, deps: ["M1"] },
    { id: "I1", durationMin: 30, weight: 5, deps: [] },
    { id: "I2", durationMin: 20, weight: 5, deps: ["I1"] }
  ];
  const cpm = Engine.analyzeCriticalPath(tasks);
  assert.equal(cpm.projectMakespanMin, 150);
  assert.equal(cpm.nodeMap.get("I1").totalFloatMin, 100);
  assert.equal(cpm.nodeMap.get("I2").totalFloatMin, 100);
  assert.deepEqual(cpm.criticalTaskIds, ["M1", "M2"]);
  assert.deepEqual(Engine.enumerateCriticalPaths(tasks).criticalPaths, [["M1", "M2"]]);
  assert.equal(Engine.scheduleWorkflow(tasks).taskTimeline.length, 4);
});

test("Wave2-B: share decode rejects cycles, non-finite and out-of-range durations", () => {
  const cyc = linkFor([1, [["A", "A", 10, 5, "General", [1]], ["B", "B", 10, 5, "General", [0]]], [], SETTINGS]);
  assert.equal(Engine.decodePlanHash(cyc).ok, false);
  for (const dur of [null, -5, 0, 0.005, 1441, Infinity]) {
    const link = linkFor([1, [["A", "A", dur, 5, "General", []]], [], SETTINGS]);
    assert.equal(Engine.decodePlanHash(link).ok, false, `duration ${dur}`);
  }
});

test("Wave2-B: fractional durations and long unicode titles round-trip through share links", () => {
  const tasks = [
    { id: "U1", title: "日本語タイトル 長い名前 🔧 Ünïcodé", durationMin: 12.5, weight: 5, category: "General", deps: [] },
    { id: "U2", title: "Half minute task", durationMin: 0.5, weight: 3, category: "General", deps: ["U1"] },
    { id: "U3", title: "Quarter", durationMin: 0.25, weight: 1, category: "General", deps: [] }
  ];
  const decoded = Engine.decodePlanHash(Engine.encodePlanHash({ tasks, doneTaskIds: [], settings: {} }));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.plan.tasks[0].title, tasks[0].title);
  assert.equal(decoded.plan.tasks[1].durationMin, 0.5);
  near(makespan(decoded.plan.tasks), makespan(tasks), "fractional makespan");
});

test("Wave2-B: a 60-task shared plan decodes; task 61 and oversize payloads are refused", () => {
  const rows = [];
  for (let i = 1; i <= 60; i++) rows.push([`K${i}`, `Work package ${i}`, 10 + (i % 7), 5, "General", i > 1 ? [i - 2] : []]);
  const decoded = Engine.decodePlanHash(linkFor([1, rows, [0, 59], SETTINGS]));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.plan.tasks.length, 60);
  assert.deepEqual(decoded.plan.doneTaskIds, ["K1", "K60"]);
  const tooMany = linkFor([1, rows.concat([["K61", "Extra", 10, 5, "General", []]]), [], SETTINGS]);
  assert.equal(Engine.decodePlanHash(tooMany).ok, false);
  assert.throws(
    () => Engine.encodePlanHash({ tasks: decoded.plan.tasks.concat([{ id: "K61", durationMin: 5, weight: 1, deps: [] }]) }),
    /60 tasks/
  );
  const big = [];
  for (let i = 0; i < 60; i++) big.push({ id: `B${i}`, title: "界".repeat(120), durationMin: 10, weight: 1, deps: [] });
  assert.throws(() => Engine.encodePlanHash({ tasks: big }), /too large/);
});

test("Wave2-B: a split task verifies under the independent checker with halves in parallel", () => {
  const move = Engine.adviseCrash(AP).moves.find((m) => m.moveId === "A6:split2");
  const { tasks: out, partIds } = Engine.applyCrashMove(AP, move);
  const verdict = Engine.verifyPlan(out, { workers: 2 });
  assert.equal(verdict.valid, true, verdict.failures.join("; "));
  // With the default three workers a spare lane is free at the handoff
  // moment, so the halves really do run in parallel.
  const multi = Engine.scheduleWithWorkers(out, { workers: 3 });
  const a = { s: multi.starts.get(partIds[0]), e: multi.ends.get(partIds[0]) };
  const b = { s: multi.starts.get(partIds[1]), e: multi.ends.get(partIds[1]) };
  assert.ok(a.s < b.e && b.s < a.e, "split halves overlap on different workers");
  // With only two workers a longer task occupies the spare lane, so the
  // halves serialize honestly: 265m, not the 225m CPM promises.
  assert.equal(Engine.scheduleWithWorkers(out, { workers: 2 }).makespanMin, 265);
});

test("Wave2-B: restoring a completed prerequisite re-links its dependents", () => {
  const { ctrl, byId } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  ctrl.selectTask("A2");
  byId.get("btn-toggle-done").dispatchEvent({ type: "click" });
  ctrl.selectTask("A4");
  assert.match(byId.get("inspector-cpm").textContent, /ES 0m/, "A4 starts at 0 while A2 is done");
  ctrl.selectTask("A2");
  byId.get("btn-toggle-done").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.doneTaskIds.includes("A2"), false);
  ctrl.selectTask("A4");
  assert.match(byId.get("inspector-cpm").textContent, /ES 60m/, "A4 waits on the restored A2");
});

test("Wave2-B: toggling the same task done twice restores it exactly once", () => {
  const { ctrl, byId } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  ctrl.selectTask("A6");
  byId.get("btn-toggle-done").dispatchEvent({ type: "click" });
  byId.get("btn-toggle-done").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.doneTaskIds.length, 0);
  assert.equal(byId.get("kpi-makespan").textContent, "255 min");
});

/* ----------------------------- C: timer edges ----------------------------- */

test("Wave2-C: exhausting the queue leaves the countdown at 00:00 across later renders", () => {
  const { ctrl, byId } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  let guard = 0;
  while (!ctrl.state.focus.exhausted && guard++ < 60) {
    byId.get("btn-timer-complete").dispatchEvent({ type: "click" });
  }
  assert.equal(ctrl.state.focus.remainingSec, 0);
  ctrl.selectTask("A1");
  assert.equal(ctrl.state.focus.remainingSec, 0, "a re-render must not resurrect a finished countdown");
  assert.equal(byId.get("focus-countdown").textContent, "00:00");
  assert.equal(byId.get("pill-countdown").textContent, "00:00");
});

test("Wave2-C: a paused zero-second remainder is not refilled on re-render", () => {
  const { ctrl } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  ctrl.state.focus.remainingSec = 0;
  ctrl.state.focus.blockKey = "A1 p1";
  ctrl.render();
  assert.equal(ctrl.state.focus.remainingSec, 0);
});

test("Wave2-C: a queue recompute that shifts the running block backward keeps its remainder", () => {
  const { ctrl, byId } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  let guard = 0;
  while (guard++ < 10) {
    const key = ctrl.state.focus.blockKey || "";
    if (key && !key.startsWith("A1 ")) break;
    byId.get("btn-timer-skip").dispatchEvent({ type: "click" });
  }
  byId.get("btn-timer-start").dispatchEvent({ type: "click" });
  const idx0 = ctrl.state.focus.index;
  const key0 = ctrl.state.focus.blockKey;
  ctrl.state.focus.remainingSec = 300;
  ctrl.selectTask("A1");
  byId.get("btn-toggle-done").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.focus.blockKey, key0, "the running block keeps its identity");
  assert.ok(ctrl.state.focus.index < idx0, "the block slid backward in the queue");
  assert.equal(ctrl.state.focus.remainingSec, 300, "the countdown kept the remainder");
  assert.equal(ctrl.state.focus.running, true);
});

test("Wave2-C: splitting the running block's task rebases onto the rewired queue", () => {
  const { ctrl, byId } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  byId.get("btn-timer-start").dispatchEvent({ type: "click" });
  ctrl.state.focus.blockKey = "A6 p1";
  ctrl.state.focus.index = 5;
  assert.equal(ctrl.applyCrash("A6:split2"), true);
  const keys = Engine.scheduleWorkflow(ctrl.state.tasks, { focusBlockMin: 25, breakMin: 5, dayCapacityMin: 300 })
    .blocks.map((b) => `${b.taskId} p${b.part}`);
  assert.ok(keys.includes(ctrl.state.focus.blockKey), `blockKey ${ctrl.state.focus.blockKey} must exist in the new queue`);
});

/* ---------------------------- D: honest states ---------------------------- */

test("Wave2-D: a corrupt restore warning clears after the first successful save", () => {
  const h = makeHarness(null, false, "{not json");
  assert.match(h.byId.get("storage-status").textContent, /corrupt/i);
  h.ctrl.applyPreset("ap-robotics-week");
  assert.equal(h.byId.get("storage-status").textContent, "Saved locally");
  assert.equal(h.byId.get("storage-status").getAttribute("data-state"), "ok");
});

test("Wave2-D: a persisted plan that fails graph validation warns instead of dying silently", () => {
  const bad = makeHarness(null, false, JSON.stringify({
    presetId: "ap-robotics-week",
    tasks: [{ id: "A", durationMin: 10, deps: ["MISSING"] }],
    doneTaskIds: [], selectedTaskId: "A"
  }));
  assert.match(bad.byId.get("storage-status").textContent, /corrupt/i);
  assert.equal(bad.byId.get("storage-status").getAttribute("data-state"), "warning");
});

test("Wave2-D: the shared-plan option disappears after returning to a preset", () => {
  const { ctrl, byId } = makeHarness();
  const link = Engine.encodePlanHash({ tasks: AP, doneTaskIds: [], settings: {} });
  assert.equal(ctrl.importHash(link), true);
  const sel = byId.get("preset-select");
  assert.ok(sel.children.some((o) => o.value === "shared"), "shared option appears for a shared plan");
  ctrl.applyPreset("exam-study-sprint");
  assert.equal(sel.children.some((o) => o.value === "shared"), false, "stale shared option removed");
});

test("Wave2-D: a delay parked on a completed task says so instead of claiming absorption", () => {
  const { ctrl, byId } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  byId.get("slip-task-select").value = "A6";
  byId.get("slip-task-select").dispatchEvent({ type: "change" });
  byId.get("slip-min-input").value = "30";
  byId.get("slip-min-input").dispatchEvent({ type: "change" });
  ctrl.selectTask("A6");
  byId.get("btn-toggle-done").dispatchEvent({ type: "click" });
  assert.match(byId.get("slip-summary").textContent, /parked|marked done|inactive/i);
});

/* ---------------------- E: risk sweep meets the slip ---------------------- */

test("Wave2-E: the delay sweep measures extra delay on top of the active slip", () => {
  const slip = { taskId: "A6", slipMin: 30 };
  const risk = Engine.analyzeScheduleRisk(AP, { delayMin: 15, slip });
  assert.equal(risk.baselineMakespanMin, 285, "the baseline is the slipped plan");
  const a6 = risk.samples.find((s) => s.taskId === "A6");
  assert.equal(a6.makespanMin, 300, "the swept task stacks delay on its slipped duration");
  const a5 = risk.samples.find((s) => s.taskId === "A5");
  assert.equal(a5.floatMin, 65, "the float column matches the slipped graph");
  const tele = Engine.planTelemetry(AP, { delayMin: 15, slip });
  assert.equal(tele.makespanMin, 285);
  assert.equal(tele.riskWorstCaseMakespanMin, 300);
  assert.ok(tele.riskWorstCaseMakespanMin >= tele.makespanMin, "worst case never reads below the live makespan");
});

test("Wave2-E: the risk panel's worst case includes the active delay", () => {
  const { byId, ctrl } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  byId.get("slip-task-select").value = "A6";
  byId.get("slip-task-select").dispatchEvent({ type: "change" });
  byId.get("slip-min-input").value = "30";
  byId.get("slip-min-input").dispatchEvent({ type: "input" });
  assert.equal(byId.get("kpi-worst").textContent, "295m");
  assert.match(byId.get("kpi-worst-sub").textContent, /over 285m baseline/);
});

test("Wave2-E: the sweep stays nominal when no delay is active", () => {
  const risk = Engine.analyzeScheduleRisk(AP, { delayMin: 15 });
  assert.equal(risk.baselineMakespanMin, 255);
  assert.equal(risk.samples.find((s) => s.taskId === "A5").floatMin, 35);
});

/* ------------------------------ F: ICS edges ------------------------------ */

test("Wave2-F: a sub-second focus slice still emits a valid VEVENT", () => {
  const tasks = [{ id: "T", title: "Tiny", durationMin: 0.01, weight: 1, deps: [] }];
  const sched = Engine.scheduleWorkflow(tasks, { focusBlockMin: 25, breakMin: 0, startDateIso: "2026-11-20" });
  const report = Engine.validateIcs(Engine.exportScheduleToIcs(sched, "Test"));
  assert.equal(report.valid, true, report.errors.join("; "));
});

test("Wave2-F: unicode titles and ids fold inside 75 octets without breaking sequences", () => {
  const tasks = [
    { id: "日本", title: "翻訳メモ：絵文字🎨と日本語テキスト", durationMin: 30, weight: 5, deps: [] },
    { id: "E2", title: "x".repeat(200), durationMin: 30, weight: 5, deps: ["日本"] }
  ];
  const sched = Engine.scheduleWorkflow(tasks, { focusBlockMin: 25, breakMin: 0, startDateIso: "2026-11-20" });
  const ics = Engine.exportScheduleToIcs(sched, "Test");
  assert.equal(Engine.validateIcs(ics).valid, true);
  for (const line of ics.split("\r\n")) {
    assert.ok(new TextEncoder().encode(line).length <= 75, `overlong line: ${line}`);
  }
});

/* ------------------------------- harness --------------------------------- */

function makeHarness(seed, broken = false, rawSeed = null) {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const byId = new Map();
  for (const id of ids) {
    const tag = id.includes("svg") || id === "capybara-badge" ? "div"
      : id.includes("select") ? "select" : id.includes("input") ? "input"
      : id.includes("body") ? "tbody" : "div";
    const element = makeEl(tag, id);
    const tagMatch = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>([^<]*)<`));
    if (tagMatch && tagMatch[1].trim()) element.textContent = tagMatch[1].trim();
    const valueMatch = html.match(new RegExp(`<[^>]*id="${id}"[^>]*\\bvalue="([^"]*)"`));
    if (valueMatch) element.value = valueMatch[1];
    byId.set(id, element);
  }
  byId.get("policy-select").value = "wspt";
  byId.get("preset-select").value = "capybara-rescue";
  const tabs = ["tab-dag", "tab-nodes", "tab-blocks", "tab-risk"].map((id) => makeEl("button", id));
  const panels = ["panel-dag", "panel-nodes", "panel-blocks", "panel-risk"].map((id) => makeEl("div", id));
  const storage = broken
    ? { data: {}, getItem(k) { return this.data[k] || null; }, setItem() { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; } }
    : { data: rawSeed !== null ? { "cadencedag.user.v1": rawSeed } : (seed ? Object.assign({}, seed) : {}), getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = v; } };
  const doc = {
    body: makeEl("body"),
    defaultView: { setInterval: () => 7, clearInterval: () => {} },
    getElementById(id) { return byId.get(id) || null; },
    createElement(tag) { return makeEl(tag); },
    createElementNS(_ns, tag) { return makeEl(tag); },
    querySelectorAll(sel) { return sel === ".tab" ? tabs : sel === ".panel" ? panels : []; },
    addEventListener() {},
    visibilityState: "visible"
  };
  const svgCtx = { document: doc, Math, Number, Object, String, Array };
  svgCtx.globalThis = svgCtx;
  vm.runInNewContext(uiJs, svgCtx);
  const sandbox = {
    document: doc, Math, Number, Object, String, Array, Date, JSON, URL,
    Blob: function () {}, localStorage: storage,
    CadenceDagEngine: Engine, CadenceDagSvg: svgCtx.CadenceDagSvg
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(appJs, sandbox);
  const ctrl = sandbox.CadenceDagApp.createController(doc);
  ctrl.init();
  return { byId, ctrl, storage, tabs, panels, doc };
}

function makeEl(tag, id = "") {
  const listeners = {};
  const element = {
    tagName: tag.toUpperCase(), id, value: "", textContent: "", _innerHTML: "", style: {}, disabled: false,
    get className() { return this.attributes.class || ""; },
    set className(v) { this.attributes.class = String(v); },
    children: [], options: [], attributes: {},
    get innerHTML() {
      if (this._innerHTML) return this._innerHTML;
      return this.children.map((c) => c.outerHTML || c.innerHTML || c.textContent || "").join("");
    },
    set innerHTML(v) { this._innerHTML = String(v); if (v === "") this.children = []; },
    get outerHTML() {
      const cls = this.attributes.class ? ` class="${this.attributes.class}"` : "";
      return `<${this.tagName.toLowerCase()}${cls}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
    },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); this._sync(); },
      remove(c) { this._set.delete(c); this._sync(); },
      toggle(c, f) { if (f === undefined) this._set.has(c) ? this._set.delete(c) : this._set.add(c); else if (f) this._set.add(c); else this._set.delete(c); this._sync(); },
      contains(c) { return this._set.has(c) || (this._owner.attributes.class || "").split(/\s+/).includes(c); },
      _sync() { this._owner.attributes.class = [...this._set].join(" "); }
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    dispatchEvent(ev) { for (const fn of listeners[ev.type] || []) fn(ev); },
    appendChild(child) { this.children.push(child); if (this.tagName === "SELECT" && child.tagName === "OPTION") this.options.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); },
    get firstChild() { return this.children[0] || null; },
    closest() { return null; },
    focus() {},
    querySelector() { return null; }
  };
  element.classList._owner = element;
  return element;
}
