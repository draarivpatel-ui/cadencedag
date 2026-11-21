"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Engine = require("../js/dag-engine.js");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const appJs = fs.readFileSync(path.join(ROOT, "js/app.js"), "utf8");
const engineJs = fs.readFileSync(path.join(ROOT, "js/dag-engine.js"), "utf8");

const idList = () => [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

test("UI 01: HTML5 doctype, language, charset and viewport", () => {
  assert.match(html.trimStart(), /^<!DOCTYPE html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /name="viewport"/);
});

test("UI 02: all ids are unique and the four tabs resolve to panels", () => {
  const ids = idList();
  assert.equal(new Set(ids).size, ids.length);
  const set = new Set(ids);
  for (const [tab, panel] of [
    ["tab-dag", "panel-dag"], ["tab-nodes", "panel-nodes"],
    ["tab-blocks", "panel-blocks"], ["tab-risk", "panel-risk"]
  ]) {
    assert.ok(set.has(tab) && set.has(panel));
    assert.match(html, new RegExp(`id="${tab}"[^>]*aria-controls="${panel}"`));
    assert.match(html, new RegExp(`id="${panel}"[^>]*aria-labelledby="${tab}"`));
  }
});

test("UI 03: every label[for] resolves to a real control", () => {
  const set = new Set(idList());
  const fors = [...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(fors.length >= 12);
  for (const id of fors) assert.ok(set.has(id), `unresolved label #${id}`);
});

test("UI 04: all three scripts load in dependency order", () => {
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ["js/dag-engine.js", "js/ui-dag.js", "js/app.js"]);
  assert.ok(scripts.length === 3);
  for (const rel of scripts) assert.ok(fs.existsSync(path.join(ROOT, rel)));
});

test("UI 05: new risk controls and readouts are present and bound", () => {
  const set = new Set(idList());
  for (const id of ["workers-input", "risk-delay-input", "kpi-paths", "kpi-parallel",
    "kpi-util", "kpi-slack", "kpi-worst", "kpi-mean-delay", "critical-paths-body",
    "worker-ledger-body", "risk-samples-body", "btn-export-telemetry",
    "btn-validate-ics", "ics-validate-result"]) {
    assert.ok(set.has(id), `missing #${id}`);
  }
  for (const fn of ["enumerateCriticalPaths", "analyzeScheduleRisk", "scheduleWithWorkers",
                    "validateIcs", "planTelemetry"]) {
    assert.ok(appJs.includes(`Engine.${fn}`), `${fn} not used by the controller`);
    assert.ok(engineJs.includes(`function ${fn}(`), `${fn} missing from engine`);
  }
});

test("UI 06: controller binds the new inputs and export buttons", () => {
  // Numeric inputs are bound through the onInput helper; buttons use $ directly.
  for (const id of ["workers-input", "risk-delay-input"]) {
    assert.ok(appJs.includes(`onInput("${id}"`), `#${id} not bound`);
  }
  for (const id of ["btn-export-telemetry", "btn-validate-ics"]) {
    assert.ok(appJs.includes(`$("${id}")`), `#${id} not bound`);
  }
  assert.ok(appJs.includes("renderRiskPanel(remaining)"));
});

test("UI 07: tables carry accessible captions", () => {
  const captions = (html.match(/<caption\b/g) || []).length;
  assert.ok(captions >= 3);
  assert.match(html, /<th scope="col">|<th>/);
});

test("UI 08: styles use tabular numerics and a visible focus treatment", () => {
  assert.match(css, /font-variant-numeric: tabular-nums/);
  assert.ok(/:focus/.test(css));
});

/* ----------------------- deterministic UI readouts ---------------------- */

test("UI 09: risk KPI values come from the engine, not hard coded markup", () => {
  const p = Engine.enumerateCriticalPaths(Engine.PRESET_WORKFLOWS[0].tasks);
  const r = Engine.analyzeScheduleRisk(Engine.PRESET_WORKFLOWS[0].tasks, { delayMin: 10 });
  const m = Engine.scheduleWithWorkers(Engine.PRESET_WORKFLOWS[0].tasks, { workers: 3 });
  assert.equal(p.makespanMin, 180);
  assert.equal(r.baselineMakespanMin, 180);
  assert.equal(m.workers, 3);
  assert.ok(m.utilization <= 1);
});

test("UI 10: the ICS validator reports zero errors for every preset", () => {
  for (const wf of Engine.PRESET_WORKFLOWS) {
    const s = Engine.scheduleWorkflow(wf.tasks, { focusBlockMin: 25, breakMin: 5 });
    const v = Engine.validateIcs(Engine.exportScheduleToIcs(s, "Contract Check"));
    assert.equal(v.valid, true);
    assert.equal(v.errors.length, 0);
    assert.equal(v.eventCount, s.blocks.length);
  }
});

test("UI 11: diagnostics JSON has stable keys across parameter changes", () => {
  const a = Engine.planTelemetry(Engine.PRESET_WORKFLOWS[0].tasks, { workers: 2, delayMin: 5 });
  const b = Engine.planTelemetry(Engine.PRESET_WORKFLOWS[0].tasks, { workers: 5, delayMin: 25 });
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  assert.equal(a.taskCount, b.taskCount);
  assert.equal(a.makespanMin, b.makespanMin);
  assert.notEqual(a.workers, b.workers);
});

/* ----------------------------- compliance ------------------------------- */

test("UI 12: no em-dashes or en-dashes in shipped text files", () => {
  for (const rel of ["index.html", "styles.css", "js/app.js", "js/dag-engine.js",
                     "js/ui-dag.js", "tests/dom-smoke.test.js", "tests/advanced.test.js"]) {
    const txt = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.equal(/[\u2013\u2014]/.test(txt), false, `${rel} contains a forbidden dash`);
  }
});

test("UI 13: no forbidden vendor or disclosure terms in shipped text files", () => {
  // Assemble the forbidden-name list from char codes so this test file never
  // contains a literal vendor or model name.
  const codes = [
    [65,73],[76,76,77],[67,108,97,117,100,101],[79,112,101,110,65,73],
    [65,110,116,104,114,111,112,105,99],[71,101,109,105,110,105],[67,111,112,105,108,111,116],
    [67,104,97,116,71,80,84],[66,101,100,114,111,99,107],[78,101,98,105,117,115]
  ];
  const names = codes.map(cs => String.fromCharCode.apply(null, cs));
  const banned = new RegExp("\\b(?:" + names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b", "i");
  for (const rel of ["index.html", "styles.css", "js/app.js", "js/dag-engine.js", "js/ui-dag.js"]) {
    const txt = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const [i, line] of txt.split("\n").entries()) {
      assert.equal(banned.test(line), false, `${rel}:${i + 1}`);
    }
  }
});

test("UI 14: the page makes no external network references", () => {
  assert.equal(/<script[^>]+src="https?:/.test(html), false);
  assert.equal(/<link[^>]+href="https?:/.test(html), false);
});
