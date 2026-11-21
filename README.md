# CadenceDAG

**See which tasks actually set your deadline, then fix the right one.** CadenceDAG is an offline critical path planner and focus timer written in vanilla JavaScript with zero dependencies. Draw a week as a dependency graph and it shows the critical path, what a delay really costs, and which single change buys back the most time.

Open `index.html` directly, or deploy the folder to any static host. There is no build step, no install, no account and no network request.

## What it does

### The studio view

Everything that matters sits on one screen: the live dependency graph, the finish time, the critical chain, Next Best Focus, the focus timer pill, the delay shockwave and the crash advisor.

- **Dependency graph.** Kahn topological sorting rejects missing prerequisites, self-loops, non-positive durations and cycles. Forward and backward passes compute Earliest Start, Earliest Finish, Latest Start, Latest Finish, Total Float and Free Float. Clicking a node lights its upstream prerequisites and downstream dependents.
- **Task inspector.** Edit the title, minutes and priority inline, toggle prerequisites with chips, and mark a task done. Chips that would create a cycle are disabled, and Delete refuses to orphan downstream tasks. The schedule readout shows live ES, EF, float and critical status.
- **Delay shockwave.** The `+15m delay shockwave` button sends a delay through the graph hop by hop. Each downstream task shows how far it moved, float absorbs what it can, and the finish time updates at once.
- **Crash advisor.** For every task it tests four moves: trim 10 minutes, trim 15 minutes, trim 25 percent, or split across two workers. Each candidate is re-solved exactly, ranked by real minutes saved, and applied with one click.
- **New bottleneck detection.** When a cut makes a different chain set the finish, the advisor names that chain and says how many minutes of the cut are lost.
- **Experiment bar.** One click each: `Absorb a delay` injects 15 minutes into the task with the most float and shows the finish hold still, `Push the deadline` delays a 0m float task and moves the finish minute for minute, and `Preview the best fix` names the exact crash move that buys the most time. Each experiment leaves a persistent causal sentence beside the graph.
- **Bottleneck lab.** A slider changes the selected task's duration and an SVG response curve shows the exact finish `max(rival chain, through + change)`, the rival floor, the crossover point, and a live preview against the current plan. `Apply change` commits as one undoable step; `Reset preview` snaps back.
- **Undo and redo.** Edits, completions, delays, crash moves, preset switches, imported plans and settled planning settings are all reversible, start date included.
- **Keyboard shortcuts.** `Cmd` or `Ctrl` `Z` undoes, adding `Shift` redoes, `Space` starts or pauses the timer when you are not typing, and `?` opens the cheat sheet.

### Timeline and policies

A slack-aware Gantt draws float windows behind each task. Three single-worker policies are compared side by side: WSPT (weight divided by duration), Critical-First (minimum total float) and SPT (shortest processing time). The comparison reports weighted completion, the first three tasks, and high-priority minutes finished in the first 120 minutes of work (excluding breaks and day rollover).

### Slack table

Every task with its duration, [ES, EF] window, total float, free float, WSPT ratio and critical flag.

### Focus timer

Work is split into focus blocks with an editable block length, break interval, daily focus budget, start date and a 09:00 local day start. Long tasks split across blocks and roll into the next day, and the daily budget caps focus work independently of the block length. Every plan day resolves its own UTC offset from the calendar date, so a daylight saving transition inside a plan keeps each day anchored at 09:00 local. The countdown derives from an absolute deadline timestamp instead of counting interval callbacks, so background-tab throttling, pause, resume, queue edits and tab visibility changes all recover the true remaining time. The timer always loads the scheduled block's real duration and stays visible in the top bar.

### Saved plan status

A badge in the top bar shows `Saved locally` after every write, and switches to a visible warning when saving is blocked (private browsing or a full quota), when restore data is corrupt, or when storage is unavailable. The plan, completed tasks, selection and all planning settings persist across reloads.

### Risk and workers

- **Critical path enumeration.** Dynamic programming counts every distinct longest dependency chain exactly, even when branching produces astronomically many equal chains (a 60 diamond graph reports all 1,152,921,504,606,846,976 of them). The table materializes at most 256 and says so explicitly when truncated. The count always includes the active delay.
- **Parallel worker scheduling and swimlanes.** The worker that is free first takes the ready task that can start soonest. The swimlane chart and ledger show each worker's tasks, busy minutes, idle gaps, utilization and speedup.
- **Schedule risk sweep.** A bounded delay is injected into each task in turn, reporting worst case, mean impact and how many delays float absorbs. An independent `verifyPlan` check re-validates the CPM identities, worker precedence and work conservation on every plan.
- **Calendar validation and diagnostics.** A structural `.ics` validator and a JSON diagnostics export.

### Sharing and printing

- **Plan links.** `Copy plan link` encodes the plan into a `#plan=` URL fragment. Opening the link loads the plan as one undoable step, and nothing is sent to a server.
- **One-page plan.** `Print one-page plan` produces a clean checklist in schedule order.
- **Exports.** `.ics` calendar and JSON.

Shared links are treated as hostile input. The decoder accepts only a fixed positional format, checks every field against an allowlist, rejects reserved ids such as `__proto__` and `constructor`, rejects markup and control characters in titles, caps sizes, and validates the graph before anything reaches the plan.

### Presets and the secret mascot

Five hand written presets ship with the page, and the **Capybara Habitat Rescue** opens first: a flooded capybara habitat rebuilt as a nine task dependency graph with an evacuation ramp, a veterinary check and a reopen gate. The Capybara Chief Slack Auditor explains what the numbers mean in plain words, balances a tangerine beside the graph, It worries when a delay pushes the finish, cheers when critical work clears, hops for completed focus blocks, and throws a tangerine party if you pet it five times. All of its motion respects `prefers-reduced-motion`.

## Verification

Node.js 18 or newer is sufficient. No install is needed.

```sh
npm test
```

That expands to `node --test tests/*.test.js` and passes **261 tests, 0 failed, 0 skipped, 0 cancelled**:

| Suite | Tests | Coverage |
| --- | --- | --- |
| `tests/studio.test.js` | 97 | Crash advisor (checked against full re-solves and an independent brute-force search), new bottleneck detection, tied chains, split rewiring, graph queries, shockwave tracing, undo and redo, share link round trips, 44 hostile links, deterministic fuzzing, keyboard shortcuts, XSS sinks, print plan, capybara reactions |
| `tests/wave1.test.js` | 35 | Exact DP path counts (2^60 chains counted, never materialized), delay-aware telemetry, Bottleneck Lab crossovers verified against full re-solves, verifyPlan invariants, absolute-deadline timer, per-day DST offsets, inspector freshness, storage status states, settings persistence and undo, input defenses, UTF-8 ICS folding |
| `tests/qa-fixes.test.js` | 27 | Timer block durations, preset switch recovery, empty-state persistence, delay propagation, 120 work minutes labeling, break and budget clamping, DST anchoring, strict ICS validation, exact-float boundaries |
| `tests/advanced.test.js` | 28 | Critical chain enumeration, multi-worker ledger, deterministic risk sweep, ICS validation, local wall-clock starts, plan telemetry, cross-preset regressions |
| `tests/phase2.test.js` | 23 | Policy comparison, AP preset, Pomodoro flow, inspector edit and delete guards, persistence, comparison strip, next action, swimlanes, HTML escaping |
| `tests/ui-contract.test.js` | 14 | Markup, unique ids, labels, script order, bindings, focus styles, dash and term compliance, zero network references |
| `tests/dag-engine.test.js` | 10 | Presets, validation, CPM, slippage, WSPT, ICS export, free float, Pomodoro splits |
| `tests/ui-dag.test.js` | 3 | SVG markers, edges, selected stroke, tooltips, Gantt ticks, float bars and worker swimlanes |
| `tests/dom-smoke.test.js` | 1 | Shipped HTML loaded into a DOM stub with every control exercised |
| `tests/wave2.test.js` | 23 | Wave 2 regressions: crossover curves re-solved under active delay, disconnected islands, share-link cycles and size caps, fractional durations, restored prerequisites, split verification, timer queue rebase and exhaustion, corrupt and invalid restore states, stale shared-plan option, parked delay honesty, slip-aware delay sweep, sub-second ICS events |

Syntax verification:

```sh
for f in js/*.js tests/*.js; do node --check "$f" || exit 1; done
```

## Engine API

```js
const E = require('./js/dag-engine.js');
const wf = E.PRESET_WORKFLOWS[0].tasks;

const cpm = E.analyzeCriticalPath(wf);
const advice = E.adviseCrash(wf);
const next = E.applyCrashMove(wf, advice.best).tasks;
const wave = E.traceDelayShockwave(wf, 'T5', 15);
const near = E.graphNeighborhood(wf, 'T5');
const link = E.encodePlanHash({ tasks: wf });
const plan = E.decodePlanHash(link);
const multi = E.scheduleWithWorkers(wf, { workers: 3, policy: 'wspt' });
const risk = E.analyzeScheduleRisk(wf, { delayMin: 10 });
const schedule = E.scheduleWorkflow(wf, { focusBlockMin: 25, breakMin: 5 });
const ics = E.exportScheduleToIcs(schedule, 'My Focus Plan');
```

All internal units are minutes. Timestamps in `.ics` output are UTC.

## Honest scope

- The advisor is exact for the model it solves, which is one move at a time on the dependency graph. It does not plan sequences of moves.
- A split assumes the task divides into two equal parallel halves, each carrying a fixed 5 minute handoff. Real tasks may not divide that cleanly.
- Critical path timing assumes enough people to run parallel tasks. The worker swimlanes show the effect of a fixed team.
- The risk sweep is a deterministic one-task-at-a-time delay test, not a Monte Carlo simulation.
- All five preset workflows and their weights are illustrative, not measured project data; the Capybara Habitat Rescue is a teaching example, not a real wildlife operation.
- The `.ics` output is structurally validated by the shipped validator. It has not been imported into an external calendar client.
- Undo history lasts for the current page session. The plan itself persists in `localStorage`.
- No user study has been run.

## Project layout

```
index.html         the studio view and four detail tabs
styles.css         instrument theme, responsive layout, motion and print plan
js/dag-engine.js   CPM, crash advisor, shockwave, history, share links, schedulers, risk, ICS
js/ui-dag.js       SVG DAG, Gantt and worker swimlane renderers
js/app.js          controller, inspector, timer, shortcuts, sharing, exports
tests/             ten node:test files
video/             demo narration and recording steps
```

## License

MIT.
