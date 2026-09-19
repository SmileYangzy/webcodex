use crate::workspace_checkpoint::{create_workspace_checkpoint, restore_workspace_checkpoint};
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

#[test]
fn clean_checkpoint_restore_removes_tracked_edit_and_includes_path() {
    let repo = tempfile::tempdir().unwrap();
    run_git(repo.path(), &["init", "--initial-branch=main"]);
    run_git(repo.path(), &["config", "core.autocrlf", "false"]);
    run_git(repo.path(), &["config", "user.name", "WebCodex Test"]);
    run_git(
        repo.path(),
        &["config", "user.email", "webcodex@example.invalid"],
    );
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

    std::fs::write(&probe, "value = 2\n").unwrap();
    run_git(repo.path(), &["add", "probe.py"]);
    let restored = restore_workspace_checkpoint(repo.path(), &checkpoint);
    assert!(restored.get("error").is_none(), "{restored}");
    assert_eq!(std::fs::read_to_string(&probe).unwrap(), "value = 1\n");
    assert_eq!(restored["changed_paths"], serde_json::json!(["probe.py"]));
    run_git(repo.path(), &["diff", "--cached", "--exit-code"]);
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
