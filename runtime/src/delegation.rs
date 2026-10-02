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
const ACTIVE_STATES: &str = "('starting','running','awaiting_parent','awaiting_user')";
/// Error messages that are also the RPC error code the MCP host reports.
pub const ERROR_CODES: [&str; 16] = [
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
    "invalid_workspace",
    "worktree_requires_project",
    "worktree_requires_git",
    "worktree_unavailable",
];
const MAX_PROMPT_BYTES: usize = 256 * 1024;
const MAX_RESULT_CHARS: usize = 64 * 1024;

/// Runtime-side delegation state shared by the service and the resolver.
#[derive(Default)]
pub struct Delegations {
    tokens: Mutex<HashMap<String, String>>,
    /// Serializes the cap check with the row insert across MCP connections.
    pub(crate) start_gate: Mutex<()>,
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
        if !PARENT_PROVIDERS.contains(&provider) {
            return None;
        }
        let command = mcp_executable.as_ref()?;
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
}

pub(crate) fn active_link(tx: &Transaction<'_>, child_session_id: &str) -> Result<Option<ChildLink>> {
    tx.query_row(
        &format!("SELECT id,parent_session_id,state FROM delegations WHERE child_session_id=? AND state IN {ACTIVE_STATES}"),
        [child_session_id],
        |row| Ok(ChildLink { id: row.get(0)?, parent_session_id: row.get(1)?, state: row.get(2)? }),
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

/// The parent agent can answer requests only while it is inside a turn.
pub(crate) fn parent_turn_active(tx: &Transaction<'_>, parent_session_id: &str) -> Result<bool> {
    let row: Option<(String, Option<String>)> = tx
        .query_row(
            "SELECT sessions.status,session_activity.state FROM sessions LEFT JOIN session_activity ON session_activity.session_id=sessions.id WHERE sessions.id=?",
            [parent_session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row.is_some_and(|(status, state)| {
        !matches!(status.as_str(), "exited" | "interrupted" | "error")
            && matches!(state.as_deref(), Some("running" | "awaiting_approval"))
    }))
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
pub(crate) fn project_child_event(tx: &Transaction<'_>, link: &ChildLink, kind: &str, data: &Value) -> Result<()> {
    let started = link.state != "starting";
    match kind {
        "message.user" if !started => set_state(tx, &link.id, "running", None, None),
        "chat.approval" | "chat.approval.resolved" if started => {
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
            set_state(tx, &link.id, "failed", Some(&answer), Some(message))
        }
        _ => Ok(()),
    }
}

fn child_of(tx: &Transaction<'_>, delegation_id: &str) -> Result<String> {
    tx.query_row("SELECT child_session_id FROM delegations WHERE id=?", [delegation_id], |row| row.get(0))
        .map_err(Into::into)
}

/// The delegate's answer: its assistant text, in transcript order.
fn final_answer(tx: &Transaction<'_>, child_session_id: &str) -> Result<String> {
    let mut statement = tx.prepare("SELECT data FROM chat_items WHERE session_id=? ORDER BY created_at,rowid")?;
    let rows = statement.query_map([child_session_id], |row| row.get::<_, String>(0))?;
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
    let mut answer = texts.join("\n\n");
    if answer.chars().count() > MAX_RESULT_CHARS {
        answer = answer.chars().take(MAX_RESULT_CHARS).collect::<String>() + "\n…(truncated)";
    }
    Ok(answer)
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
    pub operation_id: &'a str,
}

pub(crate) fn insert(db: &Database, row: &NewDelegation<'_>) -> Result<()> {
    db.transaction(|tx| {
        let now = Utc::now().to_rfc3339();
        tx.execute(
            "INSERT INTO delegations(id,parent_session_id,child_session_id,agent,workspace,workspace_path,branch,prompt,operation_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'starting',?,?)",
            params![row.id, row.parent_session_id, row.child_session_id, row.agent, row.workspace, row.workspace_path, row.branch, row.prompt, row.operation_id, now, now],
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
    if !matches!(request.workspace.as_deref(), None | Some("shared" | "worktree")) {
        return Err(anyhow!("invalid_workspace"));
    }
    if !crate::providers::SUPPORTED_PROVIDERS.contains(&request.agent.as_str()) {
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
    if !is_active(db, delegation_id) {
        return;
    }
    match crate::service::send_chat_message(db, providers, child_session_id, prompt, &[], send_operation_id) {
        Ok(result) => {
            if let Some(turn_id) = result.get("turnId").and_then(Value::as_str) {
                let _ = db.transaction(|tx| {
                    tx.execute("UPDATE delegations SET turn_id=? WHERE id=?", params![turn_id, delegation_id])?;
                    Ok(())
                });
            }
        }
        Err(error) => fail(format!("The delegated prompt could not be sent: {error}")),
    }
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

/// `session.stop` on a delegate ends its delegation as cancelled.
pub fn cancel_stopped(db: &Database, session_id: &str) -> Result<()> {
    db.transaction(|tx| match active_link(tx, session_id)? {
        Some(link) => set_state(tx, &link.id, "cancelled", None, None),
        None => Ok(()),
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
            cancel(db, providers, &parent, &request.id)?
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

fn cancel(db: &Database, providers: &Providers, parent: &Session, id: &str) -> Result<Value> {
    let row = owned_row(db, &parent.id, id)?;
    if !matches!(row.state.as_str(), "starting" | "running" | "awaiting_parent" | "awaiting_user") {
        return Ok(json!({"delegationId": row.id, "state": row.state}));
    }
    let turn = row
        .turn_id
        .clone()
        .or_else(|| db.session_by_id(&row.child).ok().flatten().and_then(|session| session.activity).and_then(|activity| activity.turn_id));
    db.transaction(|tx| set_state(tx, &row.id, "cancelled", None, None))?;
    if let Some(turn) = turn {
        // Best effort: an idle or not-yet-connected delegate has no turn to stop.
        let _ = providers.chat_cancel(&row.child, &turn);
    }
    Ok(json!({"delegationId": row.id, "state": "cancelled"}))
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
    fn constant_time_eq_requires_same_length_and_bytes() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
