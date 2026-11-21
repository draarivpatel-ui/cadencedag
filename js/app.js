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
      // deadlineMs is the absolute wall-clock finish of the running block;
      // the countdown derives from it instead of counting interval callbacks,
      // so throttled background tabs never drift.
      focus: { index: 0, completed: 0, remainingSec: 25 * 60, running: false, intervalId: null, blockKey: null, exhausted: false, deadlineMs: null },
      // Bottleneck lab preview: the duration delta (minutes) currently shown
      // for the selected task. 0 means the preview matches the real plan.
      whatifDeltaMin: 0,
      keyboardSelection: null,
      clockMode: "local",
      capyCelebration: false,
      advisorLens: "all",
      shockPulse: false,
      // Prerequisite and dependent highlights appear once someone clicks a
      // node, so the first view of the graph leads with the critical path.
      showRelations: false
    };

    const $ = (id) => d.getElementById(id);
    const history = Engine.createHistory({ limit: 100 });
    // The slip the undo stack last saw, so a burst of typed delay minutes
    // lands as one undo step.
    let slipBaseline = { slipTaskId: "", slipMin: 0 };
    // The planning settings the undo stack last saw, so settled setting edits
    // also land as one undo step.
    let settingsBaseline = {
      policy: state.policy, focusBlockMin: state.focusBlockMin, breakMin: state.breakMin,
      dayCapacityMin: state.dayCapacityMin, workers: state.workers,
      riskDelayMin: state.riskDelayMin, startDateIso: state.startDateIso
    };

    // Timers go through the window when one exists; test stubs have neither.
    function later(fn, ms) {
      const view = d.defaultView;
      if (view && typeof view.setTimeout === "function") return view.setTimeout(fn, ms);
      return typeof setTimeout === "function" ? setTimeout(fn, ms) : null;
    }
    function cancelLater(id) {
      if (id === null || id === undefined) return;
      const view = d.defaultView;
      if (view && typeof view.clearTimeout === "function") view.clearTimeout(id);
      else if (typeof clearTimeout === "function") clearTimeout(id);
    }

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
      if (typeof localStorage === "undefined") {
        stickyStorageNotice = { level: "warning", message: "Local saving unavailable in this browser" };
        setStorageStatus("warning", stickyStorageNotice.message);
        return;
      }
      let raw = null;
      try {
        raw = localStorage.getItem(STORAGE_KEY);
      } catch (_err) {
        stickyStorageNotice = { level: "warning", message: "Local saving unavailable (storage blocked)" };
        setStorageStatus("warning", stickyStorageNotice.message);
        return;
      }
      // An initialized-but-empty store means the user deleted every task:
      // restore that empty state instead of resurrecting the preset tasks.
      if (raw === null || raw === undefined) return;
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch (_err) {
        // Corrupt JSON: the in-memory preset stays intact, but the user must
        // know their previous edits will not come back.
        stickyStorageNotice = { level: "warning", message: "Saved plan was corrupt; showing the sample plan" };
        setStorageStatus("warning", stickyStorageNotice.message);
        return;
      }
      if (!data || !Array.isArray(data.tasks)) {
        stickyStorageNotice = { level: "warning", message: "Saved plan was corrupt; showing the sample plan" };
        setStorageStatus("warning", stickyStorageNotice.message);
        return;
      }
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
      // Planning settings persist alongside the plan, validated against the
      // same clamps the inputs enforce, so a corrupt value falls back cleanly.
      const s = data.settings && typeof data.settings === "object" ? data.settings : {};
      const clamp = (v, lo, hi, fb) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
      };
      if (s.policy === "wspt" || s.policy === "critical" || s.policy === "shortest") state.policy = s.policy;
      state.focusBlockMin = clamp(s.focusBlockMin, 15, 90, state.focusBlockMin);
      state.breakMin = clamp(s.breakMin, 0, 30, state.breakMin);
      state.dayCapacityMin = clamp(s.dayCapacityMin, 60, 720, state.dayCapacityMin);
      state.workers = clamp(s.workers, 1, 8, state.workers);
      state.riskDelayMin = clamp(s.riskDelayMin, 0, 240, state.riskDelayMin);
      if (typeof data.startDateIso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.startDateIso)) {
        state.startDateIso = data.startDateIso;
      }
    }

    // A load-time problem (corrupt restore, blocked store) stays on the badge
    // until the first real edit, so boot-time saves never silence it.
    let stickyStorageNotice = null;

    function setStorageStatus(level, message) {
      const el = $("storage-status");
      if (!el) return;
      el.textContent = message;
      el.setAttribute("data-state", level);
    }

    function persist() {
      try {
        if (typeof localStorage === "undefined") {
          setStorageStatus("warning", "Local saving unavailable in this browser");
          return;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          presetId: state.presetId,
          tasks: state.tasks.map((t) => Object.assign({}, t, { deps: t.deps.slice() })),
          doneTaskIds: state.doneTaskIds.slice(),
          selectedTaskId: state.selectedTaskId,
          settings: planSettings(),
          startDateIso: state.startDateIso
        }));
        if (stickyStorageNotice) setStorageStatus(stickyStorageNotice.level, stickyStorageNotice.message);
        else setStorageStatus("ok", "Saved locally");
        // A write that succeeded means the store works again: drop any
        // blocked-store notice from boot once the user edits something.
        if (stickyStorageNotice && stickyStorageNotice.level !== "warning") stickyStorageNotice = null;
      } catch (err) {
        // Private browsing or a full storage quota must not break the app,
        // but the user must see that their edits will disappear on reload.
        setStorageStatus("warning", "Not saved locally" + (err && err.name === "QuotaExceededError" ? " (storage full)" : " (storage blocked)"));
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

    /* ----------------------- undo and redo ----------------------- */

    function snapshot() {
      return {
        presetId: state.presetId,
        tasks: state.tasks.map((t) => Object.assign({}, t, { deps: t.deps.slice() })),
        doneTaskIds: state.doneTaskIds.slice(),
        selectedTaskId: state.selectedTaskId,
        slipTaskId: state.slipTaskId,
        slipMin: state.slipMin,
        policy: state.policy,
        focusBlockMin: state.focusBlockMin,
        breakMin: state.breakMin,
        dayCapacityMin: state.dayCapacityMin,
        workers: state.workers,
        riskDelayMin: state.riskDelayMin,
        startDateIso: state.startDateIso
      };
    }

    function syncHistoryButtons() {
      const undoBtn = $("btn-undo");
      const redoBtn = $("btn-redo");
      if (undoBtn) {
        undoBtn.disabled = !history.canUndo();
        undoBtn.setAttribute("title", history.canUndo() ? `Undo: ${history.undoLabel()}` : "Nothing to undo");
      }
      if (redoBtn) {
        redoBtn.disabled = !history.canRedo();
        redoBtn.setAttribute("title", history.canRedo() ? `Redo: ${history.redoLabel()}` : "Nothing to redo");
      }
    }

    // Runs one plan change and records it as a single undo step. A change
    // that leaves the plan identical records nothing.
    function mutate(label, fn) {
      const before = snapshot();
      const out = fn();
      history.commit(before, snapshot(), label);
      slipBaseline = { slipTaskId: state.slipTaskId, slipMin: state.slipMin };
      settingsBaseline = settingsSnapshot();
      syncHistoryButtons();
      return out;
    }

    function settingsSnapshot() {
      return {
        policy: state.policy, focusBlockMin: state.focusBlockMin, breakMin: state.breakMin,
        dayCapacityMin: state.dayCapacityMin, workers: state.workers,
        riskDelayMin: state.riskDelayMin, startDateIso: state.startDateIso
      };
    }

    function commitSettingsEdit() {
      const after = snapshot();
      const before = Object.assign({}, after, settingsBaseline);
      const changed = [];
      if (settingsBaseline.policy !== state.policy) changed.push(`policy ${state.policy}`);
      if (settingsBaseline.focusBlockMin !== state.focusBlockMin) changed.push(`focus ${state.focusBlockMin}m`);
      if (settingsBaseline.breakMin !== state.breakMin) changed.push(`break ${state.breakMin}m`);
      if (settingsBaseline.dayCapacityMin !== state.dayCapacityMin) changed.push(`budget ${state.dayCapacityMin}m`);
      if (settingsBaseline.workers !== state.workers) changed.push(`${state.workers} workers`);
      if (settingsBaseline.riskDelayMin !== state.riskDelayMin) changed.push(`risk ${state.riskDelayMin}m`);
      if (settingsBaseline.startDateIso !== state.startDateIso) changed.push(`start ${state.startDateIso}`);
      if (!changed.length) return;
      history.commit(before, after, `Set ${changed.join(", ")}`);
      settingsBaseline = settingsSnapshot();
      syncHistoryButtons();
    }

    function commitSlipEdit() {
      const after = snapshot();
      const before = Object.assign({}, after, slipBaseline);
      const label = state.slipTaskId && state.slipMin > 0
        ? `Delay ${state.slipTaskId} by ${state.slipMin}m` : "Clear delay";
      history.commit(before, after, label);
      slipBaseline = { slipTaskId: state.slipTaskId, slipMin: state.slipMin };
      syncHistoryButtons();
      persist();
    }

    function restoreSnapshot(snap) {
      const settingsChanged =
        (snap.policy !== undefined && snap.policy !== state.policy) ||
        (snap.focusBlockMin !== undefined && snap.focusBlockMin !== state.focusBlockMin) ||
        (snap.breakMin !== undefined && snap.breakMin !== state.breakMin) ||
        (snap.dayCapacityMin !== undefined && snap.dayCapacityMin !== state.dayCapacityMin) ||
        (snap.startDateIso !== undefined && snap.startDateIso !== state.startDateIso);
      state.presetId = snap.presetId;
      state.tasks = snap.tasks;
      state.doneTaskIds = snap.doneTaskIds;
      state.selectedTaskId = snap.selectedTaskId;
      state.slipTaskId = snap.slipTaskId;
      state.slipMin = snap.slipMin;
      if (snap.policy !== undefined) state.policy = snap.policy;
      if (snap.focusBlockMin !== undefined) state.focusBlockMin = snap.focusBlockMin;
      if (snap.breakMin !== undefined) state.breakMin = snap.breakMin;
      if (snap.dayCapacityMin !== undefined) state.dayCapacityMin = snap.dayCapacityMin;
      if (snap.workers !== undefined) state.workers = snap.workers;
      if (snap.riskDelayMin !== undefined) state.riskDelayMin = snap.riskDelayMin;
      if (snap.startDateIso !== undefined) state.startDateIso = snap.startDateIso;
      slipBaseline = { slipTaskId: snap.slipTaskId, slipMin: snap.slipMin };
      settingsBaseline = settingsSnapshot();
      showError("");
      setInspectorStatus("");
      persist();
      syncPresetSelect();
      setValue("policy-select", state.policy);
      setValue("focus-min-input", String(state.focusBlockMin));
      setValue("break-min-input", String(state.breakMin));
      setValue("cap-min-input", String(state.dayCapacityMin));
      setValue("workers-input", String(state.workers));
      setValue("risk-delay-input", String(state.riskDelayMin));
      setValue("start-date-input", state.startDateIso);
      populateSlipDropdown();
      setValue("slip-min-input", String(state.slipMin));
      if (settingsChanged) resetFocus(false);
      fillInspector(state.selectedTaskId);
      render();
      syncHistoryButtons();
    }

    // A shared plan is not one of the samples, so it gets its own entry.
    function syncPresetSelect() {
      const sel = $("preset-select");
      if (!sel) return;
      const known = Engine.PRESET_WORKFLOWS.some((w) => w.id === state.presetId);
      if (!known && !Array.from(sel.options || []).some((o) => o.value === "shared")) {
        const opt = d.createElement("option");
        opt.value = "shared";
        opt.textContent = "Shared plan";
        sel.appendChild(opt);
      }
      sel.value = known ? state.presetId : "shared";
    }

    function undo() {
      const entry = history.undo(snapshot());
      if (!entry) return false;
      restoreSnapshot(entry.snapshot);
      showToast(`Undid: ${entry.label}`);
      return true;
    }

    function redo() {
      const entry = history.redo(snapshot());
      if (!entry) return false;
      restoreSnapshot(entry.snapshot);
      showToast(`Redid: ${entry.label}`);
      return true;
    }

    let toastTimer = null;
    function showToast(message, offerUndo) {
      const box = $("toast");
      if (!box) return;
      setText("toast-text", message);
      const undoBtn = $("toast-undo");
      if (undoBtn) undoBtn.hidden = !offerUndo;
      box.classList.remove("is-visible");
      box.classList.add("is-visible");
      cancelLater(toastTimer);
      toastTimer = later(() => box.classList.remove("is-visible"), offerUndo ? 7000 : 3200);
    }

    /* ------------------------- capybara -------------------------- */

    let capyTimer = null;
    function setCapyMood(mood, message) {
      const capy = $("capybara-easter");
      if (capy) capy.setAttribute("data-mood", mood);
      if (message) setText("capybara-status", message);
      cancelLater(capyTimer);
      capyTimer = later(() => {
        const el = $("capybara-easter");
        if (el) el.setAttribute("data-mood", "calm");
      }, mood === "party" ? 4200 : 2800);
    }

    function applyPreset(presetId) {
      const found = Engine.PRESET_WORKFLOWS.find((w) => w.id === presetId);
      if (!found) return;
      mutate(`Load ${found.name.replace(/\s*\(\d+ Tasks\)$/, "")}`, () => loadPreset(found));
    }

    function loadPreset(found) {
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
      state.focus = { index: 0, completed: 0, remainingSec: state.focusBlockMin * 60, running: false, intervalId: null, blockKey: null, exhausted: false, deadlineMs: null };
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
      noneOpt.textContent = "No delay";
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

    // Every render re-derives the inspector's schedule readout from the same
    // analysis the tables show, so a delay or edit can never leave the two
    // disagreeing. The editable fields are untouched mid-typing.
    function refreshInspectorCpm() {
      const id = state.selectedTaskId;
      if (!id || !state.tasks.some((t) => t.id === id)) return;
      const n = selectedCpmNode(id);
      setText("inspector-cpm", n
        ? `ES ${n.esMin}m | EF ${n.efMin}m | Float ${n.totalFloatMin}m | ${n.isCritical ? "Critical (0m float)" : "Has float"}`
        : "");
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
      const saveBtn = $("btn-save-task");
      if (saveBtn) saveBtn.classList.remove("is-dirty");
      renderInspectorRelations(t);
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

    // Prerequisite chips carry the edit; the hidden comma field stays the
    // single value source that saveTaskEdits reads.
    function renderDepChips(hostId, selectedIds, blockedIds, ownId, onToggle) {
      const host = $(hostId);
      if (!host) return;
      host.innerHTML = "";
      const options = state.tasks.filter((t) => t.id !== ownId);
      if (options.length === 0) {
        const none = d.createElement("span");
        none.className = "chips-empty";
        none.textContent = "No other tasks yet";
        host.appendChild(none);
        return;
      }
      for (const task of options) {
        const on = selectedIds.indexOf(task.id) !== -1;
        const blocked = blockedIds.indexOf(task.id) !== -1;
        const chip = d.createElement("button");
        chip.className = "chip";
        chip.setAttribute("type", "button");
        chip.setAttribute("aria-pressed", on ? "true" : "false");
        chip.setAttribute("title", blocked
          ? `${task.id} already depends on this task, so it cannot be a prerequisite`
          : `${task.id}: ${task.title}`);
        chip.setAttribute("data-dep", task.id);
        chip.textContent = task.id;
        chip.disabled = blocked;
        chip.addEventListener("click", () => onToggle(task.id));
        host.appendChild(chip);
      }
    }

    function refocusChip(hostId, depId) {
      const host = $(hostId);
      if (!host || typeof host.querySelector !== "function") return;
      const cssEscape = typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function"
        ? CSS.escape : (v) => String(v).replace(/["\\\]]/g, "\\$&");
      const chip = host.querySelector(`[data-dep="${cssEscape(depId)}"]`);
      if (chip && typeof chip.focus === "function") chip.focus();
    }

    function parseDeps(raw) {
      return String(raw || "").split(",").map((s) => s.trim()).filter(Boolean);
    }

    function toggleInspectorDep(depId) {
      const deps = parseDeps(($("inspector-deps") || {}).value);
      const at = deps.indexOf(depId);
      if (at === -1) deps.push(depId); else deps.splice(at, 1);
      setValue("inspector-deps", deps.join(", "));
      saveTaskEdits();
      refocusChip("inspector-dep-chips", depId);
    }

    function renderInspectorRelations(task) {
      const near = Engine.graphNeighborhood(state.tasks, task.id);
      setText("inspector-upstream", near.upstream.join(", ") || "Nothing, ready to start");
      setText("inspector-downstream", near.downstream.join(", ") || "Nothing, this task ends a chain");
      renderDepChips("inspector-dep-chips", task.deps, near.downstream, task.id, toggleInspectorDep);
    }

    function renderNewTaskChips() {
      const picked = parseDeps(($("new-task-deps") || {}).value);
      renderDepChips("new-task-dep-chips", picked, [], "", (depId) => {
        const deps = parseDeps(($("new-task-deps") || {}).value);
        const at = deps.indexOf(depId);
        if (at === -1) deps.push(depId); else deps.splice(at, 1);
        setValue("new-task-deps", deps.join(", "));
        renderNewTaskChips();
        refocusChip("new-task-dep-chips", depId);
      });
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
          if (!g) {
            if (ev.type === "click" && state.showRelations) {
              state.showRelations = false;
              render();
            }
            return;
          }
          const id = g.getAttribute("data-id");
          if (id) {
            ev.preventDefault();
            state.showRelations = true;
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
      const durRaw = (($("inspector-duration") || {}).value || "").trim();
      const weightRaw = (($("inspector-weight") || {}).value || "").trim();
      const depsRaw = (($("inspector-deps") || {}).value || "").trim();
      // Descriptive, ordered validation: each rejected edit names the exact
      // problem before anything touches the plan.
      const dur = Number(durRaw);
      if (!durRaw || !Number.isFinite(dur) || dur <= 0) {
        const msg = "Minutes must be a positive number up to 600.";
        showError(msg); setInspectorStatus(msg); return;
      }
      if (dur > 600) {
        const msg = `Minutes must be 600 or less (the largest value the planner accepts); ${durRaw} is too long.`;
        showError(msg); setInspectorStatus(msg); return;
      }
      const weight = Number(weightRaw);
      if (!weightRaw || !Number.isFinite(weight) || weight <= 0) {
        const msg = "Priority must be a positive number up to 100.";
        showError(msg); setInspectorStatus(msg); return;
      }
      if (weight > 100) {
        const msg = `Priority must be 100 or less; ${weightRaw} is too high.`;
        showError(msg); setInspectorStatus(msg); return;
      }
      const deps = depsRaw ? depsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
      const unknown = deps.filter((dep) => !state.tasks.some((t) => t.id === dep));
      if (unknown.length) {
        const msg = `Unknown prerequisite${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Use task ids from the graph, like ${state.tasks.slice(0, 2).map((t) => t.id).join(", ")}.`;
        showError(msg); setInspectorStatus(msg); return;
      }
      if (deps.indexOf(id) !== -1) {
        const msg = `${id} cannot depend on itself.`;
        showError(msg); setInspectorStatus(msg); return;
      }
      const candidate = state.tasks.slice();
      candidate[idx] = Object.assign({}, candidate[idx], { title, durationMin: dur, weight, deps });
      try {
        Engine.validateAndTopoSort(candidate);
        mutate(`Edit ${id}`, () => { state.tasks = candidate; });
        setInspectorStatus(`Saved edits to ${id}.`);
        showError("");
        persist();
        populateSlipDropdown();
        fillInspector(id);
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
      mutate(`Delete ${id}`, () => {
        state.tasks = state.tasks.filter((t) => t.id !== id);
        state.doneTaskIds = state.doneTaskIds.filter((tid) => tid !== id);
        state.selectedTaskId = state.tasks.length ? state.tasks[0].id : "";
        state.slipTaskId = "";
        state.slipMin = 0;
      });
      setValue("slip-min-input", "0");
      setInspectorStatus(`Deleted ${id}.`);
      showToast(`Deleted ${id}.`, true);
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
      const node = at === -1 ? selectedCpmNode(id) : null;
      mutate(at === -1 ? `Mark ${id} done` : `Restore ${id}`, () => {
        if (at === -1) state.doneTaskIds.push(id);
        else state.doneTaskIds.splice(at, 1);
      });
      setText("btn-toggle-done", at === -1 ? "Mark Not Done" : "Mark Done");
      setInspectorStatus(at === -1 ? `${id} marked done and removed from remaining CPM.` : `${id} restored to the plan.`);
      persist();
      render();
      if (node && node.isCritical) setCapyMood("party", `Capybara cheers: ${id} just cleared off the critical path!`);
    }

    /* ---------------- delay shockwave and crash moves ---------------- */

    function shockSelected() {
      const id = state.selectedTaskId;
      if (!id) { setInspectorStatus("Select a task first."); return; }
      if (state.doneTaskIds.indexOf(id) !== -1) { setInspectorStatus(`${id} is done, so it cannot slip.`); return; }
      mutate(`Delay ${id} by 15m`, () => {
        state.slipMin = state.slipTaskId === id ? state.slipMin + 15 : 15;
        state.slipTaskId = id;
      });
      setValue("slip-task-select", state.slipTaskId);
      setValue("slip-min-input", String(state.slipMin));
      state.shockPulse = true;
      render();
      reactToDelay();
    }

    function clearDelay() {
      mutate("Clear delay", () => { state.slipTaskId = ""; state.slipMin = 0; });
      setValue("slip-task-select", "");
      setValue("slip-min-input", "0");
      render();
      setCapyMood("calm", "Capybara check: delay cleared, float restored.");
    }

    function reactToDelay() {
      if (!state.slipTaskId || state.slipMin <= 0) return;
      const trace = Engine.traceDelayShockwave(activeTasks(), state.slipTaskId, state.slipMin);
      if (trace.finishShiftMin > 0) {
        setCapyMood("worried", `Capybara alert: ${state.slipTaskId} pushed the finish by ${trace.finishShiftMin}m.`);
      } else {
        setCapyMood("happy", `Capybara approves: float absorbed all ${trace.absorbedMin}m.`);
      }
    }

    function currentAdvice() {
      const remaining = activeTasks();
      if (remaining.length === 0) return null;
      return Engine.adviseCrash(remaining, { slip: activeSlip() });
    }

    function activeSlip() {
      return state.slipTaskId && state.slipMin > 0
        ? { taskId: state.slipTaskId, slipMin: state.slipMin } : null;
    }

    function applyCrash(moveId) {
      const advice = currentAdvice();
      const move = advice && advice.moves.find((m) => m.moveId === moveId);
      if (!move) { showToast("That move no longer applies to this plan."); return false; }
      const verb = move.kind === "split2" ? `Split ${move.taskId}` : `Trim ${move.taskId} by ${move.cutMin}m`;
      // The engine re-validates every move against the live plan (unknown
      // task, stale duration, malformed split). A rejected move records no
      // history step and says why instead of corrupting the graph.
      let result = null;
      let failure = "";
      mutate(verb, () => {
        try {
          result = Engine.applyCrashMove(state.tasks, move);
          state.tasks = result.tasks;
          if (result.partIds.length) {
            if (state.selectedTaskId === move.taskId) state.selectedTaskId = result.partIds[0];
            if (state.slipTaskId === move.taskId) state.slipTaskId = result.partIds[0];
          }
        } catch (err) {
          failure = err.message;
          result = null;
        }
      });
      if (!result) {
        showError(`This move was rejected: ${failure}`);
        showToast(`This move was rejected: ${failure}`);
        return false;
      }
      persist();
      populateSlipDropdown();
      fillInspector(state.selectedTaskId);
      setInspectorStatus(`${verb} applied. Undo restores the previous plan.`);
      render();
      showToast(`${verb}: finish ${move.beforeMin}m to ${move.afterMin}m.`, true);
      setCapyMood("party", `Capybara celebrates: ${move.savedMin}m cleared off the critical path!`);
      return true;
    }

    function renderAdvisor(remaining) {
      const list = $("advisor-list");
      if (!list) return;
      list.innerHTML = "";
      const addEmpty = (text) => {
        const li = d.createElement("li");
        li.className = "advisor-empty";
        li.textContent = text;
        list.appendChild(li);
      };
      if (!remaining.length) { addEmpty("Add a task to see what-if moves."); return; }
      const advice = Engine.adviseCrash(remaining, { slip: activeSlip() });
      const lens = state.advisorLens;
      const rows = (lens === "all" ? advice.bestPerTask : advice.moves.filter((m) => m.kind === lens)).slice(0, 3);
      if (!rows.length) {
        addEmpty(advice.blockedByTiedChains
          ? `${advice.criticalPathCount} equal chains set the finish, so no single move can shorten it.`
          : "No move of this type shortens the finish.");
        return;
      }
      const cell = (tag, cls, text) => {
        const node = d.createElement(tag);
        node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
      };
      for (const move of rows) {
        const li = cell("li", "advisor-row");
        const head = cell("span", "advisor-move");
        head.appendChild(cell("b", "advisor-id", move.taskId));
        head.appendChild(d.createTextNode ? d.createTextNode(move.label) : cell("span", "", move.label));
        li.appendChild(head);
        li.appendChild(cell("span", "advisor-saving", `-${move.savedMin}m`));
        li.appendChild(cell("span", "advisor-detail",
          `${move.fromMin}m to ${move.toMin}m, finish ${move.beforeMin}m to ${move.afterMin}m`));
        const apply = cell("button", "btn btn-small advisor-apply", "Apply");
        apply.setAttribute("type", "button");
        apply.setAttribute("aria-label", `Apply ${move.label} on ${move.taskId}`);
        apply.setAttribute("data-move", move.moveId);
        apply.addEventListener("click", () => applyCrash(move.moveId));
        li.appendChild(apply);
        if (move.newBottleneck) {
          const lost = move.lostToRivalMin > 0 ? `, ${move.lostToRivalMin}m of this cut is lost` : "";
          li.appendChild(cell("span", "advisor-insight",
            `New bottleneck: ${move.newBottleneck.chain.join(" > ")} sets the finish${lost}.`));
        } else if (move.newlyCriticalIds.length) {
          li.appendChild(cell("span", "advisor-insight", `Also turns ${move.newlyCriticalIds.join(", ")} critical.`));
        }
        list.appendChild(li);
      }
    }

    /* --------------- one-click experiments and bottleneck lab --------------- */

    function setGraphProof(text) {
      setText("graph-proof", text || "");
    }

    // Deterministic float demo: delay a task whose float absorbs 15m, so the
    // judge sees float do its job without the finish moving.
    function demoAbsorbDelay() {
      const remaining = activeTasks();
      if (!remaining.length) { setGraphProof("Add a task first."); return; }
      const baseline = Engine.analyzeCriticalPath(remaining, activeSlip());
      const victim = baseline.nodes
        .filter((n) => !n.isCritical && n.totalFloatMin >= 15)
        .sort((a, b) => (b.totalFloatMin - a.totalFloatMin) || a.id.localeCompare(b.id))[0];
      if (!victim) {
        setGraphProof("Every task here is critical with 0m float, so nothing can absorb a delay. Push the deadline instead.");
        return;
      }
      const wasOnVictim = state.slipTaskId === victim.id;
      mutate(`Demo: delay ${victim.id} by 15m`, () => {
        state.slipTaskId = victim.id;
        state.slipMin = wasOnVictim ? state.slipMin + 15 : 15;
      });
      setValue("slip-task-select", state.slipTaskId);
      setValue("slip-min-input", String(state.slipMin));
      state.shockPulse = true;
      render();
      const after = Engine.analyzeCriticalPath(remaining, activeSlip());
      const shift = after.projectMakespanMin - baseline.projectMakespanMin;
      setGraphProof(`${victim.id} had ${victim.totalFloatMin}m of float, so the 15m delay fit inside it: the finish stays at ${after.projectMakespanMin}m (${shift === 0 ? "0m moved" : `+${shift}m moved`}).`);
      setCapyMood("happy", `Capybara audit: ${victim.id}'s ${victim.totalFloatMin}m float absorbed the whole 15m delay.`);
    }

    // Deterministic deadline demo: delay a critical task so the finish moves
    // minute for minute.
    function demoPushDeadline() {
      const remaining = activeTasks();
      if (!remaining.length) { setGraphProof("Add a task first."); return; }
      const baseline = Engine.analyzeCriticalPath(remaining, activeSlip());
      const victim = baseline.nodes
        .filter((n) => n.isCritical)
        .sort((a, b) => (b.totalFloatMin - a.totalFloatMin) || a.id.localeCompare(b.id))[0];
      if (!victim) { setGraphProof("No critical task found."); return; }
      const wasOnVictim = state.slipTaskId === victim.id;
      mutate(`Demo: delay ${victim.id} by 15m`, () => {
        state.slipTaskId = victim.id;
        state.slipMin = wasOnVictim ? state.slipMin + 15 : 15;
      });
      setValue("slip-task-select", state.slipTaskId);
      setValue("slip-min-input", String(state.slipMin));
      state.shockPulse = true;
      render();
      const after = Engine.analyzeCriticalPath(remaining, activeSlip());
      const shift = after.projectMakespanMin - baseline.projectMakespanMin;
      setGraphProof(`${victim.id} is critical with 0m float, so +15m pushed the finish from ${baseline.projectMakespanMin}m to ${after.projectMakespanMin}m (+${shift}m, minute for minute).`);
      setCapyMood("worried", `Capybara alert: ${victim.id} has no float, so the whole 15m landed on the finish.`);
    }

    // Direct advisor preview: name the best exact move and select its task so
    // the Bottleneck Lab and advisor both point at it.
    function demoPreviewFix() {
      const remaining = activeTasks();
      if (!remaining.length) { setGraphProof("Add a task first."); return; }
      const advice = Engine.adviseCrash(remaining, { slip: activeSlip() });
      if (!advice.best) {
        setGraphProof(advice.blockedByTiedChains
          ? `${advice.criticalPathCount} equal chains set the finish, so no single move can shorten it. Shorten two chains or split a shared task.`
          : "No exact move shortens this plan's finish.");
        return;
      }
      const move = advice.best;
      if (state.tasks.some((t) => t.id === move.taskId)) selectTask(move.taskId);
      setGraphProof(`Best exact fix: ${move.label.toLowerCase()} on ${move.taskId} moves the finish ${move.beforeMin}m to ${move.afterMin}m (${move.savedMin}m saved). Apply it from the crash advisor.`);
      setCapyMood("party", `Capybara forecast: ${move.taskId} ${move.label.toLowerCase()} buys back ${move.savedMin}m.`);
    }

    // ---- Bottleneck lab: exact response curve for the selected task ----

    function svgNode(tag, attrs, text) {
      const node = d.createElementNS ? d.createElementNS("http://www.w3.org/2000/svg", tag) : null;
      if (!node) return null;
      if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function clearSvg(svg) {
      if (!svg) return;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
    }

    function renderWhatIf() {
      const svg = $("svg-whatif");
      const task = state.tasks.find((t) => t.id === state.selectedTaskId);
      if (!svg) return;
      clearSvg(svg);
      setText("whatif-task", task ? `${task.id}: ${task.title}` : "");
      if (!task) {
        setText("whatif-result", "");
        setText("whatif-proof", "Select a task to preview its effect on the finish.");
        const apply = $("btn-apply-whatif");
        if (apply) apply.disabled = true;
        return;
      }
      if (!state.tasks.some((t) => t.id === state.selectedTaskId) || state.whatifDeltaMin === undefined) {
        state.whatifDeltaMin = 0;
      }
      const slip = activeSlip();
      let bn;
      try {
        bn = Engine.analyzeBottleneck(activeTasks(), task.id, { slip });
      } catch (_err) {
        setText("whatif-proof", "This task is not in the remaining plan.");
        return;
      }
      const deltaMin = Math.max(bn.minDeltaMin, Math.min(bn.maxDeltaMin, state.whatifDeltaMin));
      const previewDur = task.durationMin + deltaMin;
      const previewMakespan = Math.max(bn.rivalMin, bn.throughMin + deltaMin);
      const previewShift = previewMakespan - bn.baselineMin;

      // Slider + output + buttons.
      const slider = $("whatif-slider");
      if (slider) {
        slider.min = String(Math.round(bn.minDeltaMin));
        slider.max = String(Math.round(bn.maxDeltaMin));
        if (Number(slider.value) !== deltaMin) slider.value = String(Math.round(deltaMin));
      }
      const result = $("whatif-result");
      if (result) {
        result.textContent = `At ${previewDur}m: finish ${previewMakespan}m ` +
          (previewShift === 0 ? "(no change)" : `(${previewShift > 0 ? "+" : ""}${Math.round(previewShift * 100) / 100}m vs ${bn.baselineMin}m)`);
        result.setAttribute("data-state", previewShift > 0 ? "pushed" : previewShift < 0 ? "saved" : "steady");
      }
      const apply = $("btn-apply-whatif");
      if (apply) apply.disabled = deltaMin === 0;

      // Persistent causal explanation.
      const rivalLabel = bn.rivalChain.length ? bn.rivalChain.join(" > ") : "the rest of the plan";
      const floorCrossed = deltaMin < bn.crossoverDeltaMin;
      let proof;
      if (bn.floatMin === 0 && deltaMin === 0) {
        proof = `${task.id} sets the finish at ${bn.baselineMin}m with 0m float: every minute added moves the finish 1:1, and cutting it helps until ${bn.rivalMin}m.`;
      } else if (deltaMin === 0) {
        proof = `${task.id} holds ${bn.floatMin}m of float at a ${bn.baselineMin}m finish. Changes inside ${bn.crossoverDeltaMin >= 0 ? `±` : ""}${Math.abs(bn.crossoverDeltaMin)}m never reach the deadline; the crossover is at ${task.durationMin + bn.crossoverDeltaMin}m.`;
      } else if (previewShift === 0) {
        proof = `${task.id} at ${previewDur}m still finishes at ${bn.baselineMin}m: the ${Math.abs(deltaMin)}m change fits inside the ${bn.floatMin}m of float.`;
      } else if (floorCrossed) {
        proof = `At ${previewDur}m the rival chain ${rivalLabel} (${bn.rivalMin}m) sets the finish, so ${previewShift > 0 ? "stretching" : "cutting"} ${task.id} further cannot move the deadline past ${bn.rivalMin}m.`;
      } else {
        proof = `At ${previewDur}m, ${task.id} moves the finish to ${previewMakespan}m (${previewShift > 0 ? "+" : ""}${Math.round(previewShift * 100) / 100}m). The floor is the rival chain ${rivalLabel} at ${bn.rivalMin}m.`;
      }
      setText("whatif-proof", proof);

      // ---- exact response curve ----
      const W = 460, H = 132;
      const padL = 40, padR = 14, padT = 16, padB = 24;
      const lo = bn.minDeltaMin, hi = bn.maxDeltaMin;
      const yMin = Math.min(bn.rivalMin, bn.baselineMin, ...bn.points.map((p) => p.makespanMin));
      const yMax = Math.max(bn.rivalMin, bn.baselineMin, ...bn.points.map((p) => p.makespanMin));
      const spanX = Math.max(1e-9, hi - lo);
      const spanY = Math.max(1e-9, yMax - yMin);
      const xOf = (delta) => padL + ((delta - lo) / spanX) * (W - padL - padR);
      const yOf = (m) => padT + (1 - (m - yMin) / spanY) * (H - padT - padB);

      const frame = svgNode("g", { class: "whatif-plot-body" });
      // Rival floor (dashed) with label.
      frame.appendChild(svgNode("line", {
        x1: padL, y1: yOf(bn.rivalMin), x2: W - padR, y2: yOf(bn.rivalMin),
        stroke: "#2dd4bf", "stroke-dasharray": "4 3", "stroke-width": 1.2, opacity: 0.85
      }));
      frame.appendChild(svgNode("text", {
        x: padL + 4, y: yOf(bn.rivalMin) - 3, fill: "#2dd4bf", "font-size": 9
      }, `rival floor ${Math.round(bn.rivalMin)}m`));
      // Exact response polyline: max(rival, through + delta).
      const pts = bn.points.map((p) => `${xOf(p.deltaMin).toFixed(1)},${yOf(p.makespanMin).toFixed(1)}`).join(" ");
      frame.appendChild(svgNode("polyline", {
        points: pts, fill: "none", stroke: "#fb7185", "stroke-width": 2, "stroke-linejoin": "round"
      }));
      // Baseline marker at delta 0.
      frame.appendChild(svgNode("circle", {
        cx: xOf(0), cy: yOf(bn.baselineMin), r: 3.4, fill: "#a3abb6"
      }));
      frame.appendChild(svgNode("text", {
        x: xOf(0), y: yOf(bn.baselineMin) + 12, fill: "#a3abb6", "font-size": 9, "text-anchor": "middle"
      }, `now ${Math.round(bn.baselineMin)}m`));
      // Crossover marker.
      if (bn.crossoverDeltaMin >= lo && bn.crossoverDeltaMin <= hi) {
        frame.appendChild(svgNode("circle", {
          cx: xOf(bn.crossoverDeltaMin), cy: yOf(bn.rivalMin), r: 3.4,
          fill: "#101315", stroke: "#2dd4bf", "stroke-width": 1.6
        }));
        frame.appendChild(svgNode("text", {
          x: xOf(bn.crossoverDeltaMin), y: H - padB + 14, fill: "#2dd4bf", "font-size": 9, "text-anchor": "middle"
        }, `crossover ${Math.round(task.durationMin + bn.crossoverDeltaMin)}m`));
      }
      // Preview marker.
      if (deltaMin !== 0) {
        frame.appendChild(svgNode("circle", {
          cx: xOf(deltaMin), cy: yOf(previewMakespan), r: 4.2, fill: "#38bdf8", stroke: "#0e0f11", "stroke-width": 1
        }));
        frame.appendChild(svgNode("text", {
          x: Math.min(W - padR, xOf(deltaMin) + 6), y: yOf(previewMakespan) - 6,
          fill: "#38bdf8", "font-size": 9
        }, `${Math.round(previewMakespan)}m`));
      }
      // Axes.
      frame.appendChild(svgNode("line", { x1: padL, y1: padT, x2: padL, y2: H - padB, stroke: "#24282e", "stroke-width": 1 }));
      frame.appendChild(svgNode("line", { x1: padL, y1: H - padB, x2: W - padR, y2: H - padB, stroke: "#24282e", "stroke-width": 1 }));
      const ticks = [lo, 0, hi].filter((v, i, a) => a.indexOf(v) === i && v >= lo && v <= hi).sort((a, b) => a - b);
      for (const t of ticks) {
        frame.appendChild(svgNode("text", {
          x: xOf(t), y: H - padB + 12, fill: "#a3abb6", "font-size": 9, "text-anchor": "middle"
        }, `${Math.round(task.durationMin + t)}m`));
      }
      frame.appendChild(svgNode("title", null,
        `Deadline response for ${task.id}: finish = max(rival ${Math.round(bn.rivalMin)}m, ${Math.round(bn.throughMin)}m + change). Crossover at ${Math.round(task.durationMin + bn.crossoverDeltaMin)}m.`));
      svg.appendChild(frame);
    }

    function onWhatIfSlider() {
      const slider = $("whatif-slider");
      if (!slider) return;
      const n = Number(slider.value);
      state.whatifDeltaMin = Number.isFinite(n) ? n : 0;
      renderWhatIf();
    }

    function applyWhatIf() {
      const task = state.tasks.find((t) => t.id === state.selectedTaskId);
      if (!task) return;
      const newDur = Math.round((task.durationMin + state.whatifDeltaMin) * 100) / 100;
      if (newDur <= 0 || Math.abs(newDur - task.durationMin) < 1e-9) return;
      mutate(`Change ${task.id} to ${newDur}m`, () => {
        state.tasks = state.tasks.map((t) => (t.id === task.id ? Object.assign({}, t, { durationMin: newDur }) : t));
      });
      state.whatifDeltaMin = 0;
      persist();
      populateSlipDropdown();
      fillInspector(task.id);
      render();
      setInspectorStatus(`${task.id} changed to ${newDur}m. Undo restores the previous duration.`);
    }

    function resetWhatIf() {
      state.whatifDeltaMin = 0;
      renderWhatIf();
    }



    function planSettings() {
      return {
        policy: state.policy,
        focusBlockMin: state.focusBlockMin,
        breakMin: state.breakMin,
        dayCapacityMin: state.dayCapacityMin,
        workers: state.workers
      };
    }

    function shareHash() {
      return Engine.encodePlanHash({ tasks: state.tasks, doneTaskIds: state.doneTaskIds, settings: planSettings() });
    }

    function clearLocationHash() {
      const view = d.defaultView;
      if (!view || !view.location || !view.history || typeof view.history.replaceState !== "function") return;
      try {
        view.history.replaceState(null, "", view.location.pathname + view.location.search);
      } catch (_err) {
        view.location.hash = "";
      }
    }

    // A link replaces the plan on screen as one undoable step, then leaves the
    // address bar so a reload keeps later edits instead of re-importing.
    function importHash(hash) {
      const result = Engine.decodePlanHash(hash);
      clearLocationHash();
      if (!result.ok) {
        showError(result.error);
        showToast(result.error);
        return false;
      }
      const plan = result.plan;
      mutate("Load shared plan", () => {
        clearTimerInterval();
        state.focus = { index: 0, completed: 0, remainingSec: plan.settings.focusBlockMin * 60, running: false, intervalId: null, blockKey: null, exhausted: false, deadlineMs: null };
        state.presetId = "shared";
        state.tasks = plan.tasks;
        state.doneTaskIds = plan.doneTaskIds;
        state.selectedTaskId = plan.tasks[0].id;
        state.slipTaskId = "";
        state.slipMin = 0;
        Object.assign(state, plan.settings);
      });
      syncPresetSelect();
      setValue("policy-select", state.policy);
      setValue("focus-min-input", String(state.focusBlockMin));
      setValue("break-min-input", String(state.breakMin));
      setValue("cap-min-input", String(state.dayCapacityMin));
      setValue("workers-input", String(state.workers));
      setValue("slip-min-input", "0");
      showError("");
      persist();
      populateSlipDropdown();
      resetFocus(false);
      fillInspector(state.selectedTaskId);
      render();
      showToast(`Loaded a shared plan with ${plan.tasks.length} tasks.`, true);
      return true;
    }

    function copyShareLink() {
      let hash;
      try {
        hash = shareHash();
      } catch (err) {
        showToast(err.message);
        return;
      }
      const view = d.defaultView;
      const base = view && view.location ? String(view.location.href).split("#")[0] : "";
      const link = base + hash;
      setValue("share-url", link);
      const field = $("share-url");
      // The link is selected first, so it is still usable if the browser
      // holds or refuses clipboard access.
      if (field && typeof field.select === "function") field.select();
      const manual = "Link ready. Press Cmd or Ctrl+C to copy it.";
      showToast(manual);
      const clip = view && view.navigator && view.navigator.clipboard;
      if (clip && typeof clip.writeText === "function") {
        clip.writeText(link).then(() => showToast("Plan link copied."), () => showToast(manual));
      }
    }

    function renderPrintPlan(schedule) {
      const body = $("print-body");
      if (!body) return;
      const preset = Engine.PRESET_WORKFLOWS.find((w) => w.id === state.presetId);
      setText("print-title", preset ? preset.name.replace(/\s*\(\d+ Tasks\)$/, "") : "Shared CadenceDAG plan");
      const cpm = schedule.cpm;
      setText("print-summary", `Finish in ${cpm.projectMakespanMin} minutes on the critical path. ` +
        `${schedule.totalFocusBlocks} focus blocks over ${schedule.totalDays} day${schedule.totalDays === 1 ? "" : "s"}. ` +
        `Critical tasks: ${cpm.criticalTaskIds.join(", ")}.`);
      body.innerHTML = "";
      schedule.taskTimeline.forEach((item, idx) => {
        const first = schedule.blocks.find((b) => b.taskId === item.id);
        const tr = d.createElement("tr");
        const cells = [
          null,
          String(idx + 1),
          `${item.id}: ${item.title}`,
          first ? `Day ${first.dayIndex}, ${formatClock(first.startIso)}` : "",
          `${item.durationMin}m`,
          `${item.totalFloatMin}m`,
          item.isCritical ? "Critical" : "Float"
        ];
        for (const value of cells) {
          const td = d.createElement("td");
          if (value === null) {
            const box = d.createElement("span");
            box.className = "print-check";
            td.appendChild(box);
          } else {
            td.textContent = value;
          }
          tr.appendChild(td);
        }
        body.appendChild(tr);
      });
    }

    /* ------------------------ keyboard shortcuts --------------------- */

    function isEditableTarget(target) {
      if (!target) return false;
      const tag = String(target.tagName || "").toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable === true;
    }

    function isActivatableTarget(target) {
      if (!target) return false;
      const tag = String(target.tagName || "").toLowerCase();
      if (tag === "button" || tag === "a" || tag === "summary") return true;
      const role = typeof target.getAttribute === "function" ? target.getAttribute("role") : null;
      return role === "button" || role === "tab";
    }

    function openShortcuts() {
      const dialog = $("shortcut-dialog");
      if (dialog && typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    }

    function closeMenus() {
      if (typeof d.querySelectorAll !== "function") return;
      Array.from(d.querySelectorAll("details.menu[open]")).forEach((m) => { m.open = false; });
    }

    function handleKey(ev) {
      const key = String(ev.key || "");
      const target = ev.target;
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey) {
        const lower = key.toLowerCase();
        // Text fields keep the browser's own undo while someone is typing.
        if ((lower !== "z" && lower !== "y") || isEditableTarget(target)) return;
        if (lower === "y" && (ev.shiftKey || ev.metaKey)) return;
        if (typeof ev.preventDefault === "function") ev.preventDefault();
        if (lower === "y" || ev.shiftKey) redo(); else undo();
        return;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (key === "Escape") { closeMenus(); return; }
      if (isEditableTarget(target)) return;
      if (key === "?") {
        if (typeof ev.preventDefault === "function") ev.preventDefault();
        openShortcuts();
        return;
      }
      if ((key === " " || key === "Spacebar") && !isActivatableTarget(target)) {
        if (typeof ev.preventDefault === "function") ev.preventDefault();
        toggleTimer();
      }
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
        el.addEventListener("change", () => { fn(el.value); commitSettingsEdit(); render(); });
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
      onInput("slip-task-select", (v) => { state.slipTaskId = v; state.shockPulse = true; });
      onInput("slip-min-input", (v) => {
        const n = Number(v);
        state.slipMin = v === "" || !Number.isFinite(n) ? 0 : Math.max(0, n);
        state.shockPulse = true;
      });
      ["slip-task-select", "slip-min-input"].forEach((id) => {
        const el = $(id);
        if (el) el.addEventListener("change", () => { commitSlipEdit(); reactToDelay(); });
      });
      // Settings persist the moment they settle, even before a re-render.
      ["policy-select", "focus-min-input", "break-min-input", "cap-min-input",
        "start-date-input", "workers-input", "risk-delay-input"].forEach((id) => {
        const el = $(id);
        if (el) el.addEventListener("change", () => { persist(); });
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
          let autoNumber = state.tasks.length + 1;
          while (state.tasks.some((t) => t.id === `T${autoNumber}`)) autoNumber += 1;
          const id = (($("new-task-id") || {}).value || "").trim() || `T${autoNumber}`;
          const title = (($("new-task-title") || {}).value || "").trim() || `Custom Task ${id}`;
          // The displayed limits (1..600 minutes, 1..100 priority) are
          // enforced even when the browser number input is bypassed.
          const clampNum = (raw, lo, hi, fb) => {
            const n = Number(raw);
            if (raw === "" || !Number.isFinite(n)) return fb;
            return Math.min(hi, Math.max(lo, n));
          };
          const dur = clampNum((($("new-task-dur") || {}).value), 1, 600, 30);
          const wt = clampNum((($("new-task-weight") || {}).value), 1, 100, 7);
          const depsRaw = (($("new-task-deps") || {}).value || "").trim();
          const deps = depsRaw ? depsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
          const candidate = state.tasks.concat([{ id, title, durationMin: dur, weight: wt, category: "Custom", deps }]);
          try {
            Engine.validateAndTopoSort(candidate);
            mutate(`Add ${id}`, () => {
              state.tasks = candidate;
              state.selectedTaskId = id;
            });
            setInspectorStatus(`Added ${id}.`);
            showError("");
            persist();
            populateSlipDropdown();
            setValue("new-task-id", "");
            setValue("new-task-title", "");
            setValue("new-task-deps", "");
            selectTask(id);
            const addMenu = $("add-task-menu");
            if (addMenu) addMenu.open = false;
            showToast(`Added ${id}.`, true);
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
        applyPreset(Engine.PRESET_WORKFLOWS.some((w) => w.id === state.presetId) ? state.presetId : Engine.PRESET_WORKFLOWS[0].id);
        syncPresetSelect();
        setInspectorStatus(`Reset to ${state.presetId} preset. Saved edits cleared.`);
      });

      bindClick("btn-timer-start", startTimer);
      bindClick("pill-toggle", toggleTimer);
      bindClick("btn-timer-pause", () => { pauseTimer(); });
      bindClick("btn-timer-reset", () => { resetFocus(true); });
      bindClick("btn-timer-complete", () => { completeBlock(true); });
      bindClick("btn-timer-skip", () => { skipBlock(); });
      bindClick("btn-mark-done", () => {
        const blocks = focusBlocks();
        const current = blocks[state.focus.index] || blocks[0];
        if (!current) { setText("focus-status", "No active block to mark done."); return; }
        mutate(`Mark ${current.taskId} done`, () => {
          if (state.doneTaskIds.indexOf(current.taskId) === -1) state.doneTaskIds.push(current.taskId);
          state.selectedTaskId = current.taskId;
        });
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
            utcOffsetMin: utcOffsetFor
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
          if (state.capyClicks % 5 === 0) {
            setCapyMood("party", `Capybara tangerine party! ${state.capyClicks} pets and zero float lost.`);
          } else {
            setCapyMood("happy", notes[state.capyClicks % notes.length]);
          }
        };
        capy.addEventListener("click", pet);
        capy.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") { ev.preventDefault(); pet(); }
        });
      }
    }

    // Leaving a field with the mouse fires change between press and release.
    // Saving there would rebuild the control under the pointer and swallow the
    // click, so the save waits for the click's capture phase instead.
    let pointerHeld = false;
    let pendingInlineEdit = false;

    function flushInlineEdit() {
      if (!pendingInlineEdit) return;
      pendingInlineEdit = false;
      saveTaskEdits();
    }

    function commitInlineEdit() {
      if (pointerHeld) pendingInlineEdit = true;
      else saveTaskEdits();
    }

    // Uses the event path because a clicked chip may already be rebuilt and
    // detached from its menu by the time this listener runs.
    function eventInsideMenu(ev) {
      const path = typeof ev.composedPath === "function" ? ev.composedPath() : [];
      if (path.some((n) => n && typeof n.matches === "function" && n.matches("details.menu"))) return true;
      return Boolean(ev.target && typeof ev.target.closest === "function" && ev.target.closest("details.menu"));
    }

    function bindStudioControls() {
      const bindClick = (id, fn) => {
        const el = $(id);
        if (el) el.addEventListener("click", fn);
      };
      bindClick("btn-undo", undo);
      bindClick("btn-redo", redo);
      bindClick("toast-undo", undo);
      bindClick("btn-shock", shockSelected);
      bindClick("btn-clear-delay", clearDelay);
      bindClick("btn-share-link", copyShareLink);
      bindClick("btn-demo-slack", demoAbsorbDelay);
      bindClick("btn-demo-critical", demoPushDeadline);
      bindClick("btn-demo-crash", demoPreviewFix);
      const whatifSlider = $("whatif-slider");
      if (whatifSlider) {
        whatifSlider.addEventListener("input", onWhatIfSlider);
        whatifSlider.addEventListener("change", onWhatIfSlider);
      }
      bindClick("btn-apply-whatif", applyWhatIf);
      bindClick("btn-reset-whatif", resetWhatIf);
      bindClick("btn-shortcuts", openShortcuts);
      bindClick("btn-shortcuts-close", () => {
        const dialog = $("shortcut-dialog");
        if (dialog && typeof dialog.close === "function") dialog.close();
      });
      bindClick("btn-print", () => {
        closeMenus();
        const view = d.defaultView;
        if (view && typeof view.print === "function") view.print();
      });

      // Inline edits commit when a field settles; the Save button only
      // appears while a change is still pending.
      ["inspector-title", "inspector-duration", "inspector-weight"].forEach((id) => {
        const el = $(id);
        if (!el) return;
        el.addEventListener("input", () => {
          const saveBtn = $("btn-save-task");
          if (saveBtn) saveBtn.classList.add("is-dirty");
        });
        el.addEventListener("change", commitInlineEdit);
      });

      const lensHost = $("advisor-lens");
      const lensButtons = typeof d.querySelectorAll === "function" ? Array.from(d.querySelectorAll(".lens-btn")) : [];
      if (lensHost) {
        lensButtons.forEach((btn) => {
          btn.addEventListener("click", () => {
            state.advisorLens = btn.getAttribute("data-lens") || "all";
            lensButtons.forEach((b) => b.setAttribute("aria-pressed", b === btn ? "true" : "false"));
            renderAdvisor(activeTasks());
          });
        });
      }

      if (typeof d.addEventListener === "function") {
        d.addEventListener("keydown", handleKey);
        // A click outside an open menu closes it.
        d.addEventListener("click", (ev) => {
          if (!eventInsideMenu(ev)) closeMenus();
        });
        d.addEventListener("pointerdown", () => { pointerHeld = true; }, true);
        d.addEventListener("pointerup", () => {
          pointerHeld = false;
          // A release that produces no click still saves the edit.
          later(flushInlineEdit, 0);
        }, true);
        d.addEventListener("click", flushInlineEdit, true);
      }
      const view = d.defaultView;
      if (view && typeof view.addEventListener === "function") {
        view.addEventListener("hashchange", () => {
          const hash = String(view.location.hash || "");
          if (hash.indexOf("#plan=") === 0) importHash(hash);
        });
        let resizeTimer = null;
        view.addEventListener("resize", () => {
          cancelLater(resizeTimer);
          resizeTimer = later(render, 120);
        });
        // Background tabs throttle interval callbacks. The countdown derives
        // from an absolute deadline, so returning to the tab simply reads the
        // true remaining time at once instead of waiting for the next tick.
        view.addEventListener("visibilitychange", () => {
          if (d.visibilityState === "visible" && state.focus.running) tickTimer();
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

    // The true per-day offset: the engine accepts a function of the day
    // index, and this resolves each plan day to its own calendar date, so a
    // daylight saving transition inside a plan keeps every day at 09:00
    // local instead of drifting an hour after the shift. Noon avoids the
    // midnight-adjacent ambiguity of getTimezoneOffset.
    function utcOffsetFor(dayIdx) {
      const parts = String(state.startDateIso).split("-").map(Number);
      const day = new Date(parts[0] || 2026, (parts[1] || 1) - 1, (parts[2] || 1) + (Number.isFinite(Number(dayIdx)) ? Number(dayIdx) : 0), 12, 0, 0);
      const off = day.getTimezoneOffset();
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
          utcOffsetMin: utcOffsetFor,
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

    // The countdown anchors to an absolute deadline timestamp instead of
    // decrementing once per interval callback: throttled background tabs,
    // stalled timers and sleeping machines all recover exactly, because the
    // remaining seconds are recomputed from the wall clock on every tick.
    function startTimer() {
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
      state.focus.deadlineMs = Date.now() + state.focus.remainingSec * 1000;
      state.focus.running = true;
      state.focus.intervalId = d.defaultView && d.defaultView.setInterval
        ? d.defaultView.setInterval(tickTimer, 1000)
        : (typeof setInterval === "function" ? setInterval(tickTimer, 1000) : null);
      updateFocusUI();
    }

    function toggleTimer() {
      if (state.focus.running) pauseTimer(); else startTimer();
    }

    function pauseTimer() {
      if (state.focus.running && state.focus.deadlineMs !== null) {
        // Freeze the remaining seconds at the true wall-clock remainder, so
        // resume continues from where the block actually was.
        state.focus.remainingSec = Engine.remainingTimerSeconds(state.focus.deadlineMs, Date.now());
      }
      state.focus.deadlineMs = null;
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
      state.focus.deadlineMs = null;
      if (announce) setText("focus-status", "Timer reset. Ready for a fresh focus block.");
      updateFocusUI();
    }

    // The countdown must always match the scheduled block it points at. After
    // any queue recompute (task done, edited, deleted, preset changed) the
    // saved block identity rebases onto the matching remaining block, or
    // cleanly to the first block when that block no longer exists. A running
    // timer re-anchors its absolute deadline whenever the block shifts.
    function syncFocusToQueue(blocks) {
      const f = state.focus;
      if (f.blockKey) {
        const at = blocks.findIndex((b) => `${b.taskId} p${b.part}` === f.blockKey);
        if (at !== -1) {
          const moved = f.index !== at;
          if (moved) f.index = at;
          const capped = Math.min(f.remainingSec > 0 ? f.remainingSec : blocks[at].durationMin * 60, blocks[at].durationMin * 60);
          if (capped !== f.remainingSec || (moved && f.running)) {
            f.remainingSec = capped;
            // The live block's identity or length changed under a running
            // timer: restart the wall-clock anchor from the new remainder.
            if (f.running) f.deadlineMs = Date.now() + f.remainingSec * 1000;
          }
          return;
        }
      }
      // The saved block is gone: land on the first remaining block.
      f.index = 0;
      f.remainingSec = blocks.length ? blocks[0].durationMin * 60 : 0;
      f.blockKey = blocks.length ? `${blocks[0].taskId} p${blocks[0].part}` : null;
      if (f.running) f.deadlineMs = Date.now() + f.remainingSec * 1000;
    }

    // Focus length changes rebase the current block's countdown so the ring
    // and seconds never disagree with the new block length. A running timer
    // re-anchors its absolute deadline from the new remainder.
    function syncFocusToBlockLength() {
      const blocks = focusBlocks();
      if (!blocks.length) return;
      const current = blocks[state.focus.index] || blocks[0];
      state.focus.remainingSec = current.durationMin * 60;
      state.focus.blockKey = `${current.taskId} p${current.part}`;
      if (state.focus.running) state.focus.deadlineMs = Date.now() + state.focus.remainingSec * 1000;
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
      setCapyMood("happy", capyMessage);
    }

    function tickTimer() {
      if (!state.focus.running || state.focus.deadlineMs === null) return;
      state.focus.remainingSec = Engine.remainingTimerSeconds(state.focus.deadlineMs, Date.now());
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
      setText("pill-countdown", mmss(state.focus.remainingSec));
      setText("pill-task", current ? `${current.taskId}: ${current.title}` : "No block loaded");
      const pill = $("timer-pill");
      if (pill) pill.classList.toggle("is-running", state.focus.running);
      const pillBtn = $("pill-toggle");
      if (pillBtn) {
        pillBtn.setAttribute("aria-label", state.focus.running ? "Pause focus timer" : "Start focus timer");
        pillBtn.disabled = !blocks.length || state.focus.exhausted;
      }
      const pillFill = $("pill-bar-fill");
      if (pillFill && pillFill.style) {
        const span = Math.max(1, current ? current.durationMin * 60 : state.focusBlockMin * 60);
        pillFill.style.width = `${Math.round((1 - Math.max(0, Math.min(1, state.focus.remainingSec / span))) * 100)}%`;
      }
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

      setText("kpi-paths", paths.pathCountExact);
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
      // The count is exact via dynamic programming; the table shows at most
      // maxPaths materialized chains and says so when truncated.
      setText("paths-limit-status", paths.truncated
        ? `Showing ${paths.criticalPaths.length} of ${paths.pathCountExact} equal-length chains (the list is capped; the count above is exact).`
        : `${paths.pathCountExact} equal-length chain${paths.pathCount === 1 ? "" : "s"} set the finish.`);

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
      setText("paths-limit-status", reason);
      setText("graph-proof", "");
      setText("slip-summary", reason);
      renderAdvisor([]);
      renderNewTaskChips();
      renderWhatIf();
      const printBody = $("print-body");
      if (printBody) printBody.innerHTML = "";
      setText("print-summary", reason);
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
      const finishEl = $("kpi-makespan");
      if (finishEl) finishEl.setAttribute("data-state", deltaMakespan > 0 ? "pushed" : "steady");
      setText(
        "kpi-makespan-sub",
        deltaMakespan > 0
          ? `+${deltaMakespan}m deadline slip vs ${baselineCpm.projectMakespanMin}m baseline`
          : `Parallel speedup ${cpm.parallelSpeedup.toFixed(2)}x (${cpm.totalWorkMin}m work)`
      );
      setText("kpi-crit-count", `${cpm.criticalTaskIds.length} / ${cpm.nodes.length}`);
      // Parallel critical tasks are not a sequence, so show one real chain.
      const chains = Engine.enumerateCriticalPaths(remaining, activeSlip());
      const extraChains = Number(BigInt(chains.pathCountExact) - 1n);
      setText("kpi-crit-sub", chains.criticalPaths[0].join(" > ") + (extraChains > 0 ? ` (+${extraChains} tied)` : ""));
      setText("kpi-blocks", `${schedule.totalFocusBlocks} blocks`);
      setText(
        "kpi-blocks-sub",
        `${schedule.totalDays} day${schedule.totalDays === 1 ? "" : "s"} of ${state.focusBlockMin}m focus` +
        (state.breakMin > 0 ? ` + ${state.breakMin}m break` : ", no breaks")
      );
      setText("kpi-wspt", `${Math.round(schedule.totalWeightedCompletion).toLocaleString()}`);
      setText("kpi-wspt-sub", `Lower is better, ${state.policy === "critical" ? "Critical-First" : state.policy === "shortest" ? "SPT" : "WSPT"} order`);

      if (Svg) {
        const slip = activeSlip();
        Svg.renderDagGraph($("svg-dag"), cpm, state.selectedTaskId, {
          related: state.showRelations && state.selectedTaskId ? Engine.graphNeighborhood(remaining, state.selectedTaskId) : null,
          shock: slip ? Engine.traceDelayShockwave(remaining, slip.taskId, slip.slipMin) : null,
          animate: state.shockPulse
        });
        state.shockPulse = false;
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
        setText("slip-summary", "No delay injected. Pick a task and add minutes to watch float absorb it or the finish move.");
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
      renderAdvisor(remaining);
      renderNewTaskChips();
      renderPrintPlan(schedule);
      // The timer follows the recomputed queue: rebase onto the saved block
      // identity, or cleanly onto the first remaining block when that block
      // completed or was removed.
      syncFocusToQueue(schedule.blocks);
      refreshInspectorCpm();
      renderWhatIf();
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
      syncPresetSelect();
      const dateInput = $("start-date-input");
      if (dateInput) dateInput.value = state.startDateIso;
      // Persisted planning settings reach their inputs before the first render.
      setValue("policy-select", state.policy);
      setValue("focus-min-input", String(state.focusBlockMin));
      setValue("break-min-input", String(state.breakMin));
      setValue("cap-min-input", String(state.dayCapacityMin));
      setValue("workers-input", String(state.workers));
      setValue("risk-delay-input", String(state.riskDelayMin));
      populateSlipDropdown();
      bindTabs();
      bindInputs();
      bindStudioControls();
      bindSelection();
      syncHistoryButtons();
      // A stale persisted selection (task deleted before reload) already
      // fell back during loadPersisted; sync the inspector to whatever exists.
      if (!state.selectedTaskId || !state.tasks.some((t) => t.id === state.selectedTaskId)) {
        state.selectedTaskId = state.tasks.length ? state.tasks[0].id : "";
      }
      resetFocus(false);
      if (state.selectedTaskId) selectTask(state.selectedTaskId);
      else render();
      const view = d.defaultView;
      const hash = view && view.location ? String(view.location.hash || "") : "";
      if (hash.indexOf("#plan=") === 0) importHash(hash);
    }

    return { init, render, applyPreset, state, utcOffsetFor, utcOffsetMin,
      selectTask, saveTaskEdits, deleteSelectedTask, toggleDone,
      completeBlock, skipBlock, resetFocus, comparePolicies: () => Engine.comparePolicies(activeTasks()),
      undo, redo, applyCrash, shockSelected, clearDelay, importHash, shareHash, handleKey, toggleTimer,
      canUndo: () => history.canUndo(), canRedo: () => history.canRedo() };
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => {
      const ctrl = createController(document);
      if (ctrl) ctrl.init();
    });
  }

  return { createController, escapeHtml };
});
