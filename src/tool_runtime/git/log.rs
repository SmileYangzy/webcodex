use serde_json::{json, Map, Value};

use super::super::git_committed::normalize_exact_commit_id;
use super::super::tool_result::{SuggestedToolCall, ToolResult};
use super::super::ToolRuntime;
use super::shared::is_git_object_hex;

const DEFAULT_GIT_LOG_LIMIT: usize = 20;
const MAX_GIT_LOG_LIMIT: usize = 100;
const MAX_GIT_LOG_SKIP: usize = 10_000;
const GIT_LOG_RECORD_SEP: char = '\u{1e}';
const GIT_LOG_UNIT_SEP: char = '\u{1f}';
const GIT_LOG_PRETTY_FORMAT: &str = "%H%x1f%h%x1f%D%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e";

pub(crate) fn normalize_git_log_limit(limit: Option<usize>) -> usize {
    limit
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_GIT_LOG_LIMIT)
        .min(MAX_GIT_LOG_LIMIT)
}

pub(crate) fn normalize_git_log_skip(skip: Option<usize>) -> usize {
    skip.unwrap_or(0).min(MAX_GIT_LOG_SKIP)
}

pub(crate) fn git_log_next_skip(
    skip: usize,
    returned_count: usize,
    truncated: bool,
) -> Option<usize> {
    if !truncated || returned_count == 0 {
        return None;
    }
    skip.checked_add(returned_count)
        .filter(|next| *next > skip && *next <= MAX_GIT_LOG_SKIP)
}

pub(crate) fn git_log_args(head_commit: &str, limit: usize, skip: usize) -> Vec<String> {
    debug_assert!(normalize_exact_commit_id(head_commit).is_ok());
    vec![
        "log".to_string(),
        "--decorate=short".to_string(),
        "--date=iso-strict".to_string(),
        format!("--pretty=format:{GIT_LOG_PRETTY_FORMAT}"),
        "-n".to_string(),
        limit.saturating_add(1).to_string(),
        "--skip".to_string(),
        skip.to_string(),
        head_commit.to_string(),
    ]
}

fn parse_git_log_refs(decorations: &str) -> Vec<String> {
    decorations
        .split(',')
        .flat_map(|part| {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                Vec::new()
            } else if let Some((head, branch)) = trimmed.split_once(" -> ") {
                vec![head.trim().to_string(), branch.trim().to_string()]
            } else if let Some(tag) = trimmed.strip_prefix("tag: ") {
                vec![tag.trim().to_string()]
            } else {
                vec![trimmed.to_string()]
            }
        })
        .collect()
}

pub(crate) fn parse_git_log_commits(
    stdout: &str,
    limit: usize,
) -> Result<(Vec<Value>, bool), &'static str> {
    if !stdout.trim_end_matches(['\n', '\r']).is_empty()
        && !stdout
            .trim_end_matches(['\n', '\r'])
            .ends_with(GIT_LOG_RECORD_SEP)
    {
        return Err("git log source ended inside a record; retry with a smaller limit");
    }
    let mut commits = Vec::new();
    let mut truncated = false;
    for record in stdout.split(GIT_LOG_RECORD_SEP) {
        let record = record.trim_matches(['\n', '\r']);
        if record.is_empty() {
            continue;
        }
        let fields: Vec<&str> = record.splitn(7, GIT_LOG_UNIT_SEP).collect();
        if fields.len() != 7 || !is_git_object_hex(fields[0]) {
            return Err("git log source is incomplete or malformed; retry with a smaller limit");
        }
        if commits.len() >= limit {
            truncated = true;
            break;
        }
        commits.push(json!({
            "hash": fields[0],
            "short_hash": fields[1],
            "subject": fields[6],
            "author_name": fields[3],
            "author_email": fields[4],
            "author_date": fields[5],
            "refs": parse_git_log_refs(fields[2]),
        }));
    }
    Ok((commits, truncated))
}

struct GitProcessOutput {
    exit_code: i32,
    stdout: String,
    stderr: String,
    stdout_truncated: bool,
}

fn completed_git_process(result: ToolResult) -> Result<GitProcessOutput, ToolResult> {
    if result.output["execution_state"] != "completed" {
        if result.success {
            return Err(ToolResult::err_with_output(
                "git process result is incomplete or malformed",
                json!({
                    "error_kind": "source_incomplete",
                    "state_changed": false,
                }),
            ));
        }
        return Err(result);
    }
    let Some(exit_code) = result.output["exit_code"]
        .as_i64()
        .and_then(|value| i32::try_from(value).ok())
    else {
        if result.success {
            return Err(ToolResult::err_with_output(
                "git process result is incomplete or malformed",
                json!({
                    "error_kind": "source_incomplete",
                    "state_changed": false,
                }),
            ));
        }
        return Err(result);
    };
    let Some(stdout) = result.output["stdout_tail"].as_str() else {
        if result.success {
            return Err(ToolResult::err_with_output(
                "git process result is incomplete or malformed",
                json!({
                    "error_kind": "source_incomplete",
                    "state_changed": false,
                }),
            ));
        }
        return Err(result);
    };
    Ok(GitProcessOutput {
        exit_code,
        stdout: stdout.to_string(),
        stderr: result.output["stderr_tail"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        stdout_truncated: result.output["stdout_truncated"].as_bool().unwrap_or(false),
    })
}

fn git_log_suggested_call(
    project: &str,
    head_commit: &str,
    limit: usize,
    next_skip: usize,
    session_id: Option<&str>,
) -> Value {
    let mut arguments = Map::new();
    arguments.insert("project".to_string(), json!(project));
    arguments.insert("head_commit".to_string(), json!(head_commit));
    arguments.insert("limit".to_string(), json!(limit));
    arguments.insert("skip".to_string(), json!(next_skip));
    if let Some(session_id) = session_id {
        arguments.insert("session_id".to_string(), json!(session_id));
    }
    SuggestedToolCall::new("git_log", Value::Object(arguments)).to_value()
}

impl ToolRuntime {
    async fn run_git_process(
        &self,
        project: &str,
        args: Vec<String>,
    ) -> Result<GitProcessOutput, ToolResult> {
        completed_git_process(
            self.run_internal_process_sync(project.to_string(), "git".to_string(), args, 30)
                .await,
        )
    }

    pub(crate) async fn git_log(
        &self,
        project: String,
        head_commit: Option<String>,
        limit: Option<usize>,
        skip: Option<usize>,
        session_id: Option<String>,
    ) -> ToolResult {
        let head_commit = match head_commit {
            Some(value) => match normalize_exact_commit_id(&value) {
                Ok(value) => Some(value),
                Err(reason) => {
                    return ToolResult::err_with_output(
                        format!("git_log failed: {reason}"),
                        json!({
                            "project": project,
                            "error_kind": reason,
                            "state_changed": false,
                        }),
                    )
                }
            },
            None => None,
        };
        let resolved_project = match self.resolve_project_input(&project).await {
            Ok(resolved) => resolved.resolved_id,
            Err(error) => return ToolResult::err(error),
        };
        let limit = normalize_git_log_limit(limit);
        let skip = normalize_git_log_skip(skip);
        let snapshot_head = if let Some(head) = head_commit.as_deref() {
            let object_type = match self
                .run_git_process(
                    &resolved_project,
                    vec!["cat-file".to_string(), "-t".to_string(), head.to_string()],
                )
                .await
            {
                Ok(output) => output,
                Err(result) => return result,
            };
            if object_type.stdout_truncated {
                return ToolResult::err_with_output(
                    "git object type result is incomplete",
                    json!({
                        "project": project,
                        "error_kind": "source_incomplete",
                        "state_changed": false,
                    }),
                );
            }
            (object_type.exit_code == 0 && object_type.stdout.trim() == "commit")
                .then(|| head.to_string())
        } else {
            let resolved_head = match self
                .run_git_process(
                    &resolved_project,
                    vec![
                        "rev-parse".to_string(),
                        "--verify".to_string(),
                        "HEAD^{commit}".to_string(),
                    ],
                )
                .await
            {
                Ok(output) => output,
                Err(result) => return result,
            };
            if resolved_head.stdout_truncated {
                return ToolResult::err_with_output(
                    "git HEAD result is incomplete",
                    json!({
                        "project": project,
                        "error_kind": "source_incomplete",
                        "state_changed": false,
                    }),
                );
            }
            if resolved_head.exit_code == 0 {
                normalize_exact_commit_id(resolved_head.stdout.trim()).ok()
            } else {
                let symbolic_head = match self
                    .run_git_process(
                        &resolved_project,
                        vec![
                            "symbolic-ref".to_string(),
                            "-q".to_string(),
                            "HEAD".to_string(),
                        ],
                    )
                    .await
                {
                    Ok(output) => output,
                    Err(result) => return result,
                };
                if symbolic_head.stdout_truncated {
                    return ToolResult::err_with_output(
                        "git symbolic HEAD result is incomplete",
                        json!({
                            "project": project,
                            "error_kind": "source_incomplete",
                            "state_changed": false,
                        }),
                    );
                }
                if symbolic_head.exit_code != 0 || symbolic_head.stdout.trim().is_empty() {
                    None
                } else {
                    let reference = symbolic_head.stdout.trim();
                    let ref_check = match self
                        .run_git_process(
                            &resolved_project,
                            vec![
                                "show-ref".to_string(),
                                "--verify".to_string(),
                                "--quiet".to_string(),
                                reference.to_string(),
                            ],
                        )
                        .await
                    {
                        Ok(output) => output,
                        Err(result) => return result,
                    };
                    if ref_check.stdout_truncated {
                        return ToolResult::err_with_output(
                            "git ref verification result is incomplete",
                            json!({
                                "project": project,
                                "error_kind": "source_incomplete",
                                "state_changed": false,
                            }),
                        );
                    }
                    if ref_check.exit_code == 1 {
                        return ToolResult::ok(json!({
                            "project": project,
                            "head_commit": null,
                            "limit": limit,
                            "skip": skip,
                            "count": 0,
                            "truncated": false,
                            "next_skip": null,
                            "commits": [],
                        }));
                    }
                    None
                }
            }
        };
        let Some(snapshot_head) = snapshot_head else {
            return ToolResult::err_with_output(
                "git log snapshot is unavailable",
                json!({
                    "project": project,
                    "head_commit": head_commit,
                    "error_kind": "snapshot_unavailable",
                    "state_changed": false,
                }),
            );
        };
        let output = match self
            .run_git_process(&resolved_project, git_log_args(&snapshot_head, limit, skip))
            .await
        {
            Ok(output) => output,
            Err(result) => return result,
        };
        if output.exit_code != 0 {
            return ToolResult {
                success: false,
                output: json!({
                    "project": project,
                    "head_commit": snapshot_head,
                    "limit": limit,
                    "skip": skip,
                    "exit_code": output.exit_code,
                    "stderr": output.stderr,
                }),
                error: Some("git log failed".to_string()),
            };
        }
        if output.stdout_truncated {
            return ToolResult::err_with_output(
                "git log source is incomplete; retry with a smaller limit",
                json!({
                    "project": project,
                    "error_kind": "source_incomplete",
                    "state_changed": false,
                }),
            );
        }
        let (commits, truncated) = match parse_git_log_commits(&output.stdout, limit) {
            Ok(page) => page,
            Err(error) => {
                return ToolResult::err_with_output(
                    error,
                    json!({
                        "project": project,
                        "error_kind": "source_incomplete",
                        "state_changed": false,
                    }),
                );
            }
        };
        let next_skip = git_log_next_skip(skip, commits.len(), truncated);
        let mut payload = json!({
            "project": project,
            "head_commit": snapshot_head,
            "limit": limit,
            "skip": skip,
            "count": commits.len(),
            "truncated": truncated,
            "next_skip": next_skip,
            "commits": commits,
        });
        if let Some(next_skip) = next_skip {
            payload["suggested_call"] = git_log_suggested_call(
                &resolved_project,
                &snapshot_head,
                limit,
                next_skip,
                session_id.as_deref(),
            );
        }
        ToolResult::ok(payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completed_git_process_rejects_malformed_success() {
        let result = completed_git_process(ToolResult::ok(json!({})));
        let error = match result {
            Ok(_) => panic!("malformed successful process result must fail closed"),
            Err(error) => error,
        };

        assert!(!error.success);
        assert_eq!(error.output["error_kind"], "source_incomplete");
        assert_eq!(error.output["state_changed"], false);
    }
}
