import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeWindowController, preferredWindowKey } from "../dist/runtime_window_state.js";
import { renderWindowCards, renderWindowLinkedSessions } from "../dist/runtime_window.js";
import { RuntimeSessionNavigation, runtimeSessionInventory, runtimeSessionIdentity, filterRuntimeSessions, preferredRuntimeSession, createRuntimeSessionRow, isExactRuntimeSessionId } from "../dist/runtime_sessions.js";

const windowA = "a".repeat(64), windowB = "b".repeat(64);
const project = "agent:runner:project";
const session = { session_id: "wc_sess_aaaaaaaaaaaaaaaa", project_id: project, client_id: "runner", project_name: "Project", title: "Realistic workflow", lifecycle: "active", updated_at: 100, running_call: true, running_jobs: 1, running_jobs_complete: true, overview: { attention: { open_todos: 2, open_questions: 1, open_risks: 0 } } };
const summary = key => ({ client_window_key: key, source: "openai-session", first_seen_at_ms: 1000, last_seen_at_ms: 3000, last_tool_call_at_ms: 2900, last_meaningful_activity_at_ms: 2800, last_project: project, active_count: 1, linked_session_count: 1, recorder_gap_count: 0 });
const listing = (keys = [windowA, windowB], extra = {}) => ({ windows: keys.map(summary), total: keys.length, truncated: false, visibility: { scope: "global" }, ...extra });
const detail = (key, marker = "latest") => ({ ...summary(key), marker, active_requests: [{ tool_name: "run_process", project }], linked_sessions: [{ workflow_session_id: session.session_id, project, title: session.title }], activity: [{ tool_name: "run_process", activity_kind: "Ran", project, ended_at_ms: 3000, workflow_sessions: [{ workflow_session_id: session.session_id }] }] });
const ok = data => ({ ok: true, status: 200, data });
const failed = status => ({ ok: false, status, data: null });
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const calls = [], changes = [];
  let rejected = 0;
  const controller = new RuntimeWindowController({
    post: (path, payload, signal) => new Promise(resolve => calls.push({ path, payload, signal, resolve })),
    changed: state => changes.push(structuredClone(state)), unauthorized: () => { rejected++; controller.reset(); },
  });
  return { controller, calls, changes, rejected: () => rejected };
}
async function load(h, keys = [windowA, windowB]) {
  const start = h.calls.length, promise = h.controller.refresh();
  h.calls[start].resolve(ok(listing(keys))); await tick();
  if (keys.length) h.calls[start + 1].resolve(ok(detail(keys[0])));
  await promise;
}

class Element {
  constructor(tag = "div") { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.className = ""; this.direct = ""; this.value = ""; }
  get classList() { return { add: c => { this.className += " " + c; }, contains: c => this.className.split(/\s+/).includes(c) }; }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this.direct + this.children.map(e => e.textContent).join(" "); }
  set textContent(v) { this.direct = String(v); this.children = []; }
  appendChild(e) { this.children.push(e); return e; }
  append(...entries) { entries.forEach(e => this.appendChild(e)); }
  removeChild(e) { this.children = this.children.filter(c => c !== e); }
  replaceChildren(...entries) { this.children = entries; this.direct = ""; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  click() { this.listeners.click?.({}); }
  focus() { document.activeElement = this; }
  contains(e) { return this === e || this.children.some(c => c.contains(e)); }
  querySelectorAll(tag) { return this.children.flatMap(c => [...(c.tagName === tag ? [c] : []), ...c.querySelectorAll(tag)]); }
}
async function withDom(run) {
  const prior = { document: globalThis.document, Option: globalThis.Option };
  const root = new Element(); root.id = "runtime-global-sessions";
  const find = (node, id) => node.id === id ? node : node.children.map(c => find(c, id)).find(Boolean);
  globalThis.document = { createElement: tag => new Element(tag), getElementById: id => find(root, id), activeElement: null };
  globalThis.Option = class extends Element { constructor(text, value) { super("option"); this.textContent = text; this.value = value; } };
  try { await run(root); } finally { Object.assign(globalThis, prior); }
}

test("real /windows shape loads without a Project, selects first Window and renders linked Session controls", async () => withDom(async () => {
  const h = harness(); await load(h);
  assert.deepEqual(h.calls[0].payload, { limit: 2000 });
  assert.equal(h.controller.snapshot.selectedKey, windowA);
  assert.deepEqual(h.calls[1].payload, { client_window_key: windowA, activity_limit: 2000, session_limit: 100 });
  const rows = new Element(), links = new Element(), selected = [], sessions = [];
  renderWindowCards(rows, h.controller.snapshot.rows, windowA, key => selected.push(key), 4000, "en");
  assert.equal(rows.children.length, 2); assert.equal(rows.children[0].dataset.windowKey, windowA);
  assert.match(rows.textContent, /openai-session/); assert.match(rows.textContent, /Last seen/);
  rows.children[0].click(); assert.deepEqual(selected, [windowA]);
  renderWindowLinkedSessions(links, h.controller.snapshot.detail.linked_sessions, row => sessions.push(row), "en");
  assert.match(links.textContent, /Realistic workflow/); links.children[0].click();
  assert.equal(sessions[0].workflow_session_id, session.session_id);
}));

test("refresh retains the selected Window and successful detail, and transient failure is stale rather than zero", async () => {
  const h = harness(); await load(h);
  const selecting = h.controller.select(windowB); h.calls.at(-1).resolve(ok(detail(windowB))); await selecting;
  const refresh = h.controller.refresh(); h.calls.at(-1).resolve(ok(listing())); await tick();
  assert.equal(h.controller.snapshot.detail.client_window_key, windowB);
  h.calls.at(-1).resolve(ok(detail(windowB, "refreshed"))); await refresh;
  const failedRefresh = h.controller.refresh(); h.calls.at(-1).resolve(failed(503)); await failedRefresh;
  assert.equal(h.controller.snapshot.availability, "stale"); assert.equal(h.controller.snapshot.rows.length, 2);
  assert.equal(h.controller.snapshot.detail.marker, "refreshed");
});

test("malformed successful inventory is stale, never a confirmed zero that erases real Window evidence", async () => {
  const h = harness(); await load(h);
  const refresh = h.controller.refresh(); h.calls.at(-1).resolve(ok({ total: 0 })); await refresh;
  assert.equal(h.controller.snapshot.availability, "stale");
  assert.equal(h.controller.snapshot.rows.length, 2); assert.equal(h.controller.snapshot.selectedKey, windowA);
  const global = h.controller.refreshGlobal(); h.calls.at(-1).resolve(ok({ windows: null })); await global;
  assert.equal(h.controller.snapshot.globalAvailability, "stale");
  assert.equal(h.controller.snapshot.globalRows.length, 2);
});

test("same-key aborted detail success cannot overwrite a newer response", async () => {
  const h = harness(); await load(h);
  const older = h.controller.refreshDetail(), oldRequest = h.calls.at(-1);
  const newer = h.controller.refreshDetail(), newRequest = h.calls.at(-1);
  assert.equal(oldRequest.signal.aborted, true);
  newRequest.resolve(ok(detail(windowA, "new"))); await newer;
  oldRequest.resolve(ok(detail(windowA, "old"))); await older;
  assert.equal(h.controller.snapshot.detail.marker, "new");
});

test("superseded list and global refresh cannot replace newer Window inventory", async () => {
  const h = harness();
  const old = h.controller.refresh(false), oldRequest = h.calls.at(-1);
  const next = h.controller.refresh(false); h.calls.at(-1).resolve(ok(listing([windowB]))); await next;
  oldRequest.resolve(ok(listing([windowA]))); await old;
  assert.equal(h.controller.snapshot.selectedKey, windowB);
  const global = h.controller.refreshGlobal(), oldGlobal = h.calls.at(-1);
  const list = h.controller.refresh(false); h.calls.at(-1).resolve(ok(listing([windowA]))); await list;
  oldGlobal.resolve(ok(listing([windowB]))); await global;
  assert.equal(h.controller.snapshot.globalRows[0].client_window_key, windowA);
});

test("Project filtering is explicit, cancels previous detail, and cannot replay an out-of-scope response", async () => {
  const h = harness(); await load(h);
  const old = h.controller.refreshDetail(), request = h.calls.at(-1);
  const filter = h.controller.filter("agent:runner:other");
  assert.equal(h.calls.at(-1).payload.project, "agent:runner:other");
  assert.equal(h.controller.snapshot.detail, null);
  h.calls.at(-1).resolve(ok(listing([]))); await filter;
  request.resolve(ok(detail(windowA))); await old;
  assert.equal(h.controller.snapshot.rows.length, 0); assert.equal(h.controller.snapshot.detail, null);
  assert.equal(h.controller.snapshot.globalRows.length, 2, "filter does not erase Home's global inventory");
});

test("opening a global Window after Project filtering restores the complete global inventory state", async () => {
  const h = harness(); await load(h);
  const filter = h.controller.filter("agent:runner:other");
  h.calls.at(-1).resolve(ok(listing([], { total: 0, truncated: false }))); await filter;
  assert.equal(h.controller.snapshot.total, 0);
  const opening = h.controller.open(windowB);
  assert.equal(h.controller.snapshot.project, "");
  assert.equal(h.controller.snapshot.rows.length, 2);
  assert.equal(h.controller.snapshot.total, 2);
  assert.equal(h.controller.snapshot.truncated, false);
  assert.equal(h.controller.snapshot.availability, "available");
  h.calls.at(-1).resolve(ok(detail(windowB))); await opening;
  assert.equal(h.controller.snapshot.selectedKey, windowB);
});

test("revoked runtime:read clears all cached Window evidence and fences pending success without retrying other principals", async () => {
  const h = harness(); await load(h);
  const pending = h.controller.refreshDetail(), request = h.calls.at(-1);
  const denied = h.controller.refreshGlobal(); h.calls.at(-1).resolve(failed(403)); await denied;
  request.resolve(ok(detail(windowA))); await pending;
  assert.equal(h.controller.snapshot.availability, "unavailable");
  assert.equal(h.controller.snapshot.globalRows.length, 0); assert.equal(h.controller.snapshot.rows.length, 0);
  assert.equal(h.controller.snapshot.detail, null);
  const count = h.calls.length; assert.equal(h.rejected(), 0); await tick(); assert.equal(h.calls.length, count);
});

test("401 tears down the credential context; 404 removes stale detail while a bounded list does not imply revocation", async () => {
  const h = harness(); await load(h, [windowA]);
  assert.equal(preferredWindowKey([summary(windowB)], windowA, true), windowA);
  assert.equal(preferredWindowKey([summary(windowB)], windowA, false), windowB);
  const missing = h.controller.refreshDetail(); h.calls.at(-1).resolve(failed(404)); await missing;
  assert.equal(h.controller.snapshot.detail, null); assert.equal(h.controller.snapshot.rows.length, 0);
  const rejected = h.controller.refresh(); h.calls.at(-1).resolve(failed(401)); await rejected;
  assert.equal(h.rejected(), 1); assert.equal(h.controller.snapshot.selectedKey, "");
});

test("runtime Session inventory deduplicates, filters Runner/Project/query and restores exact selection without opening Projects", () => {
  const other = { ...session, project_id: "agent:other:two", client_id: "other", session_id: "wc_sess_bbbbbbbbbbbbbbbb", running_call: false, running_jobs: 0, updated_at: 500 };
  const rows = runtimeSessionInventory([other, session], [{ ...session, updated_at: 200 }]);
  assert.equal(rows.length, 2); assert.equal(rows[0].updated_at, 200, "actual running work sorts first");
  const noFilter = { runner: "", project: "", query: "" };
  assert.equal(preferredRuntimeSession(rows, "", noFilter).session_id, session.session_id);
  assert.equal(preferredRuntimeSession(rows, runtimeSessionIdentity(other), noFilter), other);
  assert.deepEqual(filterRuntimeSessions(rows, { ...noFilter, runner: "other" }), [other]);
  assert.equal(filterRuntimeSessions(rows, { ...noFilter, project, query: "REALISTIC" }).length, 1);
  assert.equal(preferredRuntimeSession(rows, runtimeSessionIdentity(other), { ...noFilter, project }).session_id, session.session_id);
});

test("Session rows show progress and attention safely, do not manufacture missing counters, and switch exact identity", async () => withDom(async () => {
  const clicks = [], row = createRuntimeSessionRow({ ...session, title: "<script>bad()</script>" }, "", "zh-CN", value => clicks.push(value));
  assert.match(row.textContent, /待办 2/); assert.match(row.textContent, /问题 1/); assert.match(row.textContent, /运行中的作业 1/);
  assert.equal(row.querySelectorAll("script").length, 0); row.click(); assert.equal(clicks[0].session_id, session.session_id);
  const unknown = createRuntimeSessionRow({ ...session, running_jobs: undefined, overview: {} }, "", "en", () => {});
  assert.match(unknown.textContent, /Running Jobs —/); assert.doesNotMatch(unknown.textContent, /Todos 0/);
}));

test("exact Session id lookup supplements bounded runtime inventory without requiring a Project filter", async () => withDom(async root => {
  let rows = []; const locatorCalls = [];
  const context = () => ({ language: "en", rows, projects: [{ id: project, client_id: "runner", name: "Project" }], runners: [{ client_id: "runner" }], selected: "", available: true, loading: false, stale: false, truncated: true });
  const nav = new RuntimeSessionNavigation({
    context, select() {}, unauthorized() {},
    projectSessions: async () => ok({ sessions: [], truncated: false }),
    locateSession: (sessionId, signal) => new Promise(resolve => locatorCalls.push({ sessionId, signal, resolve })),
  });
  nav.render();
  assert.equal(isExactRuntimeSessionId(session.session_id), true);
  const search = document.getElementById("runtime-global-session-query");
  search.value = session.session_id; search.listeners.input?.({}); await tick();
  assert.equal(locatorCalls.length, 1); assert.equal(locatorCalls[0].sessionId, session.session_id);
  locatorCalls[0].resolve(ok({ ...session, activity: [], activity_total: 0, activity_returned: 0, activity_truncated: false })); await tick();
  assert.match(root.textContent, /Realistic workflow/); assert.doesNotMatch(root.textContent, /inventory is incomplete/);

  rows = [session];
  const transient = nav.refreshLocator(); await tick();
  assert.equal(locatorCalls.length, 2); locatorCalls.at(-1).resolve(failed(503)); await transient;
  assert.match(root.textContent, /Realistic workflow/); assert.match(root.textContent, /lookup failed/);

  const revalidate = nav.refreshLocator(); await tick();
  assert.equal(locatorCalls.length, 3); assert.equal(locatorCalls.at(-1).sessionId, session.session_id);
  locatorCalls.at(-1).resolve(failed(404)); await revalidate;
  assert.doesNotMatch(root.textContent, /Realistic workflow/); assert.match(root.textContent, /No matching Sessions/);

  const missing = "wc_sess_bbbbbbbbbbbbbbbb";
  search.value = missing; search.listeners.input?.({}); await tick();
  assert.equal(locatorCalls.at(-1).sessionId, missing);
  locatorCalls.at(-1).resolve(failed(404)); await tick();
  assert.doesNotMatch(root.textContent, /Realistic workflow/); assert.match(root.textContent, /No matching Sessions/);
}));

test("Session list preserves semantic buttons across polling and Project filters load authorized inventory independently", async () => withDom(async root => {
  let rows = [session]; const calls = [];
  const context = () => ({ language: "en", rows, projects: [{ id: project, client_id: "runner", name: "Project" }], runners: [{ client_id: "runner" }], selected: runtimeSessionIdentity(session), available: true, loading: false, stale: false, truncated: false });
  const nav = new RuntimeSessionNavigation({ context, select() {}, unauthorized() {}, projectSessions: (project, signal) => new Promise(resolve => calls.push({ project, signal, resolve })) });
  nav.render(); const button = root.querySelectorAll("button")[0]; button.focus();
  rows = [{ ...session, updated_at: 900, running_jobs: 2 }]; nav.render();
  assert.equal(root.querySelectorAll("button")[0], button); assert.equal(document.activeElement, button);
  assert.match(button.textContent, /Running Jobs 2/);
  nav.filters.project = project; nav.render(); assert.equal(calls[0].project, project);
  calls[0].resolve(ok({ sessions: [{ ...session, title: "Project-only recent Session" }], truncated: false })); await tick();
  assert.match(root.textContent, /Project-only recent Session/);
  const malformed = nav.refreshProject(); calls.at(-1).resolve(ok({})); await malformed;
  assert.match(root.textContent, /Refresh failed/); assert.match(root.textContent, /Project-only recent Session/);
  const refresh = nav.refreshProject(); calls.at(-1).resolve(failed(403)); await refresh;
  assert.match(root.textContent, /Check access to this Project/); assert.doesNotMatch(root.textContent, /Project-only recent Session/);
  assert.doesNotMatch(root.textContent, /No matching Sessions/);
}));
