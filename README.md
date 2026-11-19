# CadenceDAG

**Inspect task dependencies, slack, and scheduling tradeoffs.** CadenceDAG is an offline critical path project planner and Pomodoro scheduler written in vanilla JavaScript with zero dependencies. Enter a dependency graph and the engine computes earliest and latest times, total and free float, every critical chain, a deterministic risk sweep, a parallel worker ledger, and an RFC 5545 calendar. A live focus timer, click to edit nodes, automatic local persistence, a student preset and a 3-policy tradeoff strip turn the planner into an execution tool you can actually use during a study week.

Open `index.html` directly, or deploy the folder to any static host. There is no build step, no install and no network request.

## What it does

### 01 DAG and slack Gantt

Kahn topological sorting validates that task nodes have no missing prerequisites, self-loops, non-positive durations, negative weights or cycles. Forward and backward passes compute Earliest Start, Earliest Finish, Latest Start, Latest Finish, Total Float, Free Float, layer depth and parallel speedup. The SVG DAG colors the critical path, and the Gantt draws slack ghost bars behind each active task bar.

A slippage simulator injects minutes into any task and reports how much float absorbs the delay and how much pushes the project deadline.

Every DAG node is keyboard and pointer selectable (`tabindex="0"`, `role="button"`, Enter or Space) and every Gantt bar carries an SVG `<title>` tooltip with the full title, ES/EF, LS/LF, Total Float, Free Float and w/p. A compact legend explains the critical path, float bars and total float ghost band.

A one line **Next Best Focus** banner names the #1 task to work on right now and the reason for the active policy: a critical bottleneck, the highest WSPT score, the least float or the shortest ready task.

### 02 Node slack table and task inspector

Every node with its duration, [ES, EF] window, total float, free float, WSPT ratio and critical flag. Rows are selectable by click or keyboard, matching the DAG canvas.

The **Selected Task Inspector** edits the title, duration, priority weight and dependencies of any task, and shows a read-only schedule readout of the task's live CPM metrics: ES, EF, total float and critical status. Delete refuses to remove a node that still has downstream dependents. Mark Done removes a task from the remaining CPM graph and recomputes the live critical path. Reset Preset restores the shipped workflow. Edits and completion state persist automatically in `localStorage` with safe guards for Node and private browsing; deleting every task keeps the plan empty across reloads instead of resurrecting a preset, and an intentional empty store is preserved.

### 03 Pomodoro timer and focus block timeline

Three single-worker priority policies are available: WSPT (weight divided by duration), Critical-First (minimum total float) and SPT (shortest processing time). Work is split into focus blocks with an editable block length, break interval, daily focus budget, start date and a 09:00 local day start. The start date defaults to today's local date; the day anchor is the 09:00 local wall-clock time on that date and cannot be edited. Long tasks split across blocks and roll into the next day, and the daily budget caps focus work independently of the block length (a 60m budget with 90m blocks still schedules 60m of work per day). Each day is anchored with calendar-date arithmetic, so the wall-clock start stays at 09:00 local across daylight saving transitions. The whole schedule exports as a standards-shaped `.ics` calendar or a JSON plan.

A **3-Policy Tradeoff Comparison** strip compares weighted completion, the first three tasks and high-priority minutes finished in the first 120 minutes of work (excluding breaks and day rollover) for all three policies. The active policy is highlighted, so flipping the dropdown immediately shows the mathematical tradeoff.

An **Active Focus Block Timer** runs the queue with Start, Pause, Reset, Complete Block and Skip controls, a `MM:SS` countdown, a progress bar, an optional pure WebAudio completion chime and a Mark Task Done button that recomputes the live plan. The countdown always loads the scheduled block's real duration (the second 15m part of a 40m task starts at 15:00), the ring fills against that block's length, and finishing the last block shows a completed state and disables Start until more work is loaded. A Local/UTC clock toggle sets the block table window labels.

### 04 Risk, resources and worker swimlanes

A deterministic analytics layer, all computed from the same graph:

- **Critical path enumeration.** Every distinct longest dependency chain, with ties resolved deterministically.
- **Parallel worker scheduling.** The worker that is free first takes the ready task that can start soonest, with the selected policy breaking ties, so no startable critical task ever waits behind a queued successor. The ledger shows each worker's tasks, busy minutes and window, plus wall-clock makespan, utilization, speedup and idle time.
- **Parallel worker swimlane Gantt.** `#svg-workers` draws one bar lane per worker with shaded idle gaps and `<title>` tooltips.
- **Schedule risk sweep.** A bounded delay is injected into each task in turn. The summary reports worst case makespan, mean delay impact, maximum delta, absorbed count, absorbed fraction and slack coverage. Green bars show absorbed slack; rose bars show deadline push.
- **ICS validation.** A structural validator checks VCALENDAR markers, CRLF line endings, balanced VEVENT blocks, one UTC DTSTART/DTEND pair per event and timestamp shapes. The button reports the result right on the page.
- **Diagnostics export.** `planTelemetry()` produces a compact JSON snapshot of every count above.

Worker count (1 to 8) and per-task risk delay (0 to 240 minutes) are editable inputs; all six KPI cards, the swimlane SVG and three tables update immediately.

### Presets and the secret mascot

Four hand written presets ship with the page: Hackathon MVP Launch, Finals & Lab Prep, SaaS Feature Release, and **AP Exam & Robotics Build Week**, a nine-task high-school week with real prerequisite chains and float. The Capybara Chief Slack Auditor reacts to completed focus blocks and zero delayed critical tasks, with a tangerine badge that pulses while respecting `prefers-reduced-motion`.

## Verification

Node.js 18 or newer is sufficient. No install is needed.

```sh
npm test
```

That expands to `node --test tests/*.test.js` and passes **106 tests, 0 failed, 0 skipped, 0 cancelled**:

| Suite | Tests | Coverage |
| --- | --- | --- |
| `tests/dag-engine.test.js` | 10 | Presets, validation, CPM, slippage, WSPT, ICS export, free float, Pomodoro splits |
| `tests/advanced.test.js` | 28 | Critical chain enumeration (including id-collision keys), multi-worker ledger (including the CPM-floor regression), deterministic risk sweep (including the exact-float boundary), ICS validation (strict calendar ranges, UID and DTSTAMP checks), local wall-clock and DST day starts, plan telemetry (including delayMin 0) and cross-preset regressions |
| `tests/dom-smoke.test.js` | 1 | Real HTML loaded into a DOM stub; all controls including the fourth tab, worker count, risk delay, ICS validator, error handling and the slack mascot |
| `tests/ui-contract.test.js` | 14 | Markup, unique ids, resolved labels, script order, bindings, deterministic readouts, focus styles, dash and term compliance, zero network references |
| `tests/ui-dag.test.js` | 3 | SVG DAG markers, edges, selected stroke, node/bar tooltips, Gantt ticks, float ghost bars and worker swimlanes |
| `tests/phase2.test.js` | 23 | comparePolicies, AP Robotics preset, Pomodoro completion and CPM recomputation, inspector edit/delete guards, persistence, comparison strip, next action, swimlanes, focus label task id, instant Mark Done label, HTML escaping, preset timer restart, local 09:00 start |
| `tests/qa-fixes.test.js` | 27 | Timer block durations and queue progression, preset switch while running, completed and empty persistence, delay propagation into critical chains and policy comparison, 120 work minutes labeling, break 0 and budget clamping, stale selection recovery, DST anchoring, diagnostics remaining plan, strict ICS validation and UID escaping, exact-float criticalAfter |

Syntax verification:

```sh
for f in js/*.js tests/*.js; do node --check "$f" || exit 1; done
```

All files pass. The suite runs offline. Runtime depends on the machine and Node version. The DOM checks evaluate shipped scripts and markup inside small contract fixtures; a separate throwaway headless Chrome session at 1440x900 and 1920x1080 verified all four tabs, the timer flow and the empty states with zero console errors and zero external requests.

## Engine API

```js
const E = require('./js/dag-engine.js');
const wf = E.PRESET_WORKFLOWS[0].tasks;

const cpm = E.analyzeCriticalPath(wf);
const paths = E.enumerateCriticalPaths(wf);
const multi = E.scheduleWithWorkers(wf, { workers: 3, policy: 'wspt' });
const risk = E.analyzeScheduleRisk(wf, { delayMin: 10 });
const comparison = E.comparePolicies(wf, { horizonMin: 120 });
const schedule = E.scheduleWorkflow(wf, { focusBlockMin: 25, breakMin: 5 });
const ics = E.exportScheduleToIcs(schedule, 'My Focus Plan');
const check = E.validateIcs(ics);
const telemetry = E.planTelemetry(wf, { workers: 3, delayMin: 10 });
```

All internal units are minutes. Timestamps in `.ics` output are UTC. The default seed workflows are hand written teaching examples; the risk sweep is deterministic and does not use random sampling.

## Honest scope

- The queue and worker models are list-scheduling simulations, not a real team's availability. They are deterministic and explainable.
- All four preset workflows and their weights are illustrative fixtures, not measured project data.
- The `.ics` output is structurally validated by the shipped validator. It has not been imported into an external calendar client during this verification run.
- Visual rendering is supported by responsive styles, DOM contract tests and a throwaway headless Chrome verification pass.
- The focus timer and persistence run entirely in the browser. No account, network request or external audio file is used.

## Project layout

```
index.html         the four view studio
styles.css         dark visual system with focus, reduced motion and timer styling
js/dag-engine.js   CPM, WSPT, policy comparison, Pomodoro, enumeration, workers, risk, ICS
js/ui-dag.js       SVG DAG, Gantt and worker swimlane renderers
js/app.js          controller, inspector, timer, inputs, KPI cards, tables, exports
tests/             seven node:test files
```

## License

MIT.

## November 18 local verification

106 Node tests passed, 0 failed, 0 skipped, 0 cancelled.

`npm test` runs `node --test tests/*.test.js`. The explicit file pattern fixes
Node directory resolution. The suite covers all seven test files.
Published runtime is not a fixed performance claim.

Verification environment. Node v26.8.1. Visual checks of all four tabs ran in
a throwaway headless Chrome at 1440x900 and 1920x1080 with zero console
errors. No physical hardware session was run.

The calendar validator checks timestamps inside each event against real
calendar ranges (month 01-12, day valid for the month including leap years,
hour 00-23, minute and second 00-59), verifies the required PRODID and
per-event UID and DTSTAMP properties, rejects equal or reversed event windows,
duplicate timestamps and nested or misplaced event markers, and rejects mixed
line endings. Existing calendar tests include these regression assertions.
Validation is structural and does not establish calendar-client
interoperability.
