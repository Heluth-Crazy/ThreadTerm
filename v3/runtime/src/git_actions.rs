//! Real Git mutations for registered project/worktree scopes.
//! Git is external state: an operation is only marked complete after Git returns
//! success; a daemon failure between those points is deliberately left retryable.
use crate::{
    db::Database,
    workspace_services::{fingerprint, git, root_for, scoped_path},
};
use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::{fs, process::Command};

const MAX_PATHS: usize = 500;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;

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
            args.extend(paths.iter().map(String::as_str));
            git(&root, &args)?;
            json!({"paths":paths})
        }
        "git.commit" => {
            let message = required_string(params, "message")?;
            if message.len() > MAX_MESSAGE_BYTES {
                return Err(anyhow!("invalid_commit_message"));
            }
            git(&root, &["commit", "-m", message])?;
            let commit = git(&root, &["rev-parse", "HEAD"])?;
            json!({"commit":commit.trim()})
        }
        "git.fetch" => json!({"output":git(&root, &["fetch", "--prune"])?}),
        "git.pull" => json!({"output":git(&root, &["pull", "--ff-only"])?}),
        "git.push" => json!({"output":git(&root, &["push", "--porcelain"])?}),
        "git.merge" => merge(&root, required_string(params, "branch")?)?,
        "git.merge.abort" => json!({"output":git(&root, &["merge", "--abort"])?}),
        _ => unreachable!(),
    };
    // Do not hide an uncertain external outcome: failure to persist completion is returned
    // to the caller; the reserved operation remains distinguishable from a successful one.
    db.transaction(|tx| complete(tx, operation_id, method, &result))?;
    Ok(Some(result))
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
fn complete(tx: &Transaction<'_>, operation_id: &str, method: &str, result: &Value) -> Result<()> {
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
}
