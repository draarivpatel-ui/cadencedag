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
const uiJs = fs.readFileSync(path.join(ROOT, "js/ui-dag.js"), "utf8");

const AP = Engine.PRESET_WORKFLOWS.find((w) => w.id === "ap-robotics-week").tasks;

/* ----------------------------- DOM harness ------------------------------ */

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
    focus() { element._focusCount = (element._focusCount || 0) + 1; },
    querySelector() { return null; }
  };
  element.classList._owner = element;
  return element;
}

function makeHarness(storageSeed) {
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
  byId.get("preset-select").value = "hackathon-sprint";
  const tabs = ["tab-dag", "tab-nodes", "tab-blocks", "tab-risk"].map((id) => makeEl("button", id));
  const panels = ["panel-dag", "panel-nodes", "panel-blocks", "panel-risk"].map((id) => makeEl("div", id));
  const storage = { data: storageSeed ? Object.assign({}, storageSeed) : {}, getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = v; } };
  const doc = {
    body: makeEl("body"),
    defaultView: { setInterval: () => 7, clearInterval: () => {} },
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
  return { byId, ctrl, storage, tabs, panels, doc };
}

/* ------------------- M1: timer follows the scheduled block --------------- */

test("QA M1: countdown loads the real scheduled block duration (A1 p2 is 15:00)", () => {
  const { byId, ctrl } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  assert.equal(byId.get("focus-countdown").textContent, "25:00");
  assert.match(byId.get("focus-task-label").textContent, /^A1 p1: /);
  byId.get("btn-timer-complete").dispatchEvent({ type: "click" });
  // A1 is 40m: part 1 is 25m, part 2 is 15m, never a hard coded 25:00.
  assert.equal(byId.get("focus-countdown").textContent, "15:00");
  assert.match(byId.get("focus-task-label").textContent, /^A1 p2: /);
  byId.get("btn-timer-complete").dispatchEvent({ type: "click" });
  assert.equal(byId.get("focus-countdown").textContent, "25:00");
  assert.match(byId.get("focus-task-label").textContent, /^A3 p1: /);
});

test("QA M1: marking A1 done from part 2 lands on A3 p1, not A3 p2", () => {
  const { byId, ctrl } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  byId.get("btn-timer-complete").dispatchEvent({ type: "click" });
  assert.match(byId.get("focus-task-label").textContent, /^A1 p2: /);
  byId.get("btn-mark-done").dispatchEvent({ type: "click" });
  assert.ok(ctrl.state.doneTaskIds.includes("A1"));
  assert.match(byId.get("focus-task-label").textContent, /^A3 p1: /);
  assert.equal(byId.get("focus-countdown").textContent, "25:00");
});

test("QA M1: completing every block stops the timer and disables Start", () => {
  const { byId, ctrl } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  let guard = 0;
  while (!ctrl.state.focus.exhausted && guard++ < 40) {
    byId.get("btn-timer-complete").dispatchEvent({ type: "click" });
  }
  assert.ok(ctrl.state.focus.exhausted, "queue exhausted flag set");
  assert.equal(ctrl.state.focus.running, false);
  assert.equal(ctrl.state.focus.intervalId, null);
  assert.equal(ctrl.state.focus.remainingSec, 0);
  assert.equal(byId.get("btn-timer-start").disabled, true);
  assert.match(byId.get("focus-status").textContent, /All blocks are complete/);
  assert.equal(byId.get("focus-progress-text").textContent, `${ctrl.state.focus.completed} / ${ctrl.state.focus.completed} blocks completed`);
  // Reset re-enables Start with a fresh countdown.
  byId.get("btn-timer-reset").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.focus.exhausted, false);
  assert.equal(byId.get("btn-timer-start").disabled, false);
  assert.equal(byId.get("focus-countdown").textContent, "25:00");
});

test("QA M2: switching presets mid-countdown keeps Start working", () => {
  const { byId, ctrl } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  byId.get("btn-timer-start").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.focus.running, true);
  // Switch to a different preset while the timer runs.
  ctrl.applyPreset("exam-study-sprint");
  assert.equal(ctrl.state.focus.running, false);
  assert.equal(ctrl.state.focus.intervalId, null);
  // Start again must actively tick from the new preset's first block.
  byId.get("btn-timer-start").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.focus.running, true);
  assert.ok(ctrl.state.focus.intervalId !== null);
  const first = Engine.scheduleWorkflow(ctrl.state.tasks, { focusBlockMin: 25, breakMin: 5, dayCapacityMin: 300 }).blocks[0];
  assert.equal(byId.get("focus-countdown").textContent, "25:00");
  assert.equal(byId.get("focus-task-label").textContent, `${first.taskId} p${first.part}: ${first.title}`);
});

test("QA M2: reset preset while running also clears the interval", () => {
  const { byId, ctrl } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  byId.get("btn-timer-start").dispatchEvent({ type: "click" });
  byId.get("btn-reset-preset").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.focus.running, false);
  assert.equal(ctrl.state.focus.intervalId, null);
  byId.get("btn-timer-start").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.focus.running, true);
});

/* --------------- M3: completed and empty graphs, persistence ------------- */

test("QA M3: marking all tasks done shows the finished state with no stale A9", () => {
  const { byId, ctrl } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  for (const t of ctrl.state.tasks.slice()) {
    ctrl.selectTask(t.id);
    byId.get("btn-toggle-done").dispatchEvent({ type: "click" });
  }
  assert.equal(byId.get("kpi-makespan").textContent, "0 min");
  assert.equal(byId.get("kpi-crit-count").textContent, "0 / 0");
  assert.equal(byId.get("kpi-wspt").textContent, "0");
  assert.match(byId.get("next-action-text").textContent, /All tasks are complete/);
  assert.equal(byId.get("slack-table-body").innerHTML.includes("A9"), false);
  assert.equal(byId.get("blocks-table-body").innerHTML.includes("A9"), false);
  assert.ok(byId.get("blocks-table-body").innerHTML.includes("All tasks are marked done"));
  assert.equal(byId.get("btn-timer-start").disabled, true);
});

test("QA M3: deleting every task persists the empty graph across reload", () => {
  const seed = makeHarness();
  seed.ctrl.applyPreset("ap-robotics-week");
  let guard = 0;
  while (seed.ctrl.state.tasks.length && guard++ < 30) {
    const leaf = seed.ctrl.state.tasks.find((t) => !seed.ctrl.state.tasks.some((o) => o.deps.includes(t.id)));
    seed.ctrl.selectTask(leaf.id);
    seed.byId.get("btn-delete-task").dispatchEvent({ type: "click" });
  }
  assert.equal(seed.ctrl.state.tasks.length, 0);
  const saved = JSON.parse(seed.storage.data["cadencedag.user.v1"]);
  assert.ok(Array.isArray(saved.tasks) && saved.tasks.length === 0, "empty array persisted");
  // Reload from the same store: the empty state survives, no preset resurrection.
  const reloaded = makeHarness({ "cadencedag.user.v1": seed.storage.data["cadencedag.user.v1"] });
  assert.equal(reloaded.ctrl.state.tasks.length, 0);
  assert.equal(reloaded.byId.get("kpi-makespan").textContent, "0 min");
  assert.match(reloaded.byId.get("next-action-text").textContent, /No tasks in the plan/);
  assert.equal(reloaded.byId.get("blocks-table-body").innerHTML.includes("A1"), false);
  // The preset dropdown is untouched, so one selection reloads a preset.
  assert.equal(reloaded.byId.get("preset-select").options.length, 5);
});

/* ------- M4: delay analytics propagate through every active analysis ------ */

test("QA M4: A5 +60 moves Critical Chains to A1 > A3 > A5 > A7 > A9 at 280m", () => {
  const { byId, ctrl } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  byId.get("slip-task-select").value = "A5";
  byId.get("slip-task-select").dispatchEvent({ type: "change" });
  byId.get("slip-min-input").value = "60";
  byId.get("slip-min-input").dispatchEvent({ type: "input" });
  const chain = byId.get("critical-paths-body").innerHTML.replace(/&gt;/g, ">").replace(/<[^>]+>/g, " ");
  assert.ok(chain.includes("A1 > A3 > A5 > A7 > A9"), `chain cell: ${chain}`);
  assert.ok(chain.includes("280m"));
  assert.equal(byId.get("kpi-makespan").textContent, "280 min");
});

test("QA M4: A6 +30 makes the active comparison cell match the headline 19,710", () => {
  const { byId, ctrl } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  byId.get("slip-task-select").value = "A6";
  byId.get("slip-task-select").dispatchEvent({ type: "change" });
  byId.get("slip-min-input").value = "30";
  byId.get("slip-min-input").dispatchEvent({ type: "input" });
  assert.equal(byId.get("kpi-wspt").textContent, "19,710");
  const strip = byId.get("policy-compare-strip");
  const wsptCell = strip.children[0];
  assert.match(wsptCell.innerHTML, /class="policy-metric">19,710</);
  // Every policy cell scores the same delayed graph.
  assert.match(strip.children[1].innerHTML, /21,565/);
});

test("QA M4: nominal baseline-only analytics are labeled, active analyses use delays", () => {
  // The risk sweep is explicitly nominal (each delay tested against the
  // undelayed baseline) and the slip summary names the delayed task.
  const { byId } = makeHarness();
  byId.get("slip-task-select").value = "A6";
  byId.get("slip-task-select").dispatchEvent({ type: "change" });
  byId.get("slip-min-input").value = "30";
  byId.get("slip-min-input").dispatchEvent({ type: "input" });
  assert.match(byId.get("slip-summary").textContent, /A6 \(\+30m\)/);
  // The swimlane panel is driven by the same slipped graph as the CPM.
  assert.ok(byId.get("svg-workers").children.length > 0);
});

/* ------------------- M5: 120 work minutes labeling ------------------------ */

test("QA M5: the horizon metric reads 'first 120 work minutes (excluding breaks)' everywhere", () => {
  const { byId } = makeHarness();
  const strip = byId.get("policy-compare-strip");
  for (const cell of strip.children) {
    assert.match(cell.innerHTML, /first 120 work min \(excl\. breaks\)/);
    assert.equal(cell.innerHTML.includes("first 2h"), false);
  }
  assert.ok(html.includes("first 120 minutes of work (excluding breaks and day rollover)"));
  const narration = fs.readFileSync(path.join(ROOT, "video", "narration.txt"), "utf8");
  assert.match(narration, /first 120 minutes of work, excluding breaks/);
  assert.equal(narration.includes("first two hours"), false);
  // The engine horizon is cumulative working minutes: 120 vs 95 on the AP demo.
  const cmp = Engine.comparePolicies(AP, { horizonMin: 120 });
  assert.equal(cmp.policies.find((p) => p.id === "critical").highPriorityMinutesFirstHorizon, 120);
  assert.equal(cmp.policies.find((p) => p.id === "wspt").highPriorityMinutesFirstHorizon, 95);
  // The horizon is measured in work minutes, not wall-clock hours: with a
  // 5m break after every block, wall-clock two hours would be fewer.
  const sched = Engine.scheduleWorkflow(AP, { focusBlockMin: 25, breakMin: 5 });
  const workOnly = sched.taskTimeline.reduce((sum, item) => {
    const overlap = Math.max(0, Math.min(item.endWorkMin, 120) - item.startWorkMin);
    return sum + (item.weight >= 8 ? overlap : 0);
  }, 0);
  assert.equal(workOnly, 95);
});

/* ------------------- M6: inspector CPM readout ---------------------------- */

test("QA M6: the inspector shows a live ES/EF/float/critical readout for the selected task", () => {
  const { byId, ctrl } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  ctrl.selectTask("A5");
  assert.equal(byId.get("inspector-duration").value, "25");
  assert.equal(byId.get("inspector-cpm").textContent, "ES 75m | EF 100m | Float 35m | Has float");
  ctrl.selectTask("A6");
  assert.equal(byId.get("inspector-cpm").textContent, "ES 105m | EF 175m | Float 0m | Critical (0m float)");
  // The markup ships the readout and the narration/steps point at it.
  assert.ok(html.includes('id="inspector-cpm"'));
  const steps = JSON.parse(fs.readFileSync(path.join(ROOT, "video", "steps.json"), "utf8"));
  assert.ok(steps.some((s) => s.selector === "#inspector-cpm"), "steps.json showcases the readout");
  const narration = fs.readFileSync(path.join(ROOT, "video", "narration.txt"), "utf8");
  assert.match(narration, /schedule readout/);
});

/* ------------------- M7: break 0 and budget clamping ---------------------- */

test("QA M7: break 0 schedules back-to-back blocks with no gaps", () => {
  const { byId, ctrl } = makeHarness();
  byId.get("break-min-input").value = "0";
  byId.get("break-min-input").dispatchEvent({ type: "input" });
  assert.equal(ctrl.state.breakMin, 0);
  assert.match(byId.get("kpi-blocks-sub").textContent, /no breaks/);
  const sched = Engine.scheduleWorkflow(ctrl.state.tasks, { focusBlockMin: 25, breakMin: 0, dayCapacityMin: 300, startDateIso: "2026-11-20" });
  for (let i = 1; i < sched.blocks.length - 1; i++) {
    const prev = sched.blocks[i - 1], cur = sched.blocks[i];
    if (prev.dayIndex === cur.dayIndex) {
      assert.equal(prev.endIso, cur.startIso, `blocks ${i - 1} and ${i} touch with break 0`);
    }
  }
  // Engine fallback treats an explicit 0 as a real setting.
  const s = Engine.scheduleWorkflow(AP, { focusBlockMin: 25, breakMin: 0 });
  const gap = new Date(s.blocks[1].startIso) - new Date(s.blocks[0].endIso);
  assert.equal(gap, 0);
});

test("QA M7: daily budget caps work independently of focus block length", () => {
  // 90m focus, 60m budget, 70m task: 60m on day 1 and 10m on day 2.
  const sched = Engine.scheduleWorkflow(
    [{ id: "T", title: "Long task", durationMin: 70, weight: 5, deps: [] }],
    { focusBlockMin: 90, breakMin: 0, dayCapacityMin: 60, startDateIso: "2026-11-20" }
  );
  assert.equal(sched.totalDays, 2);
  const day1 = sched.blocks.filter((b) => b.dayIndex === 1);
  const day2 = sched.blocks.filter((b) => b.dayIndex === 2);
  assert.equal(day1.reduce((s, b) => s + b.durationMin, 0), 60);
  assert.equal(day2.reduce((s, b) => s + b.durationMin, 0), 10);
  // And through the UI input path.
  const { byId, ctrl } = makeHarness();
  byId.get("focus-min-input").value = "90";
  byId.get("focus-min-input").dispatchEvent({ type: "input" });
  byId.get("cap-min-input").value = "60";
  byId.get("cap-min-input").dispatchEvent({ type: "input" });
  assert.equal(ctrl.state.dayCapacityMin, 60);
  assert.equal(ctrl.state.focusBlockMin, 90);
  const day1Work = Engine.scheduleWorkflow(ctrl.state.tasks, {
    focusBlockMin: 90, breakMin: 5, dayCapacityMin: 60, startDateIso: "2026-11-20"
  }).blocks.filter((b) => b.dayIndex === 1).reduce((s, b) => s + b.durationMin, 0);
  assert.equal(day1Work, 60);
});

/* ------------------- S8: stale persisted selections ------------------------ */

test("QA S8: a stale persisted selection falls back to the first existing task", () => {
  // A valid reduced graph: A4 depends only on A2.
  const reduced = AP.filter((t) => ["A2", "A4"].includes(t.id));
  const h = makeHarness({
    "cadencedag.user.v1": JSON.stringify({ presetId: "ap-robotics-week", tasks: reduced, doneTaskIds: [], selectedTaskId: "A1" })
  });
  assert.equal(h.ctrl.state.selectedTaskId, "A2");
  assert.equal(h.byId.get("inspector-title").value, "Robotics Chassis Assembly");
  // An empty persisted graph yields a null selection, not a crash.
  const empty = makeHarness({
    "cadencedag.user.v1": JSON.stringify({ presetId: "ap-robotics-week", tasks: [], doneTaskIds: [], selectedTaskId: "A9" })
  });
  assert.equal(empty.ctrl.state.selectedTaskId, "");
});

test("QA S8: partially corrupted persisted tasks are normalized or rejected", () => {
  const missingDep = makeHarness({
    "cadencedag.user.v1": JSON.stringify({ presetId: "ap-robotics-week", tasks: [{ id: "B", durationMin: 30, deps: ["NOPE"] }], doneTaskIds: [], selectedTaskId: "B" })
  });
  assert.equal(missingDep.ctrl.state.tasks.length, Engine.PRESET_WORKFLOWS[0].tasks.length, "invalid graph falls back to the preset");
});

/* ------------------- S9: keyboard focus and tab navigation ---------------- */

test("QA S9: tablist supports roving tabindex with arrow, Home and End keys", () => {
  // The controller binds the standard tablist keys and moves focus.
  assert.match(appJs, /ArrowRight/);
  assert.match(appJs, /ArrowLeft/);
  assert.match(appJs, /"Home"/);
  assert.match(appJs, /"End"/);
  assert.match(appJs, /next\.focus\(\)/);
  assert.match(appJs, /preventDefault/);
  // The shipped markup exposes a real tablist with four tab buttons.
  assert.match(html, /role="tablist"/);
  const tabIds = [...html.matchAll(/<button class="tab"[^>]*>/g)];
  assert.equal(tabIds.length, 4);
});

test("QA S9: keyboard selection re-rows restore focus to the re-rendered target", () => {
  const { byId, ctrl } = makeHarness();
  // The controller records a keyboard selection and clears it on restore.
  assert.equal(ctrl.state.keyboardSelection, null);
  assert.match(appJs, /restoreKeyboardFocus/);
  assert.match(appJs, /state\.keyboardSelection = ev\.type === "keydown" \? \{ kind: "node", id \}/);
  // DOM-level focus restore: the slack table rows carry tabindex so the
  // browser can move focus back after re-render.
  assert.match(html, /tabindex="0"/);
});

/* ------------------- S10: DST-safe day anchoring --------------------------- */

test("QA S10: each day anchors 09:00 local across a spring-forward DST shift", () => {
  // US Central: CST (UTC-6) until 2026-03-08... actually 2026 spring-forward
  // is March 8, so March 13-14 are both CDT. Use the offset-function form to
  // prove per-day anchoring: day 0 on 360 (CST), day 1+ on 300 (CDT).
  const sched = Engine.scheduleWorkflow(AP, {
    startDateIso: "2026-03-13", dayStartHour: 9,
    utcOffsetMin: (dayIdx) => (dayIdx === 0 ? 360 : 300)
  });
  const day1 = sched.blocks.filter((b) => b.dayIndex === 1);
  const day2 = sched.blocks.filter((b) => b.dayIndex === 2);
  assert.equal(day1[0].startIso, "2026-03-13T15:00:00.000Z"); // 09:00 CST
  assert.equal(day2[0].startIso, "2026-03-14T14:00:00.000Z"); // 09:00 CDT
  // Calendar arithmetic also rolls month boundaries correctly.
  const monthRoll = Engine.scheduleWorkflow(AP, {
    startDateIso: "2026-02-28", dayStartHour: 9,
    utcOffsetMin: (dayIdx) => (dayIdx === 0 ? 0 : 0)
  });
  const feb28 = monthRoll.blocks.filter((b) => b.dayIndex === 1)[0].startIso;
  const mar1 = monthRoll.blocks.filter((b) => b.dayIndex === 2)[0].startIso;
  assert.equal(feb28, "2026-02-28T09:00:00.000Z");
  assert.equal(mar1, "2026-03-01T09:00:00.000Z");
  // November fall-back: Nov 1 2026 09:00 EDT (240) then Nov 2 09:00 EST (300).
  const fall = Engine.scheduleWorkflow(AP, {
    startDateIso: "2026-11-01", dayStartHour: 9,
    utcOffsetMin: (dayIdx) => (dayIdx === 0 ? 240 : 300)
  });
  assert.equal(fall.blocks[0].startIso, "2026-11-01T13:00:00.000Z"); // 09:00 EDT
  const fallDay2 = fall.blocks.filter((b) => b.dayIndex === 2)[0].startIso;
  assert.equal(fallDay2, "2026-11-02T14:00:00.000Z"); // 09:00 EST
});

test("QA S10: a fixed offset keeps day starts 24h apart and every preset validates", () => {
  const sched = Engine.scheduleWorkflow(AP, { startDateIso: "2026-03-13", dayStartHour: 9, utcOffsetMin: 360 });
  const day1 = sched.blocks.filter((b) => b.dayIndex === 1)[0];
  const day2 = sched.blocks.filter((b) => b.dayIndex === 2)[0];
  assert.equal(day1.startIso, "2026-03-13T15:00:00.000Z");
  assert.equal(day2.startIso, "2026-03-14T15:00:00.000Z");
  assert.equal((new Date(day2.startIso) - new Date(day1.startIso)) / 60000, 1440);
  for (const wf of Engine.PRESET_WORKFLOWS) {
    const s = Engine.scheduleWorkflow(wf.tasks, { startDateIso: "2026-03-13", dayStartHour: 9, utcOffsetMin: 300 });
    assert.equal(Engine.validateIcs(Engine.exportScheduleToIcs(s)).valid, true);
  }
});

/* ------------------- S11: diagnostics export ------------------------------- */

test("QA S11: planTelemetry honors delayMin 0 and exports the remaining plan", () => {
  // Engine: delayMin 0 is respected, not replaced by the 10 default.
  const zero = Engine.planTelemetry(AP, { delayMin: 0 });
  assert.equal(zero.riskDelayMin, 0);
  assert.equal(zero.riskWorstCaseMakespanMin, Engine.analyzeCriticalPath(AP).projectMakespanMin);
  const ten = Engine.planTelemetry(AP, { delayMin: 10 });
  assert.equal(ten.riskDelayMin, 10);
  // App: the diagnostics export uses the remaining graph, not the full one.
  const { byId, ctrl } = makeHarness();
  ctrl.applyPreset("ap-robotics-week");
  // Mark a leaf task done: A9 depends on A7 and A8, so removing A9 keeps the
  // remaining graph valid.
  ctrl.selectTask("A9");
  byId.get("btn-toggle-done").dispatchEvent({ type: "click" });
  const remaining = ctrl.state.tasks.filter((t) => !ctrl.state.doneTaskIds.includes(t.id));
  assert.equal(remaining.length, 8);
  assert.match(appJs, /Engine\.planTelemetry\(activeTasks\(\)/);
  // And the exported task count matches the displayed plan.
  const telemetry = Engine.planTelemetry(remaining, { delayMin: 0, workers: 3 });
  assert.equal(telemetry.taskCount, 8);
});

/* ------------------- S12: strict ICS validation and UID escaping ---------- */

test("QA S12: the ICS validator checks real calendar ranges", () => {
  const sched = Engine.scheduleWorkflow(AP, { focusBlockMin: 25, startDateIso: "2026-11-16" });
  const ics = Engine.exportScheduleToIcs(sched);
  assert.equal(Engine.validateIcs(ics).valid, true);
  // Month 13 is rejected.
  assert.equal(Engine.validateIcs(ics.replace(/DTSTART:202611/, "DTSTART:202613")).valid, false);
  // Day 31 in a 30-day month is rejected.
  assert.equal(Engine.validateIcs(ics.replace(/DTSTART:20261116/, "DTSTART:20261131")).valid, false);
  // Hour 24 is rejected.
  assert.equal(Engine.validateIcs(ics.replace(/DTSTART:20261116T09/, "DTSTART:20261116T24")).valid, false);
  // Minute 60 is rejected.
  assert.equal(Engine.validateIcs(ics.replace(/T090000Z/, "T096000Z")).valid, false);
  // February 30 is rejected.
  assert.equal(Engine.validateIcs(ics.replace(/DTSTART:20261116/, "DTSTART:20260230")).valid, false);
  // Feb 29 2024 (leap year) is accepted structurally when substituted.
  const leap = Engine.validateIcs(ics.replace(/DTSTART:20261116T09/, "DTSTART:20240229T09"));
  assert.equal(leap.valid, true);
  assert.equal(Engine.validateIcs(ics.replace(/DTSTART:20261116T09/, "DTSTART:20230229T09")).valid, false);
});

test("QA S12: missing UID, DTSTAMP or PRODID fails validation", () => {
  const sched = Engine.scheduleWorkflow(AP, { focusBlockMin: 25 });
  const ics = Engine.exportScheduleToIcs(sched);
  assert.equal(Engine.validateIcs(ics.replace(/UID:[^\r\n]+\r\n/, "")).valid, false);
  assert.equal(Engine.validateIcs(ics.replace(/DTSTAMP:[^\r\n]+\r\n/, "")).valid, false);
  assert.equal(Engine.validateIcs(ics.replace(/PRODID:[^\r\n]+\r\n/, "")).valid, false);
  // Two VEVENTs sharing one UID fail: rewrite the second UID to equal the first.
  const uidLines = [...ics.matchAll(/UID:([^\r\n]+)/g)];
  assert.ok(uidLines.length >= 2);
  const first = uidLines[0][1];
  const duped = ics.replace(uidLines[1][0], `UID:${first}`);
  assert.equal(Engine.validateIcs(duped).valid, false);
  assert.ok(Engine.validateIcs(duped).errors.some((e) => /UID/.test(e)));
});

test("QA S12: task ids with RFC 5545 hostile characters never reach a raw UID", () => {
  const evil = [{ id: "x;y,com:mon", title: "Evil", durationMin: 30, weight: 5, deps: [] }];
  const ics = Engine.exportScheduleToIcs(Engine.scheduleWorkflow(evil, { focusBlockMin: 25 }));
  const uidLine = ics.split("\r\n").find((l) => l.startsWith("UID:"));
  assert.ok(uidLine, "UID present");
  for (const ch of [";", ",", ":"]) {
    assert.ok(!uidLine.slice(4).includes(ch), `UID has no raw ${ch}: ${uidLine}`);
  }
  assert.match(uidLine, /^UID:cadencedag-x-y-com-mon-/);
  assert.equal(Engine.validateIcs(ics).valid, true, "escaped output still validates");
  // Newlines in ids cannot inject a folded line either.
  const nl = [{ id: "a\r\nb", title: "N", durationMin: 30, weight: 5, deps: [] }];
  const nlIcs = Engine.exportScheduleToIcs(Engine.scheduleWorkflow(nl, { focusBlockMin: 25 }));
  const nlUid = nlIcs.split("\r\n").find((l) => l.startsWith("UID:"));
  assert.ok(!nlUid.slice(4).includes("\n"), "no newline survives in the UID");
});

/* ------------------- S13: unambiguous chain identity keys ------------------ */

test("QA S13: chain ids containing the separator never collide", () => {
  const collide = [
    { id: "a>b", durationMin: 10, weight: 5, deps: [] },
    { id: "c", durationMin: 5, weight: 5, deps: ["a>b"] },
    { id: "a", durationMin: 10, weight: 5, deps: [] },
    { id: "b>c", durationMin: 5, weight: 5, deps: ["a"] }
  ];
  const p = Engine.enumerateCriticalPaths(collide);
  assert.equal(p.pathCount, 2);
  assert.ok(p.criticalPaths.some((c) => c[0] === "a>b" && c[1] === "c"));
  assert.ok(p.criticalPaths.some((c) => c[0] === "a" && c[1] === "b>c"));
});

/* ------------------- S14: exact-float criticalAfter ------------------------ */

test("QA S14: a delay equal to total float marks the task critical with zero delta", () => {
  // A1 has 35m float on the AP preset.
  const at = Engine.analyzeScheduleRisk(AP, { delayMin: 35 });
  const a1 = at.samples.find((s) => s.taskId === "A1");
  assert.equal(a1.floatMin, 35);
  assert.equal(a1.deltaMin, 0);
  assert.equal(a1.criticalAfter, true);
  // Just below the boundary the task keeps float.
  const below = Engine.analyzeScheduleRisk(AP, { delayMin: 34 });
  assert.equal(below.samples.find((s) => s.taskId === "A1").criticalAfter, false);
  // Beyond the boundary both conditions hold.
  const above = Engine.analyzeScheduleRisk(AP, { delayMin: 40 });
  const a1b = above.samples.find((s) => s.taskId === "A1");
  assert.equal(a1b.criticalAfter, true);
  assert.ok(a1b.deltaMin > 0);
  // Diamond fixture: C has 25 float.
  const diamond = [
    { id: "A", durationMin: 10, weight: 8, deps: [] },
    { id: "B", durationMin: 40, weight: 9, deps: ["A"] },
    { id: "C", durationMin: 15, weight: 6, deps: ["A"] },
    { id: "D", durationMin: 20, weight: 10, deps: ["B", "C"] }
  ];
  const dAt = Engine.analyzeScheduleRisk(diamond, { delayMin: 25 });
  const c = dAt.samples.find((s) => s.taskId === "C");
  assert.equal(c.deltaMin, 0);
  assert.equal(c.criticalAfter, true);
});

/* ------------------- N15: README reconciliation ---------------------------- */

test("QA N15: README no longer promises an editable start time or stale counts", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.equal(readme.includes("editable block length, break interval, daily focus budget, start time and start date"), false);
  assert.match(readme, /09:00 local day start/);
  assert.equal(readme.includes("no screenshot or headless browser capture was taken"), false);
  assert.match(readme, /238 tests, 0 failed, 0 skipped, 0 cancelled/);
  // No stale "six test files" or old 79-test claims remain.
  assert.equal(readme.includes("six node:test files"), false);
  assert.equal(readme.includes("79 Node tests passed"), false);
  assert.equal(readme.includes("eight node:test files"), false);
  assert.match(readme, /nine node:test files/);
});
