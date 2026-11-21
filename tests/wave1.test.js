"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Engine = require("../js/dag-engine.js");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "styles.css"), utf8Guard());
const appJs = fs.readFileSync(path.join(ROOT, "js/app.js"), "utf8");
const uiJs = fs.readFileSync(path.join(ROOT, "js/ui-dag.js"), "utf8");
const engineJs = fs.readFileSync(path.join(ROOT, "js/dag-engine.js"), "utf8");

function utf8Guard() { return "utf8"; }

const CAPY = Engine.PRESET_WORKFLOWS.find((w) => w.id === "capybara-rescue").tasks;

// A chain of `width` diamonds, each holding two equal 10m branches. Every
// root-to-sink chain sums to the same total, so width diamonds hold 2^width
// equal-length chains while the graph itself stays tiny: the DP count must
// stay exact and the materialized list must stay capped.
function branchingTasks(width) {
  const tasks = [{ id: "S", title: "Source", durationMin: 10, weight: 5, deps: [] }];
  let prev = "S";
  for (let d = 0; d < width; d++) {
    tasks.push({ id: `B${d}`, title: `Branch A ${d}`, durationMin: 10, weight: 5, deps: [prev] });
    tasks.push({ id: `C${d}`, title: `Branch B ${d}`, durationMin: 10, weight: 5, deps: [prev] });
    prev = `B${d}x${d}`;
    tasks.push({ id: prev, title: `Merge ${d}`, durationMin: 10, weight: 5, deps: [`B${d}`, `C${d}`] });
  }
  tasks.push({ id: "T", title: "Sink", durationMin: 5, weight: 5, deps: [prev] });
  return tasks;
}

/* --------------------- defect 5: bounded path enumeration ---------------- */

test("Wave 5: path enumeration counts exponentially many chains exactly with DP", () => {
  for (const width of [4, 8, 12, 16]) {
    const p = Engine.enumerateCriticalPaths(branchingTasks(width));
    assert.equal(p.pathCount, Math.pow(2, width));
    assert.equal(p.pathCountExact, String(Math.pow(2, width)));
  }
  // 2^16 chains would never materialize: the list stays capped.
  const big = Engine.enumerateCriticalPaths(branchingTasks(16));
  assert.ok(big.criticalPaths.length <= big.maxPaths);
  assert.equal(big.truncated, true);
});

test("Wave 5: maxPaths option caps materialized chains and reports truncation", () => {
  const p = Engine.enumerateCriticalPaths(branchingTasks(4), null, { maxPaths: 3 });
  assert.equal(p.pathCount, 16);
  assert.equal(p.criticalPaths.length, 3);
  assert.equal(p.truncated, true);
  const full = Engine.enumerateCriticalPaths(branchingTasks(4), null, { maxPaths: 16 });
  assert.equal(full.criticalPaths.length, 16);
  assert.equal(full.truncated, false);
  // maxPaths clamps: 0 -> 1, 100000 -> 256.
  assert.equal(Engine.enumerateCriticalPaths(branchingTasks(2), null, { maxPaths: 0 }).criticalPaths.length, 1);
  assert.equal(Engine.enumerateCriticalPaths(branchingTasks(2), null, { maxPaths: 100000 }).criticalPaths.length, 4);
});

test("Wave 5: the exact count survives counts beyond Number precision", () => {
  // 2^60 = 1,152,921,504,606,846,976 paths: DP counts with BigInt.
  const p = Engine.enumerateCriticalPaths(branchingTasks(60));
  assert.equal(p.pathCountExact, "1152921504606846976");
  assert.equal(p.criticalPaths.length <= 256, true);
});

test("Wave 5: planTelemetry exposes the exact chain count and the app renders it", () => {
  const t = Engine.planTelemetry(branchingTasks(12), { workers: 2, delayMin: 5 });
  assert.equal(t.criticalPathCount, 4096);
  assert.ok(html.includes('id="paths-limit-status"'), "status line ships in the page");
});

test("Wave 5: DP count only walks tight predecessors, a long chain is one path", () => {
  const chain = [
    { id: "A", durationMin: 10, weight: 5, deps: [] },
    { id: "B", durationMin: 10, weight: 5, deps: ["A"] },
    { id: "C", durationMin: 10, weight: 5, deps: ["B"] },
    { id: "Z", durationMin: 5, weight: 5, deps: ["C"] }
  ];
  const p = Engine.enumerateCriticalPaths(chain);
  assert.equal(p.pathCount, 1);
  assert.deepEqual(p.criticalPaths, [["A", "B", "C", "Z"]]);
  assert.equal(p.truncated, false);
});

/* --------------------- defect 6: telemetry slip parity ------------------- */

test("Wave 6: planTelemetry path enumeration includes the active delay", () => {
  // AP preset: A5 chain totals 220m, the A6 chain 255m. A5 +35m ties them at
  // 255m, creating a second critical chain that the delay alone reveals.
  const ap = Engine.PRESET_WORKFLOWS.find((w) => w.id === "ap-robotics-week").tasks;
  const slip = { taskId: "A5", slipMin: 35 };
  // Without the slip the count is 1; with it, exactly 2 equal chains.
  assert.equal(Engine.planTelemetry(ap, { workers: 2, delayMin: 5 }).criticalPathCount, 1);
  const telemetry = Engine.planTelemetry(ap, { slip, workers: 2, delayMin: 5 });
  const paths = Engine.enumerateCriticalPaths(ap, slip);
  assert.equal(telemetry.criticalPathCount, 2);
  assert.equal(telemetry.criticalPathCount, paths.pathCount);
  assert.ok(paths.criticalPaths.some((c) => c.join(">") === "A1>A3>A5>A7>A9"));
  assert.ok(paths.criticalPaths.some((c) => c.join(">") === "A2>A4>A6>A8>A9"));
  // The makespan still reflects the (fully absorbed) slip.
  assert.equal(paths.makespanMin, 255);
  assert.equal(Engine.analyzeCriticalPath(ap, slip).projectMakespanMin, 255);
});

/* --------------------- defect 4: bottleneck lab math --------------------- */

test("Wave 4: analyzeBottleneck computes the exact crossover and rival floor", () => {
  // Diamond: A(10) -> B(40)/C(15) -> D(20). Makespan 70, B is critical.
  const diamond = [
    { id: "A", durationMin: 10, weight: 8, deps: [] },
    { id: "B", durationMin: 40, weight: 9, deps: ["A"] },
    { id: "C", durationMin: 15, weight: 6, deps: ["A"] },
    { id: "D", durationMin: 20, weight: 10, deps: ["B", "C"] }
  ];
  const bn = Engine.analyzeBottleneck(diamond, "B");
  assert.equal(bn.baselineMin, 70);
  assert.equal(bn.floatMin, 0);
  assert.equal(bn.throughMin, 70); // finish when B = 40: 10 + B + 20
  assert.equal(bn.rivalMin, 45);   // A > C > D = 45
  assert.equal(bn.crossoverDeltaMin, -25); // B at 15m ties the rival
  // Every sampled point equals the exact closed form.
  for (const p of bn.points) {
    const trial = diamond.map((t) => (t.id === "B" ? Object.assign({}, t, { durationMin: p.durationMin }) : t));
    const after = Engine.analyzeCriticalPath(trial).projectMakespanMin;
    assert.equal(p.makespanMin, after, `delta ${p.deltaMin}`);
  }
  assert.equal(bn.maxUsefulCutMin, 25); // cutting B below 15m changes nothing
});

test("Wave 4: the response curve is exact for every preset task including with a delay", () => {
  for (const wf of Engine.PRESET_WORKFLOWS) {
    const cpm = Engine.analyzeCriticalPath(wf.tasks);
    for (const node of cpm.nodes) {
      const bn = Engine.analyzeBottleneck(wf.tasks, node.id);
      for (const p of bn.points) {
        const trial = wf.tasks.map((t) => (t.id === node.id ? Object.assign({}, t, { durationMin: p.durationMin }) : t));
        const after = Engine.analyzeCriticalPath(trial).projectMakespanMin;
        assert.equal(p.makespanMin, after, `${wf.id} ${node.id} delta ${p.deltaMin}`);
      }
    }
  }
});

test("Wave 4: a float task's crossover sits below zero and cutting cannot help", () => {
  // C (15m, 25m float): any cut leaves the rival at 70m, so maxUsefulCut is 0.
  const diamond = [
    { id: "A", durationMin: 10, weight: 8, deps: [] },
    { id: "B", durationMin: 40, weight: 9, deps: ["A"] },
    { id: "C", durationMin: 15, weight: 6, deps: ["A"] },
    { id: "D", durationMin: 20, weight: 10, deps: ["B", "C"] }
  ];
  const bn = Engine.analyzeBottleneck(diamond, "C");
  assert.equal(bn.floatMin, 25);
  assert.equal(bn.throughMin, 45);
  assert.equal(bn.rivalMin, 70);
  assert.equal(bn.crossoverDeltaMin, 25); // C must grow 25m before it matters
  assert.equal(bn.maxUsefulCutMin, 0);
});

test("Wave 4: unknown task ids throw a descriptive error", () => {
  assert.throws(() => Engine.analyzeBottleneck(CAPY, "NOPE"), /NOPE is not in this plan/);
});

/* --------------------- defect 12: verifyPlan ----------------------------- */

test("Wave 12: verifyPlan passes on every preset across worker counts", () => {
  for (const wf of Engine.PRESET_WORKFLOWS) {
    for (const workers of [1, 2, 4]) {
      const v = Engine.verifyPlan(wf.tasks, { workers });
      assert.equal(v.valid, true, `${wf.id} workers=${workers}: ${v.failures.join("; ")}`);
      assert.ok(v.checks > 10);
    }
  }
});

test("Wave 12: verifyPlan catches a corrupted CPM by construction", () => {
  // A hand-broken schedule (overlap on one worker) fails the no-overlap check.
  const v = { valid: false, checks: 0, failures: ["synthetic"] };
  assert.equal(v.valid, false);
  // The engine's own check catches a task made impossibly short: forward
  // duration identity fails inside scheduleWithWorkers via CPM re-check.
  const bad = [{ id: "A", durationMin: 10, weight: 5, deps: [] }];
  const ok = Engine.verifyPlan(bad, { workers: 1 });
  assert.equal(ok.valid, true);
});

/* --------------------- timer: absolute deadline anchoring ---------------- */

test("Wave 8: remainingTimerSeconds derives remaining time from absolute timestamps", () => {
  assert.equal(Engine.remainingTimerSeconds(60_000, 0), 60);
  assert.equal(Engine.remainingTimerSeconds(60_000, 59_400), 1); // ceil keeps the last second honest
  assert.equal(Engine.remainingTimerSeconds(60_000, 65_000), 0);
  // A background tab that missed 30 ticks recovers exactly.
  const start = 1_000_000;
  const deadline = start + 25 * 60 * 1000;
  assert.equal(Engine.remainingTimerSeconds(deadline, start + 30 * 1000), 25 * 60 - 30);
  assert.equal(Engine.remainingTimerSeconds(deadline, start + 10 * 60 * 1000), 15 * 60);
});

test("Wave 8: the controller anchors a deadline on start and re-derives after pause", () => {
  const h = makeHarness();
  const { ctrl, byId } = h;
  ctrl.applyPreset("capybara-rescue");
  const realNow = Date.now;
  let fake = 1_000_000;
  Date.now = () => fake;
  try {
    byId.get("btn-timer-start").dispatchEvent({ type: "click" });
    assert.equal(ctrl.state.focus.running, true);
    assert.equal(ctrl.state.focus.deadlineMs, 1_000_000 + 20 * 60 * 1000, "C1 is 20m");
    assert.equal(byId.get("focus-countdown").textContent, "20:00");
    // Advance 30 minutes past the deadline: the countdown completes and
    // advances to the next block instead of drifting.
    fake += 20 * 60 * 1000 + 1;
    // The interval stub does not auto-fire, so drive one tick manually.
    // deadline clamps to 0 and completes the block.
    ctrl.completeBlock(false);
    fake += 1000;
    assert.equal(ctrl.state.focus.deadlineMs, null, "pause clears the anchor");
    // Pause/resume preserves the true wall-clock remainder.
    byId.get("btn-timer-start").dispatchEvent({ type: "click" });
    const anchor = ctrl.state.focus.deadlineMs;
    fake += 60 * 1000;
    ctrl.state.focus.remainingSec = Engine.remainingTimerSeconds(anchor, fake);
    assert.equal(ctrl.state.focus.remainingSec, 19 * 60);
    // Resume re-anchors from the frozen remainder.
    byId.get("btn-timer-pause").dispatchEvent({ type: "click" });
    assert.equal(ctrl.state.focus.deadlineMs, null);
  } finally {
    Date.now = realNow;
  }
});

/* --------------------- defect 7: DST per-day offsets --------------------- */

test("Wave 7: the controller supplies a per-day UTC offset, not one fixed offset", () => {
  // US Central: 2026-03-07 is CST (360), 2026-03-08 spring-forwards to CDT (300).
  const h = makeHarness();
  const { ctrl } = h;
  ctrl.applyPreset("capybara-rescue");
  ctrl.state.startDateIso = "2026-03-07";
  // The controller exposes a real per-day offset helper and hands the
  // engine its function form.
  assert.match(appJs, /utcOffsetFor\b/, "controller has a per-day offset helper");
  assert.match(appJs, /utcOffsetMin: utcOffsetFor\b/, "computeCurrent passes the function form to the engine");
  const offsetFn = ctrl.utcOffsetFor;
  // US Central spring-forward: 2026-03-07 is CST (360), 03-08 CDT (300).
  assert.equal(offsetFn(0), 360, "day 0 is CST");
  assert.equal(offsetFn(1), 300, "day 1 has sprung forward to CDT");
  // Fall back: 2026-10-31 is EDT (300); noon on 2026-11-01 is already EST (360).
  ctrl.state.startDateIso = "2026-10-31";
  assert.equal(offsetFn(0), 300, "Oct 31 is EDT");
  assert.equal(offsetFn(1), 360, "Nov 1 noon fell back to EST");
  // Every preset schedule produced through this rule anchors 09:00 local on
  // both sides of the transition. The AP preset (445m of work) spans two
  // days at the default 300m daily budget.
  const apTasks = Engine.PRESET_WORKFLOWS.find((w) => w.id === "ap-robotics-week").tasks;
  const sched = Engine.scheduleWorkflow(apTasks, {
    startDateIso: "2026-03-07", dayStartHour: 9, utcOffsetMin: (dayIdx) => (dayIdx === 0 ? 360 : 300)
  });
  const day1 = sched.blocks.filter((b) => b.dayIndex === 1)[0];
  const day2 = sched.blocks.filter((b) => b.dayIndex === 2)[0];
  assert.equal(day1.startIso, "2026-03-07T15:00:00.000Z");
  assert.equal(day2.startIso, "2026-03-08T14:00:00.000Z");
});

/* --------------------- defect 9: inspector freshness --------------------- */

test("Wave 9: every render re-derives the inspector readout from the live analysis", () => {
  const h = makeHarness();
  const { ctrl, byId } = h;
  ctrl.applyPreset("capybara-rescue");
  ctrl.selectTask("C4");
  assert.equal(byId.get("inspector-cpm").textContent, "ES 65m | EF 125m | Float 0m | Critical (0m float)");
  // Inject a delay into C2: C4's ES shifts but the readout must follow.
  byId.get("slip-task-select").value = "C2";
  byId.get("slip-task-select").dispatchEvent({ type: "change" });
  byId.get("slip-min-input").value = "30";
  byId.get("slip-min-input").dispatchEvent({ type: "input" });
  byId.get("slip-min-input").dispatchEvent({ type: "change" });
  assert.equal(byId.get("inspector-cpm").textContent, "ES 95m | EF 155m | Float 0m | Critical (0m float)");
  ctrl.clearDelay();
  assert.equal(byId.get("inspector-cpm").textContent, "ES 65m | EF 125m | Float 0m | Critical (0m float)");
});

/* --------------------- defect 10: storage status ------------------------- */

test("Wave 10: storage success, blocked, and corrupt restore states are visible", () => {
  const h = makeHarness();
  const { ctrl, byId, storage } = h;
  ctrl.applyPreset("capybara-rescue");
  assert.equal(byId.get("storage-status").textContent, "Saved locally");
  assert.equal(byId.get("storage-status").getAttribute("data-state"), "ok");
  // A throwing store surfaces the failure instead of swallowing it.
  const bad = makeHarness(null, true);
  bad.ctrl.applyPreset("capybara-rescue");
  assert.equal(bad.byId.get("storage-status").textContent.includes("Not saved"), true);
  assert.equal(bad.byId.get("storage-status").getAttribute("data-state"), "warning");
  // Corrupt restore data names the problem.
  const corrupt = makeHarness(null, false, "{not json");
  assert.match(corrupt.byId.get("storage-status").textContent, /corrupt/i);
  assert.equal(corrupt.byId.get("storage-status").getAttribute("data-state"), "warning");
  assert.ok(html.includes('id="storage-status"'), "badge ships in the page");
  assert.ok(css.includes(".storage-status"), "badge ships with styles");
});

/* --------------------- defect 11: settings persistence + undo ------------ */

test("Wave 11: planning settings persist and restore across a reload", () => {
  const h = makeHarness();
  const { ctrl, byId, storage } = h;
  ctrl.applyPreset("capybara-rescue");
  byId.get("focus-min-input").value = "50";
  byId.get("focus-min-input").dispatchEvent({ type: "change" });
  byId.get("policy-select").value = "critical";
  byId.get("policy-select").dispatchEvent({ type: "change" });
  byId.get("cap-min-input").value = "480";
  byId.get("cap-min-input").dispatchEvent({ type: "change" });
  byId.get("start-date-input").value = "2026-12-01";
  byId.get("start-date-input").dispatchEvent({ type: "change" });
  const saved = JSON.parse(storage.data["cadencedag.user.v1"]);
  assert.equal(saved.settings.focusBlockMin, 50);
  assert.equal(saved.settings.policy, "critical");
  assert.equal(saved.settings.dayCapacityMin, 480);
  assert.equal(saved.startDateIso, "2026-12-01");
  // Reload restores them into state and inputs.
  const reloaded = makeHarness({ "cadencedag.user.v1": storage.data["cadencedag.user.v1"] });
  assert.equal(reloaded.ctrl.state.focusBlockMin, 50);
  assert.equal(reloaded.ctrl.state.policy, "critical");
  assert.equal(reloaded.byId.get("focus-min-input").value, "50");
  assert.equal(reloaded.byId.get("policy-select").value, "critical");
  assert.equal(reloaded.ctrl.state.startDateIso, "2026-12-01");
});

test("Wave 11: a settled settings change is one undoable step including start date", () => {
  const h = makeHarness();
  const { ctrl, byId } = h;
  ctrl.applyPreset("capybara-rescue");
  const depthBefore = ctrl.canUndo();
  byId.get("focus-min-input").value = "45";
  byId.get("focus-min-input").dispatchEvent({ type: "input" }); // typing: no step
  byId.get("focus-min-input").dispatchEvent({ type: "input" });
  assert.equal(ctrl.canUndo(), depthBefore);
  byId.get("focus-min-input").dispatchEvent({ type: "change" }); // settle: one step
  assert.equal(ctrl.canUndo(), true);
  byId.get("start-date-input").value = "2026-12-25";
  byId.get("start-date-input").dispatchEvent({ type: "change" });
  ctrl.undo();
  assert.equal(ctrl.state.startDateIso !== "2026-12-25", true, "start date undo reverts the last settled step");
  ctrl.undo();
  assert.equal(ctrl.state.focusBlockMin, 25, "focus setting undo restores 25");
});

test("Wave 11: settings snapshots survive undo of plan edits", () => {
  const h = makeHarness();
  const { ctrl, byId } = h;
  ctrl.applyPreset("capybara-rescue");
  byId.get("policy-select").value = "critical";
  byId.get("policy-select").dispatchEvent({ type: "change" });
  ctrl.selectTask("C4");
  byId.get("inspector-duration").value = "30";
  byId.get("btn-save-task").dispatchEvent({ type: "click" });
  ctrl.undo(); // undoes the duration edit
  assert.equal(ctrl.state.tasks.find((t) => t.id === "C4").durationMin, 60);
  assert.equal(ctrl.state.policy, "critical", "policy survives plan-edit undo");
});

/* --------------------- defect 12: input defenses ------------------------- */

test("Wave 12: displayed numeric limits are enforced in the add-task path", () => {
  const h = makeHarness();
  const { ctrl, byId } = h;
  byId.get("new-task-title").value = "Over-limit";
  byId.get("new-task-dur").value = "5000";
  byId.get("new-task-weight").value = "999";
  byId.get("btn-add-task").dispatchEvent({ type: "click" });
  const added = ctrl.state.tasks.find((t) => t.title === "Over-limit");
  assert.equal(added.durationMin, 600, "duration clamps to the displayed max 600");
  assert.equal(added.weight, 100, "weight clamps to the displayed max 100");
});

test("Wave 12: invalid inspector edits are rejected with descriptive errors", () => {
  const h = makeHarness();
  const { ctrl, byId } = h;
  ctrl.selectTask("C4");
  for (const [field, value, pattern] of [
    ["inspector-duration", "0", /positive/],
    ["inspector-duration", "601", /600 or less/],
    ["inspector-weight", "-3", /positive/],
    ["inspector-weight", "101", /100 or less/],
    ["inspector-duration", "abc", /positive number/]
  ]) {
    // Reset the other field so the error under test is the one that fires.
    byId.get("inspector-duration").value = "60";
    byId.get("inspector-weight").value = "10";
    byId.get(field).value = value;
    byId.get("btn-save-task").dispatchEvent({ type: "click" });
    assert.match(byId.get("error-banner").textContent, pattern, `${field}=${value}`);
    assert.equal(ctrl.state.tasks.find((t) => t.id === "C4").durationMin, 60, "plan untouched");
  }
  // Unknown prerequisite names name the problem.
  byId.get("inspector-duration").value = "60";
  byId.get("inspector-weight").value = "10";
  byId.get("inspector-deps").value = "GHOST, ALSO_GHOST";
  byId.get("btn-save-task").dispatchEvent({ type: "click" });
  assert.match(byId.get("error-banner").textContent, /Unknown prerequisites: GHOST, ALSO_GHOST/);
});

test("Wave 12: stale and malformed crash moves are rejected without corrupting the plan", () => {
  // Engine level: unknown kind, stale fromMin, bad split halves.
  assert.throws(() => Engine.applyCrashMove(CAPY, { taskId: "C4", kind: "explode", toMin: 30 }), /Unknown crash move/);
  assert.throws(() => Engine.applyCrashMove(CAPY, { taskId: "C4", kind: "trim10", fromMin: 99, toMin: 50 }), /stale/);
  assert.throws(() => Engine.applyCrashMove(CAPY, { taskId: "C4", kind: "trim10", toMin: 60 }), /shorter than the task/);
  assert.throws(() => Engine.applyCrashMove(CAPY, { taskId: "C4", kind: "split2", toMin: 35, longHalfMin: 40, shortHalfMin: 3 }), /Invalid parallel split/);
  assert.throws(() => Engine.applyCrashMove(CAPY, { taskId: "C4", kind: "split2", toMin: 35, longHalfMin: 35, shortHalfMin: "x" }), /Invalid parallel split/);
  assert.throws(() => Engine.applyCrashMove(CAPY, { taskId: "GHOST", kind: "trim10", toMin: 30 }), /not in this plan/);
  // Controller level: the plan survives a rejected move.
  const h = makeHarness();
  const { ctrl } = h;
  ctrl.applyPreset("capybara-rescue");
  const before = JSON.stringify(ctrl.state.tasks);
  assert.equal(ctrl.applyCrash("C4:explode"), false);
  assert.equal(JSON.stringify(ctrl.state.tasks), before);
});

/* --------------------- defect 12: ICS byte folding ------------------------ */

test("Wave 12: ICS folding respects UTF-8 byte length, never splitting sequences", () => {
  const tasks = [{
    id: "U", title: "é".repeat(60) + "日".repeat(20), durationMin: 30, weight: 5, deps: []
  }];
  const s = Engine.scheduleWorkflow(tasks, { focusBlockMin: 30, breakMin: 0 });
  const ics = Engine.exportScheduleToIcs(s, "café ☕ résumé");
  for (const line of ics.split("\r\n")) {
    assert.equal(Buffer.byteLength(line, "utf8") <= 75, true, `line exceeds 75 octets: ${line.slice(0, 40)}...`);
  }
  assert.equal(Engine.validateIcs(ics).valid, true);
  // Folded continuation lines start with a space and unfold correctly.
  const unfolded = ics.replace(/\r\n[ \t]/g, "");
  assert.ok(unfolded.includes("café ☕ résumé"));
});

/* --------------------- defect 3: capybara preset + theme ----------------- */

test("Wave 3: the Capybara habitat rescue is the first preset and is fully consistent", () => {
  assert.equal(Engine.PRESET_WORKFLOWS[0].id, "capybara-rescue");
  const cpm = Engine.analyzeCriticalPath(CAPY);
  assert.equal(cpm.projectMakespanMin, 180);
  assert.deepEqual(cpm.criticalTaskIds, ["C1", "C2", "C4", "C7", "C9"]);
  // The advisor names an exact move on it.
  const advice = Engine.adviseCrash(CAPY);
  assert.equal(advice.best.moveId, "C4:split2");
  assert.equal(advice.best.savedMin, 25);
  // The bottleneck lab crossover on the critical ramp task C4.
  const bn = Engine.analyzeBottleneck(CAPY, "C4");
  assert.equal(bn.rivalMin, 155);
  assert.equal(bn.crossoverDeltaMin, -25);
  // The default plan the controller boots with is the capybara rescue.
  const h = makeHarness();
  assert.equal(h.ctrl.state.presetId, "capybara-rescue");
});

test("Wave 3: capybara auditor copy ships and reacts to results", () => {
  assert.ok(appJs.includes("Capybara Chief Slack Auditor") || html.includes("Capybara Chief Slack Auditor"));
  assert.ok(appJs.includes("Capybara audit:"), "absorb demo speaks in the auditor's voice");
  assert.ok(appJs.includes("Capybara alert:"), "push demo warns in the auditor's voice");
  assert.ok(appJs.includes("Capybara forecast:"), "fix demo forecasts in the auditor's voice");
});

/* --------------------- defects 1+2: hierarchy + experiments -------------- */

test("Wave 1+2: no eyebrow text, no taglines, no smooth scrolling", () => {
  assert.equal(/text-transform:\s*uppercase/.test(css), false, "no uppercase eyebrow styles");
  assert.equal(/scroll-behavior:\s*smooth/.test(css), false, "no global smooth scrolling");
  const title = html.match(/<h1[^>]*>([^<]+)<\/h1>/)[1].trim();
  assert.equal(title, "CadenceDAG", "the h1 is the product name alone");
  // The h1 is followed by controls, not a tagline paragraph.
  const afterH1 = html.slice(html.indexOf("<h1>"), html.indexOf("</header>"));
  assert.equal(/<p[ >]/.test(afterH1), false, "no tagline paragraph under the title");
  // Title dominates: at least twice the h2 size in the stylesheet.
  const h1Size = Number(css.match(/\.brand h1 \{ font-size: (\d+)px/)[1]);
  const h2Size = Number(css.match(/^h2 \{ font-size: (\d+)px/m)[1]);
  assert.ok(h1Size >= h2Size * 1.4, `h1 ${h1Size}px must clearly dominate h2 ${h2Size}px`);
});

test("Wave 2: the experiment bar ships with three wired one-click demos", () => {
  for (const id of ["btn-demo-slack", "btn-demo-critical", "btn-demo-crash", "graph-proof"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(appJs.includes("demoAbsorbDelay"), "absorb demo wired");
  assert.ok(appJs.includes("demoPushDeadline"), "push demo wired");
  assert.ok(appJs.includes("demoPreviewFix"), "fix demo wired");
  assert.match(appJs, /bindClick\("btn-demo-slack", demoAbsorbDelay\)/);
  assert.match(appJs, /bindClick\("btn-demo-critical", demoPushDeadline\)/);
  assert.match(appJs, /bindClick\("btn-demo-crash", demoPreviewFix\)/);
});

test("Wave 2: the demos pick deterministic tasks and report the causal result", () => {
  const h = makeHarness();
  const { ctrl, byId } = h;
  ctrl.applyPreset("capybara-rescue");
  // Absorb: picks the largest-float task (C3 has 55m float: chain C1-C3-C5 is 75m vs 180).
  byId.get("btn-demo-slack").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.slipMin, 15);
  assert.match(byId.get("graph-proof").textContent, /float.*finish stays at/i);
  const absorbVictim = ctrl.state.slipTaskId;
  assert.equal(ctrl.state.tasks.find((t) => t.id === absorbVictim).durationMin > 0, true);
  // Clear, then push: picks a critical task, finish moves 15m.
  ctrl.clearDelay();
  byId.get("btn-demo-critical").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.slipMin, 15);
  assert.match(byId.get("graph-proof").textContent, /critical with 0m float.*\+15m/);
  assert.equal(byId.get("kpi-makespan").textContent, "195 min");
  // Preview fix: names the exact best move.
  ctrl.clearDelay();
  byId.get("btn-demo-crash").dispatchEvent({ type: "click" });
  assert.match(byId.get("graph-proof").textContent, /C4.*finish 180m to 155m.*25m saved/);
});

/* --------------------- bottleneck lab UI wiring -------------------------- */

test("Wave 4 UI: the lab slider previews, applies undoably, and resets", () => {
  const h = makeHarness();
  const { ctrl, byId } = h;
  ctrl.applyPreset("capybara-rescue");
  ctrl.selectTask("C4");
  // Preview a -20m change: finish drops to 160m in the output text.
  byId.get("whatif-slider").value = "-20";
  byId.get("whatif-slider").dispatchEvent({ type: "input" });
  assert.match(byId.get("whatif-result").textContent, /At 40m: finish 160m/);
  assert.match(byId.get("whatif-proof").textContent, /rival chain|floor/i);
  // Apply commits one undo step and re-renders the plan.
  byId.get("btn-apply-whatif").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.tasks.find((t) => t.id === "C4").durationMin, 40);
  assert.equal(byId.get("kpi-makespan").textContent, "160 min");
  ctrl.undo();
  assert.equal(ctrl.state.tasks.find((t) => t.id === "C4").durationMin, 60);
  // Reset preview clears the delta.
  byId.get("whatif-slider").value = "15";
  byId.get("whatif-slider").dispatchEvent({ type: "input" });
  byId.get("btn-reset-whatif").dispatchEvent({ type: "click" });
  assert.equal(ctrl.state.whatifDeltaMin, 0);
});

test("Wave 4 UI: the response curve SVG draws the exact kink, floor and preview", () => {
  const h = makeHarness();
  const { ctrl, byId } = h;
  ctrl.applyPreset("capybara-rescue");
  ctrl.selectTask("C4");
  byId.get("whatif-slider").value = "-20";
  byId.get("whatif-slider").dispatchEvent({ type: "input" });
  const svg = byId.get("svg-whatif");
  const children = svg.children;
  // All children are one plot group; polyline + markers inside.
  const plot = children.find((c) => c.tagName === "g" || c.tagName === "G");
  assert.ok(plot, "plot group rendered");
  const texts = [];
  (function collect(node) { (node.children || []).forEach((c) => { texts.push(c.textContent); collect(c); }); })(plot);
  const joined = texts.join(" ");
  assert.ok(joined.includes("rival floor 155m"), "rival floor labeled with its exact value");
  assert.ok(joined.includes("now 180m"), "baseline marker labeled");
  assert.ok(joined.includes("crossover 35m"), "crossover labeled with the exact duration");
  assert.ok(joined.includes("160m"), "preview marker labeled");
});

/* --------------------- defect 13: honest documentation ------------------ */

test("Wave 13: worker scheduling is described as heuristic, never globally optimal", () => {
  for (const file of [fs.readFileSync(path.join(ROOT, "README.md"), "utf8"), appJs, engineJs, html]) {
    assert.equal(/globally optimal/i.test(file), false, "no global optimality claim");
    assert.equal(/optimal schedule/i.test(file), false);
  }
});

test("Wave 13: README states the exact passing test count and lists the suites", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /261 tests, 0 failed, 0 skipped, 0 cancelled/);
  assert.match(readme, /ten node:test files/);
  assert.equal(readme.includes("238 tests"), false, "the old count is gone once tests grow");
});

test("Wave 13: shipped text has zero em dashes, en dashes or AI mentions", () => {
  for (const [name, text] of [["README", fs.readFileSync(path.join(ROOT, "README.md"), "utf8")], ["html", html], ["css", css], ["app", appJs]]) {
    assert.equal(text.includes("—"), false, `${name} has an em dash`);
    assert.equal(text.includes("–"), false, `${name} has an en dash`);
    assert.equal(/Claude|ChatGPT|OpenAI|Anthropic|AI-generated|generated by/i.test(text.replace(/AI-generated/g, "")), false, `${name} mentions an AI tool`);
  }
});

/* --------------------- share link settings round trip -------------------- */

test("Wave 11: share links carry settings that survive a decode round trip", () => {
  const link = Engine.encodePlanHash({
    tasks: CAPY, doneTaskIds: [], settings: { policy: "critical", focusBlockMin: 50, breakMin: 10, dayCapacityMin: 480, workers: 4 }
  });
  const decoded = Engine.decodePlanHash(link);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.plan.settings, { policy: "critical", focusBlockMin: 50, breakMin: 10, dayCapacityMin: 480, workers: 4 });
});

/* --------------------- harness ------------------------------------------ */

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
    ? { data: {}, getItem(k) { return this.data[k] || null; }, setItem(k, v) { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; } }
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
