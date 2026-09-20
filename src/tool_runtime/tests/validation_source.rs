use super::*;
use crate::tool_runtime::ToolResult;
use webcodex_core::validation_source::{ObservedMutationFence, ValidationFreshness};

#[test]
fn source_fence_multiple_writers_remain_active_until_every_known_completion() {
    let registry = ValidationSourceRegistry::default();
    let first = registry.begin("p").unwrap();
    let second = registry.begin("p").unwrap();
    first.finish(&noop());
    let during = registry.capture("p").unwrap();
    assert!(!during.quiescent);
    assert_eq!(
        registry.observe("p", Some(&during)).observed_mutation_fence,
        ObservedMutationFence::Unknown
    );
    second.finish(&noop());
    assert!(registry.capture("p").unwrap().quiescent);
    assert_eq!(
        registry.observe("p", Some(&during)).observed_mutation_fence,
        ObservedMutationFence::Crossed
    );
}

#[test]
fn source_fence_handoff_and_generation_exhaustion_cannot_manufacture_quiescence() {
    let registry = ValidationSourceRegistry::default();
    registry
        .begin("job")
        .unwrap()
        .finish(&crate::tool_runtime::ToolResult::ok(
            serde_json::json!({"job_id":"existing-job","state_changed":false}),
        ));
    let pending = registry.capture("job").unwrap();
    assert!(!pending.quiescent);
    assert_eq!(
        registry.pending_jobs("job"),
        vec!["existing-job".to_string()]
    );
    registry.complete_pending_job("job", "existing-job");
    let settled = registry.capture("job").unwrap();
    assert!(settled.quiescent);
    assert!(settled.generation > pending.generation);
    assert_eq!(
        registry.observe("job", Some(&settled)).freshness,
        ValidationFreshness::Unproven
    );
    let state = registry.project("exhausted").unwrap();
    state.lock().unwrap().generation = MAX_SOURCE_GENERATION;
    let before = registry.capture("exhausted").unwrap();
    registry.begin("exhausted").unwrap().finish(&noop());
    let after = registry.capture("exhausted").unwrap();
    assert_eq!(after.generation, MAX_SOURCE_GENERATION);
    assert!(!after.quiescent);
    assert_eq!(
        registry
            .observe("exhausted", Some(&before))
            .observed_mutation_fence,
        ObservedMutationFence::Unknown
    );
}

#[test]
fn source_fence_sync_completion_does_not_require_state_changed() {
    let registry = ValidationSourceRegistry::default();
    registry.begin("p").unwrap().finish(&ToolResult::ok(
        serde_json::json!({"command_completed": true}),
    ));
    assert!(registry.capture("p").unwrap().quiescent);
}

#[test]
fn source_fence_pending_jobs_are_bounded_and_overflow_fails_closed() {
    let registry = ValidationSourceRegistry::default();
    for index in 0..MAX_PENDING_JOBS_PER_PROJECT {
        registry.begin("p").unwrap().finish(&ToolResult::ok(
            serde_json::json!({"job_id": format!("job-{index}")}),
        ));
    }
    assert_eq!(
        registry.pending_jobs("p").len(),
        MAX_PENDING_JOBS_PER_PROJECT
    );
    registry.begin("p").unwrap().finish(&ToolResult::ok(
        serde_json::json!({"job_id": "job-overflow"}),
    ));
    for job_id in registry.pending_jobs("p") {
        registry.complete_pending_job("p", &job_id);
    }
    assert!(!registry.capture("p").unwrap().quiescent);
}

#[test]
fn source_fence_lost_and_outcome_unknown_jobs_remain_uncertain() {
    for (project, output) in [
        (
            "lost",
            serde_json::json!({"job_id": "lost-job", "execution_state": "lost"}),
        ),
        (
            "unknown",
            serde_json::json!({
                "job_id": "unknown-job",
                "command_execution_state": "outcome_unknown"
            }),
        ),
        (
            "invalid-job-id",
            serde_json::json!({"job_id": "../invalid", "state_changed": false}),
        ),
        (
            "non-string-job-id",
            serde_json::json!({"job_id": 42, "state_changed": false}),
        ),
    ] {
        let registry = ValidationSourceRegistry::default();
        registry
            .begin(project)
            .unwrap()
            .finish(&ToolResult::ok(output));
        assert!(registry.pending_jobs(project).is_empty());
        assert!(!registry.capture(project).unwrap().quiescent);
    }
}

fn noop() -> crate::tool_runtime::ToolResult {
    crate::tool_runtime::ToolResult::ok(serde_json::json!({"state_changed": false}))
}

#[test]
fn source_fence_tracks_inflight_completed_and_noop_attempts_not_content_equality() {
    let registry = ValidationSourceRegistry::default();
    let before = registry.capture("p").unwrap();
    let writer = registry.begin("p").unwrap();
    let during = registry.capture("p").unwrap();
    assert!(!during.quiescent);
    assert_eq!(
        registry.observe("p", Some(&before)).freshness,
        ValidationFreshness::Stale
    );
    writer.finish(&noop());
    assert_eq!(
        registry.observe("p", Some(&during)).freshness,
        ValidationFreshness::Stale
    );
    let after = registry.capture("p").unwrap();
    assert!(after.quiescent);
    assert_eq!(
        registry.observe("p", Some(&after)).observed_mutation_fence,
        ObservedMutationFence::Uncrossed
    );
    assert_eq!(
        registry.observe("p", Some(&after)).freshness,
        ValidationFreshness::Unproven
    );
}

#[test]
fn source_fence_cancellation_and_unknown_writers_never_reopen_clean_epoch() {
    let registry = ValidationSourceRegistry::default();
    drop(registry.begin("p"));
    let after = registry.capture("p").unwrap();
    assert!(!after.quiescent);
    registry.begin("p").unwrap().finish(&noop());
    assert!(!registry.capture("p").unwrap().quiescent);
    assert_eq!(
        registry
            .observe("p", Some(&registry.capture("p").unwrap()))
            .observed_mutation_fence,
        ObservedMutationFence::Unknown
    );
}

#[test]
fn source_fence_project_and_restart_epochs_are_not_interchangeable() {
    let registry = ValidationSourceRegistry::default();
    let start = registry.capture("one").unwrap();
    registry.begin("two").unwrap().finish(&noop());
    assert_eq!(
        registry
            .observe("one", Some(&start))
            .observed_mutation_fence,
        ObservedMutationFence::Uncrossed
    );
    assert_eq!(
        registry
            .observe("two", Some(&start))
            .observed_mutation_fence,
        ObservedMutationFence::Unknown
    );
    assert_eq!(
        ValidationSourceRegistry::default()
            .observe("one", Some(&start))
            .observed_mutation_fence,
        ObservedMutationFence::Unknown
    );
}

#[test]
fn source_fence_capacity_does_not_evict_active_writers() {
    let registry = ValidationSourceRegistry::default();
    let writer = registry.begin("p").unwrap();
    for i in 1..MAX_TRACKED_PROJECTS {
        assert!(registry.capture(&i.to_string()).is_some());
    }
    assert!(registry.capture("overflow").is_none());
    assert!(!registry.capture("p").unwrap().quiescent);
    writer.finish(&noop());
    assert!(registry.capture("p").unwrap().quiescent);
}
