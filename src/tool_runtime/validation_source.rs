//! Process-local observation of canonical potential mutation dispatches.
//! Unlike the Code Mode serialization fence this includes direct calls and all
//! Sessions. It is NOT a filesystem watcher, write lock, or source snapshot.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use webcodex_core::validation_source::{
    ValidationSourceFence, ValidationSourceState, MAX_SOURCE_GENERATION,
};

const MAX_TRACKED_PROJECTS: usize = 4096;
const MAX_PENDING_JOBS_PER_PROJECT: usize = 256;

#[derive(Debug)]
struct ProjectObservation {
    epoch: String,
    generation: u64,
    active: usize,
    uncertain: bool,
    pending_jobs: BTreeSet<String>,
}

impl ProjectObservation {
    fn advance(&mut self) {
        if self.generation < MAX_SOURCE_GENERATION {
            self.generation += 1;
        } else {
            self.uncertain = true;
        }
    }

    fn snapshot(&self) -> ValidationSourceFence {
        ValidationSourceFence {
            epoch: self.epoch.clone(),
            generation: self.generation,
            quiescent: self.active == 0 && self.pending_jobs.is_empty() && !self.uncertain,
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct ValidationSourceRegistry {
    projects: Mutex<BTreeMap<String, Arc<Mutex<ProjectObservation>>>>,
}

impl ValidationSourceRegistry {
    fn project(&self, project: &str) -> Option<Arc<Mutex<ProjectObservation>>> {
        let mut projects = self.projects.lock().ok()?;
        if let Some(state) = projects.get(project) {
            return Some(Arc::clone(state));
        }
        // Never evict an active/uncertain writer and silently recreate a clean
        // baseline. Capacity exhaustion makes new Projects unproven instead.
        if projects.len() >= MAX_TRACKED_PROJECTS {
            return None;
        }
        let state = Arc::new(Mutex::new(ProjectObservation {
            epoch: uuid::Uuid::new_v4().simple().to_string(),
            generation: 0,
            active: 0,
            uncertain: false,
            pending_jobs: BTreeSet::new(),
        }));
        projects.insert(project.to_string(), Arc::clone(&state));
        Some(state)
    }

    pub(crate) fn capture(&self, project: &str) -> Option<ValidationSourceFence> {
        let state = self.project(project)?;
        let state = state.lock().ok()?;
        Some(state.snapshot())
    }

    pub(crate) fn observe(
        &self,
        project: &str,
        start: Option<&ValidationSourceFence>,
    ) -> ValidationSourceState {
        ValidationSourceState::observe(start, self.capture(project).as_ref())
    }

    pub(crate) fn pending_jobs(&self, project: &str) -> Vec<String> {
        let state = self
            .projects
            .lock()
            .ok()
            .and_then(|projects| projects.get(project).cloned());
        state
            .and_then(|state| state.lock().ok().map(|state| state.pending_jobs.clone()))
            .map(|jobs| jobs.into_iter().collect())
            .unwrap_or_default()
    }

    pub(crate) fn complete_pending_job(&self, project: &str, job_id: &str) {
        let state = self
            .projects
            .lock()
            .ok()
            .and_then(|projects| projects.get(project).cloned());
        if let Some(state) = state {
            if let Ok(mut state) = state.lock() {
                if state.pending_jobs.remove(job_id) {
                    state.advance();
                }
            }
        }
    }

    pub(crate) fn begin(&self, project: &str) -> Option<MutationObservationGuard> {
        let state = self.project(project)?;
        {
            let mut state = state.lock().ok()?;
            state.advance();
            state.active += 1;
        }
        Some(MutationObservationGuard {
            state,
            completed: false,
            pending_job: None,
        })
    }
}

pub(crate) struct MutationObservationGuard {
    state: Arc<Mutex<ProjectObservation>>,
    completed: bool,
    pending_job: Option<String>,
}

impl MutationObservationGuard {
    pub(crate) fn finish(mut self, result: &super::ToolResult) {
        let output = &result.output;
        let uncertain = output
            .get("execution_state")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|state| matches!(state, "outcome_unknown" | "lost"))
            || output
                .get("failure_kind")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|state| matches!(state, "outcome_unknown" | "lost"))
            || output
                .get("command_execution_state")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|state| state == "outcome_unknown");
        if uncertain {
            return;
        }

        let command_completed = output
            .get("command_completed")
            .and_then(serde_json::Value::as_bool)
            == Some(true);
        let command_not_started = output
            .get("command_started")
            .and_then(serde_json::Value::as_bool)
            == Some(false);
        if let Some(job_id) = output.get("job_id").filter(|job_id| !job_id.is_null()) {
            let Some(job_id) = job_id
                .as_str()
                .filter(|job_id| super::helpers::is_safe_job_id(job_id))
            else {
                return;
            };
            if command_completed || command_not_started {
                self.completed = true;
            } else {
                self.pending_job = Some(job_id.to_string());
            }
            return;
        }

        self.completed = output
            .get("state_changed")
            .and_then(serde_json::Value::as_bool)
            .is_some()
            || command_completed
            || command_not_started;
    }
}

impl Drop for MutationObservationGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.advance();
            state.active = state.active.saturating_sub(1);
            if let Some(job_id) = self.pending_job.take() {
                if state.pending_jobs.len() < MAX_PENDING_JOBS_PER_PROJECT {
                    state.pending_jobs.insert(job_id);
                } else {
                    state.uncertain = true;
                }
            } else {
                state.uncertain |= !self.completed;
            }
        }
    }
}

/// Conservative potential-source-effect classification, derived from canonical
/// metadata. Wrappers do not write: their canonical children are observed here.
/// Read-only structured validators can themselves run arbitrary build/test code;
/// that is deliberately OUTSIDE this dispatch fence, hence freshness is unproven.
pub(crate) fn observes_potential_mutation(call: &super::ToolCall) -> bool {
    let name = call.tool_name();
    if matches!(
        name,
        "code_mode_exec"
            | "code_mode_exec_effectful"
            | "code_mode_exec_mutating"
            | "cargo_check"
            | "cargo_test"
            | "go_test"
    ) {
        return false;
    }
    if matches!(
        call,
        super::ToolCall::CargoFmt {
            check: Some(true),
            ..
        }
    ) {
        return false;
    }
    let metadata = webcodex_tool_contracts::runtime_tool_metadata(name);
    metadata.requires_project
        && metadata.effect != webcodex_tool_contracts::ToolEffect::Observe
        && (metadata.shell_like
            || matches!(
                metadata.risk,
                webcodex_tool_contracts::ToolRisk::ProjectWrite
                    | webcodex_tool_contracts::ToolRisk::JobRun
                    | webcodex_tool_contracts::ToolRisk::CheckpointManage
            ))
}

#[cfg(test)]
#[path = "tests/validation_source.rs"]
mod tests;
