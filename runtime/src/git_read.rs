//! Read-only Git views and the shared Git process runner.
//!
//! The registered root is resolved in a short transaction; Git itself always runs
//! after that transaction has committed so a slow repository never holds SQLite.
//! Paths in and out are relative to the registered root, even when that root is a
//! subdirectory of the repository.
use crate::{db::Database, workspace_services::root_for};
use anyhow::{anyhow, Context, Result};
use chrono::{TimeZone, Utc};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    ffi::OsStr,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

pub(crate) const LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_LOG_PAGE: usize = 200;
const MAX_GIT_STDERR_BYTES: usize = 64 * 1024;
const POST_EXIT_STDERR_GRACE: Duration = Duration::from_secs(2);
const ZERO_COMMIT: &str = "0000000000000000000000000000000000000000";

/// Failed porcelain pushes need their stdout for structured rejection handling,
/// but their public error text remains Git's historical stderr text.
#[derive(Debug)]
pub(crate) struct PushPorcelainFailure {
    pub stdout: String,
    pub stderr: String,
}

impl std::fmt::Display for PushPorcelainFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "git_failed: {}", self.stderr)
    }
}

impl std::error::Error for PushPorcelainFailure {}

fn send_trace_git_step(args: &[&str]) -> &'static str {
    let mut command = 0;
    while args.get(command) == Some(&"-c") && args.get(command + 1).is_some() {
        command += 2;
    }
    match args.get(command).copied() {
        Some("rev-parse") => "rev-parse",
        Some("status") => "status",
        Some("update-index") => "update-index",
        Some("write-tree") => "write-tree",
        Some("cat-file") => "cat-file",
        Some("diff") => "diff",
        Some("ls-files") => "ls-files",
        _ => "other",
    }
}

fn is_push_command(args: &[&str]) -> bool {
    let mut command = 0;
    while args.get(command) == Some(&"-c") && args.get(command + 1).is_some() {
        command += 2;
    }
    args.get(command) == Some(&"push") && args.contains(&"--porcelain")
}

/// Runs Git with a hard timeout, no terminal prompt and no optional index locks.
/// Returns stdout bytes; a non-zero exit becomes `git_failed: <stderr>`.
pub(crate) fn run_git(
    root: &Path,
    args: &[&str],
    env: &[(&str, &OsStr)],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<Vec<u8>> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(["-c", "core.quotepath=off"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let trace_step = send_trace_git_step(args);
    let trace_timer = crate::send_trace::Timer::start();
    crate::send_trace::emit(
        crate::send_trace::Event::new("review.git.spawn")
            .method("chat.send")
            .step(trace_step),
    );
    #[cfg(test)]
    git_barrier::pass(root);
    let mut child = match command.spawn().context("launching git") {
        Ok(child) => child,
        Err(error) => {
            crate::send_trace::emit(
                crate::send_trace::Event::new("review.git.exit")
                    .method("chat.send")
                    .step(trace_step)
                    .outcome("launch_error")
                    .duration_us(trace_timer.elapsed_us()),
            );
            return Err(error);
        }
    };
    if let Some(input) = stdin {
        let mut pipe = child.stdin.take().ok_or_else(|| anyhow!("git_failed"))?;
        let data = input.to_vec();
        std::thread::spawn(move || {
            let _ = pipe.write_all(&data);
        });
    }
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("git_failed"))?;
    let stderr = child.stderr.take().ok_or_else(|| anyhow!("git_failed"))?;
    let deadline = Instant::now() + timeout;
    let (status, stdout, stderr) = match git_readers(
        &mut child,
        move || read_git_output(stdout),
        stderr,
        usize::MAX,
        deadline,
    ) {
        Ok(result) => result,
        Err(error) => {
            crate::send_trace::emit(
                crate::send_trace::Event::new("review.git.exit")
                    .method("chat.send")
                    .step(trace_step)
                    .outcome(if error.to_string() == "git_timeout" {
                        "timeout"
                    } else {
                        "error"
                    })
                    .duration_us(trace_timer.elapsed_us()),
            );
            return Err(error);
        }
    };
    // Match the former join().unwrap_or_default() if a reader panics.
    let stdout = stdout.unwrap_or_default();
    let stderr = stderr.unwrap_or_default();
    if !status.success() {
        crate::send_trace::emit(
            crate::send_trace::Event::new("review.git.exit")
                .method("chat.send")
                .step(trace_step)
                .outcome("error")
                .duration_us(trace_timer.elapsed_us()),
        );
        // Push porcelain writes its rejection reason to stdout. Preserve it for
        // the push classifier while retaining the historic stderr-only public
        // error for every Git command and non-porcelain push.
        if is_push_command(args) {
            return Err(PushPorcelainFailure {
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                stderr: String::from_utf8_lossy(&stderr).trim().to_owned(),
            }.into());
        }
        return Err(anyhow!("git_failed: {}", String::from_utf8_lossy(&stderr).trim()));
    }
    crate::send_trace::emit(
        crate::send_trace::Event::new("review.git.exit")
            .method("chat.send")
            .step(trace_step)
            .outcome("ok")
            .duration_us(trace_timer.elapsed_us()),
    );
    Ok(stdout)
}

pub(crate) fn git_text(root: &Path, args: &[&str]) -> Result<String> {
    let bytes = run_git(root, args, &[], None, LOCAL_TIMEOUT)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// A test-only barrier on Git invocations of one root. The suites use it to prove
/// that a slow Git never holds the runtime's single database connection (F10/F24
/// follow-up) without a fake executable or a deliberately slow repository. It is
/// never compiled into the product.
#[cfg(test)]
pub(crate) mod git_barrier {
    use std::{
        path::{Path, PathBuf},
        sync::{Condvar, Mutex, MutexGuard, OnceLock},
        time::{Duration, Instant},
    };

    /// A deadlocked Git (a failing assertion) is always released by this bound.
    const MAX_HOLD: Duration = Duration::from_secs(10);

    struct State {
        root: Option<PathBuf>,
        budget: usize,
        held: usize,
        released: bool,
    }

    fn shared() -> &'static (Mutex<State>, Condvar) {
        static SHARED: OnceLock<(Mutex<State>, Condvar)> = OnceLock::new();
        SHARED.get_or_init(|| {
            (
                Mutex::new(State {
                    root: None,
                    budget: 0,
                    held: 0,
                    released: true,
                }),
                Condvar::new(),
            )
        })
    }

    fn lock() -> MutexGuard<'static, State> {
        shared()
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn wait<'a>(state: MutexGuard<'a, State>, timeout: Duration) -> MutexGuard<'a, State> {
        shared()
            .1
            .wait_timeout(state, timeout)
            .map(|(guard, _)| guard)
            .unwrap_or_else(|poisoned| poisoned.into_inner().0)
    }

    /// Holds the next `count` Git invocations that run in `root`.
    pub(crate) fn arm(root: &Path, count: usize) {
        let mut state = lock();
        state.root = Some(root.canonicalize().unwrap_or_else(|_| root.to_path_buf()));
        state.budget = count;
        state.held = 0;
        state.released = false;
    }

    /// Blocks the Git thread while the barrier is armed for its root.
    pub(crate) fn pass(root: &Path) {
        if lock().root.is_none() {
            return;
        }
        let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let mut state = lock();
        if state.root.as_deref() != Some(root.as_path()) || state.budget == 0 || state.released {
            return;
        }
        state.budget -= 1;
        state.held += 1;
        shared().1.notify_all();
        let deadline = Instant::now() + MAX_HOLD;
        while !state.released {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            state = wait(state, remaining);
        }
    }

    /// Waits until `count` Git invocations are held.
    pub(crate) fn wait_held(count: usize, timeout: Duration) -> bool {
        let mut state = lock();
        let deadline = Instant::now() + timeout;
        while state.held < count {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            state = wait(state, remaining);
        }
        true
    }

    /// Releases every held Git invocation and disarms the barrier.
    pub(crate) fn release() {
        let mut state = lock();
        state.budget = 0;
        state.held = 0;
        state.released = true;
        state.root = None;
        shared().1.notify_all();
    }
}

fn remaining_git_budget(deadline: Instant) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| anyhow!("git_timeout"))
}

/// Runs one local Git read within a shared caller-owned deadline.
///
/// Unlike `git_text`, this does not reset the timeout for each command. It is
/// used by review checkpoint discovery so its budget covers the whole sequence,
/// while each command remains capped by the existing local-command timeout.
pub(crate) fn git_text_until(root: &Path, args: &[&str], deadline: Instant) -> Result<String> {
    let timeout = remaining_git_budget(deadline)?.min(LOCAL_TIMEOUT);
    let bytes = run_git(root, args, &[("LC_ALL", OsStr::new("C"))], None, timeout)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Verifies the root is inside a Git work tree and returns the repository
/// prefix of the root (`""` at top level, otherwise `"sub/dir/"`).
pub(crate) fn repo_prefix(root: &Path) -> Result<String> {
    let inside = git_text(root, &["rev-parse", "--is-inside-work-tree"])
        .map_err(|_| anyhow!("git_unavailable"))?;
    if inside.trim() != "true" {
        return Err(anyhow!("git_unavailable"));
    }
    Ok(git_text(root, &["rev-parse", "--show-prefix"])?
        .trim_end_matches(['\r', '\n'])
        .to_owned())
}

/// Converts a repository-relative path to a root-relative one, or None when the
/// path lies outside the registered root.
pub(crate) fn strip_prefix<'a>(prefix: &str, path: &'a str) -> Option<&'a str> {
    path.strip_prefix(prefix).filter(|rest| !rest.is_empty())
}

/// Lexical validation for paths that may no longer exist on disk (history,
/// checkpoints). Existing files must still go through `scoped_path`.
pub(crate) fn validate_relative(path: &str) -> Result<()> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') {
        return Err(anyhow!("invalid_path"));
    }
    let candidate = Path::new(path);
    if candidate.is_absolute()
        || candidate.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(anyhow!("invalid_path"));
    }
    Ok(())
}

/// `<rev>:./path` resolves relative to the registered root rather than the repo top.
pub(crate) fn blob_spec(revision: &str, path: &str) -> String {
    format!("{revision}:./{}", path.replace('\\', "/"))
}

/// Reads a blob, returning None when the path does not exist at that revision.
pub(crate) fn read_blob(root: &Path, revision: &str, path: &str) -> Result<Option<Vec<u8>>> {
    let spec = blob_spec(revision, path);
    if run_git(root, &["cat-file", "-e", &spec], &[], None, LOCAL_TIMEOUT).is_err() {
        return Ok(None);
    }
    let size: usize = git_text(root, &["cat-file", "-s", &spec])?
        .trim()
        .parse()
        .map_err(|_| anyhow!("git_failed"))?;
    if size > MAX_TEXT_BYTES {
        return Err(anyhow!("file_too_large"));
    }
    run_git(root, &["cat-file", "blob", &spec], &[], None, LOCAL_TIMEOUT).map(Some)
}

/// Hashes bytes without materializing the complete value in memory.
pub(crate) fn fingerprint_reader(mut reader: impl Read) -> Result<String> {
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(hex::encode(digest.finalize()));
        }
        digest.update(&buffer[..read]);
    }
}

/// Owns retained stderr while a reader may outlive its caller. Taking a snapshot
/// disables further retention; the detached thread keeps draining the pipe.
struct GitStderrCapture(Arc<Mutex<Option<Vec<u8>>>>);

impl GitStderrCapture {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(Some(Vec::new()))))
    }

    fn take(&self) -> Vec<u8> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
            .unwrap_or_default()
    }
}

impl Drop for GitStderrCapture {
    fn drop(&mut self) {
        let _ = self.take();
    }
}

fn capture_git_stderr(mut reader: impl Read, retained: Arc<Mutex<Option<Vec<u8>>>>, limit: usize) {
    let mut buffer = [0; 8 * 1024];
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let mut retained = retained
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(kept) = retained.as_mut() {
            let remaining = limit.saturating_sub(kept.len());
            kept.extend_from_slice(&buffer[..read.min(remaining)]);
        }
    }
}

fn stop_blob_child(child: &mut Child) {
    if !matches!(child.try_wait(), Ok(Some(_))) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn read_git_output(mut reader: impl Read) -> Vec<u8> {
    let mut bytes = Vec::new();
    let _ = reader.read_to_end(&mut bytes);
    bytes
}

/// Waits for Git and stdout within one deadline. After Git exits, stderr gets
/// only a short grace before returning its snapshot with the real exit status.
/// Disconnected readers retain each caller's existing panic policy.
fn git_readers<O: Send + 'static>(
    child: &mut Child,
    stdout: impl FnOnce() -> O + Send + 'static,
    stderr: impl Read + Send + 'static,
    stderr_limit: usize,
    deadline: Instant,
) -> Result<(ExitStatus, Option<O>, Option<Vec<u8>>)> {
    let (out_tx, out_rx) = mpsc::sync_channel(1);
    let (err_tx, err_rx) = mpsc::sync_channel(1);
    let stderr_capture = GitStderrCapture::new();
    let retained = Arc::clone(&stderr_capture.0);
    // Detached readers may outlive Git when a descendant retains a pipe.
    std::thread::spawn(move || {
        let _ = out_tx.send(stdout());
    });
    std::thread::spawn(move || {
        capture_git_stderr(stderr, retained, stderr_limit);
        let _ = err_tx.send(());
    });
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                stop_blob_child(child);
                return Err(error.into());
            }
        }
        if Instant::now() >= deadline {
            stop_blob_child(child);
            return Err(anyhow!("git_timeout"));
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let stderr_deadline = deadline.min(Instant::now() + POST_EXIT_STDERR_GRACE);
    let stdout = match out_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(value) => Some(value),
        Err(mpsc::RecvTimeoutError::Disconnected) => None,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            stop_blob_child(child);
            return Err(anyhow!("git_timeout"));
        }
    };
    let stderr =
        match err_rx.recv_timeout(stderr_deadline.saturating_duration_since(Instant::now())) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => Some(stderr_capture.take()),
            Err(mpsc::RecvTimeoutError::Disconnected) => None,
        };
    Ok((status, stdout, stderr))
}

fn blob_fingerprint_readers(
    child: &mut Child,
    stdout: impl Read + Send + 'static,
    stderr: impl Read + Send + 'static,
    deadline: Instant,
) -> Result<(ExitStatus, String, Vec<u8>)> {
    let (status, fingerprint, stderr) = git_readers(
        child,
        move || fingerprint_reader(stdout),
        stderr,
        MAX_GIT_STDERR_BYTES,
        deadline,
    )?;
    Ok((
        status,
        fingerprint.ok_or_else(|| anyhow!("git_failed"))??,
        stderr.ok_or_else(|| anyhow!("git_failed"))?,
    ))
}

/// Returns the SHA-256 fingerprint of an object without applying text-size limits.
pub(crate) fn blob_fingerprint(root: &Path, oid: &str) -> Result<String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(["-c", "core.quotepath=off"])
        .args(["cat-file", "blob", oid])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let trace_timer = crate::send_trace::Timer::start();
    crate::send_trace::emit(
        crate::send_trace::Event::new("review.git.spawn")
            .method("chat.send")
            .step("cat-file"),
    );
    #[cfg(test)]
    git_barrier::pass(root);
    let mut child = match command.spawn().context("launching git") {
        Ok(child) => child,
        Err(error) => {
            crate::send_trace::emit(
                crate::send_trace::Event::new("review.git.exit")
                    .method("chat.send")
                    .step("cat-file")
                    .outcome("launch_error")
                    .duration_us(trace_timer.elapsed_us()),
            );
            return Err(error);
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow!("git_failed"));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow!("git_failed"));
        }
    };
    let deadline = Instant::now() + LOCAL_TIMEOUT;
    // A grandchild can retain these pipes after Git exits; readers share Git's deadline.
    let (status, fingerprint, stderr) = match blob_fingerprint_readers(
        &mut child,
        stdout,
        stderr,
        deadline,
    ) {
        Ok(result) => result,
        Err(error) => {
            crate::send_trace::emit(
                crate::send_trace::Event::new("review.git.exit")
                    .method("chat.send")
                    .step("cat-file")
                    .outcome(if error.to_string() == "git_timeout" {
                        "timeout"
                    } else {
                        "error"
                    })
                    .duration_us(trace_timer.elapsed_us()),
            );
            return Err(error);
        }
    };
    if !status.success() {
        crate::send_trace::emit(
            crate::send_trace::Event::new("review.git.exit")
                .method("chat.send")
                .step("cat-file")
                .outcome("error")
                .duration_us(trace_timer.elapsed_us()),
        );
        return Err(anyhow!(
            "git_failed: {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    crate::send_trace::emit(
        crate::send_trace::Event::new("review.git.exit")
            .method("chat.send")
            .step("cat-file")
            .outcome("ok")
            .duration_us(trace_timer.elapsed_us()),
    );
    Ok(fingerprint)
}

/// Text for a diff side; None marks binary content.
pub(crate) fn text_of(bytes: &[u8]) -> Option<String> {
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes.to_vec()).ok()
}

fn has_head(root: &Path) -> bool {
    run_git(
        root,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        &[],
        None,
        LOCAL_TIMEOUT,
    )
    .is_ok()
}

pub fn dispatch(db: &Database, method: &str, params: &Value) -> Result<Option<Value>> {
    if !matches!(
        method,
        "git.branches"
            | "git.log"
            | "git.push.preview"
            | "git.commit.show"
            | "git.commit.diff"
            | "git.blame"
            | "git.stash.list"
            | "git.stash.show"
    ) {
        return Ok(None);
    }
    let object = params
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let project_id = string(object, "projectId")?;
    let worktree = object.get("worktreePath").and_then(Value::as_str);
    let root = db.transaction(|tx| root_for(tx, project_id, worktree))?;
    repo_prefix(&root)?;
    let result = match method {
        "git.branches" => branches(&root)?,
        "git.push.preview" => push_preview(&root)?,
        "git.log" => {
            let path = object.get("path").and_then(Value::as_str);
            if let Some(path) = path {
                validate_relative(path)?;
            }
            let skip = object.get("skip").and_then(Value::as_u64).unwrap_or(0) as usize;
            let limit = object
                .get("limit")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(100)
                .clamp(1, MAX_LOG_PAGE);
            // `all` lists every local/remote branch and tag for the commit graph; file history stays on HEAD.
            let all = path.is_none() && object.get("all").and_then(Value::as_bool).unwrap_or(false);
            log(&root, path, all, skip, limit)?
        }
        "git.commit.show" => commit_show(&root, string(object, "commit")?)?,
        "git.commit.diff" => {
            let path = string(object, "path")?;
            validate_relative(path)?;
            let original = object.get("originalPath").and_then(Value::as_str);
            if let Some(original) = original {
                validate_relative(original)?;
            }
            commit_diff(&root, string(object, "commit")?, path, original)?
        }
        "git.blame" => blame(&root, string(object, "path")?)?,
        "git.stash.list" => json!({"entries": stash_entries(&root)?}),
        "git.stash.show" => stash_show(&root, string(object, "oid")?)?,
        _ => unreachable!(),
    };
    Ok(Some(result))
}

const PUSH_PREVIEW_FORMAT: &str = "--format=%x1e%H%x1f%s%x1f%an%x1f%cI";

/// Resolves the one local destination that an ordinary push would use without
/// contacting the remote. Ambiguous push configuration deliberately fails
/// closed so callers can retain the existing plain-push behavior.
pub(crate) fn push_preview(root: &Path) -> Result<Value> {
    let local_branch = git_text(root, &["symbolic-ref", "--quiet", "HEAD"])
        .map_err(|_| anyhow!("push_preview_unavailable: detached HEAD"))?
        .trim()
        .to_owned();
    let branch = branch_name(&local_branch)
        .filter(|branch| !branch.is_empty())
        .ok_or_else(|| anyhow!("push_preview_unavailable: detached HEAD"))?
        .to_owned();

    let remote = push_remote(root, &branch)?;
    let configured_destination = reject_ambiguous_push_config(root, &remote, &branch)?;
    let upstream = upstream(root, &branch)?;
    let push_default = git_config(root, "push.default");
    let remote_branch = if let Some(destination) = configured_destination {
        if upstream.is_none() {
            return Err(anyhow!("push_preview_unavailable: publish refspec is not compatible with legacy publish"));
        }
        destination
    } else {
        match push_default.as_deref() {
            Some("current") => branch.clone(),
            Some("upstream") => {
                let Some((upstream_remote, upstream_branch)) = upstream.as_ref() else {
                    return Err(anyhow!("push_preview_unavailable: push.default upstream has no upstream"));
                };
                if upstream_remote != &remote {
                    return Err(anyhow!("push_preview_unavailable: upstream remote differs from push remote"));
                }
                branch_name(upstream_branch).expect("upstream is a branch").to_owned()
            }
            None | Some("simple") => match upstream.as_ref() {
                Some((upstream_remote, upstream_branch)) if upstream_remote == &remote && upstream_branch == &format!("refs/heads/{branch}") => branch.clone(),
                // A triangular setup pushes the current branch to its push remote.
                Some((upstream_remote, _)) if upstream_remote != &remote => branch.clone(),
                Some(_) => return Err(anyhow!("push_preview_unavailable: simple push does not map one branch")),
                None => branch.clone(),
            },
            _ => unreachable!("unsupported push.default rejected above"),
        }
    };
    let set_upstream = upstream.is_none();
    if set_upstream && remote != legacy_default_remote(root)? {
        return Err(anyhow!("push_preview_unavailable: configured push remote differs from legacy publish remote"));
    }
    let remote_ref = format!("refs/remotes/{remote}/{remote_branch}");
    let remote_oid = git_text(root, &["rev-parse", "--verify", "--quiet", &remote_ref])
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| full_oid(value));
    let (ahead, behind) = if remote_oid.is_some() {
        let ahead_range = format!("{remote_ref}..HEAD");
        let behind_range = format!("HEAD..{remote_ref}");
        (
            push_preview_commits(root, &[&ahead_range])?,
            push_preview_commits(root, &[&behind_range])?,
        )
    } else {
        let not_remotes = format!("--remotes={remote}");
        (push_preview_commits(root, &["HEAD", "--not", &not_remotes])?, empty_push_range())
    };
    let mut preview = json!({
        "branch": branch,
        "localBranch": local_branch,
        "detached": false,
        "remote": remote,
        "remoteBranch": remote_branch,
        "setUpstream": set_upstream,
        "ahead": ahead,
        "behind": behind,
        "diverged": remote_oid.is_some() && ahead["count"].as_u64().unwrap_or(0) > 0 && behind["count"].as_u64().unwrap_or(0) > 0,
    });
    if let Some((upstream_remote, upstream_branch)) = upstream {
        preview["upstream"] = json!(format!("{upstream_remote}/{}", branch_name(&upstream_branch).expect("upstream is a branch")));
    }
    if let Some(oid) = remote_oid {
        preview["remoteOid"] = json!(oid);
    }
    if let Some(branch) = remote_default_branch(root, preview["remote"].as_str().unwrap()) {
        preview["remoteDefaultBranch"] = json!(branch);
    }
    if let Some(last_fetched) = last_fetched_at(root, preview["remote"].as_str().unwrap(), preview["remoteBranch"].as_str().unwrap()) {
        preview["lastFetchedAt"] = json!(last_fetched);
    }
    Ok(preview)
}

fn legacy_default_remote(root: &Path) -> Result<String> {
    let remotes = git_text(root, &["remote"])?;
    let remotes: Vec<_> = remotes.lines().map(str::trim).filter(|value| !value.is_empty()).collect();
    if remotes.iter().any(|remote| *remote == "origin") {
        Ok("origin".to_owned())
    } else if remotes.len() == 1 {
        Ok(remotes[0].to_owned())
    } else {
        Err(anyhow!("push_preview_unavailable: no unambiguous remote"))
    }
}

fn push_remote(root: &Path, branch: &str) -> Result<String> {
    for key in [
        format!("branch.{branch}.pushRemote"),
        "remote.pushDefault".to_owned(),
        format!("branch.{branch}.remote"),
    ] {
        if let Some(remote) = git_config(root, &key) {
            return Ok(remote);
        }
    }
    let remotes = git_text(root, &["remote"])?;
    let remotes: Vec<_> = remotes.lines().map(str::trim).filter(|value| !value.is_empty()).collect();
    if remotes.iter().any(|remote| *remote == "origin") {
        Ok("origin".to_owned())
    } else if remotes.len() == 1 {
        Ok(remotes[0].to_owned())
    } else {
        Err(anyhow!("push_preview_unavailable: no unambiguous remote"))
    }
}

fn git_config(root: &Path, key: &str) -> Option<String> {
    git_text(root, &["config", "--get", key])
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn upstream(root: &Path, branch: &str) -> Result<Option<(String, String)>> {
    let Some(remote) = git_config(root, &format!("branch.{branch}.remote")) else { return Ok(None); };
    let merges = git_text(root, &["config", "--get-all", &format!("branch.{branch}.merge")]).unwrap_or_default();
    let merges: Vec<_> = merges.lines().map(str::trim).collect();
    let merge = match merges.as_slice() {
        [] => return Ok(None),
        [merge] if !merge.is_empty() => (*merge).to_owned(),
        _ => return Err(anyhow!("push_preview_unavailable: multiple or empty upstream branches")),
    };
    if branch_name(&merge).is_none() {
        return Err(anyhow!("push_preview_unavailable: upstream is not a branch"));
    }
    Ok(Some((remote, merge)))
}

fn branch_name(reference: &str) -> Option<&str> {
    reference.strip_prefix("refs/heads/")
}

fn reject_ambiguous_push_config(root: &Path, remote: &str, branch: &str) -> Result<Option<String>> {
    let push_default = git_config(root, "push.default");
    if !matches!(push_default.as_deref(), None | Some("simple" | "current" | "upstream")) {
        return Err(anyhow!("push_preview_unavailable: push.default does not select one branch"));
    }
    if git_config_bool(root, &format!("remote.{remote}.mirror")) {
        return Err(anyhow!("push_preview_unavailable: remote mirror is configured"));
    }
    if git_config_bool(root, "push.followTags") {
        return Err(anyhow!("push_preview_unavailable: push.followTags is configured"));
    }
    let fetch_refspecs = git_text(root, &["config", "--get-all", &format!("remote.{remote}.fetch")]).unwrap_or_default();
    let expected_fetch = format!("+refs/heads/*:refs/remotes/{remote}/*");
    if fetch_refspecs.lines().map(str::trim).filter(|value| !value.is_empty()).collect::<Vec<_>>() != [expected_fetch.as_str()] {
        return Err(anyhow!("push_preview_unavailable: remote fetch refspec is not standard"));
    }
    let refspecs = git_text(root, &["config", "--get-all", &format!("remote.{remote}.push")]).unwrap_or_default();
    let refspecs: Vec<_> = refspecs.lines().map(str::trim).filter(|value| !value.is_empty()).collect();
    let destination = match refspecs.as_slice() {
        [] => None,
        [refspec] => exact_push_refspec_destination(refspec, branch)
            .ok_or_else(|| anyhow!("push_preview_unavailable: remote push refspec does not select one branch"))
            .map(Some)?,
        _ => return Err(anyhow!("push_preview_unavailable: multiple push refspecs")),
    };
    let urls = git_text(root, &["remote", "get-url", "--push", "--all", remote])
        .map_err(|_| anyhow!("push_preview_unavailable: remote has no push URL"))?;
    let mut urls: Vec<_> = urls.lines().map(str::trim).filter(|value| !value.is_empty()).collect();
    urls.sort_unstable();
    urls.dedup();
    if urls.len() != 1 {
        return Err(anyhow!("push_preview_unavailable: multiple push URLs"));
    }
    let fetch_urls = git_text(root, &["remote", "get-url", "--all", remote]).unwrap_or_default();
    let mut fetch_urls: Vec<_> = fetch_urls.lines().map(str::trim).filter(|value| !value.is_empty()).collect();
    fetch_urls.sort_unstable();
    fetch_urls.dedup();
    if fetch_urls.len() != 1 || fetch_urls[0] != urls[0] {
        return Err(anyhow!("push_preview_unavailable: push URL differs from fetch URL"));
    }
    Ok(destination)
}

fn exact_push_refspec_destination(refspec: &str, branch: &str) -> Option<String> {
    let (source, destination) = refspec.split_once(':')?;
    (source == format!("refs/heads/{branch}") && destination.starts_with("refs/heads/")
        && !destination.contains('*') && !destination.starts_with('+'))
        .then(|| branch_name(destination).expect("destination is a branch").to_owned())
}

fn git_config_bool(root: &Path, key: &str) -> bool {
    git_text(root, &["config", "--bool", "--get", key])
        .ok()
        .is_some_and(|value| value.trim() == "true")
}

fn push_preview_commits(root: &Path, revisions: &[&str]) -> Result<Value> {
    let mut count_args = vec!["rev-list", "--count"];
    count_args.extend_from_slice(revisions);
    let count = git_text(root, &count_args)
        .map_err(|_| anyhow!("push_preview_unavailable: cannot resolve commit range"))?
        .trim()
        .parse::<u64>()
        .map_err(|_| anyhow!("push_preview_unavailable: cannot count commits"))?;
    let mut log_args = vec!["log", PUSH_PREVIEW_FORMAT, "-n50"];
    log_args.extend_from_slice(revisions);
    let commits = parse_push_preview_commits(&git_text(root, &log_args)?);
    Ok(json!({"count": count, "commits": commits}))
}

fn parse_push_preview_commits(output: &str) -> Vec<Value> {
    output.split('\u{1e}').filter_map(|record| {
        let fields: Vec<_> = record.trim_matches(['\r', '\n']).split('\u{1f}').collect();
        (fields.len() == 4 && full_oid(fields[0])).then(|| json!({
            "hash": fields[0], "subject": fields[1], "author": fields[2], "committedAt": fields[3],
        }))
    }).collect()
}

fn empty_push_range() -> Value { json!({"count": 0, "commits": []}) }

fn remote_default_branch(root: &Path, remote: &str) -> Option<String> {
    let head = format!("refs/remotes/{remote}/HEAD");
    if let Ok(value) = git_text(root, &["symbolic-ref", "--quiet", &head]) {
        return value.trim().strip_prefix(&format!("refs/remotes/{remote}/")).map(str::to_owned);
    }
    None
}

fn last_fetched_at(root: &Path, remote: &str, remote_branch: &str) -> Option<String> {
    let reflog = format!("logs/refs/remotes/{remote}/{remote_branch}");
    let path = git_text(root, &["rev-parse", "--git-path", &reflog]).ok()?;
    let path = PathBuf::from(path.trim());
    let path = if path.is_absolute() { path } else { root.join(path) };
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(chrono::DateTime::<Utc>::from(modified).to_rfc3339())
}

fn string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("invalid_request"))
}

const LOG_FORMAT: &str = "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D";

fn parse_commits(output: &str) -> Vec<Value> {
    output
        .split('\u{1e}')
        .filter_map(|record| {
            let record = record.trim_matches(['\r', '\n']);
            if record.is_empty() {
                return None;
            }
            let fields: Vec<&str> = record.split('\u{1f}').collect();
            if fields.len() < 7 {
                return None;
            }
            let refs: Vec<String> = fields[6]
                .split(", ")
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect();
            Some(json!({
                "hash": fields[0],
                "parents": fields[1].split_whitespace().collect::<Vec<_>>(),
                "authorName": fields[2],
                "authorEmail": fields[3],
                "authoredAt": fields[4],
                "subject": fields[5],
                "refs": refs,
            }))
        })
        .collect()
}

/// Commit page for the history view. `--date-order` never lists a parent before all of its children,
/// which the renderer's lane graph relies on. `scope` echoes what was listed so the UI can tell an older
/// runtime (which ignores `all`) from a real current-branch page.
fn log(root: &Path, path: Option<&str>, all: bool, skip: usize, limit: usize) -> Result<Value> {
    let scope = if all { "all" } else { "head" };
    if !has_head(root) {
        return Ok(json!({"commits":[],"hasMore":false,"scope":scope}));
    }
    let skip_arg = format!("--skip={skip}");
    let count_arg = format!("-n{}", limit + 1);
    let mut args = vec!["log", LOG_FORMAT, &skip_arg, &count_arg];
    if path.is_some() {
        args.push("--follow");
    } else {
        args.push("--date-order");
    }
    if all {
        args.extend(["--branches", "--remotes", "--tags"]);
    }
    args.push("HEAD");
    if let Some(path) = path {
        args.push("--");
        args.push(path);
    }
    let mut commits = parse_commits(&git_text(root, &args)?);
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    Ok(json!({"commits":commits,"hasMore":has_more,"scope":scope}))
}

fn resolve_commit(root: &Path, commit: &str) -> Result<String> {
    if commit.len() < 4
        || commit.len() > 64
        || !commit.chars().all(|value| value.is_ascii_hexdigit())
    {
        return Err(anyhow!("invalid_commit"));
    }
    let spec = format!("{commit}^{{commit}}");
    git_text(root, &["rev-parse", "--verify", "--quiet", &spec])
        .map(|value| value.trim().to_owned())
        .map_err(|_| anyhow!("commit_not_found"))
}

fn first_parent(root: &Path, commit: &str) -> Option<String> {
    let spec = format!("{commit}^1");
    git_text(root, &["rev-parse", "--verify", "--quiet", &spec])
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

const STASH_FORMAT: &str = "--format=%H%x1f%P%x1f%s%x1f%ct";

fn stash_subject(subject: &str) -> (String, Option<String>) {
    if let Some(rest) = subject.strip_prefix("On ") {
        if let Some((branch, message)) = rest.split_once(": ") {
            return (message.to_owned(), Some(branch.to_owned()));
        }
    }
    if let Some(rest) = subject.strip_prefix("WIP on ") {
        if let Some((branch, message)) = rest.split_once(": ") {
            return (message.to_owned(), Some(branch.to_owned()));
        }
    }
    (subject.to_owned(), None)
}

fn full_oid(oid: &str) -> bool {
    matches!(oid.len(), 40 | 64) && oid.chars().all(|value| value.is_ascii_hexdigit())
}

/// Lists stashes by immutable commit OID. Their display index is intentionally
/// derived on every read because `stash@{n}` shifts when Git changes the stack.
pub(crate) fn stash_entries(root: &Path) -> Result<Vec<Value>> {
    let output = git_text(root, &["stash", "list", STASH_FORMAT])?;
    let mut entries = output
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let (line, timestamp) = line.rsplit_once('\u{1f}')?;
            let (oid, line) = line.split_once('\u{1f}')?;
            let (parents, subject) = line.split_once('\u{1f}')?;
            if !full_oid(oid) {
                return None;
            }
            let untracked_parent = parents.split_whitespace().nth(2).map(str::to_owned);
            let (message, branch) = stash_subject(subject);
            let mut entry = Map::new();
            entry.insert("oid".into(), json!(oid));
            entry.insert("index".into(), json!(index));
            entry.insert("message".into(), json!(message));
            if let Some(branch) = branch {
                entry.insert("branch".into(), json!(branch));
            }
            entry.insert(
                "createdAt".into(),
                json!(timestamp.parse::<i64>().unwrap_or(0)),
            );
            entry.insert("untracked".into(), json!(false));
            Some((Value::Object(entry), untracked_parent))
        })
        .collect::<Vec<_>>();
    let checks = entries
        .iter()
        .filter_map(|(_, parent)| parent.as_ref())
        .map(|parent| format!("{parent}^{{tree}}\n"))
        .collect::<String>();
    if !checks.is_empty() {
        let sizes = run_git(
            root,
            &["cat-file", "--batch-check=%(objecttype) %(objectsize)"],
            &[],
            Some(checks.as_bytes()),
            LOCAL_TIMEOUT,
        )?;
        for ((entry, _), line) in entries
            .iter_mut()
            .filter(|(_, parent)| parent.is_some())
            .zip(String::from_utf8_lossy(&sizes).lines())
        {
            let size = line
                .split_whitespace()
                .nth(1)
                .and_then(|size| size.parse::<u64>().ok())
                .unwrap_or(0);
            entry["untracked"] = json!(size > 0);
        }
    }
    Ok(entries.into_iter().map(|(entry, _)| entry).collect())
}

/// Resolves a stable stash OID to its current, unstable stack index immediately
/// before a mutation. Git accepts abbreviated revisions, so reject them here.
pub(crate) fn stash_resolve(root: &Path, oid: &str) -> Result<usize> {
    if !full_oid(oid) {
        return Err(anyhow!("stash_not_found"));
    }
    stash_entries(root)?
        .into_iter()
        .find_map(|entry| (entry["oid"] == oid).then(|| entry["index"].as_u64()))
        .flatten()
        .map(|index| index as usize)
        .ok_or_else(|| anyhow!("stash_not_found"))
}

fn stash_show(root: &Path, oid: &str) -> Result<Value> {
    stash_resolve(root, oid)?;
    let parent = format!("{oid}^1");
    let tracked = run_git(
        root,
        &["diff", "--name-status", "-z", &parent, oid, "--"],
        &[],
        None,
        LOCAL_TIMEOUT,
    )?;
    let mut files = parse_name_status(&tracked);
    let untracked_parent = format!("{oid}^3");
    if run_git(
        root,
        &["rev-parse", "--verify", "--quiet", &untracked_parent],
        &[],
        None,
        LOCAL_TIMEOUT,
    )
    .is_ok()
    {
        let untracked = run_git(
            root,
            &["ls-tree", "-r", "--name-only", "-z", &untracked_parent],
            &[],
            None,
            LOCAL_TIMEOUT,
        )?;
        for path in String::from_utf8_lossy(&untracked)
            .split('\0')
            .filter(|path| !path.is_empty())
        {
            files.push(json!({"path":path,"status":"A","untracked":true}));
        }
    }
    Ok(json!({"files":files}))
}

/// Parses `--name-status -z` output into root-relative entries. With
/// `--relative`, Git already strips the registered-root prefix.
pub(crate) fn parse_name_status(output: &[u8]) -> Vec<Value> {
    let text = String::from_utf8_lossy(output);
    let mut fields = text.split('\0').filter(|field| !field.is_empty());
    let mut files = Vec::new();
    while let Some(status) = fields.next() {
        let letter = status.chars().next().unwrap_or('M');
        if matches!(letter, 'R' | 'C') {
            let (Some(original), Some(path)) = (fields.next(), fields.next()) else {
                break;
            };
            files.push(json!({"path":path,"originalPath":original,"status":letter.to_string()}));
        } else if let Some(path) = fields.next() {
            files.push(json!({"path":path,"status":letter.to_string()}));
        }
    }
    files
}

fn commit_show(root: &Path, commit: &str) -> Result<Value> {
    let hash = resolve_commit(root, commit)?;
    let info = parse_commits(&git_text(root, &["log", "-1", LOG_FORMAT, &hash])?)
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("commit_not_found"))?;
    let body = git_text(root, &["log", "-1", "--format=%b", &hash])?;
    let output = match first_parent(root, &hash) {
        Some(parent) => run_git(
            root,
            &[
                "diff-tree",
                "-r",
                "-z",
                "-M",
                "--name-status",
                "--relative",
                &parent,
                &hash,
            ],
            &[],
            None,
            LOCAL_TIMEOUT,
        )?,
        None => run_git(
            root,
            &[
                "diff-tree",
                "--no-commit-id",
                "--root",
                "-r",
                "-z",
                "--name-status",
                "--relative",
                &hash,
            ],
            &[],
            None,
            LOCAL_TIMEOUT,
        )?,
    };
    Ok(json!({"commit":info,"body":body.trim_end(),"files":parse_name_status(&output)}))
}

fn commit_diff(root: &Path, commit: &str, path: &str, original: Option<&str>) -> Result<Value> {
    let hash = resolve_commit(root, commit)?;
    let new = read_blob(root, &hash, path)?;
    let old = match first_parent(root, &hash) {
        Some(parent) => read_blob(root, &parent, original.unwrap_or(path))?,
        None => None,
    };
    if old.is_none() && new.is_none() {
        return Err(anyhow!("path_not_in_commit"));
    }
    let old_text = old.as_deref().map(text_of).unwrap_or(Some(String::new()));
    let new_text = new.as_deref().map(text_of).unwrap_or(Some(String::new()));
    Ok(match (old_text, new_text) {
        (Some(old), Some(new)) => {
            json!({"path":path,"oldText":old,"newText":new,"binary":false})
        }
        _ => json!({"path":path,"oldText":"","newText":"","binary":true}),
    })
}

fn blame(root: &Path, path: &str) -> Result<Value> {
    let file = crate::workspace_services::scoped_path(root, path, true)?;
    let bytes = std::fs::read(&file)?;
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(anyhow!("file_too_large"));
    }
    if text_of(&bytes).is_none() {
        return Err(anyhow!("binary_file"));
    }
    let line_count = if bytes.is_empty() {
        0
    } else {
        bytes.iter().filter(|byte| **byte == b'\n').count() + usize::from(!bytes.ends_with(b"\n"))
    };
    let uncommitted = || json!({"path":path,"ranges":[{"start":1,"count":line_count.max(1),"commit":""}],"commits":{}});
    if !has_head(root) {
        return Ok(uncommitted());
    }
    let output = match run_git(
        root,
        &["blame", "--porcelain", "--", path],
        &[],
        None,
        LOCAL_TIMEOUT,
    ) {
        Ok(output) => output,
        // Untracked files have no history; every line is uncommitted.
        Err(error) if error.to_string().contains("no such path") => return Ok(uncommitted()),
        Err(error) => return Err(error),
    };
    let text = String::from_utf8_lossy(&output);
    let mut commits: Map<String, Value> = Map::new();
    let mut pending: HashMap<String, (String, i64, String)> = HashMap::new();
    let mut ranges: Vec<(usize, usize, String)> = Vec::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        if line.starts_with('\t') {
            continue;
        }
        let mut parts = line.split(' ');
        let head = parts.next().unwrap_or_default();
        if head.len() >= 40 && head.chars().all(|value| value.is_ascii_hexdigit()) {
            let _original = parts.next();
            // Porcelain output repeats a header for every final line, so each
            // header contributes exactly one line regardless of the group size.
            let Some(final_line) = parts.next().and_then(|value| value.parse::<usize>().ok())
            else {
                continue;
            };
            let commit = if head == ZERO_COMMIT {
                String::new()
            } else {
                head.to_owned()
            };
            match ranges.last_mut() {
                Some(last) if last.2 == commit && last.0 + last.1 == final_line => last.1 += 1,
                _ => ranges.push((final_line, 1, commit)),
            }
            current = Some(head.to_owned());
            continue;
        }
        let Some(commit) = current.as_ref() else {
            continue;
        };
        let entry = pending
            .entry(commit.clone())
            .or_insert_with(|| (String::new(), 0, String::new()));
        let rest = line.split_once(' ').map(|(_, value)| value).unwrap_or("");
        match head {
            "author" => entry.0 = rest.to_owned(),
            "author-time" => entry.1 = rest.parse().unwrap_or(0),
            "summary" => entry.2 = rest.to_owned(),
            _ => {}
        }
    }
    for (hash, (author, time, summary)) in pending {
        if hash == ZERO_COMMIT {
            continue;
        }
        let authored = Utc
            .timestamp_opt(time, 0)
            .single()
            .map(|value| value.to_rfc3339())
            .unwrap_or_default();
        commits.insert(
            hash,
            json!({"authorName":author,"authoredAt":authored,"summary":summary}),
        );
    }
    Ok(json!({
        "path": path,
        "ranges": ranges.into_iter().map(|(start,count,commit)| json!({"start":start,"count":count,"commit":commit})).collect::<Vec<_>>(),
        "commits": commits,
    }))
}

fn branches(root: &Path) -> Result<Value> {
    let worktrees = branch_worktrees(root)?;
    let current = git_text(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let detached = current.is_none() && has_head(root);
    let format = "--format=%(refname)%1f%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(objectname)%1f%(contents:subject)%1f%(committerdate:iso-strict)";
    let output = git_text(
        root,
        &["for-each-ref", format, "refs/heads", "refs/remotes"],
    )?;
    let mut branches = Vec::new();
    for line in output.lines() {
        let fields: Vec<&str> = line.split('\u{1f}').collect();
        if fields.len() < 8 {
            continue;
        }
        let full = fields[0];
        let remote = full.starts_with("refs/remotes/");
        if remote && full.ends_with("/HEAD") {
            continue;
        }
        let mut branch = Map::new();
        branch.insert("name".into(), json!(fields[1]));
        branch.insert("remote".into(), json!(remote));
        branch.insert("current".into(), json!(fields[2] == "*"));
        if !remote && fields[2] != "*" {
            if let Some(owner) = worktrees.get(full) {
                branch.insert("worktreePath".into(), json!(owner.path));
                if owner.missing { branch.insert("worktreeMissing".into(), json!(true)); }
            }
        }
        if !fields[3].is_empty() {
            branch.insert("upstream".into(), json!(fields[3]));
        }
        let track = fields[4];
        if track == "gone" {
            branch.insert("gone".into(), json!(true));
        } else {
            for part in track.split(", ") {
                if let Some(value) = part.strip_prefix("ahead ") {
                    branch.insert("ahead".into(), json!(value.parse::<i64>().unwrap_or(0)));
                } else if let Some(value) = part.strip_prefix("behind ") {
                    branch.insert("behind".into(), json!(value.parse::<i64>().unwrap_or(0)));
                }
            }
        }
        branch.insert(
            "lastCommit".into(),
            json!({"hash":fields[5],"subject":fields[6],"committedAt":fields[7]}),
        );
        branches.push(Value::Object(branch));
    }
    Ok(json!({"current":current,"detached":detached,"branches":branches}))
}

pub(crate) struct BranchWorktree {
    pub path: String,
    pub missing: bool,
}

pub(crate) fn worktree_identity(path: &str) -> String {
    let path = plain_path(Path::new(path)).to_string_lossy().replace('\\', "/");
    let path = path.trim_end_matches('/');
    if cfg!(windows) { path.to_lowercase() } else { path.to_owned() }
}

/// Listed paths may be missing; never canonicalize them to identify an owner.
pub(crate) fn branch_worktrees(root: &Path) -> Result<HashMap<String, BranchWorktree>> {
    let raw = git_text(root, &["-c", "core.quotePath=false", "worktree", "list", "--porcelain"])?;
    let mut branches = HashMap::new();
    for record in raw.split("\n\n") {
        let mut path = None;
        let mut branch = None;
        let mut prunable = false;
        for field in record.lines() {
            if let Some(value) = field.strip_prefix("worktree ") { path = Some(value); }
            else if let Some(value) = field.strip_prefix("branch ") { branch = Some(value); }
            else if field == "prunable" || field.starts_with("prunable ") { prunable = true; }
        }
        if let (Some(path), Some(branch)) = (path, branch) {
            branches.insert(branch.to_owned(), BranchWorktree { path:path.to_owned(), missing:prunable || !Path::new(path).is_dir() });
        }
    }
    Ok(branches)
}

/// Removes the Windows verbatim prefix that `canonicalize` adds; Git and Shell
/// APIs misread verbatim paths (Git sees `//?/C:/...`).
pub(crate) fn plain_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

/// Absolute repository metadata used by checkpoints.
pub(crate) struct RepoPaths {
    pub top: PathBuf,
    pub index: PathBuf,
    pub common: PathBuf,
}

/// Resolves the repository prefix and metadata paths under one shared deadline.
/// Existing callers of `repo_prefix` and `repo_paths` retain their independent
/// 30-second local-command budgets.
pub(crate) fn repo_paths_until(root: &Path, deadline: Instant) -> Result<(String, RepoPaths)> {
    // Git can print all five metadata values in one invocation. Repeating the
    // same discovery multiplies process-start cost before every agent turn.
    // Line-bearing paths keep the prior individual-command representation.
    if root.as_os_str().to_string_lossy().contains(['\r', '\n']) {
        return repo_paths_until_separate(root, deadline);
    }
    let output = match git_text_until(root, &[
        "rev-parse", "--is-inside-work-tree", "--show-prefix", "--show-toplevel",
        "--git-path", "index", "--git-common-dir",
    ], deadline) {
        Ok(output) => output,
        Err(error) if error.to_string().contains("not a git repository")
            || error.to_string().contains("must be run in a work tree") => {
            return Err(anyhow!("git_unavailable"));
        }
        Err(error) => return Err(error),
    };
    let fields: Vec<_> = output.lines().collect();
    if fields.first().map(|value| value.trim()) != Some("true") {
        return Err(anyhow!("git_unavailable"));
    }
    // A repository's separately located metadata may itself contain a newline.
    // Do not guess field boundaries or silently return incorrect Git paths.
    if fields.len() != 5 || fields[2..].iter().any(|value| value.is_empty()) {
        return repo_paths_until_separate(root, deadline);
    }
    let absolute = |value: &str| {
        let path = PathBuf::from(value);
        if path.is_absolute() { path } else { root.join(path) }
    };
    Ok((fields[1].to_owned(), RepoPaths {
        top: PathBuf::from(fields[2]), index: absolute(fields[3]), common: absolute(fields[4]),
    }))
}

fn repo_paths_until_separate(root: &Path, deadline: Instant) -> Result<(String, RepoPaths)> {
    let inside = match git_text_until(root, &["rev-parse", "--is-inside-work-tree"], deadline) {
        Ok(inside) => inside,
        Err(error) if error.to_string().contains("not a git repository") => {
            return Err(anyhow!("git_unavailable"));
        }
        Err(error) => return Err(error),
    };
    if inside.trim() != "true" {
        return Err(anyhow!("git_unavailable"));
    }
    let prefix = git_text_until(root, &["rev-parse", "--show-prefix"], deadline)?
        .trim_end_matches(['\r', '\n'])
        .to_owned();
    let top = PathBuf::from(
        git_text_until(root, &["rev-parse", "--show-toplevel"], deadline)?
            .trim_end_matches(['\r', '\n']),
    );
    let absolute = |value: String| {
        let path = PathBuf::from(value.trim_end_matches(['\r', '\n']));
        if path.is_absolute() {
            path
        } else {
            root.join(path)
        }
    };
    let index = absolute(git_text_until(
        root,
        &["rev-parse", "--git-path", "index"],
        deadline,
    )?);
    let common = absolute(git_text_until(
        root,
        &["rev-parse", "--git-common-dir"],
        deadline,
    )?);
    Ok((prefix, RepoPaths { top, index, common }))
}

#[allow(dead_code)] // Retained for callers that need independent per-command local timeouts.
pub(crate) fn repo_paths(root: &Path) -> Result<RepoPaths> {
    repo_prefix(root)?;
    let top = PathBuf::from(
        git_text(root, &["rev-parse", "--show-toplevel"])?.trim_end_matches(['\r', '\n']),
    );
    let absolute = |value: String| {
        let path = PathBuf::from(value.trim_end_matches(['\r', '\n']));
        if path.is_absolute() {
            path
        } else {
            root.join(path)
        }
    };
    let index = absolute(git_text(root, &["rev-parse", "--git-path", "index"])?);
    let common = absolute(git_text(root, &["rev-parse", "--git-common-dir"])?);
    Ok(RepoPaths { top, index, common })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_services::git;
    use std::fs;

    #[test]
    fn send_trace_classifies_commands_after_command_scope_config() {
        assert_eq!(
            send_trace_git_step(&[
                "-c",
                "core.splitIndex=false",
                "-c",
                "core.quotepath=off",
                "update-index",
            ]),
            "update-index"
        );
        assert_eq!(send_trace_git_step(&["status"]), "status");
    }

    #[test]
    fn shared_deadline_refuses_expired_git_without_starting_a_command() {
        let missing = Path::new("this-path-must-not-exist");
        let error = git_text_until(missing, &["rev-parse", "--show-toplevel"], Instant::now())
            .unwrap_err();
        assert_eq!(error.to_string(), "git_timeout");
    }

    // Use Git's shell to kill its background PID, including the MSYS PID on Windows.
    struct HeldGitPipe(tempfile::TempDir);

    impl HeldGitPipe {
        fn new() -> Self {
            Self(tempfile::tempdir().unwrap())
        }
    }

    impl Drop for HeldGitPipe {
        fn drop(&mut self) {
            let mut command = Command::new("git");
            command
                .arg("-C")
                .arg(self.0.path())
                .args(["-c", "alias.release=!kill $(cat held.pid)", "release"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000);
            }
            let _ = command.status();
        }
    }

    #[test]
    fn run_git_deadline_survives_exited_git_with_held_stderr() {
        let held = HeldGitPipe::new();
        let started = Instant::now();
        let stdout = run_git(
            held.0.path(),
            &["-c", "alias.hold=!sleep 30 </dev/null >/dev/null & echo $! > held.pid; printf 'git stdout'; printf 'before exit' >&2", "hold"],
            &[], None, Duration::from_secs(10),
        ).unwrap();
        assert_eq!(stdout, b"git stdout");
        assert!(held.0.path().join("held.pid").is_file());
        assert!(started.elapsed() < Duration::from_millis(2750));
    }

    #[test]
    fn run_git_preserves_failed_exit_and_partial_held_stderr() {
        let held = HeldGitPipe::new();
        let started = Instant::now();
        let error = run_git(
            held.0.path(),
            &["-c", "alias.hold=!sleep 30 </dev/null >/dev/null & echo $! > held.pid; printf '%070000d' 0 >&2; printf 'before exit' >&2; exit 7", "hold"],
            &[], None, Duration::from_secs(10),
        ).unwrap_err();
        assert_eq!(
            error.to_string(),
            format!("git_failed: {}before exit", "0".repeat(70_000))
        );
        assert!(held.0.path().join("held.pid").is_file());
        assert!(started.elapsed() < Duration::from_millis(2750));
    }

    #[test]
    fn run_git_still_times_out_when_exited_git_has_held_stdout() {
        let held = HeldGitPipe::new();
        let started = Instant::now();
        let error = run_git(
            held.0.path(),
            &[
                "-c",
                "alias.hold=!sleep 30 </dev/null 2>/dev/null & echo $! > held.pid",
                "hold",
            ],
            &[],
            None,
            Duration::from_millis(500),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "git_timeout");
        assert!(held.0.path().join("held.pid").is_file());
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn blob_fingerprint_reader_deadline_survives_exited_git_with_held_stderr() {
        struct HeldStderr {
            prefix: std::io::Cursor<Vec<u8>>,
            started: std::sync::mpsc::Sender<()>,
            release: std::sync::mpsc::Receiver<()>,
        }

        impl Read for HeldStderr {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let read = self.prefix.read(buffer)?;
                if read != 0 {
                    return Ok(read);
                }
                let _ = self.started.send(());
                let _ = self.release.recv_timeout(Duration::from_secs(10));
                Ok(0)
            }
        }

        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd");
            command.args(["/C", "exit 0"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "exit 0"]);
            command
        };
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn().unwrap();
        child.wait().unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let started = Instant::now();
        let (status, fingerprint, stderr) = blob_fingerprint_readers(
            &mut child,
            std::io::Cursor::new(b"blob stdout".to_vec()),
            HeldStderr {
                prefix: std::io::Cursor::new(vec![b'e'; MAX_GIT_STDERR_BYTES + 1024]),
                started: started_tx,
                release: release_rx,
            },
            Instant::now() + Duration::from_millis(100),
        )
        .unwrap();
        assert!(status.success());
        assert_eq!(fingerprint, hex::encode(Sha256::digest(b"blob stdout")));
        assert_eq!(stderr, vec![b'e'; MAX_GIT_STDERR_BYTES]);
        assert!(started_rx.recv_timeout(Duration::from_secs(1)).is_ok());
        assert!(started.elapsed() < Duration::from_secs(1));
        let _ = release_tx.send(());
    }

    #[test]
    fn grouped_repository_discovery_matches_individual_reads_and_preserves_empty_prefix() {
        let temp = repo();
        let nested = temp.path().join("nested folder").join("second");
        fs::create_dir_all(&nested).unwrap();
        for root in [temp.path(), nested.as_path()] {
            let (prefix, actual) = repo_paths_until(root, Instant::now() + LOCAL_TIMEOUT).unwrap();
            let expected = repo_paths(root).unwrap();
            assert_eq!(prefix, repo_prefix(root).unwrap());
            assert_eq!(actual.top, expected.top);
            assert_eq!(actual.index, expected.index);
            assert_eq!(actual.common, expected.common);
        }
        assert_eq!(repo_paths_until(temp.path(), Instant::now() + LOCAL_TIMEOUT).unwrap().0, "");
    }

    #[test]
    fn grouped_repository_discovery_distinguishes_linked_worktree_index_and_common_objects() {
        let temp = repo();
        git(temp.path(), &["commit", "--allow-empty", "-qm", "initial"]).unwrap();
        let linked_parent = tempfile::tempdir().unwrap();
        let linked = linked_parent.path().join("linked folder");
        git(temp.path(), &["worktree", "add", "-b", "linked", linked.to_str().unwrap()]).unwrap();
        let (_, actual) = repo_paths_until(&linked, Instant::now() + LOCAL_TIMEOUT).unwrap();
        let expected = repo_paths(&linked).unwrap();
        assert_eq!(actual.top, expected.top);
        assert_eq!(actual.index, expected.index);
        assert_eq!(actual.common, expected.common);
        assert_eq!(actual.common.canonicalize().unwrap(), temp.path().join(".git").canonicalize().unwrap());
        assert_ne!(actual.index.parent(), Some(actual.common.as_path()));
    }

    #[test]
    fn grouped_repository_discovery_preserves_non_repository_bare_and_expired_budget_errors() {
        let ordinary = tempfile::tempdir().unwrap();
        assert_eq!(repo_paths_until(ordinary.path(), Instant::now() + LOCAL_TIMEOUT).err().unwrap().to_string(), "git_unavailable");
        let bare = tempfile::tempdir().unwrap();
        git(bare.path(), &["init", "--bare", "-q"]).unwrap();
        assert_eq!(repo_paths_until(bare.path(), Instant::now() + LOCAL_TIMEOUT).err().unwrap().to_string(), "git_unavailable");
        assert_eq!(repo_paths_until(ordinary.path(), Instant::now()).err().unwrap().to_string(), "git_timeout");
    }

    #[cfg(unix)]
    #[test]
    fn grouped_repository_discovery_preserves_line_bearing_paths_with_separate_reads() {
        let temp = repo();
        let nested = temp.path().join("folder\nwith line");
        fs::create_dir_all(&nested).unwrap();
        let (prefix, actual) = repo_paths_until(&nested, Instant::now() + LOCAL_TIMEOUT).unwrap();
        let expected = repo_paths(&nested).unwrap();
        assert_eq!(prefix, repo_prefix(&nested).unwrap());
        assert_eq!(actual.top, expected.top);
        assert_eq!(actual.index, expected.index);
        assert_eq!(actual.common, expected.common);
    }

    pub(crate) fn repo() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "-q", "-b", "main"]).unwrap();
        git(temp.path(), &["config", "user.email", "qa@example.test"]).unwrap();
        git(temp.path(), &["config", "user.name", "QA"]).unwrap();
        git(temp.path(), &["config", "core.autocrlf", "false"]).unwrap();
        temp
    }

    #[test]
    fn stash_reads_use_stable_oids_and_include_untracked_files() {
        let temp = repo();
        fs::write(temp.path().join("tracked.txt"), "base\n").unwrap();
        git(temp.path(), &["add", "."]).unwrap();
        git(temp.path(), &["commit", "-qm", "base"]).unwrap();

        fs::write(temp.path().join("tracked.txt"), "first\n").unwrap();
        fs::write(temp.path().join("untracked.txt"), "first\n").unwrap();
        git(
            temp.path(),
            &["stash", "push", "--include-untracked", "-qm", "first stash"],
        )
        .unwrap();
        let first = stash_entries(temp.path()).unwrap().remove(0);
        let first_oid = first["oid"].as_str().unwrap().to_owned();
        assert_eq!(first["message"], "first stash");
        assert_eq!(first["branch"], "main");
        assert_eq!(first["untracked"], true);
        assert!(first["createdAt"].is_i64() || first["createdAt"].is_u64());

        fs::write(temp.path().join("tracked.txt"), "second\n").unwrap();
        git(
            temp.path(),
            &["stash", "push", "--include-untracked", "-qm", "second stash"],
        )
        .unwrap();
        assert_eq!(stash_entries(temp.path()).unwrap()[0]["untracked"], false);
        assert_eq!(stash_resolve(temp.path(), &first_oid).unwrap(), 1);
        assert_eq!(
            stash_resolve(temp.path(), "aabbccddeeff00112233445566778899aabbccdd")
                .unwrap_err()
                .to_string(),
            "stash_not_found"
        );
        assert_eq!(
            stash_resolve(temp.path(), &first_oid[..8])
                .unwrap_err()
                .to_string(),
            "stash_not_found"
        );

        let shown = stash_show(temp.path(), &first_oid).unwrap();
        assert!(shown["files"]
            .as_array()
            .unwrap()
            .contains(&json!({"path":"tracked.txt","status":"M"})));
        assert!(shown["files"]
            .as_array()
            .unwrap()
            .contains(&json!({"path":"untracked.txt","status":"A","untracked":true})));

        let external_message = format!("external{}stash", '\u{1f}');
        fs::write(temp.path().join("tracked.txt"), "external\n").unwrap();
        git(
            temp.path(),
            &["stash", "push", "-qm", external_message.as_str()],
        )
        .unwrap();
        let external = stash_entries(temp.path()).unwrap().remove(0);
        let external_oid = external["oid"].as_str().unwrap();
        assert_eq!(external["message"], external_message);
        assert_eq!(stash_resolve(temp.path(), external_oid).unwrap(), 0);
        assert!(stash_show(temp.path(), external_oid).unwrap()["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["path"] == "tracked.txt"));
    }

    #[test]
    fn stash_subject_separates_default_branch_prefixes() {
        assert_eq!(
            stash_subject("On main: work"),
            ("work".into(), Some("main".into()))
        );
        assert_eq!(
            stash_subject("WIP on feature: abc123 work"),
            ("abc123 work".into(), Some("feature".into()))
        );
        assert_eq!(
            stash_subject("saved externally"),
            ("saved externally".into(), None)
        );
    }

    #[test]
    fn log_show_diff_and_blame_follow_real_history() {
        let temp = repo();
        fs::create_dir(temp.path().join("sub")).unwrap();
        fs::write(temp.path().join("sub").join("a.txt"), "one\ntwo\n").unwrap();
        git(temp.path(), &["add", "."]).unwrap();
        git(temp.path(), &["commit", "-qm", "first"]).unwrap();
        fs::write(temp.path().join("sub").join("a.txt"), "one\n2\nthree\n").unwrap();
        git(temp.path(), &["commit", "-qam", "second"]).unwrap();
        fs::write(
            temp.path().join("sub").join("a.txt"),
            "one\n2\nthree\nlocal\n",
        )
        .unwrap();

        let root = temp.path().join("sub");
        let history = log(&root, Some("a.txt"), false, 0, 1).unwrap();
        assert_eq!(history["commits"].as_array().unwrap().len(), 1);
        assert_eq!(history["commits"][0]["subject"], "second");
        assert_eq!(history["hasMore"], true);

        let hash = history["commits"][0]["hash"].as_str().unwrap().to_owned();
        let shown = commit_show(&root, &hash).unwrap();
        assert_eq!(shown["files"], json!([{"path":"a.txt","status":"M"}]));
        let diff = commit_diff(&root, &hash, "a.txt", None).unwrap();
        assert_eq!(diff["oldText"], "one\ntwo\n");
        assert_eq!(diff["newText"], "one\n2\nthree\n");

        let blame = blame(&root, "a.txt").unwrap();
        let ranges = blame["ranges"].as_array().unwrap();
        let total: u64 = ranges
            .iter()
            .map(|range| range["count"].as_u64().unwrap())
            .sum();
        assert_eq!(total, 4);
        assert_eq!(ranges.last().unwrap()["commit"], "");
        assert_eq!(ranges.first().unwrap()["start"], 1);
        assert!(!blame["commits"].as_object().unwrap().is_empty());

        assert!(resolve_commit(&root, "--all").is_err());
        assert!(commit_diff(&root, &hash, "missing.txt", None).is_err());
    }

    #[test]
    fn log_lists_current_branch_or_all_branches_children_first() {
        let temp = repo();
        let commit = |name: &str| {
            fs::write(temp.path().join(format!("{name}.txt")), name).unwrap();
            git(temp.path(), &["add", "."]).unwrap();
            git(temp.path(), &["commit", "-qm", name]).unwrap();
        };
        commit("base");
        git(temp.path(), &["switch", "-qc", "feature"]).unwrap();
        commit("feature-work");
        git(temp.path(), &["tag", "v1"]).unwrap();
        git(temp.path(), &["switch", "-q", "main"]).unwrap();
        commit("main-work");
        let subjects = |value: &Value| -> Vec<String> {
            value["commits"]
                .as_array()
                .unwrap()
                .iter()
                .map(|commit| commit["subject"].as_str().unwrap().to_owned())
                .collect()
        };

        let head = log(temp.path(), None, false, 0, 10).unwrap();
        assert_eq!(head["scope"], "head");
        assert_eq!(subjects(&head), vec!["main-work", "base"]);

        let all = log(temp.path(), None, true, 0, 10).unwrap();
        assert_eq!(all["scope"], "all");
        let listed = subjects(&all);
        assert_eq!(listed.len(), 3);
        assert!(listed.contains(&"feature-work".to_owned()));
        // Children before parents: the shared base commit comes last.
        assert_eq!(listed.last().unwrap(), "base");
        let feature = all["commits"]
            .as_array()
            .unwrap()
            .iter()
            .find(|commit| commit["subject"] == "feature-work")
            .unwrap();
        let refs = feature["refs"].as_array().unwrap();
        assert!(refs.iter().any(|value| value == "feature"));
        assert!(refs.iter().any(|value| value == "tag: v1"));

        // File history ignores `all` at dispatch; the paged HEAD listing keeps working.
        let page = log(temp.path(), None, true, 1, 1).unwrap();
        assert_eq!(page["commits"].as_array().unwrap().len(), 1);
        assert_eq!(page["hasMore"], true);
    }

    #[test]
    fn branches_report_current_upstream_and_unborn_repositories() {
        let temp = repo();
        assert_eq!(
            log(temp.path(), None, false, 0, 10).unwrap()["commits"],
            json!([])
        );
        fs::write(temp.path().join("a.txt"), "a").unwrap();
        git(temp.path(), &["add", "."]).unwrap();
        git(temp.path(), &["commit", "-qm", "init"]).unwrap();
        git(temp.path(), &["branch", "feature"]).unwrap();
        let value = branches(temp.path()).unwrap();
        assert_eq!(value["current"], "main");
        assert_eq!(value["detached"], false);
        let names: Vec<&str> = value["branches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|branch| branch["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["feature", "main"]);
    }

    #[test]
    fn name_status_parser_handles_renames_and_cjk_paths() {
        let parsed = parse_name_status("R100\0old name.txt\0新 文件.txt\0M\0b.txt\0".as_bytes());
        assert_eq!(parsed[0]["originalPath"], "old name.txt");
        assert_eq!(parsed[0]["path"], "新 文件.txt");
        assert_eq!(parsed[1]["status"], "M");
    }

    #[test]
    fn push_preview_refuses_multiple_configured_upstreams() {
        let temp = repo();
        git(temp.path(), &["config", "branch.main.remote", "origin"]).unwrap();
        for merge in ["refs/heads/main", "refs/heads/other"] {
            git(temp.path(), &["config", "--add", "branch.main.merge", merge]).unwrap();
        }
        assert_eq!(
            upstream(temp.path(), "main").unwrap_err().to_string(),
            "push_preview_unavailable: multiple or empty upstream branches"
        );
    }

    #[test]
    fn push_preview_reads_local_tracking_state_and_refuses_detached_head() {
        let temp = repo();
        let root = temp.path();
        fs::write(root.join("a.txt"), "base\n").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-qm", "base"]).unwrap();
        let origin = tempfile::tempdir().unwrap();
        git(origin.path(), &["init", "--bare", "-q"]).unwrap();
        git(root, &["remote", "add", "origin", origin.path().to_str().unwrap()]).unwrap();
        git(root, &["push", "-qu", "origin", "main"]).unwrap();
        git(origin.path(), &["symbolic-ref", "HEAD", "refs/heads/main"]).unwrap();

        for subject in ["local one", "local two"] {
            fs::write(root.join("a.txt"), format!("{subject}\n")).unwrap();
            git(root, &["commit", "-qam", subject]).unwrap();
        }
        let ahead = push_preview(root).unwrap();
        assert_eq!(ahead["remote"], "origin");
        assert_eq!(ahead["remoteBranch"], "main");
        assert_eq!(ahead["ahead"]["count"], 2);
        assert_eq!(ahead["behind"]["count"], 0);
        assert_eq!(ahead["ahead"]["commits"].as_array().unwrap().len(), 2);
        assert!(ahead["remoteOid"].as_str().unwrap().len() == 40);

        let backup = tempfile::tempdir().unwrap();
        git(backup.path(), &["init", "--bare", "-q"]).unwrap();
        git(root, &["remote", "add", "backup", backup.path().to_str().unwrap()]).unwrap();
        git(root, &["push", "-q", "backup", "main:main"]).unwrap();
        git(root, &["fetch", "-q", "backup"]).unwrap();
        let backup_reflog = git(root, &["rev-parse", "--git-path", "logs/refs/remotes/backup/main"])
            .unwrap();
        let backup_reflog = PathBuf::from(backup_reflog.trim());
        let backup_reflog = if backup_reflog.is_absolute() { backup_reflog } else { root.join(backup_reflog) };
        let backup_fetched_at = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        fs::File::options().write(true).open(backup_reflog).unwrap()
            .set_times(fs::FileTimes::new().set_modified(backup_fetched_at)).unwrap();
        git(root, &["config", "branch.main.pushRemote", "backup"]).unwrap();
        git(root, &["fetch", "-q", "origin"]).unwrap();
        let triangular = push_preview(root).unwrap();
        assert_eq!(triangular["remote"], "backup");
        assert_eq!(triangular["remoteBranch"], "main");
        assert_eq!(triangular["setUpstream"], false);
        let last_fetched = chrono::DateTime::parse_from_rfc3339(triangular["lastFetchedAt"].as_str().unwrap()).unwrap();
        assert!(last_fetched.timestamp() < chrono::Utc::now().timestamp() - 30, "an origin FETCH_HEAD is not freshness for backup");
        git(root, &["config", "--unset", "branch.main.pushRemote"]).unwrap();

        let peer = tempfile::tempdir().unwrap();
        git(peer.path(), &["clone", "-q", origin.path().to_str().unwrap(), "."]).unwrap();
        git(peer.path(), &["config", "user.email", "peer@example.test"]).unwrap();
        git(peer.path(), &["config", "user.name", "Peer"]).unwrap();
        fs::write(peer.path().join("peer.txt"), "peer\n").unwrap();
        git(peer.path(), &["add", "."]).unwrap();
        git(peer.path(), &["commit", "-qm", "peer"]).unwrap();
        git(peer.path(), &["push", "-q"]).unwrap();
        git(root, &["fetch", "-q", "origin"]).unwrap();
        let diverged = push_preview(root).unwrap();
        assert_eq!(diverged["ahead"]["count"], 2);
        assert_eq!(diverged["behind"]["count"], 1);
        assert_eq!(diverged["diverged"], true);

        git(root, &["switch", "-qc", "feature"]).unwrap();
        fs::write(root.join("feature.txt"), "feature\n").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-qm", "feature"]).unwrap();
        let publish = push_preview(root).unwrap();
        assert_eq!(publish["setUpstream"], true);
        assert_eq!(publish["remoteBranch"], "feature");
        assert!(publish.get("remoteOid").is_none());

        git(root, &["config", "branch.feature.pushRemote", "backup"]).unwrap();
        assert!(push_preview(root).is_err(), "new branches keep legacy publish destination");
        git(root, &["config", "--unset", "branch.feature.pushRemote"]).unwrap();
        git(root, &["checkout", "--detach", "-q"]).unwrap();
        assert_eq!(push_preview(root).unwrap_err().to_string(), "push_preview_unavailable: detached HEAD");
    }

    #[test]
    fn push_preview_uses_full_head_ref_and_strips_branch_prefix_once() {
        let temp = repo();
        let root = temp.path();
        fs::write(root.join("a.txt"), "base\n").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-qm", "base"]).unwrap();
        git(root, &["tag", "main"]).unwrap();
        let origin = tempfile::tempdir().unwrap();
        git(origin.path(), &["init", "--bare", "-q"]).unwrap();
        git(root, &["remote", "add", "origin", origin.path().to_str().unwrap()]).unwrap();
        git(root, &["push", "-qu", "origin", "refs/heads/main:refs/heads/main"]).unwrap();
        git(root, &["push", "-q", "origin", "refs/heads/main:refs/heads/refs/heads/main"]).unwrap();
        git(root, &["fetch", "-q", "origin"]).unwrap();
        git(root, &["config", "branch.main.merge", "refs/heads/refs/heads/main"]).unwrap();
        git(root, &["config", "push.default", "upstream"]).unwrap();

        let preview = push_preview(root).unwrap();
        assert_eq!(preview["branch"], "main");
        assert_eq!(preview["localBranch"], "refs/heads/main");
        assert_eq!(preview["remoteBranch"], "refs/heads/main");
        assert_eq!(preview["upstream"], "origin/refs/heads/main");
        assert!(preview.get("remoteOid").is_some());
        git(root, &["config", "remote.origin.push", "refs/heads/main:refs/heads/refs/heads/main"]).unwrap();
        assert_eq!(push_preview(root).unwrap()["remoteBranch"], "refs/heads/main");
    }
}
