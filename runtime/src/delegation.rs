//! Agent delegation (one level, Chat only).
//!
//! A parent Chat session of a verified agent opens with ThreadTerm's MCP host
//! (`threadterm-v3-mcp`, `delegation` profile) carrying that session's id and a
//! per-open token. Through it the parent's agent starts other agents as visible
//! Chat sessions, follows them, answers their approval requests and reads their
//! results (`delegation.*` RPCs). A delegated session never gets the server,
//! and the runtime rejects delegation calls whose caller has a parent.
//!
//! Approval routing lives in `chat_projection` (it owns approval cards and the
//! Inbox); this module owns the delegation rows, their state machine and RPCs.
use crate::{
    config::RuntimeConfig,
    db::Database,
    domain::Session,
    providers::{ChatToolServer, ProviderRuntime, Providers, ToolServerResolver},
};
use anyhow::{anyhow, Result};
use chrono::Utc;
use rand::RngCore;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

/// Agents whose MCP injection, tool calls and approval handling were verified
/// live (spike 2026-10-01). Any Chat-capable agent can be a delegate.
pub const PARENT_PROVIDERS: [&str; 4] = ["claude", "codex", "kimi", "grok"];
pub const MAX_ACTIVE_DELEGATES: i64 = 4;
pub const TOOL_SERVER_NAME: &str = "threadterm";
/// The per-chat snapshot of the in-conversation tool settings. Missing values
/// deliberately mean enabled so existing installations retain their current
/// delegation behaviour and newly introduced tools are available by default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ChatToolSettings {
    pub ask: bool,
    pub session_info: bool,
    pub feedback: bool,
    pub delegation: bool,
}

impl Default for ChatToolSettings {
    fn default() -> Self {
        Self { ask: true, session_info: true, feedback: true, delegation: true }
    }
}

pub(crate) fn chat_tool_settings(db: &Database) -> Result<ChatToolSettings> {
    let mut result = ChatToolSettings::default();
    let settings = db.settings_value()?;
    if let Some(value) = settings.get("chatTools.ask").and_then(Value::as_bool) { result.ask = value; }
    if let Some(value) = settings.get("chatTools.sessionInfo").and_then(Value::as_bool) { result.session_info = value; }
    if let Some(value) = settings.get("chatTools.feedback").and_then(Value::as_bool) { result.feedback = value; }
    if let Some(value) = settings.get("chatTools.delegation").and_then(Value::as_bool) { result.delegation = value; }
    Ok(result)
}
/// The `delegation` profile's tools (`mcp_delegation::tools`). Adapters
/// auto-approve the parent's calls to exactly these names and nothing else.
pub const TOOL_NAMES: [&str; 6] = [
    "delegate_start",
    "delegate_status",
    "delegate_wait",
    "delegate_respond",
    "delegate_result",
    "delegate_cancel",
];
/// The live (non-terminal) link states; `ACTIVE_STATES` is their SQL literal
/// (a unit test keeps the two in step).
const LIVE_STATES: [&str; 6] = ["starting", "running", "awaiting_parent", "awaiting_user", "cancelling", "cancel_failed"];
const ACTIVE_STATES: &str = "('starting','running','awaiting_parent','awaiting_user','cancelling','cancel_failed')";
/// States in which a stop was requested but not observed yet: the turn may
/// still be working, so they hold capacity and keep the link non-terminal.
const STOP_REQUESTED_STATES: [&str; 2] = ["cancelling", "cancel_failed"];
/// The delegate's runtime died mid-turn (startup reconciliation).
pub(crate) const INTERRUPTED_REASON: &str = "The runtime stopped before the delegated turn finished";
/// Error messages that are also the RPC error code the MCP host reports.
pub const ERROR_CODES: [&str; 17] = [
    "delegation_unauthorized",
    "delegation_nested",
    "delegation_limit_reached",
    "delegation_not_found",
    "delegation_not_awaiting_parent",
    "request_not_found",
    "request_not_pending_for_parent",
    "choice_reserved_for_user",
    "invalid_choice",
    "unknown_agent",
    "agent_unavailable",
    "invalid_prompt",
    "invalid_user_messages",
    "invalid_workspace",
    "worktree_requires_project",
    "worktree_requires_git",
    "worktree_unavailable",
];
const MAX_PROMPT_BYTES: usize = 256 * 1024;
const MAX_RESULT_CHARS: usize = 64 * 1024;
/// The user's latest messages from the parent chat that a delegate's first
/// message carries word for word (`userMessages`): by default the one that
/// started the parent's turn, at most this many, within these sizes.
pub const DEFAULT_USER_MESSAGES: u32 = 1;
pub const MAX_USER_MESSAGES: u32 = 10;
const MAX_USER_WORDS_CHARS: usize = 8_000;
const MAX_USER_MESSAGE_CHARS: usize = 4_000;
/// Closes a first message that carries the user's words. Validation (task
/// 10-02-delegation-handoff): quoted to a delegate, the user's "delegate this"
/// read as its own instruction, and "take the narrower reading" as "do nothing".
const DELEGATE_NOTE: &str = "Note from ThreadTerm: the user's words above were said to the delegating agent and show what the user wants; your task is what the delegating agent asks of you. Say which [inferred] items you did or skipped. If that seems to conflict with the user's words, do the part that clearly doesn't conflict and report the conflict.";

/// Runtime-side delegation state shared by the service and the resolver.
#[derive(Default)]
pub struct Delegations {
    tokens: Mutex<HashMap<String, String>>,
    /// Serializes the cap check with the row insert across MCP connections.
    pub(crate) start_gate: Mutex<()>,
    /// Serializes a delegate's first send with a cancel (F09): a cancel that
    /// lands between the active check and the send produces no send.
    send_fence: Mutex<()>,
}

impl Delegations {
    /// Issues a fresh token for a session's Chat open; the previous one stops
    /// working, so only the live provider process can call as this session.
    pub fn issue_token(&self, session_id: &str) -> String {
        let mut bytes = [0_u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let token = hex::encode(bytes);
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.insert(session_id.to_owned(), token.clone());
        }
        token
    }

    fn token_matches(&self, session_id: &str, token: &str) -> bool {
        let Ok(tokens) = self.tokens.lock() else {
            return false;
        };
        tokens
            .get(session_id)
            .is_some_and(|expected| constant_time_eq(expected.as_bytes(), token.as_bytes()))
    }

    /// The caller must hold the current token of a Chat session that is not
    /// itself a delegate (one level only).
    pub(crate) fn authorize(&self, db: &Database, session_id: &str, token: &str) -> Result<Session> {
        if !self.token_matches(session_id, token) {
            return Err(anyhow!("delegation_unauthorized"));
        }
        let session = db
            .session_by_id(session_id)?
            .ok_or_else(|| anyhow!("delegation_unauthorized"))?;
        if session.mode != "chat" {
            return Err(anyhow!("delegation_unauthorized"));
        }
        if session.delegation.is_some() {
            return Err(anyhow!("delegation_nested"));
        }
        Ok(session)
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && left.iter().zip(right).fold(0_u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// Packaged and cargo builds place the MCP host next to the runtime binary.
pub fn default_mcp_executable() -> Option<PathBuf> {
    let name = if cfg!(windows) { "threadterm-v3-mcp.exe" } else { "threadterm-v3-mcp" };
    let candidate = std::env::current_exe().ok()?.parent()?.join(name);
    candidate.is_file().then_some(candidate)
}

/// Installed on `Providers`: decides per Chat open whether the session gets
/// ThreadTerm's delegation tools, and mints that open's token.
pub fn tool_server_resolver(
    db: Arc<Database>,
    delegations: Arc<Delegations>,
    config: RuntimeConfig,
    mcp_executable: Option<PathBuf>,
) -> ToolServerResolver {
    Arc::new(move |session_id: &str, provider: &str| {
        let Ok(settings) = chat_tool_settings(&db) else {
            return None;
        };
        if !settings.delegation {
            return None;
        }
        if !PARENT_PROVIDERS.contains(&provider) {
            return None;
        }
        let command = mcp_executable.as_ref()?;
        if crate::agent_review::is_reviewer(&db, session_id).unwrap_or(true) {
            return None;
        }
        // A delegated session never delegates; on any lookup error, no tools.
        match db.session_by_id(session_id) {
            Ok(Some(session)) if session.mode == "chat" && session.delegation.is_none() => {}
            _ => return None,
        }
        let token = delegations.issue_token(session_id);
        Some(ChatToolServer {
            name: TOOL_SERVER_NAME.into(),
            command: command.to_string_lossy().into_owned(),
            args: Vec::new(),
            env: vec![
                ("THREADTERM_MCP_PROFILE".into(), "delegation".into()),
                ("THREADTERM_SESSION_ID".into(), session_id.into()),
                ("THREADTERM_SESSION_TOKEN".into(), token),
                ("THREADTERM_V3_DATA".into(), config.data_dir.to_string_lossy().into_owned()),
                ("THREADTERM_V3_PIPE".into(), config.pipe_base.clone()),
            ],
        })
    })
}

// ---- rows -------------------------------------------------------------------

/// A delegated session's link while its delegation is still active.
#[derive(Debug, Clone)]
pub(crate) struct ChildLink {
    pub id: String,
    pub parent_session_id: String,
    pub state: String,
    /// The turn this link started: only its events settle the link (F08).
    pub turn_id: Option<String>,
}

pub(crate) fn active_link(tx: &Transaction<'_>, child_session_id: &str) -> Result<Option<ChildLink>> {
    tx.query_row(
        &format!("SELECT id,parent_session_id,state,turn_id FROM delegations WHERE child_session_id=? AND state IN {ACTIVE_STATES}"),
        [child_session_id],
        |row| Ok(ChildLink { id: row.get(0)?, parent_session_id: row.get(1)?, state: row.get(2)?, turn_id: row.get(3)? }),
    )
    .optional()
    .map_err(Into::into)
}

pub(crate) fn active_children(tx: &Transaction<'_>, parent_session_id: &str) -> Result<Vec<String>> {
    let mut statement = tx.prepare(&format!(
        "SELECT child_session_id FROM delegations WHERE parent_session_id=? AND state IN {ACTIVE_STATES} ORDER BY created_at"
    ))?;
    let rows = statement.query_map([parent_session_id], |row| row.get::<_, String>(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

/// A turn is running while the session is live and its activity says so; a
/// terminal session and an idle one have nothing left to stop.
fn turn_active(tx: &Transaction<'_>, session_id: &str) -> Result<bool> {
    let row: Option<(String, Option<String>)> = tx
        .query_row(
            "SELECT sessions.status,session_activity.state FROM sessions LEFT JOIN session_activity ON session_activity.session_id=sessions.id WHERE sessions.id=?",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row.is_some_and(|(status, state)| {
        !matches!(status.as_str(), "exited" | "interrupted" | "error")
            && matches!(state.as_deref(), Some("running" | "awaiting_approval"))
    }))
}

/// The parent agent can answer requests only while it is inside a turn.
pub(crate) fn parent_turn_active(tx: &Transaction<'_>, parent_session_id: &str) -> Result<bool> {
    turn_active(tx, parent_session_id)
}

/// A stop was requested and the child still owes us a turn end.
pub(crate) fn stop_requested(state: &str) -> bool {
    STOP_REQUESTED_STATES.contains(&state)
}

pub(crate) fn set_state(
    tx: &Transaction<'_>,
    delegation_id: &str,
    state: &str,
    result: Option<&str>,
    error: Option<&str>,
) -> Result<()> {
    let changed = tx.execute(
        &format!("UPDATE delegations SET state=?,result=COALESCE(?,result),error=COALESCE(?,error),updated_at=? WHERE id=? AND state IN {ACTIVE_STATES} AND (state<>? OR ? IS NOT NULL OR ? IS NOT NULL)"),
        params![state, result, error, Utc::now().to_rfc3339(), delegation_id, state, result, error],
    )?;
    if changed > 0 {
        let child: String =
            tx.query_row("SELECT child_session_id FROM delegations WHERE id=?", [delegation_id], |row| row.get(0))?;
        tx.execute(
            "INSERT INTO outbox(event,data,created_at) VALUES ('state.changed',?,?)",
            params![serde_json::to_string(&json!({"kind":"delegation","sessionId":child}))?, Utc::now().to_rfc3339()],
        )?;
    }
    Ok(())
}

/// Delegation state machine, driven by the delegated session's projected
/// events inside the projection transaction. Only the delegated turn counts:
/// terminal states are final, so later turns the user sends change nothing.
pub(crate) fn project_child_event(tx: &Transaction<'_>, link: &ChildLink, turn: Option<&str>, kind: &str, data: &Value) -> Result<()> {
    // The link answers for the turn it started (F08): an unrelated later turn
    // of the same child session cannot settle it.
    if !same_turn(link, turn) {
        return Ok(());
    }
    let started = link.state != "starting";
    let stopping = stop_requested(&link.state);
    match kind {
        "message.user" if !started => set_state(tx, &link.id, "running", None, None),
        // A pending stop keeps its state: the child still owes us a turn end.
        "chat.approval" | "chat.approval.resolved" if started && !stopping => {
            let state = match crate::chat_projection::pending_approval_route(tx, &child_of(tx, &link.id)?)? {
                Some("parent") => "awaiting_parent",
                Some(_) => "awaiting_user",
                None => "running",
            };
            set_state(tx, &link.id, state, None, None)
        }
        "chat.turn.completed" if started => {
            let state = match data.get("status").and_then(Value::as_str) {
                Some("cancelled" | "canceled" | "interrupted") => "cancelled",
                // An abort after the stop request is the stop, not a failure.
                Some("failed" | "error") if stopping => "cancelled",
                Some("failed" | "error") => "failed",
                _ => "completed",
            };
            let answer = final_answer(tx, &child_of(tx, &link.id)?)?;
            let error = (state == "failed").then(|| data.get("message").and_then(Value::as_str).unwrap_or("The delegated turn failed"));
            set_state(tx, &link.id, state, Some(&answer), error)
        }
        "chat.error" if started => {
            let message = data.get("message").and_then(Value::as_str).unwrap_or("Provider request failed");
            let answer = final_answer(tx, &child_of(tx, &link.id)?)?;
            let state = if stopping { "cancelled" } else { "failed" };
            set_state(tx, &link.id, state, Some(&answer), Some(message))
        }
        _ => Ok(()),
    }
}

/// A link settles only for the turn it started. Until the send reports that
/// turn (the link is `starting` then) and for rows written before binding
/// existed, any event counts. A later turn never matches a bound link.
fn same_turn(link: &ChildLink, turn: Option<&str>) -> bool {
    match (link.turn_id.as_deref(), turn) {
        (None, _) => true,
        (Some(bound), Some(turn)) => bound == turn,
        (Some(_), None) => false,
    }
}

fn child_of(tx: &Transaction<'_>, delegation_id: &str) -> Result<String> {
    tx.query_row("SELECT child_session_id FROM delegations WHERE id=?", [delegation_id], |row| row.get(0))
        .map_err(Into::into)
}

/// The delegate's answer: its assistant text, in transcript order.
fn final_answer(tx: &Transaction<'_>, child_session_id: &str) -> Result<String> {
    final_answer_for_turn(tx, child_session_id, None)
}

pub(crate) fn final_answer_for_turn(tx: &Transaction<'_>, child_session_id: &str, turn_id: Option<&str>) -> Result<String> {
    let mut statement = tx.prepare("SELECT data FROM chat_items WHERE session_id=? AND (? IS NULL OR turn_id=?) ORDER BY created_at,rowid")?;
    let rows = statement.query_map(params![child_session_id,turn_id,turn_id], |row| row.get::<_, String>(0))?;
    let mut texts = Vec::new();
    for row in rows {
        let Ok(item) = serde_json::from_str::<crate::domain::ChatItem>(&row?) else { continue };
        if item.role != "assistant" {
            continue;
        }
        for part in &item.parts {
            if part.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(text) = part.get("text").and_then(Value::as_str).filter(|text| !text.trim().is_empty()) {
                    texts.push(text.trim().to_owned());
                }
            }
        }
    }
    let answer = texts.join("\n\n");
    Ok(if turn_id.is_none() { truncate_answer(answer) } else { answer })
}

/// Keeps a result small enough for the delegating agent's context.
fn truncate_answer(answer: String) -> String {
    if answer.chars().count() > MAX_RESULT_CHARS {
        answer.chars().take(MAX_RESULT_CHARS).collect::<String>() + "\n…(truncated)"
    } else {
        answer
    }
}

pub(crate) struct NewDelegation<'a> {
    pub id: &'a str,
    pub parent_session_id: &'a str,
    pub child_session_id: &'a str,
    pub agent: &'a str,
    pub workspace: &'a str,
    pub workspace_path: &'a str,
    pub branch: Option<&'a str>,
    pub prompt: &'a str,
    /// How many of the user's messages the first message carries.
    pub user_messages: u32,
    pub operation_id: &'a str,
}

pub(crate) fn insert(db: &Database, row: &NewDelegation<'_>) -> Result<()> {
    db.transaction(|tx| {
        let now = Utc::now().to_rfc3339();
        tx.execute(
            "INSERT INTO delegations(id,parent_session_id,child_session_id,agent,workspace,workspace_path,branch,prompt,user_messages,operation_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'starting',?,?)",
            params![row.id, row.parent_session_id, row.child_session_id, row.agent, row.workspace, row.workspace_path, row.branch, row.prompt, row.user_messages, row.operation_id, now, now],
        )?;
        tx.execute(
            "INSERT INTO outbox(event,data,created_at) VALUES ('state.changed',?,?)",
            params![serde_json::to_string(&json!({"kind":"delegation","sessionId":row.child_session_id}))?, now],
        )?;
        Ok(())
    })
}

pub(crate) fn active_count(db: &Database, parent_session_id: &str) -> Result<i64> {
    db.transaction(|tx| {
        tx.query_row(
            &format!("SELECT COUNT(*) FROM delegations WHERE parent_session_id=? AND state IN {ACTIVE_STATES}"),
            [parent_session_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
    })
}

struct Row {
    id: String,
    child: String,
    agent: String,
    workspace: String,
    workspace_path: String,
    branch: Option<String>,
    operation_id: String,
    turn_id: Option<String>,
    state: String,
    result: Option<String>,
    error: Option<String>,
    created_at: String,
    updated_at: String,
}

fn rows(db: &Database, parent_session_id: &str) -> Result<Vec<Row>> {
    db.transaction(|tx| {
        let mut statement = tx.prepare(
            "SELECT id,child_session_id,agent,workspace,workspace_path,branch,operation_id,turn_id,state,result,error,created_at,updated_at FROM delegations WHERE parent_session_id=? ORDER BY created_at",
        )?;
        let rows = statement.query_map([parent_session_id], |row| {
            Ok(Row {
                id: row.get(0)?,
                child: row.get(1)?,
                agent: row.get(2)?,
                workspace: row.get(3)?,
                workspace_path: row.get(4)?,
                branch: row.get(5)?,
                operation_id: row.get(6)?,
                turn_id: row.get(7)?,
                state: row.get(8)?,
                result: row.get(9)?,
                error: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    })
}

fn owned_row(db: &Database, parent_session_id: &str, id: &str) -> Result<Row> {
    rows(db, parent_session_id)?
        .into_iter()
        .find(|row| row.id == id || row.child == id)
        .ok_or_else(|| anyhow!("delegation_not_found"))
}

// ---- start ------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartRequest {
    pub caller_session_id: String,
    pub caller_token: String,
    pub agent: String,
    pub prompt: String,
    pub title: Option<String>,
    pub workspace: Option<String>,
    /// The user's latest messages to attach (`DEFAULT_USER_MESSAGES` when absent).
    pub user_messages: Option<u32>,
    pub operation_id: String,
}

/// Agents that can be delegated to right now: installed and Chat-capable.
pub(crate) fn available_agents(providers: &Providers) -> Vec<String> {
    providers
        .capabilities()
        .into_iter()
        .filter(|capability| {
            capability.get("installed").and_then(Value::as_bool) == Some(true)
                && capability.get("chat").and_then(Value::as_bool) == Some(true)
        })
        .filter_map(|capability| capability.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

pub(crate) fn validate_start(db: &Database, providers: &Providers, parent: &Session, request: &StartRequest) -> Result<()> {
    if request.prompt.trim().is_empty() || request.prompt.len() > MAX_PROMPT_BYTES {
        return Err(anyhow!("invalid_prompt"));
    }
    if request.user_messages.is_some_and(|count| count > MAX_USER_MESSAGES) {
        return Err(anyhow!("invalid_user_messages"));
    }
    if !matches!(request.workspace.as_deref(), None | Some("shared" | "worktree")) {
        return Err(anyhow!("invalid_workspace"));
    }
    if !providers.contains(&request.agent) {
        return Err(anyhow!("unknown_agent"));
    }
    if !available_agents(providers).contains(&request.agent) {
        return Err(anyhow!("agent_unavailable"));
    }
    if active_count(db, &parent.id)? >= MAX_ACTIVE_DELEGATES {
        return Err(anyhow!("delegation_limit_reached"));
    }
    Ok(())
}

/// The user's own words for a delegate: the latest `count` user messages of the
/// parent chat (their text parts; an image-only message adds nothing), oldest
/// first. Newer messages claim the size budget first, so older ones are left
/// out first; returns how many were.
pub(crate) fn user_words(items: &[crate::domain::ChatItem], count: u32) -> (Vec<String>, usize) {
    let messages: Vec<Option<String>> = items
        .iter()
        .filter(|item| item.role == "user")
        .map(|item| {
            let text = item
                .parts
                .iter()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            let text = text.trim();
            (!text.is_empty()).then(|| text.to_owned())
        })
        .collect();
    let latest: Vec<&String> = messages[messages.len().saturating_sub(count as usize)..].iter().flatten().collect();
    let (mut words, mut total) = (Vec::new(), 0);
    for message in latest.iter().rev() {
        let text = if message.chars().count() > MAX_USER_MESSAGE_CHARS {
            message.chars().take(MAX_USER_MESSAGE_CHARS).collect::<String>() + "\n…(truncated)"
        } else {
            (*message).clone()
        };
        let size = text.chars().count();
        if total + size > MAX_USER_WORDS_CHARS {
            break;
        }
        total += size;
        words.push(text);
    }
    let left_out = latest.len() - words.len();
    words.reverse();
    (words, left_out)
}

/// The delegate's first message: the user's words quoted above the delegating
/// agent's prompt, and how to read the two together. Without words it is the
/// prompt unchanged.
pub(crate) fn first_message(words: &[String], left_out: usize, prompt: &str) -> String {
    if words.is_empty() {
        return prompt.to_owned();
    }
    let mut text = String::from("## User's words (attached by ThreadTerm from the delegating chat; verbatim, oldest first; later ones win)\n\n");
    if left_out > 0 {
        text.push_str(&format!("({left_out} earlier message(s) left out to stay within {MAX_USER_WORDS_CHARS} characters.)\n\n"));
    }
    for message in words {
        for line in message.lines() {
            text.push_str("> ");
            text.push_str(line);
            text.push('\n');
        }
        text.push('\n');
    }
    text.push_str("## From the delegating agent\n\n");
    text.push_str(prompt.trim_end());
    text.push_str("\n\n---\n");
    text.push_str(DELEGATE_NOTE);
    text
}

/// The folder the parent agent works in.
pub(crate) fn session_cwd(db: &Database, session: &Session) -> Result<String> {
    crate::session_configs::read(db, &session.id)?
        .map(|config| config.launch.cwd)
        .or_else(|| session.worktree_path.clone())
        .ok_or_else(|| anyhow!("cwd_required"))
}

/// Creates the delegate's own work branch from the commit the parent's folder
/// is on, in a sibling folder `<repo>.delegates/<agent>-<short>`, registered
/// as a project worktree. Uncommitted parent changes are not included.
pub(crate) fn create_worktree(
    db: &Database,
    parent: &Session,
    parent_cwd: &str,
    agent: &str,
    short: &str,
    operation_id: &str,
) -> Result<(String, String)> {
    let project_id = parent.project_id.as_deref().ok_or_else(|| anyhow!("worktree_requires_project"))?;
    // Canonical Windows paths carry the `\\?\` prefix, which git misreads.
    let root = crate::git_read::plain_path(&crate::workspace_services::workspace_root_for_cwd(db, project_id, parent_cwd)?);
    let head = git_output(Path::new(parent_cwd), &["rev-parse", "HEAD"]).map_err(|_| anyhow!("worktree_requires_git"))?;
    let name = root.file_name().and_then(|name| name.to_str()).ok_or_else(|| anyhow!("invalid_path"))?;
    let container = root.parent().ok_or_else(|| anyhow!("invalid_path"))?.join(format!("{name}.delegates"));
    std::fs::create_dir_all(&container)?;
    let path = container.join(format!("{agent}-{short}"));
    let branch = format!("threadterm/delegate-{agent}-{short}");
    crate::workspace_services::dispatch(
        db,
        "worktree.create",
        &json!({"projectId":project_id,"path":path.to_string_lossy(),"branch":branch,"createBranch":true,"startPoint":head,"operationId":format!("{operation_id}:worktree")}),
    )?
    .ok_or_else(|| anyhow!("worktree_unavailable"))?;
    // The delegate works in the plain path (the registry keeps its canonical form).
    Ok((path.to_string_lossy().into_owned(), branch))
}

fn git_output(cwd: &Path, args: &[&str]) -> Result<String> {
    let mut command = std::process::Command::new("git");
    command.current_dir(cwd).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output()?;
    if !output.status.success() {
        return Err(anyhow!("git_failed"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// Background start: connect the delegate's Chat and auto-send the prompt
/// through the same paths `chat.connect` and `chat.send` use.
pub(crate) fn run_start(
    delegations: &Delegations,
    db: &Database,
    providers: &Providers,
    delegation_id: &str,
    child_session_id: &str,
    prompt: &str,
    send_operation_id: &str,
) {
    let fail = |message: String| {
        let _ = db.transaction(|tx| set_state(tx, delegation_id, "failed", None, Some(&message)));
    };
    if let Err(error) = crate::service::connect_chat_session(db, providers, child_session_id) {
        return fail(format!("The delegated agent could not connect: {error}"));
    }
    // The fence with `cancel` (F09): a cancel that lands between the active
    // check and the send produces no send. Only these two steps need it, so a
    // slow connect never delays a cancel.
    let fence = match delegations.send_fence.lock() {
        Ok(fence) => fence,
        Err(_) => return fail("The delegation start fence is unavailable".into()),
    };
    if !is_active(db, delegation_id) {
        return;
    }
    match crate::service::send_chat_message(db, providers, child_session_id, prompt, &[], send_operation_id) {
        Ok(result) => {
            if let Some(turn_id) = result.get("turnId").and_then(Value::as_str) {
                // Bind the link to the turn it started: from here on only that
                // turn's events settle it (F08).
                let _ = db.transaction(|tx| {
                    tx.execute("UPDATE delegations SET turn_id=? WHERE id=?", params![turn_id, delegation_id])?;
                    Ok(())
                });
            }
        }
        Err(error) => fail(format!("The delegated prompt could not be sent: {error}")),
    }
    drop(fence);
}

fn is_active(db: &Database, delegation_id: &str) -> bool {
    db.transaction(|tx| {
        tx.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM delegations WHERE id=? AND state IN {ACTIVE_STATES})"),
            [delegation_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(Into::into)
    })
    .unwrap_or(false)
}

/// `session.stop` on a delegate ends its delegation as cancelled. The worker is
/// stopped, so the stop is observed (F09): cancelled is truthful here.
pub fn cancel_stopped(db: &Database, session_id: &str) -> Result<()> {
    db.transaction(|tx| match active_link(tx, session_id)? {
        Some(link) => set_state(tx, &link.id, "cancelled", None, None),
        None => Ok(()),
    })
}

/// Startup (F08): a link that was live when this runtime died is not live now.
/// Every non-terminal link becomes an explicit `interrupted` result that keeps
/// the delegate's partial answer and its worktree; the cap counts live states,
/// so capacity is free again and nothing is resent.
pub fn reconcile_interrupted(db: &Database) -> Result<usize> {
    db.transaction(|tx| {
        let links: Vec<(String, String, Option<String>)> = {
            let mut statement = tx.prepare(&format!(
                "SELECT id,child_session_id,turn_id FROM delegations WHERE state IN {ACTIVE_STATES}"
            ))?;
            let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (id, child, turn) in &links {
            let partial = truncate_answer(final_answer_for_turn(tx, child, turn.as_deref())?);
            let partial = (!partial.trim().is_empty()).then_some(partial);
            set_state(tx, id, "interrupted", partial.as_deref(), Some(INTERRUPTED_REASON))?;
        }
        Ok(links.len())
    })
}

// ---- status / respond / result / cancel --------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusRequest {
    caller_session_id: String,
    caller_token: String,
    #[serde(default)]
    ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RespondRequest {
    caller_session_id: String,
    caller_token: String,
    id: String,
    request_id: String,
    choice_id: String,
    operation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OneRequest {
    caller_session_id: String,
    caller_token: String,
    id: String,
}

fn parse<T: for<'de> Deserialize<'de>>(params: &Value) -> Result<T> {
    serde_json::from_value(params.clone()).map_err(|error| anyhow!("invalid_request: {error}"))
}

/// `delegation.status`, `delegation.respond`, `delegation.result` and
/// `delegation.cancel`. `delegation.start` needs session creation and lives in
/// the service. Returns `None` for other methods.
pub(crate) fn dispatch(
    delegations: &Delegations,
    db: &Database,
    providers: &Providers,
    method: &str,
    params: &Value,
) -> Result<Option<Value>> {
    let value = match method {
        "delegation.status" => {
            let request: StatusRequest = parse(params)?;
            let parent = delegations.authorize(db, &request.caller_session_id, &request.caller_token)?;
            status(db, providers, &parent, &request.ids)?
        }
        "delegation.respond" => {
            let request: RespondRequest = parse(params)?;
            let parent = delegations.authorize(db, &request.caller_session_id, &request.caller_token)?;
            respond(db, providers, &parent, &request)?
        }
        "delegation.result" => {
            let request: OneRequest = parse(params)?;
            let parent = delegations.authorize(db, &request.caller_session_id, &request.caller_token)?;
            result(db, &parent, &request.id)?
        }
        "delegation.cancel" => {
            let request: OneRequest = parse(params)?;
            let parent = delegations.authorize(db, &request.caller_session_id, &request.caller_token)?;
            cancel(delegations, db, providers, &parent, &request.id)?
        }
        _ => return Ok(None),
    };
    Ok(Some(value))
}

fn status(db: &Database, providers: &Providers, parent: &Session, ids: &[String]) -> Result<Value> {
    let delegates = rows(db, &parent.id)?
        .into_iter()
        .filter(|row| ids.is_empty() || ids.contains(&row.id) || ids.contains(&row.child))
        .map(|row| {
            let title = db.session_by_id(&row.child)?.map(|session| session.title).unwrap_or_default();
            let pending = if row.state == "awaiting_parent" { pending_requests(db, &row.child)? } else { Vec::new() };
            Ok(json!({
                "delegationId": row.id,
                "sessionId": row.child,
                "agent": row.agent,
                "title": title,
                "state": row.state,
                "workspace": row.workspace,
                "workspacePath": row.workspace_path,
                "branch": row.branch,
                "pendingRequests": pending,
                "error": row.error,
                "createdAt": row.created_at,
                "updatedAt": row.updated_at,
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"delegates": delegates, "availableAgents": available_agents(providers), "maxActive": MAX_ACTIVE_DELEGATES}))
}

/// Requests routed to the parent and still pending, without the choices the
/// parent may not pick (`persistent`, i.e. "always allow" rules).
fn pending_requests(db: &Database, child_session_id: &str) -> Result<Vec<Value>> {
    let items = db.chat_items(child_session_id)?;
    let mut requests = Vec::new();
    for item in items {
        for part in &item.parts {
            if part.get("type").and_then(Value::as_str) != Some("approval")
                || !matches!(part.get("status").and_then(Value::as_str), Some("pending"))
                || part.pointer("/data/delegation/route").and_then(Value::as_str) != Some("parent")
            {
                continue;
            }
            let data = part.get("data").cloned().unwrap_or(Value::Null);
            let choices = data
                .get("choices")
                .and_then(Value::as_array)
                .map(|choices| choices.iter().filter(|choice| choice.get("scope").and_then(Value::as_str) != Some("persistent")).cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            requests.push(json!({
                "requestId": part.get("approvalId").cloned().unwrap_or(Value::Null),
                "interaction": data.get("interaction").cloned().unwrap_or(json!("permission")),
                "title": data.get("title").cloned().unwrap_or(Value::Null),
                "details": data.get("details").cloned().unwrap_or(Value::Null),
                "choices": choices,
            }));
        }
    }
    Ok(requests)
}

fn respond(db: &Database, providers: &Providers, parent: &Session, request: &RespondRequest) -> Result<Value> {
    let row = owned_row(db, &parent.id, &request.id)?;
    if row.state != "awaiting_parent" {
        return Err(anyhow!("delegation_not_awaiting_parent"));
    }
    let part = db
        .chat_items(&row.child)?
        .into_iter()
        .flat_map(|item| item.parts)
        .find(|part| {
            part.get("type").and_then(Value::as_str) == Some("approval")
                && part.get("approvalId").and_then(Value::as_str) == Some(request.request_id.as_str())
        })
        .ok_or_else(|| anyhow!("request_not_found"))?;
    if part.get("status").and_then(Value::as_str) != Some("pending")
        || part.pointer("/data/delegation/route").and_then(Value::as_str) != Some("parent")
    {
        // Already answered, expired, or escalated to the user.
        return Err(anyhow!("request_not_pending_for_parent"));
    }
    let choice = part
        .pointer("/data/choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.iter().find(|choice| choice.get("choiceId").and_then(Value::as_str) == Some(request.choice_id.as_str())))
        .ok_or_else(|| anyhow!("invalid_choice"))?;
    if choice.get("scope").and_then(Value::as_str) == Some("persistent") {
        return Err(anyhow!("choice_reserved_for_user"));
    }
    let turn_id = part
        .pointer("/data/turnId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| db.session_by_id(&row.child).ok().flatten().and_then(|session| session.activity).and_then(|activity| activity.turn_id))
        .ok_or_else(|| anyhow!("request_not_pending_for_parent"))?;
    crate::service::approve_chat_request(db, providers, &row.child, &turn_id, &request.request_id, &request.choice_id, &request.operation_id)?;
    Ok(json!({"accepted": true, "delegationId": row.id}))
}

fn result(db: &Database, parent: &Session, id: &str) -> Result<Value> {
    let row = owned_row(db, &parent.id, id)?;
    let changed_files = changed_files(db, &row.child, &row.operation_id);
    Ok(json!({
        "delegationId": row.id,
        "sessionId": row.child,
        "agent": row.agent,
        "state": row.state,
        "finalAnswer": row.result,
        "changedFiles": changed_files,
        "workspace": row.workspace,
        "workspacePath": row.workspace_path,
        "branch": row.branch,
        "error": row.error,
    }))
}

/// Files changed in the delegate's folder since its delegated turn began
/// (review checkpoint). In a shared folder this includes concurrent edits by
/// others. `None` when the folder has no checkpoint (no project, no git).
fn changed_files(db: &Database, child_session_id: &str, send_operation_id: &str) -> Option<Value> {
    let checkpoint: String = db
        .transaction(|tx| {
            tx.query_row(
                "SELECT id FROM review_checkpoints WHERE session_id=? AND operation_id=? AND status='ready'",
                params![child_session_id, send_operation_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
        })
        .ok()??;
    crate::review::dispatch(db, "review.changes", &json!({"sessionId":child_session_id,"from":checkpoint}))
        .ok()?
        .and_then(|value| value.get("files").cloned())
}

/// Provider errors that mean the turn is already over (nothing left to stop).
fn already_stopped(code: &str) -> bool {
    // `turn_not_active`/`turn_not_started`/`turn_changed`: that turn is over;
    // `chat_not_open`/`provider_disconnected`: its worker is gone.
    matches!(
        code,
        "turn_not_active" | "turn_not_started" | "turn_changed" | "chat_not_open" | "provider_disconnected"
    )
}

/// A link that is not finished: its state is one `ACTIVE_STATES` names.
fn live(state: &str) -> bool {
    LIVE_STATES.contains(&state)
}

fn cancel(delegations: &Delegations, db: &Database, providers: &Providers, parent: &Session, id: &str) -> Result<Value> {
    let row = owned_row(db, &parent.id, id)?;
    if !live(&row.state) {
        return Ok(json!({"delegationId": row.id, "state": row.state}));
    }
    // The fence with `run_start` (F09): a cancel that lands between the start's
    // active check and its send means the send never happens.
    let turn = {
        let _fence = delegations.send_fence.lock().map_err(|_| anyhow!("delegation_fence_unavailable"))?;
        let row = owned_row(db, &parent.id, id)?;
        if !live(&row.state) {
            return Ok(json!({"delegationId": row.id, "state": row.state}));
        }
        // Nothing was sent yet (and, under the fence, nothing will be), or no
        // turn of this delegate is running: the child is contained, so the stop
        // is already true and frees its capacity.
        if row.state == "starting" || !turn_running(db, &row.child)? {
            db.transaction(|tx| set_state(tx, &row.id, "cancelled", None, None))?;
            return Ok(json!({"delegationId": row.id, "state": "cancelled"}));
        }
        db.transaction(|tx| set_state(tx, &row.id, "cancelling", None, None))?;
        row.turn_id
            .clone()
            .or_else(|| db.session_by_id(&row.child).ok().flatten().and_then(|session| session.activity).and_then(|activity| activity.turn_id))
    };
    // The provider reports the turn's end, which settles the link as cancelled;
    // a refusal stays visible instead of pretending the work stopped.
    match turn {
        Some(turn) => match providers.chat_cancel(&row.child, &turn) {
            Ok(()) => {
                if !turn_running(db, &row.child)? {
                    db.transaction(|tx| set_state(tx, &row.id, "cancelled", None, None))?;
                }
            }
            Err(error) if already_stopped(&error.code) => {
                db.transaction(|tx| set_state(tx, &row.id, "cancelled", None, None))?;
            }
            Err(error) => {
                db.transaction(|tx| set_state(tx, &row.id, "cancel_failed", None, Some(&error.message)))?;
                return Ok(json!({"delegationId": row.id, "state": "cancel_failed", "error": error.message}));
            }
        },
        None => db.transaction(|tx| set_state(tx, &row.id, "cancelled", None, None))?,
    }
    // Whatever the provider answered, the link reports what it knows now: while
    // a stop is pending that is `cancelling`, after a refusal `cancel_failed`.
    let state = owned_row(db, &parent.id, id)?.state;
    Ok(json!({"delegationId": row.id, "state": state}))
}

fn turn_running(db: &Database, session_id: &str) -> Result<bool> {
    db.transaction(|tx| turn_active(tx, session_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_rotate_and_compare_exactly() {
        let delegations = Delegations::default();
        let first = delegations.issue_token("s");
        assert!(delegations.token_matches("s", &first));
        let second = delegations.issue_token("s");
        assert!(!delegations.token_matches("s", &first), "a reconnect retires the previous token");
        assert!(delegations.token_matches("s", &second));
        assert!(!delegations.token_matches("other", &second));
        assert!(!delegations.token_matches("s", ""));
        assert_eq!(second.len(), 64);
    }

    #[test]
    fn the_live_state_list_and_its_sql_literal_agree() {
        assert_eq!(format!("('{}')", LIVE_STATES.join("','")), ACTIVE_STATES);
    }

    #[test]
    fn constant_time_eq_requires_same_length_and_bytes() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }

    fn item(role: &str, parts: Value) -> crate::domain::ChatItem {
        crate::domain::ChatItem {
            id: uuid::Uuid::new_v4().to_string(),
            role: role.into(),
            parts: parts.as_array().unwrap().clone(),
            created_at: String::new(),
            turn_id: None,
            elapsed_ms: None,
            turn_status: None,
            turn_origin: None,
            fork_anchor: None,
            turn_model: None,
            turn_usage: None,
            turn_review: None,
        }
    }

    #[test]
    fn the_correction_case_reaches_the_delegate_word_for_word_with_the_later_message_last() {
        let items = [
            item("user", json!([{"type":"text","text":"Add farewell(name) returning \"Goodbye, <name>!\"."}])),
            item("assistant", json!([{"type":"text","text":"Understood."}])),
            item("user", json!([{"type":"text","text":"Change of plan: return \"Bye, <name>!\" instead."}])),
            item("user", json!([{"type":"text","text":"Now hand it to a delegate."}])),
        ];
        let (words, left_out) = user_words(&items, 3);
        assert_eq!(left_out, 0);
        assert_eq!(words, ["Add farewell(name) returning \"Goodbye, <name>!\".", "Change of plan: return \"Bye, <name>!\" instead.", "Now hand it to a delegate."]);
        let text = first_message(&words, left_out, "## Assignment\n- [user] Add farewell(name).\n");
        let position = |needle: &str| text.find(needle).unwrap_or_else(|| panic!("missing {needle}"));
        assert!(text.starts_with("## User's words (attached by ThreadTerm"));
        assert!(position("> Add farewell") < position("> Change of plan"));
        assert!(position("> Change of plan") < position("## From the delegating agent"));
        assert!(position("## Assignment\n- [user] Add farewell(name).") < position(DELEGATE_NOTE));
        // Assistant replies are never attached; the default is the latest message only.
        assert_eq!(user_words(&items, DEFAULT_USER_MESSAGES).0, ["Now hand it to a delegate."]);
        // Validation test 1: "take the narrower reading" made a delegate do nothing.
        assert!(DELEGATE_NOTE.contains("do the part that clearly doesn't conflict") && !DELEGATE_NOTE.contains("narrower reading"));
    }

    #[test]
    fn no_words_leave_the_prompt_unchanged() {
        let items = [item("user", json!([{"type":"text","text":"Do it"}])), item("user", json!([{"type":"image","data":"x"}]))];
        assert_eq!(user_words(&items, 0), (Vec::<String>::new(), 0));
        // An image-only message has no words; the text one before it is not pulled in.
        assert_eq!(user_words(&items, 1), (Vec::<String>::new(), 0));
        assert_eq!(first_message(&[], 0, "Reply OK"), "Reply OK");
    }

    #[test]
    fn long_words_are_cut_and_the_oldest_left_out_first() {
        let long = |mark: char| item("user", json!([{"type":"text","text":mark.to_string().repeat(MAX_USER_MESSAGE_CHARS + 50)}]));
        let items = [long('a'), long('b'), long('c'), item("user", json!([{"type":"text","text":"short\n\nsecond paragraph"}]))];
        let (words, left_out) = user_words(&items, 4);
        // "short…", one cut message (4,000 + marker) — a second would pass 8,000.
        assert_eq!(words.len(), 2);
        assert_eq!(left_out, 2);
        assert!(words[0].starts_with('c') && words[0].ends_with("\n…(truncated)"));
        assert_eq!(words[1], "short\n\nsecond paragraph");
        let text = first_message(&words, left_out, "Go");
        assert!(text.contains("(2 earlier message(s) left out to stay within 8000 characters.)"));
        // Every line stays inside the quote, blank lines included.
        assert!(text.contains("> short\n> \n> second paragraph\n"));
        assert!(words.iter().map(|word| word.chars().count()).sum::<usize>() <= MAX_USER_WORDS_CHARS);
    }
}
