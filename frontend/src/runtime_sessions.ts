import { productNode, productButton, productName, productTime } from "./runtime_product_view.js";
import { translate, type RuntimeLanguage } from "./runtime_i18n.js";
import { formatLivenessPresentation } from "./runtime_activity.js";
import type { RuntimeApiResponse } from "./runtime_api.js";

export interface RuntimeSessionFilters { runner: string; project: string; query: string }
export function isExactRuntimeSessionId(value: string): boolean {
  return /^wc_sess_(?:[A-Za-z0-9_-]{16}|[0-9a-f]{32})$/.test(value.trim());
}
export function runtimeSessionIsWorking(row: any): boolean { return row.running_call === true || Number(row.running_jobs) > 0; }
export function runtimeSessionIdentity(row: any): string { return String(row.project_id || "") + ":" + String(row.session_id || ""); }
export function runtimeSessionInventory(recent: any[], projectRows: any[] = []): any[] {
  const rows = new Map<string, any>();
  for (const row of [...recent, ...projectRows]) {
    if (!row.session_id || !row.project_id || !row.client_id) continue;
    const key = runtimeSessionIdentity(row); const previous = rows.get(key);
    if (!previous || Number(row.updated_at || 0) >= Number(previous.updated_at || 0)) rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => Number(runtimeSessionIsWorking(b)) - Number(runtimeSessionIsWorking(a)) || Number(b.updated_at || 0) - Number(a.updated_at || 0));
}
export function filterRuntimeSessions(rows: any[], filter: RuntimeSessionFilters): any[] {
  const query = filter.query.trim().toLocaleLowerCase();
  return rows.filter(row => (!filter.runner || row.client_id === filter.runner) && (!filter.project || row.project_id === filter.project)
    && `${row.title || ""} ${row.project_name || ""} ${row.project_id} ${row.client_id} ${row.session_id}`.toLocaleLowerCase().includes(query));
}
export function preferredRuntimeSession(rows: any[], remembered: string, filter: RuntimeSessionFilters): any | null {
  const visible = filterRuntimeSessions(rows, filter);
  return visible.find(row => runtimeSessionIdentity(row) === remembered) || visible[0] || null;
}

export function createRuntimeSessionRow(row: any, selected: string, language: RuntimeLanguage, onSelect: (row: any) => void): HTMLButtonElement {
  const tr = (source: string) => translate(source, language);
  const title = String(row.title || tr("Untitled Session"));
  const button = productButton(tr("Open Session") + " " + title, () => onSelect(row), "runtime-session-row");
  button.textContent = ""; button.dataset.action = "open-runtime-session";
  button.dataset.sessionId = String(row.session_id); button.dataset.projectId = String(row.project_id);
  if (runtimeSessionIdentity(row) === selected) { button.classList.add("selected"); button.setAttribute("aria-current", "true"); }
  const name = productNode("strong", title); name.title = title; button.appendChild(name);
  button.appendChild(productNode("span", row.project_name || productName({ id: row.project_id }), "runtime-session-project"));
  const runner = productNode("span", tr("Runner") + " · " + String(row.client_id), "muted small runtime-session-runner"); runner.title = String(row.client_id); button.appendChild(runner);
  const liveness = formatLivenessPresentation(row, language);
  const status = productNode("span", String(liveness.label || tr(row.lifecycle === "closed" ? "Closed" : "Active")) + " · " + productTime(Number(row.updated_at) * 1000, language), "muted small");
  button.appendChild(status);
  const jobs = typeof row.running_jobs === "number" ? String(row.running_jobs) + (row.running_jobs_complete === false ? "+" : "") : "—";
  const attention = row.overview?.attention;
  const facts = [tr("Running Jobs") + " " + jobs];
  for (const [key, label] of [["open_todos", "Todos"], ["open_questions", "Questions"], ["open_risks", "Risks"]]) {
    if (typeof attention?.[key] === "number") facts.push(tr(label) + " " + attention[key]);
  }
  button.appendChild(productNode("span", facts.join(" · "), "muted small runtime-session-facts"));
  return button;
}

export class RuntimeSessionNavigation {
  readonly filters: RuntimeSessionFilters = { runner: "", project: "", query: "" };
  private root: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private signature = "";
  private language: RuntimeLanguage | null = null;
  private optionsSignature = "";
  private projectRequest: AbortController | null = null;
  private locatorRequest: AbortController | null = null;
  private locatedRow: any | null = null;
  private locatedSessionId = "";
  private locatorState: "idle" | "loading" | "available" | "not_found" | "stale" = "idle";
  private scopedProject = "";
  private scopedRows: any[] = [];
  private scopedState: "loading" | "available" | "stale" | "unavailable" = "loading";
  private scopedTruncated = false;
  private rowButtons = new Map<string, HTMLButtonElement>();
  constructor(private readonly services: {
    context: () => { language: RuntimeLanguage; rows: any[]; projects: any[]; runners: any[]; selected: string; available: boolean; stale: boolean; loading: boolean; truncated: boolean };
    select: (row: any) => void;
    projectSessions: (project: string, signal: AbortSignal) => Promise<RuntimeApiResponse>;
    locateSession?: (sessionId: string, signal: AbortSignal) => Promise<RuntimeApiResponse>;
    unauthorized: () => void;
  }) {}
  reset(): void {
    this.projectRequest?.abort(); this.projectRequest = null;
    this.locatorRequest?.abort(); this.locatorRequest = null;
    this.locatedRow = null; this.locatedSessionId = ""; this.locatorState = "idle";
    this.scopedProject = ""; this.scopedRows = []; this.scopedState = "loading"; this.rowButtons.clear();
    this.root?.replaceChildren(); this.root = this.list = null; this.signature = this.optionsSignature = ""; this.language = null;
    Object.assign(this.filters, { runner: "", project: "", query: "" });
  }
  async refreshLocator(): Promise<void> {
    const sessionId = this.filters.query.trim();
    this.locatorRequest?.abort(); this.locatorRequest = null;
    if (!this.services.locateSession || !isExactRuntimeSessionId(sessionId) || this.filters.project) {
      this.locatedRow = null; this.locatedSessionId = ""; this.locatorState = "idle"; this.render(); return;
    }
    const sameLocatedSession = this.locatedSessionId === sessionId;
    if (!sameLocatedSession) this.locatedRow = null;
    this.locatedSessionId = sessionId; this.locatorState = "loading";
    const request = new AbortController(); this.locatorRequest = request; this.render();
    const response = await this.services.locateSession(sessionId, request.signal);
    if (request !== this.locatorRequest || request.signal.aborted || sessionId !== this.filters.query.trim()) return;
    this.locatorRequest = null;
    if (response?.status === 401) { this.services.unauthorized(); return; }
    if (response?.status === 403 || response?.status === 404) { this.locatedRow = null; this.locatorState = "not_found"; }
    else if (!response?.ok || response.data?.session_id !== sessionId || !response.data?.project_id || !response.data?.client_id) {
      if (!sameLocatedSession) this.locatedRow = null;
      this.locatorState = "stale";
    } else {
      this.locatedRow = response.data; this.locatorState = "available";
    }
    this.render();
  }
  async refreshProject(): Promise<void> {
    const project = this.filters.project;
    this.projectRequest?.abort(); this.projectRequest = null;
    if (project !== this.scopedProject) { this.scopedRows = []; this.scopedState = "loading"; }
    this.scopedProject = project;
    if (!project) { this.render(); return; }
    const request = new AbortController(); this.projectRequest = request;
    this.render();
    const response = await this.services.projectSessions(project, request.signal);
    if (request !== this.projectRequest || request.signal.aborted || project !== this.filters.project) return;
    this.projectRequest = null;
    if (response?.status === 401) { this.services.unauthorized(); return; }
    if (response?.status === 403 || response?.status === 404) { this.scopedRows = []; this.scopedState = "unavailable"; }
    else if (!response?.ok || !Array.isArray(response.data?.sessions)) this.scopedState = "stale";
    else {
      const projectRow = this.services.context().projects.find(row => row.id === project);
      this.scopedRows = (Array.isArray(response.data.sessions) ? response.data.sessions : []).map((row: any) => ({ ...row, project_id: project, project_name: projectRow?.name || productName(projectRow || { id: project }), client_id: projectRow?.client_id }));
      this.scopedState = "available"; this.scopedTruncated = !!response.data.truncated;
    }
    this.render();
  }
  render(): void {
    const root = document.getElementById("runtime-global-sessions"); if (!root) return;
    const context = { ...this.services.context() }; const tr = (text: string) => translate(text, context.language);
    if (this.filters.project !== this.scopedProject) { void this.refreshProject(); return; }
    if (this.scopedProject) {
      context.rows = runtimeSessionInventory(this.scopedRows);
      context.loading = this.scopedState === "loading";
      context.available = this.scopedState !== "unavailable";
      context.stale = this.scopedState === "stale";
      context.truncated = this.scopedTruncated;
    } else if (this.locatedRow) {
      context.rows = runtimeSessionInventory(context.rows, [this.locatedRow]);
      context.loading = false; context.available = true;
      if (this.locatorState === "available" && isExactRuntimeSessionId(this.filters.query)) context.truncated = false;
    } else if ((this.locatorState === "not_found") && isExactRuntimeSessionId(this.filters.query)) {
      const exactSessionId = this.filters.query.trim();
      context.rows = context.rows.filter(row => String(row.session_id || "") !== exactSessionId);
      context.loading = false; context.available = true; context.truncated = false;
    }
    if (this.root !== root || this.language !== context.language || !this.list) {
      this.root = root; this.language = context.language; this.signature = this.optionsSignature = ""; root.replaceChildren();
      const heading = productNode("h2", tr("Workflow Sessions")); root.appendChild(heading);
      const filters = productNode("div", "", "runtime-session-filters");
      const addSelect = (id: string, label: string, key: "runner" | "project") => {
        const field = productNode("label", tr(label)); field.htmlFor = id;
        const select = productNode("select"); select.id = id; select.setAttribute("aria-label", tr(label));
        select.addEventListener("change", () => { this.filters[key] = select.value; if (key === "runner") this.filters.project = ""; this.render(); void this.refreshLocator(); });
        field.appendChild(select); filters.appendChild(field);
      };
      addSelect("runtime-session-runner-filter", "Filter Sessions by Runner", "runner");
      addSelect("runtime-session-project-filter", "Filter Sessions by Project", "project");
      const label = productNode("label", tr("Search Sessions")); label.htmlFor = "runtime-global-session-query";
      const search = productNode("input"); search.id = "runtime-global-session-query"; search.type = "search"; search.maxLength = 200; search.value = this.filters.query;
      search.addEventListener("input", () => { this.filters.query = search.value; this.render(); void this.refreshLocator(); }); label.appendChild(search); filters.appendChild(label); root.appendChild(filters);
      const status = productNode("p", "", "muted small"); status.id = "runtime-global-session-status"; status.setAttribute("role", "status"); root.appendChild(status);
      this.list = productNode("div", "", "runtime-session-inventory"); this.list.setAttribute("aria-label", tr("Workflow Sessions")); root.appendChild(this.list);
    }
    const optionsSignature = JSON.stringify([context.projects.map(row => [row.id, row.name]), context.runners.map(row => row.client_id), this.filters.runner, this.filters.project]);
    if (optionsSignature !== this.optionsSignature) {
      this.optionsSignature = optionsSignature;
      const runner = document.getElementById("runtime-session-runner-filter") as HTMLSelectElement;
      const project = document.getElementById("runtime-session-project-filter") as HTMLSelectElement;
      runner.replaceChildren(new Option(tr("All Runners"), ""));
      for (const row of context.runners) runner.appendChild(new Option(row.client_id, row.client_id)); runner.value = this.filters.runner;
      project.replaceChildren(new Option(tr("All Projects"), ""));
      for (const row of context.projects.filter(row => !this.filters.runner || row.client_id === this.filters.runner)) project.appendChild(new Option(productName(row), row.id)); project.value = this.filters.project;
    }
    const rows = filterRuntimeSessions(context.rows, this.filters);
    const status = document.getElementById("runtime-global-session-status");
    const exactLocator = !this.scopedProject && isExactRuntimeSessionId(this.filters.query);
    if (status) status.textContent = exactLocator && this.locatorState === "loading" && !rows.length ? tr("Locating Session…")
      : exactLocator && this.locatorState === "stale" ? tr("Exact Session lookup failed · showing previous data") + " · " + rows.length + " / " + context.rows.length
      : context.loading ? tr("Loading Sessions…") : !context.available ? tr(this.scopedProject ? "Session list unavailable. Check access to this Project." : "Runtime-wide Sessions require runtime:read. Open an authorized Project to inspect its Sessions.")
      : (context.stale ? tr("Refresh failed · showing previous data") + " · " : "") + rows.length + " / " + context.rows.length + (context.truncated ? " · " + tr("The Runtime inventory is incomplete; some retained Sessions may not be shown.") : "");
    const signature = JSON.stringify([context.language, rows, context.selected, context.available]);
    if (signature === this.signature) return; this.signature = signature;
    const focused = this.list!.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.sessionId : null;
    const entries: HTMLElement[] = [];
    const visibleKeys = new Set(rows.map(runtimeSessionIdentity));
    for (const key of this.rowButtons.keys()) if (!visibleKeys.has(key)) this.rowButtons.delete(key);
    for (const [working, title] of [[true, "Active Sessions"], [false, "Recent Sessions"]] as const) {
      const group = rows.filter(row => runtimeSessionIsWorking(row) === working);
      if (!group.length) continue;
      entries.push(productNode("h3", tr(title) + " · " + group.length, "runtime-session-group"));
      for (const row of group) {
        const fresh = createRuntimeSessionRow(row, context.selected, context.language, this.services.select);
        const key = runtimeSessionIdentity(row);
        const button = this.rowButtons.get(key) || fresh;
        if (button !== fresh) {
          button.replaceChildren(...Array.from(fresh.childNodes));
          button.className = fresh.className;
          for (const name of ["aria-label", "aria-current"]) {
            const value = fresh.getAttribute(name); if (value === null) button.removeAttribute(name); else button.setAttribute(name, value);
          }
        }
        this.rowButtons.set(key, button); entries.push(button);
      }
    }
    if (!rows.length && context.available && !context.loading && !context.stale) entries.push(productNode("p", tr(this.filters.query || this.filters.project || this.filters.runner ? "No matching Sessions" : "No active or recent Workflow Sessions."), "muted small"));
    this.list!.replaceChildren(...entries);
    if (focused) Array.from(this.list!.querySelectorAll<HTMLButtonElement>("button")).find(button => button.dataset.sessionId === focused)?.focus({ preventScroll: true });
  }
}
