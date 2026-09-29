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
use std::{
    collections::HashMap,
    ffi::OsStr,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub(crate) const LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_LOG_PAGE: usize = 200;
const ZERO_COMMIT: &str = "0000000000000000000000000000000000000000";

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
    let mut child = command.spawn().context("launching git")?;
    if let Some(input) = stdin {
        let mut pipe = child.stdin.take().ok_or_else(|| anyhow!("git_failed"))?;
        let data = input.to_vec();
        std::thread::spawn(move || {
            let _ = pipe.write_all(&data);
        });
    }
    let mut stdout = child.stdout.take().ok_or_else(|| anyhow!("git_failed"))?;
    let mut stderr = child.stderr.take().ok_or_else(|| anyhow!("git_failed"))?;
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            // Reader threads are detached: a grandchild (ssh, credential helper)
            // may keep the pipes open after Git itself is gone.
            return Err(anyhow!("git_timeout"));
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    if !status.success() {
        return Err(anyhow!(
            "git_failed: {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    Ok(stdout)
}

pub(crate) fn git_text(root: &Path, args: &[&str]) -> Result<String> {
    let bytes = run_git(root, args, &[], None, LOCAL_TIMEOUT)?;
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
        "git.branches" | "git.log" | "git.commit.show" | "git.commit.diff" | "git.blame"
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
        _ => unreachable!(),
    };
    Ok(Some(result))
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

    pub(crate) fn repo() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "-q", "-b", "main"]).unwrap();
        git(temp.path(), &["config", "user.email", "qa@example.test"]).unwrap();
        git(temp.path(), &["config", "user.name", "QA"]).unwrap();
        git(temp.path(), &["config", "core.autocrlf", "false"]).unwrap();
        temp
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
}
