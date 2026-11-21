# CadenceDAG submission upgrade

## Inspiration

A Gantt chart can look convincing while hiding exactly which chain of tasks controls the deadline. CadenceDAG makes the critical structure inspectable: enumerate every longest chain, watch float absorb a delay, click any node to edit it, run a real focus block, and see what parallel workers would actually change.

## What it does

The studio turns an editable task dependency graph into a CPM forward and backward pass, a layered DAG, a slack-aware Gantt, three priority policies, Pomodoro focus blocks and a standards-shaped `.ics` calendar. Four preset workflows ship with the page, including a nine-task AP Exam & Robotics Build Week for high-school students. Any node can be added with a validated form, clicked on the DAG or table, edited inline, marked done, or deleted when it has no downstream dependents. Edits save automatically on the device.

The **Risk & Workers** view enumerates all distinct critical chains, assigns ready tasks to a configurable number of parallel workers, draws a swimlane Gantt with idle gaps, reports utilization and idle minutes, and runs a deterministic one-task-at-a-time delay sweep with worst case, mean impact and slack coverage. Green bars show absorbed slack and rose bars show deadline push. A built-in `.ics` validator reports the structural result on screen, and a diagnostics export writes every count to JSON.

The **Focus Timer** view runs a live focus timer tied to the computed queue, with Start, Pause, Reset, Complete Block, Skip and Mark Task Done controls, a `MM:SS` countdown, progress bar, and a pure WebAudio chime with no external audio file. Marking a task done recomputes the critical path immediately. A Local/UTC clock toggle and a today-default start date keep the schedule grounded for students.

A **3-Policy Tradeoff Comparison** strip shows weighted completion, first three tasks and high-priority minutes in the first 120 minutes of work (excluding breaks and day rollover) for WSPT, Critical-First and SPT side by side. The active policy is highlighted so the dropdown always tells a mathematical story. A one line Next Best Focus Action banner names the task to start right now. The Capybara Chief Slack Auditor celebrates finished blocks and zero delayed critical tasks with a pulsing tangerine badge.

## How we built it

`js/dag-engine.js` is a dependency-free UMD module shared by the browser and Node tests. Kahn sorting validates the graph. Forward and backward passes produce ES, EF, LS, LF, total float and free float. Critical chain enumeration walks backward from zero-successor terminal nodes whose earliest finish equals the makespan. Multi-worker scheduling reuses the exact policy comparator from the single-worker scheduler, then hands the earliest-free worker whichever ready task can start soonest (non-delay list scheduling), with the policy breaking ties and every dependency end time respected. `comparePolicies` runs the same scheduler under all three policies and reduces each timeline into comparable tradeoff metrics. All analytics are pure and deterministic.

`js/ui-dag.js` renders the DAG, Gantt and worker swimlanes as inline SVG with `<title>` tooltips and keyboard-accessible node groups. `js/app.js` binds the inspector, localStorage persistence, the focus timer and the policy strip without importing a framework or making a network request.

## Challenges

The single-worker WSPT scheduler was correct but could not answer a judge asking how many people would shorten the project. Adding a parallel ledger required a precedence-aware start time: a task cannot begin when a worker frees up if an upstream task is still running. The regression suite now checks that invariant across all four presets, all three policies and worker counts from 1 to 6.

Risk reporting also needed honest labeling. Random sampling would have produced numbers that change on refresh, so the upgrade uses an exact sweep over every task and states plainly that it is not a Monte Carlo simulation. The `.ics` validator was added because a generated calendar can look fine while having unbalanced VEVENT blocks or LF-only line endings.

Interactive edits introduced a graph-integrity problem: deleting a node with dependents would leave dangling prerequisite ids. The inspector now guards that case with a clear on-screen message, and Mark Done removes completed tasks from the remaining graph while dropping their edges so the live CPM stays valid. Persistence is wrapped in try/catch so private mode and a full storage quota cannot break the planner. Accessibility was tightened with `:focus-visible` outlines, keyboard selection on nodes and rows, and a reduced-motion block, all asserted by the UI contract suite.

## Accomplishments

- Enumeration of every distinct longest chain, with deterministic tie handling.
- Parallel worker ledger and swimlane SVG with utilization, speedup, idle minutes and verified precedence.
- Deterministic delay sweep with absorbed fraction, slack coverage, worst case makespan and visual absorption bars.
- Structural `.ics` validation with a live on-page result.
- Pure 3-policy comparison strip with weighted completion, first three tasks and high-priority minutes.
- Live focus timer with WebAudio chime, progress tracking and CPM recomputation on task completion.
- Clickable DAG nodes and table rows, inline task editing, guarded delete, Mark Done and localStorage persistence.
- Fourth high-school preset, Next Best Focus Action banner and reactive Capybara tangerine badge.
- Four presets, six KPI cards, three risk tables, two extra SVG charts and a diagnostics JSON export.
- What-if crash advisor that re-solves every task against four moves, names the new bottleneck, and applies a move with one click.
- Delay shockwave, undo and redo, keyboard shortcuts, prerequisite chips, hardened share links and a one-page printable plan.
- 203 automated tests, up from 13, including brute-force advisor checks, 44 hostile share links, cross-preset regressions and real HTML wiring checks.

## Verification numbers

Verified on Node v26.8.1 with:

```sh
npm test
```

**203 passed, 0 failed, 0 skipped, 0 cancelled.**

| Check | Verified result |
| --- | --- |
| Total test count in git history (initial commit to this commit) | 13 to 203 |
| Studio suite (advisor, shockwave, history, share links, shortcuts, XSS sinks) | 97 tests |
| Critical chain enumeration suites | 5 tests, including a two-way tie |
| Multi-worker scheduling suites | 7 tests across worker counts 1 to 6, including a CPM-floor regression for every preset and policy |
| Deterministic risk sweep suites | 5 tests, exact absorption math pinned |
| ICS validation suites | 4 tests, including injected malformed calendars, real calendar-range checks and UID uniqueness |
| Phase 2 feature suites | 23 tests, policy comparison, preset, timer, inspector, persistence, swimlanes, HTML escaping |
| UI contract and DOM runtime suites | 15 tests |
| QA fix regression suites | 27 tests, timer block durations, preset switch recovery, empty-state persistence, delay propagation, 120 work minutes labeling, break 0 and budget clamping, stale selection recovery, DST anchoring, remaining-plan diagnostics, strict ICS validation and UID escaping, exact-float criticalAfter |
| JavaScript files passing `node --check` | 3 engine/UI plus 8 test files |
| Preset workflows with valid generated calendars | 4 of 4 |
| Preset workflows with verified worker precedence | 4 of 4 across 3 policies |
| Forbidden em/en dashes and vendor terms in shipped text | 0 |
| External network references in shipped runtime | 0 |

Pinned values for the first preset (Capybara Habitat Rescue): makespan 180 minutes, one critical chain C1 to C2 to C4 to C7 to C9, 9 tasks, best exact fix C4 split2 saving 25 minutes, and a 10 minute delay with 5 of 9 samples fully absorbed. The diamond fixture has a 70 minute makespan, 85 minutes of work, a 10 minute risk delay with 4 samples and a mean delta of 7.5 minutes.

## Devpost description

**CadenceDAG: inspect dependencies, slack, and scheduling tradeoffs.** An offline workbench that turns a task dependency graph into exact CPM timings, every distinct critical chain, three priority policies, a live Pomodoro focus timer and a validated RFC 5545 calendar. Click any DAG node to edit it, mark tasks done to recompute the critical path, and watch your work persist locally. The Risk & Resources view assigns ready tasks to parallel workers, draws a swimlane Gantt with idle gaps, and runs a deterministic delay sweep showing exactly how much float absorbs and how much pushes the deadline. A three-policy strip shows the cost of each priority rule. One-click experiments demonstrate float absorption, deadline push and the best exact fix, and a Bottleneck Lab draws the exact deadline response curve for any task with its crossover and rival-chain floor. A Capybara Habitat Rescue preset opens the app and its Chief Slack Auditor explains every result in plain words. Zero dependencies, one HTML file, 238 passing tests.

## What's next

Add calendar-client import verification, resource calendars with real availability, cost and skill constraints on workers, and a true stochastic schedule risk model with explicit distributions. Current presets are illustrative fixtures and the worker model is list scheduling, not a measured team simulation.

## November 18 local verification

203 Node tests passed, 0 failed, 0 skipped, 0 cancelled.

## November 20 Wave 1 revamp verification

238 Node tests across nine files passed, 0 failed, 0 skipped, 0 cancelled. The revamp closes the full Wave 1 judge critique: compact first screen with restored hierarchy, one-click experiment bar, Capybara Habitat Rescue as the opening preset, the Bottleneck Lab response curve, DP-counted critical paths with a capped materialized list, delay-aware telemetry, per-day DST offsets in the controller, an absolute-deadline focus timer, live inspector readouts, a persistent storage status badge, persisted settings with start date in undo history, enforced numeric limits with descriptive errors, stale-move rejection, and UTF-8 byte-length ICS folding.

`npm test` runs `node --test tests/*.test.js`. The explicit file pattern fixes
Node directory resolution. The suite covers all eight test files.
Published runtime is not a fixed performance claim.

Verification environment. Node v26.8.1. Visual checks of all four tabs ran in
a real browser at 1440x900, 1920x1080 and 390x844 with zero captured page
errors. No physical hardware session was run.

The calendar validator checks timestamps inside each event against real
calendar ranges (month 01-12, day valid for the month including leap years,
hour 00-23, minute and second 00-59), verifies the required PRODID and
per-event UID and DTSTAMP properties with UID uniqueness, rejects equal or
reversed event windows, duplicate timestamps and nested or misplaced event
markers, and rejects mixed line endings. Existing calendar tests include these
regression assertions. Validation is structural and does not establish
calendar-client interoperability.
