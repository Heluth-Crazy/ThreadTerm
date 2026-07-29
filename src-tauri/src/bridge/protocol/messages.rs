use std::fmt;

use serde::{Deserialize, Serialize};

use super::{
    terminal::{CardMeta, TerminalSnapshotMessage, TerminalStatus},
    theme::{AppThemeTokens, TerminalThemeTokens, ThemeMode},
    workbench::{BridgeSnapshot, MobileWorkbenchProjection, NotificationEntry},
    PROTOCOL_VERSION,
};

#[derive(Debug, Clone, Serialize)]
pub struct VersionedServerMessage {
    pub protocol_version: u16,
    #[serde(flatten)]
    pub message: ServerMessage,
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
