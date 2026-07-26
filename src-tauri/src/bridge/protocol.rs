use std::fmt;

use serde::{Deserialize, Serialize};

use crate::pty::SessionState;

pub const PROTOCOL_VERSION: u16 = 1;

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
pub struct NotificationRouting {
    pub origin: String,
    pub family: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationEntry {
    pub id: String,
    pub card_id: String,
    pub kind: String,
    pub message: String,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing: Option<NotificationRouting>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileAttentionCapability {
    pub open_request: bool,
    pub open_terminal: bool,
    pub open_notification: bool,
    pub open_evidence: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileAttentionItem {
    pub id: String,
    pub card_id: String,
    pub kind: String,
    pub severity: String,
    pub source_kind: String,
    pub source_id: String,
    pub occurred_at: u64,
    pub project_path: String,
    pub project_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_label: Option<String>,
    pub terminal_type: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub reason_code: String,
    pub capability: MobileAttentionCapability,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileExecutionGroup {
    pub id: String,
    pub project_path: String,
    pub project_name: String,
    pub worktree_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_label: Option<String>,
    pub card_ids: Vec<String>,
    pub terminal_count: usize,
    pub terminal_types: Vec<String>,
    pub attention_count: usize,
    pub status: String,
    pub terminal_statuses: Vec<String>,
    pub last_activity: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileWorkbenchSummary {
    pub attention: usize,
    pub normal_running: usize,
    pub review: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileWorkbenchRules {
    pub include_waiting: bool,
    pub include_failed: bool,
    pub include_completed_review: bool,
    pub stalled_enabled: bool,
    pub stalled_threshold_minutes: u64,
    pub stalled_excluded_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileWorkbenchCapabilities {
    pub open_terminal: bool,
    pub respond_to_structured_request: bool,
    pub update_rules: bool,
    pub update_notification_read_state: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileWorkbenchProjection {
    pub generated_at: u64,
    pub summary: MobileWorkbenchSummary,
    pub attention_items: Vec<MobileAttentionItem>,
    pub execution_groups: Vec<MobileExecutionGroup>,
    pub rules: MobileWorkbenchRules,
    pub capabilities: MobileWorkbenchCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSnapshot {
    pub cards: Vec<CardMeta>,
    pub notifications: Vec<NotificationEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workbench: Option<MobileWorkbenchProjection>,
    #[serde(default)]
    pub warming_up: bool,
    pub server_id: String,
    pub runtime_id: String,
    pub stream_seq: u64,
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
#[serde(rename_all = "camelCase")]
pub struct AppThemeTokens {
    pub background: String,
    pub foreground: String,
    pub card: String,
    pub card_foreground: String,
    pub popover: String,
    pub popover_foreground: String,
    pub primary: String,
    pub primary_foreground: String,
    pub secondary: String,
    pub secondary_foreground: String,
    pub muted: String,
    pub muted_foreground: String,
    pub accent: String,
    pub accent_foreground: String,
    pub destructive: String,
    pub destructive_foreground: String,
    pub border: String,
    pub input: String,
    pub ring: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalThemeTokens {
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub cursor_accent: String,
    pub selection: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_foreground: Option<String>,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThemeMode {
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTheme {
    pub app: AppThemeTokens,
    pub terminal: TerminalThemeTokens,
    pub mode: ThemeMode,
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionedServerMessage {
    pub protocol_version: u16,
    #[serde(flatten)]
    pub message: ServerMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub running: bool,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairQrResponse {
    pub host: String,
    pub port: u16,
    pub otp: String,
    pub url: String,
    pub server_id: String,
    pub expires_in_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub otp: String,
    pub device_name: String,
    pub permission: Option<DevicePermission>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub device: BridgeDevice,
    pub device_token: String,
    pub server_id: String,
    pub expires_in_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeDevice {
    pub id: String,
    pub name: String,
    pub permission: DevicePermission,
    pub created_at: u64,
    pub last_seen_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileSpawnCardRequest {
    pub request_id: String,
    pub terminal_type: String,
    pub project_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileCardRequest {
    pub request_id: String,
    pub card_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileRenameCardRequest {
    pub request_id: String,
    pub card_id: String,
    pub project_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DevicePermission {
    ReadOnly,
    Full,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClientMessage {
    Auth {
        token: String,
    },
    Subscribe {
        card_ids: Option<Vec<String>>,
    },
    Input {
        card_id: String,
        data: String,
    },
    Resize {
        card_id: String,
        cols: u16,
        rows: u16,
    },
    Spawn {
        request_id: String,
        terminal_type: String,
        project_path: String,
        command: Option<String>,
    },
    Activate {
        request_id: String,
        card_id: String,
    },
    Close {
        request_id: Option<String>,
        card_id: String,
    },
    Pin {
        card_id: String,
        pinned: bool,
    },
    SetIntent {
        card_id: String,
        intent: Option<String>,
    },
    MarkRead {
        card_id: String,
    },
    RenameCard {
        request_id: String,
        card_id: String,
        project_name: String,
    },
    TerminalResync,
    Ping,
}

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ServerMessage {
    Snapshot {
        cards: Vec<CardMeta>,
        notifications: Vec<NotificationEntry>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workbench: Option<MobileWorkbenchProjection>,
        #[serde(rename = "warmingUp")]
        warming_up: bool,
        #[serde(rename = "serverId")]
        server_id: String,
        #[serde(rename = "runtimeId")]
        runtime_id: String,
        #[serde(rename = "streamSeq")]
        stream_seq: u64,
    },
    CardAdded {
        card: CardMeta,
    },
    CardUpdated {
        card: CardMeta,
    },
    CardRemoved {
        card: CardMeta,
    },
    Preview {
        card_id: String,
        last_reply_preview: String,
        summary_line: Option<String>,
        hidden_line_count: usize,
    },
    TerminalSnapshot {
        snapshot: TerminalSnapshotMessage,
    },
    TerminalOutput {
        card_id: String,
        data: String,
        seq: u64,
        #[serde(rename = "runtimeId")]
        runtime_id: String,
        #[serde(rename = "streamSeq")]
        stream_seq: u64,
    },
    Theme {
        app: AppThemeTokens,
        terminal: TerminalThemeTokens,
        mode: ThemeMode,
    },
    State {
        card_id: String,
        status: TerminalStatus,
    },
    Attention {
        card_id: String,
        attention_kind: String,
        message: String,
    },
    Exit {
        card_id: String,
        code: Option<u32>,
    },
    Notification {
        entry: NotificationEntry,
    },
    SpawnResult {
        request_id: String,
        ok: bool,
        card_id: Option<String>,
        error_code: Option<String>,
        message: Option<String>,
    },
    ActivateResult {
        request_id: String,
        ok: bool,
        card_id: Option<String>,
        error_code: Option<String>,
        message: Option<String>,
    },
    CloseResult {
        request_id: String,
        ok: bool,
        card_id: Option<String>,
        error_code: Option<String>,
        message: Option<String>,
    },
    RenameResult {
        request_id: String,
        ok: bool,
        card_id: Option<String>,
        error_code: Option<String>,
        message: Option<String>,
    },
    Pong {
        t: u64,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolParseError {
    InvalidJson(String),
    ProtocolVersionMismatch { received: Option<u64> },
    InvalidMessage(String),
}

impl ProtocolParseError {
    pub fn error_code(&self) -> &'static str {
        match self {
            Self::ProtocolVersionMismatch { .. } => "protocol_version_mismatch",
            Self::InvalidJson(_) | Self::InvalidMessage(_) => "invalid_message",
        }
    }
}

impl fmt::Display for ProtocolParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidJson(message) => write!(f, "Invalid client message JSON: {message}"),
            Self::ProtocolVersionMismatch { received } => write!(
                f,
                "Bridge protocol version mismatch: expected {}, received {}",
                PROTOCOL_VERSION,
                received
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "missing".to_string())
            ),
            Self::InvalidMessage(message) => write!(f, "Invalid client message: {message}"),
        }
    }
}

impl std::error::Error for ProtocolParseError {}

pub fn versioned_server_message(message: ServerMessage) -> VersionedServerMessage {
    VersionedServerMessage {
        protocol_version: PROTOCOL_VERSION,
        message,
    }
}

pub fn parse_client_message(text: &str) -> Result<ClientMessage, ProtocolParseError> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|error| ProtocolParseError::InvalidJson(error.to_string()))?;
    let received_version = value
        .get("protocol_version")
        .and_then(|value| value.as_u64());

    if received_version != Some(PROTOCOL_VERSION as u64) {
        return Err(ProtocolParseError::ProtocolVersionMismatch {
            received: received_version,
        });
    }

    serde_json::from_value(value)
        .map_err(|error| ProtocolParseError::InvalidMessage(error.to_string()))
}

impl From<BridgeSnapshot> for ServerMessage {
    fn from(value: BridgeSnapshot) -> Self {
        ServerMessage::Snapshot {
            cards: value.cards,
            notifications: value.notifications,
            workbench: value.workbench,
            warming_up: value.warming_up,
            server_id: value.server_id,
            runtime_id: value.runtime_id,
            stream_seq: value.stream_seq,
        }
    }
}

impl Default for BridgeTheme {
    fn default() -> Self {
        Self {
            mode: ThemeMode::Dark,
            app: AppThemeTokens {
                background: "#10151d".to_string(),
                foreground: "#e8edf5".to_string(),
                card: "#151b24".to_string(),
                card_foreground: "#e8edf5".to_string(),
                popover: "#151b24".to_string(),
                popover_foreground: "#e8edf5".to_string(),
                primary: "#4f8bd6".to_string(),
                primary_foreground: "#f8fafc".to_string(),
                secondary: "#263242".to_string(),
                secondary_foreground: "#e8edf5".to_string(),
                muted: "#202a38".to_string(),
                muted_foreground: "#9aa7b7".to_string(),
                accent: "#314154".to_string(),
                accent_foreground: "#e8edf5".to_string(),
                destructive: "#ef4444".to_string(),
                destructive_foreground: "#f8fafc".to_string(),
                border: "#2d3948".to_string(),
                input: "#263242".to_string(),
                ring: "#4f8bd6".to_string(),
            },
            terminal: TerminalThemeTokens {
                background: "#000000".to_string(),
                foreground: "#f8fafc".to_string(),
                cursor: "#f8fafc".to_string(),
                cursor_accent: "#000000".to_string(),
                selection: "#334155".to_string(),
                selection_foreground: Some("#f8fafc".to_string()),
                black: "#0f172a".to_string(),
                red: "#ef4444".to_string(),
                green: "#22c55e".to_string(),
                yellow: "#eab308".to_string(),
                blue: "#3b82f6".to_string(),
                magenta: "#d946ef".to_string(),
                cyan: "#06b6d4".to_string(),
                white: "#e2e8f0".to_string(),
                bright_black: "#475569".to_string(),
                bright_red: "#f87171".to_string(),
                bright_green: "#4ade80".to_string(),
                bright_yellow: "#facc15".to_string(),
                bright_blue: "#60a5fa".to_string(),
                bright_magenta: "#e879f9".to_string(),
                bright_cyan: "#22d3ee".to_string(),
                bright_white: "#f8fafc".to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_protocol_messages_with_stable_kind_names_and_version() {
        let message = ServerMessage::State {
            card_id: "card-1".to_string(),
            status: TerminalStatus::WaitingForInput,
        };

        let json = serde_json::to_value(versioned_server_message(message))
            .expect("serialize protocol message");
        assert_eq!(json["protocol_version"], PROTOCOL_VERSION);
        assert_eq!(json["kind"], "state");
        assert_eq!(json["card_id"], "card-1");
        assert_eq!(json["status"], "waiting_for_input");
    }

    #[test]
    fn snapshot_preserves_the_server_identity_for_mobile_clients() {
        let message: ServerMessage = BridgeSnapshot {
            cards: Vec::new(),
            notifications: Vec::new(),
            workbench: None,
            warming_up: false,
            server_id: "server-a".to_string(),
            runtime_id: "runtime-a".to_string(),
            stream_seq: 7,
        }
        .into();

        let json = serde_json::to_value(versioned_server_message(message))
            .expect("serialize bridge snapshot");
        assert_eq!(json["kind"], "snapshot");
        assert_eq!(json["serverId"], "server-a");
        assert_eq!(json["runtimeId"], "runtime-a");
        assert_eq!(json["streamSeq"], 7);
    }

    #[test]
    fn serializes_card_meta_context_for_mobile_clients() {
        let card = CardMeta {
            id: "card-1".to_string(),
            pty_id: Some("pty-1".to_string()),
            status: TerminalStatus::Idle,
            project_path: "/tmp/ThreadTerm".to_string(),
            project_name: "ThreadTerm".to_string(),
            worktree_path: None,
            branch_label: Some("mobile".to_string()),
            terminal_type: Some("codex".to_string()),
            command: None,
            created_at: Some(123),
            last_activity: Some(456),
            last_reply_preview: "recent output".to_string(),
            summary_line: Some("latest reply".to_string()),
            hidden_line_count: 2,
            recent_output_bytes: 128,
            message_count: Some(7),
            unread: Some(true),
            provider_session_state: Some("bound".to_string()),
            pty_live: false,
            pty_state: None,
            attachable: true,
        };

        let json = serde_json::to_value(card).expect("serialize card meta");
        assert_eq!(json["ptyId"], "pty-1");
        assert_eq!(json["projectPath"], "/tmp/ThreadTerm");
        assert_eq!(json["projectName"], "ThreadTerm");
        assert_eq!(json["branchLabel"], "mobile");
        assert_eq!(json["terminalType"], "codex");
        assert_eq!(json["summaryLine"], "latest reply");
        assert_eq!(json["hiddenLineCount"], 2);
        assert_eq!(json["messageCount"], 7);
        assert_eq!(json["unread"], true);
        assert_eq!(json["attachable"], true);
    }

    #[test]
    fn serializes_terminal_snapshot_and_output_for_mobile_clients() {
        let snapshot = TerminalSnapshotMessage {
            card_id: "card-1".to_string(),
            data: "\u{1b}[1;1Hready".to_string(),
            seq: 42,
            runtime_id: "runtime-a".to_string(),
            stream_seq: 9,
            rows: 24,
            cols: 80,
            cursor_row: 1,
            cursor_col: 6,
            history: Some("previous line\r\n".to_string()),
        };

        let snapshot_json =
            serde_json::to_value(versioned_server_message(ServerMessage::TerminalSnapshot {
                snapshot: snapshot.clone(),
            }))
            .expect("serialize terminal snapshot");
        assert_eq!(snapshot_json["protocol_version"], PROTOCOL_VERSION);
        assert_eq!(snapshot_json["kind"], "terminal_snapshot");
        assert_eq!(snapshot_json["snapshot"]["cardId"], "card-1");
        assert_eq!(snapshot_json["snapshot"]["runtimeId"], "runtime-a");
        assert_eq!(snapshot_json["snapshot"]["streamSeq"], 9);
        assert_eq!(snapshot_json["snapshot"]["cursorRow"], 1);
        assert_eq!(snapshot_json["snapshot"]["history"], "previous line\r\n");

        let output_json =
            serde_json::to_value(versioned_server_message(ServerMessage::TerminalOutput {
                card_id: "card-1".to_string(),
                data: " streamed".to_string(),
                seq: 43,
                runtime_id: "runtime-a".to_string(),
                stream_seq: 10,
            }))
            .expect("serialize terminal output");
        assert_eq!(output_json["kind"], "terminal_output");
        assert_eq!(output_json["card_id"], "card-1");
        assert_eq!(output_json["data"], " streamed");
        assert_eq!(output_json["seq"], 43);
        assert_eq!(output_json["runtimeId"], "runtime-a");
        assert_eq!(output_json["streamSeq"], 10);
    }

    #[test]
    fn serializes_theme_message_for_mobile_clients() {
        let theme = BridgeTheme::default();
        let json = serde_json::to_value(versioned_server_message(ServerMessage::Theme {
            app: theme.app,
            terminal: theme.terminal,
            mode: theme.mode,
        }))
        .expect("serialize theme message");

        assert_eq!(json["protocol_version"], PROTOCOL_VERSION);
        assert_eq!(json["kind"], "theme");
        assert_eq!(json["mode"], "dark");
        assert_eq!(json["app"]["cardForeground"], "#e8edf5");
        assert_eq!(json["terminal"]["brightCyan"], "#22d3ee");
    }

    #[test]
    fn serializes_exact_exit_code_for_mobile_clients() {
        let json = serde_json::to_value(versioned_server_message(ServerMessage::Exit {
            card_id: "card-1".to_string(),
            code: Some(127),
        }))
        .expect("serialize exit message");

        assert_eq!(json["protocol_version"], PROTOCOL_VERSION);
        assert_eq!(json["kind"], "exit");
        assert_eq!(json["card_id"], "card-1");
        assert_eq!(json["code"], 127);
    }

    #[test]
    fn parses_client_input_message() {
        let message = parse_client_message(
            r#"{"protocol_version":1,"kind":"input","card_id":"card-1","data":"y\n"}"#,
        )
        .expect("parse client input");

        match message {
            ClientMessage::Input { card_id, data } => {
                assert_eq!(card_id, "card-1");
                assert_eq!(data, "y\n");
            }
            _ => panic!("expected input message"),
        }
    }

    #[test]
    fn parses_client_auth_message() {
        let message =
            parse_client_message(r#"{"protocol_version":1,"kind":"auth","token":"device-token"}"#)
                .expect("parse client auth");

        match message {
            ClientMessage::Auth { token } => assert_eq!(token, "device-token"),
            _ => panic!("expected auth message"),
        }
    }

    #[test]
    fn parses_terminal_resync_message() {
        let message = parse_client_message(r#"{"protocol_version":1,"kind":"terminal_resync"}"#)
            .expect("parse terminal resync");

        assert!(matches!(message, ClientMessage::TerminalResync));
    }

    #[test]
    fn parses_mobile_control_messages() {
        let spawn = parse_client_message(
            r#"{"protocol_version":1,"kind":"spawn","request_id":"req-1","terminal_type":"codex","project_path":"/tmp/app","command":"codex"}"#,
        )
        .expect("parse spawn");
        match spawn {
            ClientMessage::Spawn {
                request_id,
                terminal_type,
                project_path,
                command,
            } => {
                assert_eq!(request_id, "req-1");
                assert_eq!(terminal_type, "codex");
                assert_eq!(project_path, "/tmp/app");
                assert_eq!(command.as_deref(), Some("codex"));
            }
            _ => panic!("expected spawn message"),
        }

        let activate = parse_client_message(
            r#"{"protocol_version":1,"kind":"activate","request_id":"req-2","card_id":"card-1"}"#,
        )
        .expect("parse activate");
        match activate {
            ClientMessage::Activate {
                request_id,
                card_id,
            } => {
                assert_eq!(request_id, "req-2");
                assert_eq!(card_id, "card-1");
            }
            _ => panic!("expected activate message"),
        }
    }

    #[test]
    fn serializes_mobile_control_results() {
        let json = serde_json::to_value(versioned_server_message(ServerMessage::SpawnResult {
            request_id: "req-1".to_string(),
            ok: true,
            card_id: Some("card-1".to_string()),
            error_code: None,
            message: None,
        }))
        .expect("serialize spawn result");

        assert_eq!(json["protocol_version"], PROTOCOL_VERSION);
        assert_eq!(json["kind"], "spawn_result");
        assert_eq!(json["request_id"], "req-1");
        assert_eq!(json["card_id"], "card-1");
        assert_eq!(json["ok"], true);
    }

    #[test]
    fn rejects_missing_or_wrong_protocol_version() {
        let missing = parse_client_message(r#"{"kind":"ping"}"#)
            .expect_err("missing version must be rejected");
        assert_eq!(missing.error_code(), "protocol_version_mismatch");

        let wrong = parse_client_message(r#"{"protocol_version":2,"kind":"ping"}"#)
            .expect_err("wrong version must be rejected");
        assert_eq!(wrong.error_code(), "protocol_version_mismatch");

        let error = ServerMessage::Error {
            code: wrong.error_code().to_string(),
            message: wrong.to_string(),
        };
        let json = serde_json::to_value(versioned_server_message(error))
            .expect("serialize version mismatch error");
        assert_eq!(json["protocol_version"], PROTOCOL_VERSION);
        assert_eq!(json["kind"], "error");
        assert_eq!(json["code"], "protocol_version_mismatch");
    }
}
