import { translate, type RuntimeLanguage } from "./runtime_i18n.js";

export type ProductProject = {
  id: string; client_id: string; project_ref?: string; name?: string; path?: string; connected?: boolean;
  sessions?: { active_sessions?: number; latest_updated_at?: number; sessions_truncated?: boolean };
};
export type ProductGit = { branch?: string; non_git_project?: boolean; clean?: boolean; files?: { path: string; status?: string }[]; files_truncated?: boolean };
export function productNode<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
export function productButton(label: string, action: () => void, className = "btn secondary"): HTMLButtonElement {
  const node = productNode("button", label, className); node.type = "button"; node.setAttribute("aria-label", label); node.addEventListener("click", action); return node;
}
export function productName(project: Partial<ProductProject>): string {
  return project.name || project.path?.split(/[\\/]/).filter(Boolean).pop() || project.id || "—";
}
export function productTime(timestamp: unknown, language: RuntimeLanguage, now = Date.now()): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return translate("No activity observed yet", language);
  const seconds = Math.min(0, Math.round((timestamp - now) / 1000));
  const formatter = new Intl.RelativeTimeFormat(language === "zh-CN" ? "zh-CN" : "en", { numeric: "auto" });
  if (seconds > -60) return formatter.format(seconds, "second");
  if (seconds > -3600) return formatter.format(Math.round(seconds / 60), "minute");
  if (seconds > -86400) return formatter.format(Math.round(seconds / 3600), "hour");
  return formatter.format(Math.round(seconds / 86400), "day");
}
export function productTitle(value: unknown): string {
  const text = String(value || "").trim().split(/\r?\n/).find(Boolean) || "Untitled Session";
  return text.length > 110 ? text.slice(0, 109) + "…" : text;
}
export function productActivity(activity: any, language: RuntimeLanguage): string {
  if (!activity) return translate("No activity observed yet", language);
  if (typeof activity.summary === "string" && activity.summary && !/^execution (completed|running)/i.test(activity.summary)) return productTitle(activity.summary);
  const kind = String(activity.activity_kind || activity.kind || activity.tool_name || activity.tool || "");
  const label = /Explor|read|search|inspect/i.test(kind) ? "Reading project files"
    : /Edit|write|patch/i.test(kind) ? "Editing files" : /Validat|test|check|build/i.test(kind) ? "Running checks"
    : /Review|changes|diff/i.test(kind) ? "Reviewing changes" : /Running|job|process/i.test(kind) ? "Running tasks" : "Workspace activity";
  return translate(label, language);
}
export function createProductProjectRow(project: ProductProject, options: {
  language: RuntimeLanguage; selected?: string; onOpen: (runner: string, project: string) => void;
  git?: (project: string, node: HTMLElement) => void;
}): HTMLElement {
  const tr = (value: string) => translate(value, options.language);
  const selected = project.id === options.selected;
  const row = productNode("article", "", "product-project-row" + (selected ? " selected" : ""));
  row.setAttribute("aria-label", productName(project));
  row.appendChild(productNode("span", productName(project).slice(0, 2).toUpperCase(), "product-avatar"));
  const body = productNode("div", "", "product-project-main");
  const title = productNode("div", "", "product-project-title"); title.appendChild(productNode("h3", productName(project)));
  if (selected) title.appendChild(productNode("span", tr("Current"), "product-badge"));
  body.appendChild(title);
  const path = productNode("span", project.path || "—", "product-path"); path.title = project.path || ""; body.appendChild(path);
  const meta = productNode("div", "", "product-project-meta");
  const branch = productNode("span", "—"); branch.title = tr("Git branch"); meta.appendChild(branch);
  if (project.connected && options.git) options.git(project.id, branch);
  meta.appendChild(productNode("span", tr(project.connected ? "Connected" : "Runner unavailable")));
  meta.appendChild(productNode("span", tr("Runner") + " · " + project.client_id));
  meta.appendChild(productNode("span", project.sessions ? String(project.sessions.active_sessions ?? 0) + (project.sessions.sessions_truncated ? "+" : "") + " " + tr("active sessions") : tr("Not checked")));
  meta.appendChild(productNode("span", productTime(project.sessions?.latest_updated_at ? project.sessions.latest_updated_at * 1000 : null, options.language)));
  body.appendChild(meta); row.appendChild(body);
  const open = productButton(tr("Open"), () => options.onOpen(project.client_id, project.id)); open.setAttribute("aria-label", tr("Open Project") + " " + productName(project)); open.dataset.action = "open-project"; row.appendChild(open);
  return row;
}
export function productDialog(title: string, language: RuntimeLanguage): { dialog: HTMLDialogElement; body: HTMLElement; close: () => void } {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = productNode("dialog", "", "product-dialog"); dialog.setAttribute("aria-label", title);
  const close = () => { dialog.close(); dialog.remove(); if (previous?.isConnected) previous.focus(); };
  const header = productNode("header"); header.appendChild(productNode("h2", title)); header.appendChild(productButton(translate("Close", language), close)); dialog.appendChild(header);
  const body = productNode("div", "", "product-dialog-body"); dialog.appendChild(body);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  document.body.appendChild(dialog); dialog.showModal(); return { dialog, body, close };
}
