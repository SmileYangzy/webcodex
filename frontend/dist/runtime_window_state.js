export function initialWindowSnapshot() {
    return { rows: [], globalRows: [], total: 0, globalTotal: 0, truncated: false, globalTruncated: false,
        availability: "idle", globalAvailability: "idle", scope: "principal", project: "", selectedKey: "",
        detail: null, detailAvailability: "idle" };
}
export function preferredWindowKey(rows, selected, truncated = false) {
    if (selected && (truncated || rows.some(row => row.client_window_key === selected)))
        return selected;
    return String(rows[0]?.client_window_key || "");
}
// A response must still own its request slot even when an aborted transport
// resolves successfully. Window identity alone is not a same-key refresh fence.
export function ownsWindowResponse(current, request) {
    return current === request && !request.signal.aborted;
}
export class RuntimeWindowController {
    constructor(services) {
        this.services = services;
        this.snapshot = initialWindowSnapshot();
        this.listRequest = null;
        this.detailRequest = null;
        this.globalRequest = null;
        this.globalRevision = 0;
    }
    publish() { this.services.changed(this.snapshot); }
    reset() {
        this.listRequest?.abort();
        this.detailRequest?.abort();
        this.globalRequest?.abort();
        this.listRequest = this.detailRequest = this.globalRequest = null;
        this.snapshot = initialWindowSnapshot();
        this.globalRevision++;
    }
    denyRuntime() {
        this.reset();
        this.snapshot.availability = this.snapshot.globalAvailability = this.snapshot.detailAvailability = "unavailable";
        this.publish();
    }
    adoptGlobal(data) {
        this.snapshot.globalRows = Array.isArray(data.windows) ? data.windows : [];
        this.snapshot.globalTotal = Math.max(this.snapshot.globalRows.length, Number(data.total) || 0);
        this.snapshot.globalTruncated = !!data.truncated;
        this.snapshot.globalAvailability = "available";
        if (data.visibility?.scope === "global" || data.visibility?.scope === "principal")
            this.snapshot.scope = data.visibility.scope;
    }
    async refreshGlobal() {
        this.globalRequest?.abort();
        const request = new AbortController();
        this.globalRequest = request;
        const revision = ++this.globalRevision;
        if (this.snapshot.globalAvailability === "idle") {
            this.snapshot.globalAvailability = "loading";
            this.publish();
        }
        const response = await this.services.post("windows", { limit: 2000 }, request.signal);
        if (!ownsWindowResponse(this.globalRequest, request) || revision !== this.globalRevision)
            return;
        this.globalRequest = null;
        if (!response)
            return;
        if (response.status === 401) {
            this.services.unauthorized();
            return;
        }
        if (response.status === 403) {
            this.denyRuntime();
            return;
        }
        else if (!response.ok || !Array.isArray(response.data?.windows)) {
            this.snapshot.globalAvailability = "stale";
        }
        else {
            this.adoptGlobal(response.data);
        }
        this.publish();
    }
    async filter(project) {
        if (project === this.snapshot.project)
            return;
        this.listRequest?.abort();
        this.detailRequest?.abort();
        this.detailRequest = null;
        Object.assign(this.snapshot, { project, rows: [], selectedKey: "", detail: null, availability: "loading", detailAvailability: "idle" });
        this.publish();
        await this.refresh();
    }
    async refresh(refreshDetail = true) {
        this.listRequest?.abort();
        const request = new AbortController();
        this.listRequest = request;
        if (this.snapshot.availability === "idle") {
            this.snapshot.availability = "loading";
            this.publish();
        }
        const project = this.snapshot.project;
        const globalRevision = project ? this.globalRevision : ++this.globalRevision;
        if (!project) {
            this.globalRequest?.abort();
            this.globalRequest = null;
        }
        const response = await this.services.post("windows", { limit: 2000, ...(project ? { project } : {}) }, request.signal);
        if (!ownsWindowResponse(this.listRequest, request))
            return;
        this.listRequest = null;
        if (!response)
            return;
        if (response.status === 401) {
            this.services.unauthorized();
            return;
        }
        if (response.status === 403 && !project) {
            this.denyRuntime();
            return;
        }
        if (response.status === 403 || response.status === 404) {
            this.detailRequest?.abort();
            this.detailRequest = null;
            Object.assign(this.snapshot, { rows: [], selectedKey: "", detail: null, availability: "unavailable", detailAvailability: "unavailable" });
            if (!project) {
                this.snapshot.globalRows = [];
                this.snapshot.globalTotal = 0;
                this.snapshot.globalAvailability = "unavailable";
            }
            this.publish();
            return;
        }
        if (!response.ok || !Array.isArray(response.data?.windows)) {
            this.snapshot.availability = "stale";
            if (!project && globalRevision === this.globalRevision)
                this.snapshot.globalAvailability = "stale";
            this.publish();
            return;
        }
        const data = response.data;
        this.snapshot.rows = Array.isArray(data.windows) ? data.windows : [];
        this.snapshot.total = Math.max(this.snapshot.rows.length, Number(data.total) || 0);
        this.snapshot.truncated = !!data.truncated;
        this.snapshot.availability = "available";
        if (data.visibility?.scope === "global" || data.visibility?.scope === "principal")
            this.snapshot.scope = data.visibility.scope;
        if (!project && globalRevision === this.globalRevision)
            this.adoptGlobal(data);
        const key = preferredWindowKey(this.snapshot.rows, this.snapshot.selectedKey, this.snapshot.truncated);
        if (key !== this.snapshot.selectedKey) {
            this.detailRequest?.abort();
            this.detailRequest = null;
            this.snapshot.detail = null;
            this.snapshot.detailAvailability = "idle";
        }
        this.snapshot.selectedKey = key;
        this.publish();
        if (refreshDetail && key)
            await this.refreshDetail();
    }
    async open(key) {
        if (this.snapshot.project) {
            this.listRequest?.abort();
            this.listRequest = null;
            Object.assign(this.snapshot, {
                project: "",
                rows: this.snapshot.globalRows,
                total: this.snapshot.globalTotal,
                truncated: this.snapshot.globalTruncated,
                availability: this.snapshot.globalAvailability,
            });
        }
        await this.select(key);
    }
    async select(key) {
        if (!/^[0-9a-f]{64}$/i.test(key))
            return;
        if (key !== this.snapshot.selectedKey) {
            this.detailRequest?.abort();
            this.detailRequest = null;
            this.snapshot.detail = null;
        }
        this.snapshot.selectedKey = key;
        this.snapshot.detailAvailability = "loading";
        this.publish();
        await this.refreshDetail();
    }
    async refreshDetail() {
        const key = this.snapshot.selectedKey;
        if (!key)
            return;
        this.detailRequest?.abort();
        const request = new AbortController();
        this.detailRequest = request;
        if (!this.snapshot.detail) {
            this.snapshot.detailAvailability = "loading";
            this.publish();
        }
        const response = await this.services.post("window", { client_window_key: key, activity_limit: 2000, session_limit: 100 }, request.signal);
        if (!ownsWindowResponse(this.detailRequest, request) || key !== this.snapshot.selectedKey)
            return;
        this.detailRequest = null;
        if (!response)
            return;
        if (response.status === 401) {
            this.services.unauthorized();
            return;
        }
        if (response.status === 403) {
            this.denyRuntime();
            return;
        }
        if (response.status === 404) {
            this.snapshot.detail = null;
            this.snapshot.detailAvailability = "unavailable";
            // Revoked/deleted rows must not keep presenting old detail. Try another
            // authorized row at most once per removed key; the API remains authoritative.
            this.snapshot.rows = this.snapshot.rows.filter(row => row.client_window_key !== key);
            this.snapshot.globalRows = this.snapshot.globalRows.filter(row => row.client_window_key !== key);
            this.snapshot.total = this.snapshot.rows.length;
            this.snapshot.globalTotal = this.snapshot.globalRows.length;
            this.snapshot.selectedKey = String(this.snapshot.rows[0]?.client_window_key || "");
            this.publish();
            if (this.snapshot.selectedKey)
                await this.refreshDetail();
            return;
        }
        if (!response.ok || !response.data) {
            this.snapshot.detailAvailability = "stale";
            this.publish();
            return;
        }
        // Do not project a malformed or misrouted detail as the selected Window.
        if (response.data.client_window_key !== key) {
            this.snapshot.detailAvailability = "stale";
            this.publish();
            return;
        }
        this.snapshot.detail = response.data;
        this.snapshot.detailAvailability = "available";
        this.publish();
    }
}
