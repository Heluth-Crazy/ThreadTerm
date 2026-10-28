//! Real Git mutations for registered project/worktree scopes.
//! Git is external state: an operation is only marked complete after Git returns
//! success; a daemon failure between those points is deliberately left retryable.
use crate::{
    db::Database,
    git_read::{
        blob_fingerprint, fingerprint_reader, repo_prefix, run_git, validate_relative,
        LOCAL_TIMEOUT, MAX_TEXT_BYTES, NETWORK_TIMEOUT,
    },
    workspace_services::{fingerprint, git, root_for, scoped_path},
};
use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::{fs, path::Path, time::Duration};

const MAX_PATHS: usize = 500;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// Commit and branch switches may run user hooks (lint, post-checkout).
const HOOK_TIMEOUT: Duration = Duration::from_secs(300);

#[cfg(test)]
thread_local! {
    static MERGE_TIMEOUT_OVERRIDE: std::cell::Cell<Option<Duration>> = const { std::cell::Cell::new(None) };
}

pub fn dispatch(db: &Database, method: &str, params_value: &Value) -> Result<Option<Value>> {
    // This read shares the exact worktree/index snapshot logic with discard, but never
    // binds, claims or completes an operation.
    if method == "git.fingerprints" {
        let params = params_value
            .as_object()
            .ok_or_else(|| anyhow!("invalid_request"))?;
        let project_id = required_string(params, "projectId")?;
        let worktree = params.get("worktreePath").and_then(Value::as_str);
        let root = db.transaction(|tx| root_for(tx, project_id, worktree))?;
        return discard_fingerprints(&root, &paths(params)?).map(Some);
    }
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
    if method == "git.discard" {
        if let Some(result) = db.operation(operation_id)? {
            db.bind_operation(operation_id, method, params_value)?;
            return Ok(Some(result));
        }
        if db.external_operation_pending(operation_id)? {
            db.bind_operation(operation_id, method, params_value)?;
            return Err(anyhow!("operation_outcome_unknown"));
        }
    }
    let root = db.transaction(|tx| root_for(tx, project_id, worktree))?;
    // A completed receipt is replayed before any preflight that reads mutable state:
    // a retry after a lost response is the same operation even when the index or
    // working tree has changed since it succeeded.
    if let Some(result) = db.operation(operation_id)? {
        db.bind_operation(operation_id, method, params_value)?;
        return Ok(Some(result));
    }
    let merge_target = if method == "git.merge" {
        let target = merge_target(&root, params)?;
        ensure_clean(&root)?;
        Some(target)
    } else {
        None
    };
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
            if let Some(result) = discard_preflight(db, &root, params_value)? {
                return Ok(Some(result));
            }
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
        "git.pull" => json!({"output":pull(&root)?}),
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
        "git.discard" => discard_paths(
            db,
            operation_id,
            &root,
            &paths(params)?,
            params,
            (project_id, worktree),
        )?,
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
        "git.merge" => match merge(&root, merge_target.as_deref().ok_or_else(|| anyhow!("invalid_request"))?) {
            Ok(result) => result,
            Err(error) => {
                // Even a failed or restored merge changes the externally observed Git
                // state. Keep its claim uncertain, but always invalidate scoped readers.
                db.transaction(|tx| {
                    tx.execute(
                        "INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
                        params![serde_json::to_string(&json!({"kind":"git","projectId":project_id,"worktreePath":worktree}))?, Utc::now().to_rfc3339()],
                    )?;
                    Ok(())
                })?;
                return Err(error);
            }
        },
        "git.merge.abort" => json!({"output":git(&root, &["merge", "--abort"])?}),
        _ => unreachable!(),
    };
    // Do not hide an uncertain external outcome: failure to persist completion is returned
    // to the caller; the reserved operation remains distinguishable from a successful one.
    if let Err(error) = db.transaction(|tx| {
        complete(
            tx,
            operation_id,
            method,
            &result,
            Some((project_id, worktree)),
        )
    }) {
        if method == "git.discard" {
            return Err(discard_incomplete(
                db,
                (project_id, worktree),
                &paths(params)?,
                &[],
                error,
            ));
        }
        return Err(error);
    }
    Ok(Some(result))
}

fn discard_recycle_available(root: &Path) -> bool {
    #[cfg(test)]
    if let Some(available) = discard_test_hooks::available() {
        return available;
    }
    crate::file_ops::recycle_available(root)
}

fn discard_recycle(path: &Path) -> Result<()> {
    #[cfg(test)]
    if let Some(result) = discard_test_hooks::recycle(path) {
        return result;
    }
    crate::file_ops::recycle(path)
}

fn discard_path_summary(paths: &[String]) -> String {
    let mut summary = paths
        .iter()
        .take(3)
        .map(|path| {
            path.chars()
                .take(48)
                .map(|c| if c.is_control() { ' ' } else { c })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join(", ");
    if paths.len() > 3 {
        summary.push_str(&format!(", +{}", paths.len() - 3));
    }
    format!("[{summary}]")
}

fn discard_incomplete(
    db: &Database,
    scope: (&str, Option<&str>),
    completed: &[String],
    failed: &[String],
    error: anyhow::Error,
) -> anyhow::Error {
    // Publish refresh without a completion receipt; the external claim remains uncertain.
    let publication = db.transaction(|tx| {
        let data = json!({"kind":"git","projectId":scope.0,"worktreePath":scope.1});
        tx.execute(
            "INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
            params![serde_json::to_string(&data)?, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    });
    let detail: String = error
        .to_string()
        .chars()
        .take(96)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let refresh = if publication.is_err() {
        "; refresh event unavailable"
    } else {
        ""
    };
    anyhow!(
        "discard_incomplete: completed: {}; failed: {}; {detail}{refresh}",
        discard_path_summary(completed),
        discard_path_summary(failed)
    )
}

fn discard_paths(
    db: &Database,
    operation_id: &str,
    root: &Path,
    paths: &[String],
    params: &serde_json::Map<String, Value>,
    scope: (&str, Option<&str>),
) -> Result<Value> {
    // Prepare logical paths and arguments before the last fence. Resolve each
    // recycle target inside the effect, so no pre-fence canonical target is cached.
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for path in paths {
        if params["expectedIndexFingerprints"][path].is_null() {
            untracked.push(path.clone());
        } else {
            tracked.push((path.clone(), format!(":(literal){path}")));
        }
    }
    let mut completed = Vec::new();
    let mut recycled = Vec::new();
    // A write in the milliseconds between this final verification and an effect
    // is not detected. Keep git restore so eol/smudge/LFS filters still apply.
    verify_claimed_discard(db, operation_id, root, paths, params)?;
    for path in untracked {
        let resolved = match scoped_path(root, &path, true) {
            Ok(resolved) => resolved,
            Err(error) => {
                if !completed.is_empty() {
                    return Err(discard_incomplete(db, scope, &completed, &[path], error));
                }
                release_discard_claim(db, operation_id)?;
                return Err(error);
            }
        };
        if let Err(error) = discard_recycle(&resolved) {
            let changed = discard_worktree_fingerprint(root, &path)
                .map(|current| json!(current) != params["expectedFingerprints"][&path])
                .unwrap_or(true);
            if !completed.is_empty() || changed {
                return Err(discard_incomplete(db, scope, &completed, &[path], error));
            }
            return Err(error);
        }
        completed.push(path.clone());
        recycled.push(path);
    }
    for (path, literal) in tracked {
        // One path per command lets failures report which restores completed.
        if let Err(error) = git(root, &["restore", "--worktree", "--", &literal]) {
            let changed = discard_worktree_fingerprint(root, &path)
                .map(|current| json!(current) != params["expectedFingerprints"][&path])
                .unwrap_or(true);
            if !completed.is_empty() || changed {
                return Err(discard_incomplete(db, scope, &completed, &[path], error));
            }
            return Err(error);
        }
        completed.push(path);
    }
    Ok(json!({"paths":paths,"recycled":recycled}))
}

#[cfg(test)]
mod discard_test_hooks {
    use super::*;
    use std::{cell::RefCell, path::PathBuf};

    struct State {
        available: bool,
        fail_at: Option<usize>,
        attempts: usize,
        recycled: Vec<PathBuf>,
    }
    thread_local! { static STATE: RefCell<Option<State>> = const { RefCell::new(None) }; }
    pub struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            STATE.with(|state| *state.borrow_mut() = None);
        }
    }
    pub fn install(available: bool, fail_at: Option<usize>) -> Guard {
        STATE.with(|state| {
            *state.borrow_mut() = Some(State {
                available,
                fail_at,
                attempts: 0,
                recycled: Vec::new(),
            })
        });
        Guard
    }
    pub fn available() -> Option<bool> {
        STATE.with(|state| state.borrow().as_ref().map(|state| state.available))
    }
    pub fn recycle(path: &Path) -> Option<Result<()>> {
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            let state = state.as_mut()?;
            state.attempts += 1;
            if state.fail_at == Some(state.attempts) {
                return Some(Err(anyhow!("recycle_failed: injected")));
            }
            let destination = path.with_extension("discard-test-recycled");
            let result = fs::rename(path, &destination).map_err(Into::into);
            if result.is_ok() {
                state.recycled.push(destination);
            }
            Some(result)
        })
    }
}

/// Resolve existing files through the registered-root guard. For an absent path,
/// check its nearest existing ancestor as well (including junction/symlink parents).
fn discard_worktree_fingerprint(root: &Path, path: &str) -> Result<Option<String>> {
    validate_relative(path)?;
    let candidate = root.join(path);
    match fs::symlink_metadata(&candidate) {
        Ok(metadata) => {
            let resolved = scoped_path(root, path, true).map_err(|error| {
                if error.to_string() == "path_escape" {
                    anyhow!("invalid_path")
                } else {
                    error
                }
            })?;
            if !metadata.is_file() {
                return Err(anyhow!("invalid_file_type"));
            }
            Ok(Some(fingerprint_reader(fs::File::open(resolved)?)?))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let canonical_root = root.canonicalize()?;
            let mut ancestor = candidate.parent().ok_or_else(|| anyhow!("invalid_path"))?;
            loop {
                match fs::symlink_metadata(ancestor) {
                    Ok(_) => {
                        let canonical = ancestor
                            .canonicalize()
                            .map_err(|_| anyhow!("invalid_path"))?;
                        if !canonical.starts_with(&canonical_root) {
                            return Err(anyhow!("invalid_path"));
                        }
                        if !fs::metadata(&canonical)?.is_dir() {
                            return Err(anyhow!("invalid_file_type"));
                        }
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        ancestor = ancestor.parent().ok_or_else(|| anyhow!("invalid_path"))?;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            Ok(None)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => {
            Err(anyhow!("invalid_file_type"))
        }
        Err(error) => Err(error.into()),
    }
}

fn discard_fingerprints(root: &Path, paths: &[String]) -> Result<Value> {
    let mut files = serde_json::Map::new();
    let mut index = serde_json::Map::new();
    for path in paths {
        files.insert(
            path.clone(),
            json!(discard_worktree_fingerprint(root, path)?),
        );
        index.insert(
            path.clone(),
            json!(index_entry(root, path)?.map(|entry| entry.fingerprint)),
        );
    }
    Ok(json!({"fingerprints":files,"indexFingerprints":index}))
}

fn discard_expected_map<'a>(
    params: &'a serde_json::Map<String, Value>,
    key: &str,
    paths: &[String],
) -> Result<&'a serde_json::Map<String, Value>> {
    let map = params
        .get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("invalid_fingerprints"))?;
    let unique: std::collections::HashSet<_> = paths.iter().collect();
    if map.len() != unique.len()
        || paths.iter().any(|path| !map.contains_key(path))
        || map
            .values()
            .any(|value| !value.is_null() && !value.is_string())
    {
        return Err(anyhow!("invalid_fingerprints"));
    }
    Ok(map)
}

fn verify_discard_fingerprints(
    root: &Path,
    paths: &[String],
    params: &serde_json::Map<String, Value>,
) -> Result<()> {
    let files = discard_expected_map(params, "expectedFingerprints", paths)?;
    let index = discard_expected_map(params, "expectedIndexFingerprints", paths)?;
    let snapshot = discard_fingerprints(root, paths)?;
    if snapshot["fingerprints"].as_object() != Some(files) {
        return Err(anyhow!("file_conflict"));
    }
    if snapshot["indexFingerprints"].as_object() != Some(index) {
        return Err(anyhow!("index_conflict"));
    }
    Ok(())
}

fn discard_preflight(db: &Database, root: &Path, params_value: &Value) -> Result<Option<Value>> {
    let params = params_value
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let operation_id = required_string(params, "operationId")?;
    let paths = paths(params)?;
    let preflight = (|| {
        verify_discard_fingerprints(root, &paths, params)?;
        if paths
            .iter()
            .any(|path| params["expectedIndexFingerprints"][path].is_null())
            && !discard_recycle_available(root)
        {
            return Err(anyhow!("recycle_unavailable"));
        }
        Ok(())
    })();
    if let Err(error) = preflight {
        // Read receipt and claim together: completion may race with this preflight.
        let (receipt, pending): (Option<String>, bool) = db.transaction(|tx| {
            Ok(tx.query_row(
                "SELECT (SELECT result FROM operations WHERE id=?1), EXISTS(SELECT 1 FROM external_operations WHERE id=?1)",
                [operation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })?;
        if let Some(receipt) = receipt {
            db.bind_operation(operation_id, "git.discard", params_value)?;
            return Ok(Some(serde_json::from_str(&receipt)?));
        }
        if pending {
            db.bind_operation(operation_id, "git.discard", params_value)?;
            return Err(anyhow!("operation_outcome_unknown"));
        }
        return Err(error);
    }
    Ok(None)
}

fn release_discard_claim(db: &Database, operation_id: &str) -> Result<()> {
    db.transaction(|tx| {
        tx.execute(
            "DELETE FROM external_operations WHERE id=? AND NOT EXISTS (SELECT 1 FROM operations WHERE id=?)",
            params![operation_id, operation_id],
        )?;
        Ok(())
    })
}

fn verify_claimed_discard(
    db: &Database,
    operation_id: &str,
    root: &Path,
    paths: &[String],
    params: &serde_json::Map<String, Value>,
) -> Result<()> {
    if let Err(error) = verify_discard_fingerprints(root, paths, params) {
        release_discard_claim(db, operation_id)?;
        return Err(error);
    }
    Ok(())
}

struct IndexEntry {
    mode: String,
    fingerprint: String,
}

/// The stage-0 index entry of `path`; unmerged paths are refused.
fn index_entry(root: &Path, path: &str) -> Result<Option<IndexEntry>> {
    let listing = git(
        root,
        &["ls-files", "-s", "-z", "--", &format!(":(literal){path}")],
    )?;
    let mut entry = None;
    for record in listing.split('\0').filter(|record| !record.is_empty()) {
        let (meta, entry_path) = record
            .split_once('\t')
            .ok_or_else(|| anyhow!("git_failed"))?;
        let normalized = Path::new(path)
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if entry_path != normalized {
            return Err(anyhow!("invalid_file_type"));
        }
        let fields: Vec<&str> = meta.split(' ').collect();
        if fields.len() != 3 {
            return Err(anyhow!("git_failed"));
        }
        if fields[2] != "0" {
            return Err(anyhow!("index_unmerged"));
        }
        if !matches!(fields[0], "100644" | "100755" | "120000") {
            return Err(anyhow!("invalid_file_type"));
        }
        entry = Some((fields[0].to_owned(), fields[1].to_owned()));
    }
    let Some((mode, oid)) = entry else {
        return Ok(None);
    };
    Ok(Some(IndexEntry {
        mode,
        fingerprint: blob_fingerprint(root, &oid)?,
    }))
}

fn has_head(root: &Path) -> bool {
    git(root, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).is_ok()
}

fn network(root: &Path, args: &[&str]) -> Result<String> {
    let output = run_git(root, args, &[], None, NETWORK_TIMEOUT)?;
    Ok(String::from_utf8_lossy(&output).into_owned())
}

fn pull(root: &Path) -> Result<String> {
    // No remote/refspec override: Git honors the current branch's configured
    // fetch remote. Network failures must never be relabeled as divergence.
    let fetched = network(root, &["fetch"])?;
    match run_git(root, &["merge", "--ff-only", "@{upstream}"], &[], None, HOOK_TIMEOUT) {
        Ok(output) => Ok(format!("{fetched}{}", String::from_utf8_lossy(&output))),
        Err(error) => {
            let upstream = git(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
            let counts = git(root, &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
            if upstream.is_ok() {
                if let Ok(counts) = counts {
                    let values = counts.split_whitespace().map(str::parse::<u64>).collect::<std::result::Result<Vec<_>, _>>();
                    if let Ok(values) = values {
                        if let [behind, ahead] = values.as_slice() {
                            if *ahead > 0 && *behind > 0 { return Err(anyhow!("pull_diverged: {ahead} {behind}")); }
                        }
                    }
                }
            }
            Err(error)
        }
    }
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
fn merge_target(root: &Path, params: &serde_json::Map<String, Value>) -> Result<String> {
    match (params.get("branch"), params.get("upstream")) {
        (Some(Value::String(branch)), None) if !branch.is_empty() => {
            validate_merge_target(root, branch)?;
            Ok(branch.to_owned())
        }
        (None, Some(Value::Bool(true))) => git(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
            .and_then(|upstream| {
                let upstream = upstream.trim().to_owned();
                if upstream.is_empty() { Err(anyhow!("no_upstream")) } else { Ok(upstream) }
            })
            .map_err(|_| anyhow!("no_upstream")),
        _ => Err(anyhow!("invalid_request")),
    }
}
fn merge(root: &std::path::Path, branch: &str) -> Result<Value> {
    #[cfg(test)]
    let timeout = MERGE_TIMEOUT_OVERRIDE.with(|value| value.get()).unwrap_or(HOOK_TIMEOUT);
    #[cfg(not(test))]
    let timeout = HOOK_TIMEOUT;
    merge_with_timeout(root, branch, timeout)
}
fn merge_with_timeout(root: &std::path::Path, branch: &str, timeout: Duration) -> Result<Value> {
    // Preflight cleanliness is not exclusive ownership: another writer can
    // change the index/worktree while Git or a hook is running.
    let before = git(root, &["rev-parse", "HEAD"])?;
    match run_git(root, &["merge", "--no-edit", "--", branch], &[], None, timeout) {
        Ok(output) => Ok(json!({"output":String::from_utf8_lossy(&output),"conflicted":false})),
        Err(error) => {
            let text = error.to_string();
            let after = git(root, &["rev-parse", "HEAD"])?;
            if before.trim() != after.trim() {
                return Ok(json!({"output":text,"conflicted":false,"warning":"merge_completed_after_error"}));
            }
            let merge_head = git(root, &["rev-parse", "--git-path", "MERGE_HEAD"])?;
            let merge_head = Path::new(merge_head.trim());
            let merge_head = if merge_head.is_absolute() { merge_head.to_owned() } else { root.join(merge_head) };
            if merge_head.exists() {
                let conflicted = !git(root, &["diff", "--name-only", "--diff-filter=U"])?.trim().is_empty();
                return if conflicted {
                    Ok(json!({"output":text,"conflicted":true}))
                } else {
                    Err(anyhow!("merge_incomplete: {text}"))
                };
            }
            let staged = git(root, &["diff", "--cached", "--name-only", "HEAD"])?;
            let unstaged = git(root, &["diff", "--name-only", "HEAD"])?;
            if !staged.trim().is_empty() || !unstaged.trim().is_empty() {
                return Err(anyhow!("merge_interrupted: {text}"));
            }
            Err(anyhow!("git_merge_failed: {text}"))
        }
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

/// Records a completed operation and publishes one `state.changed`. `scope` is the worktree the
/// operation touched: open Source Control and Agent-changes panels refresh from that event instead
/// of polling, and `None` only for receipts that change nothing on disk.
pub(crate) fn complete(
    tx: &Transaction<'_>,
    operation_id: &str,
    method: &str,
    result: &Value,
    scope: Option<(&str, Option<&str>)>,
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
    let data = match scope {
        Some((project_id, worktree)) => json!({
            "kind":"git",
            "projectId":project_id,
            "worktreePath":worktree,
        }),
        None => json!({}),
    };
    tx.execute(
        "INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
        params![serde_json::to_string(&data)?, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_services::initialize;
    use std::{fs, process::Command};

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
    #[test]
    fn merge_upstream_and_divergent_pull_use_configured_tracking() {
        let (temp, db, project_id) = setup();
        assert_eq!(
            dispatch(&db, "git.merge", &json!({"projectId":project_id,"upstream":true,"operationId":"missing"}))
                .unwrap_err()
                .to_string(),
            "no_upstream"
        );
        assert_eq!(
            dispatch(&db, "git.merge", &json!({"projectId":project_id,"branch":"feature","upstream":true,"operationId":"xor"}))
                .unwrap_err()
                .to_string(),
            "invalid_request"
        );
        assert_eq!(
            dispatch(&db, "git.merge", &json!({"projectId":project_id,"branch":"origin/main","operationId":"remote-branch"}))
                .unwrap_err()
                .to_string(),
            "branch_not_found"
        );
        git(temp.path(), &["branch", "-m", "main"]).unwrap();
        let remote = tempfile::tempdir().unwrap();
        git(remote.path(), &["init", "--bare"]).unwrap();
        git(temp.path(), &["remote", "add", "origin", remote.path().to_str().unwrap()])
            .unwrap();
        git(temp.path(), &["push", "-u", "origin", "main"]).unwrap();
        let other_parent = tempfile::tempdir().unwrap();
        let other = other_parent.path().join("other");
        assert!(Command::new("git")
            .args(["clone", "-b", "main", remote.path().to_str().unwrap(), other.to_str().unwrap()])
            .output()
            .unwrap()
            .status
            .success());
        git(&other, &["config", "user.email", "tests@threadterm.invalid"]).unwrap();
        git(&other, &["config", "user.name", "ThreadTerm Tests"]).unwrap();
        fs::write(other.join("upstream.txt"), "upstream\n").unwrap();
        git(&other, &["add", "upstream.txt"]).unwrap();
        git(&other, &["commit", "-m", "upstream"]).unwrap();
        git(&other, &["push"]).unwrap();
        git(temp.path(), &["fetch", "origin"]).unwrap();
        assert_eq!(
            dispatch(&db, "git.merge", &json!({"projectId":project_id,"upstream":true,"operationId":"upstream"}))
                .unwrap()
                .unwrap()["conflicted"],
            false
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("upstream.txt")).unwrap().lines().collect::<Vec<_>>(),
            ["upstream"]
        );

        fs::write(temp.path().join("local.txt"), "local\n").unwrap();
        git(temp.path(), &["add", "local.txt"]).unwrap();
        git(temp.path(), &["commit", "-m", "local"]).unwrap();
        fs::write(other.join("second.txt"), "second\n").unwrap();
        git(&other, &["add", "second.txt"]).unwrap();
        git(&other, &["commit", "-m", "second"]).unwrap();
        git(&other, &["push"]).unwrap();
        git(temp.path(), &["fetch", "origin"]).unwrap();
        let before = git(temp.path(), &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(
            dispatch(&db, "git.pull", &json!({"projectId":project_id,"operationId":"diverged"}))
                .unwrap_err()
                .to_string(),
            "pull_diverged: 1 1"
        );
        assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]).unwrap(), before);
        assert!(git(temp.path(), &["status", "--porcelain"]).unwrap().trim().is_empty());
        git(temp.path(), &["remote", "set-url", "origin", temp.path().join("missing-remote").to_str().unwrap()]).unwrap();
        let error = dispatch(&db, "git.pull", &json!({"projectId":project_id,"operationId":"unreachable"})).unwrap_err().to_string();
        assert!(error.starts_with("git_failed:"), "{error}");
    }
    struct MergeTimeout;
    impl MergeTimeout {
        fn install(timeout: Duration) -> Self { MERGE_TIMEOUT_OVERRIDE.with(|value| value.set(Some(timeout))); Self }
    }
    impl Drop for MergeTimeout { fn drop(&mut self) { MERGE_TIMEOUT_OVERRIDE.with(|value| value.set(None)); } }

    struct HookProcess { pid: std::path::PathBuf }
    impl Drop for HookProcess {
        fn drop(&mut self) {
            let Ok(pid) = fs::read_to_string(&self.pid) else { return; };
            #[cfg(windows)]
            { use std::os::windows::process::CommandExt; let mut command = Command::new("taskkill"); command.creation_flags(0x0800_0000).args(["/PID", pid.trim(), "/T", "/F"]); let _ = command.output(); }
            #[cfg(not(windows))]
            { let _ = Command::new("kill").args(["-KILL", pid.trim()]).output(); }
        }
    }
    fn divergent_merge_fixture(root: &Path) {
        git(root, &["checkout", "-b", "feature"]).unwrap();
        fs::write(root.join("feature.txt"), "feature\n").unwrap(); git(root, &["add", "feature.txt"]).unwrap(); git(root, &["commit", "-m", "feature"]).unwrap();
        git(root, &["checkout", "master"]).unwrap();
        fs::write(root.join("main.txt"), "main\n").unwrap(); git(root, &["add", "main.txt"]).unwrap(); git(root, &["commit", "-m", "main"]).unwrap();
    }
    fn sleeping_hook(root: &Path, name: &str) -> HookProcess {
        let pid = root.join(".git/hooks/hook.pid");
        #[cfg(windows)] let source = "#!/bin/sh\nexec powershell -NoProfile -Command \"\\$PID | Out-File -Encoding ascii .git/hooks/hook.pid; Start-Sleep -Seconds 30\"\n";
        #[cfg(not(windows))] let source = "#!/bin/sh\necho $$ > .git/hooks/hook.pid\nexec sleep 30\n";
        fs::write(root.join(".git/hooks").join(name), source).unwrap();
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let path = root.join(".git/hooks").join(name); let mut permissions = fs::metadata(&path).unwrap().permissions(); permissions.set_mode(0o755); fs::set_permissions(path, permissions).unwrap(); }
        HookProcess { pid }
    }
    #[test]
    fn merge_hook_timeouts_preserve_concurrent_work_or_publish_warning() {
        let (temp, db, project) = setup(); divergent_merge_fixture(temp.path());
        let timeout = MergeTimeout::install(Duration::from_secs(3)); let hook = sleeping_hook(temp.path(), "pre-merge-commit");
        let before = git(temp.path(), &["rev-parse", "HEAD"]).unwrap(); let events = outbox_count(&db);
        let error = std::thread::scope(|scope| {
            // Wait until Git has changed the tree and entered the hook, so this
            // edit is definitely after ensure_clean and during the merge.
            let writer = scope.spawn(|| {
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                while !hook.pid.exists() {
                    assert!(std::time::Instant::now() < deadline, "merge hook did not start");
                    std::thread::sleep(Duration::from_millis(10));
                }
                fs::write(temp.path().join("concurrent.txt"), "concurrent user work\n").unwrap();
                git(temp.path(), &["add", "concurrent.txt"]).unwrap();
            });
            let result = dispatch(&db, "git.merge", &json!({"projectId":project,"branch":"feature","operationId":"pre-timeout"}));
            writer.join().unwrap();
            result.unwrap_err().to_string()
        });
        assert!(error.starts_with("merge_interrupted:") && error.contains("git_timeout"), "{error}");
        assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]).unwrap(), before);
        assert!(!temp.path().join(".git/MERGE_HEAD").exists());
        assert!(!git(temp.path(), &["status", "--porcelain"]).unwrap().trim().is_empty());
        assert_eq!(git(temp.path(), &["show", ":feature.txt"]).unwrap().trim(), "feature");
        assert_eq!(git(temp.path(), &["show", ":concurrent.txt"]).unwrap().trim(), "concurrent user work");
        assert_eq!(fs::read_to_string(temp.path().join("concurrent.txt")).unwrap(), "concurrent user work\n");
        assert!(hook.pid.exists()); assert_eq!(outbox_count(&db), events + 1);
        assert_eq!(last_event(&db), json!({"kind":"git","projectId":project,"worktreePath":null}));
        drop(hook); drop(timeout);

        let (temp, db, project) = setup(); divergent_merge_fixture(temp.path());
        let timeout = MergeTimeout::install(Duration::from_secs(2)); let hook = sleeping_hook(temp.path(), "post-merge"); let events = outbox_count(&db);
        let result = dispatch(&db, "git.merge", &json!({"projectId":project,"branch":"feature","operationId":"post-timeout"})).unwrap().unwrap();
        assert_eq!(result["conflicted"], false); assert_eq!(result["warning"], "merge_completed_after_error");
        assert!(result["output"].as_str().unwrap().contains("git_timeout"));
        assert!(hook.pid.exists()); assert_eq!(outbox_count(&db), events + 1); assert_eq!(last_event(&db), json!({"kind":"git","projectId":project,"worktreePath":null}));
        drop(hook); drop(timeout);
    }
    #[test]
    fn pre_merge_hook_failure_is_incomplete_when_git_leaves_merge_head() {
        let (temp, db, project) = setup(); divergent_merge_fixture(temp.path());
        let hook = temp.path().join(".git/hooks/pre-merge-commit"); fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let mut permissions = fs::metadata(&hook).unwrap().permissions(); permissions.set_mode(0o755); fs::set_permissions(&hook, permissions).unwrap(); }
        let events = outbox_count(&db); let error = dispatch(&db, "git.merge", &json!({"projectId":project,"branch":"feature","operationId":"pre-fail"})).unwrap_err().to_string();
        assert!(error.contains("merge_incomplete")); assert!(temp.path().join(".git/MERGE_HEAD").exists());
        assert!(git(temp.path(), &["diff", "--name-only", "--diff-filter=U"]).unwrap().trim().is_empty());
        assert_eq!(outbox_count(&db), events + 1); assert_eq!(last_event(&db), json!({"kind":"git","projectId":project,"worktreePath":null}));
    }

    fn outbox_count(db: &Database) -> i64 { db.transaction(|tx| Ok(tx.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))?)).unwrap() }

    fn call(db: &Database, method: &str, params: Value) -> Result<Value> {
        dispatch(db, method, &params).map(Option::unwrap)
    }

    fn discard_request(db: &Database, project: &str, paths: &[&str], operation: &str) -> Value {
        let snapshot = call(
            db,
            "git.fingerprints",
            json!({"projectId":project,"paths":paths}),
        )
        .unwrap();
        json!({"projectId":project,"paths":paths,"expectedFingerprints":snapshot["fingerprints"],"expectedIndexFingerprints":snapshot["indexFingerprints"],"operationId":operation})
    }

    #[test]
    fn fingerprints_cover_modified_deleted_untracked_staged_new_and_absent() {
        let (temp, db, project) = setup();
        fs::write(temp.path().join("a.txt"), "modified").unwrap();
        fs::write(temp.path().join("new.txt"), "untracked").unwrap();
        fs::write(temp.path().join("staged.txt"), "staged").unwrap();
        git(temp.path(), &["add", "staged.txt"]).unwrap();
        let snapshot = call(&db, "git.fingerprints", json!({"projectId":project,"paths":["a.txt","new.txt","staged.txt","missing/nested.txt"]})).unwrap();
        assert_eq!(
            snapshot["fingerprints"],
            json!({"a.txt":fingerprint(b"modified"),"new.txt":fingerprint(b"untracked"),"staged.txt":fingerprint(b"staged"),"missing/nested.txt":null})
        );
        assert_eq!(
            snapshot["indexFingerprints"],
            json!({"a.txt":fingerprint(b"base"),"new.txt":null,"staged.txt":fingerprint(b"staged"),"missing/nested.txt":null})
        );
        fs::remove_file(temp.path().join("a.txt")).unwrap();
        let deleted = call(
            &db,
            "git.fingerprints",
            json!({"projectId":project,"paths":["a.txt"]}),
        )
        .unwrap();
        assert_eq!(deleted["fingerprints"]["a.txt"], Value::Null);
        assert_eq!(deleted["indexFingerprints"]["a.txt"], fingerprint(b"base"));
        assert!(db.operation("fingerprints").unwrap().is_none());
    }

    #[test]
    fn fingerprints_reject_unmerged_escaping_and_non_file_paths() {
        let (temp, db, project) = setup();
        for path in ["../outside", temp.path().to_str().unwrap()] {
            assert_eq!(
                call(
                    &db,
                    "git.fingerprints",
                    json!({"projectId":project,"paths":[path]})
                )
                .unwrap_err()
                .to_string(),
                "invalid_path"
            );
        }
        assert_eq!(
            call(
                &db,
                "git.fingerprints",
                json!({"projectId":project,"paths":["a.txt/child"]})
            )
            .unwrap_err()
            .to_string(),
            "invalid_file_type"
        );
        fs::create_dir(temp.path().join("folder")).unwrap();
        assert_eq!(
            call(
                &db,
                "git.fingerprints",
                json!({"projectId":project,"paths":["folder"]})
            )
            .unwrap_err()
            .to_string(),
            "invalid_file_type"
        );
        let oid = git(temp.path(), &["rev-parse", "HEAD:a.txt"]).unwrap();
        let info = format!(
            "0 {}\ta.txt\n100644 {} 1\ta.txt\n100644 {} 2\ta.txt\n",
            "0".repeat(40),
            oid.trim(),
            oid.trim()
        );
        run_git(
            temp.path(),
            &["update-index", "--index-info"],
            &[],
            Some(info.as_bytes()),
            LOCAL_TIMEOUT,
        )
        .unwrap();
        assert_eq!(
            call(
                &db,
                "git.fingerprints",
                json!({"projectId":project,"paths":["a.txt"]})
            )
            .unwrap_err()
            .to_string(),
            "index_unmerged"
        );
        for paths in [json!([]), json!(vec!["a.txt"; 501])] {
            assert_eq!(
                call(
                    &db,
                    "git.fingerprints",
                    json!({"projectId":project,"paths":paths})
                )
                .unwrap_err()
                .to_string(),
                "invalid_paths"
            );
        }
    }

    #[test]
    fn discard_requires_exact_nullable_maps_before_claiming() {
        let (_temp, db, project) = setup();
        let valid = discard_request(&db, &project, &["a.txt"], "shape");
        for key in ["expectedFingerprints", "expectedIndexFingerprints"] {
            for invalid in [
                None,
                Some(json!({})),
                Some(json!({"a.txt":valid[key]["a.txt"],"extra":null})),
                Some(json!({"a.txt":17})),
            ] {
                let mut request = valid.clone();
                if let Some(value) = invalid {
                    request[key] = value;
                } else {
                    request.as_object_mut().unwrap().remove(key);
                }
                assert_eq!(
                    call(&db, "git.discard", request).unwrap_err().to_string(),
                    "invalid_fingerprints"
                );
            }
        }
        assert!(db.claim_external_operation("shape").unwrap());
    }

    #[test]
    fn discard_restores_tracked_and_deleted_files_and_replays_completed_receipts() {
        let (temp, db, project) = setup();
        fs::write(temp.path().join("a.txt"), "changed").unwrap();
        let request = discard_request(&db, &project, &["a.txt"], "restore");
        let result = call(&db, "git.discard", request.clone()).unwrap();
        assert_eq!(fs::read(temp.path().join("a.txt")).unwrap(), b"base");
        fs::write(temp.path().join("a.txt"), "later").unwrap();
        assert_eq!(call(&db, "git.discard", request).unwrap(), result);
        assert_eq!(fs::read(temp.path().join("a.txt")).unwrap(), b"later");
        // Claim release must never erase a completed operation's claim.
        release_discard_claim(&db, "restore").unwrap();
        assert!(!db.claim_external_operation("restore").unwrap());
        fs::remove_file(temp.path().join("a.txt")).unwrap();
        let deleted = discard_request(&db, &project, &["a.txt"], "deleted");
        assert_eq!(deleted["expectedFingerprints"]["a.txt"], Value::Null);
        call(&db, "git.discard", deleted).unwrap();
        assert_eq!(fs::read(temp.path().join("a.txt")).unwrap(), b"base");
    }

    #[cfg(windows)]
    #[test]
    fn discard_recycles_matching_untracked_files() {
        let (temp, db, project) = setup();
        fs::write(temp.path().join("untracked.txt"), "keep in recycle bin").unwrap();
        let request = discard_request(&db, &project, &["untracked.txt"], "untracked");
        assert_eq!(
            request["expectedIndexFingerprints"]["untracked.txt"],
            Value::Null
        );
        match call(&db, "git.discard", request) {
            Ok(result) => {
                assert_eq!(result["recycled"], json!(["untracked.txt"]));
                assert!(!temp.path().join("untracked.txt").exists());
            }
            Err(error) => {
                assert_eq!(error.to_string(), "recycle_unavailable");
                assert_eq!(
                    fs::read(temp.path().join("untracked.txt")).unwrap(),
                    b"keep in recycle bin"
                );
                assert!(db.operation("untracked").unwrap().is_none());
                eprintln!(
                    "Recycle Bin unavailable in this environment; verified safe refusal instead"
                );
            }
        }
    }

    #[test]
    fn discard_worktree_and_index_conflicts_leave_files_intact_and_retryable() {
        let (temp, db, project) = setup();
        let request = discard_request(&db, &project, &["a.txt"], "file-conflict");
        fs::write(temp.path().join("a.txt"), "later edit").unwrap();
        for _ in 0..2 {
            assert_eq!(
                call(&db, "git.discard", request.clone())
                    .unwrap_err()
                    .to_string(),
                "file_conflict"
            );
        }
        assert_eq!(fs::read(temp.path().join("a.txt")).unwrap(), b"later edit");
        fs::write(temp.path().join("a.txt"), "partial staged").unwrap();
        git(temp.path(), &["add", "a.txt"]).unwrap();
        fs::write(temp.path().join("a.txt"), "partial staged plus unstaged").unwrap();
        let request = discard_request(&db, &project, &["a.txt"], "index-conflict");
        git(temp.path(), &["restore", "--staged", "a.txt"]).unwrap();
        for _ in 0..2 {
            assert_eq!(
                call(&db, "git.discard", request.clone())
                    .unwrap_err()
                    .to_string(),
                "index_conflict"
            );
        }
        assert_eq!(
            fs::read(temp.path().join("a.txt")).unwrap(),
            b"partial staged plus unstaged"
        );
    }

    #[test]
    fn discard_post_claim_conflicts_release_only_uncompleted_claims() {
        for index_changed in [false, true] {
            let (temp, db, project) = setup();
            let request = discard_request(&db, &project, &["a.txt"], "claimed");
            let params = request.as_object().unwrap();
            verify_discard_fingerprints(temp.path(), &paths(params).unwrap(), params).unwrap();
            db.bind_operation("claimed", "git.discard", &request)
                .unwrap();
            assert!(db.claim_external_operation("claimed").unwrap());
            fs::write(temp.path().join("a.txt"), "later").unwrap();
            if index_changed {
                git(temp.path(), &["add", "a.txt"]).unwrap();
                fs::write(temp.path().join("a.txt"), "base").unwrap();
            }
            let expected = if index_changed {
                "index_conflict"
            } else {
                "file_conflict"
            };
            assert_eq!(
                verify_claimed_discard(
                    &db,
                    "claimed",
                    temp.path(),
                    &paths(params).unwrap(),
                    params
                )
                .unwrap_err()
                .to_string(),
                expected
            );
            let claims: i64 = db
                .transaction(|tx| {
                    Ok(tx.query_row(
                        "SELECT COUNT(*) FROM external_operations WHERE id='claimed'",
                        [],
                        |row| row.get(0),
                    )?)
                })
                .unwrap();
            assert_eq!(claims, 0);
            assert_eq!(
                call(&db, "git.discard", request).unwrap_err().to_string(),
                expected
            );
            assert_eq!(
                fs::read(temp.path().join("a.txt")).unwrap(),
                if index_changed {
                    b"base".as_slice()
                } else {
                    b"later".as_slice()
                }
            );
        }
    }

    #[test]
    fn discard_paths_are_literal_and_relative_to_registered_subdirectory() {
        let (temp, db, _project) = setup();
        let nested = temp.path().join("pkg");
        fs::create_dir(&nested).unwrap();
        for name in ["a[1].txt", "a1.txt"] {
            fs::write(nested.join(name), "base").unwrap();
        }
        git(temp.path(), &["add", "pkg"]).unwrap();
        let project = db
            .add_project(nested.to_str().unwrap(), Some("nested"), "nested-project")
            .unwrap();
        for name in ["a[1].txt", "a1.txt"] {
            fs::write(nested.join(name), "changed").unwrap();
        }
        let request = discard_request(&db, &project.id, &["a[1].txt"], "literal");
        call(&db, "git.discard", request).unwrap();
        assert_eq!(fs::read(nested.join("a[1].txt")).unwrap(), b"base");
        assert_eq!(fs::read(nested.join("a1.txt")).unwrap(), b"changed");
        // An absent directory still must not be treated as one index file.
        fs::remove_file(nested.join("a[1].txt")).unwrap();
        fs::remove_file(nested.join("a1.txt")).unwrap();
        fs::remove_dir(&nested).unwrap();
        assert_eq!(
            discard_fingerprints(temp.path(), &["pkg".to_owned()])
                .unwrap_err()
                .to_string(),
            "invalid_file_type"
        );
    }

    #[cfg(windows)]
    #[test]
    fn fingerprints_reject_junction_escapes_for_existing_and_absent_files() {
        use std::os::windows::process::CommandExt;
        let (temp, db, project) = setup();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("outside.txt"), "untouched").unwrap();
        let junction = temp.path().join("escape");
        assert!(Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&junction)
            .arg(outside.path())
            .creation_flags(0x0800_0000)
            .output()
            .unwrap()
            .status
            .success());
        for path in [
            "escape/outside.txt",
            "escape/missing.txt",
            "escape/missing/nested.txt",
        ] {
            assert_eq!(
                call(
                    &db,
                    "git.fingerprints",
                    json!({"projectId":project,"paths":[path]})
                )
                .unwrap_err()
                .to_string(),
                "invalid_path"
            );
        }
        fs::remove_dir(junction).unwrap();
        assert_eq!(
            fs::read(outside.path().join("outside.txt")).unwrap(),
            b"untouched"
        );
    }

    #[test]
    fn discard_streams_large_binary_modified_and_deleted_tracked_files() {
        let (temp, db, project) = setup();
        let original: Vec<u8> = (0..3 * 1024 * 1024)
            .map(|index| (index % 251) as u8)
            .collect();
        let modified: Vec<u8> = original.iter().map(|byte| byte.wrapping_add(1)).collect();
        for path in ["modified.bin", "deleted.bin"] {
            fs::write(temp.path().join(path), &original).unwrap();
        }
        git(temp.path(), &["add", "modified.bin", "deleted.bin"]).unwrap();
        git(temp.path(), &["commit", "-m", "large binaries"]).unwrap();
        fs::write(temp.path().join("modified.bin"), &modified).unwrap();
        fs::remove_file(temp.path().join("deleted.bin")).unwrap();
        let request = discard_request(
            &db,
            &project,
            &["modified.bin", "deleted.bin"],
            "large-discard",
        );
        assert_eq!(
            request["expectedFingerprints"]["modified.bin"],
            fingerprint(&modified)
        );
        assert_eq!(request["expectedFingerprints"]["deleted.bin"], Value::Null);
        for path in ["modified.bin", "deleted.bin"] {
            assert_eq!(
                request["expectedIndexFingerprints"][path],
                fingerprint(&original)
            );
        }
        call(&db, "git.discard", request).unwrap();
        for path in ["modified.bin", "deleted.bin"] {
            assert_eq!(fs::read(temp.path().join(path)).unwrap(), original);
        }
        assert_eq!(call(&db, "git.index.write", json!({"projectId":project,"path":"modified.bin","content":"x".repeat(3 * 1024 * 1024),"expectedIndexFingerprint":fingerprint(&original),"operationId":"large-write"})).unwrap_err().to_string(), "invalid_content");
        assert!(!db.external_operation_pending("large-write").unwrap());
    }

    #[test]
    fn discard_outstanding_claim_precedes_preflight_and_receipt_replays_first() {
        let (temp, db, project) = setup();
        let request = discard_request(&db, &project, &["a.txt"], "lost-response");
        db.bind_operation("lost-response", "git.discard", &request)
            .unwrap();
        assert!(db.claim_external_operation("lost-response").unwrap());
        fs::write(temp.path().join("a.txt"), "partially changed").unwrap();
        assert_eq!(
            call(&db, "git.discard", request.clone())
                .unwrap_err()
                .to_string(),
            "operation_outcome_unknown"
        );
        assert_eq!(
            fs::read(temp.path().join("a.txt")).unwrap(),
            b"partially changed"
        );
        assert!(db.external_operation_pending("lost-response").unwrap());
        let mut different = request.clone();
        different["paths"] = json!(["other.txt"]);
        assert!(call(&db, "git.discard", different)
            .unwrap_err()
            .to_string()
            .starts_with("operation_conflict:"));
        let receipt = json!({"paths":["a.txt"],"recycled":[]});
        db.transaction(|tx| {
            complete(
                tx,
                "lost-response",
                "git.discard",
                &receipt,
                Some((&project, None)),
            )
        })
        .unwrap();
        assert!(!db.external_operation_pending("lost-response").unwrap());
        assert_eq!(call(&db, "git.discard", request).unwrap(), receipt);
    }

    #[test]
    fn discard_failed_preflight_rechecks_concurrent_claims_and_receipts() {
        for recycle_unavailable in [false, true] {
            let (temp, db, project) = setup();
            let path = if recycle_unavailable { "new.txt" } else { "a.txt" };
            fs::write(temp.path().join(path), "reviewed edit").unwrap();
            let request = discard_request(&db, &project, &[path], "concurrent");
            let _hooks = discard_test_hooks::install(false, None);
            // Simulate dispatch passing its initial pending check, then another
            // caller claiming and applying an effect before this preflight runs.
            assert!(!db.external_operation_pending("concurrent").unwrap());
            db.bind_operation("concurrent", "git.discard", &request)
                .unwrap();
            assert!(db.claim_external_operation("concurrent").unwrap());
            if !recycle_unavailable {
                git(temp.path(), &["restore", "--worktree", "--", path]).unwrap();
            }
            assert_eq!(
                discard_preflight(&db, temp.path(), &request)
                    .unwrap_err()
                    .to_string(),
                "operation_outcome_unknown"
            );
            assert!(db.external_operation_pending("concurrent").unwrap());
            let receipt = json!({"paths":[path],"recycled":[]});
            db.transaction(|tx| {
                complete(
                    tx,
                    "concurrent",
                    "git.discard",
                    &receipt,
                    Some((&project, None)),
                )
            })
            .unwrap();
            assert_eq!(
                discard_preflight(&db, temp.path(), &request).unwrap(),
                Some(receipt)
            );
        }
    }

    #[test]
    fn discard_recycle_unavailable_preflight_has_no_effects_or_claim() {
        let (temp, db, project) = setup();
        fs::write(temp.path().join("a.txt"), "tracked edit").unwrap();
        fs::write(temp.path().join("new.txt"), "untracked edit").unwrap();
        let request = discard_request(&db, &project, &["a.txt", "new.txt"], "unavailable");
        let _hooks = discard_test_hooks::install(false, None);
        let before: i64 = db
            .transaction(
                |tx| Ok(tx.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))?),
            )
            .unwrap();
        assert_eq!(
            call(&db, "git.discard", request).unwrap_err().to_string(),
            "recycle_unavailable"
        );
        assert_eq!(
            fs::read(temp.path().join("a.txt")).unwrap(),
            b"tracked edit"
        );
        assert_eq!(
            fs::read(temp.path().join("new.txt")).unwrap(),
            b"untracked edit"
        );
        assert!(!db.external_operation_pending("unavailable").unwrap());
        assert!(db.operation("unavailable").unwrap().is_none());
        let after: i64 = db
            .transaction(
                |tx| Ok(tx.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))?),
            )
            .unwrap();
        assert_eq!(before, after);
        assert!(
            db.claim_external_operation("unavailable").unwrap(),
            "preflight leaves no claim"
        );
    }

    #[test]
    fn discard_partial_recycle_publishes_refresh_and_keeps_an_unknown_claim() {
        let (temp, db, project) = setup();
        fs::write(temp.path().join("a.txt"), "tracked edit").unwrap();
        fs::write(temp.path().join("one.txt"), "recoverable one").unwrap();
        fs::write(temp.path().join("two.txt"), "recoverable two").unwrap();
        let request = discard_request(&db, &project, &["a.txt", "one.txt", "two.txt"], "partial");
        let _hooks = discard_test_hooks::install(true, Some(2));
        let before: i64 = db
            .transaction(
                |tx| Ok(tx.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))?),
            )
            .unwrap();
        let error = call(&db, "git.discard", request.clone())
            .unwrap_err()
            .to_string();
        assert!(error.starts_with("discard_incomplete:"), "{error}");
        assert!(error.contains("completed: [one.txt]"), "{error}");
        assert!(error.contains("failed: [two.txt]"), "{error}");
        assert!(error.len() < 1024);
        assert_eq!(
            fs::read(temp.path().join("one.discard-test-recycled")).unwrap(),
            b"recoverable one"
        );
        assert!(!temp.path().join("one.txt").exists());
        assert_eq!(
            fs::read(temp.path().join("two.txt")).unwrap(),
            b"recoverable two"
        );
        assert_eq!(
            fs::read(temp.path().join("a.txt")).unwrap(),
            b"tracked edit",
            "recycle runs before restore"
        );
        assert_eq!(
            last_event(&db),
            json!({"kind":"git","projectId":project,"worktreePath":null})
        );
        let after: i64 = db
            .transaction(
                |tx| Ok(tx.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))?),
            )
            .unwrap();
        assert_eq!(after, before + 1);
        assert!(db.operation("partial").unwrap().is_none());
        assert!(db.external_operation_pending("partial").unwrap());
        assert_eq!(
            call(&db, "git.discard", request).unwrap_err().to_string(),
            "operation_outcome_unknown"
        );
    }

    #[test]
    fn discard_recycles_before_restoring_on_a_successful_mixed_batch() {
        let (temp, db, project) = setup();
        fs::write(temp.path().join("a.txt"), "tracked edit").unwrap();
        fs::write(temp.path().join("new.txt"), "untracked edit").unwrap();
        let request = discard_request(&db, &project, &["a.txt", "new.txt"], "mixed");
        let _hooks = discard_test_hooks::install(true, None);
        assert_eq!(
            call(&db, "git.discard", request).unwrap()["recycled"],
            json!(["new.txt"])
        );
        assert_eq!(fs::read(temp.path().join("a.txt")).unwrap(), b"base");
        assert_eq!(
            fs::read(temp.path().join("new.discard-test-recycled")).unwrap(),
            b"untracked edit"
        );
        assert!(!db.external_operation_pending("mixed").unwrap());
    }

    fn last_event(db: &Database) -> Value {
        let data = db
            .transaction(|tx| {
                tx.query_row(
                    "SELECT data FROM outbox ORDER BY seq DESC LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .map_err(Into::into)
            })
            .unwrap();
        serde_json::from_str(&data).unwrap()
    }

    /// F16: a Git mutation publishes one scoped change event (never a timer-driven refresh), and a
    /// replayed receipt does not publish a second one.
    #[test]
    fn mutations_publish_one_scoped_worktree_event() {
        let (temp, db, project_id) = setup();
        fs::write(temp.path().join("a.txt"), "changed").unwrap();
        let stage = json!({"projectId":project_id,"paths":["a.txt"],"operationId":"scoped-event"});
        dispatch(&db, "git.stage", &stage).unwrap();
        assert_eq!(
            last_event(&db),
            json!({"kind":"git","projectId":project_id,"worktreePath":null})
        );
        let before: i64 = db
            .transaction(|tx| {
                tx.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
                    .map_err(Into::into)
            })
            .unwrap();
        dispatch(&db, "git.stage", &stage).unwrap();
        let after: i64 = db
            .transaction(|tx| {
                tx.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
                    .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(before, after, "a replayed receipt must not republish");
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
            discard_request(&db, &project, &["b.txt"], "dc1"),
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
    fn commit_receipt_replays_after_the_index_becomes_empty() {
        let (temp, db, project) = setup();
        fs::write(temp.path().join("a.txt"), "next").unwrap();
        call(
            &db,
            "git.stage",
            json!({"projectId":project,"paths":["a.txt"],"operationId":"r-stage"}),
        )
        .unwrap();
        let request =
            json!({"projectId":project,"message":"lost response","operationId":"r-commit"});
        let committed = call(&db, "git.commit", request.clone()).unwrap();
        let head = git(temp.path(), &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(committed["commit"].as_str().unwrap(), head.trim());
        let commits = git(temp.path(), &["rev-list", "--count", "HEAD"]).unwrap();
        // The response was lost, so the client retries the same operation after the
        // commit emptied the index; the receipt must win over the nothing_staged fence.
        git(temp.path(), &["reset", "--quiet"]).unwrap();
        assert!(git(temp.path(), &["diff", "--cached", "--quiet"]).is_ok());
        let replayed = call(&db, "git.commit", request).unwrap();
        assert_eq!(replayed, committed);
        assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]).unwrap(), head);
        assert_eq!(
            git(temp.path(), &["rev-list", "--count", "HEAD"]).unwrap(),
            commits
        );
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
