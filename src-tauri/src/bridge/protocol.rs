use serde::{Deserialize, Serialize};

use crate::pty::SessionState;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardMeta {
    pub id: String,
    pub status: TerminalStatus,
    pub last_reply_preview: String,
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
    Subscribe { card_ids: Option<Vec<String>> },
    Input { card_id: String, data: String },
    Resize { card_id: String, cols: u16, rows: u16 },
    Spawn {
        terminal_type: String,
        project_path: String,
        command: Option<String>,
    },
    Close { card_id: String },
    Pin { card_id: String, pinned: bool },
    SetIntent { card_id: String, intent: Option<String> },
    MarkRead { card_id: String },
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
        hidden_line_count: usize,
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

impl From<BridgeSnapshot> for ServerMessage {
    fn from(value: BridgeSnapshot) -> Self {
        ServerMessage::Snapshot {
            cards: value.cards,
            notifications: value.notifications,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_protocol_messages_with_stable_kind_names() {
        let message = ServerMessage::State {
            card_id: "card-1".to_string(),
            status: TerminalStatus::WaitingForInput,
        };

        let json = serde_json::to_value(message).expect("serialize protocol message");
        assert_eq!(json["kind"], "state");
        assert_eq!(json["card_id"], "card-1");
        assert_eq!(json["status"], "waiting_for_input");
    }

    #[test]
    fn parses_client_input_message() {
        let message: ClientMessage = serde_json::from_str(
            r#"{"kind":"input","card_id":"card-1","data":"y\n"}"#,
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
}
