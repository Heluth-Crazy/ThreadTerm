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
fn card_emit() -> &'static Mutex<HashMap<String, Instant>> {
    static CARD_EMIT: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    CARD_EMIT.get_or_init(|| Mutex::new(HashMap::new()))
}
fn cancel_flags() -> &'static Mutex<HashMap<String, Arc<Mutex<bool>>>> {
    static CANCEL_FLAGS: OnceLock<Mutex<HashMap<String, Arc<Mutex<bool>>>>> = OnceLock::new();
    CANCEL_FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn test_completed_turns() -> &'static Mutex<HashMap<String, String>> {
    static COMPLETED: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    COMPLETED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Test helper: mark a reviewer turn completed without touching SQLite under the
/// provider worker lock (which deadlocks with card refresh).
#[cfg(test)]
pub(crate) fn test_complete_turn(session_id: &str, turn_id: &str, answer: &str) {
    if let Ok(mut map) = test_completed_turns().lock() {
        map.insert(format!("{session_id}\0{turn_id}"), answer.to_owned());
    }
}

#[cfg(test)]
pub(crate) fn test_clear_completed_turns() {
    if let Ok(mut map) = test_completed_turns().lock() {
        map.clear();
    }
}

#[cfg(test)]
fn test_turn_answer(session_id: &str, turn_id: &str) -> Option<String> {
    test_completed_turns()
        .lock()
        .ok()?
        .get(&format!("{session_id}\0{turn_id}"))
        .cloned()
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
    #[allow(dead_code)]
    lease_epoch: i64,
}

pub fn initialize(db: &Database) -> Result<()> {
    db.transaction(|tx| {
        tx.execute_batch(SCHEMA)?;
        let _ = tx.execute("ALTER TABLE code_reviews ADD COLUMN card_rev INTEGER NOT NULL DEFAULT 0", []);
        Ok(())
    })
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
        let _ = upsert_card(db, parent, id, "failed", true);
    }
    Ok(rows.len())
}

pub(crate) fn is_hidden_reviewer(db: &Database, session_id: &str) -> Result<bool> {
    db.transaction(|tx| {
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
    })
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
            "INSERT INTO provider_option_catalog(provider,options_json,seen_at) VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET options_json=excluded.options_json,seen_at=excluded.seen_at",
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
    let status = crate::git_read::run_git(
        root,
        &["status", "--porcelain", "-z"],
        &[],
        None,
        crate::git_read::LOCAL_TIMEOUT,
    )?;
    Ok(String::from_utf8_lossy(&status)
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .count())
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
    let status = crate::git_read::run_git(
        root,
        &["status", "--porcelain=v1", "-z"],
        &[],
        None,
        crate::git_read::LOCAL_TIMEOUT,
    )?;
    let mut hasher = Sha256::new();
    hasher.update(&status);
    let text = String::from_utf8_lossy(&status);
    for path in text.split('\0').filter(|s| s.len() > 3).map(|s| s[3..].replace('\\', "/")).take(200) {
        if path.is_empty() {
            continue;
        }
        if let Ok(bytes) = fs::read(root.join(&path)) {
            hasher.update(path.as_bytes());
            hasher.update(&bytes);
        } else {
            hasher.update(path.as_bytes());
            hasher.update(b"missing");
        }
    }
    Ok(hex::encode(hasher.finalize()))
}

fn changed_paths(root: &Path, before: &str, after: &str) -> Vec<String> {
    if before == after {
        return Vec::new();
    }
    let Ok(status) = crate::git_read::run_git(
        root,
        &["status", "--porcelain=v1", "-z"],
        &[],
        None,
        crate::git_read::LOCAL_TIMEOUT,
    ) else {
        return vec!["(status unavailable)".into()];
    };
    String::from_utf8_lossy(&status)
        .split('\0')
        .filter(|s| s.len() > 3)
        .map(|s| s[3..].replace('\\', "/"))
        .filter(|s| !s.is_empty())
        .take(12)
        .collect()
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

fn card_preview(db: &Database, review_id: &str, status: &str) -> Result<String> {
    if status == "failed" {
        let error: Option<String> = db.transaction(|tx| {
            Ok(tx
                .query_row("SELECT error FROM code_reviews WHERE id=?", [review_id], |r| r.get(0))
                .optional()?)
        })?;
        return Ok(error.unwrap_or_else(|| "The review failed".into()));
    }
    let findings: Vec<Value> = db.transaction(|tx| {
        let raw: Option<String> = tx.query_row(
            "SELECT findings_json FROM code_reviews WHERE id=?",
            [review_id],
            |r| r.get::<_, Option<String>>(0),
        )?;
        Ok(raw
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default())
    })?;
    if findings.is_empty() {
        return Ok("No issues found".into());
    }
    let mut confirmed = 0usize;
    let mut plausible = 0usize;
    let mut unverified = 0usize;
    for finding in &findings {
        match finding.get("verdict").and_then(Value::as_str).unwrap_or("unverified") {
            "confirmed" => confirmed += 1,
            "plausible" => plausible += 1,
            _ => unverified += 1,
        }
    }
    let depth: String = db.transaction(|tx| {
        Ok(tx.query_row("SELECT depth FROM code_reviews WHERE id=?", [review_id], |r| r.get(0))?)
    })?;
    let mut parts = Vec::new();
    if confirmed > 0 {
        parts.push(format!("{confirmed} confirmed"));
    }
    if plausible > 0 {
        parts.push(format!("{plausible} plausible"));
    }
    if depth == "quick" || unverified > 0 {
        if unverified > 0 || depth == "quick" {
            parts.push(format!("{unverified} unverified"));
        }
    }
    if parts.is_empty() {
        Ok("No issues found".into())
    } else {
        Ok(parts.join(" · "))
    }
}

fn live_card_progress(db: &Database, review_id: &str) -> Result<(usize, usize, Option<String>, i64)> {
    let reviewers = reviewer_ids(db, review_id)?;
    let mut tool_count = 0usize;
    let mut item_count = 0usize;
    let mut last_activity: Option<(String, String)> = None;
    for reviewer in reviewers {
        let items = db.chat_items(&reviewer).unwrap_or_default();
        item_count += items.len();
        for item in items {
            for part in &item.parts {
                if part.get("type").and_then(Value::as_str) != Some("tool") {
                    continue;
                }
                tool_count += 1;
                let label = part
                    .get("toolName")
                    .and_then(Value::as_str)
                    .or_else(|| part.pointer("/data/title").and_then(Value::as_str))
                    .or_else(|| part.pointer("/data/name").and_then(Value::as_str))
                    .unwrap_or("")
                    .trim();
                if !label.is_empty() {
                    last_activity = Some((item.created_at.clone(), label.to_owned()));
                }
            }
        }
        if last_activity.is_none() {
            if let Some(session) = db.session_by_id(&reviewer)? {
                if let Some(activity) = session.activity {
                    let text = activity.reason.clone().unwrap_or_else(|| activity.state.clone());
                    if !text.is_empty() {
                        last_activity = Some((session.updated_at, text));
                    }
                }
            }
        }
    }
    let rev = db.transaction(|tx| {
        let current: i64 = tx.query_row(
            "SELECT card_rev FROM code_reviews WHERE id=?",
            [review_id],
            |r| r.get(0),
        )?;
        let next = current + 1 + item_count as i64;
        tx.execute("UPDATE code_reviews SET card_rev=? WHERE id=?", params![next, review_id])?;
        Ok(next)
    })?;
    Ok((tool_count, item_count, last_activity.map(|(_, text)| text), rev))
}

fn upsert_card(db: &Database, parent: &str, review_id: &str, status: &str, force: bool) -> Result<()> {
    if !force {
        let mut map = card_emit().lock().map_err(|_| anyhow!("card emit poisoned"))?;
        let now = Instant::now();
        if let Some(previous) = map.get(review_id) {
            if now.duration_since(*previous) < CARD_LIVE_REFRESH {
                return Ok(());
            }
        }
        map.insert(review_id.to_owned(), now);
    }
    let key = review_key(review_id);
    let id = card_id(parent, &key);
    let summary = summary_value(db, review_id)?;
    let (provider, started_at, error): (String, String, Option<String>) = db.transaction(|tx| {
        Ok(tx.query_row(
            "SELECT provider, created_at, error FROM code_reviews WHERE id=?",
            [review_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?)
    })?;
    let (tool_count, item_count, last_activity, rev) = live_card_progress(db, review_id)?;
    let preview = if status == "failed" {
        error.unwrap_or_else(|| "The review failed".into())
    } else {
        card_preview(db, review_id, status)?
    };
    let now = Utc::now().to_rfc3339();
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
        "toolCount": tool_count,
        "itemCount": item_count,
        "summary": preview,
        "rev": rev,
    });
    if let Some(activity) = last_activity {
        info["lastActivity"] = json!(activity);
    }
    if matches!(status, "completed" | "failed" | "cancelled") {
        info["endedAt"] = json!(now);
    }
    let item = ChatItem {
        id: id.clone(),
        role: "system".into(),
        parts: vec![json!({"type":"subagent","toolId":key,"status":status,"data":info})],
        created_at: started_at.clone(),
        turn_id: None,
        elapsed_ms: None,
        turn_status: None,
        turn_origin: None,
        fork_anchor: None,
        turn_model: None,
        turn_usage: None,
        turn_review: None,
    };
    db.transaction(|tx| {
        let created: Option<String> = tx
            .query_row("SELECT created_at FROM chat_items WHERE id=?", [&id], |r| r.get(0))
            .optional()?;
        let mut stored = item;
        if let Some(created_at) = created {
            stored.created_at = created_at;
        }
        tx.execute(
            "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES (?,?,NULL,'message',?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            params![stored.id, parent, serde_json::to_string(&stored)?, stored.created_at],
        )?;
        tx.execute(
            "INSERT INTO outbox(event,data,created_at) VALUES ('chat.item',?,?)",
            params![json!({"sessionId":parent,"item":stored}).to_string(), Utc::now().to_rfc3339()],
        )?;
        Ok(())
    })
}

fn bump_stage(db: &Database, review_id: &str, stage: &str, done: i64, state: &str) -> Result<bool> {
    db.transaction(|tx| {
        let changed = if matches!(state, "cancelled" | "failed" | "done") {
            tx.execute(
                "UPDATE code_reviews SET stage=?, stages_done=?, state=?, updated_at=? WHERE id=? AND state IN ('preparing','finding','verifying')",
                params![stage, done, state, Utc::now().to_rfc3339(), review_id],
            )?
        } else {
            tx.execute(
                "UPDATE code_reviews SET stage=?, stages_done=?, state=?, updated_at=? WHERE id=? AND state IN ('preparing','finding','verifying')",
                params![stage, done, state, Utc::now().to_rfc3339(), review_id],
            )?
        };
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
        tx.execute(
            "UPDATE code_reviews SET warnings_json=?, updated_at=? WHERE id=?",
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

fn last_answer_text(db: &Database, reviewer: &str) -> Result<String> {
    db.transaction(|tx| {
        let mut statement = tx.prepare(
            "SELECT data FROM chat_items WHERE session_id=? AND json_extract(data,'$.role')='assistant' ORDER BY created_at DESC,id DESC",
        )?;
        let mut rows = statement.query([reviewer])?;
        while let Some(row) = rows.next()? {
            let item: ChatItem = serde_json::from_str(&row.get::<_, String>(0)?)?;
            if item.parts.is_empty() {
                continue;
            }
            return Ok(item
                .parts
                .iter()
                .filter(|p| p["type"] == "text")
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"));
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
            Some("completed") => return Ok(Some(last_answer_text(db, reviewer)?)),
            Some(status @ ("failed" | "interrupted" | "cancelled" | "canceled")) => {
                return Err(anyhow!("The reviewer turn ended with status {status}"));
            }
            _ => {}
        }
        #[cfg(test)]
        if let Some(answer) = test_turn_answer(reviewer, turn) {
            return Ok(Some(answer));
        }
        let _ = upsert_card(db, parent, review_id, "running", false);
        std::thread::sleep(STAGE_POLL);
    }
    Err(anyhow!("The reviewer timed out"))
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

fn stop_reviewers(db: &Database, providers: &Arc<Providers>, review_id: &str) -> Result<()> {
    let reviewers = reviewer_ids(db, review_id)?;
    for reviewer in &reviewers {
        let _ = db.set_session_status(reviewer, "interrupted", None);
    }
    // Provider cancel/stop can block on a worker still inside send/capture; run
    // them off-thread so the review can already be terminal and waiters exit.
    if !reviewers.is_empty() {
        let providers = Arc::clone(providers);
        let _ = std::thread::Builder::new()
            .name("code-review-stop".into())
            .spawn(move || {
                for reviewer in reviewers {
                    let _ = providers.chat_cancel(&reviewer, "");
                    let _ = providers.chat_stop(&reviewer);
                }
            });
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
        let ok = bump_stage(db, &review_id, "done", 0, "failed").unwrap_or(false);
        if !ok {
            return;
        }
        let _ = db.transaction(|tx| {
            tx.execute(
                "UPDATE code_reviews SET error=?, updated_at=? WHERE id=? AND state='failed'",
                params![message, Utc::now().to_rfc3339(), review_id],
            )?;
            Ok(())
        });
        let _ = upsert_card(db, &parent_id, &review_id, "failed", true);
    };
    let stop_providers = Arc::clone(&providers);
    let mark_cancelled = |db: &Database| {
        if cancel_review(db, &review_id).unwrap_or(false) {
            let _ = upsert_card(db, &parent_id, &review_id, "cancelled", true);
        }
        let _ = stop_reviewers(db, &stop_providers, &review_id);
    };
    let cancelled = || *cancel.lock().unwrap_or_else(|p| p.into_inner());

    let mut finder_groups = Vec::new();
    if !bump_stage(&db, &review_id, "finding", 0, "finding").unwrap_or(false) {
        return;
    }
    let _ = upsert_card(&db, &parent_id, &review_id, "running", true);

    let finders: Vec<_> = planned.iter().filter(|row| row.role == "finder").cloned().collect();
    if depth == Depth::Thorough && finders.len() > 1 {
        let results = std::thread::scope(|scope| {
            let mut handles = Vec::new();
            for planned_finder in &finders {
                let db = Arc::clone(&db);
                let providers = Arc::clone(&providers);
                let review_id = review_id.clone();
                let parent_id = parent_id.clone();
                let provider = provider.clone();
                let root = root.clone();
                let scope_label = scope_label.clone();
                let files = files.clone();
                let focus = focus.clone();
                let cancel = Arc::clone(&cancel);
                let planned_finder = planned_finder.clone();
                handles.push(scope.spawn(move || {
                    run_one_finder(
                        &db,
                        &providers,
                        &review_id,
                        &parent_id,
                        &provider,
                        &root,
                        &scope_label,
                        &files,
                        focus.as_deref(),
                        &planned_finder,
                        &cancel,
                    )
                }));
            }
            handles.into_iter().map(|handle| handle.join().unwrap_or_else(|_| Err(anyhow!("finder thread panicked")))).collect::<Vec<_>>()
        });
        let mut any_cancel = false;
        for (planned_finder, result) in finders.iter().zip(results) {
            match result {
                Ok(None) => any_cancel = true,
                Ok(Some(group)) => {
                    finder_groups.push(group);
                    let _ = bump_stage(
                        &db,
                        &review_id,
                        "finding",
                        planned_finder.stage_index + 1,
                        "finding",
                    );
                }
                Err(error) => {
                    let _ = push_warning(
                        &db,
                        &review_id,
                        &format!("Finder ({}) failed: {error}", planned_finder.lens),
                    );
                }
            }
            let _ = upsert_card(&db, &parent_id, &review_id, "running", false);
        }
        if any_cancel || cancelled() {
            mark_cancelled(&db);
            return;
        }
    } else {
        for planned_finder in &finders {
            if cancelled() {
                mark_cancelled(&db);
                return;
            }
            match run_one_finder(
                &db,
                &providers,
                &review_id,
                &parent_id,
                &provider,
                &root,
                &scope_label,
                &files,
                focus.as_deref(),
                planned_finder,
                &cancel,
            ) {
                Ok(None) => {
                    mark_cancelled(&db);
                    return;
                }
                Ok(Some(group)) => {
                    finder_groups.push(group);
                }
                Err(error) => {
                    fail(&db, &format!("Finder failed: {error}"));
                    return;
                }
            }
            let _ = bump_stage(
                &db,
                &review_id,
                "finding",
                planned_finder.stage_index + 1,
                "finding",
            );
            let _ = upsert_card(&db, &parent_id, &review_id, "running", false);
        }
    }

    if finder_groups.is_empty() {
        fail(&db, "Every finder failed");
        return;
    }
    let candidates = merge_candidates(finder_groups);
    if !set_findings(&db, &review_id, &candidates, Some(candidates.len()), None).unwrap_or(false) {
        return;
    }

    let findings = if depth == Depth::Quick {
        candidates
            .into_iter()
            .map(|mut f| {
                f["verdict"] = json!("unverified");
                f
            })
            .collect::<Vec<_>>()
    } else {
        if cancelled() {
            mark_cancelled(&db);
            return;
        }
        if !bump_stage(&db, &review_id, "verifying", depth.stages_total() - 1, "verifying").unwrap_or(false) {
            return;
        }
        let _ = upsert_card(&db, &parent_id, &review_id, "running", true);
        match planned.iter().find(|row| row.role == "verifier") {
            None => {
                let _ = push_warning(&db, &review_id, "Verifier session was not prepared");
                candidates
                    .into_iter()
                    .map(|mut f| {
                        f["verdict"] = json!("unverified");
                        f
                    })
                    .collect::<Vec<_>>()
            }
            Some(verifier) => {
                let prompt = build_verifier_prompt(&root, &scope_label, &files, &candidates, focus.as_deref());
                match (|| -> Result<Vec<Value>> {
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
                    let answer = wait_for_answer(&db, &verifier.session_id, &turn, &cancel, &parent_id, &review_id)?
                        .ok_or_else(|| anyhow!("cancelled"))?;
                    let (parsed, unparsed) = agent_review::parse_answer(&root, &answer);
                    if unparsed {
                        Err(anyhow!("unparsed verifier answer"))
                    } else {
                        Ok(parsed.unwrap_or_default())
                    }
                })() {
                    Ok(verified) => {
                        let (findings, rejected) = apply_verifier(&candidates, &verified);
                        if !set_findings(&db, &review_id, &findings, Some(candidates.len()), Some(rejected))
                            .unwrap_or(false)
                        {
                            return;
                        }
                        findings
                    }
                    Err(error) if error.to_string() == "cancelled" => {
                        mark_cancelled(&db);
                        return;
                    }
                    Err(error) => {
                        let _ = push_warning(&db, &review_id, &format!("Verifier failed: {error}"));
                        candidates
                            .into_iter()
                            .map(|mut f| {
                                f["verdict"] = json!("unverified");
                                f
                            })
                            .collect()
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
        let _ = upsert_card(&db, &parent_id, &review_id, "completed", true);
    }
}

pub fn read_session_transcript(db: &Database, parent: &str, key: &str) -> Result<Value> {
    let review_id = key.strip_prefix("review:").ok_or_else(|| fault("invalid_request"))?;
    let (owned, rev, rows) = db.transaction(|tx| {
        let owner: Option<String> = tx
            .query_row(
                "SELECT session_id FROM code_reviews WHERE id=?",
                [review_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(owner) = owner else {
            return Err(fault("invalid_request"));
        };
        if owner != parent {
            return Err(fault("invalid_request"));
        }
        let rev: i64 = tx
            .query_row("SELECT card_rev FROM code_reviews WHERE id=?", [review_id], |r| r.get(0))
            .unwrap_or(0);
        let mut statement = tx.prepare(
            "SELECT session_id, role, lens, stage_index FROM code_review_sessions WHERE review_id=? ORDER BY stage_index ASC, session_id ASC",
        )?;
        let rows = statement
            .query_map([review_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((owner, rev, rows))
    })?;
    let _ = owned;
    let mut items = Vec::new();
    for (session_id, role, lens, stage_index) in rows {
        let label = match (role.as_str(), lens.as_deref()) {
            ("verifier", _) => "Stage: verifying".to_owned(),
            (_, Some(lens)) => format!("Stage: finding · {lens}"),
            _ => format!("Stage: finding · {stage_index}"),
        };
        items.push(json!({
            "id": format!("{parent}:system:review-stage:{review_id}:{stage_index}:{session_id}"),
            "role": "system",
            "parts": [{"type":"text","text": label}],
            "createdAt": Utc::now().to_rfc3339(),
        }));
        let child_items = db.chat_items(&session_id).unwrap_or_default();
        for item in child_items {
            items.push(serde_json::to_value(item)?);
            if items.len() >= 500 {
                return Ok(json!({"items": items, "rev": rev, "truncated": true, "source": "session"}));
            }
        }
    }
    Ok(json!({"items": items, "rev": rev, "truncated": false, "source": "session"}))
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
                    upsert_card(db, &request.session_id, &request.review_id, "cancelled", true)?;
                }
                let _ = stop_reviewers(db, providers, &request.review_id);
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
            upsert_card(db, &session.id, &review_id, "running", true)?;
            let mut planned = Vec::new();
            for (index, lens) in request.depth.lenses().into_iter().enumerate() {
                let reviewer = create_reviewer_session(
                    db,
                    &session,
                    &cwd,
                    &request.provider,
                    &format!("Code review · {lens}"),
                    &format!("{}:finder:{index}", request.operation_id),
                    create,
                )?;
                if let Err(error) = stage_read_only(db, providers, &reviewer, &request.provider) {
                    let _ = push_warning(db, &review_id, &format!("Could not stage read-only mode: {error}"));
                }
                if let Some(model) = &request.model {
                    stage_catalog_selection(db, &request.provider, "model", model, &reviewer)?;
                }
                if let Some(thinking) = &request.thinking {
                    stage_catalog_selection(db, &request.provider, "thinking", thinking, &reviewer)?;
                }
                db.transaction(|tx| {
                    tx.execute(
                        "INSERT INTO code_review_sessions(review_id,session_id,role,lens,stage_index) VALUES (?,?,?,?,?)",
                        params![review_id, reviewer, "finder", lens, index as i64],
                    )?;
                    Ok(())
                })?;
                planned.push(PlannedSession {
                    session_id: reviewer,
                    role: "finder",
                    lens: lens.to_owned(),
                    stage_index: index as i64,
                });
            }
            if request.depth != Depth::Quick {
                let verifier = create_reviewer_session(
                    db,
                    &session,
                    &cwd,
                    &request.provider,
                    "Code review · verify",
                    &format!("{}:verifier", request.operation_id),
                    create,
                )?;
                let _ = stage_read_only(db, providers, &verifier, &request.provider);
                if let Some(model) = &request.model {
                    stage_catalog_selection(db, &request.provider, "model", model, &verifier)?;
                }
                if let Some(thinking) = &request.thinking {
                    stage_catalog_selection(db, &request.provider, "thinking", thinking, &verifier)?;
                }
                let stage_index = request.depth.stages_total() - 1;
                db.transaction(|tx| {
                    tx.execute(
                        "INSERT INTO code_review_sessions(review_id,session_id,role,lens,stage_index) VALUES (?,?,?,?,?)",
                        params![review_id, verifier, "verifier", "verify", stage_index],
                    )?;
                    Ok(())
                })?;
                planned.push(PlannedSession {
                    session_id: verifier,
                    role: "verifier",
                    lens: "verify".into(),
                    stage_index,
                });
            }
            let result = json!({"reviewId": review_id, "itemId": item_id});
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
                if bump_stage(db, &review_id, "done", 0, "failed")? {
                    let _ = db.transaction(|tx| {
                        tx.execute(
                            "UPDATE code_reviews SET error=?, updated_at=? WHERE id=? AND state='failed'",
                            params![format!("The review could not start: {error}"), Utc::now().to_rfc3339(), review_id],
                        )?;
                        Ok(())
                    });
                    upsert_card(db, &session.id, &review_id, "failed", true)?;
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
