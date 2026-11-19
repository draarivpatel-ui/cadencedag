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
    },
    {
      id: "ap-robotics-week",
      name: "AP Exam & Robotics Build Week (9 Tasks)",
      tasks: [
        { id: "A1", title: "AP Bio Free Response Set", durationMin: 40, weight: 9, category: "AP Prep", deps: [] },
        { id: "A2", title: "Robotics Chassis Assembly", durationMin: 60, weight: 10, category: "Robotics", deps: [] },
        { id: "A3", title: "AP Calc BC Review Sheet", durationMin: 35, weight: 8, category: "AP Prep", deps: ["A1"] },
        { id: "A4", title: "Sensor Wiring & Checkout", durationMin: 45, weight: 9, category: "Robotics", deps: ["A2"] },
        { id: "A5", title: "Study Group Formula Swap", durationMin: 25, weight: 6, category: "AP Prep", deps: ["A3"] },
        { id: "A6", title: "Autonomous Path Code", durationMin: 70, weight: 10, category: "Robotics", deps: ["A4"] },
        { id: "A7", title: "Mock AP Exam Timed Run", durationMin: 90, weight: 10, category: "AP Prep", deps: ["A3", "A5"] },
        { id: "A8", title: "Robot Field Trial & Log", durationMin: 50, weight: 9, category: "Robotics", deps: ["A6"] },
        { id: "A9", title: "Demo Day Checkout List", durationMin: 30, weight: 8, category: "Robotics", deps: ["A7", "A8"] }
      ]
    }
  ];

  // Parse a numeric option, falling back only when the value is missing or
  // not a finite number. Zero and negative values pass through untouched so
  // callers can clamp with their own minimums.
  function numOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

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
    const focusMin = Math.max(10, numOr(opts.focusBlockMin, 25));
    // Explicit nullish fallback: breakMin = 0 is a real setting (no gaps
    // between blocks), not a missing value.
    const breakMin = opts.breakMin === undefined || opts.breakMin === null
      ? 5 : Math.max(0, numOr(opts.breakMin, 5));
    const dayStartHour = opts.dayStartHour === undefined || opts.dayStartHour === null
      ? 9 : numOr(opts.dayStartHour, 9);
    // The daily budget is a hard cap on focus work per day, independent of the
    // focus block length. A 90m block still stops at the remaining budget, so
    // a 70m task on a 60m budget schedules 60m on day 1 and 10m on day 2
    // instead of silently raising the day's capacity to the block length.
    // The floor of 1 minute keeps the slicing loop terminating.
    const dayCapacityMin = Math.max(1, numOr(opts.dayCapacityMin, 360));
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
    // dayStartHour is wall-clock time. utcOffsetMin follows Date#getTimezoneOffset
    // (minutes to add to local time to reach UTC; 360 in US Central standard
    // time), so 9:00 local becomes 15:00Z there. The default 0 keeps Node runs
    // deterministic and treats the start hour as UTC.
    const utcOffsetMin = opts.utcOffsetMin === undefined || opts.utcOffsetMin === null
      ? 0 : numOr(opts.utcOffsetMin, 0);
    // Each day anchors its own local wall-clock start via calendar date
    // arithmetic. Adding fixed 86,400,000 ms drifts an hour across daylight
    // saving transitions; Date.UTC(y, m, d + dayIdx, h, min) keeps 09:00
    // local on every calendar day. utcOffsetMin may be a number (one zone for
    // the whole plan) or a function(dayIndex) so callers can hand the true
    // per-day offset when DST shifts mid-plan.
    const baseOffsetH = Math.floor(dayStartHour);
    const baseOffsetM = Math.round((dayStartHour % 1) * 60);
    const offsetForDay = typeof opts.utcOffsetMin === "function"
      ? (dayIdx) => numOr(opts.utcOffsetMin(dayIdx), 0)
      : () => utcOffsetMin;
    const dayAnchorMs = (dayIdx) => {
      // Calendar-date arithmetic in the offset zone, so month lengths and
      // leap years stay exact without any 86400000 multiplication.
      const localMs = Date.UTC(baseY || 2026, (baseM || 11) - 1, (baseD || 16) + dayIdx, baseOffsetH, baseOffsetM, 0);
      return localMs + offsetForDay(dayIdx) * 60000;
    };

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
        const startMs = dayAnchorMs(dayIndex) + dayClockOffsetMin * 60000;
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

        // A break separates two adjacent focus blocks on the same day. When
        // the slice ends exactly at the daily budget, the next slice rolls to
        // a fresh day, so no break is inserted (a break must never push past
        // the budget into the next day's window).
        const moreWorkToday = rem > 0 && dayUsedWorkMin < dayCapacityMin;
        const nextTaskToday = rem === 0 && item !== taskTimeline[taskTimeline.length - 1]
          && dayUsedWorkMin < dayCapacityMin;
        if (breakMin > 0 && (moreWorkToday || nextTaskToday)) {
          dayClockOffsetMin += breakMin;
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

  /**
   * Pure side-by-side policy comparison. Runs the same dependency-respecting
   * single-worker scheduler under each policy and reports the weighted
   * completion sum, the first three executed task ids, and how many minutes
   * of high-priority work (weight >= 8) finish inside the first 120 minutes
   * of work. The horizon is cumulative working minutes (breaks and day
   * rollover excluded), not wall-clock hours, so a 120 minute horizon is
   * exactly the first two hours of focused work.
   */
  function comparePolicies(rawTasks, options) {
    const opts = options || {};
    const horizonMin = Math.max(1, numOr(opts.horizonMin, 120));
    const highPriorityWeight = numOr(opts.highPriorityWeight, 8);
    const shared = {
      focusBlockMin: numOr(opts.focusBlockMin, 25),
      breakMin: opts.breakMin === undefined ? 5 : opts.breakMin,
      dayCapacityMin: numOr(opts.dayCapacityMin, 360),
      dayStartHour: opts.dayStartHour === undefined ? 9 : opts.dayStartHour,
      startDateIso: opts.startDateIso || "2026-11-16",
      // The injected slip belongs to the plan itself, so every policy cell
      // scores the same delayed graph the headline KPI shows.
      slip: opts.slip || null
    };
    const policies = [
      { id: "wspt", label: "WSPT" },
      { id: "critical", label: "Critical-First" },
      { id: "shortest", label: "SPT" }
    ];
    const results = policies.map((p) => {
      const sched = scheduleWorkflow(rawTasks, Object.assign({}, shared, { policy: p.id }));
      const highPriorityMinutesFirstHorizon = sched.taskTimeline.reduce((sum, item) => {
        if (item.weight < highPriorityWeight) return sum;
        const overlap = Math.max(0, Math.min(item.endWorkMin, horizonMin) - item.startWorkMin);
        return sum + overlap;
      }, 0);
      return {
        id: p.id,
        label: p.label,
        weightedCompletion: sched.totalWeightedCompletion,
        firstThreeTaskIds: sched.executionOrder.slice(0, 3),
        highPriorityMinutesFirstHorizon,
        focusBlocks: sched.totalFocusBlocks
      };
    });
    const bestWeightedCompletion = Math.min(...results.map((r) => r.weightedCompletion));
    const bestHighPriorityMinutes = Math.max(...results.map((r) => r.highPriorityMinutesFirstHorizon));
    return {
      horizonMin,
      highPriorityWeight,
      policies: results,
      bestWeightedCompletion,
      bestHighPriorityMinutes,
      weightedCompletionSaving: Math.max(...results.map((r) => r.weightedCompletion)) - bestWeightedCompletion
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

  // RFC 5545 TEXT value characters that must stay out of a UID: they break
  // line folding or property parsing. Everything else in a task id passes
  // through so exported events round-trip against the plan.
  function sanitizeIcsUidPart(s) {
    return String(s || "")
      .replace(/\\/g, "-")
      .replace(/;/g, "-")
      .replace(/,/g, "-")
      .replace(/[\r\n:]/g, "-")
      .replace(/\s+/g, "-");
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
      const uidPart = sanitizeIcsUidPart(b.taskId);
      lines.push(
        "BEGIN:VEVENT",
        `UID:cadencedag-${uidPart}-p${b.part}-${i}@local.offline`,
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

  /* ------------------------------------------------------------------ */
  /* Advanced analytics: critical paths, resources and schedule risk       */
  /* ------------------------------------------------------------------ */

  /**
   * Enumerate every distinct longest dependency chain through the DAG.
   * Each path is an ordered array of task ids whose durations sum to the
   * project makespan. Ties are resolved deterministically by task id.
   * Accepts the same slip options as analyzeCriticalPath so delay analytics
   * on the active (possibly slipped) plan enumerate the true chains.
   */
  function enumerateCriticalPaths(rawTasks, slipOptions) {
    const { tasks, byId, succs, topoOrder } = validateAndTopoSort(rawTasks);
    const slipTaskId = slipOptions && slipOptions.taskId ? String(slipOptions.taskId) : "";
    const slipMin = slipOptions && Number.isFinite(Number(slipOptions.slipMin)) ? Math.max(0, Number(slipOptions.slipMin)) : 0;
    const dur = new Map();
    for (const t of tasks) dur.set(t.id, t.durationMin + (t.id === slipTaskId ? slipMin : 0));
    const ef = new Map();
    for (const id of topoOrder) {
      const t = byId.get(id);
      let start = 0;
      for (const dep of t.deps) start = Math.max(start, ef.get(dep));
      ef.set(id, start + dur.get(id));
    }
    const makespan = Math.max(...ef.values());
    const ends = topoOrder.filter((id) => ef.get(id) === makespan && succs.get(id).length === 0);
    const paths = [];
    const seen = new Set();

    function walk(id, tail) {
      const chain = [id, ...tail];
      const t = byId.get(id);
      const preds = t.deps.slice().sort();
      let extended = false;
      for (const dep of preds) {
        if (Math.abs(ef.get(dep) - (ef.get(id) - dur.get(id))) < 1e-6) {
          extended = true;
          walk(dep, chain);
        }
      }
      if (!extended) {
        // JSON.stringify keeps ["a>b","c"] and ["a","b>c"] distinct; a plain
        // ">" join would collapse them into the same key.
        const key = JSON.stringify(chain);
        if (!seen.has(key)) { seen.add(key); paths.push(chain); }
      }
    }
    for (const end of ends.slice().sort()) walk(end, []);
    paths.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { makespanMin: makespan, criticalPaths: paths, pathCount: paths.length };
  }

  /**
   * Deterministic multi-worker list scheduling. Ready tasks are prioritized
   * by the same policy scores as scheduleWorkflow, then assigned to the
   * worker that becomes free earliest. Returns a per-worker ledger, the
   * wall-clock makespan and utilization.
   */
  function scheduleWithWorkers(rawTasks, options) {
    const opts = options || {};
    const policy = opts.policy || "wspt";
    const workers = Math.max(1, Math.floor(Number(opts.workers) || 1));
    const cpm = analyzeCriticalPath(rawTasks, opts.slip);
    const remaining = new Map();
    for (const n of cpm.nodes) remaining.set(n.id, n.deps.length);
    const ready = cpm.nodes.filter((n) => n.deps.length === 0).map((n) => n.id);
    const freeAt = new Array(workers).fill(0);
    const ledger = freeAt.map((_, i) => ({ worker: i + 1, tasks: [], busyMin: 0 }));
    const starts = new Map();
    const ends = new Map();

    function score(node) {
      if (policy === "critical") return [-node.totalFloatMin, node.wsptRatio, -node.effectiveDurationMin];
      if (policy === "shortest") return [-node.effectiveDurationMin, node.weight, -node.totalFloatMin];
      return [node.wsptRatio, -node.totalFloatMin, node.weight];
    }
    function compare(aId, bId) {
      const sa = score(cpm.nodeMap.get(aId)), sb = score(cpm.nodeMap.get(bId));
      for (let i = 0; i < sa.length; i++) {
        if (Math.abs(sa[i] - sb[i]) > 1e-9) return sb[i] - sa[i];
      }
      return aId.localeCompare(bId);
    }

    while (ready.length > 0) {
      // Non-delay list scheduling: the earliest-free worker takes the ready
      // task that can start soonest; the policy only breaks ties. Without
      // this, a high-priority successor could reserve a worker while an
      // already-startable critical task waited.
      let w = 0;
      for (let i = 1; i < workers; i++) if (freeAt[i] < freeAt[w]) w = i;
      const earliest = (tid) => {
        let t = freeAt[w];
        for (const dep of cpm.nodeMap.get(tid).deps) t = Math.max(t, ends.get(dep));
        return t;
      };
      ready.sort((a, b) => (earliest(a) - earliest(b)) || compare(a, b));
      const id = ready.shift();
      const node = cpm.nodeMap.get(id);
      const start = earliest(id);
      const end = start + node.effectiveDurationMin;
      starts.set(id, start);
      ends.set(id, end);
      freeAt[w] = end;
      ledger[w].tasks.push({ id, title: node.title, startMin: start, endMin: end, durationMin: node.effectiveDurationMin });
      ledger[w].busyMin += node.effectiveDurationMin;
      for (const sid of node.succs) {
        const rem = remaining.get(sid) - 1;
        remaining.set(sid, rem);
        if (rem === 0) ready.push(sid);
      }
    }
    const makespanMin = Math.max(0, ...freeAt);
    const totalWorkMin = cpm.totalWorkMin;
    return {
      policy, workers, cpm, ledger, starts, ends,
      makespanMin, totalWorkMin,
      utilization: makespanMin > 0 ? totalWorkMin / (makespanMin * workers) : 0,
      parallelSpeedup: makespanMin > 0 ? totalWorkMin / makespanMin : 1,
      idleMin: makespanMin * workers - totalWorkMin
    };
  }

  /**
   * Deterministic schedule risk analysis. Instead of random sampling, it
   * injects a bounded delay into each task in turn (and optionally into
   * every critical task at once) and measures the resulting makespan.
   * Returns the worst case, mean, and the fraction of tasks whose delay
   * is fully absorbed by float.
   */
  function analyzeScheduleRisk(rawTasks, options) {
    const opts = options || {};
    const delayMin = Math.max(0, numOr(opts.delayMin, 0));
    const baseline = analyzeCriticalPath(rawTasks);
    const samples = [];
    for (const node of baseline.nodes) {
      const withSlip = analyzeCriticalPath(rawTasks, { taskId: node.id, slipMin: delayMin });
      const delta = withSlip.projectMakespanMin - baseline.projectMakespanMin;
      samples.push({
        taskId: node.id,
        title: node.title,
        floatMin: node.totalFloatMin,
        delayMin,
        absorbed: Math.min(delayMin, Math.max(0, node.totalFloatMin)),
        makespanMin: withSlip.projectMakespanMin,
        deltaMin: delta,
        // At the exact float boundary (delayMin >= totalFloat) the delayed
        // task itself sits at zero float, so it is critical even when the
        // makespan delta is still 0.
        criticalAfter: node.isCritical || delayMin >= node.totalFloatMin || delta > 0
      });
    }
    const deltas = samples.map((s) => s.deltaMin);
    const maxDelta = Math.max(0, ...deltas);
    const meanDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
    const absorbedCount = samples.filter((s) => s.deltaMin === 0).length;
    return {
      delayMin,
      baselineMakespanMin: baseline.projectMakespanMin,
      worstCaseMakespanMin: baseline.projectMakespanMin + maxDelta,
      meanDeltaMin: Math.round(meanDelta * 1e6) / 1e6,
      maxDeltaMin: maxDelta,
      absorbedCount,
      sampleCount: samples.length,
      absorbedFraction: samples.length ? absorbedCount / samples.length : 0,
      slackCoverage: baseline.nodes.length
        ? baseline.nodes.filter((n) => n.totalFloatMin >= delayMin).length / baseline.nodes.length
        : 0,
      samples,
      note: "Deterministic one-task-at-a-time delay sweep, not a Monte Carlo simulation"
    };
  }

  /**
   * Validate an .ics string produced by exportScheduleToIcs: structural
   * markers, required PRODID and per-event UID/DTSTAMP properties, one
   * DTSTART/DTEND pair per event, real UTC calendar timestamps (valid month,
   * day for month, hour and minute ranges), CRLF line endings and strictly
   * increasing event times.
   */
  function validateIcs(ics) {
    const text = String(ics || "");
    const lines = text.split("\r\n");
    const errors = [];
    if (lines[0] !== "BEGIN:VCALENDAR") errors.push("missing VCALENDAR start");
    if (!lines.includes("VERSION:2.0")) errors.push("missing VERSION:2.0");
    if (!lines.some((l) => l.startsWith("PRODID:"))) errors.push("missing PRODID");
    if (!lines.includes("CALSCALE:GREGORIAN")) errors.push("missing CALSCALE");
    if (lines[lines.length - 2] !== "END:VCALENDAR") errors.push("missing VCALENDAR end");
    if (/[\r\n]/.test(text.replace(/\r\n/g, ""))) errors.push("line endings are not CRLF");
    const begins = lines.filter((l) => l === "BEGIN:VEVENT").length;
    const ends = lines.filter((l) => l === "END:VEVENT").length;
    if (begins !== ends) errors.push("unbalanced VEVENT markers");

    const shape = /^\d{8}T\d{6}Z$/;
    // RFC 5545 calendar truth, not just a digit shape: month 01-12, day valid
    // for that month (leap years included), hour 00-23, minute and second
    // 00-59.
    const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
    function validUtcTimestamp(ts) {
      if (!shape.test(ts)) return false;
      const year = Number(ts.slice(0, 4));
      const month = Number(ts.slice(4, 6));
      const day = Number(ts.slice(6, 8));
      const hour = Number(ts.slice(9, 11));
      const minute = Number(ts.slice(11, 13));
      const second = Number(ts.slice(13, 15));
      if (month < 1 || month > 12) return false;
      if (day < 1 || day > daysInMonth(year, month)) return false;
      if (hour > 23 || minute > 59 || second > 59) return false;
      return true;
    }

    let event = null;
    let eventIndex = 0;
    const seenUids = new Map();
    for (const line of lines) {
      if (line === "BEGIN:VEVENT") {
        if (event) errors.push("unbalanced VEVENT markers: nested event");
        event = { starts: [], ends: [], uids: [], stamps: [] };
        eventIndex++;
      } else if (line === "END:VEVENT") {
        if (!event) {
          errors.push("unbalanced VEVENT markers: end before start");
          continue;
        }
        if (event.starts.length !== 1 || event.ends.length !== 1) {
          errors.push(`missing or duplicate event timestamps at event ${eventIndex}`);
        } else {
          const start = event.starts[0], end = event.ends[0];
          const startOk = validUtcTimestamp(start);
          const endOk = validUtcTimestamp(end);
          if (!startOk) errors.push(`invalid DTSTART at event ${eventIndex}`);
          if (!endOk) errors.push(`invalid DTEND at event ${eventIndex}`);
          if (startOk && endOk && end <= start) {
            errors.push(`DTEND must follow DTSTART at event ${eventIndex}`);
          }
        }
        if (event.uids.length !== 1 || !event.uids[0]) {
          errors.push(`missing or duplicate UID at event ${eventIndex}`);
        } else {
          // RFC 5545: UIDs are globally unique; two events sharing one fail.
          const uid = event.uids[0];
          if (seenUids.has(uid)) {
            errors.push(`UID is not unique: events ${seenUids.get(uid)} and ${eventIndex} share ${uid}`);
          } else {
            seenUids.set(uid, eventIndex);
          }
        }
        if (event.stamps.length !== 1 || !validUtcTimestamp(event.stamps[0])) {
          errors.push(`missing or invalid DTSTAMP at event ${eventIndex}`);
        }
        event = null;
      } else if (line.startsWith("UID:")) {
        if (!event) errors.push("UID outside VEVENT");
        else event.uids.push(line.slice(4));
      } else if (line.startsWith("DTSTAMP:")) {
        if (!event) errors.push("DTSTAMP outside VEVENT");
        else event.stamps.push(line.slice(8));
      } else if (line.startsWith("DTSTART:") || line.startsWith("DTEND:")) {
        if (!event) errors.push("event timestamp outside VEVENT");
        else if (line.startsWith("DTSTART:")) event.starts.push(line.slice(8));
        else event.ends.push(line.slice(6));
      }
    }
    if (event) errors.push("unbalanced VEVENT markers: unclosed event");
    return { valid: errors.length === 0, errors, eventCount: begins };
  }

  /** Compact deterministic summary of a plan for diagnostics and exports. */
  function planTelemetry(rawTasks, options) {
    const opts = options || {};
    const cpm = analyzeCriticalPath(rawTasks, opts.slip);
    const paths = enumerateCriticalPaths(rawTasks);
    // delayMin: 0 is a real setting, not a missing value; only a missing or
    // non-numeric delay falls back to the default sweep of 10 minutes.
    const risk = analyzeScheduleRisk(rawTasks, { delayMin: numOr(opts.delayMin, 10) });
    const workers = Math.max(1, Math.floor(numOr(opts.workers, 2)));
    const multi = scheduleWithWorkers(rawTasks, { workers, policy: opts.policy || "wspt", slip: opts.slip });
    const single = scheduleWorkflow(rawTasks, Object.assign({ focusBlockMin: 25, breakMin: 5 }, opts));
    return {
      taskCount: cpm.nodes.length,
      makespanMin: cpm.projectMakespanMin,
      totalWorkMin: cpm.totalWorkMin,
      criticalTaskCount: cpm.criticalTaskIds.length,
      criticalPathCount: paths.pathCount,
      maxLayer: cpm.maxLayer,
      parallelSpeedup: cpm.parallelSpeedup,
      singleWorkerWeightedCompletion: single.totalWeightedCompletion,
      multiWorkerMakespanMin: multi.makespanMin,
      multiWorkerUtilization: Math.round(multi.utilization * 1e6) / 1e6,
      multiWorkerIdleMin: multi.idleMin,
      workers,
      riskDelayMin: risk.delayMin,
      riskAbsorbedFraction: Math.round(risk.absorbedFraction * 1e6) / 1e6,
      riskWorstCaseMakespanMin: risk.worstCaseMakespanMin,
      focusBlocks: single.totalFocusBlocks,
      totalDays: single.totalDays
    };
  }

  return {
    PRESET_WORKFLOWS,
    validateAndTopoSort,
    analyzeCriticalPath,
    scheduleWorkflow,
    comparePolicies,
    exportScheduleToIcs,
    enumerateCriticalPaths,
    scheduleWithWorkers,
    analyzeScheduleRisk,
    validateIcs,
    planTelemetry
  };
});
