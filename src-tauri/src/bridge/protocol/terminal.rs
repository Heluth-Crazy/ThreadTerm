use serde::{Deserialize, Serialize};

use crate::pty::SessionState;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardMeta {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pty_id: Option<String>,
    pub status: TerminalStatus,
    pub project_path: String,
    pub project_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity: Option<u64>,
    pub last_reply_preview: String,
    pub summary_line: Option<String>,
    pub hidden_line_count: usize,
    pub recent_output_bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unread: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_session_state: Option<String>,
    #[serde(default)]
    pub pty_live: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pty_state: Option<TerminalStatus>,
    #[serde(default)]
    pub attachable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshotMessage {
    pub card_id: String,
    pub data: String,
    pub seq: u64,
    pub runtime_id: String,
    pub stream_seq: u64,
    pub rows: u16,
    pub cols: u16,
    pub cursor_row: u16,
    pub cursor_col: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    Idle,
    Running,
    WaitingForInput,
    Completed,
    Failed,
}

impl From<SessionState> for TerminalStatus {
    fn from(value: SessionState) -> Self {
        match value {
            SessionState::Idle => Self::Idle,
            SessionState::Running => Self::Running,
            SessionState::WaitingForInput => Self::WaitingForInput,
            SessionState::Completed => Self::Completed,
            SessionState::Failed => Self::Failed,
        }
    }
}
