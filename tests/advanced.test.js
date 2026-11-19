"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Engine = require("../js/dag-engine.js");

const DIAMOND = [
  { id: "A", title: "Start", durationMin: 10, weight: 8, deps: [] },
  { id: "B", title: "Long branch", durationMin: 40, weight: 9, deps: ["A"] },
  { id: "C", title: "Short branch", durationMin: 15, weight: 6, deps: ["A"] },
  { id: "D", title: "Finish", durationMin: 20, weight: 10, deps: ["B", "C"] }
];

/* ------------------------ critical path enumeration --------------------- */

test("enumerateCriticalPaths finds the exact longest chain of a diamond", () => {
  const p = Engine.enumerateCriticalPaths(DIAMOND);
  assert.equal(p.makespanMin, 70);
  assert.deepEqual(p.criticalPaths, [["A", "B", "D"]]);
  assert.equal(p.pathCount, 1);
});

test("enumerateCriticalPaths reports both tied longest chains", () => {
  const tied = [
    { id: "A", durationMin: 10, deps: [] },
    { id: "B", durationMin: 30, deps: ["A"] },
    { id: "C", durationMin: 30, deps: ["A"] },
    { id: "D", durationMin: 5, deps: ["B", "C"] }
  ];
  const p = Engine.enumerateCriticalPaths(tied);
  assert.equal(p.makespanMin, 45);
  assert.equal(p.pathCount, 2);
  assert.ok(p.criticalPaths.some((c) => c.join(">") === "A>B>D"));
  assert.ok(p.criticalPaths.some((c) => c.join(">") === "A>C>D"));
});

test("enumerateCriticalPaths agrees with CPM critical nodes", () => {
  const wf = Engine.PRESET_WORKFLOWS[0].tasks;
  const cpm = Engine.analyzeCriticalPath(wf);
  const paths = Engine.enumerateCriticalPaths(wf);
  const union = new Set(paths.criticalPaths.flat());
  assert.deepEqual([...union].sort(), [...cpm.criticalTaskIds].sort());
  assert.equal(paths.makespanMin, cpm.projectMakespanMin);
});

test("enumerateCriticalPaths on a single task returns one path", () => {
  const p = Engine.enumerateCriticalPaths([{ id: "Solo", durationMin: 7, deps: [] }]);
  assert.equal(p.makespanMin, 7);
  assert.deepEqual(p.criticalPaths, [["Solo"]]);
});

test("enumerateCriticalPaths rejects a cyclic graph", () => {
  assert.throws(() => Engine.enumerateCriticalPaths([
    { id: "A", durationMin: 5, deps: ["B"] }, { id: "B", durationMin: 5, deps: ["A"] }
  ]), /cycle/);
});

/* ----------------------- multi-worker scheduling ------------------------ */

test("scheduleWithWorkers one worker equals the serial task timeline makespan", () => {
  const r = Engine.scheduleWithWorkers(DIAMOND, { workers: 1 });
  assert.equal(r.makespanMin, 85);
  assert.equal(r.totalWorkMin, 85);
  assert.equal(r.ledger.length, 1);
  assert.equal(r.utilization, 1);
  assert.equal(r.idleMin, 0);
});

test("scheduleWithWorkers two workers exploit real parallelism", () => {
  const r = Engine.scheduleWithWorkers(DIAMOND, { workers: 2 });
  assert.equal(r.makespanMin, 70);
  assert.equal(r.totalWorkMin, 85);
  assert.ok(Math.abs(r.utilization - 85 / 140) < 1e-9);
  assert.equal(r.idleMin, 55);
  assert.equal(r.ledger.length, 2);
});

test("scheduleWithWorkers never violates precedence", () => {
  for (const w of [1, 2, 3, 5]) {
    const r = Engine.scheduleWithWorkers(Engine.PRESET_WORKFLOWS[0].tasks, { workers: w, policy: "wspt" });
    for (const n of r.cpm.nodes) {
      for (const dep of n.deps) {
        assert.ok(r.ends.get(dep) <= r.starts.get(n.id),
          `${dep} finishes at ${r.ends.get(dep)} but ${n.id} starts at ${r.starts.get(n.id)} with ${w} workers`);
      }
    }
  }
});

test("scheduleWithWorkers makespan never increases with more workers", () => {
  let prev = Infinity;
  for (const w of [1, 2, 3, 4, 6]) {
    const r = Engine.scheduleWithWorkers(Engine.PRESET_WORKFLOWS[2].tasks, { workers: w });
    assert.ok(r.makespanMin <= prev, `${w} workers increased makespan`);
    prev = r.makespanMin;
  }
});

test("scheduleWithWorkers is deterministic and clamps worker count", () => {
  const a = Engine.scheduleWithWorkers(DIAMOND, { workers: 3 });
  const b = Engine.scheduleWithWorkers(DIAMOND, { workers: 3 });
  assert.deepEqual(a.ledger, b.ledger);
  assert.equal(Engine.scheduleWithWorkers(DIAMOND, { workers: -5 }).workers, 1);
});

test("scheduleWithWorkers ledger busy minutes sum to total work", () => {
  const r = Engine.scheduleWithWorkers(Engine.PRESET_WORKFLOWS[1].tasks, { workers: 4, policy: "critical" });
  assert.equal(r.ledger.reduce((s, w) => s + w.busyMin, 0), r.totalWorkMin);
});

/* ------------------------- deterministic risk sweep --------------------- */

test("analyzeScheduleRisk reports exact absorption for a 10 minute delay", () => {
  const r = Engine.analyzeScheduleRisk(DIAMOND, { delayMin: 10 });
  assert.equal(r.baselineMakespanMin, 70);
  assert.equal(r.sampleCount, 4);
  assert.equal(r.absorbedCount, 1);
  assert.equal(r.maxDeltaMin, 10);
  assert.equal(r.worstCaseMakespanMin, 80);
  assert.equal(r.meanDeltaMin, 7.5);
});

test("analyzeScheduleRisk zero delay never moves the deadline", () => {
  const r = Engine.analyzeScheduleRisk(DIAMOND, { delayMin: 0 });
  assert.equal(r.maxDeltaMin, 0);
  assert.equal(r.absorbedCount, 4);
  assert.equal(r.absorbedFraction, 1);
  assert.equal(r.worstCaseMakespanMin, r.baselineMakespanMin);
});

test("analyzeScheduleRisk absorbed delay equals min(delay, float)", () => {
  const r = Engine.analyzeScheduleRisk(Engine.PRESET_WORKFLOWS[0].tasks, { delayMin: 10 });
  for (const s of r.samples) {
    assert.equal(s.absorbed, Math.min(10, Math.max(0, s.floatMin)));
    assert.equal(s.deltaMin, s.makespanMin - r.baselineMakespanMin);
  }
});

test("analyzeScheduleRisk is deterministic and labels itself honestly", () => {
  const a = Engine.analyzeScheduleRisk(DIAMOND, { delayMin: 25 });
  const b = Engine.analyzeScheduleRisk(DIAMOND, { delayMin: 25 });
  assert.deepEqual(a, b);
  assert.match(a.note, /not a Monte Carlo simulation/);
});

test("analyzeScheduleRisk slack coverage is a fraction in [0,1]", () => {
  for (const d of [0, 5, 40, 200]) {
    const r = Engine.analyzeScheduleRisk(Engine.PRESET_WORKFLOWS[2].tasks, { delayMin: d });
    assert.ok(r.slackCoverage >= 0 && r.slackCoverage <= 1);
    assert.ok(r.absorbedFraction >= 0 && r.absorbedFraction <= 1);
  }
});

/* ----------------------------- ICS validation --------------------------- */

test("validateIcs accepts a generated schedule", () => {
  const s = Engine.scheduleWorkflow(Engine.PRESET_WORKFLOWS[0].tasks, { focusBlockMin: 25 });
  const r = Engine.validateIcs(Engine.exportScheduleToIcs(s, "Test, Plan"));
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.eventCount, s.blocks.length);
  const ics = Engine.exportScheduleToIcs(s, "Test, Plan");
  const start = ics.match(/DTSTART:(\d{8}T\d{6}Z)/)[1];
  assert.equal(Engine.validateIcs(ics.replace(/DTEND:\d{8}T\d{6}Z/, "DTEND:" + start)).valid, false);
  assert.equal(Engine.validateIcs(ics.replace("DTEND:", "DTSTART:")).valid, false);
});

test("validateIcs rejects missing calendar markers", () => {
  assert.equal(Engine.validateIcs("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n").valid, false);
});

test("validateIcs rejects unbalanced VEVENT blocks", () => {
  const s = Engine.scheduleWorkflow(DIAMOND, { focusBlockMin: 25 });
  const ics = Engine.exportScheduleToIcs(s).replace("END:VEVENT\r\n", "");
  const r = Engine.validateIcs(ics);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /unbalanced/.test(e)));
});

test("validateIcs rejects LF-only and mixed line endings", () => {
  const s = Engine.scheduleWorkflow(DIAMOND, { focusBlockMin: 25 });
  const r = Engine.validateIcs(Engine.exportScheduleToIcs(s).replace(/\r\n/g, "\n"));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /CRLF/.test(e)));
  const mixed = Engine.exportScheduleToIcs(s).replace("\r\n", "\n");
  assert.equal(Engine.validateIcs(mixed).valid, false);
});

/* --------------------------- plan telemetry ----------------------------- */

test("planTelemetry is deterministic and internally consistent", () => {
  const wf = Engine.PRESET_WORKFLOWS[0].tasks;
  const a = Engine.planTelemetry(wf, { workers: 3, delayMin: 10 });
  const b = Engine.planTelemetry(wf, { workers: 3, delayMin: 10 });
  assert.deepEqual(a, b);
  assert.equal(a.taskCount, wf.length);
  assert.equal(a.makespanMin, Engine.analyzeCriticalPath(wf).projectMakespanMin);
  assert.equal(a.workers, 3);
  assert.ok(a.multiWorkerUtilization >= 0 && a.multiWorkerUtilization <= 1);
  assert.ok(a.focusBlocks > 0 && a.totalDays >= 1);
});

test("planTelemetry worker count changes the parallel makespan but not the CPM plan", () => {
  const wf = Engine.PRESET_WORKFLOWS[0].tasks;
  const one = Engine.planTelemetry(wf, { workers: 1, delayMin: 10 });
  const four = Engine.planTelemetry(wf, { workers: 4, delayMin: 10 });
  assert.equal(one.makespanMin, four.makespanMin);
  assert.equal(one.totalWorkMin, four.totalWorkMin);
  assert.ok(four.multiWorkerMakespanMin <= one.multiWorkerMakespanMin);
});

test("planTelemetry risk delay flows into the worst case", () => {
  const wf = Engine.PRESET_WORKFLOWS[0].tasks;
  const low = Engine.planTelemetry(wf, { workers: 2, delayMin: 0 });
  const high = Engine.planTelemetry(wf, { workers: 2, delayMin: 40 });
  assert.ok(high.riskWorstCaseMakespanMin >= low.riskWorstCaseMakespanMin);
});

/* -------------------------- regression pins ----------------------------- */

test("regression: every preset has at least one critical path and valid ICS", () => {
  for (const wf of Engine.PRESET_WORKFLOWS) {
    const p = Engine.enumerateCriticalPaths(wf.tasks);
    assert.ok(p.pathCount >= 1);
    const s = Engine.scheduleWorkflow(wf.tasks, { focusBlockMin: 25, breakMin: 5 });
    assert.equal(Engine.validateIcs(Engine.exportScheduleToIcs(s)).valid, true);
  }
});

test("regression: no worker starts a task before its dependencies finish", () => {
  for (const wf of Engine.PRESET_WORKFLOWS) {
    for (const policy of ["wspt", "critical", "shortest"]) {
      const r = Engine.scheduleWithWorkers(wf.tasks, { workers: 4, policy });
      for (const n of r.cpm.nodes) {
        for (const dep of n.deps) assert.ok(r.starts.get(n.id) >= r.ends.get(dep));
      }
    }
  }
});

test("regression: risk samples cover every task exactly once", () => {
  for (const wf of Engine.PRESET_WORKFLOWS) {
    const r = Engine.analyzeScheduleRisk(wf.tasks, { delayMin: 15 });
    assert.equal(r.sampleCount, wf.tasks.length);
    assert.equal(new Set(r.samples.map((s) => s.taskId)).size, wf.tasks.length);
  }
});

test("regression: parallel makespan never beats the CPM floor and reaches it with 3 workers", () => {
  // A greedy queue once let a high-priority successor reserve a worker while a
  // startable critical task waited (AP preset: 295m with 3 workers vs a 255m
  // critical path). Non-delay list scheduling keeps every preset on the floor.
  for (const wf of Engine.PRESET_WORKFLOWS) {
    const floor = Engine.analyzeCriticalPath(wf.tasks).projectMakespanMin;
    for (const policy of ["wspt", "critical", "shortest"]) {
      for (const w of [1, 2, 3, 4]) {
        const r = Engine.scheduleWithWorkers(wf.tasks, { workers: w, policy });
        assert.ok(r.makespanMin >= floor, `${wf.id} ${policy} ${w}w beat the CPM floor`);
      }
      assert.equal(Engine.scheduleWithWorkers(wf.tasks, { workers: 3, policy }).makespanMin, floor,
        `${wf.id} ${policy} with 3 workers should reach the ${floor}m critical path`);
    }
  }
  const ap = Engine.PRESET_WORKFLOWS.find((w) => w.id === "ap-robotics-week").tasks;
  assert.equal(Engine.scheduleWithWorkers(ap, { workers: 1 }).makespanMin, 445);
  assert.equal(Engine.scheduleWithWorkers(ap, { workers: 3 }).makespanMin, 255);
});

test("scheduleWorkflow utcOffsetMin anchors the day start to local wall-clock time", () => {
  const tasks = Engine.PRESET_WORKFLOWS[3].tasks;
  const utc = Engine.scheduleWorkflow(tasks, { startDateIso: "2026-11-20", dayStartHour: 9 });
  const central = Engine.scheduleWorkflow(tasks, { startDateIso: "2026-11-20", dayStartHour: 9, utcOffsetMin: 360 });
  assert.equal(utc.blocks[0].startIso, "2026-11-20T09:00:00.000Z");
  assert.equal(central.blocks[0].startIso, "2026-11-20T15:00:00.000Z");
  assert.equal(central.blocks.length, utc.blocks.length);
  assert.equal(central.totalWeightedCompletion, utc.totalWeightedCompletion);
  const v = Engine.validateIcs(Engine.exportScheduleToIcs(central, "Offset Check"));
  assert.equal(v.valid, true);
  assert.match(Engine.exportScheduleToIcs(central, "Offset Check"), /DTSTART:20261120T150000Z/);
});
