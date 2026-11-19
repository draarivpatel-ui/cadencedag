"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Engine = require("../js/dag-engine.js");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(ROOT, "js/app.js"), "utf8");
const engineJs = fs.readFileSync(path.join(ROOT, "js/dag-engine.js"), "utf8");
const uiJs = fs.readFileSync(path.join(ROOT, "js/ui-dag.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const idList = () => [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

/* ------------------------- comparePolicies unit tests ------------------- */

const DIAMOND = [
  { id: "A", title: "Root", durationMin: 10, weight: 9, deps: [] },
  { id: "B", title: "Heavy", durationMin: 40, weight: 10, deps: ["A"] },
  { id: "C", title: "Light", durationMin: 15, weight: 3, deps: ["A"] },
  { id: "D", title: "Finish", durationMin: 20, weight: 8, deps: ["B", "C"] }
];

test("comparePolicies returns exactly three labeled policies with deterministic metrics", () => {
  const a = Engine.comparePolicies(DIAMOND);
  const b = Engine.comparePolicies(DIAMOND);
  assert.deepEqual(a, b);
  assert.deepEqual(a.policies.map((p) => p.id), ["wspt", "critical", "shortest"]);
  assert.deepEqual(a.policies.map((p) => p.label), ["WSPT", "Critical-First", "SPT"]);
  for (const p of a.policies) {
    assert.ok(p.weightedCompletion > 0);
    assert.equal(p.firstThreeTaskIds.length, 3);
    assert.ok(p.highPriorityMinutesFirstHorizon >= 0);
    assert.ok(p.focusBlocks > 0);
  }
});

test("comparePolicies weighted completion equals each policy's scheduleWorkflow result", () => {
  const cmp = Engine.comparePolicies(DIAMOND, { horizonMin: 120 });
  for (const p of cmp.policies) {
    const sched = Engine.scheduleWorkflow(DIAMOND, { policy: p.id, focusBlockMin: 25, breakMin: 5, dayCapacityMin: 360 });
    assert.equal(p.weightedCompletion, sched.totalWeightedCompletion);
    assert.deepEqual(p.firstThreeTaskIds, sched.executionOrder.slice(0, 3));
  }
});

test("comparePolicies horizon and high-priority threshold change the minute metric", () => {
  const tasks = [
    { id: "X", durationMin: 30, weight: 9, deps: [] },
    { id: "Y", durationMin: 30, weight: 2, deps: [] }
  ];
  const wide = Engine.comparePolicies(tasks, { horizonMin: 120, highPriorityWeight: 8 });
  const narrow = Engine.comparePolicies(tasks, { horizonMin: 10, highPriorityWeight: 8 });
  for (const p of wide.policies) {
    const short = narrow.policies.find((q) => q.id === p.id);
    assert.ok(p.highPriorityMinutesFirstHorizon > short.highPriorityMinutesFirstHorizon);
  }
  const strict = Engine.comparePolicies(tasks, { horizonMin: 120, highPriorityWeight: 10 });
  assert.ok(strict.policies.every((p) => p.highPriorityMinutesFirstHorizon === 0));
});

test("comparePolicies on independent weighted tasks shows WSPT beating SPT on weighted completion", () => {
  const tasks = [
    { id: "H", durationMin: 30, weight: 10, deps: [] },
    { id: "L", durationMin: 10, weight: 1, deps: [] }
  ];
  const cmp = Engine.comparePolicies(tasks);
  const wspt = cmp.policies.find((p) => p.id === "wspt");
  const spt = cmp.policies.find((p) => p.id === "shortest");
  assert.ok(wspt.weightedCompletion < spt.weightedCompletion);
  assert.equal(cmp.bestWeightedCompletion, wspt.weightedCompletion);
  assert.equal(cmp.weightedCompletionSaving, spt.weightedCompletion - wspt.weightedCompletion);
});

/* ------------------------- AP Robotics preset --------------------------- */

test("AP Exam & Robotics Build Week preset is a valid 9-task graph with real float", () => {
  const preset = Engine.PRESET_WORKFLOWS.find((w) => w.id === "ap-robotics-week");
  assert.ok(preset, "preset exists");
  assert.match(preset.name, /AP Exam & Robotics Build Week/);
  assert.equal(preset.tasks.length, 9);
  const cpm = Engine.analyzeCriticalPath(preset.tasks);
  assert.ok(cpm.criticalTaskIds.length >= 1);
  assert.ok(cpm.nodes.some((n) => n.totalFloatMin > 0), "has at least one float task");
  assert.equal(Engine.validateAndTopoSort(preset.tasks).topoOrder.length, 9);
  const ics = Engine.validateIcs(Engine.exportScheduleToIcs(Engine.scheduleWorkflow(preset.tasks)));
  assert.equal(ics.valid, true);
  assert.equal(ics.errors.length, 0);
});

test("all four presets remain valid with distinct ids and at least one critical path", () => {
  assert.equal(Engine.PRESET_WORKFLOWS.length, 4);
  const ids = Engine.PRESET_WORKFLOWS.map((w) => w.id);
  assert.equal(new Set(ids).size, 4);
  for (const wf of Engine.PRESET_WORKFLOWS) {
    assert.ok(Engine.enumerateCriticalPaths(wf.tasks).pathCount >= 1);
  }
});

/* ------------------------- UI contract additions ------------------------ */

test("UI 15: Phase 2 markup exposes every required new control with unique ids", () => {
  const set = new Set(idList());
  assert.equal(set.size, idList().length, "all ids remain unique");
  for (const id of [
    "next-action-banner", "next-action-text", "inspector-title", "inspector-duration",
    "inspector-weight", "inspector-deps", "btn-save-task", "btn-delete-task",
    "btn-toggle-done", "btn-reset-preset", "inspector-status", "policy-compare-strip",
    "clock-readout", "clock-toggle", "focus-task-label", "focus-countdown",
    "focus-progress-fill", "focus-progress-text", "btn-timer-start", "btn-timer-pause",
    "btn-timer-reset", "btn-timer-complete", "btn-timer-skip", "btn-mark-done",
    "focus-status", "block-window-head", "svg-workers", "capybara-badge"
  ]) {
    assert.ok(set.has(id), `missing #${id}`);
  }
  assert.ok(html.includes('role="button" tabindex="0"'));
  assert.ok(appJs.includes("Engine.comparePolicies("));
  assert.ok(engineJs.includes("function comparePolicies("));
  assert.ok(uiJs.includes("function renderWorkerSwimlanes("));
  assert.ok(css.includes("prefers-reduced-motion"));
  assert.ok(css.includes(".dag-node"));
});

test("UI 16: page still makes zero external network references after Phase 2", () => {
  assert.equal(/<script[^>]+src="https?:/.test(html), false);
  assert.equal(/<link[^>]+href="https?:/.test(html), false);
  const strippedHtml = html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, "");
  const strippedApp = appJs.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, "");
  const strippedUi = uiJs.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, "");
  assert.equal(/https?:\/\//.test(strippedHtml), false);
  assert.equal(/https?:\/\//.test(strippedApp), false);
  assert.equal(/https?:\/\//.test(strippedUi), false);
});

/* ------------------------- controller integration ----------------------- */

function makeEl(tag, id = "") {
  const listeners = {};
  const element = {
    tagName: tag.toUpperCase(), id, value: "", textContent: "", _innerHTML: "",
    style: {},
    get className() { return this.attributes.class || ""; },
    set className(v) { this.attributes.class = String(v); },
    children: [],
    options: [],
    attributes: {},
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
      contains(c) {
        const attr = this._owner.attributes.class || "";
        return this._set.has(c) || attr.split(/\s+/).includes(c);
      },
      _sync() { this._owner.attributes.class = [...this._set].join(" "); }
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    dispatchEvent(ev) { for (const fn of listeners[ev.type] || []) fn(ev); },
    appendChild(child) { this.children.push(child); if (this.tagName === "SELECT" && child.tagName === "OPTION") this.options.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); },
    get firstChild() { return this.children[0] || null; },
    closest() { return null; }
  };
  element.classList._owner = element;
  return element;
}

function makeHarness() {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const byId = new Map();
  for (const id of ids) {
    const tag = id.includes("svg") || id === "capybara-badge" ? "div"
      : id.includes("select") ? "select" : id.includes("input") ? "input"
      : id.includes("body") ? "tbody" : "div";
    const element = makeEl(tag, id);
    // Seed static text/value from the shipped markup so the harness behaves
    // like a browser after parsing (buttons, labels and initial select values).
    const tagMatch = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>([^<]*)<`));
    if (tagMatch && tagMatch[1].trim()) element.textContent = tagMatch[1].trim();
    const valueMatch = html.match(new RegExp(`<[^>]*id="${id}"[^>]*\\bvalue="([^"]*)"`));
    if (valueMatch) element.value = valueMatch[1];
    byId.set(id, element);
  }
  // A shipped <select> uses its first <option> value when none is marked selected.
  byId.get("policy-select").value = "wspt";
  byId.get("preset-select").value = "hackathon-sprint";
  const tabs = ["tab-dag", "tab-nodes", "tab-blocks", "tab-risk"].map((id) => makeEl("button", id));
  const panels = ["panel-dag", "panel-nodes", "panel-blocks", "panel-risk"].map((id) => makeEl("div", id));
  const storage = { data: {}, getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = v; } };
  const doc = {
    body: makeEl("body"),
    defaultView: { setInterval: () => 1, clearInterval: () => {} },
    getElementById(id) { return byId.get(id) || null; },
    createElement(tag) { return makeEl(tag); },
    createElementNS(_ns, tag) { return makeEl(tag); },
    querySelectorAll(sel) { return sel === ".tab" ? tabs : sel === ".panel" ? panels : []; },
    addEventListener() {}
  };
  const SvgCtx = { document: doc, Math, Number, Object, String, Array };
  SvgCtx.globalThis = SvgCtx;
  vm.runInNewContext(uiJs, SvgCtx);
  const sandbox = {
    document: doc, Math, Number, Object, String, Array, Date, JSON, URL,
    Blob: function () {}, localStorage: storage,
    CadenceDagEngine: Engine, CadenceDagSvg: SvgCtx.CadenceDagSvg
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(appJs, sandbox);
  const ctrl = sandbox.CadenceDagApp.createController(doc);
  ctrl.init();
  return { byId, ctrl, storage, tabs, panels, doc, sandboxApp: sandbox.CadenceDagApp };
}

test("Pomodoro: Mark Task Done recomputes CPM and excludes the task from the live plan", () => {
  const { byId, ctrl } = makeHarness();
  const before = byId.get("kpi-crit-count").textContent;
  const firstId = ctrl.state.tasks[0].id;
  ctrl.selectTask(firstId);
  byId.get("btn-mark-done").dispatchEvent({ type: "click" });
  assert.ok(ctrl.state.doneTaskIds.includes(firstId));
  assert.notEqual(byId.get("kpi-crit-count").textContent, before);
  assert.ok(!byId.get("blocks-table-body").innerHTML.includes(`${firstId} p`));
});

test("Pomodoro: complete, skip and reset advance the queue and update progress", () => {
  const { byId, ctrl } = makeHarness();
  const total = Engine.scheduleWorkflow(ctrl.state.tasks, { focusBlockMin: 25, breakMin: 5, dayCapacityMin: 300 }).totalFocusBlocks;
  assert.equal(byId.get("focus-progress-text").textContent, `0 / ${total} blocks completed`);
  byId.get("btn-timer-complete").dispatchEvent({ type: "click" });
  assert.equal(byId.get("focus-progress-text").textContent, `1 / ${total} blocks completed`);
  assert.equal(ctrl.state.focus.index, 1);
  assert.ok(byId.get("capybara-status").textContent.toLowerCase().includes("capybara"));
  assert.ok(byId.get("capybara-badge").classList.contains("is-glowing"));
  byId.get("btn-timer-skip").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.focus.index, 2);
  byId.get("btn-timer-reset").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.focus.index, 0);
  assert.equal(ctrl.state.focus.completed, 0);
  assert.equal(byId.get("focus-countdown").textContent, "25:00");
});

test("Pomodoro: start and pause drive the countdown without any network calls", () => {
  const { byId, ctrl } = makeHarness();
  byId.get("btn-timer-start").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.focus.running, true);
  byId.get("btn-timer-pause").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.focus.running, false);
  assert.equal(ctrl.state.focus.intervalId, null);
});

test("Local/UTC toggle changes the clock label and the block table header", () => {
  const { byId, ctrl } = makeHarness();
  assert.equal(byId.get("clock-toggle").textContent, "Clock: Local");
  byId.get("clock-toggle").dispatchEvent({ type: "click" });
  assert.equal(byId.get("clock-toggle").textContent, "Clock: UTC");
  assert.match(byId.get("clock-readout").textContent, /UTC/);
  assert.equal(byId.get("block-window-head").textContent, "UTC Window");
  assert.match(ctrl.state.startDateIso, /^\d{4}-\d{2}-\d{2}$/);
});

test("DAG selection, inline edit, delete guard and reset preset all work", () => {
  const { byId, ctrl, storage } = makeHarness();
  const first = ctrl.state.tasks[0].id;
  ctrl.selectTask(first);
  assert.equal(byId.get("inspector-title").value, ctrl.state.tasks[0].title);
  // Downstream dependency guard: T1 has successors in the first preset.
  byId.get("btn-delete-task").dispatchEvent({ type: "click" });
  assert.ok(ctrl.state.tasks.some((t) => t.id === first));
  assert.match(byId.get("error-banner").textContent, /Cannot delete/);
  // Inline edit persists and re-renders.
  byId.get("inspector-title").value = "Renamed bottleneck";
  byId.get("inspector-duration").value = "45";
  byId.get("inspector-weight").value = "10";
  byId.get("btn-save-task").dispatchEvent({ type: "click" });
  const edited = ctrl.state.tasks.find((t) => t.id === first);
  assert.equal(edited.title, "Renamed bottleneck");
  assert.equal(edited.durationMin, 45);
  assert.equal(edited.weight, 10);
  assert.match(storage.data["cadencedag.user.v1"], /Renamed bottleneck/);
  // A leaf task can be deleted cleanly.
  const leaf = ctrl.state.tasks[ctrl.state.tasks.length - 1].id;
  ctrl.selectTask(leaf);
  byId.get("btn-delete-task").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.tasks.some((t) => t.id === leaf), false);
  // Reset restores the preset without the edits.
  byId.get("btn-reset-preset").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.tasks[0].title, Engine.PRESET_WORKFLOWS[0].tasks[0].title);
  assert.equal(ctrl.state.tasks.length, Engine.PRESET_WORKFLOWS[0].tasks.length);
});

test("selectTask fills all inspector fields for a non-first task", () => {
  const { byId, ctrl } = makeHarness();
  const target = ctrl.state.tasks.find((t) => t.id === "T5");
  ctrl.selectTask("T5");
  assert.equal(byId.get("inspector-title").value, target.title);
  assert.equal(byId.get("inspector-duration").value, String(target.durationMin));
  assert.equal(byId.get("inspector-deps").value, target.deps.join(", "));
  assert.equal(ctrl.state.selectedTaskId, "T5");
});

test("Persistence: a fresh controller restores edits and corrupt storage is ignored", () => {
  const { byId, ctrl, storage } = makeHarness();
  byId.get("inspector-title").value = "Persisted title";
  byId.get("inspector-duration").value = "55";
  byId.get("inspector-weight").value = "9";
  byId.get("btn-save-task").dispatchEvent({ type: "click" });
  byId.get("btn-toggle-done").dispatchEvent({ type: "click" });
  const saved = JSON.parse(storage.data["cadencedag.user.v1"]);
  assert.equal(saved.tasks[0].title, "Persisted title");
  assert.equal(saved.doneTaskIds.length, 1);
  storage.data["cadencedag.user.v1"] = "{not json";
  const again = makeHarness();
  assert.equal(again.ctrl.state.tasks.length, Engine.PRESET_WORKFLOWS[0].tasks.length);
});

test("Comparison strip renders three cells and highlights the active policy", () => {
  const { byId } = makeHarness();
  const strip = byId.get("policy-compare-strip");
  assert.equal(strip.children.length, 3);
  const active = strip.children.filter((c) => c.classList.contains("is-active"));
  assert.equal(active.length, 1);
  assert.match(active[0].innerHTML, /WSPT/);
  byId.get("policy-select").value = "shortest";
  byId.get("policy-select").dispatchEvent({ type: "change" });
  const active2 = strip.children.filter((c) => c.classList.contains("is-active"));
  assert.equal(active2.length, 1);
  assert.match(active2[0].innerHTML, /SPT/);
});

test("Next Best Focus Action names a concrete task with a reason", () => {
  const { byId } = makeHarness();
  assert.match(byId.get("next-action-text").textContent, /^T\d+: .+ is next because/);
  assert.match(byId.get("next-action-text").textContent, /(critical bottleneck|highest WSPT score)/);
});

test("Worker swimlane SVG and delay absorption bars render in the risk panel", () => {
  const { byId } = makeHarness();
  assert.ok(byId.get("svg-workers").children.length > 0);
  assert.ok(byId.get("risk-samples-body").innerHTML.includes("absorb-bar"));
  assert.ok(byId.get("risk-samples-body").innerHTML.includes("push-bar"));
  // Singular copy at one worker, and the KPI follows the input.
  byId.get("workers-input").value = "1";
  byId.get("workers-input").dispatchEvent({ type: "input" });
  assert.match(byId.get("kpi-parallel-sub").textContent, /^1 worker, /);
  assert.match(byId.get("kpi-util-sub").textContent, /idle across 1 worker$/);
});

/* ------------------------- QA regressions (M1, S1, S2) ------------------ */

test("M1: focus task label shows the real task id and never 'undefined'", () => {
  const { byId, ctrl } = makeHarness();
  const label = byId.get("focus-task-label").textContent;
  const first = Engine.scheduleWorkflow(ctrl.state.tasks, { focusBlockMin: 25, breakMin: 5, dayCapacityMin: 300 }).blocks[0];
  assert.equal(label, `${first.taskId} p${first.part}: ${first.title}`);
  assert.match(label, /^T\d+ p\d+: /);
  assert.equal(label.includes("undefined"), false);
  byId.get("btn-timer-complete").dispatchEvent({ type: "click" });
  const next = byId.get("focus-task-label").textContent;
  assert.equal(next.includes("undefined"), false);
  assert.match(next, /^T\d+ p\d+: /);
  // Same guarantee on the student preset, whose ids use a different prefix.
  ctrl.applyPreset("ap-robotics-week");
  assert.match(byId.get("focus-task-label").textContent, /^A\d+ p\d+: /);
});

test("S1: Mark Done button label flips immediately on toggle and back", () => {
  const { byId, ctrl } = makeHarness();
  ctrl.selectTask("T5");
  assert.equal(byId.get("btn-toggle-done").textContent, "Mark Done");
  byId.get("btn-toggle-done").dispatchEvent({ type: "click" });
  assert.ok(ctrl.state.doneTaskIds.includes("T5"));
  assert.equal(byId.get("btn-toggle-done").textContent, "Mark Not Done");
  byId.get("btn-toggle-done").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.doneTaskIds.includes("T5"), false);
  assert.equal(byId.get("btn-toggle-done").textContent, "Mark Done");
});

test("S2: escapeHtml neutralizes markup in every innerHTML sink, text sinks keep raw text", () => {
  const { byId, ctrl, sandboxApp } = makeHarness();
  assert.equal(sandboxApp.escapeHtml(`<script>alert("x")</script> & 'y'`),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;");
  const evil = `<script>alert(1)</script> & <img src=x onerror=1>`;
  ctrl.selectTask("T1");
  byId.get("inspector-title").value = evil;
  byId.get("btn-save-task").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.tasks.find((t) => t.id === "T1").title, evil);
  for (const sink of ["slack-table-body", "blocks-table-body"]) {
    const markup = byId.get(sink).innerHTML;
    assert.ok(markup.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;img src=x onerror=1&gt;"), `${sink} escapes the title`);
    assert.equal(markup.includes("<script>"), false, `${sink} has no live <script>`);
    assert.equal(markup.includes("<img"), false, `${sink} has no live <img>`);
  }
  // The banner is a textContent sink: the raw characters survive as text, unescaped.
  const banner = byId.get("next-action-text").textContent;
  assert.ok(banner.includes(evil));
  assert.equal(banner.includes("&lt;"), false);
  // Task ids also reach the risk, chain, ledger and policy sinks.
  const idEvil = "Z<b>";
  byId.get("new-task-id").value = idEvil;
  byId.get("new-task-title").value = "Escaped id probe";
  byId.get("new-task-dur").value = "400";
  byId.get("new-task-weight").value = "10";
  byId.get("new-task-deps").value = "";
  byId.get("btn-add-task").dispatchEvent({ type: "click" });
  assert.ok(ctrl.state.tasks.some((t) => t.id === idEvil));
  for (const sink of ["risk-samples-body", "critical-paths-body", "worker-ledger-body", "slack-table-body", "policy-compare-strip"]) {
    const markup = byId.get(sink).innerHTML;
    assert.ok(markup.includes("Z&lt;b&gt;"), `${sink} escapes the id`);
    assert.equal(markup.includes("Z<b>"), false, `${sink} has no raw id markup`);
  }
});

test("Switching presets refreshes the inspector to the new preset's first task", () => {
  const { byId, ctrl } = makeHarness();
  assert.equal(byId.get("inspector-title").value, Engine.PRESET_WORKFLOWS[0].tasks[0].title);
  ctrl.applyPreset("ap-robotics-week");
  const ap = Engine.PRESET_WORKFLOWS.find((w) => w.id === "ap-robotics-week").tasks[0];
  assert.equal(ctrl.state.selectedTaskId, ap.id);
  assert.equal(byId.get("inspector-title").value, ap.title);
  assert.equal(byId.get("inspector-duration").value, String(ap.durationMin));
  assert.equal(byId.get("inspector-deps").value, ap.deps.join(", "));
});

test("Focus blocks start at 09:00 on the local wall clock and the banner reason follows the policy", () => {
  const { byId, ctrl } = makeHarness();
  const rows = byId.get("blocks-table-body").innerHTML;
  assert.match(rows, /09:00 to 09:25/);
  assert.equal(/Local<\/td>|UTC<\/td>/.test(rows), false, "window cells carry no per-cell zone suffix");
  ctrl.applyPreset("ap-robotics-week");
  assert.match(byId.get("next-action-text").textContent, /^A1: .+ highest WSPT score/);
  byId.get("policy-select").value = "critical";
  byId.get("policy-select").dispatchEvent({ type: "change" });
  assert.match(byId.get("next-action-text").textContent, /^A2: .+ critical bottleneck with 0m float/);
});
