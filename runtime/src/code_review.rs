//! Chat Code Review: user-started finder → (optional) verifier pipeline shown as
//! one parent-chat subagent card. Diff capture and prompt framing share
//! `agent_review` helpers; reviewer sessions are hidden and tool-restricted.
use crate::{
    agent_review,
    db::Database,
    domain::ChatItem,
    providers::{ProviderRuntime, Providers},
    review::ReviewFile,
};
use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const FOCUS_BUDGET: usize = 4 * 1024;
const CATALOG_BYTES: usize = 16 * 1024;
const CATALOG_CHOICES: usize = 200;
const FINDER_CAP: usize = 30;
const MERGE_CAP: usize = 40;
/// At most one live card refresh per second while a stage runs.
const CARD_LIVE_REFRESH: Duration = Duration::from_secs(1);
const STAGE_POLL: Duration = Duration::from_millis(500);
/// Ceiling per finder/verifier stage; cancel is the normal stop.
const STAGE_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const BUILT_IN: &str = "Review code you did not write. Look only for wrong behaviour, crashes, security problems, data loss or missing safeguards. Skip style, naming and formatting. An empty list is a good answer when nothing qualifies. Do NOT edit files or run commands that change anything. Cite path:line relative to the worktree root.";
const FINDER_BLOCK: &str = "## Required final response\n\nFinish with a fenced block with info string `threadterm-review` containing a JSON array:\n\n```threadterm-review\n[{\"severity\":\"high|medium|low|info\",\"path\":\"rel/path\",\"line\":12,\"title\":\"…\",\"body\":\"…\",\"category\":\"…\",\"failureScenario\":\"concrete inputs or state that lead to the wrong result\"}]\n```\n\nPath and line are optional. Reply with an empty array if you find nothing.";
const VERIFIER_BLOCK: &str = "## Required final response\n\nFor each candidate below, read the code and try to refute it. Finish with a fenced `threadterm-review` JSON array that keeps each candidate's `id` and adds `verdict` (`confirmed`|`plausible`|`rejected`) and a one-line `reason`. You may lower severity. Do not add new findings.\n\n```threadterm-review\n[{\"id\":\"c1\",\"severity\":\"high|medium|low|info\",\"path\":\"rel/path\",\"line\":12,\"title\":\"…\",\"body\":\"…\",\"verdict\":\"confirmed|plausible|rejected\",\"reason\":\"…\"}]\n```";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS code_reviews (
 id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL,
 provider TEXT NOT NULL,
 model TEXT,
 thinking TEXT,
 depth TEXT NOT NULL,
 scope_json TEXT NOT NULL,
 scope_label TEXT NOT NULL,
 focus TEXT,
 root TEXT NOT NULL,
 state TEXT NOT NULL,
 stage TEXT NOT NULL,
 stages_done INTEGER NOT NULL DEFAULT 0,
 stages_total INTEGER NOT NULL,
 candidates INTEGER,
 rejected INTEGER,
 findings_json TEXT,
 warnings_json TEXT NOT NULL DEFAULT '[]',
 fingerprint_start TEXT,
 card_rev INTEGER NOT NULL DEFAULT 0,
 error TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS code_reviews_session ON code_reviews(session_id, created_at);
CREATE TABLE IF NOT EXISTS code_review_sessions (
 review_id TEXT NOT NULL REFERENCES code_reviews(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 role TEXT NOT NULL,
 lens TEXT,
 stage_index INTEGER NOT NULL,
 turn_id TEXT,
 PRIMARY KEY (review_id, session_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS code_review_sessions_session ON code_review_sessions(session_id);
CREATE TABLE IF NOT EXISTS provider_option_catalog (
 provider TEXT PRIMARY KEY,
 options_json TEXT NOT NULL,
 seen_at TEXT NOT NULL
);";

static START_GATE: Mutex<()> = Mutex::new(());
/// The last card written per active review. Held for the whole card write, so a
/// slow live refresh can never land after a terminal card.
struct CardEmit {
    at: Instant,
    signature: String,
}
fn card_emit() -> &'static Mutex<HashMap<String, CardEmit>> {
    static CARD_EMIT: OnceLock<Mutex<HashMap<String, CardEmit>>> = OnceLock::new();
    CARD_EMIT.get_or_init(|| Mutex::new(HashMap::new()))
}
fn cancel_flags() -> &'static Mutex<HashMap<String, Arc<Mutex<bool>>>> {
    static CANCEL_FLAGS: OnceLock<Mutex<HashMap<String, Arc<Mutex<bool>>>>> = OnceLock::new();
    CANCEL_FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn fault(code: &str) -> anyhow::Error {
    crate::providers::ProviderError::new(code, code).into()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Depth {
    Quick,
    Standard,
    Thorough,
}

impl Depth {
    fn as_str(self) -> &'static str {
        match self {
            Self::Quick => "quick",
            Self::Standard => "standard",
            Self::Thorough => "thorough",
        }
    }
    fn stages_total(self) -> i64 {
        match self {
            Self::Quick => 1,
            Self::Standard => 2,
            Self::Thorough => 4,
        }
    }
    fn lenses(self) -> Vec<&'static str> {
        match self {
            Self::Thorough => vec!["correctness", "security", "regressions"],
            _ => vec!["general"],
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Scope {
    Uncommitted,
    Session,
    Branch,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartRequest {
    session_id: String,
    provider: String,
    model: Option<String>,
    thinking: Option<String>,
    depth: Depth,
    scope: Scope,
    focus: Option<String>,
    operation_id: String,
    lease_epoch: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelRequest {
    session_id: String,
    review_id: String,
    operation_id: String,
    lease_epoch: i64,
}

pub fn initialize(db: &Database) -> Result<()> {
    db.transaction(|tx| {
        tx.execute_batch(SCHEMA)?;
        let _ = tx.execute("ALTER TABLE code_reviews ADD COLUMN card_rev INTEGER NOT NULL DEFAULT 0", []);
        let _ = tx.execute("ALTER TABLE code_reviews ADD COLUMN ended_at TEXT", []);
        Ok(())
    })
}

/// Whether `session_id` is a Code Review finder or verifier, inside a projection
/// transaction. Legacy fixtures without the table read as not a reviewer.
pub(crate) fn is_reviewer_tx(tx: &Transaction<'_>, session_id: &str) -> Result<bool> {
    match tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM code_review_sessions WHERE session_id=?)",
        [session_id],
        |r| r.get(0),
    ) {
        Ok(value) => Ok(value),
        Err(rusqlite::Error::SqliteFailure(_, Some(message)))
            if message == "no such table: code_review_sessions" =>
        {
            Ok(false)
        }
        Err(error) => Err(error.into()),
    }
}

/// Active reviews interrupted by a runtime restart become failed; their child
/// sessions are left for `mark_live_sessions_interrupted`. Parent cards are
/// updated to failed so they never stay stuck on "running".
pub fn reconcile_interrupted(db: &Database) -> Result<usize> {
    let rows: Vec<(String, String)> = db.transaction(|tx| {
        let now = Utc::now().to_rfc3339();
        let mut statement = tx.prepare(
            "SELECT id, session_id FROM code_reviews WHERE state IN ('preparing','finding','verifying')",
        )?;
        let rows = statement
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, _) in &rows {
            tx.execute(
                "UPDATE code_reviews SET state='failed', stage='done', error=?, updated_at=? WHERE id=? AND state IN ('preparing','finding','verifying')",
                params!["ThreadTerm restarted during the review", now, id],
            )?;
        }
        Ok(rows)
    })?;
    for (id, parent) in &rows {
        let _ = upsert_card(db, parent, id, true);
    }
    // No review runs at startup, so every copy left by an earlier run is stale.
    remove_tree(&snapshot_root(db));
    Ok(rows.len())
}

pub(crate) fn is_hidden_reviewer(db: &Database, session_id: &str) -> Result<bool> {
    db.transaction(|tx| is_reviewer_tx(tx, session_id))
}

pub(crate) fn remember_provider_options(db: &Database, provider: &str, state: &Value) -> Result<()> {
    let Some(options) = state.get("options").and_then(Value::as_array) else {
        return Ok(());
    };
    let mut kept = Vec::new();
    for option in options {
        let category = option.get("category").and_then(Value::as_str).unwrap_or("");
        if category != "model" && category != "thinking" {
            continue;
        }
        let mut row = option.clone();
        if let Some(Value::Array(choices)) = row.get_mut("choices") {
            choices.truncate(CATALOG_CHOICES);
        }
        // Catalog stores choices and recommended values, not this session's selection.
        if let Some(obj) = row.as_object_mut() {
            if let Some(recommended) = obj.get("recommended").cloned() {
                obj.insert("value".into(), recommended);
            }
        }
        kept.push(row);
    }
    if kept.is_empty() {
        return Ok(());
    }
    let text = fit_catalog_json(&kept)?;
    db.transaction(|tx| {
        tx.execute(
            // `chat.options` runs often; an unchanged catalog is not rewritten.
            "INSERT INTO provider_option_catalog(provider,options_json,seen_at) VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET options_json=excluded.options_json,seen_at=excluded.seen_at WHERE options_json<>excluded.options_json",
            params![provider, text, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    })
}

/// Drop trailing choices, then whole options, until the JSON fits in 16 KiB.
pub(crate) fn fit_catalog_json(options: &[Value]) -> Result<String> {
    let mut kept = options.to_vec();
    loop {
        let text = serde_json::to_string(&kept)?;
        if text.len() <= CATALOG_BYTES {
            return Ok(text);
        }
        let mut trimmed = false;
        if let Some(Value::Object(obj)) = kept.last_mut() {
            if let Some(Value::Array(choices)) = obj.get_mut("choices") {
                if !choices.is_empty() {
                    choices.pop();
                    trimmed = true;
                }
            }
        }
        if !trimmed {
            if kept.pop().is_none() {
                return Ok("[]".into());
            }
        }
    }
}

fn read_only_kind(provider: &str) -> &'static str {
    match provider {
        "codex" | "claude" | "grok" => "enforced",
        _ => "requested",
    }
}

/// An agent that cannot be locked read-only reviews a throwaway copy instead of the
/// user's files, so it can run without asking for every command.
fn isolates(provider: &str) -> bool {
    read_only_kind(provider) == "requested"
}

/// Copies of reviewed code live beside the database, one folder per review.
pub(crate) fn snapshot_root(db: &Database) -> PathBuf {
    db.path().parent().unwrap_or_else(|| Path::new(".")).join("review-snapshots")
}

pub(crate) fn snapshot_dir(db: &Database, review_id: &str) -> PathBuf {
    snapshot_root(db).join(review_id)
}

/// Bounds for copying uncommitted work into a copy; beyond them the review asks as before.
const SNAPSHOT_FILES: usize = 20_000;
const SNAPSHOT_BYTES: u64 = 512 * 1024 * 1024;

/// A throwaway copy of `root` at the state under review: a shared local clone checked out
/// at the same commit, with the same branch, remote-tracking and tag refs but no remotes
/// (a reviewer has nowhere to push), plus every uncommitted and untracked file.
pub(crate) fn create_snapshot(root: &Path, dir: &Path) -> Result<()> {
    use crate::git_read::{git_text, run_git, LOCAL_TIMEOUT, NETWORK_TIMEOUT};
    if !remove_tree(dir) {
        return Err(anyhow!("an earlier copy could not be removed"));
    }
    fs::create_dir_all(dir.parent().unwrap_or(dir))?;
    let (source, target) = (root.to_string_lossy().into_owned(), dir.to_string_lossy().into_owned());
    // A clone and checkout of a large tree can outlast the 30 s budget of a read.
    run_git(root, &["clone", "--shared", "--no-checkout", "--quiet", ".", &target], &[], None, NETWORK_TIMEOUT)?;
    run_git(dir, &["remote", "remove", "origin"], &[], None, LOCAL_TIMEOUT)?;
    run_git(
        dir,
        &["fetch", "--quiet", "--update-head-ok", &source, "+refs/heads/*:refs/heads/*", "+refs/remotes/*:refs/remotes/*", "+refs/tags/*:refs/tags/*"],
        &[],
        None,
        NETWORK_TIMEOUT,
    )?;
    let head = git_text(root, &["rev-parse", "HEAD"])?.trim().to_owned();
    match git_text(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).map(|name| name.trim().to_owned()) {
        Ok(branch) if !branch.is_empty() => run_git(dir, &["checkout", "--quiet", "--force", &branch], &[], None, NETWORK_TIMEOUT)?,
        _ => run_git(dir, &["checkout", "--quiet", "--force", "--detach", &head], &[], None, NETWORK_TIMEOUT)?,
    };
    let (mut files, mut bytes) = (0usize, 0u64);
    for path in status_paths(root, true)? {
        let (from, to) = (root.join(&path), dir.join(&path));
        match fs::metadata(&from) {
            Ok(meta) if meta.is_file() => {
                files += 1;
                bytes += meta.len();
                if files > SNAPSHOT_FILES || bytes > SNAPSHOT_BYTES {
                    return Err(anyhow!("there are too many uncommitted files to copy"));
                }
                if let Some(parent) = to.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(&from, &to)?;
            }
            // A nested repository or submodule entry is not copied.
            Ok(_) => {}
            Err(_) => {
                let _ = fs::remove_file(&to);
            }
        }
    }
    Ok(())
}

/// Removes a review's copy once its reviewers have stopped. A provider process can hold
/// the folder briefly after stopping; a copy left behind goes at the next startup.
fn remove_snapshot(dir: &Path) {
    for _ in 0..20 {
        if remove_tree(dir) {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Git leaves some object files read-only, which Windows refuses to delete.
fn remove_tree(dir: &Path) -> bool {
    if !dir.exists() || fs::remove_dir_all(dir).is_ok() {
        return true;
    }
    clear_readonly(dir);
    fs::remove_dir_all(dir).is_ok()
}

/// Never follows a link or junction out of the copy: only real folders are entered.
fn clear_readonly(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => clear_readonly(&path),
            Ok(kind) if kind.is_file() => {
                if let Ok(meta) = fs::metadata(&path) {
                    let mut permissions = meta.permissions();
                    if permissions.readonly() {
                        #[allow(clippy::permissions_set_readonly_false)]
                        permissions.set_readonly(false);
                        let _ = fs::set_permissions(&path, permissions);
                    }
                }
            }
            _ => {}
        }
    }
}

fn catalog_option(db: &Database, provider: &str, category: &str) -> Result<Option<Value>> {
    let raw: Option<String> = db.transaction(|tx| {
        Ok(tx
            .query_row(
                "SELECT options_json FROM provider_option_catalog WHERE provider=?",
                [provider],
                |r| r.get(0),
            )
            .optional()?)
    })?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let Ok(Value::Array(rows)) = serde_json::from_str::<Value>(&raw) else {
        return Ok(None);
    };
    Ok(rows.into_iter().find(|row| row["category"] == category))
}

/// Counts changed paths without building diffs (for `codeReview.options`).
pub(crate) fn count_uncommitted_files(root: &Path) -> Result<usize> {
    Ok(status_paths(root, false)?.len())
}

/// Paths from `git status --porcelain=v1 -z --no-renames`: one `XY path` entry
/// each, so a rename is its delete plus its add and never a bare source path.
fn status_paths(root: &Path, every_untracked: bool) -> Result<Vec<String>> {
    let mut args = vec!["status", "--porcelain=v1", "-z", "--no-renames"];
    if every_untracked {
        args.push("--untracked-files=all");
    }
    let status = crate::git_read::run_git(root, &args, &[], None, crate::git_read::LOCAL_TIMEOUT)?;
    Ok(String::from_utf8_lossy(&status)
        .split('\0')
        .filter_map(|entry| entry.get(3..))
        .map(|path| path.replace('\\', "/"))
        .filter(|path| !path.is_empty())
        .collect())
}

pub(crate) fn count_session_files(db: &Database, session_id: &str) -> Result<usize> {
    let (first, last) = session_checkpoints(db, session_id)?;
    let Some(from) = first else {
        return Ok(0);
    };
    let to = last.filter(|id| id != &from);
    crate::review::changed_file_count(db, session_id, &from, to.as_deref())
}

pub(crate) fn count_branch_files(root: &Path) -> Result<usize> {
    let (_, merge_base) = default_branch_base(root)?;
    let output = crate::git_read::run_git(
        root,
        &["diff", "--name-only", "-z", "--relative", &merge_base, "HEAD", "--", "."],
        &[],
        None,
        crate::git_read::LOCAL_TIMEOUT,
    )?;
    Ok(String::from_utf8_lossy(&output)
        .split('\0')
        .filter(|path| !path.is_empty())
        .count())
}

fn session_checkpoints(db: &Database, session_id: &str) -> Result<(Option<String>, Option<String>)> {
    db.transaction(|tx| {
        let first: Option<String> = tx
            .query_row(
                "SELECT id FROM review_checkpoints WHERE session_id=? AND status='ready' ORDER BY created_at ASC, rowid ASC LIMIT 1",
                [session_id],
                |r| r.get(0),
            )
            .optional()?;
        let last: Option<String> = tx
            .query_row(
                "SELECT id FROM review_checkpoints WHERE session_id=? AND status='ready' ORDER BY created_at DESC, rowid DESC LIMIT 1",
                [session_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok((first, last))
    })
}

fn branch_available(root: &Path) -> bool {
    crate::git_read::repo_prefix(root).is_ok()
        && default_branch_base(root).is_ok()
}

fn default_branch_base(root: &Path) -> Result<(String, String)> {
    let head = crate::git_read::git_text(root, &["rev-parse", "HEAD"])?
        .trim()
        .to_owned();
    let current = crate::git_read::git_text(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty());
    let mut candidates = Vec::new();
    if let Ok(remote) = crate::git_read::git_text(root, &["config", "--get", "remote.pushDefault"]) {
        let remote = remote.trim();
        if !remote.is_empty() {
            if let Ok(sym) = crate::git_read::git_text(root, &["symbolic-ref", &format!("refs/remotes/{remote}/HEAD")]) {
                if let Some(branch) = sym.trim().rsplit('/').next() {
                    candidates.push(format!("{remote}/{branch}"));
                }
            }
        }
    }
    candidates.extend(["origin/main", "origin/master", "main", "master"].map(str::to_owned));
    for reference in candidates {
        if current.as_deref() == Some(reference.as_str()) {
            continue;
        }
        if let Ok(oid) = crate::git_read::git_text(root, &["rev-parse", "--verify", &reference]) {
            let oid = oid.trim().to_owned();
            if oid != head {
                if let Ok(merge) = crate::git_read::git_text(root, &["merge-base", &oid, &head]) {
                    return Ok((reference, merge.trim().to_owned()));
                }
            }
        }
    }
    Err(fault("review_empty"))
}

fn branch_snapshot(root: &Path) -> Result<(Vec<ReviewFile>, String)> {
    let (reference, merge_base) = default_branch_base(root)?;
    let output = crate::git_read::run_git(
        root,
        &["diff", "--name-status", "-z", "--no-renames", "--relative", &merge_base, "HEAD", "--", "."],
        &[],
        None,
        crate::git_read::LOCAL_TIMEOUT,
    )?;
    let listing = String::from_utf8_lossy(&output);
    let mut parts = listing.split('\0').filter(|s| !s.is_empty());
    let mut targets = Vec::new();
    while let (Some(status), Some(path)) = (parts.next(), parts.next()) {
        targets.push((path.to_owned(), status.chars().next().unwrap_or('M').to_string()));
    }
    targets.sort_by(|a, b| a.0.cmp(&b.0));
    let binary_paths = crate::review::binary_diff_paths(&crate::git_read::run_git(
        root,
        &["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative", &merge_base, "HEAD", "--", "."],
        &[],
        None,
        crate::git_read::LOCAL_TIMEOUT,
    )?);
    let deadline = Instant::now() + Duration::from_secs(60);
    let (mut remaining, mut exhausted) = (agent_review::DIFF_BUDGET, false);
    let mut files = Vec::new();
    for (path, status) in targets {
        let binary = binary_paths.contains(&path);
        let diff = if binary {
            Some(String::new())
        } else if exhausted {
            None
        } else {
            crate::review::bounded_unified_diff(
                root,
                &["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--relative", &merge_base, "HEAD", "--", &path],
                &[],
                remaining,
                deadline,
            )?
        };
        files.push(agent_review::retain_file(
            ReviewFile { path, status, diff, binary },
            &mut remaining,
            &mut exhausted,
        ));
    }
    Ok((
        files,
        format!("Branch changes versus {reference} (merge-base {merge_base})."),
    ))
}

fn capture_scope(
    db: &Database,
    session: &crate::domain::Session,
    root: &Path,
    scope: &Scope,
) -> Result<(Vec<ReviewFile>, String)> {
    match scope {
        Scope::Uncommitted => {
            crate::git_read::repo_prefix(root).map_err(|_| fault("review_empty"))?;
            let head = crate::git_read::git_text(root, &["rev-parse", "--short", "HEAD"])?;
            let files = agent_review::uncommitted_snapshot(root)?;
            Ok((files, format!("Uncommitted changes against HEAD {}.", head.trim())))
        }
        Scope::Session => {
            let (first, last) = session_checkpoints(db, &session.id)?;
            let Some(from) = first else {
                return Err(fault("review_empty"));
            };
            let to = last.filter(|id| id != &from);
            let files = crate::review::unified_snapshot(db, &session.id, &from, to.as_deref())?;
            Ok((
                files,
                format!("This chat's changes from its first checkpoint up to its latest."),
            ))
        }
        Scope::Branch => branch_snapshot(root),
    }
}

fn worktree_fingerprint(root: &Path) -> Result<String> {
    // Every untracked file is listed, so an edit inside a new folder is seen too.
    let paths = status_paths(root, true)?;
    let mut hasher = Sha256::new();
    for (index, path) in paths.iter().enumerate() {
        hasher.update(path.as_bytes());
        hasher.update(b"\0");
        if index >= 200 {
            continue;
        }
        match fs::read(root.join(path)) {
            Ok(bytes) => hasher.update(&bytes),
            Err(_) => hasher.update(b"missing"),
        }
    }
    Ok(hex::encode(hasher.finalize()))
}

fn changed_paths(root: &Path, before: &str, after: &str) -> Vec<String> {
    if before == after {
        return Vec::new();
    }
    match status_paths(root, false) {
        Ok(paths) if !paths.is_empty() => paths.into_iter().take(12).collect(),
        // The worktree differs from the start but is clean now: an edit was undone.
        Ok(_) => vec!["(changes since undone)".into()],
        Err(_) => vec!["(status unavailable)".into()],
    }
}

pub(crate) fn build_finder_prompt(
    root: &Path,
    scope_label: &str,
    files: &[ReviewFile],
    focus: Option<&str>,
    lens: &str,
) -> (String, &'static str, Vec<String>) {
    let repository = crate::workspace_services::scoped_path(root, ".threadterm/review.md", true)
        .ok()
        .and_then(|p| fs::metadata(&p).ok().filter(|m| m.is_file() && m.len() <= 64 * 1024).map(|_| p))
        .and_then(|p| {
            use std::io::Read;
            let mut bytes = Vec::new();
            fs::File::open(p).ok()?.take(64 * 1024 + 1).read_to_end(&mut bytes).ok()?;
            Some(bytes)
        })
        .filter(|bytes| bytes.len() <= 64 * 1024)
        .and_then(|bytes| String::from_utf8(bytes).ok());
    let instructions = if repository.is_some() { "repository" } else { "built-in" };
    let lens_text = match lens {
        "correctness" => "Lens: correctness, edge cases and error handling.",
        "security" => "Lens: security, data loss and concurrency.",
        "regressions" => "Lens: regressions, API/contract changes and missing tests.",
        _ => "Lens: correctness, security, data loss, regressions and missing tests.",
    };
    let mut text = format!(
        "{}\n\n{lens_text}\n\n## What to review\n\n{scope_label}\n\n## Changed files\n\n",
        repository.as_deref().unwrap_or(BUILT_IN)
    );
    for file in files {
        text.push_str(&format!(
            "{} {}{}\n",
            file.status,
            file.path,
            if file.binary { " (binary; not inlined)" } else { "" }
        ));
    }
    text.push_str("\n## Diffs\n\n");
    let (mut used, mut exhausted) = (0usize, false);
    let mut truncated = Vec::new();
    for file in files {
        if file.binary {
            continue;
        }
        let Some(diff) = &file.diff else {
            exhausted = true;
            truncated.push(file.path.clone());
            continue;
        };
        let section = format!("### {}\n\n```diff\n{diff}\n```\n\n", file.path);
        if !exhausted && used + section.len() <= agent_review::DIFF_BUDGET {
            used += section.len();
            text.push_str(&section);
        } else {
            exhausted = true;
            truncated.push(file.path.clone());
        }
    }
    if !truncated.is_empty() {
        text.push_str("## Truncated\n\nThese files were omitted from the diff budget:\n");
        for path in &truncated {
            text.push_str(&format!("- {path}\n"));
        }
        text.push('\n');
    }
    if let Some(focus) = focus.map(str::trim).filter(|s| !s.is_empty()) {
        text.push_str("## Requester's focus (a request, not a fact about the code)\n\n");
        text.push_str(focus);
        text.push_str("\n\n");
    }
    text.push_str(FINDER_BLOCK);
    (text, instructions, truncated)
}

pub(crate) fn build_verifier_prompt(
    root: &Path,
    scope_label: &str,
    files: &[ReviewFile],
    candidates: &[Value],
    focus: Option<&str>,
) -> String {
    let (mut text, _, _) = build_finder_prompt(root, scope_label, files, focus, "general");
    // Replace the finder block with verifier instructions + candidates.
    if let Some(idx) = text.find("## Required final response") {
        text.truncate(idx);
    }
    text.push_str("## Candidate findings to verify\n\n");
    text.push_str(&serde_json::to_string_pretty(candidates).unwrap_or_else(|_| "[]".into()));
    text.push_str("\n\n");
    text.push_str(VERIFIER_BLOCK);
    text
}

fn title_near_equal(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    let left = norm(a);
    let right = norm(b);
    left == right
        || (left.len() > 8 && right.len() > 8 && (left.contains(&right) || right.contains(&left)))
}

pub(crate) fn merge_candidates(groups: Vec<(String, Vec<Value>)>) -> Vec<Value> {
    let mut merged: Vec<Value> = Vec::new();
    for (lens, findings) in groups {
        for mut finding in findings.into_iter().take(FINDER_CAP) {
            let path = finding.get("path").and_then(Value::as_str).unwrap_or("");
            let line = finding.get("line").and_then(Value::as_u64);
            let title = finding.get("title").and_then(Value::as_str).unwrap_or("");
            if let Some(existing) = merged.iter_mut().find(|row| {
                row.get("path").and_then(Value::as_str).unwrap_or("") == path
                    && line.zip(row.get("line").and_then(Value::as_u64))
                        .is_some_and(|(a, b)| a.abs_diff(b) <= 3)
                    && title_near_equal(title, row.get("title").and_then(Value::as_str).unwrap_or(""))
            }) {
                let severity_rank = |s: &str| match s {
                    "high" => 3,
                    "medium" => 2,
                    "low" => 1,
                    _ => 0,
                };
                if severity_rank(finding["severity"].as_str().unwrap_or(""))
                    > severity_rank(existing["severity"].as_str().unwrap_or(""))
                {
                    existing["severity"] = finding["severity"].clone();
                    existing["body"] = finding["body"].clone();
                    if finding.get("failureScenario").is_some() {
                        existing["failureScenario"] = finding["failureScenario"].clone();
                    }
                }
                let mut lenses = existing
                    .get("lenses")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if !lenses.iter().any(|v| v == &json!(lens)) {
                    lenses.push(json!(lens));
                }
                existing["lenses"] = json!(lenses);
            } else {
                finding["lenses"] = json!([lens]);
                finding["verdict"] = json!("unverified");
                merged.push(finding);
                if merged.len() == MERGE_CAP {
                    assign_candidate_ids(&mut merged);
                    return merged;
                }
            }
        }
    }
    assign_candidate_ids(&mut merged);
    merged
}

fn assign_candidate_ids(findings: &mut [Value]) {
    for (index, finding) in findings.iter_mut().enumerate() {
        finding["id"] = json!(format!("c{}", index + 1));
    }
}

pub(crate) fn apply_verifier(candidates: &[Value], verified: &[Value]) -> (Vec<Value>, usize) {
    let mut rejected = 0usize;
    let mut out = Vec::new();
    for candidate in candidates {
        let id = candidate.get("id").and_then(Value::as_str).unwrap_or("");
        let title = candidate.get("title").and_then(Value::as_str).unwrap_or("");
        let path = candidate.get("path").and_then(Value::as_str).unwrap_or("");
        let match_row = verified
            .iter()
            .find(|row| {
                let row_id = row.get("id").and_then(Value::as_str).unwrap_or("");
                !id.is_empty() && row_id == id
            })
            .or_else(|| {
                verified.iter().find(|row| {
                    row.get("title").and_then(Value::as_str).unwrap_or("") == title
                        && row.get("path").and_then(Value::as_str).unwrap_or("") == path
                })
            });
        let Some(row) = match_row else {
            let mut keep = candidate.clone();
            keep["verdict"] = json!("unverified");
            out.push(keep);
            continue;
        };
        let verdict = row.get("verdict").and_then(Value::as_str).unwrap_or("plausible");
        if verdict == "rejected" {
            rejected += 1;
            continue;
        }
        let mut keep = candidate.clone();
        keep["verdict"] = json!(if verdict == "confirmed" { "confirmed" } else { "plausible" });
        if let Some(reason) = row.get("reason") {
            keep["reason"] = reason.clone();
        }
        if let Some(severity) = row.get("severity") {
            let rank = |s: &str| match s {
                "high" => 3,
                "medium" => 2,
                "low" => 1,
                _ => 0,
            };
            if rank(severity.as_str().unwrap_or("")) < rank(keep["severity"].as_str().unwrap_or("")) {
                keep["severity"] = severity.clone();
            }
        }
        out.push(keep);
    }
    (out, rejected)
}

fn review_key(id: &str) -> String {
    format!("review:{id}")
}

fn card_id(session: &str, key: &str) -> String {
    format!("{session}:system:subagent:{key}")
}

fn active_review(db: &Database, session_id: &str) -> Result<Option<String>> {
    db.transaction(|tx| {
        Ok(tx
            .query_row(
                "SELECT id FROM code_reviews WHERE session_id=? AND state IN ('preparing','finding','verifying') ORDER BY created_at DESC LIMIT 1",
                [session_id],
                |r| r.get(0),
            )
            .optional()?)
    })
}

fn reviewer_ids(db: &Database, review_id: &str) -> Result<Vec<String>> {
    db.transaction(|tx| reviewer_ids_tx(tx, review_id))
}

fn summary_value(db: &Database, review_id: &str) -> Result<Value> {
    db.transaction(|tx| {
        let row = tx.query_row(
            "SELECT id,depth,scope_label,model,stage,stages_done,stages_total,candidates,rejected,findings_json,warnings_json FROM code_reviews WHERE id=?",
            [review_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                    r.get::<_, Option<String>>(9)?,
                    r.get::<_, String>(10)?,
                ))
            },
        )?;
        let mut summary = json!({
            "reviewId": row.0,
            "depth": row.1,
            "scopeLabel": row.2,
            "stage": row.4,
            "stagesDone": row.5,
            "stagesTotal": row.6,
            "reviewerSessionIds": reviewer_ids_tx(tx, review_id)?,
        });
        if let Some(model) = row.3 {
            summary["model"] = json!(model);
        }
        if let Some(candidates) = row.7 {
            summary["candidates"] = json!(candidates);
        }
        if let Some(rejected) = row.8 {
            summary["rejected"] = json!(rejected);
        }
        if let Some(findings) = row.9 {
            summary["findings"] = serde_json::from_str(&findings).unwrap_or(json!([]));
        }
        let warnings: Value = serde_json::from_str(&row.10).unwrap_or(json!([]));
        if warnings.as_array().is_some_and(|v| !v.is_empty()) {
            summary["warnings"] = warnings;
        }
        Ok(summary)
    })
}

fn reviewer_ids_tx(tx: &Transaction<'_>, review_id: &str) -> Result<Vec<String>> {
    let mut statement = tx.prepare(
        "SELECT session_id FROM code_review_sessions WHERE review_id=? ORDER BY stage_index ASC, session_id ASC",
    )?;
    let rows = statement
        .query_map([review_id], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The collapsed card line: live stage progress, or the result once it ends.
fn card_preview(summary: &Value, status: &str, error: Option<&str>) -> String {
    let count = |key: &str| summary[key].as_i64().unwrap_or(0);
    match status {
        "failed" => error.unwrap_or("The review failed").to_owned(),
        "cancelled" => "Cancelled".into(),
        "running" => {
            let finders = if summary["depth"] == "quick" { 1 } else { (count("stagesTotal") - 1).max(1) };
            match summary["stage"].as_str().unwrap_or("") {
                "finding" => format!("Finding issues · {}/{finders}", count("stagesDone").min(finders)),
                "verifying" => match count("candidates") {
                    1 => "Verifying 1 finding".to_owned(),
                    candidates => format!("Verifying {candidates} findings"),
                },
                _ => "Preparing".into(),
            }
        }
        _ => {
            let findings = summary["findings"].as_array().cloned().unwrap_or_default();
            let tally = |verdict: &str| findings.iter().filter(|f| f["verdict"] == verdict).count();
            let (confirmed, plausible) = (tally("confirmed"), tally("plausible"));
            let unverified = findings.len() - confirmed - plausible;
            let mut parts = Vec::new();
            if confirmed > 0 {
                parts.push(format!("{confirmed} confirmed"));
            }
            if plausible > 0 {
                parts.push(format!("{plausible} plausible"));
            }
            if unverified > 0 {
                parts.push(format!("{unverified} unverified"));
            }
            if parts.is_empty() { "No issues found".into() } else { parts.join(" · ") }
        }
    }
}

/// Reviewer activity for the card. SQL aggregates keep a once-per-second refresh
/// from decoding whole transcripts; `size` changes whenever any reviewer item does.
struct Progress {
    items: i64,
    size: f64,
    tools: i64,
    last: Option<String>,
}

fn live_card_progress(tx: &Transaction<'_>, review_id: &str) -> Result<Progress> {
    const REVIEWERS: &str = "SELECT session_id FROM code_review_sessions WHERE review_id=?1";
    let (items, size) = tx.query_row(
        &format!("SELECT COUNT(*), TOTAL(length(data)) FROM chat_items WHERE session_id IN ({REVIEWERS})"),
        [review_id],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?)),
    )?;
    let tools = tx.query_row(
        &format!("SELECT COUNT(*) FROM chat_items c, json_each(c.data,'$.parts') p WHERE c.session_id IN ({REVIEWERS}) AND json_extract(p.value,'$.type')='tool'"),
        [review_id],
        |r| r.get::<_, i64>(0),
    )?;
    let last = tx
        .query_row(
            &format!("SELECT CAST(COALESCE(json_extract(p.value,'$.toolName'),json_extract(p.value,'$.data.title'),json_extract(p.value,'$.data.name')) AS TEXT) FROM chat_items c, json_each(c.data,'$.parts') p WHERE c.session_id IN ({REVIEWERS}) AND json_extract(p.value,'$.type')='tool' ORDER BY c.created_at DESC, c.rowid DESC, p.key DESC LIMIT 1"),
            [review_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .map(|label| label.trim().chars().take(120).collect::<String>())
        .filter(|label| !label.is_empty());
    Ok(Progress { items, size, tools, last })
}

fn card_status(state: &str) -> &'static str {
    match state {
        "done" => "completed",
        "failed" => "failed",
        "cancelled" => "cancelled",
        _ => "running",
    }
}

/// Writes the parent's review card from the stored review. The status comes from
/// the review's state, never from the caller, and writes are serialized, so a
/// stale live refresh cannot reopen a finished card. An unchanged card is not
/// rewritten; `force` only skips the once-per-second throttle.
pub(crate) fn upsert_card(db: &Database, parent: &str, review_id: &str, force: bool) -> Result<()> {
    let mut emitted = card_emit().lock().map_err(|_| anyhow!("card emit poisoned"))?;
    let now = Instant::now();
    if !force && emitted.get(review_id).is_some_and(|last| now.duration_since(last.at) < CARD_LIVE_REFRESH) {
        return Ok(());
    }
    let summary = summary_value(db, review_id)?;
    let (state, provider, started_at, error, progress) = db.transaction(|tx| {
        let (state, provider, started_at, error) = tx.query_row(
            "SELECT state, provider, created_at, error FROM code_reviews WHERE id=?",
            [review_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?)),
        )?;
        Ok((state, provider, started_at, error, live_card_progress(tx, review_id)?))
    })?;
    let status = card_status(&state);
    let preview = card_preview(&summary, status, error.as_deref());
    let signature = json!([status, summary, progress.items, progress.size, progress.tools, progress.last, preview]).to_string();
    if emitted.get(review_id).is_some_and(|last| last.signature == signature) {
        return Ok(());
    }
    let key = review_key(review_id);
    let id = card_id(parent, &key);
    let terminal = status != "running";
    db.transaction(|tx| {
        tx.execute("UPDATE code_reviews SET card_rev=card_rev+1 WHERE id=?", [review_id])?;
        if terminal {
            tx.execute(
                "UPDATE code_reviews SET ended_at=COALESCE(ended_at,?) WHERE id=?",
                params![Utc::now().to_rfc3339(), review_id],
            )?;
        }
        let (rev, ended_at): (i64, Option<String>) = tx.query_row(
            "SELECT card_rev, ended_at FROM code_reviews WHERE id=?",
            [review_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let mut info = json!({
            "key": key,
            "provider": provider,
            "agentType": "code-review",
            "name": "Code review",
            "description": summary["scopeLabel"].clone(),
            "status": status,
            "transcript": "session",
            "review": summary,
            "startedAt": started_at,
            "toolCount": progress.tools,
            "itemCount": progress.items,
            "summary": preview,
            "rev": rev,
        });
        if let Some(activity) = &progress.last {
            info["lastActivity"] = json!(activity);
        }
        if let Some(ended_at) = ended_at.filter(|_| terminal) {
            info["endedAt"] = json!(ended_at);
        }
        let created_at: Option<String> = tx
            .query_row("SELECT created_at FROM chat_items WHERE id=?", [&id], |r| r.get(0))
            .optional()?;
        let item = ChatItem {
            id: id.clone(),
            role: "system".into(),
            parts: vec![json!({"type":"subagent","toolId":key,"status":status,"data":info})],
            created_at: created_at.unwrap_or_else(|| started_at.clone()),
            turn_id: None,
            elapsed_ms: None,
            turn_status: None,
            turn_origin: None,
            fork_anchor: None,
            turn_model: None,
            turn_usage: None,
            turn_review: None,
        };
        tx.execute(
            "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES (?,?,NULL,'message',?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            params![item.id, parent, serde_json::to_string(&item)?, item.created_at],
        )?;
        tx.execute(
            "INSERT INTO outbox(event,data,created_at) VALUES ('chat.item',?,?)",
            params![json!({"sessionId":parent,"item":item}).to_string(), Utc::now().to_rfc3339()],
        )?;
        Ok(())
    })?;
    if terminal {
        emitted.remove(review_id);
    } else {
        emitted.insert(review_id.to_owned(), CardEmit { at: now, signature });
    }
    Ok(())
}

/// Moves an active review to `state`; a review that already ended is left alone.
fn bump_stage(db: &Database, review_id: &str, stage: &str, done: i64, state: &str) -> Result<bool> {
    db.transaction(|tx| {
        let changed = tx.execute(
            "UPDATE code_reviews SET stage=?, stages_done=?, state=?, updated_at=? WHERE id=? AND state IN ('preparing','finding','verifying')",
            params![stage, done, state, Utc::now().to_rfc3339(), review_id],
        )?;
        Ok(changed > 0)
    })
}

/// Counts one finished finder (answered or failed) while the review is finding.
fn finish_finder(db: &Database, review_id: &str) -> Result<()> {
    db.transaction(|tx| {
        tx.execute(
            "UPDATE code_reviews SET stages_done=stages_done+1, updated_at=? WHERE id=? AND state='finding'",
            params![Utc::now().to_rfc3339(), review_id],
        )?;
        Ok(())
    })
}

/// Fails an active review with `error`, keeping the stages it finished.
fn fail_review(db: &Database, review_id: &str, error: &str) -> Result<bool> {
    db.transaction(|tx| {
        let changed = tx.execute(
            "UPDATE code_reviews SET stage='done', state='failed', error=?, updated_at=? WHERE id=? AND state IN ('preparing','finding','verifying')",
            params![error, Utc::now().to_rfc3339(), review_id],
        )?;
        Ok(changed > 0)
    })
}

fn cancel_review(db: &Database, review_id: &str) -> Result<bool> {
    db.transaction(|tx| {
        let changed = tx.execute(
            "UPDATE code_reviews SET stage='done', state='cancelled', updated_at=? WHERE id=? AND state IN ('preparing','finding','verifying')",
            params![Utc::now().to_rfc3339(), review_id],
        )?;
        Ok(changed > 0)
    })
}

fn push_warning(db: &Database, review_id: &str, warning: &str) -> Result<()> {
    db.transaction(|tx| {
        let raw: String = tx.query_row("SELECT warnings_json FROM code_reviews WHERE id=?", [review_id], |r| r.get(0))?;
        let mut warnings: Vec<Value> = serde_json::from_str(&raw).unwrap_or_default();
        warnings.push(json!(warning));
        // A review that already ended keeps the warnings it ended with.
        tx.execute(
            "UPDATE code_reviews SET warnings_json=?, updated_at=? WHERE id=? AND state IN ('preparing','finding','verifying')",
            params![json!(warnings).to_string(), Utc::now().to_rfc3339(), review_id],
        )?;
        Ok(())
    })
}

fn set_findings(
    db: &Database,
    review_id: &str,
    findings: &[Value],
    candidates: Option<usize>,
    rejected: Option<usize>,
) -> Result<bool> {
    db.transaction(|tx| {
        let changed = tx.execute(
            "UPDATE code_reviews SET findings_json=?, candidates=COALESCE(?,candidates), rejected=COALESCE(?,rejected), updated_at=? WHERE id=? AND state IN ('preparing','finding','verifying')",
            params![
                json!(findings).to_string(),
                candidates.map(|v| v as i64),
                rejected.map(|v| v as i64),
                Utc::now().to_rfc3339(),
                review_id
            ],
        )?;
        Ok(changed > 0)
    })
}

/// The newest assistant text of the bound turn. A trailing tool-only item is
/// skipped, so the fenced findings block in the last text reply is what is read.
fn last_answer_text(db: &Database, reviewer: &str, turn: &str) -> Result<String> {
    db.transaction(|tx| {
        let mut statement = tx.prepare(
            "SELECT data FROM chat_items WHERE session_id=? AND turn_id=? AND json_extract(data,'$.role')='assistant' ORDER BY created_at DESC,id DESC",
        )?;
        let mut rows = statement.query(params![reviewer, turn])?;
        while let Some(row) = rows.next()? {
            let item: ChatItem = serde_json::from_str(&row.get::<_, String>(0)?)?;
            let text = item
                .parts
                .iter()
                .filter(|p| p["type"] == "text")
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            if !text.trim().is_empty() {
                return Ok(text);
            }
        }
        Ok(String::new())
    })
}

fn bound_turn_status(db: &Database, reviewer: &str, turn: &str) -> Result<Option<String>> {
    db.transaction(|tx| {
        let mut statement = tx.prepare(
            "SELECT json_extract(data,'$.turnStatus') FROM chat_items WHERE session_id=? AND turn_id=? AND json_extract(data,'$.turnStatus') IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1",
        )?;
        Ok(statement
            .query_row(params![reviewer, turn], |r| r.get::<_, Option<String>>(0))
            .optional()?
            .flatten())
    })
}

fn wait_for_answer(
    db: &Database,
    reviewer: &str,
    turn: &str,
    cancel: &Arc<Mutex<bool>>,
    parent: &str,
    review_id: &str,
) -> Result<Option<String>> {
    if turn.is_empty() {
        return Err(anyhow!("The reviewer turn did not start"));
    }
    let deadline = Instant::now() + STAGE_TIMEOUT;
    while Instant::now() < deadline {
        if *cancel.lock().map_err(|_| anyhow!("cancel poisoned"))? {
            return Ok(None);
        }
        let session = db.session_by_id(reviewer)?;
        let Some(session) = session else {
            return Err(fault("reviewer_deleted"));
        };
        if matches!(session.status.as_str(), "exited" | "interrupted" | "error") {
            return Err(anyhow!("The reviewer session {} before completing", session.status));
        }
        match bound_turn_status(db, reviewer, turn)?.as_deref() {
            Some("completed") => return Ok(Some(last_answer_text(db, reviewer, turn)?)),
            Some(status @ ("failed" | "interrupted" | "cancelled" | "canceled")) => {
                return Err(anyhow!("The reviewer turn ended with status {status}"));
            }
            _ => {}
        }
        let _ = upsert_card(db, parent, review_id, false);
        std::thread::sleep(STAGE_POLL);
    }
    Err(anyhow!("The reviewer timed out"))
}

/// The chat's folder inside the copy (the copy's root when the folder is not there).
fn snapshot_cwd(root: &Path, cwd: &str, dir: &Path) -> String {
    let cwd = PathBuf::from(cwd);
    let cwd = crate::git_read::plain_path(&cwd.canonicalize().unwrap_or(cwd));
    let inside = cwd.strip_prefix(root).ok().map(|relative| dir.join(relative)).filter(|path| path.is_dir());
    inside.unwrap_or_else(|| dir.to_path_buf()).to_string_lossy().into_owned()
}

/// In a copy the reviewer stops asking: Kimi's never-ask mode. Pi never asks, and
/// OpenCode keeps its own permission settings, so it may still ask.
pub(crate) fn stage_never_ask(db: &Database, reviewer: &str, provider: &str) -> Result<()> {
    if provider == "kimi" {
        crate::delegation::stage_authority(db, reviewer, &[("mode", "yolo")])?;
    }
    Ok(())
}

fn stage_read_only(db: &Database, providers: &Providers, reviewer: &str, provider: &str) -> Result<()> {
    match provider {
        "codex" => {
            crate::delegation::stage_authority(db, reviewer, &[("sandbox", "read-only")])?;
        }
        "claude" | "grok" => {
            crate::delegation::stage_authority(db, reviewer, &[("mode", "plan")])?;
        }
        _ => {}
    }
    let _ = providers;
    Ok(())
}

fn apply_read_only_after_connect(providers: &Providers, reviewer: &str, provider: &str) {
    if provider == "codex" {
        if providers
            .chat_options(reviewer)
            .ok()
            .and_then(|v| v["options"].as_array().cloned())
            .is_some_and(|options| {
                options.iter().any(|o| {
                    o["id"] == "sandbox"
                        && o["choices"].as_array().is_some_and(|c| c.iter().any(|c| c["value"] == "read-only"))
                })
            })
        {
            let _ = providers.chat_set_option(reviewer, "sandbox", "read-only");
        }
    }
    if matches!(provider, "claude" | "grok") {
        if providers
            .chat_options(reviewer)
            .ok()
            .and_then(|v| v["options"].as_array().cloned())
            .is_some_and(|options| {
                options.iter().any(|o| o["id"] == "mode" && o["choices"].as_array().is_some_and(|c| c.iter().any(|c| c["value"] == "plan")))
            })
        {
            let _ = providers.chat_set_option(reviewer, "mode", "plan");
        }
    }
}

/// Stops the reviewers' provider processes once a review ends, so finished
/// reviews leave no idle agents behind. A cancel also marks the sessions
/// interrupted and cancels their turns first.
fn stop_reviewers(db: &Database, providers: &Arc<Providers>, review_id: &str, cancel: bool) -> Result<()> {
    let reviewers = reviewer_ids(db, review_id)?;
    if cancel {
        for reviewer in &reviewers {
            let _ = db.set_session_status(reviewer, "interrupted", None);
        }
    }
    // Provider cancel/stop can block on a worker still inside send/capture; run
    // them off-thread so the review can already be terminal and waiters exit.
    // An isolated review's copy goes once its reviewers have let go of it.
    let snapshot = snapshot_dir(db, review_id);
    if !reviewers.is_empty() {
        let providers = Arc::clone(providers);
        let _ = std::thread::Builder::new()
            .name("code-review-stop".into())
            .spawn(move || {
                for reviewer in reviewers {
                    if cancel {
                        let _ = providers.chat_cancel(&reviewer, "");
                    }
                    let _ = providers.chat_stop(&reviewer);
                }
                remove_snapshot(&snapshot);
            });
    } else {
        remove_snapshot(&snapshot);
    }
    Ok(())
}

fn options(db: &Database, providers: &Providers, session_id: &str) -> Result<Value> {
    let session = db.session_by_id(session_id)?.ok_or_else(|| fault("session_not_found"))?;
    let cwd = crate::delegation::session_cwd(db, &session)?;
    let root = if let Some(project) = &session.project_id {
        crate::workspace_services::workspace_root_for_cwd(db, project, &cwd)?
    } else {
        PathBuf::from(&cwd).canonicalize()?
    };
    let root = crate::git_read::plain_path(&root);
    let capabilities = providers.capabilities();
    let mut provider_rows = Vec::new();
    for capability in capabilities {
        let id = capability.get("id").and_then(Value::as_str).unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let chat = capability.get("chat").and_then(Value::as_bool) == Some(true);
        let installed = capability.get("installed").and_then(Value::as_bool) == Some(true);
        let available = chat && installed;
        let mut row = json!({
            "id": id,
            "name": capability.get("name").and_then(Value::as_str).unwrap_or(id),
            "available": available,
            "readOnly": read_only_kind(id),
        });
        if !available {
            row["reason"] = json!(if !installed { "Not installed" } else { "Not Chat-capable" });
        }
        if let Some(model) = catalog_option(db, id, "model")? {
            row["model"] = model;
        }
        if let Some(thinking) = catalog_option(db, id, "thinking")? {
            row["thinking"] = thinking;
        }
        provider_rows.push(row);
    }
    let mut scopes = Vec::new();
    let uncommitted = count_uncommitted_files(&root).unwrap_or(0);
    scopes.push(json!({
        "kind":"uncommitted",
        "available": uncommitted > 0,
        "fileCount": uncommitted,
        "label":"Uncommitted changes",
        "reason": if uncommitted == 0 { Value::String("Nothing to review".into()) } else { Value::Null },
    }));
    let session_count = count_session_files(db, session_id).unwrap_or(0);
    scopes.push(json!({
        "kind":"session",
        "available": session_count > 0,
        "fileCount": session_count,
        "label":"This chat's changes",
        "reason": if session_count == 0 { Value::String("Nothing to review".into()) } else { Value::Null },
    }));
    let branch_ok = branch_available(&root);
    let branch_count = if branch_ok { count_branch_files(&root).unwrap_or(0) } else { 0 };
    scopes.push(json!({
        "kind":"branch",
        "available": branch_ok && branch_count > 0,
        "fileCount": branch_count,
        "label":"Branch vs base",
        "reason": if !branch_ok {
            Value::String("No known base branch".into())
        } else if branch_count == 0 {
            Value::String("Nothing to review".into())
        } else {
            Value::Null
        },
    }));
    for scope in &mut scopes {
        if scope["reason"].is_null() {
            scope.as_object_mut().map(|o| o.remove("reason"));
        }
    }
    let mut result = json!({"providers": provider_rows, "scopes": scopes});
    if let Some(active) = active_review(db, session_id)? {
        result["active"] = json!(active);
    }
    Ok(result)
}

fn create_reviewer_session(
    db: &Database,
    parent: &crate::domain::Session,
    cwd: &str,
    provider: &str,
    title: &str,
    operation: &str,
    create: &dyn Fn(&Value) -> Result<Value>,
) -> Result<String> {
    let created = create(&json!({
        "projectId": parent.project_id,
        "cwd": cwd,
        "title": title.chars().take(120).collect::<String>(),
        "provider": provider,
        "mode": "chat",
        "operationId": operation,
    }))?;
    let id = created["id"].as_str().ok_or_else(|| anyhow!("session_create_failed"))?.to_owned();
    let _ = (db, parent, title);
    Ok(id)
}

fn stage_catalog_selection(
    db: &Database,
    provider: &str,
    category: &str,
    value: &str,
    session_id: &str,
) -> Result<()> {
    let option = catalog_option(db, provider, category)?;
    if let Some(option) = &option {
        if let Some(choices) = option.get("choices").and_then(Value::as_array) {
            if !choices.is_empty()
                && !choices
                    .iter()
                    .any(|choice| choice.get("value").and_then(Value::as_str) == Some(value))
            {
                return Err(fault("invalid_request"));
            }
        }
        let id = option
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .unwrap_or(category);
        crate::delegation::stage_authority(db, session_id, &[(id, value)])?;
    } else {
        crate::delegation::stage_authority(db, session_id, &[(category, value)])?;
    }
    Ok(())
}

fn validate_catalog_selection(db: &Database, provider: &str, category: &str, value: &str) -> Result<()> {
    let Some(option) = catalog_option(db, provider, category)? else {
        return Ok(());
    };
    let Some(choices) = option.get("choices").and_then(Value::as_array) else {
        return Ok(());
    };
    if choices.is_empty() {
        return Ok(());
    }
    if choices
        .iter()
        .any(|choice| choice.get("value").and_then(Value::as_str) == Some(value))
    {
        Ok(())
    } else {
        Err(fault("invalid_request"))
    }
}

#[derive(Clone)]
struct PlannedSession {
    session_id: String,
    role: &'static str,
    lens: String,
    stage_index: i64,
}

fn run_one_finder(
    db: &Database,
    providers: &Providers,
    review_id: &str,
    parent_id: &str,
    provider: &str,
    root: &Path,
    scope_label: &str,
    files: &[ReviewFile],
    focus: Option<&str>,
    planned: &PlannedSession,
    cancel: &Arc<Mutex<bool>>,
) -> Result<Option<(String, Vec<Value>)>> {
    let lens = planned.lens.as_str();
    let reviewer = planned.session_id.as_str();
    let index = planned.stage_index;
    let (prompt, _, _) = build_finder_prompt(root, scope_label, files, focus, lens);
    crate::service::connect_chat_session(db, providers, reviewer)?;
    apply_read_only_after_connect(providers, reviewer, provider);
    let result = crate::service::send_chat_message(
        db,
        providers,
        reviewer,
        &prompt,
        &[],
        &format!("{review_id}:send:finder:{index}"),
    )?;
    let turn = result["turnId"].as_str().unwrap_or("").to_owned();
    if turn.is_empty() {
        return Err(anyhow!("The reviewer turn did not start"));
    }
    db.transaction(|tx| {
        tx.execute(
            "UPDATE code_review_sessions SET turn_id=? WHERE review_id=? AND session_id=?",
            params![turn, review_id, reviewer],
        )?;
        Ok(())
    })?;
    match wait_for_answer(db, reviewer, &turn, cancel, parent_id, review_id)? {
        None => Ok(None),
        Some(answer) => {
            let (parsed, unparsed) = agent_review::parse_answer(root, &answer);
            if unparsed {
                Err(anyhow!("Finder returned an unparsed answer"))
            } else {
                Ok(Some((lens.to_owned(), parsed.unwrap_or_default())))
            }
        }
    }
}

fn run_pipeline(
    db: Arc<Database>,
    providers: Arc<Providers>,
    review_id: String,
    parent_id: String,
    provider: String,
    depth: Depth,
    root: PathBuf,
    scope_label: String,
    files: Vec<ReviewFile>,
    focus: Option<String>,
    planned: Vec<PlannedSession>,
    cancel: Arc<Mutex<bool>>,
) {
    let fail = |db: &Database, message: &str| {
        if fail_review(db, &review_id, message).unwrap_or(false) {
            let _ = upsert_card(db, &parent_id, &review_id, true);
        }
        let _ = stop_reviewers(db, &providers, &review_id, false);
    };
    let mark_cancelled = |db: &Database| {
        if cancel_review(db, &review_id).unwrap_or(false) {
            let _ = upsert_card(db, &parent_id, &review_id, true);
        }
        let _ = stop_reviewers(db, &providers, &review_id, true);
    };
    let cancelled = || *cancel.lock().unwrap_or_else(|p| p.into_inner());
    let unverified = |findings: Vec<Value>| {
        findings
            .into_iter()
            .map(|mut finding| {
                finding["verdict"] = json!("unverified");
                finding
            })
            .collect::<Vec<_>>()
    };

    if !bump_stage(&db, &review_id, "finding", 0, "finding").unwrap_or(false) {
        return;
    }
    let _ = upsert_card(&db, &parent_id, &review_id, true);

    // Every finder runs on its own thread (Thorough's three lenses at once). Each
    // counts itself finished and refreshes the card, so progress moves while
    // the others still run.
    let finders: Vec<_> = planned.iter().filter(|row| row.role == "finder").collect();
    let results = std::thread::scope(|scope| {
        let handles = finders
            .iter()
            .map(|finder| {
                let (db, providers, cancel) = (&*db, &*providers, &cancel);
                let (review_id, parent_id, provider) = (&review_id, &parent_id, &provider);
                let (root, scope_label, files, focus) = (&root, &scope_label, &files, focus.as_deref());
                scope.spawn(move || {
                    let result = run_one_finder(
                        db, providers, review_id, parent_id, provider, root, scope_label, files, focus, finder, cancel,
                    );
                    if !matches!(result, Ok(None)) {
                        let _ = finish_finder(db, review_id);
                        let _ = upsert_card(db, parent_id, review_id, false);
                    }
                    result
                })
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap_or_else(|_| Err(anyhow!("finder thread panicked"))))
            .collect::<Vec<_>>()
    });
    let (mut finder_groups, mut errors, mut any_cancel) = (Vec::new(), Vec::new(), false);
    for (finder, result) in finders.iter().zip(results) {
        match result {
            Ok(None) => any_cancel = true,
            Ok(Some(group)) => finder_groups.push(group),
            Err(error) => errors.push((finder.lens.clone(), error.to_string())),
        }
    }
    if any_cancel || cancelled() {
        mark_cancelled(&db);
        return;
    }
    if finder_groups.is_empty() {
        let message = match errors.as_slice() {
            [(_, error)] if finders.len() == 1 => format!("The reviewer failed: {error}"),
            [(lens, error), ..] => format!("Every finder failed. First error ({lens}): {error}"),
            [] => "No finder ran".to_owned(),
        };
        fail(&db, &message);
        return;
    }
    for (lens, error) in &errors {
        let _ = push_warning(&db, &review_id, &format!("Finder ({lens}) failed: {error}"));
    }
    let candidates = merge_candidates(finder_groups);
    if !set_findings(&db, &review_id, &candidates, Some(candidates.len()), None).unwrap_or(false) {
        return;
    }

    let findings = if depth == Depth::Quick {
        unverified(candidates)
    } else if candidates.is_empty() {
        // Nothing to refute: the verifier would only spend a run confirming an empty list.
        candidates
    } else {
        if cancelled() {
            mark_cancelled(&db);
            return;
        }
        if !bump_stage(&db, &review_id, "verifying", finders.len() as i64, "verifying").unwrap_or(false) {
            return;
        }
        let _ = upsert_card(&db, &parent_id, &review_id, true);
        match planned.iter().find(|row| row.role == "verifier") {
            None => {
                let _ = push_warning(&db, &review_id, "Verifier session was not prepared");
                unverified(candidates)
            }
            Some(verifier) => {
                let prompt = build_verifier_prompt(&root, &scope_label, &files, &candidates, focus.as_deref());
                match (|| -> Result<Option<Vec<Value>>> {
                    crate::service::connect_chat_session(&db, &providers, &verifier.session_id)?;
                    apply_read_only_after_connect(&providers, &verifier.session_id, &provider);
                    let result = crate::service::send_chat_message(
                        &db,
                        &providers,
                        &verifier.session_id,
                        &prompt,
                        &[],
                        &format!("{review_id}:send:verifier"),
                    )?;
                    let turn = result["turnId"].as_str().unwrap_or("").to_owned();
                    if turn.is_empty() {
                        return Err(anyhow!("The reviewer turn did not start"));
                    }
                    db.transaction(|tx| {
                        tx.execute(
                            "UPDATE code_review_sessions SET turn_id=? WHERE review_id=? AND session_id=?",
                            params![turn, review_id, verifier.session_id],
                        )?;
                        Ok(())
                    })?;
                    let Some(answer) = wait_for_answer(&db, &verifier.session_id, &turn, &cancel, &parent_id, &review_id)? else {
                        return Ok(None);
                    };
                    let (parsed, unparsed) = agent_review::parse_answer(&root, &answer);
                    if unparsed {
                        Err(anyhow!("unparsed verifier answer"))
                    } else {
                        Ok(Some(parsed.unwrap_or_default()))
                    }
                })() {
                    Ok(Some(verified)) => {
                        let (findings, rejected) = apply_verifier(&candidates, &verified);
                        if !set_findings(&db, &review_id, &findings, Some(candidates.len()), Some(rejected))
                            .unwrap_or(false)
                        {
                            return;
                        }
                        findings
                    }
                    Ok(None) => {
                        mark_cancelled(&db);
                        return;
                    }
                    Err(_) if cancelled() => {
                        mark_cancelled(&db);
                        return;
                    }
                    Err(error) => {
                        let _ = push_warning(&db, &review_id, &format!("Verifier failed: {error}"));
                        unverified(candidates)
                    }
                }
            }
        }
    };

    let fingerprint_start: Option<String> = db
        .transaction(|tx| {
            Ok(tx
                .query_row("SELECT fingerprint_start FROM code_reviews WHERE id=?", [&review_id], |r| r.get(0))
                .optional()?)
        })
        .ok()
        .flatten();
    if let (Some(before), Ok(after)) = (fingerprint_start, worktree_fingerprint(&root)) {
        let changed = changed_paths(&root, &before, &after);
        if !changed.is_empty() {
            let extra = if changed.len() > 5 {
                format!(" (+{})", changed.len().saturating_sub(5))
            } else {
                String::new()
            };
            let listed = changed.into_iter().take(5).collect::<Vec<_>>().join(", ");
            let _ = push_warning(
                &db,
                &review_id,
                &format!("Files changed during the review: {listed}{extra}"),
            );
        }
    }

    if !set_findings(&db, &review_id, &findings, None, None).unwrap_or(false) {
        return;
    }
    if bump_stage(&db, &review_id, "done", depth.stages_total(), "done").unwrap_or(false) {
        let _ = upsert_card(&db, &parent_id, &review_id, true);
    }
    let _ = stop_reviewers(&db, &providers, &review_id, false);
}

/// Most reviewer items one transcript read returns. Each reviewer keeps an equal
/// share of its newest items, so a long finder never hides the verifier.
const TRANSCRIPT_ITEMS: usize = 500;

/// The hidden reviewer that asked `approval_id` in `turn_id`, when the chat owning a running
/// review answers it from the review card; `None` for the chat's own requests. Reviewers whose
/// read-only mode is only requested (Kimi and other ACP agents) still ask before running tools.
pub fn approval_owner(db: &Database, owner: &str, turn_id: &str, approval_id: &str) -> Result<Option<String>> {
    let reviewers = db.transaction(|tx| {
        // A database that never ran a review (Code Review's schema is created at startup) has none to route to.
        let reviews: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='code_review_sessions')",
            [],
            |r| r.get(0),
        )?;
        if !reviews {
            return Ok(Vec::new());
        }
        let mut statement = tx.prepare(
            "SELECT crs.session_id FROM code_review_sessions crs JOIN code_reviews cr ON cr.id=crs.review_id \
             WHERE cr.session_id=? AND cr.state IN ('preparing','finding','verifying') AND (crs.turn_id=? OR crs.turn_id IS NULL)",
        )?;
        let rows = statement
            .query_map(params![owner, turn_id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;
    for reviewer in reviewers {
        let asked = db.chat_items(&reviewer)?.iter().any(|item| {
            item.turn_id.as_deref() == Some(turn_id)
                && item.parts.iter().any(|part| part.get("approvalId").and_then(Value::as_str) == Some(approval_id))
        });
        if asked {
            return Ok(Some(reviewer));
        }
    }
    Ok(None)
}

pub fn read_session_transcript(db: &Database, parent: &str, key: &str) -> Result<Value> {
    let review_id = key.strip_prefix("review:").ok_or_else(|| fault("invalid_request"))?;
    let (rev, ended, rows) = db.transaction(|tx| {
        let review: Option<(String, i64, String)> = tx
            .query_row(
                "SELECT session_id, card_rev, state FROM code_reviews WHERE id=?",
                [review_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        // Only the chat that owns the review may read its reviewers.
        let Some((_, rev, state)) = review.filter(|(owner, _, _)| owner == parent) else {
            return Err(fault("invalid_request"));
        };
        let mut statement = tx.prepare(
            "SELECT crs.session_id, crs.role, crs.lens, crs.stage_index, s.created_at FROM code_review_sessions crs JOIN sessions s ON s.id=crs.session_id WHERE crs.review_id=? ORDER BY crs.stage_index ASC, crs.session_id ASC",
        )?;
        let rows = statement
            .query_map([review_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((rev, !matches!(state.as_str(), "preparing" | "finding" | "verifying"), rows))
    })?;
    let share = TRANSCRIPT_ITEMS / rows.len().max(1);
    let (mut items, mut truncated) = (Vec::new(), false);
    for (session_id, role, lens, stage_index, created_at) in rows {
        let mut child_items = db.chat_items(&session_id).unwrap_or_default();
        if child_items.len() > share {
            child_items.drain(..child_items.len() - share);
            truncated = true;
        }
        let mut label = match (role.as_str(), lens.as_deref()) {
            ("verifier", _) => "Stage: verifying".to_owned(),
            (_, Some(lens)) => format!("Stage: finding · {lens}"),
            _ => format!("Stage: finding · {stage_index}"),
        };
        if ended && child_items.is_empty() {
            label.push_str(" · not run");
        }
        items.push(json!({
            "id": format!("{parent}:system:review-stage:{review_id}:{stage_index}:{session_id}"),
            "role": "system",
            "parts": [{"type":"text","text": label}],
            "createdAt": created_at,
        }));
        for item in child_items {
            items.push(serde_json::to_value(item)?);
        }
    }
    Ok(json!({"items": items, "rev": rev, "truncated": truncated, "source": "session"}))
}

pub fn dispatch(
    db: &Arc<Database>,
    providers: &Arc<Providers>,
    method: &str,
    params: &Value,
    lease_check: &dyn Fn(&str, i64) -> Result<()>,
    create: &dyn Fn(&Value) -> Result<Value>,
) -> Result<Value> {
    match method {
        "codeReview.options" => {
            let session_id = params["sessionId"].as_str().ok_or_else(|| fault("invalid_request"))?;
            options(db, providers, session_id)
        }
        "codeReview.cancel" => {
            let request: CancelRequest = serde_json::from_value(params.clone()).map_err(|_| fault("invalid_request"))?;
            if request.operation_id.is_empty() {
                return Err(fault("invalid_request"));
            }
            lease_check(&request.session_id, request.lease_epoch)?;
            db.bind_operation(&request.operation_id, method, params)?;
            if let Some(value) = db.operation(&request.operation_id)? {
                return Ok(value);
            }
            let state: Option<String> = db.transaction(|tx| {
                Ok(tx
                    .query_row(
                        "SELECT state FROM code_reviews WHERE id=? AND session_id=?",
                        params![request.review_id, request.session_id],
                        |r| r.get(0),
                    )
                    .optional()?)
            })?;
            let Some(state) = state else {
                return Err(fault("review_not_found"));
            };
            if matches!(state.as_str(), "preparing" | "finding" | "verifying") {
                if let Ok(map) = cancel_flags().lock() {
                    if let Some(flag) = map.get(&request.review_id) {
                        if let Ok(mut value) = flag.lock() {
                            *value = true;
                        }
                    }
                }
                // Mark cancelled before stopping reviewers so a stuck provider
                // stop cannot leave the review active forever.
                if cancel_review(db, &request.review_id)? {
                    upsert_card(db, &request.session_id, &request.review_id, true)?;
                }
                let _ = stop_reviewers(db, providers, &request.review_id, true);
            }
            db.complete_operation(&request.operation_id, method, &Value::Null)?;
            Ok(Value::Null)
        }
        "codeReview.start" => {
            let request: StartRequest = serde_json::from_value(params.clone()).map_err(|_| fault("invalid_request"))?;
            if request.operation_id.is_empty() {
                return Err(fault("invalid_request"));
            }
            lease_check(&request.session_id, request.lease_epoch)?;
            if let Some(focus) = &request.focus {
                if focus.len() > FOCUS_BUDGET {
                    return Err(fault("focus_too_long"));
                }
            }
            db.bind_operation(&request.operation_id, method, params)?;
            let _gate = START_GATE.lock().map_err(|_| anyhow!("review gate poisoned"))?;
            if let Some(value) = db.operation(&request.operation_id)? {
                return Ok(value);
            }
            if active_review(db, &request.session_id)?.is_some() {
                return Err(fault("review_active"));
            }
            if !providers.contains(&request.provider) {
                return Err(fault("provider_unavailable"));
            }
            if !crate::delegation::available_agents(providers).contains(&request.provider) {
                return Err(fault("provider_unavailable"));
            }
            if let Some(model) = &request.model {
                validate_catalog_selection(db, &request.provider, "model", model)?;
            }
            if let Some(thinking) = &request.thinking {
                validate_catalog_selection(db, &request.provider, "thinking", thinking)?;
            }
            let session = db
                .session_by_id(&request.session_id)?
                .ok_or_else(|| fault("session_not_found"))?;
            let cwd = crate::delegation::session_cwd(db, &session)?;
            let root = if let Some(project) = &session.project_id {
                crate::workspace_services::workspace_root_for_cwd(db, project, &cwd)?
            } else {
                PathBuf::from(&cwd).canonicalize()?
            };
            let root = crate::git_read::plain_path(&root);
            let (files, scope_label) = capture_scope(db, &session, &root, &request.scope)?;
            if files.is_empty() {
                return Err(fault("review_empty"));
            }
            let fingerprint = worktree_fingerprint(&root).ok();
            let review_id = uuid::Uuid::new_v4().to_string();
            let key = review_key(&review_id);
            let item_id = card_id(&session.id, &key);
            let now = Utc::now().to_rfc3339();
            db.transaction(|tx| {
                tx.execute(
                    "INSERT INTO code_reviews(id,session_id,item_id,provider,model,thinking,depth,scope_json,scope_label,focus,root,state,stage,stages_done,stages_total,warnings_json,fingerprint_start,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'preparing','preparing',0,?, '[]',?,?,?)",
                    params![
                        review_id,
                        session.id,
                        item_id,
                        request.provider,
                        request.model,
                        request.thinking,
                        request.depth.as_str(),
                        serde_json::to_string(&request.scope)?,
                        scope_label,
                        request.focus,
                        root.to_string_lossy(),
                        request.depth.stages_total(),
                        fingerprint,
                        now,
                        now
                    ],
                )?;
                Ok(())
            })?;
            upsert_card(db, &session.id, &review_id, true)?;
            // The review row exists from here on: any failure must end it, or it
            // would block every later review of this chat as `review_active`.
            let prepared = (|| -> Result<Vec<PlannedSession>> {
                let mut stages: Vec<(&'static str, String, i64)> = request
                    .depth
                    .lenses()
                    .into_iter()
                    .enumerate()
                    .map(|(index, lens)| ("finder", lens.to_owned(), index as i64))
                    .collect();
                if request.depth != Depth::Quick {
                    stages.push(("verifier", "verify".into(), request.depth.stages_total() - 1));
                }
                // An agent that cannot be locked read-only reviews a copy and stops asking;
                // without a copy it keeps asking before commands, as before.
                let isolated_cwd = if isolates(&request.provider) {
                    let dir = snapshot_dir(db, &review_id);
                    match create_snapshot(&root, &dir) {
                        Ok(()) => Some(snapshot_cwd(&root, &cwd, &dir)),
                        Err(error) => {
                            remove_snapshot(&dir);
                            let _ = push_warning(db, &review_id, &format!("Could not make a copy to review, so the reviewer asks before running commands: {error}"));
                            None
                        }
                    }
                } else {
                    None
                };
                let reviewer_cwd = isolated_cwd.clone().unwrap_or_else(|| cwd.clone());
                let mut planned = Vec::new();
                for (role, lens, stage_index) in stages {
                    let (title, operation) = if role == "verifier" {
                        ("Code review · verify".to_owned(), format!("{}:verifier", request.operation_id))
                    } else {
                        (format!("Code review · {lens}"), format!("{}:finder:{stage_index}", request.operation_id))
                    };
                    let reviewer = create_reviewer_session(db, &session, &reviewer_cwd, &request.provider, &title, &operation, create)?;
                    // Mark it a reviewer before staging: it is hidden and
                    // tool-restricted even if staging fails.
                    db.transaction(|tx| {
                        tx.execute(
                            "INSERT INTO code_review_sessions(review_id,session_id,role,lens,stage_index) VALUES (?,?,?,?,?)",
                            params![review_id, reviewer, role, lens, stage_index],
                        )?;
                        tx.execute(
                            "INSERT INTO outbox(event,data,created_at) VALUES ('state.changed',?,?)",
                            params![json!({"sessionId":reviewer,"kind":"session.codeReview"}).to_string(), Utc::now().to_rfc3339()],
                        )?;
                        Ok(())
                    })?;
                    if let Err(error) = stage_read_only(db, providers, &reviewer, &request.provider) {
                        let _ = push_warning(db, &review_id, &format!("Could not stage read-only mode: {error}"));
                    }
                    if isolated_cwd.is_some() {
                        stage_never_ask(db, &reviewer, &request.provider)?;
                    }
                    if let Some(model) = &request.model {
                        stage_catalog_selection(db, &request.provider, "model", model, &reviewer)?;
                    }
                    if let Some(thinking) = &request.thinking {
                        stage_catalog_selection(db, &request.provider, "thinking", thinking, &reviewer)?;
                    }
                    planned.push(PlannedSession { session_id: reviewer, role, lens, stage_index });
                }
                Ok(planned)
            })();
            let result = json!({"reviewId": review_id, "itemId": item_id});
            let planned = match prepared {
                Ok(planned) => planned,
                Err(error) => {
                    // The card reports it; the dialog sees a started review.
                    if fail_review(db, &review_id, &format!("The review could not start: {error}"))? {
                        upsert_card(db, &session.id, &review_id, true)?;
                    }
                    db.complete_operation(&request.operation_id, method, &result)?;
                    return Ok(result);
                }
            };
            db.complete_operation(&request.operation_id, method, &result)?;
            let cancel = Arc::new(Mutex::new(false));
            if let Ok(mut map) = cancel_flags().lock() {
                map.insert(review_id.clone(), Arc::clone(&cancel));
            }
            let worker_db = Arc::clone(db);
            let worker_providers = Arc::clone(providers);
            let worker_cancel = Arc::clone(&cancel);
            let worker_review = review_id.clone();
            let worker_parent = session.id.clone();
            let worker_provider = request.provider.clone();
            let worker_focus = request.focus.clone();
            let worker_files = files;
            let worker_root = root;
            let worker_label = scope_label;
            let worker_depth = request.depth;
            let spawned = std::thread::Builder::new()
                .name(format!("code-review-{}", &review_id[..8]))
                .spawn(move || {
                    run_pipeline(
                        worker_db,
                        worker_providers,
                        worker_review.clone(),
                        worker_parent,
                        worker_provider,
                        worker_depth,
                        worker_root,
                        worker_label,
                        worker_files,
                        worker_focus,
                        planned,
                        worker_cancel,
                    );
                    if let Ok(mut map) = cancel_flags().lock() {
                        map.remove(&worker_review);
                    }
                });
            if let Err(error) = spawned {
                if fail_review(db, &review_id, &format!("The review could not start: {error}"))? {
                    upsert_card(db, &session.id, &review_id, true)?;
                }
                if let Ok(mut map) = cancel_flags().lock() {
                    map.remove(&review_id);
                }
            }
            Ok(result)
        }
        _ => Err(fault("unknown_method")),
    }
}
