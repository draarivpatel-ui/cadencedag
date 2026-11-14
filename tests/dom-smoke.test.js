const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeEl(tag, id = "") {
  const listeners = {};
  return {
    tagName: tag.toUpperCase(),
    id,
    value: "",
    textContent: "",
    _innerHTML: "",
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) { this._innerHTML = String(v); if (this._innerHTML === "") this.children = []; },
    options: [],
    children: [],
    attributes: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, f) {
        if (f === undefined) this._set.has(c) ? this._set.delete(c) : this._set.add(c);
        else if (f) this._set.add(c);
        else this._set.delete(c);
      },
      contains(c) { return this._set.has(c); }
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    dispatchEvent(ev) { for (const fn of listeners[ev.type] || []) fn(ev); },
    appendChild(child) {
      this.children.push(child);
      if (this.tagName === "SELECT" && child.tagName === "OPTION") this.options.push(child);
      return child;
    },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); },
    get firstChild() { return this.children[0] || null; }
  };
}

test("DOM smoke: CadenceDAG binds all controls, handles cycle errors, slippage, and capybara easter egg", () => {
  const rootDir = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
  const ids = [
    "preset-select", "policy-select", "focus-min-input", "break-min-input", "cap-min-input",
    "start-date-input", "btn-export-ics", "btn-export-json", "new-task-id", "new-task-dur",
    "new-task-title", "new-task-weight", "new-task-deps", "btn-add-task", "error-banner",
    "kpi-makespan", "kpi-crit-count", "kpi-blocks", "kpi-wspt", "svg-dag", "svg-gantt",
    "slip-task-select", "slip-min-input", "slip-summary", "slack-table-body", "blocks-table-body",
    "capybara-easter", "capybara-status"
  ];

  const byId = new Map();
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `Missing #${id} in index.html`);
    byId.set(id, makeEl(id.includes("select") ? "select" : id.includes("input") ? "input" : id.includes("svg") ? "svg" : "div", id));
  }

  const tabs = ["tab-dag", "tab-nodes", "tab-blocks"].map((id, idx) => {
    const t = makeEl("button", id);
    t.setAttribute("aria-controls", ["panel-dag", "panel-nodes", "panel-blocks"][idx]);
    t.setAttribute("aria-selected", idx === 0 ? "true" : "false");
    return t;
  });
  const panels = ["panel-dag", "panel-nodes", "panel-blocks"].map((id, idx) => {
    const p = makeEl("div", id);
    if (idx === 0) p.classList.add("is-active");
    return p;
  });

  const doc = {
    body: makeEl("body"),
    getElementById(id) { return byId.get(id) || null; },
    createElement(tag) { return makeEl(tag); },
    createElementNS(_ns, tag) { return makeEl(tag); },
    querySelectorAll(sel) {
      if (sel === ".tab") return tabs;
      if (sel === ".panel") return panels;
      return [];
    },
    addEventListener() {}
  };

  const Engine = require("../js/dag-engine.js");
  const svgCtx = { document: doc, Math, Number, Object, String, Array };
  svgCtx.globalThis = svgCtx;
  vm.runInNewContext(fs.readFileSync(path.join(rootDir, "js/ui-dag.js"), "utf8"), svgCtx);
  const Svg = svgCtx.CadenceDagSvg;

  const sandbox = { document: doc, Math, Number, Object, String, Array, URL, Blob: function () {} };
  sandbox.globalThis = sandbox;
  sandbox.CadenceDagEngine = Engine;
  sandbox.CadenceDagSvg = Svg;
  vm.runInNewContext(fs.readFileSync(path.join(rootDir, "js/app.js"), "utf8"), sandbox);

  const ctrl = sandbox.CadenceDagApp.createController(doc);
  ctrl.init();

  assert.equal(byId.get("preset-select").options.length, 3);
  assert.ok(byId.get("kpi-makespan").textContent.includes("min"));
  assert.ok(byId.get("svg-dag").children.length > 5);
  assert.ok(byId.get("svg-gantt").children.length > 5);

  // Inject invalid missing-dependency task -> error banner turns visible
  byId.get("new-task-id").value = "BAD";
  byId.get("new-task-dur").value = "20";
  byId.get("new-task-deps").value = "NO_SUCH_NODE";
  byId.get("btn-add-task").dispatchEvent({ type: "click" });
  assert.ok(byId.get("error-banner").classList.contains("is-visible"));

  // Inject valid downstream node -> updates table cleanly
  byId.get("new-task-id").value = "T10";
  byId.get("new-task-deps").value = "T9";
  byId.get("btn-add-task").dispatchEvent({ type: "click" });
  assert.ok(!byId.get("error-banner").classList.contains("is-visible"));
  assert.equal(byId.get("slack-table-body").children.length, 10);

  // Test capybara easter egg click
  byId.get("capybara-easter").dispatchEvent({ type: "click" });
  assert.ok(byId.get("capybara-status").textContent.toLowerCase().includes("capybara"));
});
