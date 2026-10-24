use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    ffi::OsStr,
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_STATUS_BYTES: usize = 1024 * 1024;
const MAX_STDERR_BYTES: usize = 16 * 1024;
const UNKNOWN_CHANGED_FILE: &str = "(unknown changed file)";

/// Reports Git and repository availability without assuming either is installed.
pub(crate) fn prerequisites(cwd: Option<&str>) -> Value {
    prerequisites_with_program(cwd, OsStr::new("git"))
}
/// Captures the Git state surrounding one read-only Group chat delivery.
pub(crate) fn capture(cwd: &str) -> Value {
    capture_with_program(cwd, OsStr::new("git"))
}

fn prerequisites_with_program(cwd: Option<&str>, program: &OsStr) -> Value {
    let deadline = Instant::now() + TIMEOUT;
    let version = match git(
        program,
        None,
        &["--version"],
        None,
        deadline,
        MAX_STATUS_BYTES,
    ) {
        Ok(output) => String::from_utf8_lossy(&output).trim().to_owned(),
        Err(error) => return prerequisite_failure(cwd, error),
    };
    let mut result = json!({"git":{"found":true,"version":version}});
    if let Some(cwd) = cwd {
        let folder = match git(
            program,
            Some(cwd),
            &["rev-parse", "--is-inside-work-tree"],
            None,
            deadline,
            64,
        ) {
            Ok(output) if output.trim_ascii() == b"true" => json!({"repository":true}),
            Ok(_) => json!({"repository":false,"reason":"not_a_repository"}),
            Err(GitFailure::Failed(detail)) if is_not_repository(&detail) => {
                json!({"repository":false,"reason":"not_a_repository"})
            }
            Err(error) => json!({"repository":false,"reason":error.reason()}),
        };
        result["folder"] = folder;
    }
    result
}

fn prerequisite_failure(cwd: Option<&str>, error: GitFailure) -> Value {
    let (found, reason) = match error {
        GitFailure::NotFound => (false, "no_git"),
        _ => (true, "error"),
    };
    let mut result = json!({"git":{"found":found}});
    if cwd.is_some() {
        result["folder"] = json!({"repository":false,"reason":reason});
    }
    result
}

fn capture_with_program(cwd: &str, program: &OsStr) -> Value {
    let deadline = Instant::now() + TIMEOUT;
    match git(
        program,
        Some(cwd),
        &["rev-parse", "--is-inside-work-tree"],
        None,
        deadline,
        64,
    ) {
        Ok(output) if output.trim_ascii() == b"true" => {}
        Ok(_) => return unchecked(GitFailure::NotRepository),
        Err(GitFailure::Failed(detail)) if is_not_repository(&detail) => {
            return unchecked(GitFailure::NotRepository)
        }
        Err(error) => return unchecked(error),
    }
    let status = match git(
        program,
        Some(cwd),
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
            "--ignore-submodules=all",
        ],
        None,
        deadline,
        MAX_STATUS_BYTES,
    ) {
        Ok(status) => status,
        Err(error) => return unchecked(error),
    };
    let files = status_files(&status);
    let hash = Arc::new(Mutex::new(Sha256::new()));
    update(&hash, b"status\0");
    update(&hash, &status);
    update(&hash, b"worktree\0");
    if let Err(error) = git_stream_hash(
        program,
        cwd,
        &["diff", "--no-ext-diff", "--binary"],
        deadline,
        &hash,
    ) {
        return unchecked(error);
    }
    update(&hash, b"index\0");
    if let Err(error) = git_stream_hash(
        program,
        cwd,
        &["diff", "--cached", "--no-ext-diff", "--binary"],
        deadline,
        &hash,
    ) {
        return unchecked(error);
    }
    let paths = untracked_paths(&status);
    if !paths.is_empty() {
        let input = stdin_paths(&paths);
        let output = match git(
            program,
            Some(cwd),
            &["hash-object", "--no-filters", "--stdin-paths"],
            Some(&input),
            deadline,
            paths.len().saturating_mul(65).saturating_add(1),
        ) {
            Ok(output) => output,
            Err(error) => return unchecked(error),
        };
        let hashes = output
            .split(|byte| *byte == b'\n')
            .filter(|hash| !hash.is_empty())
            .collect::<Vec<_>>();
        if hashes.len() != paths.len() {
            return unchecked(GitFailure::Failed(
                "hash-object returned an incomplete result".into(),
            ));
        }
        for (path, content_hash) in paths.iter().zip(hashes) {
            update(&hash, b"untracked\0");
            update(&hash, path.as_bytes());
            update(&hash, b"\0");
            update(&hash, content_hash);
            update(&hash, b"\n");
        }
    }
    let hash = hash.lock().expect("group chat Git hasher poisoned").clone();
    json!({"checked":true,"hash":hex::encode(hash.finalize()),"files":files})
}

/// Returns `None` if either capture was incomplete. Otherwise it identifies paths newly present in Git status snapshots.
pub(crate) fn changed(before: &Value, after: &Value) -> Option<Vec<String>> {
    if !before
        .get("checked")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || !after
            .get("checked")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return None;
    }
    let before_hash = before.get("hash").and_then(Value::as_str)?;
    let after_hash = after.get("hash").and_then(Value::as_str)?;
    if before_hash == after_hash {
        return Some(Vec::new());
    }
    let mut changed = files(before)?
        .symmetric_difference(&files(after)?)
        .cloned()
        .collect::<Vec<_>>();
    if changed.is_empty() {
        changed.push(UNKNOWN_CHANGED_FILE.into());
    }
    Some(changed)
}
fn unchecked(error: GitFailure) -> Value {
    json!({"checked":false,"hash":"","files":[],"reason":error.reason(),"detail":error.detail()})
}
fn files(value: &Value) -> Option<BTreeSet<String>> {
    Some(
        value
            .get("files")?
            .as_array()?
            .iter()
            .map(Value::as_str)
            .collect::<Option<BTreeSet<_>>>()?
            .into_iter()
            .map(str::to_owned)
            .collect(),
    )
}
fn status_files(status: &[u8]) -> Vec<String> {
    status
        .split(|byte| *byte == 0)
        .filter_map(status_path)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
fn untracked_paths(status: &[u8]) -> Vec<String> {
    status
        .split(|byte| *byte == 0)
        .filter(|entry| entry.starts_with(b"?? "))
        .filter_map(status_path)
        .collect()
}
fn stdin_paths(paths: &[String]) -> Vec<u8> {
    let mut input = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        if index > 0 {
            input.push(b'\n');
        }
        input.extend_from_slice(quote_stdin_path(path).as_bytes());
    }
    input
}
fn quote_stdin_path(path: &str) -> String {
    let mut quoted = String::with_capacity(path.len() + 2);
    quoted.push('"');
    for byte in path.bytes() {
        match byte {
            b'\\' => quoted.push_str("\\\\"),
            b'"' => quoted.push_str("\\\""),
            b'\n' => quoted.push_str("\\n"),
            b'\r' => quoted.push_str("\\r"),
            b'\t' => quoted.push_str("\\t"),
            0..=31 | 127..=255 => quoted.push_str(&format!("\\{:03o}", byte)),
            _ => quoted.push(byte as char),
        }
    }
    quoted.push('"');
    quoted
}
fn is_not_repository(detail: &str) -> bool {
    detail.to_ascii_lowercase().contains("not a git repository")
}
fn status_path(entry: &[u8]) -> Option<String> {
    (entry.len() >= 4).then(|| String::from_utf8_lossy(&entry[3..]).into_owned())
}

#[derive(Debug)]
enum GitFailure {
    NotFound,
    NotRepository,
    TimedOut,
    TooLarge,
    Failed(String),
}
impl GitFailure {
    fn reason(&self) -> &'static str {
        match self {
            Self::NotFound => "no_git",
            Self::NotRepository => "not_a_repository",
            Self::TimedOut | Self::TooLarge | Self::Failed(_) => "error",
        }
    }
    fn detail(&self) -> String {
        match self {
            Self::NotFound => "Git was not found on PATH".into(),
            Self::NotRepository => "This folder is not a Git repository".into(),
            Self::TimedOut => "Git did not finish within five seconds".into(),
            Self::TooLarge => "Git returned more data than this check can safely retain".into(),
            Self::Failed(detail) => detail.clone(),
        }
    }
}
fn update(hash: &Arc<Mutex<Sha256>>, bytes: &[u8]) {
    hash.lock()
        .expect("group chat Git hasher poisoned")
        .update(bytes);
}

/// Matches `git_read::run_git`'s non-interactive environment. Diff bytes go directly into the SHA-256 state, so a large legitimate diff does not make the guard unchecked.
fn git_stream_hash(
    program: &OsStr,
    cwd: &str,
    args: &[&str],
    deadline: Instant,
    hash: &Arc<Mutex<Sha256>>,
) -> Result<(), GitFailure> {
    if Instant::now() >= deadline {
        return Err(GitFailure::TimedOut);
    }
    let mut child = command(program, Some(cwd), args, false)
        .spawn()
        .map_err(spawn_failure)?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| GitFailure::Failed("Git stdout was unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| GitFailure::Failed("Git stderr was unavailable".into()))?;
    let hash = Arc::clone(hash);
    let stdout = thread::spawn(move || stream_hash(stdout, &hash));
    let stderr = thread::spawn(move || read_bounded(stderr, MAX_STDERR_BYTES));
    let status = wait(&mut child, deadline)?;
    stdout
        .join()
        .map_err(|_| GitFailure::Failed("Git stdout reader failed".into()))??;
    let stderr = stderr.join().unwrap_or(None).unwrap_or_default();
    status.success().then_some(()).ok_or_else(|| failed(stderr))
}
fn git(
    program: &OsStr,
    cwd: Option<&str>,
    args: &[&str],
    input: Option<&[u8]>,
    deadline: Instant,
    limit: usize,
) -> Result<Vec<u8>, GitFailure> {
    if Instant::now() >= deadline {
        return Err(GitFailure::TimedOut);
    }
    if cwd.is_some_and(|cwd| !Path::new(cwd).is_dir()) {
        return Err(GitFailure::Failed(
            "The selected folder is unavailable".into(),
        ));
    }
    let mut child = command(program, cwd, args, input.is_some())
        .spawn()
        .map_err(spawn_failure)?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| GitFailure::Failed("Git stdout was unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| GitFailure::Failed("Git stderr was unavailable".into()))?;
    let stdout = thread::spawn(move || read_bounded(stdout, limit));
    let stderr = thread::spawn(move || read_bounded(stderr, MAX_STDERR_BYTES));
    let stdin = input.map(|input| {
        let mut stdin = child.stdin.take().expect("Git stdin was requested");
        let input = input.to_vec();
        thread::spawn(move || stdin.write_all(&input))
    });
    let status = wait(&mut child, deadline)?;
    let output = stdout
        .join()
        .map_err(|_| GitFailure::Failed("Git stdout reader failed".into()))?
        .ok_or(GitFailure::TooLarge)?;
    if let Some(stdin) = stdin {
        let _ = stdin.join();
    }
    let stderr = stderr.join().unwrap_or(None).unwrap_or_default();
    if status.success() {
        Ok(output)
    } else {
        Err(failed(stderr))
    }
}
fn command(program: &OsStr, cwd: Option<&str>, args: &[&str], stdin: bool) -> Command {
    let mut command = Command::new(program);
    if let Some(cwd) = cwd {
        command
            .args(["-C", ".", "-c", "core.quotepath=off"])
            .current_dir(cwd);
    }
    command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(if stdin { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}
fn spawn_failure(error: std::io::Error) -> GitFailure {
    if error.kind() == std::io::ErrorKind::NotFound {
        GitFailure::NotFound
    } else {
        GitFailure::Failed(error.to_string())
    }
}
fn failed(stderr: Vec<u8>) -> GitFailure {
    let detail = String::from_utf8_lossy(&stderr).trim().to_owned();
    GitFailure::Failed(if detail.is_empty() {
        "Git command failed".into()
    } else {
        detail
    })
}
fn wait(
    child: &mut std::process::Child,
    deadline: Instant,
) -> Result<std::process::ExitStatus, GitFailure> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(GitFailure::TimedOut);
            }
            Err(error) => return Err(GitFailure::Failed(error.to_string())),
        }
    }
}
fn read_bounded(mut reader: impl Read, limit: usize) -> Option<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader.read(&mut buffer).ok()?;
        if count == 0 {
            return Some(output);
        }
        if output.len().saturating_add(count) > limit {
            return None;
        }
        output.extend_from_slice(&buffer[..count]);
    }
}
fn stream_hash(mut reader: impl Read, hash: &Arc<Mutex<Sha256>>) -> Result<(), GitFailure> {
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| GitFailure::Failed(error.to_string()))?;
        if count == 0 {
            return Ok(());
        }
        update(hash, &buffer[..count]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path, process::Command};
    fn repository() -> tempfile::TempDir {
        let directory = tempfile::Builder::new()
            .prefix("group-chat-guard-")
            .tempdir()
            .unwrap();
        run(directory.path(), &["init"]);
        directory
    }
    fn run(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[test]
    fn captures_staged_dirty_and_untracked_content() {
        let repository = repository();
        fs::write(repository.path().join("staged.txt"), "one").unwrap();
        run(repository.path(), &["add", "staged.txt"]);
        fs::write(repository.path().join("dirty.txt"), "two").unwrap();
        fs::write(repository.path().join("untracked file.txt"), "three").unwrap();
        let first = capture(repository.path().to_str().unwrap());
        assert_eq!(first["checked"], true);
        assert_eq!(
            first["files"],
            json!(["dirty.txt", "staged.txt", "untracked file.txt"])
        );
        fs::write(
            repository.path().join("untracked file.txt"),
            "changed content",
        )
        .unwrap();
        let second = capture(repository.path().to_str().unwrap());
        assert_eq!(
            changed(&first, &second),
            Some(vec![UNKNOWN_CHANGED_FILE.into()])
        );
    }
    #[test]
    fn reports_added_and_removed_status_paths() {
        let repository = repository();
        let before = capture(repository.path().to_str().unwrap());
        fs::write(repository.path().join("new.txt"), "new").unwrap();
        let after = capture(repository.path().to_str().unwrap());
        assert_eq!(changed(&before, &after), Some(vec!["new.txt".into()]));
        assert_eq!(changed(&after, &after), Some(Vec::new()));
    }
    #[test]
    fn non_git_directory_reports_its_reason() {
        let directory = tempfile::tempdir().unwrap();
        let value = capture(directory.path().to_str().unwrap());
        assert_eq!(value["checked"], false);
        assert_eq!(value["reason"], "not_a_repository");
        assert_eq!(
            prerequisites(Some(directory.path().to_str().unwrap()))["folder"],
            json!({"repository":false,"reason":"not_a_repository"})
        );
        assert_eq!(changed(&value, &value), None);
    }
    #[test]
    fn missing_git_is_distinguished() {
        let directory = tempfile::tempdir().unwrap();
        let value = capture_with_program(
            directory.path().to_str().unwrap(),
            OsStr::new("threadterm-missing-git"),
        );
        assert_eq!(value["reason"], "no_git");
        assert_eq!(
            prerequisites_with_program(
                Some(directory.path().to_str().unwrap()),
                OsStr::new("threadterm-missing-git")
            ),
            json!({"git":{"found":false},"folder":{"repository":false,"reason":"no_git"}})
        );
    }
    #[test]
    fn failed_version_probe_keeps_git_present_and_marks_folder_error() {
        assert_eq!(
            prerequisite_failure(Some("folder"), GitFailure::TimedOut),
            json!({"git":{"found":true},"folder":{"repository":false,"reason":"error"}})
        );
    }
    #[test]
    fn unavailable_folder_is_an_error_not_a_missing_git_installation() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("does-not-exist");
        let value = capture(missing.to_str().unwrap());
        assert_eq!(value["reason"], "error");
        assert_eq!(value["detail"], "The selected folder is unavailable");
    }
    #[test]
    fn bulk_hash_matches_legacy_per_path_hashes() {
        let repository = repository();
        for index in 0..3 {
            fs::write(
                repository.path().join(format!("file {index}.txt")),
                format!("data {index}"),
            )
            .unwrap();
        }
        let status = git(
            OsStr::new("git"),
            Some(repository.path().to_str().unwrap()),
            &[
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--no-renames",
                "--ignore-submodules=all",
            ],
            None,
            Instant::now() + TIMEOUT,
            MAX_STATUS_BYTES,
        )
        .unwrap();
        let paths = untracked_paths(&status);
        let input = stdin_paths(&paths);
        let bulk = git(
            OsStr::new("git"),
            Some(repository.path().to_str().unwrap()),
            &["hash-object", "--no-filters", "--stdin-paths"],
            Some(&input),
            Instant::now() + TIMEOUT,
            1024,
        )
        .unwrap();
        for (path, hash) in paths.iter().zip(
            bulk.split(|byte| *byte == b'\n')
                .filter(|hash| !hash.is_empty()),
        ) {
            let legacy = git(
                OsStr::new("git"),
                Some(repository.path().to_str().unwrap()),
                &["hash-object", "--no-filters", "--", path],
                None,
                Instant::now() + TIMEOUT,
                256,
            )
            .unwrap();
            assert_eq!(hash, legacy.trim_ascii());
        }
    }
    #[test]
    fn stdin_paths_c_style_quotes_special_names() {
        assert_eq!(quote_stdin_path("plain"), "\"plain\"");
        assert_eq!(
            quote_stdin_path("\"quote\\slash\nline"),
            "\"\\\"quote\\\\slash\\nline\""
        );
    }
}
