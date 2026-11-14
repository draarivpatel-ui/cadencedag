const test = require("node:test");
const assert = require("node:assert/strict");
const Engine = require("../js/dag-engine.js");

test("PRESET_WORKFLOWS contains 3 valid acyclic DAG presets", () => {
  assert.equal(Engine.PRESET_WORKFLOWS.length, 3);
  for (const wf of Engine.PRESET_WORKFLOWS) {
    const res = Engine.validateAndTopoSort(wf.tasks);
    assert.equal(res.topoOrder.length, wf.tasks.length);
  }
});

test("validateAndTopoSort rejects empty graph, duplicate IDs, self-loop, missing dependency, and cycle", () => {
  assert.throws(() => Engine.validateAndTopoSort([]));
  assert.throws(() => Engine.validateAndTopoSort([
    { id: "A", durationMin: 10, deps: [] },
    { id: "A", durationMin: 20, deps: [] }
  ]));
  assert.throws(() => Engine.validateAndTopoSort([
    { id: "A", durationMin: 10, deps: ["A"] }
  ]));
  assert.throws(() => Engine.validateAndTopoSort([
    { id: "A", durationMin: 10, deps: ["Z"] }
  ]));
  assert.throws(() => Engine.validateAndTopoSort([
    { id: "A", durationMin: 10, deps: ["B"] },
    { id: "B", durationMin: 10, deps: ["A"] }
  ]));
  assert.throws(() => Engine.validateAndTopoSort([
    { id: "A", durationMin: 0, deps: [] }
  ]));
});

test("analyzeCriticalPath computes exact makespan, critical nodes, and float for diamond DAG", () => {
  const diamond = [
    { id: "A", title: "Start", durationMin: 10, weight: 8, deps: [] },
    { id: "B", title: "Long branch", durationMin: 40, weight: 9, deps: ["A"] },
    { id: "C", title: "Short branch", durationMin: 15, weight: 6, deps: ["A"] },
    { id: "D", title: "Finish", durationMin: 20, weight: 10, deps: ["B", "C"] }
  ];
  const cpm = Engine.analyzeCriticalPath(diamond);
  assert.equal(cpm.projectMakespanMin, 70);
  assert.equal(cpm.totalWorkMin, 85);
  assert.deepEqual(cpm.criticalTaskIds, ["A", "B", "D"]);

  const nodeC = cpm.nodeMap.get("C");
  assert.equal(nodeC.esMin, 10);
  assert.equal(nodeC.efMin, 25);
  assert.equal(nodeC.lsMin, 35);
  assert.equal(nodeC.lfMin, 50);
  assert.equal(nodeC.totalFloatMin, 25);
  assert.equal(nodeC.freeFloatMin, 25);
  assert.equal(nodeC.isCritical, false);
});

test("analyzeCriticalPath slippage simulator absorbs float below slack and extends makespan beyond slack", () => {
  const diamond = [
    { id: "A", durationMin: 10, weight: 8, deps: [] },
    { id: "B", durationMin: 40, weight: 9, deps: ["A"] },
    { id: "C", durationMin: 15, weight: 6, deps: ["A"] },
    { id: "D", durationMin: 20, weight: 10, deps: ["B", "C"] }
  ];
  const minorSlip = Engine.analyzeCriticalPath(diamond, { taskId: "C", slipMin: 20 });
  assert.equal(minorSlip.projectMakespanMin, 70);
  assert.equal(minorSlip.nodeMap.get("C").totalFloatMin, 5);

  const majorSlip = Engine.analyzeCriticalPath(diamond, { taskId: "C", slipMin: 35 });
  assert.equal(majorSlip.projectMakespanMin, 80);
  assert.equal(majorSlip.nodeMap.get("C").isCritical, true);
  assert.equal(majorSlip.nodeMap.get("B").isCritical, false);
});

test("scheduleWorkflow respects topological precedence under wspt, critical, and shortest policies", () => {
  const wf = Engine.PRESET_WORKFLOWS[0].tasks;
  for (const policy of ["wspt", "critical", "shortest"]) {
    const sched = Engine.scheduleWorkflow(wf, { policy, focusBlockMin: 25, breakMin: 5, dayCapacityMin: 200 });
    const pos = new Map(sched.executionOrder.map((id, idx) => [id, idx]));
    for (const t of wf) {
      for (const dep of t.deps) {
        assert.ok(pos.get(dep) < pos.get(t.id), `${policy}: ${dep} must precede ${t.id}`);
      }
    }
    const scheduledSum = sched.blocks.reduce((acc, b) => acc + b.durationMin, 0);
    assert.equal(scheduledSum, sched.cpm.totalWorkMin);
  }
});

test("WSPT policy minimizes or beats reverse order on independent weighted tasks", () => {
  const tasks = [
    { id: "H", durationMin: 10, weight: 10, deps: [] }, // ratio 1.0
    { id: "L", durationMin: 50, weight: 5, deps: [] }   // ratio 0.1
  ];
  const wspt = Engine.scheduleWorkflow(tasks, { policy: "wspt" });
  assert.deepEqual(wspt.executionOrder, ["H", "L"]);
  assert.equal(wspt.totalWeightedCompletion, 10 * 10 + 5 * 60); // 400
});

test("exportScheduleToIcs emits valid RFC 5545 VCALENDAR/VEVENT blocks with CRLF", () => {
  const sched = Engine.scheduleWorkflow(Engine.PRESET_WORKFLOWS[1].tasks, {
    policy: "wspt",
    focusBlockMin: 25,
    breakMin: 5,
    dayCapacityMin: 150,
    startDateIso: "2026-11-16"
  });
  const ics = Engine.exportScheduleToIcs(sched, "Exam Sprint, Finals");
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.includes("X-WR-CALNAME:Exam Sprint\\, Finals\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  const eventCount = (ics.match(/BEGIN:VEVENT/g) || []).length;
  assert.equal(eventCount, sched.blocks.length);
  assert.equal((ics.match(/END:VEVENT/g) || []).length, sched.blocks.length);
});

test("validateAndTopoSort rejects empty task id, negative weight, and non-finite duration while deduplicating deps", () => {
  assert.throws(() => Engine.validateAndTopoSort([{ id: "  ", durationMin: 10, deps: [] }]));
  assert.throws(() => Engine.validateAndTopoSort([{ id: "A", durationMin: 10, weight: 0, deps: [] }]));
  assert.throws(() => Engine.validateAndTopoSort([{ id: "A", durationMin: Number.NaN, deps: [] }]));
  assert.throws(() => Engine.validateAndTopoSort([
    { id: "A", durationMin: 10, deps: ["C"] },
    { id: "B", durationMin: 10, deps: ["A"] },
    { id: "C", durationMin: 10, deps: ["B"] }
  ]), /Dependency cycle detected/);

  const dedup = Engine.validateAndTopoSort([
    { id: "X", durationMin: 10, deps: [] },
    { id: "Y", durationMin: 15, deps: ["X", "X"] }
  ]);
  assert.deepEqual(dedup.byId.get("Y").deps, ["X"]);
  assert.deepEqual(dedup.topoOrder, ["X", "Y"]);
});

test("analyzeCriticalPath computes freeFloatMin distinct from totalFloatMin, layer depth, and speedup", () => {
  const tasks = [
    { id: "A", durationMin: 30, weight: 5, deps: [] },
    { id: "B", durationMin: 10, weight: 5, deps: ["A"] },
    { id: "C", durationMin: 15, weight: 5, deps: ["B"] },
    { id: "D", durationMin: 80, weight: 5, deps: [] },
    { id: "E", durationMin: 10, weight: 5, deps: ["C", "D"] }
  ];
  const cpm = Engine.analyzeCriticalPath(tasks);
  assert.equal(cpm.projectMakespanMin, 90);
  assert.equal(cpm.totalWorkMin, 145);
  assert.ok(Math.abs(cpm.parallelSpeedup - 145 / 90) < 1e-6);
  assert.equal(cpm.maxLayer, 3);
  assert.equal(cpm.nodeMap.get("B").freeFloatMin, 0);
  assert.equal(cpm.nodeMap.get("B").totalFloatMin, 25);
  assert.equal(cpm.nodeMap.get("C").freeFloatMin, 25);
  assert.equal(cpm.nodeMap.get("C").totalFloatMin, 25);
});

test("scheduleWorkflow splits long tasks across Pomodoro blocks and rolls into Day 2 when exceeding capacity", () => {
  const tasks = [
    { id: "T1", title: "Deep build, stage; one", durationMin: 70, weight: 9, deps: [] },
    { id: "T2", title: "Review\npass", durationMin: 35, weight: 7, deps: ["T1"] }
  ];
  const sched = Engine.scheduleWorkflow(tasks, {
    policy: "shortest",
    focusBlockMin: 25,
    breakMin: 5,
    dayStartHour: 9,
    dayCapacityMin: 60,
    startDateIso: "2026-11-20"
  });
  // Day 1 takes 25 + 25 + 10 = 60m of T1; Day 2 takes remaining 10m of T1 + 25 + 10 = 45m of T2
  assert.equal(sched.totalDays, 2);
  assert.equal(sched.totalFocusBlocks, 6);
  assert.equal(sched.blocks[0].dayIndex, 1);
  assert.equal(sched.blocks[3].dayIndex, 2);
  assert.equal(sched.blocks[3].taskId, "T1");
  assert.equal(sched.blocks[3].part, 4);

  const ics = Engine.exportScheduleToIcs(sched);
  assert.ok(ics.includes("SUMMARY:[CRITICAL] Deep build\\, stage\\; one (T1 p1)\r\n"));
  assert.ok(ics.includes("Review\\npass"));
});

