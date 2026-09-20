use crate::workspace_checkpoint::{create_workspace_checkpoint, restore_workspace_checkpoint};
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::fs::File;
#[cfg(windows)]
use std::io::Read;
use std::path::Path;
#[cfg(windows)]
use std::process::{Child, ExitStatus};
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::time::{Duration, Instant};

const STDIN_LEASE_HELPER_ROOT: &str = "WEBCODEX_CHECKPOINT_STDIN_LEASE_HELPER_ROOT";

fn isolate_git_environment(command: &mut Command, root: &Path) {
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_CONFIG_COUNT", "2")
        .env("GIT_CONFIG_KEY_0", "commit.gpgSign")
        .env("GIT_CONFIG_VALUE_0", "false")
        .env("GIT_CONFIG_KEY_1", "core.hooksPath")
        .env("GIT_CONFIG_VALUE_1", root.join(".webcodex-disabled-hooks"))
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env_remove("GIT_TEMPLATE_DIR");
}

fn run_git(root: &Path, args: &[&str]) {
    let mut command = Command::new("git");
    isolate_git_environment(&mut command, root);
    let output = command
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .output()
        .expect("run git fixture command");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn git_stdout(root: &Path, args: &[&str]) -> Vec<u8> {
    let mut command = Command::new("git");
    isolate_git_environment(&mut command, root);
    let output = command
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn init_repo(autocrlf: bool) -> tempfile::TempDir {
    let repo = tempfile::tempdir().unwrap();
    run_git(repo.path(), &["init", "--initial-branch=main"]);
    run_git(
        repo.path(),
        &[
            "config",
            "core.autocrlf",
            if autocrlf { "true" } else { "false" },
        ],
    );
    run_git(repo.path(), &["config", "user.name", "WebCodex Test"]);
    run_git(
        repo.path(),
        &["config", "user.email", "webcodex@example.invalid"],
    );
    repo
}

fn sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[test]
fn clean_checkpoint_restore_removes_tracked_edit_and_includes_path() {
    let repo = init_repo(false);
    let probe = repo.path().join("probe.py");
    std::fs::write(&probe, "value = 1\n").unwrap();
    run_git(repo.path(), &["add", "probe.py"]);
    run_git(repo.path(), &["commit", "-m", "baseline"]);

    let mut checkpoint = create_workspace_checkpoint(repo.path(), false);
    assert!(checkpoint.get("error").is_none(), "{checkpoint}");
    checkpoint["checkpoint_id"] = serde_json::json!("fixture");
    std::fs::write(&probe, "value = 1\nassert value == 1\n").unwrap();

    let restored = restore_workspace_checkpoint(repo.path(), &checkpoint);

    assert!(restored.get("error").is_none(), "{restored}");
    assert_eq!(std::fs::read_to_string(&probe).unwrap(), "value = 1\n");
    assert_eq!(restored["changed_paths"], serde_json::json!(["probe.py"]));
    assert_eq!(
        restored["warnings"],
        serde_json::json!(["checkpoint_clean_paths_restored_from_git_diff_not_byte_exact"])
    );

    std::fs::write(&probe, "value = 2\n").unwrap();
    run_git(repo.path(), &["add", "probe.py"]);
    let restored = restore_workspace_checkpoint(repo.path(), &checkpoint);
    assert!(restored.get("error").is_none(), "{restored}");
    assert_eq!(std::fs::read_to_string(&probe).unwrap(), "value = 1\n");
    assert_eq!(restored["changed_paths"], serde_json::json!(["probe.py"]));
    run_git(repo.path(), &["diff", "--cached", "--exit-code"]);
}

#[test]
fn checkpoint_restores_exact_lf_and_crlf_bytes_with_autocrlf_enabled() {
    let repo = init_repo(true);
    let probe = repo.path().join("probe.txt");
    std::fs::write(&probe, b"baseline\n").unwrap();
    run_git(repo.path(), &["add", "probe.txt"]);
    run_git(repo.path(), &["commit", "-m", "baseline"]);

    for (saved, replacement) in [
        (b"saved-lf\n".as_slice(), b"replacement\r\n".as_slice()),
        (b"saved-crlf\r\n".as_slice(), b"replacement\n".as_slice()),
    ] {
        std::fs::write(&probe, saved).unwrap();
        let mut checkpoint = create_workspace_checkpoint(repo.path(), false);
        assert_eq!(checkpoint["version"], 2, "{checkpoint}");
        checkpoint["checkpoint_id"] = serde_json::json!("line-endings");
        std::fs::write(&probe, replacement).unwrap();

        let restored = restore_workspace_checkpoint(repo.path(), &checkpoint);

        assert!(restored.get("error").is_none(), "{restored}");
        assert_eq!(std::fs::read(&probe).unwrap(), saved);
    }
}

#[test]
fn git_clean_crlf_checkpoint_has_no_raw_snapshot_and_restores_via_diff() {
    let repo = init_repo(true);
    let probe = repo.path().join("probe.txt");
    std::fs::write(&probe, b"baseline\n").unwrap();
    run_git(repo.path(), &["add", "probe.txt"]);
    run_git(repo.path(), &["commit", "-m", "baseline"]);
    std::fs::remove_file(&probe).unwrap();
    run_git(repo.path(), &["checkout", "--", "probe.txt"]);
    assert_eq!(std::fs::read(&probe).unwrap(), b"baseline\r\n");

    let mut checkpoint = create_workspace_checkpoint(repo.path(), false);
    assert_eq!(checkpoint["tracked_paths"], serde_json::json!([]));
    checkpoint["checkpoint_id"] = serde_json::json!("clean-crlf");

    std::fs::write(&probe, b"baseline\n").unwrap();
    assert!(git_stdout(repo.path(), &["diff", "--", "probe.txt"]).is_empty());
    let restored = restore_workspace_checkpoint(repo.path(), &checkpoint);
    assert!(restored.get("error").is_none(), "{restored}");
    assert_eq!(std::fs::read(&probe).unwrap(), b"baseline\n");

    std::fs::write(&probe, b"changed\n").unwrap();

    let restored = restore_workspace_checkpoint(repo.path(), &checkpoint);

    assert!(restored.get("error").is_none(), "{restored}");
    assert_eq!(
        restored["warnings"],
        serde_json::json!(["checkpoint_clean_paths_restored_from_git_diff_not_byte_exact"])
    );
}

#[test]
fn checkpoint_uses_unquoted_nul_paths_for_unicode_and_spaces() {
    let repo = init_repo(true);
    let relative = "目录 name/probe 文件.txt";
    let probe = repo.path().join(relative);
    std::fs::create_dir_all(probe.parent().unwrap()).unwrap();
    std::fs::write(&probe, b"baseline\n").unwrap();
    run_git(repo.path(), &["add", relative]);
    run_git(repo.path(), &["commit", "-m", "baseline"]);
    std::fs::write(&probe, b"saved-lf\n").unwrap();

    let mut checkpoint = create_workspace_checkpoint(repo.path(), false);
    assert_eq!(checkpoint["tracked_paths"], serde_json::json!([relative]));
    checkpoint["checkpoint_id"] = serde_json::json!("unicode-path");
    std::fs::write(&probe, b"replacement\r\n").unwrap();

    let restored = restore_workspace_checkpoint(repo.path(), &checkpoint);

    assert!(restored.get("error").is_none(), "{restored}");
    assert_eq!(std::fs::read(&probe).unwrap(), b"saved-lf\n");
    assert_eq!(restored["changed_paths"], serde_json::json!([relative]));
}

#[test]
fn checkpoint_preserves_staged_index_and_unstaged_worktree() {
    let repo = init_repo(true);
    let probe = repo.path().join("probe.txt");
    std::fs::write(&probe, b"baseline\n").unwrap();
    run_git(repo.path(), &["add", "probe.txt"]);
    run_git(repo.path(), &["commit", "-m", "baseline"]);
    std::fs::write(&probe, b"staged\r\n").unwrap();
    run_git(repo.path(), &["add", "probe.txt"]);
    std::fs::write(&probe, b"staged\r\nunstaged\r\n").unwrap();
    let expected_index = git_stdout(repo.path(), &["show", ":probe.txt"]);
    let expected_worktree = std::fs::read(&probe).unwrap();
    let mut checkpoint = create_workspace_checkpoint(repo.path(), false);
    checkpoint["checkpoint_id"] = serde_json::json!("staged-unstaged");
    std::fs::write(&probe, b"current\n").unwrap();
    run_git(repo.path(), &["add", "probe.txt"]);

    let restored = restore_workspace_checkpoint(repo.path(), &checkpoint);

    assert!(restored.get("error").is_none(), "{restored}");
    assert_eq!(
        git_stdout(repo.path(), &["show", ":probe.txt"]),
        expected_index
    );
    assert_eq!(std::fs::read(&probe).unwrap(), expected_worktree);
    assert_eq!(
        String::from_utf8(git_stdout(repo.path(), &["status", "--short"]))
            .unwrap()
            .trim(),
        "MM probe.txt"
    );
}

#[test]
fn legacy_v1_restore_reports_byte_fidelity_limitation() {
    let repo = init_repo(false);
    let probe = repo.path().join("probe.txt");
    std::fs::write(&probe, b"baseline\n").unwrap();
    run_git(repo.path(), &["add", "probe.txt"]);
    run_git(repo.path(), &["commit", "-m", "baseline"]);
    std::fs::write(&probe, b"saved\n").unwrap();
    let mut checkpoint = create_workspace_checkpoint(repo.path(), false);
    checkpoint["checkpoint_id"] = serde_json::json!("legacy");
    assert!(!checkpoint["tracked_diff"].as_str().unwrap().is_empty());
    checkpoint["format"] = serde_json::json!("webcodex.workspace_checkpoint.v1");
    checkpoint["version"] = serde_json::json!(1);
    {
        let checkpoint = checkpoint.as_object_mut().unwrap();
        checkpoint.remove("tracked_paths");
        checkpoint.remove("tracked_worktree_files");
        checkpoint.remove("tracked_snapshot_bytes");
    }
    std::fs::write(&probe, b"current\n").unwrap();

    let restored = restore_workspace_checkpoint(repo.path(), &checkpoint);

    assert!(restored.get("error").is_none(), "{restored}");
    assert_eq!(std::fs::read(&probe).unwrap(), b"saved\n");
    assert_eq!(
        restored["warnings"],
        serde_json::json!(["legacy_v1_text_diff_restore_is_not_byte_exact"])
    );
}

#[test]
fn restore_rejects_non_numeric_or_unknown_checkpoint_versions() {
    let repo = init_repo(false);
    let probe = repo.path().join("probe.txt");
    std::fs::write(&probe, b"baseline\n").unwrap();
    run_git(repo.path(), &["add", "probe.txt"]);
    run_git(repo.path(), &["commit", "-m", "baseline"]);
    let mut checkpoint = create_workspace_checkpoint(repo.path(), false);
    checkpoint["checkpoint_id"] = serde_json::json!("version");

    for version in [serde_json::json!("2"), serde_json::json!(3)] {
        checkpoint["version"] = version;
        let restored = restore_workspace_checkpoint(repo.path(), &checkpoint);
        assert_eq!(restored["error_kind"], "invalid_checkpoint", "{restored}");
    }
}

#[test]
fn checkpoint_rejects_large_tracked_snapshot_with_small_diff() {
    let repo = init_repo(false);
    let probe = repo.path().join("probe.txt");
    let baseline = "baseline\n".repeat(130_000);
    std::fs::write(&probe, &baseline).unwrap();
    run_git(repo.path(), &["add", "probe.txt"]);
    run_git(repo.path(), &["commit", "-m", "baseline"]);
    let changed = format!("changed\n{baseline}");
    std::fs::write(&probe, &changed).unwrap();

    let checkpoint = create_workspace_checkpoint(repo.path(), false);

    assert_eq!(
        checkpoint["error_kind"], "checkpoint_too_large",
        "{checkpoint}"
    );
    assert_eq!(std::fs::read(&probe).unwrap(), changed.as_bytes());
}

#[test]
fn failed_restore_rolls_back_current_worktree_bytes() {
    let repo = init_repo(true);
    let probe = repo.path().join("probe.txt");
    std::fs::write(&probe, b"baseline\n").unwrap();
    run_git(repo.path(), &["add", "probe.txt"]);
    run_git(repo.path(), &["commit", "-m", "baseline"]);
    std::fs::write(&probe, b"saved\r\n").unwrap();
    let mut checkpoint = create_workspace_checkpoint(repo.path(), false);
    checkpoint["checkpoint_id"] = serde_json::json!("rollback");
    checkpoint["untracked_files"] = serde_json::json!([{
        "path": "probe.txt/child",
        "content": "child\n",
        "sha256": sha256(b"child\n")
    }]);
    std::fs::write(&probe, b"current-staged\r\n").unwrap();
    run_git(repo.path(), &["add", "probe.txt"]);
    std::fs::write(&probe, b"current-staged\r\ncurrent-unstaged\n").unwrap();
    let before_index = git_stdout(repo.path(), &["show", ":probe.txt"]);
    let before_worktree = std::fs::read(&probe).unwrap();

    let restored = restore_workspace_checkpoint(repo.path(), &checkpoint);

    assert_eq!(restored["error_kind"], "restore_failed", "{restored}");
    assert_eq!(restored["rolled_back"], true, "{restored}");
    assert_eq!(
        git_stdout(repo.path(), &["show", ":probe.txt"]),
        before_index
    );
    assert_eq!(std::fs::read(&probe).unwrap(), before_worktree);
}

#[cfg(windows)]
fn wait_for_child(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().expect("poll child process") {
            return Some(status);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(windows)]
fn terminate_process_tree(child: &mut Child) -> ExitStatus {
    let pid = child.id().to_string();
    let mut taskkill = Command::new("taskkill")
        .args(["/PID", &pid, "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn taskkill for checkpoint helper process tree");
    let taskkill_status = wait_for_child(&mut taskkill, Duration::from_secs(2));
    if taskkill_status.is_none() {
        let _ = taskkill.kill();
        assert!(
            wait_for_child(&mut taskkill, Duration::from_secs(2)).is_some(),
            "taskkill did not terminate within the cleanup deadline"
        );
    }

    if let Some(status) = wait_for_child(child, Duration::from_secs(2)) {
        return status;
    }
    let _ = child.kill();
    let status = wait_for_child(child, Duration::from_secs(2))
        .expect("checkpoint helper did not terminate after process-tree cleanup");
    assert!(
        taskkill_status.is_some_and(|status| status.success()),
        "taskkill failed to terminate the checkpoint helper process tree"
    );
    status
}

#[test]
fn checkpoint_stdin_lease_helper() {
    let Ok(root) = std::env::var(STDIN_LEASE_HELPER_ROOT) else {
        return;
    };
    #[cfg(windows)]
    {
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            let mut stdin = stdin.lock();
            started_tx.send(()).unwrap();
            let _ = stdin.read(&mut [0u8; 1]);
        });
        started_rx.recv().unwrap();
        std::thread::sleep(Duration::from_millis(50));
    }
    let checkpoint = create_workspace_checkpoint(Path::new(&root), false);
    assert!(checkpoint.get("error").is_none(), "{checkpoint}");
    assert_eq!(checkpoint["complete"], true);
}

#[cfg(windows)]
#[test]
fn checkpoint_git_does_not_inherit_runner_parent_stdin_lease() {
    let repo = tempfile::tempdir().unwrap();
    run_git(repo.path(), &["init", "--initial-branch=main"]);
    run_git(repo.path(), &["config", "user.name", "WebCodex Test"]);
    run_git(
        repo.path(),
        &["config", "user.email", "webcodex@example.invalid"],
    );
    std::fs::write(repo.path().join("probe.txt"), "baseline\n").unwrap();
    run_git(repo.path(), &["add", "probe.txt"]);
    run_git(repo.path(), &["commit", "-m", "baseline"]);

    let helper_output = tempfile::tempdir().unwrap();
    let stdout_path = helper_output.path().join("stdout.log");
    let stderr_path = helper_output.path().join("stderr.log");
    let mut command = Command::new(std::env::current_exe().unwrap());
    isolate_git_environment(&mut command, repo.path());
    let mut child = command
        .arg("workspace_checkpoint_tests::checkpoint_stdin_lease_helper")
        .arg("--exact")
        .arg("--nocapture")
        .env(STDIN_LEASE_HELPER_ROOT, repo.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::from(File::create(&stdout_path).unwrap()))
        .stderr(Stdio::from(File::create(&stderr_path).unwrap()))
        .spawn()
        .expect("spawn checkpoint stdin-lease helper");
    let stdin_lease = child.stdin.take().expect("helper stdin pipe");
    let status = wait_for_child(&mut child, Duration::from_secs(5));
    if status.is_none() {
        let terminated_status = terminate_process_tree(&mut child);
        drop(stdin_lease);
        let stdout = std::fs::read_to_string(&stdout_path).unwrap_or_default();
        let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
        panic!(
            "checkpoint inherited the open Runner stdin lease and did not finish; terminated_status={terminated_status}: stdout={stdout} stderr={stderr}"
        );
    }
    drop(stdin_lease);
    let stdout = std::fs::read_to_string(&stdout_path).unwrap_or_default();
    let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
    assert!(
        status.unwrap().success(),
        "checkpoint helper failed: stdout={stdout} stderr={stderr}"
    );
}
