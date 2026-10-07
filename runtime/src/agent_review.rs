//! User-requested independent reviews. Diff capture is synchronous; provider
//! startup is the only background work. State and findings are reconciled on read.
use crate::{db::Database, providers::{Providers, ProviderRuntime, ProviderError}, review::ReviewFile};
use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::{Path, PathBuf}, sync::{Arc, Mutex}};

pub(crate) const DIFF_BUDGET: usize = 200 * 1024;
const INSTRUCTION_BUDGET: u64 = 64 * 1024;
static START_GATE: Mutex<()> = Mutex::new(());
const BUILT_IN: &str = "Review for correctness, security, data loss, regressions and missing tests. Do NOT edit files or run commands that change anything. Cite path:line relative to the worktree root. Be concise.";
const FINAL_BLOCK: &str = "## Required final response\n\nFinish with a fenced block with info string `threadterm-review` containing a JSON array:\n\n```threadterm-review\n[{\"severity\":\"high|medium|low|info\",\"path\":\"rel/path\",\"line\":12,\"title\":\"…\",\"body\":\"…\"}]\n```\n\nPath and line are optional. Reply with an empty array if you find nothing.";
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS agent_reviews (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 reviewer_session_id TEXT NOT NULL, agent TEXT NOT NULL, scope_json TEXT NOT NULL, root TEXT NOT NULL,
 state TEXT NOT NULL, files INTEGER NOT NULL, truncated_json TEXT NOT NULL, instructions TEXT NOT NULL,
 findings_json TEXT, unparsed INTEGER NOT NULL DEFAULT 0, reviewer_answer_seen TEXT, turn_id TEXT,
 error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS agent_reviews_session ON agent_reviews(session_id, created_at);
 CREATE UNIQUE INDEX IF NOT EXISTS agent_reviews_reviewer ON agent_reviews(reviewer_session_id);";

pub fn initialize(db: &Database) -> Result<()> { db.transaction(|tx| Ok(tx.execute_batch(SCHEMA)?)) }

pub(crate) fn is_reviewer(db: &Database, session_id: &str) -> Result<bool> {
    db.transaction(|tx| {
        match tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_reviews WHERE reviewer_session_id=?)", [session_id], |r| r.get(0)) {
            Ok(value) => Ok(value),
            // Legacy fixtures instantiate the service without main's schema setup.
            Err(rusqlite::Error::SqliteFailure(_, Some(message))) if message == "no such table: agent_reviews" => Ok(false),
            Err(error) => Err(error.into()),
        }
    })
}

fn fault(code: &str) -> anyhow::Error { ProviderError::new(code, code).into() }

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Scope { Checkpoints { from: String, to: Option<String> }, Uncommitted }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartRequest { pub session_id: String, pub agent: String, pub scope: Scope, pub operation_id: String }

#[derive(Debug)]
pub(crate) struct Prompt { pub text: String, pub instructions: &'static str, pub truncated: Vec<String> }

fn diff_section(path: &str, diff: &str) -> String { format!("### {path}\n\n```diff\n{diff}\n```\n\n") }

pub(crate) fn retain_file(mut file: ReviewFile, remaining: &mut usize, exhausted: &mut bool) -> ReviewFile {
    if file.binary { return file; }
    let size = file.diff.as_ref().map(|diff| diff_section(&file.path, diff).len());
    if !*exhausted && size.is_some_and(|size| size <= *remaining) { *remaining -= size.unwrap(); }
    else { file.diff = None; *exhausted = true; }
    file
}

pub(crate) fn build_prompt(root: &Path, description: &str, files: &[ReviewFile]) -> Prompt {
    let repository = crate::workspace_services::scoped_path(root, ".threadterm/review.md", true).ok()
        .and_then(|p| fs::metadata(&p).ok().filter(|m| m.is_file() && m.len() <= INSTRUCTION_BUDGET).map(|_| p))
        .and_then(|p| {
            use std::io::Read;
            let mut bytes = Vec::new();
            fs::File::open(p).ok()?.take(INSTRUCTION_BUDGET + 1).read_to_end(&mut bytes).ok()?;
            Some(bytes)
        }).filter(|bytes| bytes.len() <= INSTRUCTION_BUDGET as usize)
        .and_then(|bytes| String::from_utf8(bytes).ok());
    let instructions = if repository.is_some() { "repository" } else { "built-in" };
    let mut text = format!("{}\n\n## What to review\n\n{description}\n\n## Changed files\n\n", repository.as_deref().unwrap_or(BUILT_IN));
    for file in files { text.push_str(&format!("{} {}{}\n", file.status, file.path, if file.binary { " (binary; not inlined)" } else { "" })); }
    text.push_str("\n## Diffs\n\n");
    let (mut used, mut exhausted) = (0, false);
    let mut truncated = Vec::new();
    for file in files {
        if file.binary { continue; }
        let section = file.diff.as_ref().map(|diff| diff_section(&file.path, diff));
        match section {
            Some(section) if !exhausted && used + section.len() <= DIFF_BUDGET => { used += section.len(); text.push_str(&section); }
            _ => { exhausted = true; truncated.push(file.path.clone()); }
        }
    }
    if !truncated.is_empty() { text.push_str("## Truncated\n\nThese files were omitted from the diff budget:\n"); for path in &truncated { text.push_str(&format!("- {path}\n")); } text.push('\n'); }
    text.push_str(FINAL_BLOCK);
    Prompt { text, instructions, truncated }
}

fn checkpoint_label(db: &Database, session: &str, id: &str) -> Result<String> {
    db.transaction(|tx| {
        tx.query_row("SELECT COALESCE(label,created_at) FROM review_checkpoints WHERE id=? AND session_id=? AND status='ready'", params![id,session], |r| r.get(0)).optional()?.ok_or_else(|| fault("checkpoint_not_found"))
    })
}

/// Validation order is user-visible. The gate spans cap validation, capture,
/// session creation and row insertion so concurrent starts cannot exceed three.
pub(crate) fn prepare(db: &Database, providers: &Providers, request: &StartRequest) -> Result<(crate::domain::Session, String, PathBuf, Vec<ReviewFile>, Prompt)> {
    let session = db.session_by_id(&request.session_id)?.ok_or_else(|| fault("session_not_found"))?;
    if !providers.contains(&request.agent) { return Err(fault("unknown_agent")); }
    if !crate::delegation::available_agents(providers).contains(&request.agent) { return Err(fault("agent_unavailable")); }
    let count: i64 = db.transaction(|tx| Ok(tx.query_row("SELECT COUNT(*) FROM agent_reviews WHERE session_id=? AND state IN ('starting','running')", [&session.id], |r| r.get(0))?))?;
    if count >= 3 { return Err(fault("agent_review_limit")); }
    let description = match &request.scope {
        Scope::Checkpoints { from, to } => {
            let label = checkpoint_label(db, &session.id, from)?;
            let end = to.as_deref().map(|id| checkpoint_label(db, &session.id, id)).transpose()?;
            format!("Changes in session \"{}\" since checkpoint {} up to {}.", session.title, label, end.as_deref().unwrap_or("now"))
        }
        Scope::Uncommitted => String::new(),
    };
    let cwd = crate::delegation::session_cwd(db, &session)?;
    let root = if let Some(project) = &session.project_id { crate::workspace_services::workspace_root_for_cwd(db, project, &cwd)? } else { PathBuf::from(&cwd).canonicalize()? };
    let root = crate::git_read::plain_path(&root);
    let (files, description) = match &request.scope {
        Scope::Checkpoints { from, to } => (crate::review::unified_snapshot(db, &session.id, from, to.as_deref())?, description),
        Scope::Uncommitted => {
            crate::git_read::repo_prefix(&root).map_err(|_| fault("not_a_git_worktree"))?;
            let head = crate::git_read::git_text(&root, &["rev-parse", "--short", "HEAD"])?;
            (uncommitted_snapshot(&root)?, format!("Uncommitted changes against HEAD {}.", head.trim()))
        }
    };
    if files.is_empty() { return Err(fault("no_changes")); }
    let prompt = build_prompt(&root, &description, &files);
    Ok((session, cwd, root, files, prompt))
}

pub(crate) fn uncommitted_snapshot(root: &Path) -> Result<Vec<ReviewFile>> {
    use crate::git_read::{git_text, run_git, LOCAL_TIMEOUT};
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let output = git_text(root, &["diff", "HEAD", "--name-status", "-z", "--no-renames", "--relative", "--", "."])?;
    let mut parts = output.split('\0').filter(|s| !s.is_empty());
    let mut targets = Vec::new();
    while let (Some(status), Some(path)) = (parts.next(), parts.next()) { targets.push((path.to_owned(),status.chars().next().unwrap_or('M').to_string(),true)); }
    let untracked = run_git(root, &["ls-files", "--others", "--exclude-standard", "-z", "--", "."], &[], None, LOCAL_TIMEOUT)?;
    targets.extend(String::from_utf8_lossy(&untracked).split('\0').filter(|s| !s.is_empty()).map(|path| (path.to_owned(),"A".into(),false)));
    targets.sort_by(|a,b| a.0.cmp(&b.0));
    let mut files = Vec::new();
    let binary_paths = crate::review::binary_diff_paths(&run_git(root, &["diff", "HEAD", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative", "--", "."], &[], None, LOCAL_TIMEOUT)?);
    let (mut remaining, mut exhausted) = (DIFF_BUDGET, false);
    for (path, status, tracked) in targets {
        if tracked {
        let binary = binary_paths.contains(&path);
        let diff = if binary { Some(String::new()) } else if exhausted { None } else {
            crate::review::bounded_unified_diff(root, &["diff", "HEAD", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--relative", "--", &path], &[], remaining, deadline)?
        };
        files.push(retain_file(ReviewFile { path, status, diff, binary }, &mut remaining, &mut exhausted));
        continue;
        }
        let target = crate::workspace_services::scoped_path(root, &path, true)?;
        let metadata = fs::metadata(&target)?;
        if !metadata.is_file() { continue; }
        use std::io::Read;
        let mut bytes = Vec::new();
        let read_limit = if exhausted { 8192 } else { remaining + 1 };
        fs::File::open(target)?.take(read_limit as u64).read_to_end(&mut bytes)?;
        let content = crate::git_read::text_of(&bytes);
        let partial = bytes.len() as u64 != metadata.len();
        let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).err().is_some_and(|error| error.error_len().is_some() || !partial);
        let diff = content.filter(|_| !exhausted && bytes.len() as u64 == metadata.len() && std::time::Instant::now() < deadline).map(|text| {
            let lines: Vec<_> = text.lines().collect();
            let mut patch = format!("diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n");
            if !lines.is_empty() { patch.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len())); }
            for line in lines { patch.push('+'); patch.push_str(line); patch.push('\n'); }
            if !text.is_empty() && !text.ends_with('\n') { patch.push_str("\\ No newline at end of file\n"); }
            patch
        });
        files.push(retain_file(ReviewFile { path, status, diff: if binary { Some(String::new()) } else { diff }, binary }, &mut remaining, &mut exhausted));
    }
    Ok(files)
}

fn event(tx: &Transaction<'_>, session_id: &str) -> Result<()> {
    tx.execute("INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)", params![json!({"kind":"agentReview","sessionId":session_id}).to_string(), Utc::now().to_rfc3339()])?;
    Ok(())
}

fn row_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut value = json!({"id":row.get::<_,String>(0)?,"sessionId":row.get::<_,String>(1)?,"reviewerSessionId":row.get::<_,String>(2)?,"agent":row.get::<_,String>(3)?,"scope":serde_json::from_str::<Value>(&row.get::<_,String>(4)?).unwrap_or(Value::Null),"state":row.get::<_,String>(5)?,"files":row.get::<_,i64>(6)?,"truncated":serde_json::from_str::<Value>(&row.get::<_,String>(7)?).unwrap_or(json!([])),"instructions":row.get::<_,String>(8)?,"createdAt":row.get::<_,String>(9)?,"updatedAt":row.get::<_,String>(10)?});
    if let Some(findings) = row.get::<_,Option<String>>(11)? { value["findings"] = serde_json::from_str(&findings).unwrap_or(json!([])); }
    if row.get::<_,bool>(12)? { value["unparsed"] = json!(true); }
    if let Some(error) = row.get::<_,Option<String>>(13)? { value["error"] = json!(error); }
    Ok(value)
}
const COLUMNS: &str = "id,session_id,reviewer_session_id,agent,scope_json,state,files,truncated_json,instructions,created_at,updated_at,findings_json,unparsed,error";
pub(crate) fn get(db: &Database, id: &str) -> Result<Value> {
    db.transaction(|tx| tx.query_row(&format!("SELECT {COLUMNS} FROM agent_reviews WHERE id=?"), [id], row_value).optional()?.ok_or_else(|| fault("review_not_found")))
}

fn state(db: &Database, id: &str, next: &str, error: Option<&str>) -> Result<()> {
    db.transaction(|tx| {
        let changed = tx.execute("UPDATE agent_reviews SET state=?,error=?,updated_at=? WHERE id=? AND (state<>? OR COALESCE(error,'')<>COALESCE(?,'')) AND (?<>'running' OR state='starting') AND (?<>'completed' OR state='running')", params![next,error,Utc::now().to_rfc3339(),id,next,error,next,next])?;
        if changed > 0 { let session: String = tx.query_row("SELECT session_id FROM agent_reviews WHERE id=?", [id], |r| r.get(0))?; event(tx, &session)?; }
        Ok(())
    })
}

pub(crate) fn parse_answer(root: &Path, answer: &str) -> (Option<Vec<Value>>, bool) {
    let mut last = None;
    let mut collecting = false;
    let mut body = String::new();
    for line in answer.lines() {
        if line.trim() == "```threadterm-review" { collecting = true; body.clear(); last = None; }
        else if collecting && line.trim() == "```" { last = Some(body.clone()); collecting = false; }
        else if collecting { body.push_str(line); body.push('\n'); }
    }
    let Some(Value::Array(entries)) = last.and_then(|s| serde_json::from_str::<Value>(&s).ok()) else { return (None, true); };
    let mut findings = Vec::new();
    for entry in entries {
        let severity = entry["severity"].as_str().unwrap_or("");
        if !matches!(severity, "high"|"medium"|"low"|"info") { continue; }
        let title = entry["title"].as_str().unwrap_or("").trim();
        if title.is_empty() || title.chars().count() > 200 { continue; }
        let body = entry["body"].as_str().unwrap_or("");
        let body = if body.chars().count() > 4000 { body.chars().take(3999).collect::<String>() + "…" } else { body.into() };
        let mut finding = json!({"id":uuid::Uuid::new_v4().to_string(),"severity":severity,"title":title,"body":body,"state":"open"});
        if let Some(path) = entry["path"].as_str().and_then(|s| normalize_path(root, s)) {
            finding["path"] = json!(path);
            if let Some(line) = entry["line"].as_u64().filter(|line| *line > 0 && *line <= 9_007_199_254_740_991) { finding["line"] = json!(line); }
        }
        findings.push(finding);
        if findings.len() == 100 { break; }
    }
    (Some(findings), false)
}

fn normalize_path(root: &Path, path: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    if path.starts_with('/') || path.contains(':') || path.split('/').any(|p| p == "..") { return None; }
    let path = path.split('/').filter(|part| !part.is_empty() && *part != ".").collect::<Vec<_>>().join("/");
    crate::git_read::validate_relative(&path).ok()?;
    // Missing/deleted files can still carry a valid path. Resolve the nearest
    // existing ancestor, so junctions/symlinks cannot disguise an escape.
    let canonical_root = root.canonicalize().ok()?;
    let mut ancestor = root.join(&path);
    while fs::symlink_metadata(&ancestor).is_err() { if !ancestor.pop() { return None; } }
    if !ancestor.canonicalize().ok()?.starts_with(&canonical_root) { return None; }
    Some(path)
}

/// The reviewer's newest assistant message with content, in `chat_items` order. Only assistant rows are decoded, newest
/// first, so a list never decodes the reviewer's first message (it carries the whole captured diff).
fn last_answer(db: &Database, reviewer: &str) -> Result<Option<crate::domain::ChatItem>> {
    db.transaction(|tx| {
        let mut statement = tx.prepare("SELECT data FROM chat_items WHERE session_id=? AND json_extract(data,'$.role')='assistant' ORDER BY created_at DESC,id DESC")?;
        let mut rows = statement.query([reviewer])?;
        while let Some(row) = rows.next()? {
            let item: crate::domain::ChatItem = serde_json::from_str(&row.get::<_, String>(0)?)?;
            // Empty duration-only completion carriers are metadata, not replies.
            if !item.parts.is_empty() { return Ok(Some(item)); }
        }
        Ok(None)
    })
}

pub(crate) fn list(db: &Database, session_id: &str) -> Result<Value> {
    if db.session_by_id(session_id)?.is_none() { return Err(fault("session_not_found")); }
    let rows = db.transaction(|tx| {
        let mut statement = tx.prepare(&format!("SELECT {COLUMNS} FROM agent_reviews WHERE session_id=? AND (state IN ('starting','running') OR id IN (SELECT id FROM agent_reviews WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20)) ORDER BY created_at DESC,rowid DESC"))?;
        let rows = statement.query_map([session_id,session_id], row_value)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;
    let mut result = Vec::new();
    for row in rows {
        let id = row["id"].as_str().unwrap();
        let reviewer = row["reviewerSessionId"].as_str().unwrap();
        let current = row["state"].as_str().unwrap();
        let session = db.session_by_id(reviewer)?;
        if session.is_none() && matches!(current, "starting"|"running") { state(db, id, "failed", Some("The reviewer session was deleted"))?; }
        else if current != "failed" && current != "completed" {
            let Some(session) = session else { continue; };
            let turn: Option<String> = db.transaction(|tx| Ok(tx.query_row("SELECT turn_id FROM agent_reviews WHERE id=?", [id], |r| r.get(0))?))?;
            let completed = current == "running" && (session.activity.as_ref().is_some_and(|activity| {
                matches!(activity.state.as_str(), "awaiting_input"|"idle") && activity.reason.is_none() && activity.turn_id.is_some() && (turn.is_none() || turn == activity.turn_id)
            }) || if let Some(turn) = &turn {
                // Completion attention can be acknowledged or superseded by a
                // newer turn before the first list. Its durable event still
                // proves that this review's original turn succeeded.
                db.transaction(|tx| Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE event='session.activity' AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.activity.turnId')=? AND json_extract(data,'$.activity.state')='awaiting_input' AND created_at>=?)", params![reviewer,turn,row["createdAt"].as_str().unwrap()], |r| r.get::<_,bool>(0))?))?
            } else { false });
            if completed { state(db, id, "completed", None)?; }
            else if matches!(session.status.as_str(), "exited"|"interrupted"|"error") {
                state(db, id, "failed", Some(&format!("The reviewer session {} before completing", session.status)))?;
            } else if current == "running" {
                if let Some(activity) = &session.activity {
                    if matches!(activity.reason.as_deref(), Some("terminal"|"error")) { state(db, id, "failed", Some("The reviewer turn was stopped or failed before completing"))?; }
                }
            }
        }
        let updated = get(db, id)?;
        if updated["state"] == "completed" && db.session_by_id(reviewer)?.is_some_and(|session| !matches!(session.status.as_str(),"starting"|"running"|"waiting") && !session.activity.is_some_and(|a| matches!(a.state.as_str(),"running"|"awaiting_approval"))) {
            let answer = last_answer(db, reviewer)?;
            let answer = answer.as_ref();
            let text = answer.map(|item| item.parts.iter().filter(|p| p["type"] == "text").filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default();
            let seen = hex::encode(Sha256::digest(format!("{}\n{text}", answer.map(|i| i.id.as_str()).unwrap_or("")).as_bytes()));
            let (root, previous): (String,Option<String>) = db.transaction(|tx| Ok(tx.query_row("SELECT root,reviewer_answer_seen FROM agent_reviews WHERE id=?", [id], |r| Ok((r.get(0)?,r.get(1)?)))?))?;
            if previous.as_deref() != Some(&seen) {
                let (findings, unparsed) = parse_answer(Path::new(&root), &text);
                db.transaction(|tx| {
                    let changed = tx.execute("UPDATE agent_reviews SET findings_json=?,unparsed=?,reviewer_answer_seen=?,updated_at=? WHERE id=? AND reviewer_answer_seen IS ? AND state='completed' AND EXISTS(SELECT 1 FROM sessions WHERE id=reviewer_session_id AND status NOT IN ('starting','running','waiting'))", params![findings.map(|f|json!(f).to_string()),unparsed,seen,Utc::now().to_rfc3339(),id,previous])?;
                    if changed > 0 { event(tx, session_id)?; }
                    Ok(())
                })?;
            }
        }
        if result.len() < 20 { result.push(get(db, id)?); }
    }
    Ok(json!(result))
}

pub(crate) fn mark(db: &Database, params: &Value) -> Result<Value> {
    let id = params["reviewId"].as_str().ok_or_else(|| fault("invalid_request"))?;
    let operation = params["operationId"].as_str().filter(|s|!s.is_empty()).ok_or_else(|| fault("invalid_request"))?;
    let next = params["state"].as_str().filter(|s| matches!(*s,"open"|"added"|"dismissed")).ok_or_else(|| fault("invalid_request"))?;
    let ids = params["findingIds"].as_array().filter(|v| !v.is_empty() && v.len() <= 100).ok_or_else(|| fault("invalid_request"))?;
    db.bind_operation(operation, "agentReview.mark", params)?;
    if let Some(result) = db.operation(operation)? { return Ok(result); }
    db.transaction(|tx| {
        let previous: Option<String> = tx.query_row("SELECT result FROM operations WHERE id=?", [operation], |r| r.get(0)).optional()?;
        if let Some(result) = previous { return Ok(serde_json::from_str(&result)?); }
        let mut value = tx.query_row(&format!("SELECT {COLUMNS} FROM agent_reviews WHERE id=?"), [id], row_value).optional()?.ok_or_else(|| fault("review_not_found"))?;
        let mut findings = value["findings"].as_array().cloned().unwrap_or_default();
        if ids.iter().any(|id| !id.is_string() || !findings.iter().any(|finding| finding["id"] == *id)) { return Err(fault("finding_not_found")); }
        let changed = findings.iter().any(|f| ids.contains(&f["id"]) && f["state"] != next);
        if changed {
            for finding in &mut findings { if ids.contains(&finding["id"]) { finding["state"] = json!(next); } }
            let now = Utc::now().to_rfc3339();
            tx.execute("UPDATE agent_reviews SET findings_json=?,updated_at=? WHERE id=?", params![json!(findings).to_string(),now,id])?;
            value["findings"] = json!(findings); value["updatedAt"] = json!(now);
            event(tx, value["sessionId"].as_str().unwrap())?;
        }
        crate::git_actions::complete(tx, operation, "agentReview.mark", &value)?;
        Ok(value)
    })
}

fn run_start(db: &Database, providers: &Providers, id: &str, reviewer: &str, agent: &str, prompt: &str, operation: &str) -> Result<()> {
    crate::service::connect_chat_session(db, providers, reviewer)?;
    if agent == "codex" {
        if providers.chat_options(reviewer).ok().and_then(|v| v["options"].as_array().cloned()).is_some_and(|options| options.iter().any(|o| o["id"] == "sandbox" && o["choices"].as_array().is_some_and(|c| c.iter().any(|c| c["value"] == "read-only")))) {
            let _ = providers.chat_set_option(reviewer, "sandbox", "read-only");
        }
    }
    let result = crate::service::send_chat_message(db, providers, reviewer, prompt, &[], operation)?;
    db.transaction(|tx| {
        tx.execute("UPDATE agent_reviews SET turn_id=? WHERE id=?", params![result["turnId"].as_str(),id])?;
        Ok(())
    })?;
    state(db, id, "running", None)
}

pub fn dispatch(db: &Arc<Database>, providers: &Arc<Providers>, method: &str, params: &Value, create: &dyn Fn(&Value) -> Result<Value>) -> Result<Value> {
    match method {
        "agentReview.list" => list(db, params["sessionId"].as_str().ok_or_else(|| fault("invalid_request"))?),
        "agentReview.mark" => mark(db, params),
        "agentReview.start" => {
            let request: StartRequest = serde_json::from_value(params.clone()).map_err(|_| fault("invalid_request"))?;
            if request.operation_id.is_empty() { return Err(fault("invalid_request")); }
            db.bind_operation(&request.operation_id, method, params)?;
            let _gate = START_GATE.lock().map_err(|_| anyhow!("review gate poisoned"))?;
            if let Some(value) = db.operation(&request.operation_id)? { return Ok(value); }
            // Reconcile on an explicit request, so completed reviews don't hold cap slots.
            if db.session_by_id(&request.session_id)?.is_some() { list(db, &request.session_id)?; }
            let (session, cwd, root, files, prompt) = prepare(db, providers, &request)?;
            let created = create(&json!({"projectId":session.project_id,"cwd":cwd,"title":format!("Review: {}",session.title).chars().take(120).collect::<String>(),"provider":request.agent,"mode":"chat","operationId":format!("{}:session",request.operation_id)}))?;
            let reviewer = created["id"].as_str().ok_or_else(|| anyhow!("session_create_failed"))?.to_owned();
            let id = uuid::Uuid::new_v4().to_string();
            let now = Utc::now().to_rfc3339();
            db.transaction(|tx| {
                tx.execute("INSERT INTO agent_reviews(id,session_id,reviewer_session_id,agent,scope_json,root,state,files,truncated_json,instructions,created_at,updated_at) VALUES(?,?,?,?,?,?,'starting',?,?,?,?,?)", params![id,session.id,reviewer,request.agent,params["scope"].to_string(),root.to_string_lossy(),files.len(),json!(prompt.truncated).to_string(),prompt.instructions,now,now])?;
                event(tx, &session.id)
            })?;
            let result = get(db, &id)?;
            db.complete_operation(&request.operation_id, method, &result)?;
            let (worker_db, worker_providers) = (Arc::clone(db), Arc::clone(providers));
            let worker_id = id.clone();
            let spawned = std::thread::Builder::new().name(format!("review-{}", &id[..8])).spawn(move || {
                if let Err(error) = run_start(&worker_db, &worker_providers, &worker_id, &reviewer, &request.agent, &prompt.text, &format!("{}:send",request.operation_id)) { let _ = state(&worker_db, &worker_id, "failed", Some(&format!("The reviewer could not start: {error}"))); }
            });
            if let Err(error) = spawned { state(db, &id, "failed", Some(&format!("The reviewer could not start: {error}")))?; }
            Ok(result)
        }
        _ => Err(fault("unknown_method")),
    }
}
