import { translate } from "./runtime_i18n.js";
import { createProductProjectRow, productNode, productButton, productDialog, productName, productTime, productTitle, productActivity } from "./runtime_product_view.js";
// UI state only. Project registration, authorization and Git remain canonical API operations.
export class ProductWorkspace {
    constructor(services) {
        this.services = services;
        this.generation = 0;
        this.requests = new Set();
        this.gitCache = new Map();
        this.gitPending = new Map();
        this.gitRunning = 0;
        this.gitQueue = [];
        this.dialogs = new Set();
        this.query = "";
        this.runner = "";
        this.projectLanguage = "";
        this.projectSignature = "";
        this.runnerSignature = "";
        this.activitySignature = "";
        this.projectList = null;
    }
    reset() {
        this.generation++;
        for (const request of this.requests)
            request.abort();
        this.requests.clear();
        this.gitCache.clear();
        this.gitPending.clear();
        for (const dialog of this.dialogs)
            dialog.close();
        this.dialogs.clear();
        this.query = "";
        this.runner = "";
        this.projectLanguage = "";
        this.projectSignature = "";
        this.projectList = null;
        this.runnerSignature = "";
        this.activitySignature = "";
        document.getElementById("runtime-projects-content")?.replaceChildren();
        document.getElementById("runtime-activity-content")?.replaceChildren();
    }
    invalidateGit() { this.gitCache.clear(); }
    async git(project) {
        const cached = this.gitCache.get(project);
        if (cached && Date.now() - cached.at < 30000)
            return cached.value;
        const pending = this.gitPending.get(project);
        if (pending)
            return pending;
        const generation = this.generation;
        const task = (async () => {
            if (this.gitRunning >= 3)
                await new Promise(resolve => this.gitQueue.push(resolve));
            this.gitRunning++;
            const request = new AbortController();
            this.requests.add(request);
            try {
                if (generation !== this.generation)
                    return null;
                const result = await this.services.post("project-git", { project }, request.signal);
                if (generation !== this.generation || request.signal.aborted)
                    return null;
                if (result?.status === 401) {
                    this.services.unauthorized();
                    return null;
                }
                const value = result?.ok ? result.data : null;
                this.gitCache.set(project, { value, at: Date.now() });
                return value;
            }
            finally {
                this.requests.delete(request);
                this.gitRunning--;
                this.gitQueue.shift()?.();
                if (generation === this.generation)
                    this.gitPending.delete(project);
            }
        })();
        this.gitPending.set(project, task);
        return task;
    }
    attachGit(project, target) {
        const generation = this.generation;
        const language = this.services.context().language;
        void this.git(project).then(value => {
            if (generation !== this.generation || !target.isConnected)
                return;
            target.textContent = value?.branch || translate(value?.non_git_project ? "No Git repository" : "Not checked", language);
            target.title = value?.branch || translate("Git branch", language);
        });
    }
    renderProjects() {
        const root = document.getElementById("runtime-projects-content");
        if (!root)
            return;
        const context = this.services.context();
        const tr = (text) => translate(text, context.language);
        if (!this.projectList || !root.contains(this.projectList) || this.projectLanguage !== context.language) {
            root.replaceChildren();
            this.projectLanguage = context.language;
            this.projectSignature = "";
            const heading = productNode("header", "", "product-page-heading");
            heading.appendChild(productNode("h2", tr("Projects")));
            const add = productButton(tr("Add Project"), () => this.addProject(), "btn primary");
            add.dataset.action = "add-project";
            heading.appendChild(add);
            root.appendChild(heading);
            const filters = productNode("div", "", "product-filters");
            const runnerLabel = productNode("label", tr("Runner"));
            runnerLabel.htmlFor = "product-project-runner";
            const select = productNode("select");
            select.id = "product-project-runner";
            select.setAttribute("aria-label", tr("Runner"));
            select.appendChild(new Option(tr("All Runners"), ""));
            for (const runner of context.runners)
                select.appendChild(new Option(runner.client_id, runner.client_id));
            select.value = this.runner;
            select.addEventListener("change", () => { this.runner = select.value; this.renderProjects(); });
            const searchLabel = productNode("label", tr("Search projects"));
            searchLabel.htmlFor = "product-project-query";
            const search = productNode("input");
            search.type = "search";
            search.id = "product-project-query";
            search.maxLength = 200;
            search.value = this.query;
            search.addEventListener("input", () => { this.query = search.value; this.renderProjects(); });
            filters.append(runnerLabel, select, searchLabel, search);
            root.appendChild(filters);
            this.projectList = productNode("div", "", "product-project-list");
            root.appendChild(this.projectList);
        }
        const runnersSignature = JSON.stringify([context.language, context.runners.map(row => row.client_id)]);
        if (runnersSignature !== this.runnerSignature) {
            this.runnerSignature = runnersSignature;
            const select = document.getElementById("product-project-runner");
            if (select) {
                select.replaceChildren(new Option(tr("All Runners"), ""));
                for (const row of context.runners)
                    select.appendChild(new Option(row.client_id, row.client_id));
                if (!context.runners.some(row => row.client_id === this.runner))
                    this.runner = "";
                select.value = this.runner;
            }
        }
        const signature = JSON.stringify([context.projects, context.selectedProject, context.available, this.query, this.runner]);
        if (signature === this.projectSignature)
            return;
        this.projectSignature = signature;
        const activeName = this.projectList.contains(document.activeElement) ? document.activeElement?.getAttribute("aria-label") : null;
        this.projectList.replaceChildren();
        const query = this.query.trim().toLocaleLowerCase();
        const rows = context.projects.filter(project => {
            if (this.runner && this.runner !== project.client_id)
                return false;
            const searchable = [project.id, project.project_ref, project.name, productName(project), project.path, project.client_id]
                .filter(Boolean).map(String).join(" ").toLocaleLowerCase();
            return searchable.includes(query);
        }).sort((a, b) => a.client_id.localeCompare(b.client_id) || (b.sessions?.latest_updated_at || 0) - (a.sessions?.latest_updated_at || 0));
        let lastRunner = "";
        for (const project of rows) {
            if (context.runners.length > 1 && project.client_id !== lastRunner) {
                this.projectList.appendChild(productNode("p", tr("Runner") + " · " + project.client_id, "product-runner-label"));
                lastRunner = project.client_id;
            }
            this.projectList.appendChild(createProductProjectRow(project, { language: context.language, selected: context.selectedProject, onOpen: this.services.onProject, git: (project, target) => this.attachGit(project, target) }));
        }
        if (!rows.length)
            this.projectList.appendChild(productNode("p", tr(!context.available ? "Projects unavailable. Refresh to try again." : this.query || this.runner ? "No matching projects" : "No projects yet"), "product-empty"));
        if (activeName)
            Array.from(this.projectList.querySelectorAll("button")).find(value => value.getAttribute("aria-label") === activeName)?.focus();
    }
    addProject() {
        const context = this.services.context();
        const tr = (text) => translate(text, context.language);
        const generation = this.generation;
        const popup = productDialog(tr("Add Project"), context.language);
        this.dialogs.add(popup);
        const form = productNode("form");
        const request = new AbortController();
        const runnerLabel = productNode("label", tr("Runner"));
        runnerLabel.htmlFor = "product-add-runner";
        const runner = productNode("select");
        runner.id = "product-add-runner";
        runner.required = true;
        for (const row of context.runners)
            runner.appendChild(new Option(row.client_id, row.client_id));
        if (this.runner)
            runner.value = this.runner;
        const pathLabel = productNode("label", tr("Project folder"));
        pathLabel.htmlFor = "product-add-path";
        const path = productNode("input");
        path.id = "product-add-path";
        path.required = true;
        path.maxLength = 4096;
        path.autocomplete = "off";
        path.spellcheck = false;
        path.title = tr("Project folder");
        path.placeholder = tr("Absolute folder path on the selected Runner");
        const message = productNode("p", "", "product-form-message");
        message.setAttribute("role", "status");
        const submit = productNode("button", tr("Add Project"), "btn primary");
        submit.type = "submit";
        submit.disabled = !context.runners.length;
        form.append(runnerLabel, runner, pathLabel, path, message, submit);
        popup.body.appendChild(form);
        let pending = false;
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (pending || !path.value.trim() || !runner.value || generation !== this.generation)
                return;
            pending = true;
            submit.disabled = true;
            runner.disabled = true;
            path.disabled = true;
            this.requests.add(request);
            message.textContent = tr("Adding project…");
            try {
                const result = await this.services.registerProject({ client_id: runner.value, path: path.value.trim() }, request.signal);
                if (generation !== this.generation || request.signal.aborted || !popup.dialog.isConnected)
                    return;
                if (result?.status === 401) {
                    this.services.unauthorized();
                    return;
                }
                if (result?.ok && result.data?.success === true) {
                    popup.close();
                    this.dialogs.delete(popup);
                    this.services.refresh();
                    return;
                }
                message.textContent = tr(result?.status === 0 || result === null ? "The result could not be confirmed. Refresh Projects before trying again." : "Project could not be added. Check the folder and Runner access.");
                message.setAttribute("role", "alert");
                // No automatic write replay, including after transport failure.
            }
            finally {
                this.requests.delete(request);
                pending = false;
                if (generation === this.generation && popup.dialog.isConnected) {
                    submit.disabled = false;
                    runner.disabled = false;
                    path.disabled = false;
                }
            }
        });
        path.focus();
    }
    renderActivity() {
        const root = document.getElementById("runtime-activity-content");
        if (!root)
            return;
        const context = this.services.context();
        const tr = (text) => translate(text, context.language);
        const signature = JSON.stringify([context.language, context.sessions, context.windows, context.available, context.runners]);
        if (signature === this.activitySignature)
            return;
        this.activitySignature = signature;
        const focusedKey = root.contains(document.activeElement) ? document.activeElement.dataset.activityKey : null;
        root.replaceChildren();
        const heading = productNode("header", "", "product-page-heading");
        heading.appendChild(productNode("h2", tr("Activity")));
        root.appendChild(heading);
        const rows = context.sessions.map(session => ({ at: Number(session.updated_at) * 1000, kind: "session", value: session })).concat(context.windows.map(window => ({ at: window.last_meaningful_activity_at_ms || window.last_seen_at_ms, kind: "window", value: window })))
            .sort((a, b) => b.at - a.at).slice(0, 40);
        for (const row of rows) {
            const entry = productButton("", () => row.kind === "session" ? this.services.onSession(row.value) : this.services.onWindow(row.value.client_window_key), "product-activity-entry");
            entry.dataset.activityKey = row.kind + ":" + (row.value.session_id || row.value.client_window_key);
            const body = productNode("div");
            body.appendChild(productNode("strong", row.kind === "session" ? productTitle(row.value.title) : tr("Window Activity") + " · " + String(row.value.client_window_key).slice(-12)));
            body.appendChild(productNode("span", row.kind === "session" ? productActivity(row.value.current_activity || row.value.last_activity, context.language) : productName(context.projects.find(project => project.id === row.value.last_project) || {}), "muted"));
            const projectId = row.kind === "session" ? row.value.project_id : row.value.last_project;
            const project = context.projects.find(project => project.id === projectId);
            body.appendChild(productNode("span", tr(row.kind === "session" ? "Workflow Session" : "Window Activity") + " · " + productName(project || { id: projectId }) + " · " + (row.value.client_id || project?.client_id || "—"), "muted small"));
            entry.setAttribute("aria-label", body.textContent || tr("Activity"));
            entry.append(body, productNode("time", productTime(row.at, context.language)));
            root.appendChild(entry);
        }
        if (focusedKey)
            Array.from(root.querySelectorAll("button")).find(button => button.dataset.activityKey === focusedKey)?.focus({ preventScroll: true });
        if (!rows.length)
            root.appendChild(productNode("p", tr(context.available ? "No activity observed yet" : "Activity unavailable. Refresh to try again."), "product-empty"));
    }
}
