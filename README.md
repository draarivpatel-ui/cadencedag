# CadenceDAG

CadenceDAG is an offline critical path project planner and Pomodoro scheduler written in vanilla JS without any dependencies. You input the task dependency graph, and the software computes earliest and latest times, identifies zero slack paths, performs a deadline slip simulation, and exports an RFC 5545 calendar.

Aariv Patel made this software as part of his contribution to Teens Hack Houston (Triple H, Technical Track) based on the productivity topic.

## What It Does

Topological sorting by Kahn verifies that task nodes do not have missing prerequisites, self-loops, zero duration, or cycles. Passes through the graph from beginning to end and backwards calculate Earliest Start, Earliest Finish, Latest Start, Latest Finish, Total Float, Free Float, layer depth, and parallel speedup.

You can set a delay of minutes for any task to find out whether the slack is consumed or makespan is moved forward. The software orders tasks according to WSPT, Minimum Total Float, or Shortest Processing Time, cuts focus blocks within a budget for the day, plots layered DAG and Gantt diagrams in SVG format, and provides a clickable `#capybara-easter` Chief Slack Auditor.

## Testing

```bash
node --test tests/
```

Thirteen tests succeed through `node --test tests/`.
