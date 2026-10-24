//! Bounded per-file folder snapshots for Group chat delivery attribution.
//!
//! The JSON shape is private runtime state. A complete snapshot contains every
//! included working-tree file at one instant; an incomplete snapshot is never
//! diffed, because a partial manifest would invent additions or deletions.

use ignore::{DirEntry, WalkBuilder};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const SNAPSHOT_VERSION: u64 = 1;
const MAX_ENTRIES: usize = 20_000;
const MAX_HASH_BYTES: u64 = 5 * 1024 * 1024;
const SNAPSHOT_BUDGET: Duration = Duration::from_secs(3);
const MAX_GIT_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_GIT_ERROR_BYTES: usize = 16 * 1024;
const SKIPPED_DIRECTORIES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "__pycache__",
];

/// Captures one complete, bounded view of the folder or an explicit incomplete
/// marker. Callers persist the value and use `diff` only after the turn ends.
pub(crate) fn capture(cwd: &str) -> Value {
    capture_with_limits(cwd, MAX_ENTRIES, SNAPSHOT_BUDGET)
}

/// The limit-aware entry point is visible inside the crate so focused tests can
/// exercise bounds without constructing a 20,001-file fixture.
pub(crate) fn capture_with_limits(cwd: &str, max_entries: usize, budget: Duration) -> Value {
    capture_with_program_and_limits(cwd, OsStr::new("git"), max_entries, budget)
}

fn capture_with_program_and_limits(
    cwd: &str,
    git_program: &OsStr,
    max_entries: usize,
    budget: Duration,
) -> Value {
    let Some(deadline) = Instant::now().checked_add(budget) else {
        return incomplete("timeout");
    };
    let root = Path::new(cwd);
    if !root.is_dir() {
        return incomplete("folder_unavailable");
    }
    let root = match root.canonicalize() {
        Ok(root) => root,
        Err(_) => return incomplete("folder_unavailable"),
    };
    match git_output(
        git_program,
        &root,
        &["rev-parse", "--is-inside-work-tree"],
        deadline,
        64,
    ) {
        Ok(output) if output.trim_ascii() == b"true" => {
            capture_git(git_program, &root, max_entries, deadline)
        }
        Ok(_) | Err(GitFailure::NotFound) | Err(GitFailure::NotRepository) => {
            capture_folder(&root, max_entries, deadline)
        }
        Err(GitFailure::TimedOut) => incomplete("timeout"),
        Err(GitFailure::TooLarge | GitFailure::Failed) => incomplete("git_error"),
    }
}

fn capture_git(program: &OsStr, root: &Path, max_entries: usize, deadline: Instant) -> Value {
    let status = match git_output(
        program,
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
            "--ignore-submodules=all",
            "--",
            ".",
        ],
        deadline,
        MAX_GIT_OUTPUT_BYTES,
    ) {
        Ok(status) => status,
        Err(GitFailure::TimedOut) => return incomplete("timeout"),
        Err(_) => return incomplete("git_error"),
    };
    let listed = match git_output(
        program,
        root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            ".",
        ],
        deadline,
        MAX_GIT_OUTPUT_BYTES,
    ) {
        Ok(listed) => listed,
        Err(GitFailure::TimedOut) => return incomplete("timeout"),
        Err(_) => return incomplete("git_error"),
    };
    let paths = match parse_git_paths(&listed, max_entries) {
        Ok(paths) => paths,
        Err(error) => return incomplete(error.reason()),
    };
    let mut files = Vec::with_capacity(paths.len());
    for relative in paths {
        if Instant::now() >= deadline {
            return incomplete("timeout");
        }
        let display = normalized_relative(&relative);
        match snapshot_path(root, &root.join(&relative), &display, deadline) {
            Ok(Some(file)) => files.push(file),
            Ok(None) => {}
            Err(error) => return incomplete(error.reason()),
        }
    }
    json!({
        "version": SNAPSHOT_VERSION,
        "complete": true,
        "source": "git",
        "gitStatus": hex::encode(Sha256::digest(&status)),
        "files": files,
    })
}

fn capture_folder(root: &Path, max_entries: usize, deadline: Instant) -> Value {
    if Instant::now() >= deadline {
        return incomplete("timeout");
    }
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .ignore(true)
        .git_ignore(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .filter_entry(walk_entry_allowed);
    let mut files = Vec::new();
    for entry in builder.build() {
        if Instant::now() >= deadline {
            return incomplete("timeout");
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => return incomplete("walk_error"),
        };
        if entry.depth() == 0 || !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        if files.len() >= max_entries {
            return incomplete("entry_limit");
        }
        let relative = match entry.path().strip_prefix(root) {
            Ok(relative) => relative,
            Err(_) => return incomplete("path_error"),
        };
        let Some(relative) = relative.to_str() else {
            return incomplete("path_encoding");
        };
        let relative = normalize_separator(relative);
        match snapshot_path(root, entry.path(), &relative, deadline) {
            Ok(Some(file)) => files.push(file),
            Ok(None) => {}
            Err(error) => return incomplete(error.reason()),
        }
    }
    json!({
        "version": SNAPSHOT_VERSION,
        "complete": true,
        "source": "folder",
        "files": files,
    })
}

fn walk_entry_allowed(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    let Some(kind) = entry.file_type() else {
        return true;
    };
    if kind.is_symlink() {
        return false;
    }
    if !kind.is_dir() {
        return true;
    }
    if is_reparse_point(entry.path()) {
        return false;
    }
    let name = entry.file_name().to_string_lossy();
    !SKIPPED_DIRECTORIES
        .iter()
        .any(|skipped| directory_name_eq(&name, skipped))
}

#[cfg(windows)]
fn directory_name_eq(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

#[cfg(not(windows))]
fn directory_name_eq(left: &str, right: &str) -> bool {
    left == right
}

#[cfg(windows)]
fn is_reparse_point(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_attributes() & 0x400 != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_reparse_point(_path: &Path) -> bool {
    false
}

fn parse_git_paths(bytes: &[u8], max_entries: usize) -> Result<Vec<PathBuf>, CaptureFailure> {
    if !bytes.is_empty() && !bytes.ends_with(&[0]) {
        return Err(CaptureFailure::GitOutput);
    }
    let mut paths = Vec::new();
    let mut seen = BTreeSet::new();
    for field in bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
    {
        let value = std::str::from_utf8(field).map_err(|_| CaptureFailure::PathEncoding)?;
        if !safe_relative(Path::new(value)) || value.is_empty() {
            return Err(CaptureFailure::Path);
        }
        let path = PathBuf::from(value);
        if has_skipped_directory(&path) {
            continue;
        }
        if seen.insert(path.clone()) {
            if paths.len() >= max_entries {
                return Err(CaptureFailure::EntryLimit);
            }
            paths.push(path);
        }
    }
    Ok(paths)
}

fn has_skipped_directory(path: &Path) -> bool {
    path.parent().is_some_and(|parent| {
        parent.components().any(|component| {
            let Component::Normal(name) = component else {
                return false;
            };
            let name = name.to_string_lossy();
            SKIPPED_DIRECTORIES
                .iter()
                .any(|skipped| directory_name_eq(&name, skipped))
        })
    })
}

fn safe_relative(path: &Path) -> bool {
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn normalized_relative(path: &Path) -> String {
    normalize_separator(path.to_string_lossy().as_ref())
}

#[cfg(windows)]
fn normalize_separator(path: &str) -> String {
    path.replace('\\', "/")
}

#[cfg(not(windows))]
fn normalize_separator(path: &str) -> String {
    path.to_owned()
}

fn snapshot_path(
    root: &Path,
    path: &Path,
    relative: &str,
    deadline: Instant,
) -> Result<Option<Value>, CaptureFailure> {
    if Instant::now() >= deadline {
        return Err(CaptureFailure::TimedOut);
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(CaptureFailure::Read),
    };
    if metadata.file_type().is_symlink() || is_reparse_metadata(&metadata) {
        return snapshot_link(path, relative, &metadata);
    }
    if metadata.is_dir() {
        return Ok(None);
    }
    if !metadata.is_file() {
        return Err(CaptureFailure::Read);
    }
    let canonical = path.canonicalize().map_err(|_| CaptureFailure::Read)?;
    if !canonical.starts_with(root) {
        return Err(CaptureFailure::Path);
    }
    let mut file = open_without_following_final_link(&canonical)?;
    let before = file.metadata().map_err(|_| CaptureFailure::Read)?;
    if is_reparse_metadata(&before) || !before.is_file() {
        return Err(CaptureFailure::ChangedDuringCapture);
    }
    let modified = modified_key(before.modified().map_err(|_| CaptureFailure::Read)?);
    let mut value = Map::new();
    value.insert("path".into(), json!(relative));
    value.insert("kind".into(), json!("file"));
    value.insert("size".into(), json!(before.len()));
    value.insert("modified".into(), json!(modified));
    if before.len() <= MAX_HASH_BYTES {
        value.insert(
            "sha256".into(),
            json!(bounded_content_hash(&mut file, deadline)?),
        );
    }
    let after = file.metadata().map_err(|_| CaptureFailure::Read)?;
    if before.len() != after.len()
        || before.modified().ok().map(modified_key) != after.modified().ok().map(modified_key)
    {
        return Err(CaptureFailure::ChangedDuringCapture);
    }
    Ok(Some(Value::Object(value)))
}

#[cfg(windows)]
fn open_without_following_final_link(path: &Path) -> Result<fs::File, CaptureFailure> {
    use std::os::windows::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(0x0020_0000)
        .open(path)
        .map_err(|_| CaptureFailure::Read)
}

#[cfg(not(windows))]
fn open_without_following_final_link(path: &Path) -> Result<fs::File, CaptureFailure> {
    fs::File::open(path).map_err(|_| CaptureFailure::Read)
}

#[cfg(windows)]
fn is_reparse_metadata(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_metadata(_metadata: &fs::Metadata) -> bool {
    false
}

fn bounded_content_hash(
    reader: &mut impl Read,
    deadline: Instant,
) -> Result<String, CaptureFailure> {
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if Instant::now() >= deadline {
            return Err(CaptureFailure::TimedOut);
        }
        let remaining = MAX_HASH_BYTES + 1 - total;
        let wanted = buffer.len().min(remaining as usize);
        let count = reader
            .read(&mut buffer[..wanted])
            .map_err(|_| CaptureFailure::Read)?;
        if count == 0 {
            return Ok(hex::encode(digest.finalize()));
        }
        total += count as u64;
        if total > MAX_HASH_BYTES {
            return Err(CaptureFailure::ChangedDuringCapture);
        }
        digest.update(&buffer[..count]);
    }
}

fn snapshot_link(
    path: &Path,
    relative: &str,
    metadata: &fs::Metadata,
) -> Result<Option<Value>, CaptureFailure> {
    let target = fs::read_link(path).map_err(|_| CaptureFailure::Read)?;
    let mut digest = Sha256::new();
    update_os_string_hash(&mut digest, target.as_os_str());
    Ok(Some(json!({
        "path": relative,
        "kind": "link",
        "size": metadata.len(),
        "modified": modified_key(metadata.modified().map_err(|_| CaptureFailure::Read)?),
        "sha256": hex::encode(digest.finalize()),
    })))
}

#[cfg(unix)]
fn update_os_string_hash(digest: &mut Sha256, value: &OsStr) {
    use std::os::unix::ffi::OsStrExt;
    digest.update(value.as_bytes());
}

#[cfg(windows)]
fn update_os_string_hash(digest: &mut Sha256, value: &OsStr) {
    use std::os::windows::ffi::OsStrExt;
    for unit in value.encode_wide() {
        digest.update(unit.to_le_bytes());
    }
}

fn modified_key(value: SystemTime) -> String {
    match value.duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("{}:{:09}", duration.as_secs(), duration.subsec_nanos()),
        Err(error) => {
            let duration = error.duration();
            format!("-{}:{:09}", duration.as_secs(), duration.subsec_nanos())
        }
    }
}

fn incomplete(reason: &str) -> Value {
    json!({
        "version": SNAPSHOT_VERSION,
        "complete": false,
        "reason": reason,
    })
}

/// Returns exact per-file folder evidence, or `None` when either endpoint is
/// incomplete or malformed. Status is relative to the before/after pair.
pub(crate) fn diff(before: &Value, after: &Value) -> Option<Vec<Value>> {
    let before_source = before.get("source")?.as_str()?;
    let after_source = after.get("source")?.as_str()?;
    if !matches!(before_source, "git" | "folder") || before_source != after_source {
        return None;
    }
    let before = manifest(before)?;
    let after = manifest(after)?;
    let mut paths = before
        .keys()
        .chain(after.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut changed = Vec::new();
    for path in std::mem::take(&mut paths) {
        let status = match (before.get(&path), after.get(&path)) {
            (None, Some(_)) => "added",
            (Some(_), None) => "deleted",
            (Some(left), Some(right)) if left != right => "modified",
            _ => continue,
        };
        changed.push(json!({"path": path, "status": status, "evidence": "folder"}));
    }
    Some(changed)
}

fn manifest(value: &Value) -> Option<BTreeMap<String, (String, u64, String, String)>> {
    if value.get("version")?.as_u64()? != SNAPSHOT_VERSION
        || value.get("complete")?.as_bool()? != true
    {
        return None;
    }
    let mut result = BTreeMap::new();
    for entry in value.get("files")?.as_array()? {
        let object = entry.as_object()?;
        let path = object.get("path")?.as_str()?;
        if path.is_empty() || !safe_relative(Path::new(path)) {
            return None;
        }
        let kind = object.get("kind")?.as_str()?;
        if !matches!(kind, "file" | "link") {
            return None;
        }
        let size = object.get("size")?.as_u64()?;
        let modified = object.get("modified")?.as_str()?;
        let (basis, fingerprint) = match object.get("sha256") {
            Some(Value::String(hash))
                if hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) =>
            {
                ("sha256", hash.as_str())
            }
            Some(_) => return None,
            None if kind == "file" && size > MAX_HASH_BYTES => ("metadata", modified),
            None => return None,
        };
        if result
            .insert(
                path.to_owned(),
                (
                    kind.to_owned(),
                    size,
                    basis.to_owned(),
                    fingerprint.to_owned(),
                ),
            )
            .is_some()
        {
            return None;
        }
    }
    Some(result)
}

#[derive(Debug)]
enum CaptureFailure {
    TimedOut,
    EntryLimit,
    Read,
    Path,
    PathEncoding,
    GitOutput,
    ChangedDuringCapture,
}

impl CaptureFailure {
    fn reason(&self) -> &'static str {
        match self {
            Self::TimedOut => "timeout",
            Self::EntryLimit => "entry_limit",
            Self::Read => "read_error",
            Self::Path => "path_error",
            Self::PathEncoding => "path_encoding",
            Self::GitOutput => "git_error",
            Self::ChangedDuringCapture => "changed_during_capture",
        }
    }
}

#[derive(Debug)]
enum GitFailure {
    NotFound,
    NotRepository,
    TimedOut,
    TooLarge,
    Failed,
}

fn git_output(
    program: &OsStr,
    cwd: &Path,
    args: &[&str],
    deadline: Instant,
    limit: usize,
) -> Result<Vec<u8>, GitFailure> {
    if Instant::now() >= deadline {
        return Err(GitFailure::TimedOut);
    }
    let mut command = Command::new(program);
    command
        .args([
            "-C",
            ".",
            "-c",
            "core.quotepath=off",
            "-c",
            "core.fsmonitor=false",
        ])
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            GitFailure::NotFound
        } else {
            GitFailure::Failed
        }
    })?;
    let stdout = child.stdout.take().ok_or(GitFailure::Failed)?;
    let stderr = child.stderr.take().ok_or(GitFailure::Failed)?;
    let stdout = thread::spawn(move || read_bounded_and_drain(stdout, limit));
    let stderr = thread::spawn(move || read_bounded_and_drain(stderr, MAX_GIT_ERROR_BYTES));
    let status = wait_for_child(&mut child, deadline);
    let output = stdout
        .join()
        .map_err(|_| GitFailure::Failed)?
        .map_err(|_| GitFailure::Failed)?;
    let errors = stderr
        .join()
        .map_err(|_| GitFailure::Failed)?
        .map_err(|_| GitFailure::Failed)?;
    let status = status?;
    let output = output.ok_or(GitFailure::TooLarge)?;
    let errors = errors.unwrap_or_default();
    if status.success() {
        return Ok(output);
    }
    let detail = String::from_utf8_lossy(&errors).to_ascii_lowercase();
    if detail.contains("not a git repository") {
        Err(GitFailure::NotRepository)
    } else {
        Err(GitFailure::Failed)
    }
}

fn wait_for_child(
    child: &mut std::process::Child,
    deadline: Instant,
) -> Result<std::process::ExitStatus, GitFailure> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(GitFailure::TimedOut);
            }
            Err(_) => return Err(GitFailure::Failed),
        }
    }
}

fn read_bounded_and_drain(mut reader: impl Read, limit: usize) -> std::io::Result<Option<Vec<u8>>> {
    let mut output = Vec::new();
    let mut overflow = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            return Ok((!overflow).then_some(output));
        }
        if !overflow && output.len().saturating_add(count) <= limit {
            output.extend_from_slice(&buffer[..count]);
        } else {
            overflow = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, process::Command};

    fn file_paths(snapshot: &Value) -> Vec<String> {
        snapshot["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["path"].as_str().unwrap().to_owned())
            .collect()
    }

    fn change_tuples(before: &Value, after: &Value) -> Vec<(String, String)> {
        diff(before, after)
            .unwrap()
            .iter()
            .map(|entry| {
                (
                    entry["path"].as_str().unwrap().to_owned(),
                    entry["status"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    }

    fn run_git(root: &Path, args: &[&str]) {
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

    fn repository() -> tempfile::TempDir {
        let directory = tempfile::Builder::new()
            .prefix("group-folder-git-")
            .tempdir()
            .unwrap();
        run_git(directory.path(), &["init", "-q", "-b", "main"]);
        run_git(
            directory.path(),
            &["config", "user.email", "qa@example.test"],
        );
        run_git(directory.path(), &["config", "user.name", "QA"]);
        run_git(directory.path(), &["config", "core.autocrlf", "false"]);
        fs::write(directory.path().join(".gitignore"), "ignored.log\n").unwrap();
        fs::write(directory.path().join("tracked.txt"), "one\n").unwrap();
        fs::write(directory.path().join("gone.txt"), "gone\n").unwrap();
        fs::create_dir(directory.path().join("target")).unwrap();
        fs::write(
            directory.path().join("target").join("tracked.txt"),
            "skip\n",
        )
        .unwrap();
        run_git(directory.path(), &["add", "."]);
        run_git(directory.path(), &["commit", "-qm", "initial"]);
        directory
    }

    #[test]
    fn folder_manifest_reports_added_modified_and_deleted_files() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("modified.txt"), "before").unwrap();
        fs::write(directory.path().join("deleted.txt"), "before").unwrap();
        let before = capture(directory.path().to_str().unwrap());
        fs::write(directory.path().join("modified.txt"), "after").unwrap();
        fs::remove_file(directory.path().join("deleted.txt")).unwrap();
        fs::write(directory.path().join("added.txt"), "after").unwrap();
        let after = capture(directory.path().to_str().unwrap());
        assert_eq!(before["source"], "folder");
        assert_eq!(
            change_tuples(&before, &after),
            vec![
                ("added.txt".into(), "added".into()),
                ("deleted.txt".into(), "deleted".into()),
                ("modified.txt".into(), "modified".into()),
            ]
        );
        assert!(diff(&before, &after)
            .unwrap()
            .iter()
            .all(|entry| entry["evidence"] == "folder"));
    }

    #[test]
    fn folder_manifest_honors_ignore_files_and_builtin_directory_skips() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join(".gitignore"),
            "ignored.txt\nignored-dir/\n",
        )
        .unwrap();
        fs::write(directory.path().join(".ignore"), "also-ignored.txt\n").unwrap();
        fs::write(directory.path().join("visible.txt"), "visible").unwrap();
        fs::write(directory.path().join("ignored.txt"), "ignored").unwrap();
        fs::write(directory.path().join("also-ignored.txt"), "ignored").unwrap();
        fs::create_dir(directory.path().join("ignored-dir")).unwrap();
        fs::write(
            directory.path().join("ignored-dir").join("x.txt"),
            "ignored",
        )
        .unwrap();
        for name in SKIPPED_DIRECTORIES {
            let path = directory.path().join(name);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("generated.txt"), "generated").unwrap();
        }
        let snapshot = capture(directory.path().to_str().unwrap());
        assert_eq!(snapshot["complete"], true, "{snapshot}");
        let paths = file_paths(&snapshot);
        assert!(paths.contains(&"visible.txt".to_owned()));
        assert!(paths.contains(&".gitignore".to_owned()));
        assert!(paths.contains(&".ignore".to_owned()));
        assert!(!paths.iter().any(|path| path.contains("ignored.txt")
            || path.contains("ignored-dir")
            || path.contains("generated.txt")));
    }

    #[test]
    fn incomplete_snapshots_never_produce_deltas() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("one.txt"), "1").unwrap();
        fs::write(directory.path().join("two.txt"), "2").unwrap();
        let capped = capture_with_limits(
            directory.path().to_str().unwrap(),
            1,
            Duration::from_secs(3),
        );
        let timed_out = capture_with_limits(
            directory.path().to_str().unwrap(),
            MAX_ENTRIES,
            Duration::ZERO,
        );
        assert_eq!(capped["reason"], "entry_limit");
        assert_eq!(timed_out["reason"], "timeout");
        assert_eq!(
            diff(&capped, &capture(directory.path().to_str().unwrap())),
            None
        );
        assert_eq!(diff(&timed_out, &timed_out), None);
        assert_eq!(
            diff(
                &json!({"complete":true,"version":1,"files":[]}),
                &json!({"complete":true,"version":1,"files":[{"path":"../outside","kind":"file","size":1,"modified":"0:000000000"}]})
            ),
            None
        );
    }

    #[test]
    fn missing_git_falls_back_to_the_portable_folder_manifest() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("portable.txt"), "portable").unwrap();
        let snapshot = capture_with_program_and_limits(
            directory.path().to_str().unwrap(),
            OsStr::new("threadterm-definitely-missing-git"),
            MAX_ENTRIES,
            SNAPSHOT_BUDGET,
        );
        assert_eq!(snapshot["complete"], true, "{snapshot}");
        assert_eq!(snapshot["source"], "folder");
        assert_eq!(file_paths(&snapshot), vec!["portable.txt"]);
    }

    #[test]
    fn files_above_five_megabytes_use_metadata_and_still_detect_size_changes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.bin");
        fs::File::create(&path)
            .unwrap()
            .set_len(MAX_HASH_BYTES + 1)
            .unwrap();
        let before = capture(directory.path().to_str().unwrap());
        let entry = &before["files"][0];
        assert!(entry.get("sha256").is_none());
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_HASH_BYTES + 2)
            .unwrap();
        let after = capture(directory.path().to_str().unwrap());
        assert_eq!(
            change_tuples(&before, &after),
            vec![("large.bin".into(), "modified".into())]
        );
    }

    #[test]
    fn same_content_touch_is_not_a_change_for_hashed_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("small.txt");
        fs::write(&path, "same content").unwrap();
        let before = capture(directory.path().to_str().unwrap());
        let future = SystemTime::now() + Duration::from_secs(60);
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(future))
            .unwrap();
        let after = capture(directory.path().to_str().unwrap());
        assert_ne!(
            before["files"][0]["modified"], after["files"][0]["modified"],
            "the fixture must change only mtime"
        );
        assert_eq!(diff(&before, &after), Some(Vec::new()));
    }

    #[test]
    fn growing_content_reader_stops_after_the_limit_detection_byte() {
        struct GrowingReader {
            read: u64,
        }
        impl Read for GrowingReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                buffer.fill(b'x');
                self.read += buffer.len() as u64;
                Ok(buffer.len())
            }
        }
        let mut reader = GrowingReader { read: 0 };
        let error =
            bounded_content_hash(&mut reader, Instant::now() + Duration::from_secs(3)).unwrap_err();
        assert_eq!(error.reason(), "changed_during_capture");
        assert_eq!(reader.read, MAX_HASH_BYTES + 1);
    }

    #[test]
    fn git_manifest_detects_clean_paths_and_does_not_treat_index_or_commit_changes_as_folder_writes(
    ) {
        let repository = repository();
        let before = capture(repository.path().to_str().unwrap());
        assert_eq!(before["source"], "git", "{before}");
        assert!(file_paths(&before).contains(&"tracked.txt".to_owned()));
        assert!(!file_paths(&before).contains(&"target/tracked.txt".to_owned()));

        fs::write(repository.path().join("tracked.txt"), "two\n").unwrap();
        fs::remove_file(repository.path().join("gone.txt")).unwrap();
        fs::write(repository.path().join("untracked.txt"), "new\n").unwrap();
        fs::write(repository.path().join("ignored.log"), "ignored\n").unwrap();
        let changed = capture(repository.path().to_str().unwrap());
        assert!(!file_paths(&changed).contains(&"ignored.log".to_owned()));
        assert_eq!(
            change_tuples(&before, &changed),
            vec![
                ("gone.txt".into(), "deleted".into()),
                ("tracked.txt".into(), "modified".into()),
                ("untracked.txt".into(), "added".into()),
            ]
        );

        run_git(repository.path(), &["add", "."]);
        let staged = capture(repository.path().to_str().unwrap());
        assert_eq!(diff(&changed, &staged), Some(Vec::new()));
        run_git(repository.path(), &["commit", "-qm", "changed"]);
        let committed = capture(repository.path().to_str().unwrap());
        assert_eq!(diff(&staged, &committed), Some(Vec::new()));

        fs::write(repository.path().join("tracked.txt"), "temporary\n").unwrap();
        let dirty = capture(repository.path().to_str().unwrap());
        run_git(repository.path(), &["restore", "tracked.txt"]);
        let restored = capture(repository.path().to_str().unwrap());
        assert_eq!(
            change_tuples(&dirty, &restored),
            vec![("tracked.txt".into(), "modified".into())]
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_outside_the_folder_are_not_followed() {
        use std::os::unix::fs::symlink;
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("root");
        let outside = parent.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(&outside, root.join("outside-link")).unwrap();
        let snapshot = capture(root.to_str().unwrap());
        assert_eq!(snapshot["complete"], true, "{snapshot}");
        assert!(!file_paths(&snapshot)
            .iter()
            .any(|path| path.contains("secret.txt")));
    }

    #[cfg(windows)]
    #[test]
    fn file_symlinks_outside_the_folder_are_not_followed() {
        use std::os::windows::fs::symlink_file;
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("root");
        let outside = parent.path().join("outside.txt");
        fs::create_dir(&root).unwrap();
        fs::write(&outside, "secret").unwrap();
        let link = root.join("outside-link.txt");
        if let Err(error) = symlink_file(&outside, &link) {
            eprintln!("symlink test skipped because Windows denied fixture creation: {error}");
            return;
        }
        let snapshot = capture(root.to_str().unwrap());
        assert_eq!(snapshot["complete"], true, "{snapshot}");
        assert!(!file_paths(&snapshot)
            .iter()
            .any(|path| path == "outside.txt"));
    }

    #[cfg(windows)]
    #[test]
    fn junctions_outside_the_folder_are_not_followed() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("root");
        let outside = parent.path().join("outside");
        let junction = root.join("outside-junction");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        let output = Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let snapshot = capture(root.to_str().unwrap());
        assert_eq!(snapshot["complete"], true, "{snapshot}");
        assert!(!file_paths(&snapshot)
            .iter()
            .any(|path| path.contains("secret.txt")));
    }

    #[cfg(windows)]
    #[test]
    fn unreadable_file_makes_the_snapshot_incomplete() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("locked.txt");
        fs::write(&path, "locked").unwrap();
        let _exclusive = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        let snapshot = capture(directory.path().to_str().unwrap());
        assert_eq!(snapshot["complete"], false, "{snapshot}");
        assert_eq!(snapshot["reason"], "read_error");
    }

    #[test]
    #[ignore = "opt-in 5,000-file Git and non-Git timing probe"]
    fn five_thousand_file_snapshot_timings() {
        let plain = tempfile::Builder::new()
            .prefix("group-folder-plain-perf-")
            .tempdir()
            .unwrap();
        for index in 0..5_000 {
            fs::write(
                plain.path().join(format!("file-{index:04}.txt")),
                format!("plain {index}\n"),
            )
            .unwrap();
        }
        let started = Instant::now();
        let plain_snapshot = capture(plain.path().to_str().unwrap());
        let plain_elapsed = started.elapsed();

        let repository = tempfile::Builder::new()
            .prefix("group-folder-git-perf-")
            .tempdir()
            .unwrap();
        run_git(repository.path(), &["init", "-q", "-b", "main"]);
        run_git(
            repository.path(),
            &["config", "user.email", "qa@example.test"],
        );
        run_git(repository.path(), &["config", "user.name", "QA"]);
        for index in 0..5_000 {
            fs::write(
                repository.path().join(format!("file-{index:04}.txt")),
                format!("git {index}\n"),
            )
            .unwrap();
        }
        run_git(repository.path(), &["add", "."]);
        run_git(repository.path(), &["commit", "-qm", "fixture"]);
        let started = Instant::now();
        let git_snapshot = capture(repository.path().to_str().unwrap());
        let git_elapsed = started.elapsed();
        eprintln!(
            "group_folder 5,000 files: non_git={plain_elapsed:?} complete={} reason={}; git={git_elapsed:?} complete={} reason={}",
            plain_snapshot["complete"],
            plain_snapshot["reason"].as_str().unwrap_or("none"),
            git_snapshot["complete"],
            git_snapshot["reason"].as_str().unwrap_or("none"),
        );
        assert!(plain_elapsed < Duration::from_secs(4), "{plain_snapshot}");
        assert!(git_elapsed < Duration::from_secs(4), "{git_snapshot}");
    }
}
