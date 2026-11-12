use crate::session_activity::SessionActivity;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    pub title: String,
    pub provider: String,
    pub mode: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cols: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<i32>,
    pub followed: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub read_only: bool,
    /// The process tree was stopped to free resources. The session and its
    /// native identity stay; opening it resumes the same conversation.
    #[serde(default, skip_serializing_if = "is_false")]
    pub released: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<SessionActivity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation: Option<SessionDelegation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<SessionGroup>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<crate::quick_launch::SessionRun>,
    /// Present when this Chat session is a Chat Code Review finder or verifier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_review: Option<SessionCodeReview>,
    /// Provider id of the agent CLI currently running inside a shell/custom terminal; absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_agent: Option<String>,
    #[serde(flatten, default)]
    pub organization: SessionOrganization,
}

/// Marker filled from `code_review_sessions` so S2 can open reviewers by id.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionCodeReview {
    pub review_id: String,
    pub parent_session_id: String,
    /// `finder` or `verifier`.
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lens: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Present on a Chat session that another agent started through ThreadTerm
/// delegation. `state` follows the delegated turn only; later turns the user
/// sends to the delegate do not change it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDelegation {
    pub id: String,
    pub parent_session_id: String,
    /// `shared` (the parent's folder) or `worktree`.
    pub workspace: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// starting | running | awaiting_parent | awaiting_user | cancelling | cancel_failed |
    /// completed | failed | cancelled | interrupted
    pub state: String,
    /// How many of the user's messages from the parent chat ThreadTerm
    /// attached to the delegate's first message (sent only when some were).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub user_messages: u32,
    /// The authority the delegate was fitted to under its parent (F07):
    /// read_only | ask_before_writes | writes_in_workspace | full_access.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority: Option<String>,
    /// Preview of the delegated turn's answer (or failure). Present only for
    /// terminal states, and only when there is text to show.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    /// Quiet detection (R8): the delegate's last activity, present only while
    /// the runtime reports it quiet. The renderer never infers quiet itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
    /// The tool call an open quiet episode waits on, present only while one is open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_tool: Option<SessionOpenTool>,
}

/// The still-open tool call of a quiet delegate (R8).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpenTool {
    pub name: String,
    /// RFC 3339, when the call started.
    pub since: String,
}

/// Present on a Chat session participating in a group chat.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroup {
    pub id: String,
    pub handle: String,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionOrganization {
    pub archived: bool,
    pub pinned: bool,
    pub bookmarked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    pub sort_order: i64,
    pub organization_revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forked_from: Option<SessionForkedFrom>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionForkedFrom {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionOrganize {
    pub session_id: String,
    pub archived: Option<bool>,
    pub pinned: Option<bool>,
    pub bookmarked: Option<bool>,
    pub intent: Option<String>,
    pub sort_order: Option<i64>,
    pub expected_revision: i64,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub revision: i64,
    #[serde(flatten)]
    pub value: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeForkAnchor {
    pub native_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatItem {
    pub id: String,
    pub role: String,
    pub parts: Vec<Value>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    // Wall-clock turn duration; providers that expose a completed-turn
    // measurement (Codex, Grok, and Kimi ACP) set it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    /// Provider-confirmed native turn outcome. This is deliberately separate
    /// from `elapsed_ms`: a completed turn may have no measured duration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_status: Option<NativeTurnStatus>,
    /// Imported native history is presentation-only even after the session is
    /// resumed. Live projection leaves this absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_origin: Option<ChatTurnOrigin>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fork_anchor: Option<NativeForkAnchor>,
    /// Model selected when this turn began. Kept on the turn rather than the
    /// session so a later model change cannot rewrite historic footers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_model: Option<String>,
    /// Latest native per-turn context snapshot. Session-wide totals are never
    /// copied here; adapters publish these through `chat.context`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_usage: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_review: Option<ChatTurnReview>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurnReview {
    pub from: String,
    pub to: String,
    pub file_count: u64,
}

/// The public native-history turn states supported by the Chat presentation.
/// Missing status stays unknown; callers must not infer completion from age,
/// timestamps, or the presence of a transcript item.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NativeTurnStatus {
    Unknown,
    Completed,
    Interrupted,
    Failed,
    InProgress,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChatTurnOrigin {
    History,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub epoch: String,
    pub revision: i64,
    pub projects: Vec<Project>,
    pub sessions: Vec<Session>,
    pub settings: Settings,
    pub workspaces: Vec<Value>,
    pub inbox: Vec<Value>,
    pub providers: Vec<Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub native_subagents: BTreeMap<String, Vec<Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequest {
    pub v: u32,
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcResponse {
    Ok { v: u32, id: String, result: Value },
    Err { v: u32, id: String, error: RpcError },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthRequest {
    pub token: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub protocol: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    pub v: u32,
    pub event: String,
    pub epoch: String,
    pub seq: i64,
    pub data: Value,
}
