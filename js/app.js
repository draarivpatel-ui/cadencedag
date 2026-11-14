(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CadenceDagApp = factory(root.CadenceDagEngine, root.CadenceDagSvg);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (Engine, Svg) {
  "use strict";

  function createController(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d) return null;

    const state = {
      presetId: Engine.PRESET_WORKFLOWS[0].id,
      tasks: Engine.PRESET_WORKFLOWS[0].tasks.map((t) => Object.assign({}, t, { deps: t.deps.slice() })),
      policy: "wspt",
      focusBlockMin: 25,
      breakMin: 5,
      dayCapacityMin: 300,
      dayStartHour: 9,
      startDateIso: "2026-11-16",
      slipTaskId: "",
      slipMin: 0,
      selectedTaskId: Engine.PRESET_WORKFLOWS[0].tasks[0].id,
      capyClicks: 0
    };

    const $ = (id) => d.getElementById(id);

    function setText(id, val) {
      const el = $(id);
      if (el) el.textContent = val;
    }

    function showError(msg) {
      const box = $("error-banner");
      if (!box) return;
      box.textContent = msg || "";
      box.classList.toggle("is-visible", Boolean(msg));
    }

    function applyPreset(presetId) {
      const found = Engine.PRESET_WORKFLOWS.find((w) => w.id === presetId);
      if (!found) return;
      state.presetId = found.id;
      state.tasks = found.tasks.map((t) => Object.assign({}, t, { deps: t.deps.slice() }));
      state.slipTaskId = "";
      state.slipMin = 0;
      state.selectedTaskId = found.tasks[0] ? found.tasks[0].id : "";
      showError("");
      populateSlipDropdown();
      render();
    }

    function populateSlipDropdown() {
      const sel = $("slip-task-select");
      if (!sel) return;
      sel.innerHTML = "";
      const noneOpt = d.createElement("option");
      noneOpt.value = "";
      noneOpt.textContent = "None (Nominal Duration)";
      sel.appendChild(noneOpt);
      state.tasks.forEach((t) => {
        const opt = d.createElement("option");
        opt.value = t.id;
        opt.textContent = `${t.id}: ${t.title} (${t.durationMin}m)`;
        sel.appendChild(opt);
      });
      sel.value = state.slipTaskId;
    }

    function bindTabs() {
      const tabs = d.querySelectorAll(".tab");
      tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          tabs.forEach((t) => t.setAttribute("aria-selected", "false"));
          tab.setAttribute("aria-selected", "true");
          const target = tab.getAttribute("aria-controls");
          d.querySelectorAll(".panel").forEach((p) => {
            p.classList.toggle("is-active", p.id === target);
          });
        });
      });
    }

    function bindInputs() {
      const presetSel = $("preset-select");
      if (presetSel) {
        presetSel.addEventListener("change", () => applyPreset(presetSel.value));
      }

      const onInput = (id, fn) => {
        const el = $(id);
        if (!el) return;
        el.addEventListener("change", () => { fn(el.value); render(); });
        el.addEventListener("input", () => { fn(el.value); render(); });
      };

      onInput("policy-select", (v) => { state.policy = v; });
      onInput("focus-min-input", (v) => { state.focusBlockMin = Math.max(15, Math.min(90, Number(v) || 25)); });
      onInput("break-min-input", (v) => { state.breakMin = Math.max(0, Math.min(30, Number(v) || 5)); });
      onInput("cap-min-input", (v) => { state.dayCapacityMin = Math.max(60, Math.min(720, Number(v) || 300)); });
      onInput("start-date-input", (v) => { state.startDateIso = v || "2026-11-16"; });
      onInput("slip-task-select", (v) => { state.slipTaskId = v; });
      onInput("slip-min-input", (v) => { state.slipMin = Math.max(0, Number(v) || 0); });

      const addBtn = $("btn-add-task");
      if (addBtn) {
        addBtn.addEventListener("click", () => {
          const id = (($("new-task-id") || {}).value || "").trim() || `T${state.tasks.length + 1}`;
          const title = (($("new-task-title") || {}).value || "").trim() || `Custom Task ${id}`;
          const dur = Number((($("new-task-dur") || {}).value || "30"));
          const wt = Number((($("new-task-weight") || {}).value || "7"));
          const depsRaw = (($("new-task-deps") || {}).value || "").trim();
          const deps = depsRaw ? depsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
          const candidate = state.tasks.concat([{ id, title, durationMin: dur, weight: wt, category: "Custom", deps }]);
          try {
            Engine.validateAndTopoSort(candidate);
            state.tasks = candidate;
            state.selectedTaskId = id;
            showError("");
            populateSlipDropdown();
            render();
          } catch (err) {
            showError(err.message);
          }
        });
      }

      const icsBtn = $("btn-export-ics");
      if (icsBtn) {
        icsBtn.addEventListener("click", () => {
          const sched = computeCurrent();
          if (!sched) return;
          const ics = Engine.exportScheduleToIcs(sched.schedule, "CadenceDAG Focus Plan");
          triggerDownload("cadencedag_schedule.ics", ics, "text/calendar");
        });
      }

      const jsonBtn = $("btn-export-json");
      if (jsonBtn) {
        jsonBtn.addEventListener("click", () => {
          const sched = computeCurrent();
          if (!sched) return;
          const payload = {
            presetId: state.presetId,
            policy: sched.schedule.policy,
            makespanMin: sched.schedule.cpm.projectMakespanMin,
            totalWorkMin: sched.schedule.cpm.totalWorkMin,
            criticalPath: sched.schedule.cpm.criticalTaskIds,
            executionOrder: sched.schedule.executionOrder,
            blocks: sched.schedule.blocks
          };
          triggerDownload("cadencedag_plan.json", JSON.stringify(payload, null, 2), "application/json");
        });
      }

      const capy = $("capybara-easter");
      if (capy) {
        capy.addEventListener("click", () => {
          state.capyClicks += 1;
          const notes = [
            "Capybara Chief Slack Auditor: staying calm around 0m float.",
            "Capybara tip: prioritize high weight-to-duration nodes on critical edges.",
            "Capybara spotted! Hydration break (+5m) keeps critical paths steady."
          ];
          setText("capybara-status", notes[state.capyClicks % notes.length]);
        });
      }
    }

    function triggerDownload(filename, content, mime) {
      if (typeof Blob === "undefined" || !d.createElement) return;
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = d.createElement("a");
      a.href = url;
      a.download = filename;
      d.body.appendChild(a);
      a.click();
      d.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    function computeCurrent() {
      try {
        const baselineCpm = Engine.analyzeCriticalPath(state.tasks);
        const schedule = Engine.scheduleWorkflow(state.tasks, {
          policy: state.policy,
          focusBlockMin: state.focusBlockMin,
          breakMin: state.breakMin,
          dayCapacityMin: state.dayCapacityMin,
          dayStartHour: state.dayStartHour,
          startDateIso: state.startDateIso,
          slip: state.slipTaskId && state.slipMin > 0 ? { taskId: state.slipTaskId, slipMin: state.slipMin } : null
        });
        showError("");
        return { baselineCpm, schedule };
      } catch (err) {
        showError(err.message);
        return null;
      }
    }

    function render() {
      const res = computeCurrent();
      if (!res) return;
      const { baselineCpm, schedule } = res;
      const cpm = schedule.cpm;
      const deltaMakespan = cpm.projectMakespanMin - baselineCpm.projectMakespanMin;

      setText("kpi-makespan", `${cpm.projectMakespanMin} min`);
      setText(
        "kpi-makespan-sub",
        deltaMakespan > 0
          ? `+${deltaMakespan}m deadline slip vs ${baselineCpm.projectMakespanMin}m baseline`
          : `Parallel speedup ${cpm.parallelSpeedup.toFixed(2)}x (${cpm.totalWorkMin}m work)`
      );
      setText("kpi-crit-count", `${cpm.criticalTaskIds.length} / ${cpm.nodes.length}`);
      setText("kpi-crit-sub", cpm.criticalTaskIds.join(" -> "));
      setText("kpi-blocks", `${schedule.totalFocusBlocks} blocks`);
      setText("kpi-blocks-sub", `${schedule.totalDays} day(s) @ ${state.focusBlockMin}m + ${state.breakMin}m`);
      setText("kpi-wspt", `${Math.round(schedule.totalWeightedCompletion).toLocaleString()}`);
      setText("kpi-wspt-sub", `Policy: ${state.policy.toUpperCase()} weighted sum w_i * C_i`);

      if (Svg) {
        Svg.renderDagGraph($("svg-dag"), cpm, state.selectedTaskId);
        Svg.renderGanttChart($("svg-gantt"), cpm);
      }

      // Slippage readout
      if (state.slipTaskId && state.slipMin > 0) {
        const baseNode = baselineCpm.nodeMap.get(state.slipTaskId);
        const absorbed = Math.min(state.slipMin, baseNode ? baseNode.totalFloatMin : 0);
        setText(
          "slip-summary",
          `Slip on ${state.slipTaskId} (+${state.slipMin}m): baseline float ${baseNode ? baseNode.totalFloatMin : 0}m absorbed ${absorbed}m; project makespan shifted by +${deltaMakespan}m.`
        );
      } else {
        setText("slip-summary", "No delay injected. Pick any task and add slip minutes to watch slack absorb small delays or push the deadline.");
      }

      // Node slack table
      const slackBody = $("slack-table-body");
      if (slackBody) {
        slackBody.innerHTML = "";
        cpm.nodes.forEach((n) => {
          const tr = d.createElement("tr");
          tr.innerHTML = `
            <td>${n.id}</td>
            <td>${n.title}</td>
            <td>${n.effectiveDurationMin}m</td>
            <td>[${n.esMin}, ${n.efMin}]</td>
            <td>${n.totalFloatMin}m</td>
            <td>${n.freeFloatMin}m</td>
            <td>${n.wsptRatio.toFixed(2)}</td>
            <td><span class="${n.isCritical ? "pill-crit" : "pill-float"}">${n.isCritical ? "CRITICAL" : "Float"}</span></td>
          `;
          slackBody.appendChild(tr);
        });
      }

      // Pomodoro schedule blocks table
      const blkBody = $("blocks-table-body");
      if (blkBody) {
        blkBody.innerHTML = "";
        schedule.blocks.forEach((b, idx) => {
          const startTime = b.startIso.slice(11, 16);
          const endTime = b.endIso.slice(11, 16);
          const tr = d.createElement("tr");
          tr.innerHTML = `
            <td>#${idx + 1}</td>
            <td>Day ${b.dayIndex} (${b.startIso.slice(0, 10)})</td>
            <td>${startTime}-${endTime} UTC</td>
            <td>${b.taskId} p${b.part} (${b.durationMin}m)</td>
            <td>${b.title}</td>
            <td><span class="${b.isCritical ? "pill-crit" : "pill-float"}">${b.isCritical ? "Critical" : "Buffer"}</span></td>
          `;
          blkBody.appendChild(tr);
        });
      }
    }

    function init() {
      const sel = $("preset-select");
      if (sel && sel.options.length === 0) {
        Engine.PRESET_WORKFLOWS.forEach((w) => {
          const opt = d.createElement("option");
          opt.value = w.id;
          opt.textContent = w.name;
          sel.appendChild(opt);
        });
      }
      populateSlipDropdown();
      bindTabs();
      bindInputs();
      render();
    }

    return { init, render, applyPreset, state };
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => {
      const ctrl = createController(document);
      if (ctrl) ctrl.init();
    });
  }

  return { createController };
});
