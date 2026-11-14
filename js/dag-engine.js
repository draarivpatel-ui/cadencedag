(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CadenceDagEngine = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PRESET_WORKFLOWS = [
    {
      id: "hackathon-sprint",
      name: "Hackathon MVP Launch (9 Tasks)",
      tasks: [
        { id: "T1", title: "Define API & Data Contract", durationMin: 30, weight: 9, category: "Design", deps: [] },
        { id: "T2", title: "Core Compute Engine", durationMin: 75, weight: 10, category: "Backend", deps: ["T1"] },
        { id: "T3", title: "UI Wireframe & Styles", durationMin: 50, weight: 7, category: "Frontend", deps: ["T1"] },
        { id: "T4", title: "Unit & Edge Test Suite", durationMin: 50, weight: 9, category: "QA", deps: ["T2"] },
        { id: "T5", title: "SVG Interactive Canvas", durationMin: 60, weight: 8, category: "Frontend", deps: ["T1", "T3"] },
        { id: "T6", title: "Wire UI to Engine", durationMin: 45, weight: 9, category: "Integration", deps: ["T2", "T5"] },
        { id: "T7", title: "Accessibility & DOM Smoke", durationMin: 35, weight: 8, category: "QA", deps: ["T4", "T6"] },
        { id: "T8", title: "Demo Script & Narration", durationMin: 40, weight: 7, category: "Media", deps: ["T6"] },
        { id: "T9", title: "Deploy & Devpost Packaging", durationMin: 25, weight: 10, category: "Release", deps: ["T7", "T8"] }
      ]
    },
    {
      id: "exam-study-sprint",
      name: "Finals & Lab Prep (7 Tasks)",
      tasks: [
        { id: "S1", title: "Audit Syllabus & Past Papers", durationMin: 25, weight: 8, category: "Plan", deps: [] },
        { id: "S2", title: "Derivations Flashcard Deck", durationMin: 50, weight: 9, category: "Core", deps: ["S1"] },
        { id: "S3", title: "Clean Lab Notebook Figures", durationMin: 40, weight: 6, category: "Lab", deps: ["S1"] },
        { id: "S4", title: "Timed Practice Set A", durationMin: 60, weight: 10, category: "Practice", deps: ["S2"] },
        { id: "S5", title: "Error Log & Weak Topics", durationMin: 35, weight: 9, category: "Review", deps: ["S4"] },
        { id: "S6", title: "Peer Formula Cross-Check", durationMin: 30, weight: 5, category: "Lab", deps: ["S3"] },
        { id: "S7", title: "Final Mock Exam Timed Run", durationMin: 55, weight: 10, category: "Exam", deps: ["S5", "S6"] }
      ]
    },
    {
      id: "product-release",
      name: "SaaS Feature Release (8 Tasks)",
      tasks: [
        { id: "R1", title: "Schema Migration Draft", durationMin: 40, weight: 9, category: "DB", deps: [] },
        { id: "R2", title: "Telemetry Metrics Spec", durationMin: 25, weight: 6, category: "Ops", deps: [] },
        { id: "R3", title: "Endpoint Handler & Auth", durationMin: 65, weight: 10, category: "Backend", deps: ["R1"] },
        { id: "R4", title: "Dashboard Panel Component", durationMin: 55, weight: 8, category: "Frontend", deps: ["R2"] },
        { id: "R5", title: "Contract & Integration Tests", durationMin: 45, weight: 9, category: "QA", deps: ["R3"] },
        { id: "R6", title: "Wire Telemetry Hooks", durationMin: 30, weight: 7, category: "Ops", deps: ["R2", "R3"] },
        { id: "R7", title: "End-to-End Staging Verification", durationMin: 40, weight: 9, category: "QA", deps: ["R4", "R5", "R6"] },
        { id: "R8", title: "Changelog & Gradual Rollout", durationMin: 25, weight: 8, category: "Release", deps: ["R7"] }
      ]
    }
  ];

  function cloneTasks(tasks) {
    return (tasks || []).map((t) => ({
      id: String(t.id).trim(),
      title: String(t.title || t.id).trim(),
      durationMin: Number(t.durationMin),
      weight: Number(t.weight ?? 5),
      category: String(t.category || "General").trim(),
      deps: Array.isArray(t.deps) ? t.deps.map((d) => String(d).trim()).filter(Boolean) : []
    }));
  }

  /**
   * Validates task graph and computes topological ordering (Kahn's algorithm) with deterministic tie-breaking.
   * Throws descriptive error on duplicate IDs, unknown dependencies, non-positive durations, or cycles.
   */
  function validateAndTopoSort(rawTasks) {
    const tasks = cloneTasks(rawTasks);
    if (tasks.length === 0) {
      throw new Error("Workflow must include at least one task");
    }

    const byId = new Map();
    for (const t of tasks) {
      if (!t.id) throw new Error("Task id cannot be empty");
      if (byId.has(t.id)) throw new Error(`Duplicate task id: ${t.id}`);
      if (!Number.isFinite(t.durationMin) || t.durationMin <= 0) {
        throw new Error(`Task ${t.id} durationMin must be a positive finite number`);
      }
      if (!Number.isFinite(t.weight) || t.weight <= 0) {
        throw new Error(`Task ${t.id} weight must be positive`);
      }
      byId.set(t.id, t);
    }

    const indegree = new Map();
    const succs = new Map();
    for (const t of tasks) {
      indegree.set(t.id, 0);
      succs.set(t.id, []);
    }

    for (const t of tasks) {
      const seenDeps = new Set();
      for (const dep of t.deps) {
        if (dep === t.id) throw new Error(`Task ${t.id} cannot depend on itself`);
        if (!byId.has(dep)) throw new Error(`Task ${t.id} references missing dependency ${dep}`);
        if (seenDeps.has(dep)) continue;
        seenDeps.add(dep);
        succs.get(dep).push(t.id);
        indegree.set(t.id, indegree.get(t.id) + 1);
      }
      t.deps = Array.from(seenDeps);
    }

    const queue = [];
    for (const t of tasks) {
      if (indegree.get(t.id) === 0) queue.push(t.id);
    }

    const topoOrder = [];
    while (queue.length > 0) {
      const id = queue.shift();
      topoOrder.push(id);
      for (const nextId of succs.get(id)) {
        const rem = indegree.get(nextId) - 1;
        indegree.set(nextId, rem);
        if (rem === 0) queue.push(nextId);
      }
    }

    if (topoOrder.length !== tasks.length) {
      const cycleIds = tasks.filter((t) => indegree.get(t.id) > 0).map((t) => t.id);
      throw new Error(`Dependency cycle detected involving: ${cycleIds.join(", ")}`);
    }

    return { tasks, byId, succs, topoOrder };
  }

  /**
   * Computes Critical Path Method (CPM) forward/backward pass, Total Float, Free Float,
   * layer depths (for DAG layout), critical paths, and parallelism speedup.
   */
  function analyzeCriticalPath(rawTasks, slipOptions) {
    const { tasks, byId, succs, topoOrder } = validateAndTopoSort(rawTasks);
    const slipTaskId = slipOptions && slipOptions.taskId ? String(slipOptions.taskId) : "";
    const slipMin = slipOptions && Number.isFinite(Number(slipOptions.slipMin)) ? Math.max(0, Number(slipOptions.slipMin)) : 0;

    const effectiveDur = new Map();
    for (const t of tasks) {
      effectiveDur.set(t.id, t.durationMin + (t.id === slipTaskId ? slipMin : 0));
    }

    // Forward pass: ES, EF, topological layer
    const es = new Map();
    const ef = new Map();
    const layer = new Map();

    for (const id of topoOrder) {
      const t = byId.get(id);
      let maxPredEf = 0;
      let maxPredLayer = -1;
      for (const dep of t.deps) {
        if (ef.get(dep) > maxPredEf) maxPredEf = ef.get(dep);
        if (layer.get(dep) > maxPredLayer) maxPredLayer = layer.get(dep);
      }
      es.set(id, maxPredEf);
      ef.set(id, maxPredEf + effectiveDur.get(id));
      layer.set(id, maxPredLayer + 1);
    }

    let projectMakespanMin = 0;
    let totalWorkMin = 0;
    for (const id of topoOrder) {
      if (ef.get(id) > projectMakespanMin) projectMakespanMin = ef.get(id);
      totalWorkMin += effectiveDur.get(id);
    }

    // Backward pass: LS, LF
    const ls = new Map();
    const lf = new Map();
    for (let i = topoOrder.length - 1; i >= 0; i--) {
      const id = topoOrder[i];
      const children = succs.get(id);
      let minSuccLs = projectMakespanMin;
      if (children.length > 0) {
        minSuccLs = Infinity;
        for (const cid of children) {
          if (ls.get(cid) < minSuccLs) minSuccLs = ls.get(cid);
        }
      }
      lf.set(id, minSuccLs);
      ls.set(id, minSuccLs - effectiveDur.get(id));
    }

    const nodes = tasks.map((t) => {
      const totalFloatMin = ls.get(t.id) - es.get(t.id);
      const children = succs.get(t.id);
      let minSuccEs = projectMakespanMin;
      if (children.length > 0) {
        minSuccEs = Infinity;
        for (const cid of children) {
          if (es.get(cid) < minSuccEs) minSuccEs = es.get(cid);
        }
      }
      const freeFloatMin = minSuccEs - ef.get(t.id);
      const isCritical = Math.abs(totalFloatMin) < 1e-6;
      const wsptRatio = t.weight / effectiveDur.get(t.id);

      return {
        id: t.id,
        title: t.title,
        category: t.category,
        baseDurationMin: t.durationMin,
        effectiveDurationMin: effectiveDur.get(t.id),
        weight: t.weight,
        wsptRatio,
        deps: t.deps.slice(),
        succs: children.slice(),
        layer: layer.get(t.id),
        esMin: es.get(t.id),
        efMin: ef.get(t.id),
        lsMin: ls.get(t.id),
        lfMin: lf.get(t.id),
        totalFloatMin,
        freeFloatMin,
        isCritical
      };
    });

    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const criticalTaskIds = nodes.filter((n) => n.isCritical).map((n) => n.id);
    const maxLayer = nodes.reduce((m, n) => Math.max(m, n.layer), 0);

    return {
      nodes,
      nodeMap,
      topoOrder,
      criticalTaskIds,
      projectMakespanMin,
      totalWorkMin,
      parallelSpeedup: projectMakespanMin > 0 ? totalWorkMin / projectMakespanMin : 1,
      maxLayer
    };
  }

  /**
   * Single-worker dependency-respecting scheduler supporting 3 policies:
   * - "wspt": Weighted Shortest Processing Time (weight / duration) descending
   * - "critical": Minimum Total Float ascending, then weight descending
   * - "shortest": Shortest Processing Time (duration) ascending
   * Splits work into Pomodoro focus blocks (workBlockMin + breakMin) with optional daily horizon.
   */
  function scheduleWorkflow(rawTasks, options) {
    const opts = options || {};
    const policy = opts.policy || "wspt"; // "wspt" | "critical" | "shortest"
    const focusMin = Math.max(10, Number(opts.focusBlockMin || 25));
    const breakMin = Math.max(0, Number(opts.breakMin || 5));
    const dayStartHour = Number(opts.dayStartHour ?? 9);
    const dayCapacityMin = Math.max(focusMin, Number(opts.dayCapacityMin || 360));
    const startDateIso = opts.startDateIso || "2026-11-16";

    const cpm = analyzeCriticalPath(rawTasks, opts.slip);
    const remainingDeps = new Map();
    for (const n of cpm.nodes) {
      remainingDeps.set(n.id, n.deps.length);
    }

    const ready = cpm.nodes.filter((n) => n.deps.length === 0).map((n) => n.id);
    const executionOrder = [];
    const done = new Set();

    function scoreForPolicy(node) {
      if (policy === "critical") {
        return [-node.totalFloatMin, node.wsptRatio, -node.effectiveDurationMin];
      }
      if (policy === "shortest") {
        return [-node.effectiveDurationMin, node.weight, -node.totalFloatMin];
      }
      // WSPT default
      return [node.wsptRatio, -node.totalFloatMin, node.weight];
    }

    function compareIds(aId, bId) {
      const sa = scoreForPolicy(cpm.nodeMap.get(aId));
      const sb = scoreForPolicy(cpm.nodeMap.get(bId));
      for (let i = 0; i < sa.length; i++) {
        if (Math.abs(sa[i] - sb[i]) > 1e-9) return sb[i] - sa[i];
      }
      return aId.localeCompare(bId);
    }

    let cursorWorkMin = 0;
    let totalWeightedCompletion = 0;
    const taskTimeline = [];

    while (ready.length > 0) {
      ready.sort(compareIds);
      const nextId = ready.shift();
      const node = cpm.nodeMap.get(nextId);
      done.add(nextId);
      executionOrder.push(nextId);

      const startWorkMin = cursorWorkMin;
      const endWorkMin = cursorWorkMin + node.effectiveDurationMin;
      cursorWorkMin = endWorkMin;
      totalWeightedCompletion += node.weight * endWorkMin;

      taskTimeline.push({
        id: node.id,
        title: node.title,
        category: node.category,
        durationMin: node.effectiveDurationMin,
        weight: node.weight,
        isCritical: node.isCritical,
        totalFloatMin: node.totalFloatMin,
        startWorkMin,
        endWorkMin
      });

      for (const sid of node.succs) {
        const rem = remainingDeps.get(sid) - 1;
        remainingDeps.set(sid, rem);
        if (rem === 0 && !done.has(sid)) {
          ready.push(sid);
        }
      }
    }

    // Map serial taskTimeline into concrete Pomodoro focus & break blocks across days
    const [baseY, baseM, baseD] = startDateIso.split("-").map(Number);
    const baseUtcMs = Date.UTC(baseY || 2026, (baseM || 11) - 1, baseD || 16, Math.floor(dayStartHour), Math.round((dayStartHour % 1) * 60), 0);

    const blocks = [];
    let dayIndex = 0;
    let dayUsedWorkMin = 0;
    let dayClockOffsetMin = 0;

    for (const item of taskTimeline) {
      let rem = item.durationMin;
      let part = 1;
      while (rem > 0) {
        if (dayUsedWorkMin >= dayCapacityMin) {
          dayIndex++;
          dayUsedWorkMin = 0;
          dayClockOffsetMin = 0;
        }
        const availToday = dayCapacityMin - dayUsedWorkMin;
        const slice = Math.min(rem, focusMin, availToday);
        const startMs = baseUtcMs + dayIndex * 86400000 + dayClockOffsetMin * 60000;
        const endMs = startMs + slice * 60000;

        blocks.push({
          taskId: item.id,
          title: item.title,
          part,
          dayIndex: dayIndex + 1,
          durationMin: slice,
          isCritical: item.isCritical,
          startIso: new Date(startMs).toISOString(),
          endIso: new Date(endMs).toISOString(),
          type: "focus"
        });

        rem -= slice;
        part++;
        dayUsedWorkMin += slice;
        dayClockOffsetMin += slice;

        if (breakMin > 0 && (rem > 0 || item !== taskTimeline[taskTimeline.length - 1])) {
          if (dayUsedWorkMin < dayCapacityMin) {
            dayClockOffsetMin += breakMin;
          }
        }
      }
    }

    return {
      policy,
      cpm,
      executionOrder,
      taskTimeline,
      blocks,
      totalWeightedCompletion,
      totalDays: dayIndex + 1,
      totalFocusBlocks: blocks.length
    };
  }

  function formatIcsUtc(isoStr) {
    return isoStr.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  }

  function escapeIcsText(s) {
    return String(s || "")
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r?\n/g, "\\n");
  }

  /**
   * Generates an RFC 5545 compliant .ics VCALENDAR containing every scheduled Pomodoro focus block.
   */
  function exportScheduleToIcs(scheduleResult, calendarName) {
    const calTitle = escapeIcsText(calendarName || "CadenceDAG Focus Schedule");
    const dtStamp = formatIcsUtc(new Date("2026-11-14T12:00:00Z").toISOString());
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//CadenceDAG//Offline CPM Scheduler//EN",
      `X-WR-CALNAME:${calTitle}`,
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH"
    ];

    for (let i = 0; i < scheduleResult.blocks.length; i++) {
      const b = scheduleResult.blocks[i];
      const critLabel = b.isCritical ? "[CRITICAL]" : "[FLOAT]";
      const summary = escapeIcsText(`${critLabel} ${b.title} (${b.taskId} p${b.part})`);
      const desc = escapeIcsText(
        `Policy: ${scheduleResult.policy.toUpperCase()} | Task ${b.taskId} | Block ${b.durationMin}m | Critical: ${b.isCritical ? "Yes" : "No"}`
      );
      lines.push(
        "BEGIN:VEVENT",
        `UID:cadencedag-${b.taskId}-p${b.part}-${i}@local.offline`,
        `DTSTAMP:${dtStamp}`,
        `DTSTART:${formatIcsUtc(b.startIso)}`,
        `DTEND:${formatIcsUtc(b.endIso)}`,
        `SUMMARY:${summary}`,
        `DESCRIPTION:${desc}`,
        "END:VEVENT"
      );
    }

    lines.push("END:VCALENDAR");
    return lines.join("\r\n") + "\r\n";
  }

  return {
    PRESET_WORKFLOWS,
    validateAndTopoSort,
    analyzeCriticalPath,
    scheduleWorkflow,
    exportScheduleToIcs
  };
});
