use std::fmt;

use serde::{Deserialize, Serialize};

use crate::pty::SessionState;

pub const PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardMeta {
    pub id: String,
    pub status: TerminalStatus,
    pub project_path: String,
    pub project_name: String,
    pub last_reply_preview: String,
    pub summary_line: Option<String>,
    pub hidden_line_count: usize,
    pub recent_output_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationEntry {
    pub id: String,
    pub card_id: String,
    pub kind: String,
    pub message: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSnapshot {
    pub cards: Vec<CardMeta>,
    pub notifications: Vec<NotificationEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshotMessage {
    pub card_id: String,
    pub data: String,
    pub seq: u64,
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
        terminal_type: String,
        project_path: String,
        command: Option<String>,
    },
    Close {
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
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ServerMessage {
    Snapshot {
        cards: Vec<CardMeta>,
        notifications: Vec<NotificationEntry>,
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
    fn serializes_card_meta_context_for_mobile_clients() {
        let card = CardMeta {
            id: "card-1".to_string(),
            status: TerminalStatus::Idle,
            project_path: "/tmp/ThreadTerm".to_string(),
            project_name: "ThreadTerm".to_string(),
            last_reply_preview: "recent output".to_string(),
            summary_line: Some("latest reply".to_string()),
            hidden_line_count: 2,
            recent_output_bytes: 128,
        };

        let json = serde_json::to_value(card).expect("serialize card meta");
        assert_eq!(json["projectPath"], "/tmp/ThreadTerm");
        assert_eq!(json["projectName"], "ThreadTerm");
        assert_eq!(json["summaryLine"], "latest reply");
        assert_eq!(json["hiddenLineCount"], 2);
    }

    #[test]
    fn serializes_terminal_snapshot_and_output_for_mobile_clients() {
        let snapshot = TerminalSnapshotMessage {
            card_id: "card-1".to_string(),
            data: "\u{1b}[1;1Hready".to_string(),
            seq: 42,
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
        assert_eq!(snapshot_json["snapshot"]["cursorRow"], 1);
        assert_eq!(snapshot_json["snapshot"]["history"], "previous line\r\n");

        let output_json =
            serde_json::to_value(versioned_server_message(ServerMessage::TerminalOutput {
                card_id: "card-1".to_string(),
                data: " streamed".to_string(),
                seq: 43,
            }))
            .expect("serialize terminal output");
        assert_eq!(output_json["kind"], "terminal_output");
        assert_eq!(output_json["card_id"], "card-1");
        assert_eq!(output_json["data"], " streamed");
        assert_eq!(output_json["seq"], 43);
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
