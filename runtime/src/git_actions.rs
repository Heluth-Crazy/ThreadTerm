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
use sha2::{Digest, Sha256};
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
    // Ordered transport lanes are per connection. Keep the entry's preflight,
    // effect and consumed marker together across local clients as well.
    static UNDO_EXECUTION: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _undo_execution = if method == "git.undo" {
        Some(UNDO_EXECUTION.lock().map_err(|_| anyhow!("undo_unavailable"))?)
    } else { None };
    // This read shares the exact worktree/index snapshot logic with discard, but never
    // binds, claims or completes an operation.
    if method == "git.undo.list" { return undo_list(db, params_value).map(Some); }
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
            | "git.cherryPick"
            | "git.revert"
            | "git.reset"
            | "git.undo"
            | "git.operation.abort"
            | "git.operation.continue"
            | "git.stash.push" | "git.stash.apply" | "git.stash.drop"
    ) {
        return Ok(None);
    }
    let params = params_value
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let operation_id = required_string(params, "operationId")?;
    let project_id = required_string(params, "projectId")?;
    let worktree = params.get("worktreePath").and_then(Value::as_str);
    // Force push's preflight reads the remote-tracking tip, which a completed push moves.
    if method == "git.undo" || method == "git.discard" || method.starts_with("git.stash.") || method == "git.checkout" || method == "git.push"
        || matches!(method, "git.cherryPick" | "git.revert" | "git.reset" | "git.operation.abort" | "git.operation.continue") {
        if let Some(result) = db.operation(operation_id)? {
            db.bind_operation(operation_id, method, params_value)?;
            return stash_receipt(method, result).map(Some);
        }
        if db.external_operation_pending(operation_id)? {
            if method != "git.undo" || db.operation_request(operation_id)?.is_some() {
                db.bind_operation(operation_id, method, params_value)?;
            }
            return Err(anyhow!("operation_outcome_unknown"));
        }
    }
    let root = db.transaction(|tx| root_for(tx, project_id, worktree))?;
    // A completed receipt is replayed before any preflight that reads mutable state:
    // a retry after a lost response is the same operation even when the index or
    // working tree has changed since it succeeded.
    if let Some(result) = db.operation(operation_id)? {
        db.bind_operation(operation_id, method, params_value)?;
        return stash_receipt(method, result).map(Some);
    }
    let merge_target = if method == "git.merge" {
        let target = merge_target(&root, params)?;
        ensure_clean(&root)?;
        Some(target)
    } else {
        None
    };
    let history_hash = match method {
        "git.cherryPick" | "git.revert" => Some(history_commit_preflight(&root, params, method)?),
        _ => None,
    };
    let reset = (method == "git.reset")
        .then(|| reset_preflight(db, &root, params, project_id, worktree))
        .transpose()?;
    if matches!(method, "git.operation.abort" | "git.operation.continue") {
        operation_preflight(&root, params, method == "git.operation.continue")?;
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
        "git.branch.delete" => {
            validate_branch_name(&root, required_string(params, "branch")?)?;
        }
        "git.discard" => {
            if let Some(result) = discard_preflight(db, &root, params_value)? {
                return stash_receipt(method, result).map(Some);
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
    let force_push = if method == "git.push" && ["force", "expectedRemoteOid", "remote", "remoteBranch", "localBranch"].iter().any(|key| params.contains_key(*key)) {
        if db.external_operation_pending(operation_id)? {
            db.bind_operation(operation_id, method, params_value)?;
            return Err(anyhow!("operation_outcome_unknown"));
        }
        Some(prepare_force_push(&root, params)?)
    } else {
        None
    };
    if method == "git.fetch" {
        if let Some(remote) = params.get("remote") {
            validate_fetch_remote(&root, remote.as_str().ok_or_else(|| anyhow!("invalid_request"))?)?;
        }
    }
    if method == "git.undo" { undo_preflight(db, &root, params)?; }
    db.bind_operation(operation_id, method, params_value)?;
    if let Some(result) = db.operation(operation_id)? {
        return stash_receipt(method, result).map(Some);
    }
    let checkout = if method == "git.checkout" {
        if db.external_operation_pending(operation_id)? {
            return Err(anyhow!("operation_outcome_unknown"));
        }
        Some(checkout_preflight(&root, params)?)
    } else {
        None
    };
    // Stash preflight is read-only and follows receipt/pending-claim checks.
    if method == "git.stash.push" {
        stash_message(params)?;
        let include = params.get("includeUntracked").and_then(Value::as_bool).ok_or_else(|| anyhow!("invalid_request"))?;
        if !stash_has_changes(&root, include)? { return Err(anyhow!("nothing_to_stash")); }
    }
    if method == "git.stash.apply" || method == "git.stash.drop" {
        crate::git_read::stash_resolve(&root, required_string(params, "oid")?)?;
    }
    // This insert is an atomic execution claim. A caller that finds a claim without
    // completion cannot know whether Git already applied the external side effect.
    if !db.claim_external_operation(operation_id)? {
        return Err(anyhow!("operation_outcome_unknown"));
    }
    let project_id = required_string(params, "projectId")?;
    let worktree = params.get("worktreePath").and_then(Value::as_str);
    let root = db.transaction(|tx| root_for(tx, project_id, worktree))?;
    let journal = UndoJournal { db, operation_id, project_id, root: &root, release_on_failure: true };
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
        "git.fetch" => {
            let args = match params.get("remote").and_then(Value::as_str) {
                Some(remote) => vec!["fetch", "--prune", remote],
                None => vec!["fetch", "--prune"],
            };
            json!({"output":network(&root, &args)?})
        }
        "git.pull" => json!({"output":pull(&root)?}),
        "git.push" => {
            if let Some(plan) = force_push.as_ref() {
                json!({"output": force_push_with_lease(&root, plan)?})
            } else if params.get("setUpstream").and_then(Value::as_bool) == Some(true) {
                let remote = default_remote(&root)?;
                json!({"output":push_network(&root, &["push", "--porcelain", "-u", &remote, "HEAD"])?})
            } else {
                json!({"output":push_network(&root, &["push", "--porcelain"])?})
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
        "git.stash.push" => {
            let message = stash_message(params)?;
            let oid = stash_publish_failure(db, (project_id, worktree), stash_push(&root, &message, params["includeUntracked"].as_bool().unwrap()))?;
            let Some(pushed) = oid else { release_discard_claim(db, operation_id)?; return Err(anyhow!("nothing_to_stash")); };
            json!({"oid":pushed.oid})
        }
        "git.stash.apply" => stash_publish_failure(db, (project_id, worktree), stash_apply(&root, required_string(params, "oid")?, params.get("pop").and_then(Value::as_bool) == Some(true), &journal))?,
        "git.stash.drop" => {
            let oid = required_string(params, "oid")?;
            let interference = stash_publish_failure(db, (project_id, worktree), stash_drop(&root, oid, &journal))?;
            match interference {
                Some(detail) => json!({"oid":oid,"dropped":false,"interference":detail}),
                None => json!({"oid":oid,"dropped":true,"undoId":operation_id}),
            }
        }
        "git.checkout" if params.get("stash").and_then(Value::as_bool) == Some(true) => {
            stash_publish_failure(db, (project_id, worktree), stash_switch(&root, checkout.as_ref().unwrap(), required_string(params, "branch")?, operation_id, &journal))?
        }
        "git.checkout" => {
            let plan = checkout.as_ref().unwrap();
            let args: Vec<&str> = plan.args.iter().map(String::as_str).collect();
            let before = checkout_head(&root).ok();
            let new_ref_absent = !plan.creating || plan.branch_ref.as_deref()
                .is_some_and(|reference| matches!(checkout_optional_ref(&root, reference), Ok(None)));
            if let Err(failure) = run_git(&root, &args, &[("LANGUAGE", std::ffi::OsStr::new("C"))], None, HOOK_TIMEOUT) {
                if let Some(paths) = failure.to_string().strip_prefix("git_failed: ").and_then(checkout_refusal_paths) {
                    let after = checkout_head(&root).ok();
                    let still_absent = !plan.creating || plan.branch_ref.as_deref()
                        .is_some_and(|reference| matches!(checkout_optional_ref(&root, reference), Ok(None)));
                    if checkout_can_release(before.as_ref(), after.as_ref(), new_ref_absent, still_absent) {
                        release_discard_claim(db, operation_id)?;
                        return Err(anyhow!("checkout_would_overwrite: {}", json!(paths)));
                    }
                }
                return Err(failure);
            }
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
            journal.capture("branch", || {
                let tip = git(&root, &["rev-parse", "--verify", &format!("refs/heads/{branch}")])?;
                let remote = git(&root, &["config", "--get", &format!("branch.{branch}.remote")]).ok();
                let merge = git(&root, &["config", "--get", &format!("branch.{branch}.merge")]).ok();
                Ok(json!({"branch":branch,"tipOid":tip.trim(),"remote":remote.map(|s| s.trim().to_owned()),"merge":merge.map(|s| s.trim().to_owned())}))
            })?;
            if let Err(error) = git(&root, &["branch", flag, branch]).map_err(|error| {
                if error.to_string().contains("not fully merged") {
                    anyhow!("branch_not_merged")
                } else {
                    error
                }
            }) { journal.remove()?; return Err(error); }
            json!({"branch":branch,"undoId":operation_id})
        }
        "git.undo" => undo_apply(db, operation_id, &root, params)?,
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
        "git.cherryPick" | "git.revert" => history_apply(
            db,
            operation_id,
            &root,
            method,
            params,
            history_hash.as_deref().ok_or_else(|| anyhow!("invalid_request"))?,
        )?,
        "git.reset" => {
            let plan = reset.as_ref().ok_or_else(|| anyhow!("invalid_request"))?;
            let before = checkout_head(&root)?;
            let before_symbolic_head = match symbolic_head(&root, &before) {
                Ok(value) => value,
                Err(error) if error.to_string() == "head_moved" => {
                    release_discard_claim(db, operation_id)?;
                    return Err(error);
                }
                Err(error) => return Err(error),
            };
            if before.oid != required_string(params, "expectedHead")? || before_symbolic_head != plan.symbolic_head {
                release_discard_claim(db, operation_id)?;
                return Err(anyhow!("head_moved"));
            }
            if params.contains_key("undoOf") {
                if let Err(error) = reset_reflog_continuity(&root, &before_symbolic_head, &before.oid, &plan.target) {
                    release_discard_claim(db, operation_id)?;
                    return Err(error);
                }
            }
            let mode = required_string(params, "mode")?;
            let flag = match mode { "soft" => "--soft", "mixed" => "--mixed", _ => return Err(anyhow!("invalid_request")) };
            let nonce = hex::encode(Sha256::digest(operation_id.as_bytes()));
            let reflog_action = format!("reset: moving to {} [ThreadTerm {}]", plan.target, &nonce[..16]);
            let reflog_label = format!("{reflog_action}: updating HEAD");
            journal.capture("reset", || Ok(json!({"previousHead":before.oid,"target":plan.target,"branchRef":before_symbolic_head,"reflogLabel":reflog_label})))?;
            let output = run_git(&root, &["reset", flag, &plan.target], &[("GIT_REFLOG_ACTION", std::ffi::OsStr::new(&reflog_action))], None, HOOK_TIMEOUT)?;
            json!({"output":String::from_utf8_lossy(&output),"previousHead":before.oid,"head":plan.target,"symbolicHead":plan.symbolic_head,"undoId":operation_id})
        }
        "git.operation.abort" | "git.operation.continue" => {
            let kind = required_string(params, "kind")?;
            let command = if method == "git.operation.abort" { "--abort" } else { "--continue" };
            let args = if method == "git.operation.continue" { vec!["-c", "core.editor=true", kind, command] } else { vec![kind, command] };
            let output = run_git(&root, &args, &[], None, HOOK_TIMEOUT)?;
            if method == "git.operation.abort" {
                json!({"output":String::from_utf8_lossy(&output),"head":head_oid(&root)?})
            } else {
                json!({"output":String::from_utf8_lossy(&output),"conflicted":false,"head":head_oid(&root)?})
            }
        }
        _ => unreachable!(),
    };
    if matches!(method, "git.stash.apply" | "git.checkout") {
        let outcome = result.get("stash").unwrap_or(&result);
        if outcome.get("dropped").and_then(Value::as_bool) != Some(true) { journal.remove()?; }
    }
    // Do not hide an uncertain external outcome: failure to persist completion is returned
    // to the caller; the reserved operation remains distinguishable from a successful one.
    if let Err(error) = db.transaction(|tx| {
        if method == "git.undo" {
            if !crate::db::mark_git_undo_undone(tx, required_string(params, "id")?)? { return Err(anyhow!("undo_already_undone")); }
        }
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
        if let Some(oid) = result.get("oid").or_else(|| result.get("stash").and_then(|stash| stash.get("oid"))) {
            let outcome = result.get("stash").unwrap_or(&result);
            let mut detail = json!({"oid":oid,"error":error.to_string()});
            for key in ["applied", "dropped", "conflicted", "interference"] { if let Some(value) = outcome.get(key) { detail[key] = value.clone(); } }
            return Err(anyhow!("stash_operation_failed: {}", detail));
        }
        return Err(error);
    }
    stash_receipt(method, result).map(Some)
}


struct UndoJournal<'a> {
    db: &'a Database,
    operation_id: &'a str,
    project_id: &'a str,
    root: &'a Path,
    release_on_failure: bool,
}

impl UndoJournal<'_> {
    fn capture(&self, kind: &str, capture: impl FnOnce() -> Result<Value>) -> Result<Value> {
        let outcome = (|| {
            let payload = capture()?;
            if let Some(existing) = self.db.git_undo_get(self.operation_id, self.project_id, &self.root.to_string_lossy())? {
                if existing.kind != kind || existing.payload != payload { return Err(anyhow!("undo_capture_changed")); }
            } else {
                self.db.git_undo_insert(self.operation_id, self.operation_id, self.project_id,
                    &self.root.to_string_lossy(), kind, &payload)?;
            }
            Ok(payload)
        })();
        match outcome {
            Ok(payload) => Ok(payload),
            Err(error) => {
                if self.release_on_failure { release_discard_claim(self.db, self.operation_id)?; }
                if error.to_string().contains("discard_conflict") || error.to_string() == "undo_capture_unsupported" { return Err(error); }
                Err(anyhow!("undo_capture_failed: {error}"))
            }
        }
    }

    fn remove(&self) -> Result<()> {
        self.db.transaction(|tx| crate::db::delete_git_undo(tx, self.operation_id))
    }
}

fn undo_entry(db: &Database, root: &Path, params: &serde_json::Map<String, Value>) -> Result<crate::db::GitUndoEntry> {
    let entry = db.git_undo_get(required_string(params, "id")?, required_string(params, "projectId")?, &root.to_string_lossy())?
        .ok_or_else(|| anyhow!("undo_unavailable"))?;
    if entry.undone_at.is_some() { return Err(anyhow!("undo_already_undone")); }
    // An unfinished external action cannot be assumed to have completed, even if
    // its recovery identifiers were captured before the effect.
    if !undo_effect_confirmed(db, &entry)? { return Err(anyhow!("undo_unavailable")); }
    Ok(entry)
}

fn undo_effect_confirmed(db: &Database, entry: &crate::db::GitUndoEntry) -> Result<bool> {
    let Some(receipt) = db.operation(&entry.operation_id)? else { return Ok(false); };
    if entry.kind == "stash" {
        let outcome = receipt.get("stash").unwrap_or(&receipt);
        return Ok(outcome.get("dropped").and_then(Value::as_bool) == Some(true) && outcome.get("interference").is_none());
    }
    Ok(true)
}

fn undo_objects_available(root: &Path, kind: &str, payload: &Value) -> bool {
    let keys: &[&str] = match kind { "branch" => &["tipOid"], "stash" => &["stashOid"], "reset" => &["previousHead"], _ => &[] };
    keys.iter().all(|key| payload[*key].as_str().is_some_and(|oid| git(root, &["cat-file", "-e", oid]).is_ok()))
}

fn undo_preflight(db: &Database, root: &Path, params: &serde_json::Map<String, Value>) -> Result<()> {
    let entry = undo_entry(db, root, params)?;
    let p = &entry.payload;
    if !undo_objects_available(root, &entry.kind, p) { return Err(anyhow!("undo_unavailable")); }
    match entry.kind.as_str() {
        "discard" => { crate::git_undo::preflight_discard(root, p)?; }
        "branch" => {
            let branch = p["branch"].as_str().ok_or_else(|| anyhow!("undo_unavailable"))?;
            validate_branch_name(root, branch)?;
            if checkout_optional_ref(root, &format!("refs/heads/{branch}"))?.is_some() { return Err(anyhow!("undo_conflict: {branch}")); }
        }
        "stash" => {}
        "reset" => {
            let head = checkout_head(root)?;
            let reference = p["branchRef"].as_str().ok_or_else(|| anyhow!("undo_unavailable"))?;
            if Some(head.oid.as_str()) != p["target"].as_str() || symbolic_head(root, &head)? != reference { return Err(anyhow!("undo_conflict: HEAD")); }
            reset_reflog_continuity(root, reference, &head.oid, p["previousHead"].as_str().ok_or_else(|| anyhow!("undo_unavailable"))?)
                .map_err(|_| anyhow!("undo_conflict: HEAD"))?;
            // Keep the existing continuity fence and also identify this exact reset:
            // an external reset away and back can recreate the same OID boundary.
            let label = p["reflogLabel"].as_str().ok_or_else(|| anyhow!("undo_unavailable"))?;
            for reference in if reference == "detached" { vec!["HEAD"] } else { vec![reference, "HEAD"] } {
                if git(root, &["reflog", "show", "--format=%gs", "-1", reference])?.trim_end() != label {
                    return Err(anyhow!("undo_conflict: HEAD"));
                }
            }
        }
        _ => return Err(anyhow!("undo_unavailable")),
    }
    Ok(())
}

fn release_undo_claim(db: &Database, operation_id: &str) -> Result<()> {
    db.transaction(|tx| {
        tx.execute("DELETE FROM external_operations WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM operations WHERE id=?1)", [operation_id])?;
        tx.execute("DELETE FROM operation_requests WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM operations WHERE id=?1) AND NOT EXISTS(SELECT 1 FROM external_operations WHERE id=?1)", [operation_id])?;
        Ok(())
    })
}

fn mark_undo_partial(
    db: &Database,
    entry: &crate::db::GitUndoEntry,
    applied: &[String],
    remaining: &[String],
) -> Result<()> {
    let mut payload = entry.payload.clone();
    anyhow::ensure!(payload.is_object(), "undo_unavailable");
    payload["partial"] = serde_json::json!({"applied": applied, "remaining": remaining});
    db.transaction(|tx| {
        anyhow::ensure!(
            crate::db::mark_git_undo_partial(tx, &entry.id, &payload)?,
            "undo_already_undone"
        );
        Ok(())
    })
}

fn undo_apply(db: &Database, operation_id: &str, root: &Path, params: &serde_json::Map<String, Value>) -> Result<Value> {
    if let Err(error) = undo_preflight(db, root, params) {
        release_undo_claim(db, operation_id)?;
        return Err(error);
    }
    let entry = undo_entry(db, root, params)?;
    let p = &entry.payload;
    match entry.kind.as_str() {
        "discard" => {
            let prepared = match crate::git_undo::preflight_discard(root, p) {
                Ok(prepared) => prepared,
                Err(error) => { release_undo_claim(db, operation_id)?; return Err(error); }
            };
            if let Err(error) = crate::git_undo::apply_discard(root, prepared) {
                if crate::git_undo::undo_no_effect(&error) {
                    release_undo_claim(db, operation_id)?;
                } else if let Some((applied, remaining)) = crate::git_undo::undo_progress(&error) {
                    // Some paths were restored before the failure: retire the entry,
                    // keep the progress visible and let every surface re-read the worktree.
                    if !applied.is_empty() {
                        let mut suffix = String::new();
                        if let Err(mark) = mark_undo_partial(db, &entry, applied, remaining) {
                            suffix.push_str(&format!("; undo journal update failed: {mark}"));
                        }
                        let worktree = params.get("worktreePath").and_then(Value::as_str);
                        if publish_git_change(db, required_string(params, "projectId")?, worktree).is_err() {
                            suffix.push_str("; refresh event unavailable");
                        }
                        if !suffix.is_empty() {
                            return Err(anyhow!("{error}{suffix}"));
                        }
                    }
                }
                return Err(error);
            }
        }
        "branch" => {
            let branch = p["branch"].as_str().unwrap();
            // update-ref's zero-old-OID condition also fences a racing branch creator.
            let zero = "0".repeat(p["tipOid"].as_str().unwrap().len());
            git(root, &["update-ref", &format!("refs/heads/{branch}"), p["tipOid"].as_str().unwrap(), &zero])?;
            for key in ["remote", "merge"] {
                if let Some(value) = p[key].as_str() { git(root, &["config", &format!("branch.{branch}.{key}"), value])?; }
            }
        }
        "stash" => {
            let oid = p["stashOid"].as_str().unwrap();
            if !stash_stack(root)?.iter().any(|(present, _)| present == oid) {
                stash_restore_foreign(root, oid, p["message"].as_str().unwrap_or("Recovered stash"))?;
            }
        }
        "reset" => { git(root, &["reset", "--soft", p["previousHead"].as_str().unwrap()])?; }
        _ => return Err(anyhow!("undo_unavailable")),
    }
    Ok(json!({"id":entry.id,"undoneAt":Utc::now().to_rfc3339()}))
}

fn undo_list(db: &Database, params_value: &Value) -> Result<Value> {
    let params = params_value.as_object().ok_or_else(|| anyhow!("invalid_request"))?;
    let project = required_string(params, "projectId")?;
    let root = db.transaction(|tx| root_for(tx, project, params.get("worktreePath").and_then(Value::as_str)))?;
    let mut rows = Vec::new();
    for entry in db.git_undo_list(project, &root.to_string_lossy())? {
        if !undo_effect_confirmed(db, &entry)? { continue; }
        let p = &entry.payload;
        // A discard row names only what Undo can restore; paths that went to the
        // Recycle Bin are counted separately.
        let (paths, recycled) = match entry.kind.as_str() {
            "discard" => crate::git_undo::discard_undoable_paths(p).unwrap_or_default(),
            _ => (p["paths"].as_array().map(|paths| paths.iter().filter_map(|path| path.as_str().or_else(|| path["path"].as_str())).map(str::to_owned).collect::<Vec<_>>()).unwrap_or_default(), 0),
        };
        let plural = if paths.len() == 1 { "" } else { "s" };
        let recycled_plural = if recycled == 1 { "" } else { "s" };
        let label = match entry.kind.as_str() {
            "branch" => format!("Delete {}", p["branch"].as_str().unwrap_or("branch")),
            "stash" => format!("Remove stash: {}", p["message"].as_str().unwrap_or("stash")),
            "reset" => format!("Reset {}", p["previousHead"].as_str().unwrap_or("").chars().take(8).collect::<String>()),
            _ if paths.is_empty() && recycled > 0 => format!("{recycled} file{recycled_plural} moved to the Recycle Bin"),
            _ => {
                let mut label = format!("Discarded changes in {} file{plural}", paths.len());
                if recycled > 0 { label.push_str(&format!(" ({recycled} more moved to the Recycle Bin)")); }
                label
            }
        };
        let available = entry.undone_at.is_none() && if entry.kind == "discard" { crate::git_undo::discard_available(&root, p) } else { undo_objects_available(&root, &entry.kind, p) };
        let empty = Vec::new();
        let partial = p.get("partial");
        let applied = partial
            .and_then(|partial| partial["applied"].as_array())
            .map(|applied| applied.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>())
            .unwrap_or_else(|| empty.clone());
        let remaining = partial
            .and_then(|partial| partial["remaining"].as_array())
            .map(|remaining| remaining.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>())
            .unwrap_or(empty);
        rows.push(json!({"id":entry.id,"kind":entry.kind,"label":label,"createdAt":entry.created_at,
            "available":available,"paths":paths.iter().take(20).collect::<Vec<_>>(),"pathCount":paths.len(),"undoneAt":entry.undone_at,"recycledCount":recycled,
            "partial":!applied.is_empty()||!remaining.is_empty(),
            "applied":applied.iter().take(20).collect::<Vec<_>>(),"remaining":remaining.iter().take(20).collect::<Vec<_>>()}));
    }
    Ok(json!({"entries":rows}))
}

fn stash_publish_failure<T>(db: &Database, scope: (&str, Option<&str>), result: Result<T>) -> Result<T> {
    if let Err(original) = &result {
        let published = db.transaction(|tx| {
            tx.execute("INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
                params![serde_json::to_string(&json!({"kind":"git","projectId":scope.0,"worktreePath":scope.1}))?, Utc::now().to_rfc3339()])?;
            Ok(())
        });
        if let Err(publication) = published {
            let raw = original.to_string();
            if let Some(detail) = raw.strip_prefix("stash_operation_failed: ") {
                if let Ok(mut detail) = serde_json::from_str::<Value>(detail) {
                    detail["publicationError"] = json!(publication.to_string());
                    return Err(anyhow!("stash_operation_failed: {}", detail));
                }
            }
            return Err(anyhow!("{original}; state.changed publication failed: {publication}"));
        }
    }
    result
}

#[derive(Debug, PartialEq, Eq)]
struct HistoryActionState { head: CheckoutHead, index_tree: String }

fn head_oid(root: &Path) -> Result<String> {
    let head = git(root, &["rev-parse", "HEAD"])?;
    let head = head.trim();
    if full_oid(head) { Ok(head.to_owned()) } else { Err(anyhow!("commit_not_found")) }
}

fn history_operation(root: &Path) -> Result<Option<String>> {
    let paths = git(root, &["rev-parse", "--git-path", "MERGE_HEAD", "--git-path", "rebase-merge", "--git-path", "rebase-apply", "--git-path", "CHERRY_PICK_HEAD", "--git-path", "REVERT_HEAD"])?;
    let paths = paths.lines().map(Path::new).map(|path| if path.is_absolute() { path.to_owned() } else { root.join(path) }).collect::<Vec<_>>();
    if paths.len() != 5 { return Err(anyhow!("git_failed")); }
    if paths[0].exists() { return Ok(Some("merge".to_owned())); }
    if paths[1].exists() || paths[2].exists() { return Ok(Some("rebase".to_owned())); }
    if paths[3].exists() { return Ok(Some("cherry-pick".to_owned())); }
    if paths[4].exists() { return Ok(Some("revert".to_owned())); }
    Ok(None)
}

fn resolve_history_commit(root: &Path, value: &str) -> Result<String> {
    if !(7..=64).contains(&value.len()) || !value.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(anyhow!("invalid_commit"));
    }
    let oid = git(root, &["rev-parse", "--verify", "--quiet", &format!("{value}^{{commit}}")])
        .map(|output| output.trim().to_owned())
        .map_err(|_| anyhow!("commit_not_found"))?;
    if full_oid(&oid) { Ok(oid) } else { Err(anyhow!("commit_not_found")) }
}

fn history_commit_preflight(root: &Path, params: &serde_json::Map<String, Value>, method: &str) -> Result<String> {
    let hash = resolve_history_commit(root, required_string(params, "hash")?)?;
    if let Some(kind) = history_operation(root)? { return Err(anyhow!("operation_in_progress: {kind}")); }
    if method == "git.cherryPick" && checkout_head(root)?.reference.is_none() { return Err(anyhow!("detached_head")); }
    if method == "git.cherryPick" && params.contains_key("mainline") { return Err(anyhow!("invalid_request")); }
    if method == "git.revert" {
        let parents = git(root, &["log", "-1", "--format=%P", &hash])?.split_whitespace().count();
        match params.get("mainline") {
            Some(Value::Number(value)) if value.as_u64().is_some_and(|mainline| mainline > 0 && mainline as usize <= parents) => {}
            None if parents <= 1 => {}
            None => return Err(anyhow!("mainline_required")),
            _ => return Err(anyhow!("invalid_mainline")),
        }
    }
    Ok(hash)
}

struct ResetPlan {
    target: String,
    symbolic_head: String,
}

fn symbolic_head(root: &Path, head: &CheckoutHead) -> Result<String> {
    match git(root, &["symbolic-ref", "--quiet", "HEAD"]) {
        Ok(value) => {
            let reference = value.trim();
            if reference.starts_with("refs/heads/") && head.reference.as_deref() == Some(reference) {
                Ok(reference.to_owned())
            } else {
                Err(anyhow!("head_moved"))
            }
        }
        Err(error)
            if error
                .to_string()
                .strip_prefix("git_failed:")
                .is_some_and(|stderr| stderr.trim().is_empty()) =>
        {
            if head.reference.is_none() { Ok("detached".to_owned()) } else { Err(anyhow!("head_moved")) }
        }
        Err(error) => Err(error),
    }
}

fn reset_reflog_entry(root: &Path, reference: &str, target: &str, previous: &str) -> Result<()> {
    let output = git(root, &["reflog", "show", "--format=%H%x00%gs", "-2", reference])
        .map_err(|_| anyhow!("branch_changed"))?;
    let mut lines = output.lines();
    let newest = lines.next().and_then(|line| line.split_once('\0'));
    let prior = lines.next().and_then(|line| line.split_once('\0'));
    if lines.next().is_some()
        || !matches!(newest, Some((oid, subject)) if oid == target && subject.starts_with("reset: moving to"))
        || !matches!(prior, Some((oid, _)) if oid == previous)
    {
        return Err(anyhow!("branch_changed"));
    }
    Ok(())
}

fn reset_reflog_continuity(root: &Path, symbolic_head: &str, target: &str, previous: &str) -> Result<()> {
    let reference = if symbolic_head == "detached" { "HEAD" } else { symbolic_head };
    reset_reflog_entry(root, reference, target, previous)?;
    if reference != "HEAD" {
        reset_reflog_entry(root, "HEAD", target, previous)?;
    }
    Ok(())
}

fn reset_preflight(db: &Database, root: &Path, params: &serde_json::Map<String, Value>, project_id: &str, worktree: Option<&str>) -> Result<ResetPlan> {
    let hash = resolve_history_commit(root, required_string(params, "hash")?)?;
    if let Some(kind) = history_operation(root)? { return Err(anyhow!("operation_in_progress: {kind}")); }
    let mode = required_string(params, "mode")?;
    if !matches!(mode, "soft" | "mixed") { return Err(anyhow!("invalid_request")); }
    let expected = required_string(params, "expectedHead")?;
    if !full_oid(expected) { return Err(anyhow!("invalid_request")); }
    let current = checkout_head(root)?;
    if current.oid != expected { return Err(anyhow!("head_moved")); }
    let current_symbolic_head = symbolic_head(root, &current)?;
    if let Some(undo_of) = params.get("undoOf") {
        if mode != "soft" { return Err(anyhow!("invalid_request")); }
        let undo_of = undo_of.as_str().filter(|value| !value.is_empty()).ok_or_else(|| anyhow!("invalid_request"))?;
        let (method, request) = db.operation_request(undo_of)?.ok_or_else(|| anyhow!("reset_undo_not_found"))?;
        let receipt = db.operation(undo_of)?.ok_or_else(|| anyhow!("reset_undo_not_found"))?;
        let receipt_symbolic_head = receipt.get("symbolicHead").and_then(Value::as_str).ok_or_else(|| anyhow!("reset_undo_invalid"))?;
        if method != "git.reset"
            || request.get("projectId").and_then(Value::as_str) != Some(project_id)
            || request.get("worktreePath").and_then(Value::as_str) != worktree
            || receipt.get("previousHead").and_then(Value::as_str) != Some(hash.as_str())
            || receipt.get("head").and_then(Value::as_str) != Some(expected)
        { return Err(anyhow!("reset_undo_invalid")); }
        if current_symbolic_head != receipt_symbolic_head { return Err(anyhow!("head_moved")); }
        reset_reflog_continuity(root, receipt_symbolic_head, expected, &hash)?;
    } else if !run_git(root, &["merge-base", "--is-ancestor", &hash, expected], &[], None, LOCAL_TIMEOUT).is_ok() {
        return Err(anyhow!("not_ancestor"));
    }
    Ok(ResetPlan { target: hash, symbolic_head: current_symbolic_head })
}

fn operation_preflight(root: &Path, params: &serde_json::Map<String, Value>, continuing: bool) -> Result<()> {
    let kind = required_string(params, "kind")?;
    if !matches!(kind, "cherry-pick" | "revert") { return Err(anyhow!("invalid_request")); }
    if history_operation(root)?.as_deref() != Some(kind) { return Err(anyhow!("operation_not_in_progress")); }
    if continuing && !git(root, &["diff", "--name-only", "--diff-filter=U"])?.trim().is_empty() {
        return Err(anyhow!("unresolved_conflicts"));
    }
    Ok(())
}

fn history_action_state(root: &Path) -> Result<HistoryActionState> {
    Ok(HistoryActionState {
        head: checkout_head(root)?,
        index_tree: git(root, &["write-tree"])?.trim().to_owned(),
    })
}

fn history_action_unchanged(root: &Path, before: &HistoryActionState) -> bool {
    history_operation(root).ok().flatten().is_none()
        && history_action_state(root).ok().as_ref() == Some(before)
}

/// Recognizes only Git 2.33's complete, English refusal sequences.  Unknown
/// output retains its claim because it cannot prove Git did no work.
fn history_refusal_paths(stderr: &str, command: &str) -> Option<Vec<String>> {
    let lines = stderr.strip_prefix("git_failed: ").unwrap_or(stderr).lines().map(|line| line.trim_end_matches('\r')).filter(|line| !line.is_empty()).collect::<Vec<_>>();
    let fatal = format!("fatal: {command} failed");
    let staged = [
        format!("error: your local changes would be overwritten by {command}."),
        "hint: commit your changes or stash them to proceed.".to_owned(),
        fatal.clone(),
    ];
    if lines == staged.iter().map(String::as_str).collect::<Vec<_>>() { return Some(Vec::new()); }
    if lines == [format!("error: your local changes would be overwritten by {command}."), fatal.clone()] { return Some(Vec::new()); }
    let headers = [
        "error: Your local changes to the following files would be overwritten by merge:",
        "error: The following untracked working tree files would be overwritten by merge:",
    ];
    let trailers = [
        "Please commit your changes or stash them before you merge.",
        "Please move or remove them before you merge.",
    ];
    let mut cursor = 0;
    let mut paths = Vec::new();
    while headers.contains(lines.get(cursor)?) {
        cursor += 1;
        let start = cursor;
        while let Some(path) = lines.get(cursor).and_then(|line| line.strip_prefix('\t')) {
            if path.is_empty() { return None; }
            if paths.len() < 50 && !paths.iter().any(|known| known == path) { paths.push(path.to_owned()); }
            cursor += 1;
        }
        if cursor == start { return None; }
        if trailers.contains(lines.get(cursor)?) { cursor += 1; }
    }
    (cursor + 2 == lines.len() && lines.get(cursor) == Some(&"Aborting") && lines.get(cursor + 1) == Some(&fatal.as_str()) && !paths.is_empty()).then_some(paths)
}

fn history_apply(db: &Database, operation_id: &str, root: &Path, method: &str, params: &serde_json::Map<String, Value>, hash: &str) -> Result<Value> {
    let command = if method == "git.cherryPick" { "cherry-pick" } else { "revert" };
    let mut args = vec![command, "--no-edit"];
    let mainline = (command == "revert").then(|| params.get("mainline").and_then(Value::as_u64).map(|value| value.to_string())).flatten();
    if let Some(mainline) = mainline.as_deref() {
        args.extend(["-m", mainline]);
    }
    args.push(hash);
    let before = history_action_state(root)?;
    match run_git(root, &args, &[("LANGUAGE", std::ffi::OsStr::new("C"))], None, HOOK_TIMEOUT) {
        Ok(output) => Ok(json!({"output":String::from_utf8_lossy(&output),"conflicted":false,"head":head_oid(root)?})),
        Err(error) => {
            let text = error.to_string();
            if history_operation(root)?.as_deref() == Some(command) {
                return Ok(json!({"output":text,"conflicted":true,"head":head_oid(root)?}));
            }
            if history_refusal_paths(&text, command).is_some() && history_action_unchanged(root, &before) {
                release_discard_claim(db, operation_id)?;
                let code = if command == "cherry-pick" { "cherry_pick_would_overwrite" } else { "revert_would_overwrite" };
                return Err(anyhow!("{code}"));
            }
            Err(error)
        }
    }
}

// Failed smart switches are durable receipts too: retries must never stash twice.
fn stash_receipt(method: &str, result: Value) -> Result<Value> {
    if method == "git.stash.drop" {
        if let Some(detail) = result.get("interference") { return Err(anyhow!("stash_drop_interfered: {}", detail)); }
    }
    if method == "git.checkout" && result.get("error").is_some() && result.get("stash").is_some() {
        return Err(anyhow!("stash_switch_failed: {}", result));
    }
    Ok(result)
}

fn stash_message(params: &serde_json::Map<String, Value>) -> Result<String> {
    let message = match params.get("message") {
        None => "",
        Some(Value::String(value)) => value,
        _ => return Err(anyhow!("invalid_request")),
    };
    Ok(message.chars().filter(|ch| !ch.is_control()).take(200).collect())
}

fn stash_has_changes(root: &Path, include: bool) -> Result<bool> {
    let flag = if include { "--untracked-files=all" } else { "--untracked-files=no" };
    Ok(!git(root, &["status", "--porcelain", flag])?.trim().is_empty())
}

fn stash_stack(root: &Path) -> Result<Vec<(String, String)>> {
    let output = run_git(root, &["stash", "list", "--format=%H%x00%gs"], &[], None, LOCAL_TIMEOUT)?;
    Ok(String::from_utf8(output)?.lines().filter_map(|line| {
        line.split_once('\0').map(|(oid, subject)| (oid.to_owned(), subject.to_owned()))
    }).collect())
}

fn stash_push_snapshot(root: &Path) -> Result<Vec<(String, String)>> {
    // %gs is the reflog subject; %s can differ after `stash store -m`.
    let output = run_git(root, &["stash", "list", "--format=%H%x00%gs"], &[], None, LOCAL_TIMEOUT)?;
    Ok(String::from_utf8(output)?.lines().filter_map(|line| {
        line.split_once('\0').map(|(oid, subject)| (oid.to_owned(), subject.to_owned()))
    }).collect())
}

struct StashPushed { oid: String, added_entry: bool }

fn stash_push(root: &Path, message: &str, include: bool) -> Result<Option<StashPushed>> {
    let before = stash_push_snapshot(root)?;
    if !stash_has_changes(root, include)? { return Ok(None); }
    let head = checkout_head(root)?;
    let branch = head.reference.as_deref().and_then(|reference| reference.strip_prefix("refs/heads/")).unwrap_or("(no branch)");
    let expected = if message.is_empty() {
        format!("WIP on {branch}: {}", git(root, &["log", "-1", "--format=%h %s"])?.trim_end_matches(['\r', '\n']))
    } else {
        format!("On {branch}: {message}")
    };
    // Git copy_reflog_msg collapses ASCII whitespace and trims the subject.
    let expected = expected.split_ascii_whitespace().collect::<Vec<_>>().join(" ");
    let mut args = vec!["stash", "push"];
    if include { args.push("--include-untracked"); }
    if !message.is_empty() { args.extend(["-m", message]); }
    #[cfg(test)]
    let mut env = stash_test_hooks::push_env();
    #[cfg(not(test))]
    let mut env = Vec::new();
    env.push(("LANGUAGE", std::ffi::OsStr::new("C")));
    let pushed = run_git(root, &args, &env, None, HOOK_TIMEOUT);
    #[cfg(test)]
    let pushed = pushed.and_then(|output| { stash_test_hooks::after_push(root)?; Ok(output) });
    let after = stash_push_snapshot(root).map_err(|error| anyhow!("stash_operation_failed: {}", json!({"candidateOids":[],"error":error.to_string()})))?;
    // Subtract occurrences, rather than a set, to retain repeated same-OID
    // entries when Git did append a reflog record. Never attribute the new top.
    let mut remaining = before;
    let candidates: Vec<_> = after.iter().filter(|entry| {
        if let Some(index) = remaining.iter().position(|before| before == *entry) {
            remaining.remove(index);
            false
        } else { true }
    }).collect();
    let candidate_oids: Vec<_> = candidates.iter().map(|(oid, _)| oid.as_str()).collect();
    let matches: Vec<_> = candidates.iter().filter(|(_, subject)| subject == &expected).collect();
    if let Err(error) = pushed {
        let mut detail = json!({"candidateOids":candidate_oids,"error":error.to_string()});
        if matches.len() == 1 { detail["oid"] = json!(matches[0].0); }
        return Err(anyhow!("stash_operation_failed: {}", detail));
    }
    if matches.len() != 1 {
        let retained_oids: Vec<_> = after.iter().map(|(oid, _)| oid.as_str()).collect();
        return Err(anyhow!("stash_operation_failed: {}", json!({"candidateOids":candidate_oids,"retainedOids":retained_oids,"error":format!("Cannot uniquely attribute stash push; candidate OIDs: {}; retained OIDs: {}",json!(candidate_oids),json!(retained_oids))})));
    }
    Ok(Some(StashPushed { oid: matches[0].0.clone(), added_entry: true }))
}

fn stash_error_detail(oid: &str, error: anyhow::Error) -> Value {
    let raw = error.to_string();
    let mut detail = raw.strip_prefix("stash_operation_failed: ")
        .and_then(|detail| serde_json::from_str::<Value>(detail).ok())
        .filter(Value::is_object).unwrap_or_else(|| json!({"error":raw}));
    detail["oid"] = json!(oid);
    detail
}

fn stash_restore_foreign(root: &Path, oid: &str, message: &str) -> Result<()> {
    run_git(root, &["stash", "store", "-m", message, oid], &[], None, HOOK_TIMEOUT)?;
    Ok(())
}

fn stash_drop(root: &Path, oid: &str, journal: &UndoJournal<'_>) -> Result<Option<Value>> {
    let before = stash_stack(root)?;
    let index = before.iter().position(|(entry, _)| entry == oid).ok_or_else(|| anyhow!("stash_not_found"))?;
    journal.capture("stash", || Ok(json!({"stashOid":oid,"message":before[index].1.chars().take(200).collect::<String>()})))?;
    let selector = format!("stash@{{{index}}}");
    #[cfg(test)]
    stash_test_hooks::before_drop(root)?;
    // Porcelain stdout describes Git's earlier resolution, not what reflog delete
    // removed under its lock. Only the observed stack transition can prove success.
    let _dropped = run_git(root, &["stash", "drop", &selector], &[("LANGUAGE", std::ffi::OsStr::new("C"))], None, HOOK_TIMEOUT);
    #[cfg(test)]
    stash_test_hooks::after_drop(root)?;
    let after = stash_stack(root).map_err(|error| anyhow!("stash_operation_failed: {}", json!({"oid":oid,"dropped":null,"error":error.to_string()})))?;
    let ours_gone = !after.iter().any(|(entry, _)| entry == oid);
    let missing: Vec<_> = before.iter().filter(|(entry, _)| entry != oid && !after.iter().any(|(present, _)| present == entry)).collect();
    if ours_gone && missing.is_empty() { return Ok(None); }
    let unknown = !ours_gone && missing.is_empty();
    let mut restored = Vec::new();
    let mut restore_failed = Vec::new();
    for (entry, message) in missing {
        match stash_restore_foreign(root, entry, message) {
            Ok(()) => restored.push(json!({"oid":entry,"message":message})),
            Err(error) => restore_failed.push(json!({"oid":entry,"message":message,"error":error.to_string()})),
        }
    }
    let expected: Vec<_> = before.iter().filter(|(entry, _)| !ours_gone || entry != oid).collect();
    let order_changed = !restored.is_empty() || stash_stack(root).map(|current| {
        // Ignore newly pushed entries when comparing the order of known entries.
        let known: Vec<_> = current.iter().filter(|(entry, _)| before.iter().any(|(old, _)| old == entry)).collect();
        known != expected
    }).unwrap_or(true);
    let mut detail = json!({"oid":oid,"ourEntryDropped":ours_gone,"restored":restored,"restoreFailed":restore_failed,"orderChanged":order_changed});
    if unknown { detail["unknownEntryLost"] = json!(true); }
    // Recovery of a foreign entry must not depend on journal maintenance.
    if let Err(error) = journal.remove() {
        return Err(anyhow!("stash_operation_failed: {}", json!({"oid":oid,"dropped":false,"interference":detail,"error":error.to_string()})));
    }
    Ok(Some(detail))
}

#[cfg(test)]
mod stash_test_hooks {
    use super::*;
    type Hook = Box<dyn FnMut(&Path) -> Result<()>>;
    #[derive(Default)]
    struct State { before_drop: Option<Hook>, after_apply: Option<Hook>, fixed_dates: bool }
    thread_local! { static STATE: std::cell::RefCell<State> = std::cell::RefCell::new(State::default()); }
    pub struct Guard(State);
    impl Drop for Guard { fn drop(&mut self) { STATE.with(|state| *state.borrow_mut() = std::mem::take(&mut self.0)); } }
    pub fn install(before_drop: Option<Hook>, after_apply: Option<Hook>, fixed_dates: bool, _mask_output: bool) -> Guard {
        STATE.with(|state| Guard(std::mem::replace(&mut *state.borrow_mut(), State { before_drop, after_apply, fixed_dates })))
    }
    pub fn before_drop(root: &Path) -> Result<()> { STATE.with(|state| match state.borrow_mut().before_drop.as_mut() { Some(hook) => hook(root), None => Ok(()) }) }
    pub fn after_apply(root: &Path) -> Result<()> { let hook = STATE.with(|state| state.borrow_mut().after_apply.take()); match hook { Some(mut hook) => hook(root), None => Ok(()) } }
    thread_local! { static AFTER_PUSH: std::cell::RefCell<Option<Hook>> = const { std::cell::RefCell::new(None) }; }
    pub struct AfterPushGuard(Option<Hook>);
    impl Drop for AfterPushGuard { fn drop(&mut self) { AFTER_PUSH.with(|state| *state.borrow_mut() = self.0.take()); } }
    pub fn install_after_push(hook: Hook) -> AfterPushGuard {
        AFTER_PUSH.with(|state| AfterPushGuard(state.replace(Some(hook))))
    }
    pub fn after_push(root: &Path) -> Result<()> {
        let hook = AFTER_PUSH.with(|state| state.borrow_mut().take());
        match hook { Some(mut hook) => hook(root), None => Ok(()) }
    }
    thread_local! { static AFTER_DROP: std::cell::RefCell<Option<Hook>> = const { std::cell::RefCell::new(None) }; }
    pub struct AfterDropGuard(Option<Hook>);
    impl Drop for AfterDropGuard { fn drop(&mut self) { AFTER_DROP.with(|state| *state.borrow_mut() = self.0.take()); } }
    pub fn install_after_drop(hook: Hook) -> AfterDropGuard {
        AFTER_DROP.with(|state| AfterDropGuard(state.replace(Some(hook))))
    }
    pub fn after_drop(root: &Path) -> Result<()> {
        let hook = AFTER_DROP.with(|state| state.borrow_mut().take());
        match hook { Some(mut hook) => hook(root), None => Ok(()) }
    }
    pub fn push_env() -> Vec<(&'static str, &'static std::ffi::OsStr)> {
        if STATE.with(|state| state.borrow().fixed_dates) {
            vec![("GIT_AUTHOR_DATE", std::ffi::OsStr::new("2001-01-01T00:00:00Z")), ("GIT_COMMITTER_DATE", std::ffi::OsStr::new("2001-01-01T00:00:00Z"))]
        } else { Vec::new() }
    }
}

fn stash_apply(root: &Path, oid: &str, pop: bool, journal: &UndoJournal<'_>) -> Result<Value> {
    crate::git_read::stash_resolve(root, oid)?;
    if pop {
        let stack = stash_stack(root)?;
        let message = stack.iter().find(|(entry, _)| entry == oid).ok_or_else(|| anyhow!("stash_not_found"))?.1.chars().take(200).collect::<String>();
        journal.capture("stash", || Ok(json!({"stashOid":oid,"message":message})))?;
    }
    match run_git(root, &["stash", "apply", oid], &[], None, HOOK_TIMEOUT) {
        Ok(_) => {
            let cleanup = (|| -> Result<Option<Value>> {
                #[cfg(test)]
                stash_test_hooks::after_apply(root)?;
                // Apply has already changed the worktree. A cleanup/capture
                // failure must retain the uncertain claim rather than retry apply.
                let cleanup_journal = UndoJournal { release_on_failure: false, ..*journal };
                if pop { stash_drop(root, oid, &cleanup_journal) } else { Ok(None) }
            })();
            match cleanup {
                Ok(Some(interference)) => Ok(json!({"oid":oid,"applied":true,"dropped":false,"interference":interference})),
                Ok(None) => {
                    let mut result = json!({"oid":oid,"applied":true,"dropped":pop});
                    if pop { result["undoId"] = json!(journal.operation_id); }
                    Ok(result)
                },
                Err(error) => {
                    let mut detail = stash_error_detail(oid, error);
                    detail["applied"] = json!(true);
                    if detail.get("dropped").is_none() { detail["dropped"] = Value::Null; }
                    Err(anyhow!("stash_operation_failed: {}", detail))
                }
            }
        }
        Err(error) => {
            let unmerged = run_git(root, &["ls-files", "-u", "-z"], &[], None, LOCAL_TIMEOUT)
                .map_err(|read| anyhow!("stash_operation_failed: {}", json!({"oid":oid,"error":read.to_string()})))?;
            if !unmerged.is_empty() {
                Ok(json!({"oid":oid,"applied":true,"conflicted":true,"dropped":false}))
            } else {
                Ok(json!({"oid":oid,"applied":false,"dropped":false,"warning":error.to_string()}))
            }
        }
    }
}

fn stash_switch_message(branch: &str, operation_id: &str) -> String {
    let nonce = hex::encode(Sha256::digest(operation_id.as_bytes()));
    let suffix = format!(" [op {}]", &nonce[..8]);
    let prefix: String = format!("ThreadTerm: switch to {branch}").chars().filter(|ch| !ch.is_control()).take(200 - suffix.chars().count()).collect();
    format!("{prefix}{suffix}")
}

fn stash_switch(root: &Path, plan: &CheckoutPlan, branch: &str, operation_id: &str, journal: &UndoJournal<'_>) -> Result<Value> {
    let before = checkout_head(root)?;
    let message = stash_switch_message(branch, operation_id);
    let pushed = stash_push(root, &message, true)?;
    let args: Vec<&str> = plan.args.iter().map(String::as_str).collect();
    let switched = run_git(root, &args, &[("LANGUAGE", std::ffi::OsStr::new("C"))], None, HOOK_TIMEOUT);
    let Some(pushed) = pushed else {
        let current = git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
        if let Err(error) = switched {
            let target = plan.branch_ref.as_deref().unwrap_or("");
            if checkout_head(root)? == before || (current.trim() != branch && format!("refs/heads/{}", current.trim()) != target) {
                return Err(error);
            }
            return Ok(json!({"branch":current.trim(),"warning":error.to_string()}));
        }
        return Ok(json!({"branch":current.trim()}));
    };
    let oid = pushed.oid;
    let journal = &UndoJournal { release_on_failure: false, ..*journal };
    // Everything after push must retain the recovery OID, even an unexpected read failure.
    let mut known_apply = None;
    let outcome = (|| -> Result<Value> {
        if let Err(error) = &switched {
            let after = checkout_head(root)?;
            if after == before {
                let restored = stash_apply(root, &oid, pushed.added_entry, journal)?;
                known_apply = Some(restored.clone());
                let clean = restored["applied"] == true && restored.get("conflicted") != Some(&Value::Bool(true));
                let mut stash = restored;
                stash["restored"] = json!(clean);
                return Ok(json!({"error":error.to_string(),"stash":stash}));
            }
            // Only the requested target proves that a failed hook followed a real switch.
            let current = git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
            let target = plan.branch_ref.as_deref().unwrap_or("");
            if current.trim() != branch && after.reference.as_deref() != Some(target) {
                return Ok(json!({"error":error.to_string(),"stash":{"oid":oid,"restored":false,"dropped":false}}));
            }
        }
        let mut applied = stash_apply(root, &oid, pushed.added_entry, journal)?;
        known_apply = Some(applied.clone());
        applied["message"] = json!(message);
        let apply_warning = applied.as_object_mut().and_then(|value| value.remove("warning"));
        let current = git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
        let mut result = json!({"branch":current.trim(),"stash":applied});
        if let Err(error) = &switched { result["warning"] = json!(error.to_string()); }
        else if let Some(warning) = apply_warning { result["warning"] = warning; }
        Ok(result)
    })();
    outcome.map_err(|error| {
        let mut detail = stash_error_detail(&oid, error);
        if let Some(outcome) = known_apply {
            for key in ["applied", "dropped", "conflicted", "interference"] { if let Some(value) = outcome.get(key) { detail[key] = value.clone(); } }
        }
        anyhow!("stash_operation_failed: {}", detail)
    })
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

/// Resolve the switch once, then reject read-only conflicts before the claim.
#[derive(Debug)]
struct CheckoutPlan {
    args: Vec<String>,
    creating: bool,
    branch_ref: Option<String>,
}

fn checkout_preflight(root: &Path, params: &serde_json::Map<String, Value>) -> Result<CheckoutPlan> {
    let branch = required_string(params, "branch")?;
    validate_branch_name(root, branch)?;
    let create = params.get("create").and_then(Value::as_bool) == Some(true);
    let start = params.get("startPoint").and_then(Value::as_str);
    if let Some(start) = start {
        if start.is_empty() || start.starts_with('-') || start.len() > 255 { return Err(anyhow!("invalid_start_point")); }
        if checkout_optional_ref(root, &format!("{start}^{{commit}}"))?.is_none() { return Err(anyhow!("start_point_not_found")); }
    }
    let local = format!("refs/heads/{branch}");
    let remote = format!("refs/remotes/{branch}");
    if create {
        let mut args = vec!["switch".to_owned(), "-c".to_owned(), branch.to_owned()];
        if let Some(start) = start { args.push(start.to_owned()); }
        return Ok(CheckoutPlan { args, creating:true, branch_ref:Some(local) });
    }
    if checkout_optional_ref(root, &local)?.is_some() {
        if let Some(owner) = crate::git_read::branch_worktrees(root)?.get(&local) {
            let top = git(root, &["rev-parse", "--show-toplevel"])?;
            let canonical_top = Path::new(top.trim()).canonicalize()?;
            if crate::git_read::worktree_identity(&canonical_top.to_string_lossy()) != crate::git_read::worktree_identity(&owner.path) {
                return Err(anyhow!("branch_checked_out_elsewhere: {}", json!({"path":owner.path,"missing":owner.missing})));
            }
        }
        return Ok(CheckoutPlan { args:vec!["switch".into(), branch.into()], creating:false, branch_ref:None });
    }
    if checkout_optional_ref(root, &remote)?.is_none() { return Err(anyhow!("branch_not_found")); }
    // Git infers the local name by dropping the configured remote prefix.
    // If that cannot be resolved, retain any failed claim conservatively.
    let remotes = git(root, &["remote"])?;
    let prefix = remotes.lines().filter(|name| branch.starts_with(&format!("{name}/"))).max_by_key(|name| name.len());
    let branch_ref = prefix.map(|name| format!("refs/heads/{}", &branch[name.len()+1..]));
    Ok(CheckoutPlan { args:vec!["switch".into(), "--track".into(), branch.into()], creating:true, branch_ref })
}

fn checkout_optional_ref(root: &Path, reference: &str) -> Result<Option<String>> {
    match git(root, &["rev-parse", "--verify", "--quiet", reference]) {
        Ok(value) => Ok(Some(value.trim().to_owned())),
        Err(error) if error.to_string().strip_prefix("git_failed:").is_some_and(|stderr| stderr.trim().is_empty()) => Ok(None),
        Err(error) => Err(error),
    }
}

#[derive(Debug, PartialEq, Eq)]
struct CheckoutHead {
    reference: Option<String>,
    oid: String,
}

fn checkout_head(root: &Path) -> Result<CheckoutHead> {
    // One local call reads both the OID and the symbolic identity. An unborn or
    // unreadable HEAD cannot prove an unchanged checkout and keeps the claim.
    let output = git(root, &["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"])?;
    let mut lines = output.lines();
    let oid = lines.next().filter(|value| !value.is_empty()).ok_or_else(|| anyhow!("checkout_head_unknown"))?;
    let reference = match lines.next() {
        Some("HEAD") => None,
        Some(value) if value.starts_with("refs/") => Some(value.to_owned()),
        _ => return Err(anyhow!("checkout_head_unknown")),
    };
    if lines.next().is_some() { return Err(anyhow!("checkout_head_unknown")); }
    Ok(CheckoutHead { reference, oid:oid.to_owned() })
}

fn checkout_can_release(before: Option<&CheckoutHead>, after: Option<&CheckoutHead>, absent_before: bool, absent_after: bool) -> bool {
    before.is_some() && before == after && absent_before && absent_after
}

/// Only complete, known unpack-trees porcelain refusals prove switch did no work.
fn checkout_refusal_paths(stderr: &str) -> Option<Vec<String>> {
    const HEADERS: [(&str, Option<&str>); 4] = [
        ("error: Your local changes to the following files would be overwritten by checkout:", Some("Please commit your changes or stash them before you switch branches.")),
        ("error: The following untracked working tree files would be overwritten by checkout:", Some("Please move or remove them before you switch branches.")),
        ("error: The following untracked working tree files would be removed by checkout:", Some("Please move or remove them before you switch branches.")),
        ("error: Updating the following directories would lose untracked files in them:", None),
    ];
    let mut block: Option<(Option<&str>, usize)> = None;
    let mut aborted = false;
    let mut paths = Vec::new();
    for line in stderr.lines().map(|line| line.trim_end_matches('\r')).filter(|line| !line.is_empty()) {
        if aborted { return None; }
        if let Some(path) = line.strip_prefix('\t') {
            if path.is_empty() { return None; }
            block.as_mut()?.1 += 1;
            if paths.len() < 50 && !paths.iter().any(|value| value == path) { paths.push(path.to_owned()); }
            continue;
        }
        if let Some((trailer, count)) = block {
            if count == 0 { return None; }
            if let Some(trailer) = trailer {
                if line == trailer {
                    block = None;
                    continue;
                }
            }
            block = None;
        }
        if line == "Aborting" {
            if paths.is_empty() { return None; }
            aborted = true;
        } else {
            let (_, trailer) = HEADERS.iter().find(|(header, _)| *header == line)?;
            block = Some((*trailer, 0));
        }
    }
    if aborted && block.is_none() && !paths.is_empty() { Some(paths) } else { None }
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

/// Publishes a scoped Git change without a completion receipt, so every surface
/// re-reads the worktree after a partially applied effect.
fn publish_git_change(db: &Database, project_id: &str, worktree: Option<&str>) -> Result<()> {
    db.transaction(|tx| {
        let data = json!({"kind":"git","projectId":project_id,"worktreePath":worktree});
        tx.execute(
            "INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
            params![serde_json::to_string(&data)?, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    })
}

fn discard_incomplete(
    db: &Database,
    scope: (&str, Option<&str>),
    completed: &[String],
    failed: &[String],
    error: anyhow::Error,
) -> anyhow::Error {
    // Publish refresh without a completion receipt; the external claim remains uncertain.
    let publication = publish_git_change(db, scope.0, scope.1);
    let displaced = crate::git_undo::kept_displaced(&error).map(str::to_owned);
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
        "discard_incomplete: completed: {}; failed: {}; {detail}{refresh}; completedPaths: {}; remainingPaths: {}; keptDisplaced: {}",
        discard_path_summary(completed),
        discard_path_summary(failed),
        json!(completed), json!(failed), json!(displaced)
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
            tracked.push(path.clone());
        }
    }
    let mut completed = Vec::new();
    let mut recycled = Vec::new();
    // Validate every representation before any recycle or worktree handoff.
    // Each tracked handoff then validates the bytes it actually displaced.
    verify_claimed_discard(db, operation_id, root, paths, params)?;
    let journal = UndoJournal { db, operation_id, project_id: scope.0, root, release_on_failure: true };
    let mut payload = journal.capture("discard", || crate::git_undo::capture_discard(root, paths, params))?;
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
    let undoable = !tracked.is_empty();
    for (index, path) in tracked.iter().enumerate() {
        #[cfg(test)]
        discard_handoff_hooks::before_path(root, path)?;
        let handoff = crate::git_undo::discard_handoff(root, path, params, &mut payload, |payload| {
            db.transaction(|tx| {
                let changed = tx.execute("UPDATE git_undo SET payload=? WHERE id=?", params![serde_json::to_string(payload)?, operation_id])?;
                anyhow::ensure!(changed == 1, "undo_capture_failed");
                Ok(())
            })
        });
        if let Err(error) = handoff {
            return Err(discard_incomplete(db, scope, &completed, &tracked[index..], error));
        }
        completed.push(path.clone());
    }
    let mut result = json!({"paths":paths,"recycled":recycled});
    if undoable { result["undoId"] = json!(operation_id); }
    Ok(result)
}

#[cfg(test)]
mod discard_handoff_hooks {
    use super::*;
    type Hook = Box<dyn FnMut(&Path, &str) -> Result<()>>;
    thread_local! { static BEFORE: std::cell::RefCell<Option<Hook>> = const { std::cell::RefCell::new(None) }; }
    pub struct Guard(Option<Hook>);
    impl Drop for Guard { fn drop(&mut self) { BEFORE.with(|hook| *hook.borrow_mut() = self.0.take()); } }
    pub fn install(hook: Hook) -> Guard { BEFORE.with(|slot| Guard(slot.replace(Some(hook)))) }
    pub fn before_path(root: &Path, path: &str) -> Result<()> {
        BEFORE.with(|hook| match hook.borrow_mut().as_mut() { Some(hook) => hook(root, path), None => Ok(()) })
    }
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
pub(crate) fn discard_worktree_fingerprint(root: &Path, path: &str) -> Result<Option<String>> {
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

pub(crate) fn verify_discard_fingerprints(
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

/// Keeps the existing plain-push argument vectors intact while fixing Git's
/// output language for stable rejection classification.
fn push_network(root: &Path, args: &[&str]) -> Result<String> {
    match run_git(root, args, &[("LANGUAGE", std::ffi::OsStr::new("C"))], None, NETWORK_TIMEOUT) {
        Ok(output) => Ok(String::from_utf8_lossy(&output).into_owned()),
        Err(error) => Err(classify_push_rejection(error)),
    }
}

struct ForcePushPlan {
    remote: String,
    remote_branch: String,
    local_branch: String,
    expected_oid: String,
}

fn validate_fetch_remote(root: &Path, remote: &str) -> Result<()> {
    if remote.is_empty() || remote.starts_with('-') || remote.contains(['\0', '\r', '\n'])
        || !git(root, &["remote"])?.lines().any(|configured| configured == remote)
    {
        return Err(anyhow!("invalid_remote"));
    }
    Ok(())
}

fn prepare_force_push(root: &Path, params: &serde_json::Map<String, Value>) -> Result<ForcePushPlan> {
    if params.get("force").and_then(Value::as_str) != Some("with-lease") || params.contains_key("setUpstream") {
        return Err(anyhow!("invalid_request"));
    }
    let expected = required_string(params, "expectedRemoteOid")?;
    if !full_oid(expected) {
        return Err(anyhow!("invalid_request"));
    }
    let remote = required_string(params, "remote")?;
    let remote_branch = required_string(params, "remoteBranch")?;
    let local_branch = required_string(params, "localBranch")?;
    let preview = crate::git_read::push_preview(root)
        .map_err(|_| anyhow!("push_destination_changed"))?;
    let current_branch = git(root, &["symbolic-ref", "--quiet", "HEAD"])
        .map_err(|_| anyhow!("push_destination_changed"))?;
    if preview["remote"].as_str() != Some(remote)
        || preview["remoteBranch"].as_str() != Some(remote_branch)
        || preview["localBranch"].as_str() != Some(local_branch)
        || current_branch.trim() != local_branch
    {
        return Err(anyhow!("push_destination_changed"));
    }
    let actual = preview.get("remoteOid").and_then(Value::as_str);
    if actual != Some(expected) {
        return Err(anyhow!("push_lease_stale"));
    }
    Ok(ForcePushPlan {
        remote: remote.to_owned(), remote_branch: remote_branch.to_owned(),
        local_branch: local_branch.to_owned(), expected_oid: expected.to_owned(),
    })
}

fn force_push_with_lease(root: &Path, plan: &ForcePushPlan) -> Result<String> {
    let lease = format!("--force-with-lease=refs/heads/{}:{}", plan.remote_branch, plan.expected_oid);
    let destination = format!("{}:refs/heads/{}", plan.local_branch, plan.remote_branch);
    let args = ["push", "--porcelain", &lease, "--force-if-includes", &plan.remote, &destination];
    match run_git(root, &args, &[("LANGUAGE", std::ffi::OsStr::new("C"))], None, NETWORK_TIMEOUT) {
        Ok(output) => Ok(String::from_utf8_lossy(&output).into_owned()),
        Err(error) => Err(classify_push_rejection(error)),
    }
}

fn full_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn classify_push_rejection(error: anyhow::Error) -> anyhow::Error {
    let text = if let Some(push) = error.downcast_ref::<crate::git_read::PushPorcelainFailure>() {
        format!("{}\n{}", push.stdout, push.stderr)
    } else {
        error.to_string()
    };
    let lower = text.to_ascii_lowercase();
    if lower.contains("stale info") { return anyhow!("push_lease_stale"); }
    if lower.contains("pre-receive hook declined") || lower.contains("protected branch") {
        let remote = text.lines().map(str::trim).find_map(|line| line.find("remote:").map(|index| line[index + "remote:".len()..].trim()))
            .unwrap_or("remote rejected");
        return anyhow!("push_rejected_hook: {remote}");
    }
    if lower.contains("non-fast-forward") || lower.contains("fetch first") { return anyhow!("push_rejected_non_ff"); }
    if lower.contains("authentication failed") || lower.contains("could not read username") || lower.contains("permission denied (publickey)") {
        return anyhow!("push_auth_failed");
    }
    if lower.contains("could not resolve host") || lower.contains("could not resolve hostname") || lower.contains("failed to connect") || lower.contains("unable to access") || lower.contains("no such host") {
        return anyhow!("push_remote_unreachable");
    }
    error
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
        // Under load the timeout can fire before the post-merge hook starts; the outcome is the same.
        assert_eq!(outbox_count(&db), events + 1); assert_eq!(last_event(&db), json!({"kind":"git","projectId":project,"worktreePath":null}));
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
    fn checkout_preflight_preserves_work_and_retries_rejected_operations() {
        let (temp, db, project) = setup();
        let root = temp.path();
        let original = git(root, &["branch", "--show-current"]).unwrap();
        let original = original.trim();
        fs::write(root.join("same.txt"), "same").unwrap();
        git(root, &["add", "same.txt"]).unwrap();
        git(root, &["commit", "-m", "shared file"]).unwrap();
        git(root, &["switch", "-c", "target"]).unwrap();
        fs::write(root.join("a.txt"), "target").unwrap();
        fs::write(root.join("new 文件.txt"), "target new").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-m", "target changes"]).unwrap();
        git(root, &["switch", original]).unwrap();
        let before = git(root, &["rev-parse", "HEAD"]).unwrap();
        for (index, state) in ["modified", "staged", "untracked"].iter().enumerate() {
            let path = if *state == "untracked" { "new 文件.txt" } else { "a.txt" };
            fs::write(root.join(path), "local").unwrap();
            if *state == "staged" { git(root, &["add", path]).unwrap(); }
            let operation = format!("reject-{index}");
            let request = json!({"projectId":project,"branch":"target","operationId":operation});
            for _ in 0..2 {
                let error = call(&db, "git.checkout", request.clone()).unwrap_err().to_string();
                assert_eq!(error, format!("checkout_would_overwrite: {}", json!([path])));
                assert_eq!(git(root, &["rev-parse", "HEAD"]).unwrap(), before);
                assert!(!db.external_operation_pending(&operation).unwrap());
            }
            if *state == "untracked" { fs::remove_file(root.join(path)).unwrap(); }
            else { git(root, &["restore", "--source=HEAD", "--staged", "--worktree", "--", path]).unwrap(); }
        }
        fs::write(root.join("same.txt"), "carry this edit").unwrap();
        let request = json!({"projectId":project,"branch":"target","operationId":"reject-0"});
        assert_eq!(call(&db, "git.checkout", request.clone()).unwrap()["branch"], "target");
        assert_eq!(fs::read_to_string(root.join("same.txt")).unwrap(), "carry this edit");
        // Replay remains first even if the newly dirty tree would fail a fresh request.
        git(root, &["switch", original]).unwrap();
        fs::write(root.join("a.txt"), "another edit on the old branch").unwrap();
        assert_eq!(call(&db, "git.checkout", request).unwrap()["branch"], "target");
        assert_eq!(git(root, &["branch", "--show-current"]).unwrap().trim(), original);
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"another edit on the old branch");
    }

    #[test]
    fn checkout_worktree_ownership_and_remote_tracking_are_preserved() {
        let (temp, db, project) = setup();
        let remote = tempfile::tempdir().unwrap();
        git(remote.path(), &["init", "--bare"]).unwrap();
        git(temp.path(), &["remote", "add", "origin", remote.path().to_str().unwrap()]).unwrap();
        git(temp.path(), &["push", "origin", "HEAD:remote-target"]).unwrap();
        let request = json!({"projectId":project,"branch":"origin/remote-target","operationId":"remote-switch"});
        assert_eq!(call(&db, "git.checkout", request).unwrap()["branch"], "remote-target");
        assert_eq!(git(temp.path(), &["rev-parse", "--abbrev-ref", "@{upstream}"]).unwrap().trim(), "origin/remote-target");
        let linked = tempfile::tempdir().unwrap();
        let path = linked.path().join("other worktree 新");
        git(temp.path(), &["worktree", "add", "-b", "occupied", path.to_str().unwrap()]).unwrap();
        let request = json!({"projectId":project,"branch":"occupied","operationId":"occupied-switch"});
        for _ in 0..2 {
            let error = call(&db, "git.checkout", request.clone()).unwrap_err().to_string();
            assert!(error.starts_with("branch_checked_out_elsewhere: "), "{error}");
            let detail: Value = serde_json::from_str(error.strip_prefix("branch_checked_out_elsewhere: ").unwrap()).unwrap();
            assert!(detail["path"].as_str().unwrap().ends_with("other worktree 新"));
            assert_eq!(detail["missing"], false);
            assert!(!db.external_operation_pending("occupied-switch").unwrap());
        }
        let branches = crate::git_read::dispatch(&db, "git.branches", &json!({"projectId":project})).unwrap().unwrap();
        let occupied = branches["branches"].as_array().unwrap().iter().find(|row| row["name"] == "occupied").unwrap();
        assert!(occupied["worktreePath"].as_str().unwrap().ends_with("other worktree 新"));
        let current = branches["branches"].as_array().unwrap().iter().find(|row| row["current"] == true).unwrap();
        assert!(current.get("worktreePath").is_none());
    }

    #[test]
    fn checkout_refusals_require_complete_known_blocks_and_no_other_output() {
        let headers = [
            ("error: Your local changes to the following files would be overwritten by checkout:", Some("Please commit your changes or stash them before you switch branches.")),
            ("error: The following untracked working tree files would be overwritten by checkout:", Some("Please move or remove them before you switch branches.")),
            ("error: The following untracked working tree files would be removed by checkout:", Some("Please move or remove them before you switch branches.")),
            ("error: Updating the following directories would lose untracked files in them:", None),
        ];
        let mut mixed = String::new();
        for (index, (header, trailer)) in headers.iter().enumerate() {
            let block = format!("{header}\r\n\tpath'{index}\r\n{}", trailer.map(|text| format!("{text}\r\n")).unwrap_or_default());
            assert_eq!(checkout_refusal_paths(&format!("\n{block}\nAborting\r\n")), Some(vec![format!("path'{index}")]));
            assert_eq!(checkout_refusal_paths(&format!("{header}\n\tpath'{index}\nAborting")), Some(vec![format!("path'{index}")]));
            assert_eq!(checkout_refusal_paths(&format!("{block}unknown hook output\nAborting")), None);
            assert_eq!(checkout_refusal_paths(&format!("fatal: refused\n{block}Aborting")), None);
            assert_eq!(checkout_refusal_paths(&format!("{block}Aborting\nwarning: extra")), None);
            assert_eq!(checkout_refusal_paths(&format!("{header}\nAborting")), None);
            mixed.push_str(&block);
        }
        let advice_free = format!("{}\n\ttracked.txt\n{}\n\tuntracked.txt\nAborting", headers[0].0, headers[1].0);
        assert_eq!(checkout_refusal_paths(&advice_free), Some(vec!["tracked.txt".into(), "untracked.txt".into()]));
        assert_eq!(checkout_refusal_paths(&advice_free.replace("Aborting", "unknown\nAborting")), None);
        assert_eq!(checkout_refusal_paths(&advice_free.replace("Aborting", "")), None);
        mixed.push_str("Aborting\n");
        assert_eq!(checkout_refusal_paths(&mixed), Some((0..4).map(|index| format!("path'{index}")).collect()));
        let mut capped = format!("{}\n", headers[1].0);
        for index in 0..60 { capped.push_str(&format!("\tnew{index}.txt\n\tnew{index}.txt\n")); }
        capped.push_str("Please move or remove them before you switch branches.\nAborting");
        assert_eq!(checkout_refusal_paths(&capped), Some((0..50).map(|index| format!("new{index}.txt")).collect()));
        assert_eq!(checkout_refusal_paths(&(capped + "\nfatal: after cap")), None);
        assert_eq!(checkout_refusal_paths("fatal: unknown"), None);
        assert_eq!(checkout_refusal_paths("\tstray path\nAborting"), None);
    }

    #[test]
    fn checkout_advice_free_refusals_release_the_claim_and_retry() {
        let (temp, db, project) = setup(); let root = temp.path();
        git(root, &["config", "advice.commitBeforeMerge", "false"]).unwrap();
        git(root, &["branch", "before"]).unwrap();
        fs::write(root.join("a.txt"), "target").unwrap(); fs::write(root.join("New"), "target untracked").unwrap();
        git(root, &["add", "a.txt", "New"]).unwrap(); git(root, &["commit", "-m", "target"]).unwrap();
        git(root, &["branch", "target"]).unwrap(); git(root, &["switch", "before"]).unwrap();
        fs::write(root.join("a.txt"), "local tracked").unwrap(); fs::write(root.join("New"), "local untracked").unwrap();
        let head = checkout_head(root).unwrap(); let index = fs::read(root.join(".git/index")).unwrap();
        let native = run_git(root, &["switch", "target"], &[("LANGUAGE", std::ffi::OsStr::new("C"))], None, HOOK_TIMEOUT).unwrap_err().to_string();
        assert!(!native.contains("Please commit") && !native.contains("Please move"), "{native}");
        assert!(native.contains("Your local changes") && native.contains("untracked working tree files"), "{native}");
        let request = json!({"projectId":project,"branch":"target","operationId":"advice-free-switch"});
        for _ in 0..2 {
            assert_eq!(call(&db,"git.checkout",request.clone()).unwrap_err().to_string(), format!("checkout_would_overwrite: {}",json!(["a.txt", "New"])));
            assert!(!db.external_operation_pending("advice-free-switch").unwrap());
            assert_eq!(checkout_head(root).unwrap(), head); assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
            assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"local tracked"); assert_eq!(fs::read(root.join("New")).unwrap(), b"local untracked");
            assert!(!root.join(".git/index.lock").exists());
        }
        git(root, &["restore", "--worktree", "--", "a.txt"]).unwrap(); fs::remove_file(root.join("New")).unwrap();
        assert_eq!(call(&db,"git.checkout",request).unwrap()["branch"], "target");
    }

    #[test]
    fn checkout_release_requires_known_unchanged_head_and_absent_new_refs() {
        let a = CheckoutHead { reference:Some("refs/heads/main".into()), oid:"a".repeat(40) };
        let other_ref = CheckoutHead { reference:Some("refs/heads/other".into()), oid:a.oid.clone() };
        let other_oid = CheckoutHead { reference:a.reference.clone(), oid:"b".repeat(40) };
        let detached = CheckoutHead { reference:None, oid:a.oid.clone() };
        assert!(checkout_can_release(Some(&a), Some(&a), true, true));
        assert!(checkout_can_release(Some(&detached), Some(&detached), true, true));
        for other in [&other_ref, &other_oid, &detached] { assert!(!checkout_can_release(Some(&a), Some(other), true, true)); }
        assert!(!checkout_can_release(None, None, true, true));
        assert!(!checkout_can_release(Some(&a), None, true, true));
        assert!(!checkout_can_release(Some(&a), Some(&a), false, true));
        assert!(!checkout_can_release(Some(&a), Some(&a), true, false));
        let (_temp, db, project) = setup();
        assert!(db.claim_external_operation("completed-during-release").unwrap());
        let receipt = json!({"branch":"original"});
        db.transaction(|tx| complete(tx,"completed-during-release","git.checkout",&receipt,Some((&project,None)))).unwrap();
        release_discard_claim(&db, "completed-during-release").unwrap();
        assert_eq!(db.operation("completed-during-release").unwrap(), Some(receipt));
    }

    #[test]
    fn checkout_reports_all_real_obstructions_and_releases_only_the_safe_claim() {
        let (temp, db, project) = setup();
        let root = temp.path();
        fs::write(root.join("staged.txt"), "base").unwrap();
        git(root, &["add", "staged.txt"]).unwrap();
        git(root, &["commit", "-m", "base staged path"]).unwrap();
        git(root, &["branch", "before"]).unwrap();
        for path in ["a.txt", "staged.txt", "New", "obstruction", "quote's.txt", "Case.txt"] { fs::write(root.join(path), "target").unwrap(); }
        git(root, &["add", "."]).unwrap(); git(root, &["commit", "-m", "target files"]).unwrap();
        git(root, &["branch", "target"]).unwrap(); git(root, &["switch", "before"]).unwrap();
        fs::write(root.join("a.txt"), "local tracked").unwrap();
        fs::write(root.join("staged.txt"), "local staged").unwrap(); git(root, &["add", "staged.txt"]).unwrap();
        fs::write(root.join("New"), "local untracked").unwrap();
        fs::write(root.join("quote's.txt"), "local quote").unwrap();
        fs::create_dir(root.join("obstruction")).unwrap(); fs::write(root.join("obstruction/local.txt"), "local directory file").unwrap();
        fs::write(root.join("case-probe"), "probe").unwrap();
        let insensitive = root.join("CASE-PROBE").exists(); fs::remove_file(root.join("case-probe")).unwrap();
        if insensitive { fs::write(root.join("case.txt"), "local case").unwrap(); }
        else { eprintln!("case-only collision skipped on case-sensitive filesystem"); }
        let snapshot_paths = ["a.txt", "staged.txt", "New", "obstruction/local.txt", "quote's.txt", "case.txt"];
        let snapshot: Vec<_> = snapshot_paths.iter().map(|path| fs::read(root.join(path)).ok()).collect();
        let index = fs::read(root.join(".git/index")).unwrap(); let head = checkout_head(root).unwrap();
        let request = json!({"projectId":project,"branch":"target","operationId":"all-obstructions"});
        let mut expected = vec!["a.txt", "staged.txt", "New", "obstruction", "quote's.txt"];
        if insensitive { expected.push("Case.txt"); } expected.sort();
        for _ in 0..2 {
            let failure = call(&db,"git.checkout",request.clone()).unwrap_err().to_string();
            let mut paths: Vec<String> = serde_json::from_str(failure.strip_prefix("checkout_would_overwrite: ").expect(&failure)).unwrap();
            paths.sort(); assert_eq!(paths, expected);
            assert_eq!(checkout_head(root).unwrap(), head); assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
            assert_eq!(snapshot_paths.iter().map(|path| fs::read(root.join(path)).ok()).collect::<Vec<_>>(), snapshot);
            assert!(!root.join(".git/index.lock").exists()); assert!(!db.external_operation_pending("all-obstructions").unwrap());
        }
        git(root, &["restore", "--source=HEAD", "--staged", "--worktree", "--", "a.txt", "staged.txt"]).unwrap();
        for path in ["New", "quote's.txt", "obstruction/local.txt"] { fs::remove_file(root.join(path)).unwrap(); }
        fs::remove_dir(root.join("obstruction")).unwrap(); if insensitive { fs::remove_file(root.join("case.txt")).unwrap(); }
        assert_eq!(call(&db,"git.checkout",request).unwrap()["branch"], "target");
    }

    #[test]
    fn checkout_create_and_track_refusals_release_only_absent_new_branches() {
        for create in [false, true] {
            let (temp, db, project) = setup(); let root = temp.path();
            let remote = tempfile::tempdir().unwrap();
            git(remote.path(), &["init", "--bare"]).unwrap();
            git(root, &["remote", "add", "origin", remote.path().to_str().unwrap()]).unwrap();
            git(root, &["branch", "before"]).unwrap(); fs::write(root.join("a.txt"), "target").unwrap(); git(root, &["commit", "-am", "target"]).unwrap();
            git(root, &["branch", "target"]).unwrap(); git(root, &["push", "origin", "HEAD:tracked"]).unwrap(); git(root, &["switch", "before"]).unwrap();
            if !create { git(root, &["switch", "--detach", "before"]).unwrap(); assert!(checkout_head(root).unwrap().reference.is_none()); }
            fs::write(root.join("a.txt"), "local").unwrap();
            let request = if create { json!({"projectId":project,"branch":"created","create":true,"startPoint":"target","operationId":"new-ref-refusal"}) }
                else { json!({"projectId":project,"branch":"origin/tracked","operationId":"new-ref-refusal"}) };
            let name = if create { "created" } else { "tracked" }; let reference = format!("refs/heads/{name}");
            let before = checkout_head(root).unwrap(); let index = fs::read(root.join(".git/index")).unwrap();
            for _ in 0..2 {
                assert_eq!(call(&db,"git.checkout",request.clone()).unwrap_err().to_string(), format!("checkout_would_overwrite: {}",json!(["a.txt"])));
                assert!(!db.external_operation_pending("new-ref-refusal").unwrap());
                assert_eq!(checkout_optional_ref(root,&reference).unwrap(),None);
                assert_eq!(checkout_head(root).unwrap(),before); assert_eq!(fs::read(root.join(".git/index")).unwrap(),index);
                assert_eq!(fs::read(root.join("a.txt")).unwrap(),b"local"); assert!(!root.join(".git/index.lock").exists());
            }
            git(root,&["restore","--worktree","--","a.txt"]).unwrap();
            assert_eq!(call(&db,"git.checkout",request).unwrap()["branch"],name);
            assert!(checkout_optional_ref(root,&reference).unwrap().is_some());
        }
    }

    #[test]
    fn checkout_refreshes_timestamp_only_changes_and_keeps_hook_failures_uncertain() {
        let (temp, db, project) = setup(); let root = temp.path();
        git(root, &["branch", "before"]).unwrap(); fs::write(root.join("a.txt"), "target").unwrap();
        git(root, &["commit", "-am", "target"]).unwrap(); git(root, &["branch", "target"]).unwrap(); git(root, &["switch", "before"]).unwrap();
        let file = fs::OpenOptions::new().write(true).open(root.join("a.txt")).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(std::time::SystemTime::now()+Duration::from_secs(10))).unwrap(); drop(file);
        assert_eq!(call(&db,"git.checkout",json!({"projectId":project,"branch":"target","operationId":"timestamp-only"})).unwrap()["branch"], "target");
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"target");
        let hook = root.join(".git/hooks/post-checkout");
        fs::write(&hook, "#!/bin/sh\nprintf '%s|%s' \"$LANGUAGE\" \"${LC_ALL-}\" > .git/checkout-hook-env\necho 'fatal: post-checkout hook failed' >&2\nexit 1\n").unwrap();
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap(); }
        let request = json!({"projectId":project,"branch":"hook-created","create":true,"operationId":"hook-uncertain"});
        let error = call(&db,"git.checkout",request.clone()).unwrap_err().to_string(); assert!(error.starts_with("git_failed:"), "{error}");
        assert!(db.external_operation_pending("hook-uncertain").unwrap());
        assert!(checkout_optional_ref(root,"refs/heads/hook-created").unwrap().is_some());
        assert_eq!(fs::read_to_string(root.join(".git/checkout-hook-env")).unwrap(), format!("C|{}",std::env::var("LC_ALL").unwrap_or_default()));
        assert_eq!(call(&db,"git.checkout",request).unwrap_err().to_string(), "operation_outcome_unknown");
    }

    #[test]
    fn checkout_honors_all_native_ignore_sources() {
        for source in ["gitignore", "info-exclude", "global-exclude"] {
            let (temp, db, project) = setup(); let root = temp.path();
            match source {
                "gitignore" => { fs::write(root.join(".gitignore"), "dist/\n").unwrap(); git(root,&["add",".gitignore"]).unwrap(); git(root,&["commit","-m","ignore output"]).unwrap(); }
                "info-exclude" => { use std::io::Write; let mut file = fs::OpenOptions::new().append(true).open(root.join(".git/info/exclude")).unwrap(); writeln!(file,"dist/").unwrap(); }
                "global-exclude" => { let path=root.join(".git/global-ignore"); fs::write(&path,"dist/\n").unwrap(); git(root,&["config","core.excludesFile",path.to_str().unwrap()]).unwrap(); }
                _ => unreachable!(),
            }
            git(root,&["branch","before"]).unwrap(); fs::create_dir(root.join("dist")).unwrap(); fs::write(root.join("dist/output.js"),"tracked target").unwrap();
            git(root,&["add","-f","dist/output.js"]).unwrap(); git(root,&["commit","-m","target output"]).unwrap(); git(root,&["branch","target"]).unwrap(); git(root,&["switch","before"]).unwrap();
            fs::create_dir_all(root.join("dist")).unwrap(); fs::write(root.join("dist/output.js"),"ignored local").unwrap();
            git(root,&["switch","target"]).unwrap(); assert_eq!(fs::read(root.join("dist/output.js")).unwrap(),b"tracked target"); git(root,&["switch","before"]).unwrap();
            fs::create_dir_all(root.join("dist")).unwrap(); fs::write(root.join("dist/output.js"),"ignored local").unwrap();
            assert_eq!(call(&db,"git.checkout",json!({"projectId":project,"branch":"target","operationId":"ignored-switch"})).unwrap()["branch"],"target", "{source}");
            assert_eq!(fs::read(root.join("dist/output.js")).unwrap(),b"tracked target");
        }
    }

    #[test]
    fn checkout_nested_missing_worktrees_and_unborn_creation() {
        let (temp, db, project) = setup();
        let root = temp.path();
        let nested = root.join("nested-linked");
        git(root, &["worktree", "add", "-b", "nested-owner", nested.to_str().unwrap()]).unwrap();
        checkout_preflight(&nested, json!({"branch":"nested-owner"}).as_object().unwrap()).unwrap();
        // The main folder is an ancestor, but a distinct worktree identity.
        let original = git(root, &["branch", "--show-current"]).unwrap();
        let error = checkout_preflight(&nested, json!({"branch":original.trim()}).as_object().unwrap()).unwrap_err().to_string();
        assert!(error.starts_with("branch_checked_out_elsewhere:"), "{error}");
        let request = json!({"projectId":project,"branch":"nested-owner","operationId":"nested-switch"});
        assert!(call(&db, "git.checkout", request.clone()).unwrap_err().to_string().contains("branch_checked_out_elsewhere:"));
        assert!(!db.external_operation_pending("nested-switch").unwrap());
        fs::remove_dir_all(&nested).unwrap();
        for _ in 0..2 {
            let error = call(&db, "git.checkout", request.clone()).unwrap_err().to_string();
            let detail: Value = serde_json::from_str(error.strip_prefix("branch_checked_out_elsewhere: ").unwrap()).unwrap();
            assert_eq!(detail["missing"], true);
            assert!(detail["path"].as_str().unwrap().ends_with("nested-linked"));
            assert!(!db.external_operation_pending("nested-switch").unwrap());
        }
        let rows = crate::git_read::dispatch(&db, "git.branches", &json!({"projectId":project})).unwrap().unwrap();
        assert_eq!(rows["branches"].as_array().unwrap().iter().find(|row| row["name"] == "nested-owner").unwrap()["worktreeMissing"], true);
        git(root, &["worktree", "prune"]).unwrap();
        call(&db, "git.checkout", request).unwrap();

        let unborn = tempfile::tempdir().unwrap();
        git(unborn.path(), &["init"]).unwrap();
        let unborn_db = Database::open(&unborn.path().join("runtime.sqlite")).unwrap();
        initialize(&unborn_db).unwrap();
        let project = unborn_db.add_project(unborn.path().to_str().unwrap(), Some("unborn"), "unborn-add").unwrap();
        fs::write(unborn.path().join("local.txt"), "keep").unwrap();
        let result = call(&unborn_db, "git.checkout", json!({"projectId":project.id,"branch":"new-unborn","create":true,"operationId":"unborn-create"})).unwrap();
        assert_eq!(result["branch"], "new-unborn");
        assert_eq!(fs::read(unborn.path().join("local.txt")).unwrap(), b"keep");
        assert!(!unborn.path().join(".git/index.lock").exists());
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
    #[test]
    fn stash_oid_mutations_replay_and_indices_shift() {
        let (temp, db, project) = setup(); let root = temp.path();
        let push = json!({"projectId":project,"message":"first\nmessage","includeUntracked":true,"operationId":"stash-first"});
        assert_eq!(call(&db,"git.stash.push",push.clone()).unwrap_err().to_string(),"nothing_to_stash");
        assert!(!db.external_operation_pending("stash-first").unwrap());
        fs::write(root.join("a.txt"), "local").unwrap();
        fs::write(root.join("new.txt"), "untracked").unwrap();
        let first = call(&db,"git.stash.push",push.clone()).unwrap();
        let oid = first["oid"].as_str().unwrap();
        assert_eq!(call(&db,"git.stash.push",push).unwrap(),first);
        assert!(!root.join("new.txt").exists());
        let list = crate::git_read::dispatch(&db,"git.stash.list",&json!({"projectId":project})).unwrap().unwrap();
        assert_eq!(list["entries"][0]["oid"],oid); assert_eq!(list["entries"][0]["untracked"],true);
        assert!(list["entries"][0]["message"].as_str().unwrap().contains("firstmessage"));
        let shown = crate::git_read::dispatch(&db,"git.stash.show",&json!({"projectId":project,"oid":oid})).unwrap().unwrap();
        assert!(shown["files"].as_array().unwrap().iter().any(|file|file["path"]=="new.txt" && file["untracked"]==true));
        fs::write(root.join("a.txt"),"second").unwrap();
        let second = call(&db,"git.stash.push",json!({"projectId":project,"includeUntracked":false,"operationId":"stash-second"})).unwrap();
        assert_eq!(crate::git_read::stash_resolve(root,oid).unwrap(),1);
        let apply = json!({"projectId":project,"oid":oid,"pop":false,"operationId":"stash-apply"});
        assert_eq!(call(&db,"git.stash.apply",apply.clone()).unwrap()["applied"],true);
        assert_eq!(call(&db,"git.stash.apply",apply).unwrap()["applied"],true);
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(),"local");
        let drop = json!({"projectId":project,"oid":oid,"operationId":"stash-drop"});
        let dropped = call(&db,"git.stash.drop",drop.clone()).unwrap();
        assert_eq!(call(&db,"git.stash.drop",drop).unwrap(),dropped);
        assert_eq!(crate::git_read::stash_resolve(root,second["oid"].as_str().unwrap()).unwrap(),0);
        let missing = json!({"projectId":project,"oid":oid,"pop":true,"operationId":"stash-missing"});
        assert_eq!(call(&db,"git.stash.apply",missing).unwrap_err().to_string(),"stash_not_found");
        assert!(!db.external_operation_pending("stash-missing").unwrap());
        git(root,&["restore","a.txt"]).unwrap(); fs::remove_file(root.join("new.txt")).unwrap();
        let pop = json!({"projectId":project,"oid":second["oid"],"pop":true,"operationId":"stash-pop"});
        assert_eq!(call(&db,"git.stash.apply",pop.clone()).unwrap()["dropped"],true);
        assert_eq!(call(&db,"git.stash.apply",pop).unwrap()["dropped"],true);
    }

    #[test]
    fn stash_pop_conflicts_keeps_oid_and_receipt() {
        let (temp,db,project)=setup(); let root=temp.path();
        fs::write(root.join("a.txt"),"local").unwrap();
        let saved=call(&db,"git.stash.push",json!({"projectId":project,"includeUntracked":false,"operationId":"save"})).unwrap();
        fs::write(root.join("a.txt"),"other").unwrap();git(root,&["add","a.txt"]).unwrap();git(root,&["commit","-m","other"]).unwrap();
        let request=json!({"projectId":project,"oid":saved["oid"],"pop":true,"operationId":"pop"});
        let result=call(&db,"git.stash.apply",request.clone()).unwrap();
        assert_eq!(result["conflicted"],true);assert_eq!(result["dropped"],false);
        assert_eq!(call(&db,"git.stash.apply",request).unwrap(),result);
        assert_eq!(crate::git_read::stash_resolve(root,saved["oid"].as_str().unwrap()).unwrap(),0);
    }

    #[test]
    fn stash_smart_switch_clean_conflict_and_untracked_obstruction() {
        for mode in ["clean","conflict","untracked"] {
            let (temp,db,project)=setup();let root=temp.path();
            let original=git(root,&["branch","--show-current"]).unwrap();
            git(root,&["switch","-c","target"]).unwrap();
            if mode=="conflict" {fs::write(root.join("a.txt"),"target").unwrap();git(root,&["add","a.txt"]).unwrap();git(root,&["commit","-m","target"]).unwrap();}
            if mode=="untracked" {fs::write(root.join("collision"),"target tracked").unwrap();git(root,&["add","collision"]).unwrap();git(root,&["commit","-m","target"]).unwrap();}
            git(root,&["switch",original.trim()]).unwrap();
            fs::write(root.join("a.txt"),"local").unwrap();
            fs::write(root.join("free"),"free local").unwrap();
            if mode=="untracked" {fs::write(root.join("collision"),"untracked local").unwrap();}
            let request=json!({"projectId":project,"branch":"target","stash":true,"operationId":"smart"});
            let result=call(&db,"git.checkout",request.clone()).unwrap();
            assert_eq!(result["branch"],"target");assert_eq!(call(&db,"git.checkout",request).unwrap(),result);
            assert_eq!(fs::read_to_string(root.join("free")).unwrap(),"free local");
            match mode {
                "clean" => {assert_eq!(result["stash"]["dropped"],true);assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(),"local");}
                "conflict" => {assert_eq!(result["stash"]["conflicted"],true);assert_eq!(result["stash"]["dropped"],false);}
                _ => {
                    assert_eq!(result["stash"]["applied"],false);assert_eq!(result["stash"]["dropped"],false);
                    // Git 2.33 restores untracked files before the tracked merge, and can restore some before failing.
                    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(),"base");
                    assert_eq!(fs::read_to_string(root.join("collision")).unwrap(),"target tracked");
                }
            }
        }
    }

    #[test]
    fn stash_smart_switch_failure_restores_and_hook_failure_warns() {
        // Create-existing-branch fails after the stash push without moving HEAD.
        let (temp,db,project)=setup();let root=temp.path();
        git(root,&["branch","target"]).unwrap();
        fs::write(root.join("a.txt"),"local").unwrap();fs::write(root.join("new.txt"),"new").unwrap();
        let request=json!({"projectId":project,"branch":"target","create":true,"stash":true,"operationId":"fail"});
        let error=call(&db,"git.checkout",request.clone()).unwrap_err().to_string();
        let receipt:Value=serde_json::from_str(error.strip_prefix("stash_switch_failed: ").unwrap()).unwrap();
        assert_eq!(receipt["stash"]["restored"],true);assert_eq!(receipt["stash"]["dropped"],true);
        assert_eq!(call(&db,"git.checkout",request).unwrap_err().to_string(),error);
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(),"local");assert_eq!(fs::read_to_string(root.join("new.txt")).unwrap(),"new");
        fs::write(root.join(".git/hooks/post-checkout"),"#!/bin/sh\necho hook-failed >&2\nexit 1\n").unwrap();
        #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;fs::set_permissions(root.join(".git/hooks/post-checkout"),fs::Permissions::from_mode(0o755)).unwrap();}
        let result=call(&db,"git.checkout",json!({"projectId":project,"branch":"target","stash":true,"operationId":"hook"})).unwrap();
        assert_eq!(result["branch"],"target");assert_eq!(result["stash"]["dropped"],true);assert!(result["warning"].as_str().unwrap().contains("hook-failed"));
    }

    #[test]
    fn stash_message_is_bounded_and_claims_are_never_reexecuted() {
        let (temp,db,project)=setup();
        let request=json!({"projectId":project,"message":"x".repeat(300)+"\n\0", "includeUntracked":true,"operationId":"pending"});
        assert_eq!(stash_message(request.as_object().unwrap()).unwrap().chars().count(),200);
        db.bind_operation("pending","git.stash.push",&request).unwrap();assert!(db.claim_external_operation("pending").unwrap());
        fs::write(temp.path().join("a.txt"),"local").unwrap();
        assert_eq!(call(&db,"git.stash.push",request).unwrap_err().to_string(),"operation_outcome_unknown");
        assert_eq!(fs::read_to_string(temp.path().join("a.txt")).unwrap(),"local");
    }

    #[test]
    fn stash_publication_failure_preserves_recovery_oid() {
        let (_temp,db,project)=setup();
        db.transaction(|tx| { tx.execute_batch("CREATE TRIGGER reject_stash_event BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'publication unavailable'); END;")?; Ok(()) }).unwrap();
        let error=stash_publish_failure::<()>(&db,(&project,None),Err(anyhow!("stash_operation_failed: {}",json!({"oid":"abc","error":"apply failed"})))).unwrap_err().to_string();
        let detail:Value=serde_json::from_str(error.strip_prefix("stash_operation_failed: ").unwrap()).unwrap();
        assert_eq!(detail["oid"],"abc"); assert_eq!(detail["error"],"apply failed");assert!(detail["publicationError"].as_str().unwrap().contains("publication unavailable"));
    }

    #[test]
    fn stash_smart_switch_no_changes_preserves_post_checkout_warning() {
        let (temp,db,project)=setup();let root=temp.path();git(root,&["branch","target"]).unwrap();
        fs::write(root.join(".git/hooks/post-checkout"),"#!/bin/sh\necho hook-failed >&2\nexit 1\n").unwrap();
        #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;fs::set_permissions(root.join(".git/hooks/post-checkout"),fs::Permissions::from_mode(0o755)).unwrap();}
        let request=json!({"projectId":project,"branch":"target","stash":true,"operationId":"empty-hook"});
        let result=call(&db,"git.checkout",request.clone()).unwrap();
        assert_eq!(result["branch"],"target");assert!(result["warning"].as_str().unwrap().contains("hook-failed"));
        assert!(result.get("stash").is_none());assert_eq!(call(&db,"git.checkout",request).unwrap(),result);
    }

    #[test]
    fn stash_drop_reports_unknown_window_entry_loss_without_retrying() {
        let (temp,db,project)=setup(); let root=temp.path();
        fs::write(root.join("a.txt"),"ours").unwrap();
        let ours=stash_push(root,"ours",false).unwrap().unwrap().oid;
        let attempts=std::rc::Rc::new(std::cell::Cell::new(0)); let captured=attempts.clone();
        let _hooks=stash_test_hooks::install(Some(Box::new(move |root| {
            captured.set(captured.get()+1);
            fs::write(root.join("a.txt"),"foreign contents")?;
            git(root,&["stash","push","-m","foreign message"])?; Ok(())
        })),None,false,false);
        let request=json!({"projectId":project,"oid":ours,"operationId":"drop-race"});
        let error=call(&db,"git.stash.drop",request.clone()).unwrap_err().to_string();
        let detail:Value=serde_json::from_str(error.strip_prefix("stash_drop_interfered: ").unwrap()).unwrap();
        assert_eq!(detail["oid"],ours); assert_eq!(detail["ourEntryDropped"],false);
        assert_eq!(detail["unknownEntryLost"],true); assert_eq!(detail["restored"],json!([]));
        assert_eq!(detail["restoreFailed"],json!([])); assert_eq!(detail["orderChanged"],false);
        assert_eq!(call(&db,"git.stash.drop",request).unwrap_err().to_string(),error);
        assert_eq!(attempts.get(),1); assert_eq!(stash_stack(root).unwrap().len(),1);
        assert_eq!(stash_stack(root).unwrap()[0].0,ours);
        assert_eq!(git(root,&["show",&format!("{ours}:a.txt")]).unwrap(),"ours");
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(),"base");
    }

    #[test]
    fn stash_drop_restores_missing_foreign_entry_with_exact_reflog_label() {
        let (temp,db,project)=setup();let root=temp.path();fs::write(root.join("a.txt"),"ours").unwrap();
        let ours=stash_push(root,"ours",false).unwrap().unwrap().oid;
        fs::write(root.join("a.txt"),"foreign C contents").unwrap();
        let foreign=stash_push(root,"commit subject differs",false).unwrap().unwrap().oid;
        git(root,&["stash","drop","stash@{0}"]).unwrap();
        git(root,&["stash","store","-m","custom label",&foreign]).unwrap();
        assert_eq!(stash_stack(root).unwrap()[0],(foreign.clone(),"custom label".into()));
        let _hooks=stash_test_hooks::install(Some(Box::new(|root| {
            fs::write(root.join("a.txt"),"new E contents")?;
            git(root,&["stash","push","-m","new E"])?; Ok(())
        })),None,false,false);
        let error=call(&db,"git.stash.drop",json!({"projectId":project,"oid":ours,"operationId":"drop-C"})).unwrap_err().to_string();
        let detail:Value=serde_json::from_str(error.strip_prefix("stash_drop_interfered: ").unwrap()).unwrap();
        assert_eq!(detail["oid"],ours);assert_eq!(detail["ourEntryDropped"],false);assert_eq!(detail["orderChanged"],true);
        assert_eq!(detail["restored"],json!([{"oid":foreign,"message":"custom label"}]));assert_eq!(detail["restoreFailed"],json!([]));
        assert_ne!(detail["unknownEntryLost"],true);
        let stack=stash_stack(root).unwrap();assert_eq!(stack.len(),3);assert_eq!(stack[0],(foreign.clone(),"custom label".into()));
        assert!(stack.iter().any(|(oid,_)|oid==&ours));
        assert_eq!(git(root,&["show",&format!("{foreign}:a.txt")]).unwrap(),"foreign C contents");
    }

    #[test]
    fn stash_drop_allows_a_new_foreign_push_after_our_drop() {
        let (temp,db,project)=setup();let root=temp.path();fs::write(root.join("a.txt"),"ours").unwrap();
        let ours=stash_push(root,"ours",false).unwrap().unwrap().oid;
        let _race=stash_test_hooks::install_after_drop(Box::new(|root| {
            fs::write(root.join("a.txt"),"foreign E contents")?;
            git(root,&["stash","push","-m","new E"])?; Ok(())
        }));
        assert_eq!(call(&db,"git.stash.drop",json!({"projectId":project,"oid":ours,"operationId":"clean-drop"})).unwrap()["dropped"],true);
        let stack=stash_stack(root).unwrap();assert_eq!(stack.len(),1);assert_ne!(stack[0].0,ours);
        assert_eq!(git(root,&["show",&format!("{}:a.txt",stack[0].0)]).unwrap(),"foreign E contents");
    }

    #[test]
    fn stash_drop_reports_failed_foreign_restore_and_target_deletion() {
        let (temp,db,project)=setup();let root=temp.path();
        fs::write(root.join("a.txt"),"foreign contents").unwrap();
        let foreign=stash_push(root,"foreign",false).unwrap().unwrap().oid;
        fs::write(root.join("a.txt"),"ours").unwrap();
        let ours=stash_push(root,"ours",false).unwrap().unwrap().oid;
        let _race=stash_test_hooks::install_after_drop(Box::new(|root| {
            git(root,&["stash","drop","stash@{0}"])?;
            // Fixture-owned ref lock makes repair fail; TempDir removes it even
            // on assertion failure, without changing the process environment.
            fs::write(root.join(".git/refs/stash.lock"),"fixture lock")?; Ok(())
        }));
        let error=call(&db,"git.stash.drop",json!({"projectId":project,"oid":ours,"operationId":"failed-repair"})).unwrap_err().to_string();
        let detail:Value=serde_json::from_str(error.strip_prefix("stash_drop_interfered: ").unwrap()).unwrap();
        assert_eq!(detail["ourEntryDropped"],true);assert_eq!(detail["restored"],json!([]));assert_eq!(detail["orderChanged"],true);
        let failed=detail["restoreFailed"].as_array().unwrap();assert_eq!(failed.len(),1);assert_eq!(failed[0]["oid"],foreign);
        assert!(failed[0]["message"].as_str().unwrap().ends_with("foreign"));
        assert!(failed[0]["error"].as_str().unwrap().contains("lock"));assert_ne!(detail["unknownEntryLost"],true);
        assert!(stash_stack(root).unwrap().is_empty());
    }

    #[test]
    fn stash_pop_and_switch_interference_preserve_the_known_apply_outcome() {
        for smart in [false,true] {
            let (temp,db,project)=setup();let root=temp.path();git(root,&["branch","target"]).unwrap();
            fs::write(root.join("a.txt"),"our applied contents").unwrap();
            let saved=if smart {None} else {Some(stash_push(root,"ours",false).unwrap().unwrap().oid)};
            let _hooks=stash_test_hooks::install(Some(Box::new(|root| {
                // Do not disturb the already applied tracked content.
                fs::write(root.join("foreign.txt"),"foreign window contents")?;
                git(root,&["add","foreign.txt"])?;
                git(root,&["stash","push","-m","foreign","--","foreign.txt"])?; Ok(())
            })),None,false,false);
            let (method,request)=if smart {("git.checkout",json!({"projectId":project,"branch":"target","stash":true,"operationId":"interfered-switch"}))}
                else {("git.stash.apply",json!({"projectId":project,"oid":saved,"pop":true,"operationId":"interfered-pop"}))};
            let result=call(&db,method,request.clone()).unwrap();let outcome=if smart {&result["stash"]} else {&result};
            assert_eq!(outcome["applied"],true);assert_eq!(outcome["dropped"],false);
            assert_eq!(outcome["interference"]["oid"],outcome["oid"]);assert_eq!(outcome["interference"]["unknownEntryLost"],true);
            assert_eq!(outcome["interference"]["ourEntryDropped"],false);
            assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(),"our applied contents");
            assert_eq!(call(&db,method,request).unwrap(),result);
        }
    }

    #[test]
    fn stash_push_matches_git_reflog_whitespace_normalization() {
        for message in ["two  spaces","  leading","trailing  ","two\tspaces"," \t repeated  spaces \t "] {
            let (temp,_db,_project)=setup();let root=temp.path();
            fs::write(root.join("a.txt"),"our saved contents").unwrap();
            let oid=stash_push(root,message,false).unwrap().unwrap().oid;
            let branch=git(root,&["branch","--show-current"]).unwrap();
            let expected=format!("On {}: {message}",branch.trim()).split_ascii_whitespace().collect::<Vec<_>>().join(" ");
            assert_eq!(stash_push_snapshot(root).unwrap(),vec![(oid,expected)]);
        }
    }

    #[test]
    fn identical_stash_oids_still_create_entries_and_smart_switch_restores() {
        let (temp,db,project)=setup();let root=temp.path();git(root,&["branch","target"]).unwrap();
        let _hooks=stash_test_hooks::install(None,None,true,false);
        fs::write(root.join("a.txt"),"identical local content").unwrap();
        let first=call(&db,"git.stash.push",json!({"projectId":project,"message":"identical","includeUntracked":true,"operationId":"first-identical"})).unwrap();
        git(root,&["stash","apply",first["oid"].as_str().unwrap()]).unwrap();
        let error=call(&db,"git.stash.push",json!({"projectId":project,"message":"identical","includeUntracked":true,"operationId":"second-identical"})).unwrap_err().to_string();
        let detail:Value=serde_json::from_str(error.strip_prefix("stash_operation_failed: ").unwrap()).unwrap();
        assert_eq!(detail["candidateOids"],json!([]));assert!(detail["retainedOids"].as_array().unwrap().contains(&first["oid"]));
        assert_eq!(stash_stack(root).unwrap().len(),1);
        git(root,&["stash","apply",first["oid"].as_str().unwrap()]).unwrap();
        let result=call(&db,"git.checkout",json!({"projectId":project,"branch":"target","stash":true,"operationId":"smart-identical"})).unwrap();
        assert_ne!(result["stash"]["oid"],first["oid"]);assert_eq!(result["stash"]["applied"],true);assert_eq!(result["stash"]["dropped"],true);
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(),"identical local content");assert_eq!(stash_stack(root).unwrap().len(),1);
    }

    #[test]
    fn stash_cleanup_errors_retain_known_apply_outcome_for_pop_and_switch() {
        for smart in [false,true] {
            let (temp,db,project)=setup();let root=temp.path();git(root,&["branch","target"]).unwrap();
            fs::write(root.join("a.txt"),"local content").unwrap();
            let saved=if smart {None} else {Some(call(&db,"git.stash.push",json!({"projectId":project,"includeUntracked":false,"operationId":"save-cleanup"})).unwrap())};
            let dropped=std::rc::Rc::new(std::cell::RefCell::new(None));let captured=dropped.clone();
            let _hooks=stash_test_hooks::install(None,Some(Box::new(move |root| {
                *captured.borrow_mut()=Some(git(root,&["rev-parse","refs/stash"])?.trim().to_owned());
                git(root,&["stash","drop","stash@{0}"])?;Ok(())
            })),false,false);
            let result=if smart {call(&db,"git.checkout",json!({"projectId":project,"branch":"target","stash":true,"operationId":"switch-cleanup"}))}
                else {call(&db,"git.stash.apply",json!({"projectId":project,"oid":saved.as_ref().unwrap()["oid"],"pop":true,"operationId":"pop-cleanup"}))};
            let error=result.unwrap_err().to_string();let detail:Value=serde_json::from_str(error.strip_prefix("stash_operation_failed: ").unwrap()).unwrap();
            assert_eq!(detail["oid"],dropped.borrow().as_ref().unwrap().as_str());assert_eq!(detail["applied"],true);assert!(detail["dropped"].is_null()||detail["dropped"]==false);
            assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(),"local content");
        }
    }

    #[test]
    fn stash_push_attributes_our_entry_below_a_concurrent_foreign_push() {
        for mode in ["message","default","smart"] {
            let (temp,db,project)=setup();let root=temp.path();git(root,&["branch","target"]).unwrap();
            fs::write(root.join("a.txt"),"our saved contents").unwrap();
            let observed=std::rc::Rc::new(std::cell::RefCell::new(None));let captured=observed.clone();
            let _race=stash_test_hooks::install_after_push(Box::new(move |root| {
                let ours=git(root,&["rev-parse","refs/stash"])?.trim().to_owned();
                fs::write(root.join("a.txt"),"foreign saved contents")?;
                git(root,&["stash","push","-m","ThreadTerm: switch to target [op deadbeef]"])?;
                let foreign=git(root,&["rev-parse","refs/stash"])?.trim().to_owned();
                *captured.borrow_mut()=Some((ours,foreign));Ok(())
            }));
            let result=if mode=="smart" {
                call(&db,"git.checkout",json!({"projectId":project,"branch":"target","stash":true,"operationId":"ours-smart-race"})).unwrap()
            } else {
                let mut params=json!({"projectId":project,"includeUntracked":false,"operationId":"ours-push-race"});
                if mode=="message" {params["message"]=json!("our explicit message");}
                let saved=call(&db,"git.stash.push",params).unwrap();
                let ours=observed.borrow().as_ref().unwrap().0.clone();assert_eq!(saved["oid"],ours);
                call(&db,"git.stash.apply",json!({"projectId":project,"oid":saved["oid"],"pop":true,"operationId":"ours-pop-race"})).unwrap()
            };
            let (ours,foreign)=observed.borrow().clone().unwrap();assert_ne!(ours,foreign);
            let outcome=if mode=="smart" {&result["stash"]} else {&result};
            assert_eq!(outcome["oid"],ours);assert_eq!(outcome["applied"],true);assert_eq!(outcome["dropped"],true);
            if mode=="smart" {assert_eq!(result["branch"],"target");assert_eq!(outcome["message"],stash_switch_message("target","ours-smart-race"));}
            let stack=stash_stack(root).unwrap();assert_eq!(stack.len(),1);assert_eq!(stack[0].0,foreign);
            assert_eq!(git(root,&["show",&format!("{foreign}:a.txt")]).unwrap(),"foreign saved contents");
            assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(),"our saved contents");
        }
    }

    #[test]
    fn stash_push_unmatched_or_ambiguous_subjects_never_switch_or_apply() {
        for ambiguous in [false,true] {
            let (temp,db,project)=setup();let root=temp.path();git(root,&["branch","target"]).unwrap();
            let before=checkout_head(root).unwrap();fs::write(root.join("a.txt"),"ours").unwrap();
            let observed=std::rc::Rc::new(std::cell::RefCell::new(None));let captured=observed.clone();
            let _race=stash_test_hooks::install_after_push(Box::new(move |root| {
                let ours=git(root,&["rev-parse","refs/stash"])?.trim().to_owned();
                if !ambiguous {git(root,&["stash","drop","stash@{0}"])?;}
                fs::write(root.join("a.txt"),"foreign")?;
                let message=if ambiguous {stash_switch_message("target","ambiguous-switch")} else {"foreign unrelated message".to_owned()};
                git(root,&["stash","push","-m",&message])?;
                let foreign=git(root,&["rev-parse","refs/stash"])?.trim().to_owned();
                *captured.borrow_mut()=Some((ours,foreign));Ok(())
            }));
            let error=call(&db,"git.checkout",json!({"projectId":project,"branch":"target","stash":true,"operationId":"ambiguous-switch"})).unwrap_err().to_string();
            let detail:Value=serde_json::from_str(error.strip_prefix("stash_operation_failed: ").unwrap()).unwrap();
            let (ours,foreign)=observed.borrow().clone().unwrap();let candidates=detail["candidateOids"].as_array().unwrap();
            assert!(candidates.contains(&json!(foreign)));assert_eq!(candidates.len(),if ambiguous {2} else {1});
            if ambiguous {assert!(candidates.contains(&json!(ours)));}
            assert_eq!(checkout_head(root).unwrap(),before);assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(),"base");
            assert!(stash_stack(root).unwrap().iter().any(|(oid,_)|oid==&foreign));
            assert!(db.external_operation_pending("ambiguous-switch").unwrap());
        }
    }

    #[test]
    fn stash_switch_nonce_is_operation_bound_and_survives_message_capping() {
        let message=stash_switch_message(&"x".repeat(255),"operation-one");
        assert_eq!(message.chars().count(),200);assert!(message.ends_with(&stash_switch_message("", "operation-one")["ThreadTerm: switch to ".len()..]));
        assert_eq!(stash_switch_message("target","one"),stash_switch_message("target","one"));
        assert_ne!(stash_switch_message("target","one"),stash_switch_message("target","two"));
    }

    #[test]
    fn stash_push_failure_names_its_unique_candidate_without_switching() {
        let (temp,db,project)=setup();let root=temp.path();git(root,&["branch","target"]).unwrap();
        let before=checkout_head(root).unwrap();fs::write(root.join("a.txt"),"ours").unwrap();
        let _race=stash_test_hooks::install_after_push(Box::new(|_|Err(anyhow!("injected post-push failure"))));
        let error=call(&db,"git.checkout",json!({"projectId":project,"branch":"target","stash":true,"operationId":"failed-push"})).unwrap_err().to_string();
        let detail:Value=serde_json::from_str(error.strip_prefix("stash_operation_failed: ").unwrap()).unwrap();
        assert_eq!(detail["candidateOids"],json!([detail["oid"]]));assert!(detail["oid"].is_string());
        assert_eq!(checkout_head(root).unwrap(),before);assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(),"base");
        assert_eq!(stash_stack(root).unwrap()[0].0,detail["oid"].as_str().unwrap());
    }

    #[test]
    fn push_force_lease_and_rejections_use_explicit_safe_contracts() {
        let (temp, db, project) = setup();
        let root = temp.path();
        let remote = tempfile::tempdir().unwrap();
        git(remote.path(), &["init", "--bare", "-q"]).unwrap();
        git(root, &["remote", "add", "origin", remote.path().to_str().unwrap()]).unwrap();
        let branch = git(root, &["branch", "--show-current"]).unwrap().trim().to_owned();
        git(root, &["push", "-qu", "origin", &branch]).unwrap();
        git(remote.path(), &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")]).unwrap();
        let published = crate::git_read::push_preview(root).unwrap();
        let expected = published["remoteOid"].as_str().unwrap().to_owned();

        fs::write(root.join("a.txt"), "rewritten\n").unwrap();
        git(root, &["add", "a.txt"]).unwrap();
        git(root, &["commit", "--amend", "-qm", "rewritten history"]).unwrap();
        let force_request = json!({
            "projectId":project, "operationId":"force-ok", "remote":published["remote"], "remoteBranch":published["remoteBranch"], "localBranch":published["localBranch"], "force":"with-lease", "expectedRemoteOid":expected,
        });
        let forced = dispatch(&db, "git.push", &force_request).unwrap().unwrap();
        assert!(forced["output"].as_str().is_some());
        // A retry after a lost response replays the receipt, although the lease no longer matches the moved tip.
        assert_eq!(dispatch(&db, "git.push", &force_request).unwrap().unwrap(), forced);

        let stale = crate::git_read::push_preview(root).unwrap();
        let stale_oid = stale["remoteOid"].as_str().unwrap().to_owned();
        let peer = tempfile::tempdir().unwrap();
        git(peer.path(), &["clone", "-q", remote.path().to_str().unwrap(), "."]).unwrap();
        git(peer.path(), &["config", "user.email", "peer@example.test"]).unwrap();
        git(peer.path(), &["config", "user.name", "Peer"]).unwrap();
        fs::write(peer.path().join("peer.txt"), "peer\n").unwrap();
        git(peer.path(), &["add", "."]).unwrap();
        git(peer.path(), &["commit", "-qm", "peer"]).unwrap();
        git(peer.path(), &["push", "-q"]).unwrap();
        let error = dispatch(&db, "git.push", &json!({
            "projectId":project, "operationId":"force-stale", "remote":published["remote"], "remoteBranch":published["remoteBranch"], "localBranch":published["localBranch"], "force":"with-lease", "expectedRemoteOid":stale_oid,
        })).unwrap_err().to_string();
        assert_eq!(error, "push_lease_stale");
        git(root, &["fetch", "-q", "origin"]).unwrap();
        let error = dispatch(&db, "git.push", &json!({
            "projectId":project, "operationId":"force-stale-local", "remote":published["remote"], "remoteBranch":published["remoteBranch"], "localBranch":published["localBranch"], "force":"with-lease", "expectedRemoteOid":stale_oid,
        })).unwrap_err().to_string();
        assert_eq!(error, "push_lease_stale");

        let non_ff = dispatch(&db, "git.push", &json!({"projectId":project,"operationId":"non-ff"})).unwrap_err().to_string();
        assert_eq!(non_ff, "push_rejected_non_ff");
    }

    #[test]
    fn force_push_binds_reviewed_branch_and_remote_before_claiming() {
        let (temp, db, project) = setup();
        let root = temp.path();
        git(root, &["branch", "-M", "main"]).unwrap();
        let origin = tempfile::tempdir().unwrap();
        let backup = tempfile::tempdir().unwrap();
        for (name, remote) in [("origin", &origin), ("backup", &backup)] {
            git(remote.path(), &["init", "--bare", "-q"]).unwrap();
            git(root, &["remote", "add", name, remote.path().to_str().unwrap()]).unwrap();
        }
        git(root, &["push", "-qu", "origin", "main"]).unwrap();
        git(root, &["switch", "-qc", "feature"]).unwrap();
        git(root, &["push", "-qu", "origin", "feature"]).unwrap();
        fs::write(root.join("a.txt"), "feature rewrite").unwrap();
        git(root, &["commit", "-qam", "feature rewrite", "--amend"]).unwrap();
        let preview = crate::git_read::push_preview(root).unwrap();
        let request = json!({"projectId":project,"operationId":"reviewed-feature","force":"with-lease",
            "remote":preview["remote"],"remoteBranch":preview["remoteBranch"],
            "localBranch":preview["localBranch"],"expectedRemoteOid":preview["remoteOid"]});

        git(root, &["switch", "-q", "main"]).unwrap();
        fs::write(root.join("a.txt"), "main rewrite").unwrap();
        git(root, &["commit", "-qam", "main rewrite", "--amend"]).unwrap();
        assert_eq!(git(root, &["rev-parse", "refs/remotes/origin/main"]).unwrap().trim(), preview["remoteOid"].as_str().unwrap());
        assert_eq!(dispatch(&db, "git.push", &request).unwrap_err().to_string(), "push_destination_changed");
        assert!(!db.external_operation_pending("reviewed-feature").unwrap());
        assert!(db.operation("reviewed-feature").unwrap().is_none());
        assert_eq!(git(origin.path(), &["rev-parse", "refs/heads/main"]).unwrap().trim(), preview["remoteOid"].as_str().unwrap());

        git(root, &["switch", "-q", "feature"]).unwrap();
        assert!(dispatch(&db, "git.push", &request).unwrap().unwrap()["output"].is_string());
        let reviewed = crate::git_read::push_preview(root).unwrap();
        git(root, &["push", "-q", "backup", "feature"]).unwrap();
        git(root, &["config", "branch.feature.pushRemote", "backup"]).unwrap();
        assert_eq!(crate::git_read::push_preview(root).unwrap()["remoteOid"], reviewed["remoteOid"]);
        let request = json!({"projectId":project,"operationId":"reviewed-origin","force":"with-lease",
            "remote":reviewed["remote"],"remoteBranch":reviewed["remoteBranch"],
            "localBranch":reviewed["localBranch"],"expectedRemoteOid":reviewed["remoteOid"]});
        assert_eq!(dispatch(&db, "git.push", &request).unwrap_err().to_string(), "push_destination_changed");
        assert!(!db.external_operation_pending("reviewed-origin").unwrap());
        git(root, &["config", "--unset", "branch.feature.pushRemote"]).unwrap();
        assert!(dispatch(&db, "git.push", &request).unwrap().unwrap()["output"].is_string());
    }

    #[test]
    fn fetch_targets_only_a_configured_reviewed_remote() {
        let (temp, db, project) = setup();
        let root = temp.path();
        let branch = git(root, &["branch", "--show-current"]).unwrap().trim().to_owned();
        let origin = tempfile::tempdir().unwrap();
        let backup = tempfile::tempdir().unwrap();
        for (name, remote) in [("origin", &origin), ("backup", &backup)] {
            git(remote.path(), &["init", "--bare", "-q"]).unwrap();
            git(root, &["remote", "add", name, remote.path().to_str().unwrap()]).unwrap();
            git(root, &["push", "-q", name, &branch]).unwrap();
        }
        git(root, &["branch", "--set-upstream-to", &format!("origin/{branch}")]).unwrap();
        git(root, &["config", &format!("branch.{branch}.pushRemote"), "backup"]).unwrap();
        let before = git(root, &["rev-parse", &format!("refs/remotes/origin/{branch}")]).unwrap();
        let peer = tempfile::tempdir().unwrap();
        git(peer.path(), &["clone", "-q", "-b", &branch, backup.path().to_str().unwrap(), "."]).unwrap();
        git(peer.path(), &["config", "user.email", "peer@example.test"]).unwrap();
        git(peer.path(), &["config", "user.name", "Peer"]).unwrap();
        git(peer.path(), &["commit", "--allow-empty", "-qm", "backup advanced"]).unwrap();
        git(peer.path(), &["push", "-q"]).unwrap();
        for remote in ["--all", "missing", backup.path().to_str().unwrap()] {
            let request = json!({"projectId":project,"operationId":"invalid-fetch","remote":remote});
            assert_eq!(dispatch(&db, "git.fetch", &request).unwrap_err().to_string(), "invalid_remote");
            assert!(!db.external_operation_pending("invalid-fetch").unwrap());
        }
        dispatch(&db, "git.fetch", &json!({"projectId":project,"operationId":"backup-fetch","remote":"backup"})).unwrap();
        assert_eq!(git(root, &["rev-parse", &format!("refs/remotes/origin/{branch}")]).unwrap(), before);
        let preview = crate::git_read::push_preview(root).unwrap();
        assert_eq!(preview["remote"], "backup");
        assert_eq!(preview["behind"]["count"], 1);
        assert!(preview["lastFetchedAt"].is_string());
    }

    #[test]
    fn push_rejection_classifier_is_stable_and_hook_precedes_advice() {
        for (text, expected) in [
            ("remote: protected branch\n! [remote rejected] main -> main (pre-receive hook declined)\nnon-fast-forward", "push_rejected_hook: protected branch"),
            ("fatal: Authentication failed for 'https://example.test/'", "push_auth_failed"),
            ("git@example.test: Could not resolve hostname example.test", "push_remote_unreachable"),
        ] {
            assert_eq!(classify_push_rejection(anyhow!("git_failed: {text}")).to_string(), expected);
        }
        assert_eq!(classify_push_rejection(anyhow!("git_failed: unexplained failure")).to_string(), "git_failed: unexplained failure");
        assert_eq!(classify_push_rejection(anyhow!("git_failed: stale info")).to_string(), "push_lease_stale");
    }

    #[test]
    fn push_hook_decline_returns_its_first_remote_line() {
        let (temp, db, project) = setup();
        let root = temp.path();
        let remote = tempfile::tempdir().unwrap();
        git(remote.path(), &["init", "--bare", "-q"]).unwrap();
        git(root, &["remote", "add", "origin", remote.path().to_str().unwrap()]).unwrap();
        let branch = git(root, &["branch", "--show-current"]).unwrap().trim().to_owned();
        git(root, &["push", "-qu", "origin", &branch]).unwrap();
        fs::write(remote.path().join("hooks/pre-receive"), "#!/bin/sh\necho policy denied >&2\nexit 1\n").unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(remote.path().join("hooks/pre-receive"), fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(root.join("hook.txt"), "blocked\n").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-qm", "blocked"]).unwrap();
        let error = dispatch(&db, "git.push", &json!({"projectId":project,"operationId":"hook"})).unwrap_err().to_string();
        assert_eq!(error, "push_rejected_hook: policy denied");
    }

    #[test]
    fn history_actions_replay_conflict_continue_abort_and_reset_fences() {
        let (temp, db, project) = setup();
        let root = temp.path();
        git(root, &["branch", "-M", "main"]).unwrap();
        let base = head_oid(root).unwrap();
        git(root, &["switch", "-qc", "feature"]).unwrap();
        fs::write(root.join("a.txt"), "feature\n").unwrap();
        git(root, &["commit", "-am", "feature", "-q"]).unwrap();
        let feature = head_oid(root).unwrap();
        git(root, &["switch", "-q", "main"]).unwrap();

        let picked = dispatch(&db, "git.cherryPick", &json!({"projectId":project,"hash":feature,"operationId":"pick"})).unwrap().unwrap();
        assert_eq!(picked["conflicted"], false);
        assert_eq!(dispatch(&db, "git.cherryPick", &json!({"projectId":project,"hash":feature,"operationId":"pick"})).unwrap().unwrap(), picked);

        git(root, &["reset", "--hard", &base]).unwrap();
        fs::write(root.join("a.txt"), "main\n").unwrap();
        git(root, &["commit", "-am", "main", "-q"]).unwrap();
        let conflict = dispatch(&db, "git.cherryPick", &json!({"projectId":project,"hash":feature,"operationId":"conflict"})).unwrap().unwrap();
        assert_eq!(conflict["conflicted"], true);
        let status = crate::workspace_services::git_status(root).unwrap();
        assert_eq!(status["operation"]["head"], feature);
        assert_eq!(status["operation"]["message"], "feature");
        assert_eq!(dispatch(&db, "git.operation.continue", &json!({"projectId":project,"kind":"cherry-pick","operationId":"continue-unresolved"})).unwrap_err().to_string(), "unresolved_conflicts");
        fs::write(root.join("a.txt"), "resolved\n").unwrap();
        git(root, &["add", "a.txt"]).unwrap();
        assert_eq!(dispatch(&db, "git.operation.continue", &json!({"projectId":project,"kind":"cherry-pick","operationId":"continue"})).unwrap().unwrap()["conflicted"], false);

        git(root, &["reset", "--hard", &base]).unwrap();
        fs::write(root.join("a.txt"), "main again\n").unwrap();
        git(root, &["commit", "-am", "main again", "-q"]).unwrap();
        assert_eq!(dispatch(&db, "git.cherryPick", &json!({"projectId":project,"hash":feature,"operationId":"abort-conflict"})).unwrap().unwrap()["conflicted"], true);
        assert!(dispatch(&db, "git.operation.abort", &json!({"projectId":project,"kind":"cherry-pick","operationId":"abort"})).unwrap().unwrap()["output"].is_string());

        let before_reset = head_oid(root).unwrap();
        let reset = dispatch(&db, "git.reset", &json!({"projectId":project,"hash":base,"mode":"mixed","expectedHead":before_reset,"operationId":"reset"})).unwrap().unwrap();
        assert_eq!(reset["previousHead"], before_reset);
        assert_eq!(reset["head"], base);
        assert_eq!(reset["symbolicHead"], "refs/heads/main");
        let undo = dispatch(&db, "git.reset", &json!({"projectId":project,"hash":before_reset,"mode":"soft","expectedHead":base,"undoOf":"reset","operationId":"undo"})).unwrap().unwrap();
        assert_eq!(undo["head"], before_reset);
        assert_eq!(undo["symbolicHead"], "refs/heads/main");
        assert_eq!(dispatch(&db, "git.reset", &json!({"projectId":project,"hash":base,"mode":"hard","expectedHead":before_reset,"operationId":"bad-mode"})).unwrap_err().to_string(), "invalid_request");
        assert!(!db.external_operation_pending("bad-mode").unwrap());
    }

    #[test]
    fn history_revert_clean_conflict_continue_abort_merge_and_replay() {
        let (temp, db, project) = setup();
        let root = temp.path();
        git(root, &["config", "core.autocrlf", "false"]).unwrap();
        git(root, &["branch", "-M", "main"]).unwrap();

        fs::write(root.join("a.txt"), "clean\n").unwrap();
        git(root, &["commit", "-am", "clean", "-q"]).unwrap();
        let clean_commit = head_oid(root).unwrap();
        let clean_request = json!({"projectId":project,"hash":clean_commit,"operationId":"revert-clean"});
        let clean = dispatch(&db, "git.revert", &clean_request).unwrap().unwrap();
        assert_eq!(clean["conflicted"], false);
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "base");
        assert_eq!(dispatch(&db, "git.revert", &clean_request).unwrap().unwrap(), clean);

        fs::write(root.join("a.txt"), "target\n").unwrap();
        git(root, &["commit", "-am", "revert target", "-q"]).unwrap();
        let conflict_target = head_oid(root).unwrap();
        fs::write(root.join("a.txt"), "later\n").unwrap();
        git(root, &["commit", "-am", "later", "-q"]).unwrap();
        let conflict = dispatch(
            &db,
            "git.revert",
            &json!({"projectId":project,"hash":conflict_target,"operationId":"revert-conflict"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(conflict["conflicted"], true);
        let status = crate::workspace_services::git_status(root).unwrap();
        assert_eq!(status["operation"]["head"], conflict_target);
        assert_eq!(status["operation"]["message"], "revert target");
        fs::write(root.join("a.txt"), "resolved\n").unwrap();
        git(root, &["add", "a.txt"]).unwrap();
        let continue_request = json!({"projectId":project,"kind":"revert","operationId":"revert-continue"});
        let continued = dispatch(&db, "git.operation.continue", &continue_request)
            .unwrap()
            .unwrap();
        assert_eq!(continued["conflicted"], false);
        assert_eq!(
            dispatch(&db, "git.operation.continue", &continue_request)
                .unwrap()
                .unwrap(),
            continued
        );

        fs::write(root.join("abort.txt"), "base\n").unwrap();
        git(root, &["add", "abort.txt"]).unwrap();
        git(root, &["commit", "-qm", "abort base"]).unwrap();
        fs::write(root.join("abort.txt"), "target\n").unwrap();
        git(root, &["commit", "-am", "abort target", "-q"]).unwrap();
        let abort_target = head_oid(root).unwrap();
        fs::write(root.join("abort.txt"), "later\n").unwrap();
        git(root, &["commit", "-am", "abort later", "-q"]).unwrap();
        let before_abort = head_oid(root).unwrap();
        assert_eq!(
            dispatch(
                &db,
                "git.revert",
                &json!({"projectId":project,"hash":abort_target,"operationId":"revert-abort-conflict"}),
            )
            .unwrap()
            .unwrap()["conflicted"],
            true
        );
        let abort_request = json!({"projectId":project,"kind":"revert","operationId":"revert-abort"});
        let aborted = dispatch(&db, "git.operation.abort", &abort_request)
            .unwrap()
            .unwrap();
        assert_eq!(aborted["head"], before_abort);
        assert_eq!(fs::read_to_string(root.join("abort.txt")).unwrap(), "later\n");
        assert_eq!(
            dispatch(&db, "git.operation.abort", &abort_request)
                .unwrap()
                .unwrap(),
            aborted
        );

        fs::write(root.join("merge.txt"), "base\n").unwrap();
        git(root, &["add", "merge.txt"]).unwrap();
        git(root, &["commit", "-qm", "merge base"]).unwrap();
        git(root, &["switch", "-qc", "merge-side"]).unwrap();
        fs::write(root.join("merge.txt"), "side\n").unwrap();
        git(root, &["commit", "-am", "side", "-q"]).unwrap();
        git(root, &["switch", "-q", "main"]).unwrap();
        fs::write(root.join("main-only.txt"), "main\n").unwrap();
        git(root, &["add", "main-only.txt"]).unwrap();
        git(root, &["commit", "-qm", "main side"]).unwrap();
        git(root, &["merge", "--no-ff", "merge-side", "-m", "merge side", "-q"]).unwrap();
        let merge_commit = head_oid(root).unwrap();
        let merge_request = json!({"projectId":project,"hash":merge_commit,"mainline":1,"operationId":"revert-merge"});
        let merge_revert = dispatch(&db, "git.revert", &merge_request)
            .unwrap()
            .unwrap();
        assert_eq!(merge_revert["conflicted"], false);
        assert_eq!(fs::read_to_string(root.join("merge.txt")).unwrap(), "base\n");
        assert_eq!(fs::read_to_string(root.join("main-only.txt")).unwrap(), "main\n");
        assert_eq!(
            dispatch(&db, "git.revert", &merge_request).unwrap().unwrap(),
            merge_revert
        );
    }

    #[test]
    fn history_reset_modes_fences_and_replay_preserve_content() {
        let (temp, db, project) = setup();
        let root = temp.path();
        git(root, &["config", "core.autocrlf", "false"]).unwrap();
        git(root, &["branch", "-M", "main"]).unwrap();
        fs::write(root.join("reset.txt"), "one\n").unwrap();
        git(root, &["add", "reset.txt"]).unwrap();
        git(root, &["commit", "-qm", "reset base"]).unwrap();
        let base = head_oid(root).unwrap();
        fs::write(root.join("reset.txt"), "two\n").unwrap();
        git(root, &["commit", "-am", "reset next", "-q"]).unwrap();
        let head = head_oid(root).unwrap();

        let soft_request = json!({"projectId":project,"hash":base,"mode":"soft","expectedHead":head,"operationId":"reset-soft"});
        let soft = dispatch(&db, "git.reset", &soft_request).unwrap().unwrap();
        assert_eq!(soft["previousHead"], head);
        assert_eq!(soft["symbolicHead"], "refs/heads/main");
        assert_eq!(fs::read_to_string(root.join("reset.txt")).unwrap(), "two\n");
        assert_eq!(git(root, &["diff", "--name-only"]).unwrap(), "");
        assert_eq!(git(root, &["diff", "--cached", "--name-only"]).unwrap().trim(), "reset.txt");
        assert_eq!(dispatch(&db, "git.reset", &soft_request).unwrap().unwrap(), soft);

        git(root, &["reset", "--hard", &head]).unwrap();
        let mixed_request = json!({"projectId":project,"hash":base,"mode":"mixed","expectedHead":head,"operationId":"reset-mixed"});
        let mixed = dispatch(&db, "git.reset", &mixed_request).unwrap().unwrap();
        assert_eq!(fs::read_to_string(root.join("reset.txt")).unwrap(), "two\n");
        assert_eq!(git(root, &["diff", "--cached", "--name-only"]).unwrap(), "");
        assert_eq!(git(root, &["diff", "--name-only"]).unwrap().trim(), "reset.txt");
        assert_eq!(dispatch(&db, "git.reset", &mixed_request).unwrap().unwrap(), mixed);

        let moved = dispatch(
            &db,
            "git.reset",
            &json!({"projectId":project,"hash":base,"mode":"mixed","expectedHead":head,"operationId":"reset-head-moved"}),
        )
        .unwrap_err();
        assert_eq!(moved.to_string(), "head_moved");
        assert!(!db.external_operation_pending("reset-head-moved").unwrap());

        git(root, &["reset", "--hard", &base]).unwrap();
        git(root, &["switch", "-qc", "reset-side"]).unwrap();
        fs::write(root.join("side.txt"), "side\n").unwrap();
        git(root, &["add", "side.txt"]).unwrap();
        git(root, &["commit", "-qm", "side"]).unwrap();
        let nonancestor = head_oid(root).unwrap();
        git(root, &["switch", "-q", "main"]).unwrap();
        let rejected = dispatch(
            &db,
            "git.reset",
            &json!({"projectId":project,"hash":nonancestor,"mode":"mixed","expectedHead":base,"operationId":"reset-nonancestor"}),
        )
        .unwrap_err();
        assert_eq!(rejected.to_string(), "not_ancestor");
        assert!(!db.external_operation_pending("reset-nonancestor").unwrap());
        assert_eq!(head_oid(root).unwrap(), base);
    }

    #[test]
    fn history_reset_undo_fences_symbolic_head_and_allows_matching_detached_head() {
        let (temp, db, project) = setup();
        let root = temp.path();
        git(root, &["config", "core.autocrlf", "false"]).unwrap();
        git(root, &["branch", "-M", "main"]).unwrap();
        let target = head_oid(root).unwrap();
        fs::write(root.join("a.txt"), "later\n").unwrap();
        git(root, &["commit", "-am", "later", "-q"]).unwrap();
        let previous = head_oid(root).unwrap();

        let branch_reset = dispatch(
            &db,
            "git.reset",
            &json!({"projectId":project,"hash":target,"mode":"mixed","expectedHead":previous,"operationId":"branch-reset"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(branch_reset["symbolicHead"], "refs/heads/main");
        git(root, &["restore", "--worktree", "--source=HEAD", "--", "a.txt"]).unwrap();
        git(root, &["branch", "other", &target]).unwrap();
        git(root, &["switch", "-q", "other"]).unwrap();
        let branch_undo = json!({"projectId":project,"hash":previous,"mode":"soft","expectedHead":target,"undoOf":"branch-reset","operationId":"branch-undo"});
        assert_eq!(
            dispatch(&db, "git.reset", &branch_undo)
                .unwrap_err()
                .to_string(),
            "head_moved"
        );
        assert!(!db.external_operation_pending("branch-undo").unwrap());
        assert_eq!(git(root, &["rev-parse", "refs/heads/main"]).unwrap().trim(), target);
        assert_eq!(git(root, &["rev-parse", "refs/heads/other"]).unwrap().trim(), target);
        assert_eq!(checkout_head(root).unwrap().reference.as_deref(), Some("refs/heads/other"));

        git(root, &["switch", "--detach", "-q", &previous]).unwrap();
        let detached_reset = dispatch(
            &db,
            "git.reset",
            &json!({"projectId":project,"hash":target,"mode":"mixed","expectedHead":previous,"operationId":"detached-reset"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(detached_reset["symbolicHead"], "detached");
        let detached_undo = json!({"projectId":project,"hash":previous,"mode":"soft","expectedHead":target,"undoOf":"detached-reset","operationId":"detached-undo"});
        let undone = dispatch(&db, "git.reset", &detached_undo).unwrap().unwrap();
        assert_eq!(undone["head"], previous);
        assert_eq!(undone["symbolicHead"], "detached");

        let fenced_reset = dispatch(
            &db,
            "git.reset",
            &json!({"projectId":project,"hash":target,"mode":"mixed","expectedHead":previous,"operationId":"detached-fenced-reset"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(fenced_reset["symbolicHead"], "detached");
        git(root, &["restore", "--worktree", "--source=HEAD", "--", "a.txt"]).unwrap();
        git(root, &["switch", "-qc", "attached-at-target"]).unwrap();
        let fenced_undo = json!({"projectId":project,"hash":previous,"mode":"soft","expectedHead":target,"undoOf":"detached-fenced-reset","operationId":"detached-fenced-undo"});
        assert_eq!(
            dispatch(&db, "git.reset", &fenced_undo)
                .unwrap_err()
                .to_string(),
            "head_moved"
        );
        assert!(!db.external_operation_pending("detached-fenced-undo").unwrap());
        assert_eq!(git(root, &["rev-parse", "refs/heads/attached-at-target"]).unwrap().trim(), target);
        assert_eq!(checkout_head(root).unwrap().reference.as_deref(), Some("refs/heads/attached-at-target"));

        git(root, &["switch", "--detach", "-q", &target]).unwrap();
        assert_eq!(dispatch(&db, "git.reset", &fenced_undo).unwrap_err().to_string(), "branch_changed");
        assert!(!db.external_operation_pending("detached-fenced-undo").unwrap());
        assert_eq!(checkout_head(root).unwrap(), CheckoutHead { reference: None, oid: target.clone() });
        assert_eq!(git(root, &["rev-parse", "refs/heads/attached-at-target"]).unwrap().trim(), target);
    }

    #[test]
    fn history_reset_undo_rejects_a_recreated_branch_with_the_same_name_and_oid() {
        let (temp, db, project) = setup();
        let root = temp.path();
        git(root, &["config", "core.autocrlf", "false"]).unwrap();
        git(root, &["branch", "-M", "main"]).unwrap();
        let target = head_oid(root).unwrap();
        fs::write(root.join("a.txt"), "later\n").unwrap();
        git(root, &["commit", "-am", "later", "-q"]).unwrap();
        let previous = head_oid(root).unwrap();
        dispatch(
            &db,
            "git.reset",
            &json!({"projectId":project,"hash":target,"mode":"mixed","expectedHead":previous,"operationId":"rename-reset"}),
        )
        .unwrap()
        .unwrap();
        git(root, &["restore", "--worktree", "--source=HEAD", "--", "a.txt"]).unwrap();
        git(root, &["branch", "-m", "saved"]).unwrap();
        git(root, &["branch", "main", &target]).unwrap();
        git(root, &["switch", "-q", "main"]).unwrap();

        let undo = json!({"projectId":project,"hash":previous,"mode":"soft","expectedHead":target,"undoOf":"rename-reset","operationId":"rename-undo"});
        assert_eq!(dispatch(&db, "git.reset", &undo).unwrap_err().to_string(), "branch_changed");
        assert!(!db.external_operation_pending("rename-undo").unwrap());
        assert_eq!(git(root, &["rev-parse", "refs/heads/main"]).unwrap().trim(), target);
        assert_eq!(git(root, &["rev-parse", "refs/heads/saved"]).unwrap().trim(), target);
        assert_eq!(checkout_head(root).unwrap().reference.as_deref(), Some("refs/heads/main"));
    }

    #[test]
    fn history_refusals_release_claims_and_retry_for_tracked_staged_and_untracked() {
        {
            let (temp, db, project) = setup();
            let root = temp.path();
            git(root, &["config", "core.autocrlf", "false"]).unwrap();
            git(root, &["branch", "-M", "main"]).unwrap();
            let base = head_oid(root).unwrap();
            git(root, &["switch", "-qc", "tracked-source"]).unwrap();
            fs::write(root.join("a.txt"), "picked\n").unwrap();
            git(root, &["commit", "-am", "picked", "-q"]).unwrap();
            let picked = head_oid(root).unwrap();
            git(root, &["switch", "-q", "main"]).unwrap();
            assert_eq!(head_oid(root).unwrap(), base);
            fs::write(root.join("a.txt"), "local\n").unwrap();
            let request = json!({"projectId":project,"hash":picked,"operationId":"tracked-refusal"});
            assert_eq!(
                dispatch(&db, "git.cherryPick", &request)
                    .unwrap_err()
                    .to_string(),
                "cherry_pick_would_overwrite"
            );
            assert!(!db.external_operation_pending("tracked-refusal").unwrap());
            git(root, &["restore", "a.txt"]).unwrap();
            assert_eq!(dispatch(&db, "git.cherryPick", &request).unwrap().unwrap()["conflicted"], false);
        }

        {
            let (temp, db, project) = setup();
            let root = temp.path();
            git(root, &["config", "core.autocrlf", "false"]).unwrap();
            git(root, &["config", "advice.commitBeforeMerge", "false"]).unwrap();
            fs::write(root.join("a.txt"), "target\n").unwrap();
            git(root, &["commit", "-am", "target", "-q"]).unwrap();
            let target = head_oid(root).unwrap();
            fs::write(root.join("a.txt"), "staged\n").unwrap();
            git(root, &["add", "a.txt"]).unwrap();
            let request = json!({"projectId":project,"hash":target,"operationId":"staged-refusal"});
            assert_eq!(
                dispatch(&db, "git.revert", &request)
                    .unwrap_err()
                    .to_string(),
                "revert_would_overwrite"
            );
            assert!(!db.external_operation_pending("staged-refusal").unwrap());
            git(root, &["reset", "--hard", &target]).unwrap();
            assert_eq!(dispatch(&db, "git.revert", &request).unwrap().unwrap()["conflicted"], false);
        }

        {
            let (temp, db, project) = setup();
            let root = temp.path();
            git(root, &["config", "core.autocrlf", "false"]).unwrap();
            git(root, &["config", "advice.commitBeforeMerge", "false"]).unwrap();
            fs::write(root.join("gone.txt"), "tracked\n").unwrap();
            git(root, &["add", "gone.txt"]).unwrap();
            git(root, &["commit", "-qm", "add gone"]).unwrap();
            git(root, &["rm", "-q", "gone.txt"]).unwrap();
            git(root, &["commit", "-qm", "delete gone"]).unwrap();
            let deletion = head_oid(root).unwrap();
            fs::write(root.join("gone.txt"), "untracked\n").unwrap();
            let request = json!({"projectId":project,"hash":deletion,"operationId":"untracked-refusal"});
            assert_eq!(
                dispatch(&db, "git.revert", &request)
                    .unwrap_err()
                    .to_string(),
                "revert_would_overwrite"
            );
            assert!(!db.external_operation_pending("untracked-refusal").unwrap());
            fs::remove_file(root.join("gone.txt")).unwrap();
            assert_eq!(dispatch(&db, "git.revert", &request).unwrap().unwrap()["conflicted"], false);
            assert_eq!(fs::read_to_string(root.join("gone.txt")).unwrap(), "tracked\n");
        }
    }


    #[test]
    fn undo_journal_branch_stash_reset_and_receipts_are_fenced() {
        let (temp, db, project) = setup(); let root = temp.path();
        let initial = head_oid(root).unwrap();
        git(root, &["branch", "recover-me"]).unwrap();
        git(root, &["config", "branch.recover-me.remote", "."]).unwrap();
        git(root, &["config", "branch.recover-me.merge", "refs/heads/master"]).unwrap();
        let deleted = call(&db, "git.branch.delete", json!({"projectId":project,"branch":"recover-me","operationId":"delete-journal"})).unwrap();
        assert_eq!(deleted["undoId"], "delete-journal");
        git(root, &["branch", "recover-me"]).unwrap();
        let request = json!({"projectId":project,"id":"delete-journal","operationId":"undo-branch"});
        assert!(call(&db,"git.undo",request.clone()).unwrap_err().to_string().starts_with("undo_conflict"));
        assert!(!db.external_operation_pending("undo-branch").unwrap());
        git(root, &["branch", "-D", "recover-me"]).unwrap();
        let undone = call(&db,"git.undo",request.clone()).unwrap();
        assert_eq!(git(root,&["rev-parse","refs/heads/recover-me"]).unwrap().trim(),initial);
        assert_eq!(git(root,&["config","--get","branch.recover-me.remote"]).unwrap().trim(),".");
        assert_eq!(call(&db,"git.undo",request).unwrap(),undone);
        assert_eq!(call(&db,"git.undo",json!({"projectId":project,"id":"delete-journal","operationId":"undo-again"})).unwrap_err().to_string(),"undo_already_undone");
        fs::write(root.join("a.txt"),"stash data").unwrap();
        let pushed = call(&db,"git.stash.push",json!({"projectId":project,"message":"recover stash","includeUntracked":false,"operationId":"push-journal"})).unwrap();
        call(&db,"git.stash.drop",json!({"projectId":project,"oid":pushed["oid"],"operationId":"drop-journal"})).unwrap();
        call(&db,"git.undo",json!({"projectId":project,"id":"drop-journal","operationId":"undo-stash"})).unwrap();
        assert!(stash_stack(root).unwrap().iter().any(|(oid,_)|Some(oid.as_str())==pushed["oid"].as_str()));
        fs::write(root.join("a.txt"),"next").unwrap();git(root,&["add","a.txt"]).unwrap();git(root,&["commit","-m","next"]).unwrap();
        let previous = head_oid(root).unwrap();
        call(&db,"git.reset",json!({"projectId":project,"hash":initial,"mode":"soft","expectedHead":previous,"operationId":"reset-journal"})).unwrap();
        call(&db,"git.undo",json!({"projectId":project,"id":"reset-journal","operationId":"undo-reset-journal"})).unwrap();
        assert_eq!(head_oid(root).unwrap(),previous);
        let list = call(&db,"git.undo.list",json!({"projectId":project})).unwrap();
        assert_eq!(list["entries"].as_array().unwrap().len(),3);
    }

    #[test]
    fn undo_capture_failure_releases_discard_without_effect() {
        let (temp, db, project) = setup();
        fs::write(temp.path().join("a.txt"), b"capture me\r\n").unwrap();
        let request = discard_request(&db,&project,&["a.txt"],"capture-failure");
        db.transaction(|tx| { tx.execute_batch("CREATE TRIGGER reject_undo BEFORE INSERT ON git_undo BEGIN SELECT RAISE(ABORT,'test capture failure'); END;")?; Ok(()) }).unwrap();
        assert!(call(&db,"git.discard",request.clone()).unwrap_err().to_string().starts_with("undo_capture_failed"));
        assert_eq!(fs::read(temp.path().join("a.txt")).unwrap(), b"capture me\r\n");
        assert!(!db.external_operation_pending("capture-failure").unwrap());
        db.transaction(|tx| { tx.execute_batch("DROP TRIGGER reject_undo")?; Ok(()) }).unwrap();
        call(&db,"git.discard",request).unwrap();
        call(&db,"git.undo",json!({"projectId":project,"id":"capture-failure","operationId":"undo-captured"})).unwrap();
        assert_eq!(fs::read(temp.path().join("a.txt")).unwrap(), b"capture me\r\n");
    }


    #[test]
    fn journal_reset_undo_rejects_head_roundtrip_and_recreated_branch() {
        let (temp, db, project) = setup(); let root = temp.path();
        let initial = head_oid(root).unwrap();
        fs::write(root.join("a.txt"),"second").unwrap();git(root,&["add","a.txt"]).unwrap();git(root,&["commit","-m","second"]).unwrap();
        let previous = head_oid(root).unwrap();
        call(&db,"git.reset",json!({"projectId":project,"hash":initial,"mode":"soft","expectedHead":previous,"operationId":"reset-roundtrip"})).unwrap();
        git(root,&["reset","--soft",&previous]).unwrap();
        git(root,&["reset","--soft",&initial]).unwrap();
        let undo = json!({"projectId":project,"id":"reset-roundtrip","operationId":"undo-roundtrip"});
        assert!(call(&db,"git.undo",undo).unwrap_err().to_string().starts_with("undo_conflict"));
        assert!(!db.external_operation_pending("undo-roundtrip").unwrap());
        assert_eq!(head_oid(root).unwrap(),initial);
    }


    #[test]
    fn stash_pop_capture_change_after_apply_keeps_the_claim() {
        let (temp, db, project) = setup(); let root = temp.path();
        fs::write(root.join("a.txt"),"local to pop").unwrap();
        let pushed = call(&db,"git.stash.push",json!({"projectId":project,"message":"original","includeUntracked":false,"operationId":"pop-capture-push"})).unwrap();
        let oid = pushed["oid"].as_str().unwrap().to_owned();
        let hook_oid = oid.clone();
        let _guard = stash_test_hooks::install(None,Some(Box::new(move |root| {
            git(root,&["stash","drop","stash@{0}"])?;
            git(root,&["stash","store","-m","changed subject",&hook_oid])?; Ok(())
        })),false,false);
        let request = json!({"projectId":project,"oid":oid,"pop":true,"operationId":"pop-capture-change"});
        let error = call(&db,"git.stash.apply",request.clone()).unwrap_err().to_string();
        assert!(error.starts_with("stash_operation_failed:"),"{error}");
        assert_eq!(fs::read(root.join("a.txt")).unwrap(),b"local to pop");
        assert!(db.external_operation_pending("pop-capture-change").unwrap());
        assert_eq!(call(&db,"git.stash.apply",request).unwrap_err().to_string(),"operation_outcome_unknown");
        let listed = call(&db,"git.undo.list",json!({"projectId":project})).unwrap();
        assert!(listed["entries"].as_array().unwrap().is_empty());
    }


    #[test]
    fn concurrent_journal_undo_consumes_a_stash_entry_once() {
        let (temp, db, project) = setup(); let root = temp.path();
        fs::write(root.join("a.txt"),"local stash").unwrap();
        let pushed = call(&db,"git.stash.push",json!({"projectId":project,"includeUntracked":false,"operationId":"concurrent-push"})).unwrap();
        call(&db,"git.stash.drop",json!({"projectId":project,"oid":pushed["oid"],"operationId":"concurrent-drop"})).unwrap();
        let db = std::sync::Arc::new(db);
        let start = std::sync::Arc::new(std::sync::Barrier::new(3));
        let mut jobs = Vec::new();
        for index in 0..2 {
            let (db, start, project) = (db.clone(), start.clone(), project.clone());
            jobs.push(std::thread::spawn(move || {
                start.wait();
                call(&db,"git.undo",json!({"projectId":project,"id":"concurrent-drop","operationId":format!("concurrent-undo-{index}")})).map_err(|error|error.to_string())
            }));
        }
        start.wait();
        let results: Vec<_> = jobs.into_iter().map(|job|job.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|result|result.is_ok()).count(),1);
        assert!(results.iter().any(|result|result.as_ref().err().map(String::as_str)==Some("undo_already_undone")));
        let stack = stash_stack(root).unwrap();
        assert_eq!(stack.iter().filter(|(oid,_)|Some(oid.as_str())==pushed["oid"].as_str()).count(),1);
    }


    #[test]
    fn stash_interference_repairs_foreign_entries_before_journal_cleanup() {
        let (temp, db, project) = setup(); let root = temp.path();
        fs::write(root.join("a.txt"),"foreign").unwrap();
        let foreign = call(&db,"git.stash.push",json!({"projectId":project,"message":"foreign","includeUntracked":false,"operationId":"cleanup-foreign"})).unwrap()["oid"].as_str().unwrap().to_owned();
        fs::write(root.join("a.txt"),"ours").unwrap();
        let pushed = call(&db,"git.stash.push",json!({"projectId":project,"message":"ours","includeUntracked":false,"operationId":"cleanup-push"})).unwrap();
        let _guard = stash_test_hooks::install(Some(Box::new(move |root| {
            git(root,&["stash","drop","stash@{0}"])?;
            Ok(())
        })),None,false,false);
        db.transaction(|tx| { tx.execute_batch("CREATE TRIGGER reject_undo_delete BEFORE DELETE ON git_undo BEGIN SELECT RAISE(ABORT,'journal delete failed'); END;")?; Ok(()) }).unwrap();
        let error = call(&db,"git.stash.drop",json!({"projectId":project,"oid":pushed["oid"],"operationId":"cleanup-drop"})).unwrap_err().to_string();
        assert!(error.starts_with("stash_operation_failed:"),"{error}");
        assert!(stash_stack(root).unwrap().iter().any(|(oid,_)|oid==&foreign));
        assert!(db.external_operation_pending("cleanup-drop").unwrap());
        assert!(call(&db,"git.undo.list",json!({"projectId":project})).unwrap()["entries"].as_array().unwrap().is_empty());
    }


    #[test]
    fn discard_handoff_preserves_a_later_edit_between_paths() {
        let (temp, db, project) = setup(); let root = temp.path();
        fs::write(root.join("b.txt"), "b base").unwrap();
        fs::write(root.join("c.txt"), "c base").unwrap();
        git(root, &["add", "b.txt", "c.txt"]).unwrap();
        git(root, &["commit", "-m", "additional paths"]).unwrap();
        for path in ["a.txt", "b.txt", "c.txt"] { fs::write(root.join(path), format!("confirmed {path}")).unwrap(); }
        let request = discard_request(&db, &project, &["a.txt","b.txt","c.txt"], "handoff-between");
        let _hook = discard_handoff_hooks::install(Box::new(|root, path| {
            if path == "b.txt" { fs::write(root.join(path), "editor saved b after a")?; }
            Ok(())
        }));
        let error = call(&db,"git.discard",request.clone()).unwrap_err().to_string();
        assert!(error.starts_with("discard_incomplete:"),"{error}");
        assert!(error.contains("completedPaths: [\"a.txt\"]"),"{error}");
        assert!(error.contains("remainingPaths: [\"b.txt\",\"c.txt\"]"),"{error}");
        assert_eq!(fs::read(root.join("a.txt")).unwrap(),b"base");
        assert_eq!(fs::read(root.join("b.txt")).unwrap(),b"editor saved b after a");
        assert_eq!(fs::read(root.join("c.txt")).unwrap(),b"confirmed c.txt");
        assert!(db.external_operation_pending("handoff-between").unwrap());
        assert_eq!(call(&db,"git.discard",request).unwrap_err().to_string(),"operation_outcome_unknown");
    }

    #[test]
    fn undo_rejections_leave_no_request_binding() {
        let (temp, db, project) = setup(); let root = temp.path();
        fs::write(root.join("a.txt"),"confirmed bytes").unwrap();
        let discard = discard_request(&db,&project,&["a.txt"],"undo-reject-discard");
        call(&db,"git.discard",discard).unwrap();
        fs::write(root.join("a.txt"),"later user edit").unwrap();
        for index in 0..5 {
            let operation = format!("undo-rejected-{index}");
            let request = json!({"projectId":project,"id":"undo-reject-discard","operationId":operation});
            assert!(call(&db,"git.undo",request).unwrap_err().to_string().starts_with("undo_conflict"));
            assert!(db.operation_request(&operation).unwrap().is_none());
            assert!(!db.external_operation_pending(&operation).unwrap());
        }
        let unavailable = json!({"projectId":project,"id":"missing-journal","operationId":"undo-unavailable-rejected"});
        assert_eq!(call(&db,"git.undo",unavailable).unwrap_err().to_string(),"undo_unavailable");
        assert!(db.operation_request("undo-unavailable-rejected").unwrap().is_none());
        db.claim_external_operation("undo-pending-unbound").unwrap();
        let pending = json!({"projectId":project,"id":"undo-reject-discard","operationId":"undo-pending-unbound"});
        assert_eq!(call(&db,"git.undo",pending).unwrap_err().to_string(),"operation_outcome_unknown");
        assert!(db.operation_request("undo-pending-unbound").unwrap().is_none());
    }


    #[test]
    fn undo_handoff_edit_survives_and_releases_no_effect_request() {
        let (temp, db, project) = setup(); let root = temp.path();
        fs::write(root.join("a.txt"),"discarded bytes").unwrap();
        let discard = discard_request(&db,&project,&["a.txt"],"undo-race-discard");
        call(&db,"git.discard",discard).unwrap();
        let _hook = crate::git_undo::test_hooks::install_undo_after_prepare(|root| {
            fs::write(root.join("a.txt"),"editor saved during undo preparation")?; Ok(())
        });
        let request = json!({"projectId":project,"id":"undo-race-discard","operationId":"undo-race-reject"});
        let error = call(&db,"git.undo",request).unwrap_err().to_string();
        assert!(error.starts_with("undo_conflict:"),"{error}");
        assert_eq!(fs::read(root.join("a.txt")).unwrap(),b"editor saved during undo preparation");
        assert!(!db.external_operation_pending("undo-race-reject").unwrap());
        assert!(db.operation_request("undo-race-reject").unwrap().is_none());
        let journal_root = db.transaction(|tx| root_for(tx, &project, None)).unwrap();
        assert!(db.git_undo_get("undo-race-discard",&project,&journal_root.to_string_lossy()).unwrap().unwrap().undone_at.is_none());
    }


    #[test]
    fn partial_undo_retires_the_journal_entry_and_lists_its_progress() {
        let (temp, db, project) = setup(); let root = temp.path();
        fs::write(root.join("b.txt"),"base b").unwrap();
        git(root, &["add", "b.txt"]).unwrap();
        git(root, &["commit", "-m", "second"]).unwrap();
        fs::write(root.join("a.txt"),"discarded a").unwrap();
        fs::write(root.join("b.txt"),"discarded b").unwrap();
        let discard = discard_request(&db,&project,&["a.txt","b.txt"],"undo-partial-discard");
        call(&db,"git.discard",discard).unwrap();
        let _hook = crate::git_undo::test_hooks::install_undo_after_install(|_root, path| {
            if path == "a.txt" { return Err(anyhow!("injected failure after the first install")); }
            Ok(())
        });
        let request = json!({"projectId":project,"id":"undo-partial-discard","operationId":"undo-partial"});
        let before: i64 = db.transaction(|tx| Ok(tx.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))?)).unwrap();
        let error = call(&db,"git.undo",request.clone()).unwrap_err().to_string();
        assert!(error.starts_with("undo_conflict: completed=[a.txt]; remaining=[b.txt]"),"{error}");
        let after: i64 = db.transaction(|tx| Ok(tx.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))?)).unwrap();
        assert!(after > before, "a partial Undo publishes a scoped state.changed event");
        let published: String = db.transaction(|tx| Ok(tx.query_row("SELECT data FROM outbox ORDER BY created_at DESC, rowid DESC LIMIT 1", [], |row| row.get(0))?)).unwrap();
        let published: Value = serde_json::from_str(&published).unwrap();
        assert_eq!(published["kind"],json!("git"));
        assert_eq!(published["projectId"],json!(project));
        assert_eq!(fs::read(root.join("a.txt")).unwrap(),b"discarded a");
        assert_eq!(fs::read(root.join("b.txt")).unwrap(),b"base b");
        // The restored path is a real effect, so its claim stays uncertain.
        assert!(db.external_operation_pending("undo-partial").unwrap());
        let journal_root = db.transaction(|tx| root_for(tx, &project, None)).unwrap();
        let row = db.git_undo_get("undo-partial-discard",&project,&journal_root.to_string_lossy()).unwrap().unwrap();
        assert!(row.undone_at.is_some());
        assert_eq!(row.payload["partial"]["applied"],json!(["a.txt"]));
        assert_eq!(row.payload["partial"]["remaining"],json!(["b.txt"]));
        assert_eq!(call(&db,"git.undo",json!({"projectId":project,"id":"undo-partial-discard","operationId":"undo-partial-again"})).unwrap_err().to_string(),"undo_already_undone");
        let listed = call(&db,"git.undo.list",json!({"projectId":project})).unwrap();
        let entry = listed["entries"].as_array().unwrap().iter().find(|entry| entry["id"]=="undo-partial-discard").unwrap();
        assert_eq!(entry["available"],json!(false));
        assert_eq!(entry["partial"],json!(true));
        assert!(entry["undoneAt"].as_str().is_some());
        assert_eq!(entry["applied"],json!(["a.txt"]));
        assert_eq!(entry["remaining"],json!(["b.txt"]));
    }

    #[test]
    fn undo_list_counts_recycled_paths_separately_from_undoable_ones() {
        let (temp, db, project) = setup(); let root = temp.path();
        fs::write(root.join("a.txt"),"tracked edit").unwrap();
        fs::write(root.join("untracked.txt"),"recycle me").unwrap();
        let _hooks = discard_test_hooks::install(true, None);
        let discard = discard_request(&db,&project,&["a.txt","untracked.txt"],"undo-mixed-discard");
        let result = call(&db,"git.discard",discard).unwrap();
        let undo_id = result["undoId"].as_str().expect("tracked paths stay undoable").to_owned();
        let listed = call(&db,"git.undo.list",json!({"projectId":project})).unwrap();
        let entry = listed["entries"].as_array().unwrap().iter().find(|entry| entry["id"]==undo_id.as_str()).unwrap();
        // Only the tracked path is undoable; the recycled path is counted apart.
        assert_eq!(entry["paths"],json!(["a.txt"]));
        assert_eq!(entry["pathCount"],json!(1));
        assert_eq!(entry["recycledCount"],json!(1));
        let label = entry["label"].as_str().unwrap();
        assert_eq!(label,"Discarded changes in 1 file (1 more moved to the Recycle Bin)");
    }

    #[test]
    fn discard_keeps_displaced_original_when_journal_update_fails() {
        let (temp, db, project) = setup(); let root = temp.path();
        fs::write(root.join("a.txt"),"confirmed original bytes").unwrap();
        let request = discard_request(&db,&project,&["a.txt"],"discard-update-fail");
        db.transaction(|tx| { tx.execute_batch("CREATE TRIGGER reject_undo_update BEFORE UPDATE ON git_undo BEGIN SELECT RAISE(ABORT,'journal unavailable'); END;")?; Ok(()) }).unwrap();
        let error = call(&db,"git.discard",request).unwrap_err().to_string();
        assert!(error.starts_with("discard_incomplete:"),"{error}");
        let kept: Value = serde_json::from_str(error.rsplit("; keptDisplaced: ").next().unwrap()).unwrap();
        let kept = kept.as_str().expect("recovery path reported");
        assert_eq!(fs::read(root.join(kept)).unwrap(),b"confirmed original bytes");
        assert_eq!(fs::read(root.join("a.txt")).unwrap(),b"base");
        assert!(db.external_operation_pending("discard-update-fail").unwrap());
        assert!(db.operation("discard-update-fail").unwrap().is_none());
    }

}
