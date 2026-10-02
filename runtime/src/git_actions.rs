//! Real Git mutations for registered project/worktree scopes.
//! Git is external state: an operation is only marked complete after Git returns
//! success; a daemon failure between those points is deliberately left retryable.
use crate::{
    db::Database,
    git_read::{
        read_blob, repo_prefix, run_git, validate_relative, LOCAL_TIMEOUT, MAX_TEXT_BYTES,
        NETWORK_TIMEOUT,
    },
    workspace_services::{fingerprint, git, root_for, scoped_path},
};
use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::{fs, path::Path, process::Command, time::Duration};

const MAX_PATHS: usize = 500;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// Commit and branch switches may run user hooks (lint, post-checkout).
const HOOK_TIMEOUT: Duration = Duration::from_secs(300);

pub fn dispatch(db: &Database, method: &str, params_value: &Value) -> Result<Option<Value>> {
    if !matches!(
        method,
        "git.stage"
            | "git.unstage"
            | "git.commit"
            | "git.fetch"
            | "git.pull"
            | "git.push"
            | "git.merge"
            | "git.merge.abort"
            | "git.index.write"
            | "git.discard"
            | "git.checkout"
            | "git.branch.delete"
    ) {
        return Ok(None);
    }
    let params = params_value
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let operation_id = required_string(params, "operationId")?;
    let project_id = required_string(params, "projectId")?;
    let worktree = params.get("worktreePath").and_then(Value::as_str);
    let root = db.transaction(|tx| root_for(tx, project_id, worktree))?;
    if method == "git.merge" {
        let branch = required_string(params, "branch")?;
        validate_merge_target(&root, branch)?;
        ensure_clean(&root)?;
    }
    // Validation and fences run before the claim so a rejected request stays retryable.
    match method {
        "git.index.write" => {
            let path = required_string(params, "path")?;
            validate_relative(path)?;
            repo_prefix(&root)?;
            let content = params
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("invalid_content"))?;
            if content.len() > MAX_TEXT_BYTES || content.as_bytes().contains(&0) {
                return Err(anyhow!("invalid_content"));
            }
            let expected = match params.get("expectedIndexFingerprint") {
                Some(Value::Null) => None,
                Some(Value::String(value)) if !value.is_empty() => Some(value.as_str()),
                _ => return Err(anyhow!("invalid_request")),
            };
            if index_entry(&root, path)?
                .map(|entry| entry.fingerprint)
                .as_deref()
                != expected
            {
                return Err(anyhow!("index_conflict"));
            }
        }
        "git.checkout" => {
            validate_branch_name(&root, required_string(params, "branch")?)?;
            if let Some(start) = params.get("startPoint").and_then(Value::as_str) {
                if start.is_empty() || start.starts_with('-') || start.len() > 255 {
                    return Err(anyhow!("invalid_start_point"));
                }
                let spec = format!("{start}^{{commit}}");
                git(&root, &["rev-parse", "--verify", "--quiet", &spec])
                    .map_err(|_| anyhow!("start_point_not_found"))?;
            }
        }
        "git.branch.delete" => {
            validate_branch_name(&root, required_string(params, "branch")?)?;
        }
        "git.discard" => {
            let paths = paths(params)?;
            for path in &paths {
                validate_relative(path)?;
            }
            verify_fingerprints(&root, &paths, params.get("expectedFingerprints"))?;
        }
        // `diff --cached --quiet` exits 1 (an error here) when something is staged.
        "git.commit"
            if params.get("amend").and_then(Value::as_bool) != Some(true)
                && run_git(
                    &root,
                    &["diff", "--cached", "--quiet"],
                    &[],
                    None,
                    LOCAL_TIMEOUT,
                )
                .is_ok() =>
        {
            return Err(anyhow!("nothing_staged"));
        }
        _ => {}
    }
    if let Some(result) = db.operation(operation_id)? {
        return Ok(Some(result));
    }
    db.bind_operation(operation_id, method, params_value)?;
    if let Some(result) = db.operation(operation_id)? {
        return Ok(Some(result));
    }
    // This insert is an atomic execution claim. A caller that finds a claim without
    // completion cannot know whether Git already applied the external side effect.
    if !db.claim_external_operation(operation_id)? {
        return Err(anyhow!("operation_outcome_unknown"));
    }
    let project_id = required_string(params, "projectId")?;
    let worktree = params.get("worktreePath").and_then(Value::as_str);
    let root = db.transaction(|tx| root_for(tx, project_id, worktree))?;
    let result = match method {
        "git.stage" | "git.unstage" => {
            let paths = paths(params)?;
            verify_fingerprints(&root, &paths, params.get("expectedFingerprints"))?;
            let mut args = if method == "git.stage" {
                vec!["add", "--"]
            } else {
                vec!["restore", "--staged", "--"]
            };
            // An unborn branch has no HEAD to restore from; drop the index entries instead.
            if method == "git.unstage" && !has_head(&root) {
                args = vec!["rm", "--cached", "-q", "--"];
            }
            args.extend(paths.iter().map(String::as_str));
            git(&root, &args)?;
            json!({"paths":paths})
        }
        "git.commit" => {
            let message = required_string(params, "message")?;
            if message.len() > MAX_MESSAGE_BYTES {
                return Err(anyhow!("invalid_commit_message"));
            }
            let amend = params.get("amend").and_then(Value::as_bool) == Some(true);
            let mut args = vec!["commit", "-m", message];
            if amend {
                args.push("--amend");
            }
            run_git(&root, &args, &[], None, HOOK_TIMEOUT)?;
            let commit = git(&root, &["rev-parse", "HEAD"])?;
            json!({"commit":commit.trim()})
        }
        "git.fetch" => json!({"output":network(&root, &["fetch", "--prune"])?}),
        "git.pull" => json!({"output":network(&root, &["pull", "--ff-only"])?}),
        "git.push" => {
            if params.get("setUpstream").and_then(Value::as_bool) == Some(true) {
                let remote = default_remote(&root)?;
                json!({"output":network(&root, &["push", "--porcelain", "-u", &remote, "HEAD"])?})
            } else {
                json!({"output":network(&root, &["push", "--porcelain"])?})
            }
        }
        "git.index.write" => {
            let path = required_string(params, "path")?;
            let content = params
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("invalid_content"))?;
            let mode = index_entry(&root, path)?
                .map(|entry| entry.mode)
                .unwrap_or_else(|| "100644".to_owned());
            let path_arg = format!("--path={path}");
            let oid = String::from_utf8(run_git(
                &root,
                &["hash-object", "-w", "--stdin", &path_arg],
                &[],
                Some(content.as_bytes()),
                LOCAL_TIMEOUT,
            )?)?
            .trim()
            .to_owned();
            let info = format!("{mode},{oid},{path}");
            git(&root, &["update-index", "--add", "--cacheinfo", &info])?;
            let stored = index_entry(&root, path)?.ok_or_else(|| anyhow!("git_failed"))?;
            json!({"path":path,"indexFingerprint":stored.fingerprint})
        }
        "git.discard" => {
            let paths = paths(params)?;
            let mut tracked = Vec::new();
            let mut untracked = Vec::new();
            for path in &paths {
                if git(&root, &["ls-files", "-z", "--", path])?.is_empty() {
                    untracked.push(path.clone());
                } else {
                    tracked.push(path.clone());
                }
            }
            if !tracked.is_empty() {
                let mut args = vec!["restore", "--worktree", "--"];
                args.extend(tracked.iter().map(String::as_str));
                git(&root, &args)?;
            }
            for path in &untracked {
                crate::file_ops::recycle(&scoped_path(&root, path, true)?)?;
            }
            json!({"paths":paths,"recycled":untracked})
        }
        "git.checkout" => {
            let branch = required_string(params, "branch")?;
            let create = params.get("create").and_then(Value::as_bool) == Some(true);
            let local = format!("refs/heads/{branch}");
            let remote = format!("refs/remotes/{branch}");
            let exists = |reference: &str| {
                git(&root, &["rev-parse", "--verify", "--quiet", reference]).is_ok()
            };
            let args: Vec<&str> = if create {
                let mut args = vec!["switch", "-c", branch];
                if let Some(start) = params.get("startPoint").and_then(Value::as_str) {
                    args.push(start);
                }
                args
            } else if exists(&local) {
                vec!["switch", branch]
            } else if exists(&remote) {
                vec!["switch", "--track", branch]
            } else {
                return Err(anyhow!("branch_not_found"));
            };
            run_git(&root, &args, &[], None, HOOK_TIMEOUT)?;
            let current = git(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
            json!({"branch":current.trim()})
        }
        "git.branch.delete" => {
            let branch = required_string(params, "branch")?;
            let flag = if params.get("force").and_then(Value::as_bool) == Some(true) {
                "-D"
            } else {
                "-d"
            };
            git(&root, &["branch", flag, branch]).map_err(|error| {
                if error.to_string().contains("not fully merged") {
                    anyhow!("branch_not_merged")
                } else {
                    error
                }
            })?;
            json!({"branch":branch})
        }
        "git.merge" => merge(&root, required_string(params, "branch")?)?,
        "git.merge.abort" => json!({"output":git(&root, &["merge", "--abort"])?}),
        _ => unreachable!(),
    };
    // Do not hide an uncertain external outcome: failure to persist completion is returned
    // to the caller; the reserved operation remains distinguishable from a successful one.
    db.transaction(|tx| complete(tx, operation_id, method, &result))?;
    Ok(Some(result))
}

struct IndexEntry {
    mode: String,
    fingerprint: String,
}

/// The stage-0 index entry of `path`; unmerged paths are refused.
fn index_entry(root: &Path, path: &str) -> Result<Option<IndexEntry>> {
    let listing = git(root, &["ls-files", "-s", "-z", "--", path])?;
    let mut entry = None;
    for record in listing.split('\0').filter(|record| !record.is_empty()) {
        let (meta, _) = record
            .split_once('\t')
            .ok_or_else(|| anyhow!("git_failed"))?;
        let fields: Vec<&str> = meta.split(' ').collect();
        if fields.len() != 3 {
            return Err(anyhow!("git_failed"));
        }
        if fields[2] != "0" {
            return Err(anyhow!("index_unmerged"));
        }
        entry = Some(fields[0].to_owned());
    }
    let Some(mode) = entry else {
        return Ok(None);
    };
    let bytes = read_blob(root, "", path)?.ok_or_else(|| anyhow!("git_failed"))?;
    Ok(Some(IndexEntry {
        mode,
        fingerprint: fingerprint(&bytes),
    }))
}

fn has_head(root: &Path) -> bool {
    git(root, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).is_ok()
}

fn network(root: &Path, args: &[&str]) -> Result<String> {
    let output = run_git(root, args, &[], None, NETWORK_TIMEOUT)?;
    Ok(String::from_utf8_lossy(&output).into_owned())
}

fn default_remote(root: &Path) -> Result<String> {
    let remotes: Vec<String> = git(root, &["remote"])?
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect();
    if remotes.iter().any(|remote| remote == "origin") {
        Ok("origin".to_owned())
    } else if remotes.len() == 1 {
        Ok(remotes[0].clone())
    } else {
        Err(anyhow!("no_remote"))
    }
}

fn validate_branch_name(root: &Path, branch: &str) -> Result<()> {
    if branch.len() > 255 || branch.starts_with('-') {
        return Err(anyhow!("invalid_branch"));
    }
    git(root, &["check-ref-format", "--branch", branch]).map_err(|_| anyhow!("invalid_branch"))?;
    Ok(())
}

fn ensure_clean(root: &std::path::Path) -> Result<()> {
    if !git(root, &["status", "--porcelain"])?.trim().is_empty() {
        Err(anyhow!("git_worktree_dirty"))
    } else {
        Ok(())
    }
}
fn validate_merge_target(root: &std::path::Path, branch: &str) -> Result<()> {
    if branch.len() > 255 || branch.starts_with('-') {
        return Err(anyhow!("invalid_branch"));
    }
    git(root, &["check-ref-format", "--branch", branch])?;
    let reference = format!("refs/heads/{branch}");
    git(root, &["rev-parse", "--verify", "--quiet", &reference])
        .map(|_| ())
        .map_err(|_| anyhow!("branch_not_found"))
}
fn merge(root: &std::path::Path, branch: &str) -> Result<Value> {
    let output = Command::new("git")
        .args(["merge", "--no-edit", "--", branch])
        .current_dir(root)
        .output()?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success() {
        return Ok(json!({"output":text,"conflicted":false}));
    }
    let conflicted = !git(root, &["diff", "--name-only", "--diff-filter=U"])?
        .trim()
        .is_empty();
    if conflicted {
        Ok(json!({"output":text,"conflicted":true}))
    } else {
        Err(anyhow!("git_merge_failed: {text}"))
    }
}
fn required_string<'a>(object: &'a serde_json::Map<String, Value>, key: &str) -> Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("invalid_request"))
}
fn paths(object: &serde_json::Map<String, Value>) -> Result<Vec<String>> {
    let values = object
        .get("paths")
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty() && values.len() <= MAX_PATHS)
        .ok_or_else(|| anyhow!("invalid_paths"))?;
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|path| !path.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| anyhow!("invalid_path"))
        })
        .collect()
}
fn verify_fingerprints(
    root: &std::path::Path,
    paths: &[String],
    requested: Option<&Value>,
) -> Result<()> {
    let Some(requested) = requested else {
        return Ok(());
    };
    let requested = requested
        .as_object()
        .ok_or_else(|| anyhow!("invalid_fingerprints"))?;
    if requested.len() > MAX_PATHS {
        return Err(anyhow!("invalid_fingerprints"));
    }
    for (path, expected) in requested {
        if !paths.iter().any(|candidate| candidate == path) {
            return Err(anyhow!("invalid_fingerprints"));
        }
        let expected = expected
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("invalid_fingerprints"))?;
        let resolved = scoped_path(root, path, true)?;
        let bytes = fs::read(resolved)?;
        if fingerprint(&bytes) != expected {
            return Err(anyhow!("file_conflict"));
        }
    }
    Ok(())
}
pub(crate) fn complete(
    tx: &Transaction<'_>,
    operation_id: &str,
    method: &str,
    result: &Value,
) -> Result<()> {
    let prior: Option<String> = tx
        .query_row(
            "SELECT result FROM operations WHERE id=?",
            [operation_id],
            |row| row.get(0),
        )
        .optional()?;
    if prior.is_some() {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO operations(id,method,result,created_at) VALUES(?,?,?,?)",
        params![
            operation_id,
            method,
            serde_json::to_string(result)?,
            Utc::now().to_rfc3339()
        ],
    )?;
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES('state.changed','{}',?)",
        [Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_services::initialize;
    use std::fs;

    fn setup() -> (tempfile::TempDir, Database, String) {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init"]).unwrap();
        git(
            temp.path(),
            &["config", "user.email", "tests@threadterm.invalid"],
        )
        .unwrap();
        git(temp.path(), &["config", "user.name", "ThreadTerm Tests"]).unwrap();
        fs::write(temp.path().join("a.txt"), "base").unwrap();
        git(temp.path(), &["add", "a.txt"]).unwrap();
        git(temp.path(), &["commit", "-m", "initial"]).unwrap();
        let db = Database::open(&temp.path().join("runtime.sqlite")).unwrap();
        fs::write(temp.path().join(".git/info/exclude"), "runtime.sqlite*\n").unwrap();
        initialize(&db).unwrap();
        let project = db
            .add_project(temp.path().to_str().unwrap(), Some("p"), "project-add")
            .unwrap();
        (temp, db, project.id)
    }
    #[test]
    fn stage_unstage_and_commit_are_real_and_idempotent() {
        let (temp, db, project_id) = setup();
        fs::write(temp.path().join("a.txt"), "changed").unwrap();
        let fp = fingerprint(b"changed");
        let stage = json!({"projectId":project_id,"paths":["a.txt"],"expectedFingerprints":{"a.txt":fp},"operationId":"stage"});
        assert_eq!(
            dispatch(&db, "git.stage", &stage).unwrap().unwrap()["paths"],
            json!(["a.txt"])
        );
        assert_eq!(
            dispatch(&db, "git.stage", &stage).unwrap().unwrap()["paths"],
            json!(["a.txt"])
        );
        assert!(git(temp.path(), &["diff", "--cached", "--name-only"])
            .unwrap()
            .contains("a.txt"));
        assert!(dispatch(
            &db,
            "git.unstage",
            &json!({"projectId":project_id,"paths":["a.txt"],"operationId":"unstage"})
        )
        .unwrap()
        .is_some());
        assert!(git(temp.path(), &["diff", "--cached", "--name-only"])
            .unwrap()
            .is_empty());
        dispatch(
            &db,
            "git.stage",
            &json!({"projectId":project_id,"paths":["a.txt"],"operationId":"restage"}),
        )
        .unwrap();
        let committed = dispatch(
            &db,
            "git.commit",
            &json!({"projectId":project_id,"message":"real mutation","operationId":"commit"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(committed["commit"].as_str().unwrap().len(), 40);
        assert_eq!(
            git(temp.path(), &["log", "-1", "--pretty=%s"])
                .unwrap()
                .trim(),
            "real mutation"
        );
    }
    #[test]
    fn fetch_pull_fast_forward_only_and_push_use_a_local_bare_remote() {
        let (temp, db, project_id) = setup();
        let remote = tempfile::tempdir().unwrap();
        git(remote.path(), &["init", "--bare"]).unwrap();
        git(
            temp.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        )
        .unwrap();
        git(temp.path(), &["push", "-u", "origin", "master"]).unwrap();
        assert!(dispatch(
            &db,
            "git.push",
            &json!({"projectId":project_id,"operationId":"push"})
        )
        .unwrap()
        .is_some());
        assert!(dispatch(
            &db,
            "git.fetch",
            &json!({"projectId":project_id,"operationId":"fetch"})
        )
        .unwrap()
        .is_some());
        assert!(dispatch(
            &db,
            "git.pull",
            &json!({"projectId":project_id,"operationId":"pull"})
        )
        .unwrap()
        .is_some());
    }
    #[test]
    fn staging_rejects_stale_or_escaping_fingerprints() {
        let (temp, db, project_id) = setup();
        fs::write(temp.path().join("a.txt"), "changed").unwrap();
        assert!(dispatch(&db, "git.stage", &json!({"projectId":project_id,"paths":["a.txt"],"expectedFingerprints":{"a.txt":"stale"},"operationId":"stale"})).is_err());
        assert!(dispatch(&db, "git.stage", &json!({"projectId":project_id,"paths":["a.txt"],"expectedFingerprints":{"../outside":"x"},"operationId":"escape"})).is_err());
        let unknown = json!({"projectId":project_id,"paths":["a.txt"],"operationId":"unknown"});
        db.bind_operation("unknown", "git.stage", &unknown).unwrap();
        assert!(db.claim_external_operation("unknown").unwrap());
        assert!(dispatch(&db, "git.stage", &unknown)
            .unwrap_err()
            .to_string()
            .contains("operation_outcome_unknown"));
    }
    #[test]
    fn merge_reports_success_conflict_and_explicit_abort() {
        let (temp, db, project_id) = setup();
        git(temp.path(), &["checkout", "-b", "feature"]).unwrap();
        fs::write(temp.path().join("a.txt"), "feature").unwrap();
        git(temp.path(), &["commit", "-am", "feature"]).unwrap();
        git(temp.path(), &["checkout", "master"]).unwrap();
        let success = dispatch(
            &db,
            "git.merge",
            &json!({"projectId":project_id,"branch":"feature","operationId":"merge-success"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(success["conflicted"], false);
        assert_eq!(
            fs::read_to_string(temp.path().join("a.txt")).unwrap(),
            "feature"
        );
        git(temp.path(), &["checkout", "-b", "conflict"]).unwrap();
        fs::write(temp.path().join("a.txt"), "branch").unwrap();
        git(temp.path(), &["commit", "-am", "branch"]).unwrap();
        git(temp.path(), &["checkout", "master"]).unwrap();
        fs::write(temp.path().join("a.txt"), "main").unwrap();
        git(temp.path(), &["commit", "-am", "main"]).unwrap();
        let conflict = dispatch(
            &db,
            "git.merge",
            &json!({"projectId":project_id,"branch":"conflict","operationId":"merge-conflict"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(conflict["conflicted"], true);
        assert!(
            !git(temp.path(), &["diff", "--name-only", "--diff-filter=U"])
                .unwrap()
                .trim()
                .is_empty()
        );
        let aborted = dispatch(
            &db,
            "git.merge.abort",
            &json!({"projectId":project_id,"operationId":"merge-abort"}),
        )
        .unwrap()
        .unwrap();
        assert!(aborted["output"].is_string());
        assert!(git(temp.path(), &["status", "--porcelain"])
            .unwrap()
            .trim()
            .is_empty());
        assert_eq!(
            fs::read_to_string(temp.path().join("a.txt")).unwrap(),
            "main"
        );
    }

    fn call(db: &Database, method: &str, params: Value) -> Result<Value> {
        dispatch(db, method, &params).map(Option::unwrap)
    }

    #[test]
    fn diff_semantics_and_partial_index_writes_are_fenced() {
        let (temp, db, project) = setup();
        let committed = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
        fs::write(temp.path().join("b.txt"), committed).unwrap();
        git(temp.path(), &["add", "b.txt"]).unwrap();
        git(temp.path(), &["commit", "-m", "b"]).unwrap();
        let edited = "1\nX\n3\n4\n5\n6\n7\n8\nY\n10\n";
        fs::write(temp.path().join("b.txt"), edited).unwrap();

        let unstaged = crate::workspace_services::git_diff(temp.path(), "b.txt", false).unwrap();
        assert_eq!(unstaged["oldText"], committed);
        assert_eq!(unstaged["newText"], edited);
        let index_fp = fingerprint(committed.as_bytes());
        assert_eq!(unstaged["indexFingerprint"], index_fp);

        // Stage only the first hunk: the index gets X but keeps 9.
        let partial = "1\nX\n3\n4\n5\n6\n7\n8\n9\n10\n";
        let written = call(&db, "git.index.write", json!({"projectId":project,"path":"b.txt","content":partial,"expectedIndexFingerprint":index_fp,"operationId":"iw1"})).unwrap();
        assert_eq!(written["indexFingerprint"], fingerprint(partial.as_bytes()));
        let staged = crate::workspace_services::git_diff(temp.path(), "b.txt", true).unwrap();
        assert_eq!(staged["oldText"], committed);
        assert_eq!(staged["newText"], partial);
        let unstaged = crate::workspace_services::git_diff(temp.path(), "b.txt", false).unwrap();
        assert_eq!(unstaged["oldText"], partial);
        assert_eq!(
            fs::read_to_string(temp.path().join("b.txt")).unwrap(),
            edited
        );

        // A view based on the old index content can no longer write.
        assert!(call(&db, "git.index.write", json!({"projectId":project,"path":"b.txt","content":committed,"expectedIndexFingerprint":index_fp,"operationId":"iw2"})).unwrap_err().to_string().contains("index_conflict"));
        let status = crate::workspace_services::git_status(temp.path()).unwrap();
        let entry = status["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|change| change["path"] == "b.txt")
            .unwrap()
            .clone();
        assert_eq!(
            (
                entry["indexStatus"].as_str(),
                entry["worktreeStatus"].as_str()
            ),
            (Some("M"), Some("M"))
        );

        // Untracked files can be staged partially from an empty index side.
        fs::write(temp.path().join("new.txt"), "keep\ndrop\n").unwrap();
        call(&db, "git.index.write", json!({"projectId":project,"path":"new.txt","content":"keep\n","expectedIndexFingerprint":null,"operationId":"iw3"})).unwrap();
        let staged_new = crate::workspace_services::git_diff(temp.path(), "new.txt", true).unwrap();
        assert_eq!(
            (
                staged_new["oldText"].as_str(),
                staged_new["newText"].as_str()
            ),
            (Some(""), Some("keep\n"))
        );

        // Discarding a tracked file restores the index version, not HEAD.
        call(
            &db,
            "git.discard",
            json!({"projectId":project,"paths":["b.txt"],"operationId":"dc1"}),
        )
        .unwrap();
        // Checkout applies the user's core.autocrlf, so compare line content only.
        assert_eq!(
            fs::read_to_string(temp.path().join("b.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            partial
        );

        // A deleted working file is reported as such instead of failing.
        fs::remove_file(temp.path().join("a.txt")).unwrap();
        let deleted = crate::workspace_services::git_diff(temp.path(), "a.txt", false).unwrap();
        assert_eq!(
            (deleted["deleted"].as_bool(), deleted["newText"].as_str()),
            (Some(true), Some(""))
        );
    }

    #[test]
    fn commit_refuses_empty_index_and_amends() {
        let (temp, db, project) = setup();
        assert!(call(
            &db,
            "git.commit",
            json!({"projectId":project,"message":"empty","operationId":"c0"})
        )
        .unwrap_err()
        .to_string()
        .contains("nothing_staged"));
        let parent = git(temp.path(), &["rev-parse", "HEAD"]).unwrap();
        fs::write(temp.path().join("a.txt"), "next").unwrap();
        call(
            &db,
            "git.stage",
            json!({"projectId":project,"paths":["a.txt"],"operationId":"s1"}),
        )
        .unwrap();
        call(
            &db,
            "git.commit",
            json!({"projectId":project,"message":"first try","operationId":"c1"}),
        )
        .unwrap();
        call(
            &db,
            "git.commit",
            json!({"projectId":project,"message":"reworded","amend":true,"operationId":"c2"}),
        )
        .unwrap();
        assert_eq!(
            git(temp.path(), &["log", "-1", "--format=%s"])
                .unwrap()
                .trim(),
            "reworded"
        );
        assert_eq!(git(temp.path(), &["rev-parse", "HEAD^"]).unwrap(), parent);
    }

    #[test]
    fn branches_can_be_created_switched_and_deleted_safely() {
        let (temp, db, project) = setup();
        let original = git(temp.path(), &["symbolic-ref", "--short", "HEAD"])
            .unwrap()
            .trim()
            .to_owned();
        let created = call(
            &db,
            "git.checkout",
            json!({"projectId":project,"branch":"feature/新","create":true,"operationId":"b1"}),
        )
        .unwrap();
        assert_eq!(created["branch"], "feature/新");
        fs::write(temp.path().join("a.txt"), "feature").unwrap();
        git(temp.path(), &["commit", "-am", "feature work"]).unwrap();
        call(
            &db,
            "git.checkout",
            json!({"projectId":project,"branch":original,"operationId":"b2"}),
        )
        .unwrap();
        assert!(call(
            &db,
            "git.branch.delete",
            json!({"projectId":project,"branch":"feature/新","operationId":"b3"})
        )
        .unwrap_err()
        .to_string()
        .contains("branch_not_merged"));
        call(
            &db,
            "git.branch.delete",
            json!({"projectId":project,"branch":"feature/新","force":true,"operationId":"b4"}),
        )
        .unwrap();
        for bad in ["-x", "a..b", "bad name"] {
            assert!(call(&db, "git.checkout", json!({"projectId":project,"branch":bad,"create":true,"operationId":format!("bad-{bad}")})).is_err(), "{bad}");
        }
        assert!(call(
            &db,
            "git.checkout",
            json!({"projectId":project,"branch":"missing","operationId":"b5"})
        )
        .unwrap_err()
        .to_string()
        .contains("branch_not_found"));
    }

    #[test]
    fn status_is_relative_to_a_subdirectory_root_and_keeps_rename_origins() {
        let (temp, db, _project) = setup();
        fs::create_dir(temp.path().join("pkg")).unwrap();
        fs::write(temp.path().join("pkg").join("f.txt"), "f").unwrap();
        git(temp.path(), &["add", "."]).unwrap();
        git(temp.path(), &["commit", "-m", "pkg"]).unwrap();
        git(temp.path(), &["mv", "pkg/f.txt", "pkg/g.txt"]).unwrap();
        fs::write(temp.path().join("pkg").join("g.txt"), "changed").unwrap();
        fs::write(temp.path().join("a.txt"), "outside").unwrap();
        let status = crate::workspace_services::git_status(&temp.path().join("pkg")).unwrap();
        assert_eq!(
            status["changes"],
            json!([{"path":"g.txt","originalPath":"f.txt","indexStatus":"R","worktreeStatus":"M","untracked":false}])
        );
        let _ = db;
    }
}
