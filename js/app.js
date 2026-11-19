(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CadenceDagApp = factory(root.CadenceDagEngine, root.CadenceDagSvg);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (Engine, Svg) {
  "use strict";

  const STORAGE_KEY = "cadencedag.user.v1";

  // Every user-editable string (task ids, titles, deps) that reaches an
  // innerHTML sink goes through this. textContent sinks need no escaping.
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function todayLocalIso() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

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
      startDateIso: todayLocalIso(),
      slipTaskId: "",
      slipMin: 0,
      workers: 3,
      riskDelayMin: 10,
      selectedTaskId: Engine.PRESET_WORKFLOWS[0].tasks[0].id,
      capyClicks: 0,
      doneTaskIds: [],
      // blockKey is the "<taskId> p<part>" identity of the block the timer is
      // on, so the countdown survives queue recomputes (done, edits, deletes)
      // and rebases cleanly onto the first remaining block when the block
      // itself is gone. exhausted marks a finished queue and guards Start.
      focus: { index: 0, completed: 0, remainingSec: 25 * 60, running: false, intervalId: null, blockKey: null, exhausted: false },
      keyboardSelection: null,
      clockMode: "local",
      capyCelebration: false
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

    function setInspectorStatus(msg) {
      setText("inspector-status", msg || "");
    }

    function loadPersisted() {
      let raw = null;
      try {
        raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
      } catch (_err) {
        return;
      }
      // An initialized-but-empty store means the user deleted every task:
      // restore that empty state instead of resurrecting the preset tasks.
      if (raw === null || raw === undefined) return;
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch (_err) {
        return; // Corrupt JSON: the in-memory preset stays intact.
      }
      if (!data || !Array.isArray(data.tasks)) return;
      // An intentional empty array (every task deleted) is a real state:
      // restore it instead of resurrecting the preset tasks. Only a missing
      // key or unparseable JSON above falls back to the in-memory preset.
      if (data.tasks.length === 0) {
        state.tasks = [];
        state.doneTaskIds = [];
        state.selectedTaskId = "";
        state.presetId = typeof data.presetId === "string" ? data.presetId : state.presetId;
        return;
      }
      // Normalize each restored task before validation so a partially
      // written entry cannot poison the graph.
      const candidate = data.tasks
        .filter((t) => t && typeof t === "object" && t.id != null)
        .map((t) => Object.assign({}, t, {
          id: String(t.id).trim(),
          title: String(t.title || t.id).trim(),
          durationMin: Number(t.durationMin),
          weight: Number(t.weight ?? 5),
          deps: Array.isArray(t.deps) ? t.deps.map((dep) => String(dep).trim()).filter(Boolean) : []
        }));
      try {
        Engine.validateAndTopoSort(candidate);
      } catch (_err) {
        return;
      }
      state.tasks = candidate;
      state.presetId = typeof data.presetId === "string" ? data.presetId : state.presetId;
      state.doneTaskIds = Array.isArray(data.doneTaskIds)
        ? data.doneTaskIds.filter((id) => candidate.some((t) => t.id === id))
        : [];
      // Stale selections (a deleted task id, or a mismatched type) fall back
      // to the first existing task, or null on an empty graph.
      const fallbackId = candidate.length ? candidate[0].id : "";
      state.selectedTaskId = candidate.some((t) => t.id === data.selectedTaskId)
        ? data.selectedTaskId
        : fallbackId;
    }

    function persist() {
      try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          presetId: state.presetId,
          tasks: state.tasks.map((t) => Object.assign({}, t, { deps: t.deps.slice() })),
          doneTaskIds: state.doneTaskIds.slice(),
          selectedTaskId: state.selectedTaskId
        }));
      } catch (_err) {
        // Private browsing or a full storage quota must not break the app.
      }
    }

    function activeTasks() {
      // Completed tasks drop out of the remaining graph. Their dependents lose
      // that prerequisite so the live CPM and queue stay valid and advance.
      return state.tasks
        .filter((t) => state.doneTaskIds.indexOf(t.id) === -1)
        .map((t) => Object.assign({}, t, {
          deps: t.deps.filter((dep) => state.doneTaskIds.indexOf(dep) === -1)
        }));
    }

    function applyPreset(presetId) {
      const found = Engine.PRESET_WORKFLOWS.find((w) => w.id === presetId);
      if (!found) return;
      // Kill the running interval BEFORE any focus state is replaced, so a
      // preset switch or reset mid-countdown can never leak a ticking timer
      // into the new graph (Start would otherwise look inert).
      clearTimerInterval();
      state.presetId = found.id;
      state.tasks = found.tasks.map((t) => Object.assign({}, t, { deps: t.deps.slice() }));
      state.doneTaskIds = [];
      state.slipTaskId = "";
      state.slipMin = 0;
      state.selectedTaskId = found.tasks[0] ? found.tasks[0].id : "";
      state.focus = { index: 0, completed: 0, remainingSec: state.focusBlockMin * 60, running: false, intervalId: null, blockKey: null, exhausted: false };
      setInspectorStatus("");
      showError("");
      persist();
      populateSlipDropdown();
      // The inspector must follow the new preset, not keep the old task's fields.
      const picked = fillInspector(state.selectedTaskId);
      if (picked) setInspectorStatus(`Inspecting ${picked.t.id}: ${picked.t.title}.`);
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

    function setValue(id, val) {
      const el = $(id);
      if (el) el.value = val;
    }

    // Live CPM metrics for the selected task, computed on the remaining
    // graph. Returns null when the graph is empty or the task is gone.
    function selectedCpmNode(id) {
      const res = computeCurrent();
      if (!res) return null;
      return res.schedule.cpm.nodeMap.get(id) || null;
    }

    function fillInspector(id) {
      const t = state.tasks.find((task) => task.id === id);
      if (!t) {
        setText("inspector-cpm", "");
        return null;
      }
      setValue("inspector-title", t.title);
      setValue("inspector-duration", String(t.durationMin));
      setValue("inspector-weight", String(t.weight));
      setValue("inspector-deps", t.deps.join(", "));
      const done = state.doneTaskIds.indexOf(id) !== -1;
      setText("btn-toggle-done", done ? "Mark Not Done" : "Mark Done");
      // Read-only schedule readout: the selected task's live ES, EF, float
      // and critical status from the remaining graph.
      const n = selectedCpmNode(id);
      setText("inspector-cpm", n
        ? `ES ${n.esMin}m | EF ${n.efMin}m | Float ${n.totalFloatMin}m | ${n.isCritical ? "Critical (0m float)" : "Has float"}`
        : "");
      return { t, done };
    }

    function selectTask(id) {
      if (!state.tasks.some((t) => t.id === id)) return;
      state.selectedTaskId = id;
      const picked = fillInspector(id);
      if (!picked) return;
      const { t, done } = picked;
      setInspectorStatus(`Selected ${t.id}: ${t.title}. ${done ? "Marked done." : "Not done yet."}`);
      persist();
      render();
    }

    function bindSelection() {
      const dagSvg = $("svg-dag");
      if (dagSvg) {
        const pick = (ev) => {
          const target = ev.target;
          const g = target && typeof target.closest === "function"
            ? target.closest("g.dag-node")
            : (target && target.parentNode && target.parentNode.getAttribute && target.parentNode.getAttribute("class") === "dag-node" ? target.parentNode : null);
          if (!g) return;
          const id = g.getAttribute("data-id");
          if (id) {
            ev.preventDefault();
            state.keyboardSelection = ev.type === "keydown" ? { kind: "node", id } : null;
            selectTask(id);
          }
        };
        dagSvg.addEventListener("click", pick);
        dagSvg.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") pick(ev);
        });
      }
      const table = $("slack-table-body");
      if (table) {
        const pickRow = (ev) => {
          const target = ev.target;
          const row = target && typeof target.closest === "function" ? target.closest("tr[data-task-id]") : null;
          if (!row) return;
          const id = row.getAttribute("data-task-id");
          if (id) {
            state.keyboardSelection = ev.type === "keydown" ? { kind: "row", id } : null;
            selectTask(id);
          }
        };
        table.addEventListener("click", pickRow);
        table.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") pickRow(ev);
        });
      }
    }

    // After a keyboard-triggered selection re-renders the DOM, put focus back
    // on the matching node or row so keyboard users never fall back to body.
    function restoreKeyboardFocus() {
      const k = state.keyboardSelection;
      state.keyboardSelection = null;
      if (!k) return;
      const cssEscape = typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function"
        ? CSS.escape : (s) => String(s).replace(/["\\\]]/g, "\\$&");
      let el = null;
      if (k.kind === "node") {
        const svg = $("svg-dag");
        if (svg && typeof svg.querySelector === "function") {
          el = svg.querySelector(`g.dag-node[data-id="${cssEscape(k.id)}"]`);
        }
      } else {
        const body = $("slack-table-body");
        if (body && typeof body.querySelector === "function") {
          el = body.querySelector(`tr[data-task-id="${cssEscape(k.id)}"]`);
        }
      }
      if (el && typeof el.focus === "function") {
        try { el.focus({ preventScroll: false }); } catch (_err) { el.focus(); }
      }
    }

    function saveTaskEdits() {
      const id = state.selectedTaskId;
      if (!id) { setInspectorStatus("Select a task first."); return; }
      const idx = state.tasks.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const title = (($("inspector-title") || {}).value || "").trim() || id;
      const durationMin = Number(($("inspector-duration") || {}).value);
      const weight = Number(($("inspector-weight") || {}).value);
      const depsRaw = (($("inspector-deps") || {}).value || "").trim();
      const deps = depsRaw ? depsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
      const candidate = state.tasks.slice();
      candidate[idx] = Object.assign({}, candidate[idx], { title, durationMin, weight, deps });
      try {
        Engine.validateAndTopoSort(candidate);
        state.tasks = candidate;
        setInspectorStatus(`Saved edits to ${id}.`);
        showError("");
        persist();
        populateSlipDropdown();
        render();
      } catch (err) {
        showError(err.message);
        setInspectorStatus("Could not save: " + err.message);
      }
    }

    function deleteSelectedTask() {
      const id = state.selectedTaskId;
      if (!id) { setInspectorStatus("Select a task first."); return; }
      const dependents = state.tasks.filter((t) => t.deps.indexOf(id) !== -1);
      if (dependents.length > 0) {
        const msg = `Cannot delete ${id}: downstream tasks still depend on it (${dependents.map((t) => t.id).join(", ")}). Remove those dependencies first.`;
        showError(msg);
        setInspectorStatus(msg);
        return;
      }
      state.tasks = state.tasks.filter((t) => t.id !== id);
      state.doneTaskIds = state.doneTaskIds.filter((tid) => tid !== id);
      state.selectedTaskId = state.tasks.length ? state.tasks[0].id : "";
      state.slipTaskId = "";
      state.slipMin = 0;
      setInspectorStatus(`Deleted ${id}.`);
      showError("");
      persist();
      populateSlipDropdown();
      // An emptied graph is a real persisted state: reloading after deleting
      // every task must stay empty, not resurrect the preset.
      resetFocus(false);
      if (state.selectedTaskId) selectTask(state.selectedTaskId);
      else {
        setText("btn-toggle-done", "Mark Done");
        setText("inspector-cpm", "");
        render();
      }
    }

    function toggleDone() {
      const id = state.selectedTaskId;
      if (!id) { setInspectorStatus("Select a task first."); return; }
      const at = state.doneTaskIds.indexOf(id);
      if (at === -1) state.doneTaskIds.push(id);
      else state.doneTaskIds.splice(at, 1);
      setText("btn-toggle-done", at === -1 ? "Mark Not Done" : "Mark Done");
      setInspectorStatus(at === -1 ? `${id} marked done and removed from remaining CPM.` : `${id} restored to the plan.`);
      persist();
      render();
    }

    function bindTabs() {
      const tabs = Array.from(d.querySelectorAll(".tab"));
      const activate = (tab) => {
        tabs.forEach((t) => {
          const on = t === tab;
          t.setAttribute("aria-selected", on ? "true" : "false");
          if (t.tabIndex !== undefined) t.tabIndex = on ? 0 : -1;
        });
        const target = tab.getAttribute("aria-controls");
        d.querySelectorAll(".panel").forEach((p) => {
          p.classList.toggle("is-active", p.id === target);
        });
        if (target === "panel-dag" || target === "panel-risk") render();
      };
      tabs.forEach((tab, idx) => {
        tab.addEventListener("click", () => activate(tab));
        // Standard roving-tabindex tablist keys: Left/Right move and wrap,
        // Home and End jump to the first/last tab.
        tab.addEventListener("keydown", (ev) => {
          let next = null;
          if (ev.key === "ArrowRight") next = tabs[(idx + 1) % tabs.length];
          else if (ev.key === "ArrowLeft") next = tabs[(idx - 1 + tabs.length) % tabs.length];
          else if (ev.key === "Home") next = tabs[0];
          else if (ev.key === "End") next = tabs[tabs.length - 1];
          if (!next) return;
          ev.preventDefault();
          activate(next);
          if (typeof next.focus === "function") next.focus();
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
      onInput("focus-min-input", (v) => {
        const n = Number(v);
        state.focusBlockMin = Number.isFinite(n) && n > 0 ? Math.max(15, Math.min(90, n)) : 25;
        syncFocusToBlockLength();
      });
      // Nullish handling: break = 0 (back-to-back blocks) and budget = 60
      // are valid settings, not missing values.
      onInput("break-min-input", (v) => {
        const n = Number(v);
        state.breakMin = v === "" || !Number.isFinite(n) ? 5 : Math.max(0, Math.min(30, n));
      });
      onInput("cap-min-input", (v) => {
        const n = Number(v);
        state.dayCapacityMin = v === "" || !Number.isFinite(n) ? 300 : Math.max(60, Math.min(720, n));
      });
      onInput("start-date-input", (v) => { state.startDateIso = v || todayLocalIso(); });
      onInput("slip-task-select", (v) => { state.slipTaskId = v; });
      onInput("slip-min-input", (v) => {
        const n = Number(v);
        state.slipMin = v === "" || !Number.isFinite(n) ? 0 : Math.max(0, n);
      });
      onInput("workers-input", (v) => {
        const n = Number(v);
        state.workers = Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(8, Math.floor(n))) : 1;
      });
      onInput("risk-delay-input", (v) => {
        const n = Number(v);
        state.riskDelayMin = v === "" || !Number.isFinite(n) ? 0 : Math.max(0, Math.min(240, n));
      });

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
            setInspectorStatus(`Added ${id}.`);
            showError("");
            persist();
            populateSlipDropdown();
            selectTask(id);
          } catch (err) {
            showError(err.message);
          }
        });
      }

      const bindClick = (id, fn) => {
        const el = $(id);
        if (el) el.addEventListener("click", fn);
      };

      bindClick("btn-save-task", saveTaskEdits);
      bindClick("btn-delete-task", deleteSelectedTask);
      bindClick("btn-toggle-done", toggleDone);
      bindClick("btn-reset-preset", () => {
        applyPreset(state.presetId);
        setInspectorStatus(`Reset to ${state.presetId} preset. Saved edits cleared.`);
      });

      bindClick("btn-timer-start", () => {
        const blocks = focusBlocks();
        if (state.focus.exhausted || !blocks.length) {
          setText("focus-status", blocks.length
            ? "Every block is done. Reset the timer or load more work to continue."
            : "No blocks to run. Add a task or reset the preset first.");
          return;
        }
        if (state.focus.intervalId) return;
        // A fresh Start always loads the real duration of the block it points
        // at, so the countdown can never inherit a stale length.
        const current = blocks[state.focus.index] || blocks[0];
        const expected = current.durationMin * 60;
        if (state.focus.remainingSec <= 0 || state.focus.remainingSec > expected) {
          state.focus.remainingSec = expected;
        }
        state.focus.blockKey = `${current.taskId} p${current.part}`;
        state.focus.running = true;
        state.focus.intervalId = d.defaultView && d.defaultView.setInterval
          ? d.defaultView.setInterval(tickTimer, 1000)
          : (typeof setInterval === "function" ? setInterval(tickTimer, 1000) : null);
        updateFocusUI();
      });
      bindClick("btn-timer-pause", () => { pauseTimer(); });
      bindClick("btn-timer-reset", () => { resetFocus(true); });
      bindClick("btn-timer-complete", () => { completeBlock(true); });
      bindClick("btn-timer-skip", () => { skipBlock(); });
      bindClick("btn-mark-done", () => {
        const blocks = focusBlocks();
        const current = blocks[state.focus.index] || blocks[0];
        if (!current) { setText("focus-status", "No active block to mark done."); return; }
        if (state.doneTaskIds.indexOf(current.taskId) === -1) state.doneTaskIds.push(current.taskId);
        state.selectedTaskId = current.taskId;
        persist();
        setText("focus-status", `${current.taskId} marked done. The critical path and queue were recomputed below.`);
        render();
      });
      bindClick("clock-toggle", () => {
        state.clockMode = state.clockMode === "local" ? "utc" : "local";
        setText("clock-toggle", `Clock: ${state.clockMode === "local" ? "Local" : "UTC"}`);
        setText("block-window-head", state.clockMode === "local" ? "Local Window" : "UTC Window");
        render();
      });

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

      const telemetryBtn = $("btn-export-telemetry");
      if (telemetryBtn) {
        telemetryBtn.addEventListener("click", () => {
          const sched = computeCurrent();
          if (!sched) return;
          const slip = state.slipTaskId && state.slipMin > 0
            ? { taskId: state.slipTaskId, slipMin: state.slipMin } : null;
          // Diagnostics describe the active remaining plan (what the tables
          // show), not the full graph, so completed tasks never reappear in
          // the export.
          const payload = Engine.planTelemetry(activeTasks(), {
            policy: state.policy, workers: state.workers,
            delayMin: state.riskDelayMin, slip,
            focusBlockMin: state.focusBlockMin, breakMin: state.breakMin,
            dayCapacityMin: state.dayCapacityMin, startDateIso: state.startDateIso,
            utcOffsetMin: utcOffsetMin()
          });
          triggerDownload("cadencedag_diagnostics.json", JSON.stringify(payload, null, 2), "application/json");
        });
      }

      const icsValidateBtn = $("btn-validate-ics");
      if (icsValidateBtn) {
        icsValidateBtn.addEventListener("click", () => {
          const sched = computeCurrent();
          if (!sched) return;
          const report = Engine.validateIcs(Engine.exportScheduleToIcs(sched.schedule, "CadenceDAG Focus Plan"));
          setText("ics-validate-result", report.valid
            ? `Valid RFC 5545 structure: ${report.eventCount} VEVENT blocks, CRLF line endings, 0 errors.`
            : `Invalid: ${report.errors.join("; ")}`);
        });
      }

      const capy = $("capybara-easter");
      if (capy) {
        const pet = () => {
          state.capyClicks += 1;
          const notes = [
            "Capybara check: staying calm around 0m float.",
            "Capybara tip: prioritize high weight-to-duration nodes on critical edges.",
            "Capybara spotted! Hydration break (+5m) keeps critical paths steady."
          ];
          setText("capybara-status", notes[state.capyClicks % notes.length]);
        };
        capy.addEventListener("click", pet);
        capy.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") { ev.preventDefault(); pet(); }
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

    // Minutes to add to local wall-clock time to reach UTC on the start date,
    // so the 9:00 day start means 9:00 where the student actually is.
    function utcOffsetMin() {
      const parts = String(state.startDateIso).split("-").map(Number);
      const local = new Date(parts[0] || 2026, (parts[1] || 1) - 1, parts[2] || 1, state.dayStartHour, 0, 0);
      const off = local.getTimezoneOffset();
      return Number.isFinite(off) ? off : 0;
    }

    function computeCurrent() {
      try {
        const remaining = activeTasks();
        if (remaining.length === 0) {
          // The empty/finished state is rendered by renderEmptyState, not
          // raised as an error here.
          return null;
        }
        const baselineCpm = Engine.analyzeCriticalPath(remaining);
        const schedule = Engine.scheduleWorkflow(remaining, {
          policy: state.policy,
          focusBlockMin: state.focusBlockMin,
          breakMin: state.breakMin,
          dayCapacityMin: state.dayCapacityMin,
          dayStartHour: state.dayStartHour,
          startDateIso: state.startDateIso,
          utcOffsetMin: utcOffsetMin(),
          slip: state.slipTaskId && state.slipMin > 0 ? { taskId: state.slipTaskId, slipMin: state.slipMin } : null
        });
        showError("");
        return { baselineCpm, schedule };
      } catch (err) {
        showError(err.message);
        return null;
      }
    }

    function focusBlocks() {
      const res = computeCurrent();
      return res ? res.schedule.blocks : [];
    }

    function formatClock(iso) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "--:--";
      if (state.clockMode === "utc") return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
      return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }

    function localDateLabel(iso) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "";
      if (state.clockMode === "utc") return date.toISOString().slice(0, 10);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }

    function mmss(sec) {
      const s = Math.max(0, Math.round(sec));
      return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    }

    function clearTimerInterval() {
      if (state.focus.intervalId !== null) {
        if (d.defaultView && d.defaultView.clearInterval) d.defaultView.clearInterval(state.focus.intervalId);
        else if (typeof clearInterval === "function") clearInterval(state.focus.intervalId);
        state.focus.intervalId = null;
      }
    }

    function pauseTimer() {
      state.focus.running = false;
      clearTimerInterval();
      updateFocusUI();
    }

    function resetFocus(announce) {
      clearTimerInterval();
      state.focus.index = 0;
      state.focus.completed = 0;
      state.focus.exhausted = false;
      const blocks = focusBlocks();
      state.focus.remainingSec = blocks.length ? blocks[0].durationMin * 60 : state.focusBlockMin * 60;
      state.focus.blockKey = blocks.length ? `${blocks[0].taskId} p${blocks[0].part}` : null;
      state.focus.running = false;
      if (announce) setText("focus-status", "Timer reset. Ready for a fresh focus block.");
      updateFocusUI();
    }

    // The countdown must always match the scheduled block it points at. After
    // any queue recompute (task done, edited, deleted, preset changed) the
    // saved block identity rebases onto the matching remaining block, or
    // cleanly to the first block when that block no longer exists.
    function syncFocusToQueue(blocks) {
      const f = state.focus;
      if (f.blockKey) {
        const at = blocks.findIndex((b) => `${b.taskId} p${b.part}` === f.blockKey);
        if (at !== -1) {
          if (f.index !== at) f.index = at;
          f.remainingSec = Math.min(f.remainingSec > 0 ? f.remainingSec : blocks[at].durationMin * 60, blocks[at].durationMin * 60);
          return;
        }
      }
      // The saved block is gone: land on the first remaining block.
      f.index = 0;
      f.remainingSec = blocks.length ? blocks[0].durationMin * 60 : 0;
      f.blockKey = blocks.length ? `${blocks[0].taskId} p${blocks[0].part}` : null;
    }

    // Focus length changes rebase the current block's countdown so the ring
    // and seconds never disagree with the new block length.
    function syncFocusToBlockLength() {
      const blocks = focusBlocks();
      if (!blocks.length) return;
      const current = blocks[state.focus.index] || blocks[0];
      state.focus.remainingSec = current.durationMin * 60;
      state.focus.blockKey = `${current.taskId} p${current.part}`;
    }

    function chime() {
      try {
        const view = d.defaultView || (typeof window !== "undefined" ? window : null);
        const Ctx = view && (view.AudioContext || view.webkitAudioContext) || null;
        if (!Ctx) return;
        const ctx = new Ctx();
        if (!ctx.createOscillator || !ctx.createGain) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = 660;
        gain.gain.value = 0.035;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
        osc.onended = () => { try { ctx.close(); } catch (_e) { /* noop */ } };
      } catch (_err) {
        // WebAudio is optional; no external audio URLs are ever requested.
      }
    }

    function celebrate(capyMessage) {
      state.capyCelebration = true;
      const badge = $("capybara-badge");
      if (badge && badge.classList) badge.classList.add("is-glowing");
      setText("capybara-status", capyMessage);
    }

    function tickTimer() {
      if (!state.focus.running) return;
      state.focus.remainingSec -= 1;
      if (state.focus.remainingSec <= 0) {
        state.focus.remainingSec = 0;
        completeBlock(true);
        return;
      }
      updateFocusUI();
    }

    function completeBlock(playChime) {
      const blocks = focusBlocks();
      if (!blocks.length) {
        pauseTimer();
        state.focus.exhausted = true;
        setText("focus-status", "No blocks to complete. The queue is empty.");
        updateFocusUI();
        return;
      }
      const idx = Math.min(state.focus.index, blocks.length - 1);
      state.focus.completed = Math.min(state.focus.completed + 1, blocks.length);
      if (playChime) chime();
      celebrate("Capybara celebrates: one more focus block done. Tangerine power up!");
      pauseTimer();
      if (idx < blocks.length - 1) {
        state.focus.index = idx + 1;
        const next = blocks[state.focus.index];
        state.focus.remainingSec = next.durationMin * 60;
        state.focus.blockKey = `${next.taskId} p${next.part}`;
        setText("focus-status", "Block complete. Great work. The next queued block is loaded.");
      } else {
        // Queue exhausted: stop cleanly, show the finished state, and let the
        // Start guard prevent re-running the finished block.
        state.focus.index = idx;
        state.focus.remainingSec = 0;
        state.focus.blockKey = `${blocks[idx].taskId} p${blocks[idx].part}`;
        state.focus.exhausted = true;
        setText("focus-status", "All blocks are complete. The plan is finished. Reset the timer or load more work to continue.");
      }
      updateFocusUI();
    }

    function skipBlock() {
      const blocks = focusBlocks();
      if (!blocks.length) {
        pauseTimer();
        updateFocusUI();
        return;
      }
      if (state.focus.index < blocks.length - 1) {
        state.focus.index += 1;
        const next = blocks[state.focus.index];
        state.focus.remainingSec = next.durationMin * 60;
        state.focus.blockKey = `${next.taskId} p${next.part}`;
        setText("focus-status", "Skipped to the next queued focus block.");
      } else {
        state.focus.exhausted = true;
        state.focus.remainingSec = 0;
        setText("focus-status", "This is the last block in the queue. Nothing to skip to.");
      }
      pauseTimer();
      updateFocusUI();
    }

    function updateFocusUI() {
      const blocks = focusBlocks();
      const current = blocks[state.focus.index] || blocks[0];
      setText("focus-countdown", mmss(state.focus.remainingSec));
      const ring = $("focus-ring-arc");
      if (ring && ring.setAttribute) {
        // The ring fills against the current block's own duration, not a
        // global focus length, so a 15m second part shows a true arc.
        const total = Math.max(1, current ? current.durationMin * 60 : state.focusBlockMin * 60);
        const used = 1 - Math.max(0, Math.min(1, state.focus.remainingSec / total));
        ring.setAttribute("stroke-dashoffset", (326.73 * used).toFixed(2));
      }
      setText("focus-task-label", current ? `${current.taskId} p${current.part}: ${current.title}` : "No block loaded");
      setText("focus-progress-text", blocks.length
        ? `${state.focus.completed} / ${blocks.length} blocks completed`
        : (state.tasks.length ? "0 / 0 blocks completed" : "No scheduled blocks: the plan is empty or fully done"));
      const fill = $("focus-progress-fill");
      if (fill) fill.style = fill.style || {};
      if (fill && fill.style) fill.style.width = `${blocks.length ? Math.min(100, Math.round((state.focus.completed / blocks.length) * 100)) : 0}%`;
      const startBtn = $("btn-timer-start");
      if (startBtn && startBtn.disabled !== undefined) {
        startBtn.disabled = !blocks.length || state.focus.exhausted;
      }
      const now = new Date();
      setText("clock-readout", state.clockMode === "utc"
        ? now.toISOString().slice(11, 19) + " UTC"
        : `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")} Local`);
    }

    function renderComparisonStrip() {
      const host = $("policy-compare-strip");
      if (!host) return;
      let comparison;
      try {
        // The comparison runs on the remaining graph with the injected slip,
        // so the active cell and the headline weighted completion always
        // describe the same delayed plan.
        comparison = Engine.comparePolicies(activeTasks(), {
          horizonMin: 120,
          startDateIso: state.startDateIso,
          slip: state.slipTaskId && state.slipMin > 0 ? { taskId: state.slipTaskId, slipMin: state.slipMin } : null
        });
      } catch (_err) {
        host.textContent = "Comparison unavailable for this graph.";
        return;
      }
      host.innerHTML = "";
      for (const p of comparison.policies) {
        const cell = d.createElement("div");
        const active = p.id === state.policy;
        cell.className = `policy-cell${active ? " is-active" : ""}`;
        cell.innerHTML =
          `<div class="policy-name">${escapeHtml(p.label)}${active ? " (active)" : ""}</div>` +
          `<div class="policy-metric">${p.weightedCompletion.toLocaleString()}<span>weighted completion</span></div>` +
          `<div class="policy-metric-small">First 3 <b>${p.firstThreeTaskIds.map(escapeHtml).join(" &gt; ") || "none"}</b></div>` +
          `<div class="policy-metric-small">High-priority min in first 120 work min (excl. breaks) <b>${p.highPriorityMinutesFirstHorizon}</b></div>`;
        host.appendChild(cell);
      }
    }

    function renderNextAction(res) {
      const text = $("next-action-text");
      if (!text) return;
      const first = res.schedule.cpm.nodeMap.get(res.schedule.executionOrder[0]);
      if (!first) { text.textContent = "All tasks are complete. Reset a preset to plan another sprint."; return; }
      const policy = res.schedule.policy || state.policy;
      let reason;
      if (first.isCritical) {
        reason = `it is a critical bottleneck with 0m float (w/p ${first.wsptRatio.toFixed(2)})`;
      } else if (policy === "shortest") {
        reason = `it is the shortest ready task (${first.effectiveDurationMin}m, ${first.totalFloatMin}m float)`;
      } else if (policy === "critical") {
        reason = `it has the least float among ready tasks (${first.totalFloatMin}m float)`;
      } else {
        reason = `it has the highest WSPT score among ready tasks (w/p ${first.wsptRatio.toFixed(2)}, ${first.totalFloatMin}m float)`;
      }
      text.textContent = `${first.id}: ${first.title} is next because ${reason}.`;
    }

    function renderRiskPanel(remaining) {
      const slip = state.slipTaskId && state.slipMin > 0
        ? { taskId: state.slipTaskId, slipMin: state.slipMin } : null;
      // Critical chains follow the active (possibly slipped) plan, matching
      // the CPM the other panels show.
      const paths = Engine.enumerateCriticalPaths(remaining, slip);
      const risk = Engine.analyzeScheduleRisk(remaining, { delayMin: state.riskDelayMin });
      const multi = Engine.scheduleWithWorkers(remaining, {
        policy: state.policy, workers: state.workers, slip
      });
      const cpm = multi.cpm;

      setText("kpi-paths", String(paths.pathCount));
      setText("kpi-paths-sub", `${paths.makespanMin}m longest chain across ${cpm.nodes.length} nodes`);
      setText("kpi-parallel", `${multi.makespanMin}m`);
      const workerWord = multi.workers === 1 ? "worker" : "workers";
      setText("kpi-parallel-sub", `${multi.workers} ${workerWord}, ${cpm.projectMakespanMin}m baseline`);
      setText("kpi-util", `${(multi.utilization * 100).toFixed(1)}%`);
      setText("kpi-util-sub", `${multi.idleMin}m idle across ${multi.workers} ${workerWord}`);
      setText("kpi-slack", `${(risk.slackCoverage * 100).toFixed(1)}%`);
      setText("kpi-slack-sub", `${risk.absorbedCount} of ${risk.sampleCount} delays fully absorbed`);
      setText("kpi-worst", `${risk.worstCaseMakespanMin}m`);
      setText("kpi-worst-sub", `+${risk.maxDeltaMin}m over ${risk.baselineMakespanMin}m baseline`);
      setText("kpi-mean-delay", `${Number(risk.meanDeltaMin).toFixed(1)}m`);
      setText("kpi-mean-delay-sub", `deterministic ${risk.delayMin}m per-task sweep`);

      if (Svg) Svg.renderWorkerSwimlanes($("svg-workers"), multi);

      const pathsBody = $("critical-paths-body");
      if (pathsBody) {
        pathsBody.innerHTML = "";
        paths.criticalPaths.forEach((chain, idx) => {
          const tr = d.createElement("tr");
          tr.innerHTML = `<td>#${idx + 1}</td><td class="mono">${chain.map(escapeHtml).join(" &gt; ")}</td><td class="num">${paths.makespanMin}m</td>`;
          pathsBody.appendChild(tr);
        });
      }

      const ledgerBody = $("worker-ledger-body");
      if (ledgerBody) {
        ledgerBody.innerHTML = "";
        multi.ledger.forEach((w) => {
          const tr = d.createElement("tr");
          const ids = w.tasks.map((t) => t.id).join(", ") || "(idle)";
          const first = w.tasks.length ? w.tasks[0].startMin : 0;
          const last = w.tasks.length ? w.tasks[w.tasks.length - 1].endMin : 0;
          tr.innerHTML = `<td class="id-chip">W${w.worker}</td><td class="mono">${escapeHtml(ids)}</td><td class="num">${w.busyMin}m</td><td>[${first}, ${last}]m</td>`;
          ledgerBody.appendChild(tr);
        });
      }

      const riskBody = $("risk-samples-body");
      if (riskBody) {
        riskBody.innerHTML = "";
        risk.samples.forEach((s) => {
          const tr = d.createElement("tr");
          const absorbedBarWidth = Math.min(100, Math.round((s.absorbed / Math.max(1, s.delayMin)) * 100));
          const pushBarWidth = Math.min(100, Math.round((s.deltaMin / Math.max(1, s.delayMin)) * 100));
          tr.innerHTML = `<td class="id-chip">${escapeHtml(s.taskId)}</td><td class="num">${s.floatMin}m</td><td class="num">${s.absorbed}m</td>` +
            `<td class="num">${s.makespanMin}m</td><td><span class="${s.deltaMin > 0 ? "pill-crit" : "pill-float"}">+${s.deltaMin}m</span></td>` +
            `<td class="absorption-cell"><span class="absorb-track"><span class="absorb-bar" style="width:${absorbedBarWidth}%" title="Absorbed ${s.absorbed}m of ${s.delayMin}m slack"></span>` +
            `<span class="push-bar" style="width:${pushBarWidth}%" title="Deadline pushed ${s.deltaMin}m"></span></span></td>`;
          riskBody.appendChild(tr);
        });
      }

      const delayedCritical = risk.samples.filter((s) => s.criticalAfter && s.deltaMin > 0).length;
      if (delayedCritical === 0 && !state.capyCelebration) {
        celebrate("Capybara says: 0 delayed critical tasks. Tangerine badge unlocked!");
      }
    }

    // One explicit empty-state pass across every surface: KPIs, banner,
    // canvases, tables, inspector and timer. No stale numbers survive.
    function renderEmptyState(reason) {
      setText("kpi-makespan", "0 min");
      setText("kpi-makespan-sub", reason);
      setText("kpi-crit-count", "0 / 0");
      setText("kpi-crit-sub", "none");
      setText("kpi-blocks", "0 blocks");
      setText("kpi-blocks-sub", reason);
      setText("kpi-wspt", "0");
      setText("kpi-wspt-sub", reason);
      setText("next-action-text", reason === "All tasks are marked done."
        ? "All tasks are complete. Load a preset or add a task to plan another sprint."
        : "No tasks in the plan. Load a preset below or add a task to start scheduling.");
      const strip = $("policy-compare-strip");
      if (strip) strip.innerHTML = `<div class="policy-cell"><div class="policy-name">No plan</div><div class="policy-metric-small">${escapeHtml(reason)} Load a preset to compare policies.</div></div>`;
      const dagSvg = $("svg-dag");
      if (dagSvg) while (dagSvg.firstChild) dagSvg.removeChild(dagSvg.firstChild);
      if (dagSvg) dagSvg.setAttribute("viewBox", "0 0 800 300");
      const ganttSvg = $("svg-gantt");
      if (ganttSvg) while (ganttSvg.firstChild) ganttSvg.removeChild(ganttSvg.firstChild);
      const workersSvg = $("svg-workers");
      if (workersSvg) while (workersSvg.firstChild) workersSvg.removeChild(workersSvg.firstChild);
      const slackBody = $("slack-table-body");
      if (slackBody) slackBody.innerHTML = `<tr class="empty-row"><td colspan="8">${escapeHtml(reason)} Load a preset or add a task.</td></tr>`;
      const blkBody = $("blocks-table-body");
      if (blkBody) blkBody.innerHTML = `<tr class="empty-row"><td colspan="6">${escapeHtml(reason)}</td></tr>`;
      const pathsBody = $("critical-paths-body");
      if (pathsBody) pathsBody.innerHTML = `<tr class="empty-row"><td colspan="3">${escapeHtml(reason)}</td></tr>`;
      const ledgerBody = $("worker-ledger-body");
      if (ledgerBody) ledgerBody.innerHTML = `<tr class="empty-row"><td colspan="4">${escapeHtml(reason)}</td></tr>`;
      const riskBody = $("risk-samples-body");
      if (riskBody) riskBody.innerHTML = `<tr class="empty-row"><td colspan="6">${escapeHtml(reason)}</td></tr>`;
      ["kpi-paths", "kpi-parallel", "kpi-util", "kpi-slack", "kpi-worst", "kpi-mean-delay"].forEach((id) => setText(id, "-"));
      ["kpi-paths-sub", "kpi-parallel-sub", "kpi-util-sub", "kpi-slack-sub", "kpi-worst-sub", "kpi-mean-delay-sub"].forEach((id) => setText(id, reason));
      setText("slip-summary", reason);
      const sel = state.selectedTaskId;
      if (!sel) {
        setValue("inspector-title", "");
        setValue("inspector-duration", "");
        setValue("inspector-weight", "");
        setValue("inspector-deps", "");
        setText("btn-toggle-done", "Mark Done");
        setText("inspector-cpm", "");
        setInspectorStatus(reason === "All tasks are marked done."
          ? "Every task is done. Load a preset or add a task to keep planning."
          : "The plan is empty. Load a preset or add a task to inspect it.");
      }
      resetFocus(false);
      if (state.tasks.length === 0) {
        setText("focus-status", "The plan is empty. Load a preset or add a task to schedule focus blocks.");
      }
      updateFocusUI();
    }

    function render() {
      const remaining = activeTasks();
      if (remaining.length === 0) {
        const reason = state.tasks.length === 0
          ? "The plan is empty."
          : "All tasks are marked done.";
        renderEmptyState(reason);
        return;
      }
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
      setText("kpi-crit-sub", cpm.criticalTaskIds.join(" > "));
      setText("kpi-blocks", `${schedule.totalFocusBlocks} blocks`);
      setText(
        "kpi-blocks-sub",
        `${schedule.totalDays} day${schedule.totalDays === 1 ? "" : "s"} of ${state.focusBlockMin}m focus` +
        (state.breakMin > 0 ? ` + ${state.breakMin}m break` : ", no breaks")
      );
      setText("kpi-wspt", `${Math.round(schedule.totalWeightedCompletion).toLocaleString()}`);
      setText("kpi-wspt-sub", `Sum of weight x finish time, ${state.policy === "critical" ? "Critical-First" : state.policy === "shortest" ? "SPT" : "WSPT"} order`);

      if (Svg) {
        Svg.renderDagGraph($("svg-dag"), cpm, state.selectedTaskId);
        Svg.renderGanttChart($("svg-gantt"), cpm);
      }

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

      const slackBody = $("slack-table-body");
      if (slackBody) {
        slackBody.innerHTML = "";
        cpm.nodes.forEach((n) => {
          const tr = d.createElement("tr");
          tr.setAttribute("data-task-id", n.id);
          tr.setAttribute("tabindex", "0");
          tr.setAttribute("role", "button");
          tr.className = "selectable-row" + (n.id === state.selectedTaskId ? " is-selected" : "");
          const done = state.doneTaskIds.indexOf(n.id) !== -1;
          tr.innerHTML = `
            <td class="id-chip">${escapeHtml(n.id)}</td>
            <td class="task-title">${escapeHtml(n.title)}${done ? " (done)" : ""}</td>
            <td class="num">${n.effectiveDurationMin}m</td>
            <td>[${n.esMin}, ${n.efMin}]</td>
            <td class="num">${n.totalFloatMin}m</td>
            <td class="num">${n.freeFloatMin}m</td>
            <td class="num">${n.wsptRatio.toFixed(2)}</td>
            <td><span class="${n.isCritical ? "pill-crit" : "pill-float"}">${n.isCritical ? "Critical" : "Float"}</span></td>
          `;
          slackBody.appendChild(tr);
        });
      }

      const blkBody = $("blocks-table-body");
      if (blkBody) {
        blkBody.innerHTML = "";
        schedule.blocks.forEach((b, idx) => {
          const tr = d.createElement("tr");
          tr.innerHTML = `
            <td class="cell-muted">#${idx + 1}</td>
            <td class="nowrap">Day ${b.dayIndex}<span class="cell-muted">${localDateLabel(b.startIso)}</span></td>
            <td class="nowrap">${formatClock(b.startIso)} to ${formatClock(b.endIso)}</td>
            <td class="nowrap"><span class="id-chip">${escapeHtml(b.taskId)}</span> p${b.part} <span class="cell-muted">${b.durationMin}m</span></td>
            <td class="task-title">${escapeHtml(b.title)}</td>
            <td><span class="${b.isCritical ? "pill-crit" : "pill-float"}">${b.isCritical ? "Critical" : "Buffer"}</span></td>
          `;
          blkBody.appendChild(tr);
        });
      }

      renderComparisonStrip();
      renderNextAction(res);
      renderRiskPanel(remaining);
      // The timer follows the recomputed queue: rebase onto the saved block
      // identity, or cleanly onto the first remaining block when that block
      // completed or was removed.
      syncFocusToQueue(schedule.blocks);
      updateFocusUI();
      restoreKeyboardFocus();
    }

    function init() {
      const sel = $("preset-select");
      loadPersisted();
      if (sel && sel.options.length === 0) {
        Engine.PRESET_WORKFLOWS.forEach((w) => {
          const opt = d.createElement("option");
          opt.value = w.id;
          // Drop the "(9 Tasks)" suffix so the name fits the sidebar select.
          opt.textContent = w.name.replace(/\s*\(\d+ Tasks\)$/, "");
          sel.appendChild(opt);
        });
      }
      if (sel) sel.value = state.presetId;
      const dateInput = $("start-date-input");
      if (dateInput) dateInput.value = state.startDateIso;
      populateSlipDropdown();
      bindTabs();
      bindInputs();
      bindSelection();
      // A stale persisted selection (task deleted before reload) already
      // fell back during loadPersisted; sync the inspector to whatever exists.
      if (!state.selectedTaskId || !state.tasks.some((t) => t.id === state.selectedTaskId)) {
        state.selectedTaskId = state.tasks.length ? state.tasks[0].id : "";
      }
      resetFocus(false);
      if (state.selectedTaskId) selectTask(state.selectedTaskId);
      else render();
    }

    return { init, render, applyPreset, state,
      selectTask, saveTaskEdits, deleteSelectedTask, toggleDone,
      completeBlock, skipBlock, resetFocus, comparePolicies: () => Engine.comparePolicies(activeTasks()) };
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => {
      const ctrl = createController(document);
      if (ctrl) ctrl.init();
    });
  }

  return { createController, escapeHtml };
});
