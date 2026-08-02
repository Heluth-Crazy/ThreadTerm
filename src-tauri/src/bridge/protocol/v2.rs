//! Secure bridge protocol v2 DTOs and parse/serialize helpers.
//!
//! Kept separate from v1 so existing browser clients remain byte-compatible.
//! Workspace content is request-scoped; snapshots are metadata-only.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::workspace::types::{
    DraftConflictState, DraftPatch, DraftPatchResult, EditorLeaseSnapshot, TextChange,
    WorkspaceDraftMeta, WorkspaceRecord, WorkspaceSnapshot, WorkspaceTab, WorkspaceViewState,
};

pub const PROTOCOL_VERSION_V2: u16 = 2;
pub const MAX_V2_PAYLOAD_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecurePairQrResponse {
    pub protocol: u16,
    pub host: String,
    pub port: u16,
    pub otp: String,
    pub computer_id: String,
    /// Lowercase hex SHA-256 of the desktop certificate DER.
    pub fingerprint: String,
    /// `wss://host:port` endpoint for the secure listener.
    pub endpoint: String,
    pub expires_in_seconds: u64,
    pub max_permission: super::access::DevicePermission,
    /// Canonical QR payload JSON string.
    pub qr_payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecurePairRequest {
    pub otp: String,
    pub device_name: String,
    pub permission: Option<super::access::DevicePermission>,
    /// Client must echo the computerId from the QR.
    pub computer_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecurePairResponse {
    pub device: super::access::BridgeDevice,
    pub device_token: String,
    pub computer_id: String,
    pub expires_in_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMetaSnapshot {
    pub workspace: WorkspaceRecord,
    pub tabs: Vec<WorkspaceTab>,
    pub draft_metas: Vec<WorkspaceDraftMeta>,
    pub view_states: Vec<WorkspaceViewState>,
    pub active_leases: Vec<EditorLeaseSnapshot>,
    /// Workspace service revision watermark for this snapshot.
    pub revision: u64,
    pub permission: super::access::DevicePermission,
}

impl From<WorkspaceSnapshot> for WorkspaceMetaSnapshot {
    fn from(value: WorkspaceSnapshot) -> Self {
        // Metadata only — never include draft/file bodies.
        Self {
            workspace: value.workspace,
            tabs: value.tabs,
            draft_metas: value.draft_metas,
            view_states: value.view_states,
            active_leases: value.active_leases,
            revision: 0,
            permission: super::access::DevicePermission::ReadOnly,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum V2ClientMessage {
    Auth {
        token: String,
    },
    Pair {
        otp: String,
        device_name: String,
        permission: Option<super::access::DevicePermission>,
        computer_id: String,
    },
    Ping {
        #[serde(default)]
        t: Option<u64>,
    },
    SubscribeWorkspace {
        workspace_id: String,
    },
    UnsubscribeWorkspace {
        workspace_id: String,
    },
    GetWorkspaceSnapshot {
        request_id: String,
        workspace_id: String,
    },
    OpenTab {
        request_id: String,
        workspace_id: String,
        /// Tab kind string: home | terminal | file | diff (not the envelope tag).
        tab_kind: String,
        title: Option<String>,
        card_id: Option<String>,
        relative_path: Option<String>,
    },
    CloseTab {
        request_id: String,
        workspace_id: String,
        tab_id: String,
        force: Option<bool>,
    },
    ReorderTabs {
        request_id: String,
        workspace_id: String,
        ordered_tab_ids: Vec<String>,
    },
    SetActiveTab {
        request_id: String,
        workspace_id: String,
        tab_id: String,
    },
    ReadFile {
        request_id: String,
        workspace_id: String,
        relative_path: String,
    },
    GetDraft {
        request_id: String,
        workspace_id: String,
        tab_id: String,
    },
    ApplyDraftPatch {
        request_id: String,
        workspace_id: String,
        tab_id: String,
        base_revision: u64,
        changes: Vec<TextChange>,
        full_text: Option<String>,
    },
    SaveDraft {
        request_id: String,
        workspace_id: String,
        tab_id: String,
        expected_revision: u64,
        force: Option<bool>,
    },
    DiscardDraft {
        request_id: String,
        workspace_id: String,
        tab_id: String,
        expected_revision: u64,
    },
    AcquireLease {
        request_id: String,
        workspace_id: String,
        tab_id: String,
    },
    RenewLease {
        request_id: String,
        workspace_id: String,
        tab_id: String,
    },
    ReleaseLease {
        request_id: String,
        workspace_id: String,
        tab_id: String,
    },
    TakeoverLease {
        request_id: String,
        workspace_id: String,
        tab_id: String,
    },
    ListDirectory {
        request_id: String,
        workspace_id: String,
        relative_path: Option<String>,
    },
    /// Terminal-compatible kinds reused over secure transport.
    TerminalResync,
    Input {
        card_id: String,
        data: String,
    },
    Resize {
        card_id: String,
        cols: u16,
        rows: u16,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum V2ServerMessage {
    PairResult {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        device: Option<super::access::BridgeDevice>,
        #[serde(skip_serializing_if = "Option::is_none")]
        device_token: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        computer_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        expires_in_seconds: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_code: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    AuthOk {
        device: super::access::BridgeDevice,
        computer_id: String,
        #[serde(rename = "serverId")]
        server_id: String,
        #[serde(rename = "runtimeId")]
        runtime_id: String,
    },
    Pong {
        t: u64,
    },
    WorkspaceSnapshot {
        request_id: Option<String>,
        snapshot: WorkspaceMetaSnapshot,
        #[serde(rename = "runtimeId")]
        runtime_id: String,
        #[serde(rename = "workspaceSeq")]
        workspace_seq: u64,
    },
    WorkspaceResult {
        request_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_code: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        revision: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        payload: Option<serde_json::Value>,
    },
    FileContent {
        request_id: String,
        workspace_id: String,
        relative_path: String,
        contents: String,
        size_bytes: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        modified_unix_ms: Option<u64>,
    },
    DraftContent {
        request_id: String,
        workspace_id: String,
        tab_id: String,
        revision: u64,
        dirty: bool,
        conflict: DraftConflictState,
        contents: String,
        size_bytes: u64,
    },
    DraftPatched {
        request_id: String,
        result: DraftPatchResult,
    },
    Error {
        code: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    Revoked {
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionedV2ServerMessage {
    pub protocol_version: u16,
    #[serde(flatten)]
    pub message: V2ServerMessage,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V2ProtocolParseError {
    InvalidJson(String),
    ProtocolVersionMismatch { received: Option<u64> },
    InvalidMessage(String),
    PayloadTooLarge,
}

impl V2ProtocolParseError {
    pub fn error_code(&self) -> &'static str {
        match self {
            Self::ProtocolVersionMismatch { .. } => "protocol_version_mismatch",
            Self::PayloadTooLarge => "payload_too_large",
            Self::InvalidJson(_) | Self::InvalidMessage(_) => "invalid_message",
        }
    }
}

impl fmt::Display for V2ProtocolParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidJson(message) => write!(f, "Invalid v2 client message JSON: {message}"),
            Self::ProtocolVersionMismatch { received } => write!(
                f,
                "Secure bridge protocol version mismatch: expected {}, received {}",
                PROTOCOL_VERSION_V2,
                received
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "missing".to_string())
            ),
            Self::InvalidMessage(message) => write!(f, "Invalid v2 client message: {message}"),
            Self::PayloadTooLarge => write!(
                f,
                "Secure bridge payload exceeds {MAX_V2_PAYLOAD_BYTES} bytes"
            ),
        }
    }
}

impl std::error::Error for V2ProtocolParseError {}

pub fn versioned_v2_server_message(message: V2ServerMessage) -> VersionedV2ServerMessage {
    VersionedV2ServerMessage {
        protocol_version: PROTOCOL_VERSION_V2,
        message,
    }
}

pub fn parse_v2_client_message(text: &str) -> Result<V2ClientMessage, V2ProtocolParseError> {
    if text.len() > MAX_V2_PAYLOAD_BYTES {
        return Err(V2ProtocolParseError::PayloadTooLarge);
    }
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|error| V2ProtocolParseError::InvalidJson(error.to_string()))?;
    let received_version = value
        .get("protocol_version")
        .and_then(|value| value.as_u64());

    if received_version != Some(PROTOCOL_VERSION_V2 as u64) {
        return Err(V2ProtocolParseError::ProtocolVersionMismatch {
            received: received_version,
        });
    }

    serde_json::from_value(value)
        .map_err(|error| V2ProtocolParseError::InvalidMessage(error.to_string()))
}

pub fn draft_patch_from_message(
    workspace_id: String,
    tab_id: String,
    base_revision: u64,
    changes: Vec<TextChange>,
    full_text: Option<String>,
) -> DraftPatch {
    DraftPatch {
        workspace_id,
        tab_id,
        base_revision,
        changes,
        full_text,
    }
}

/// Message kinds that must never be accepted on the plaintext v1 transport.
pub const V1_FORBIDDEN_WORKSPACE_KINDS: &[&str] = &[
    "subscribe_workspace",
    "unsubscribe_workspace",
    "get_workspace_snapshot",
    "open_tab",
    "close_tab",
    "reorder_tabs",
    "set_active_tab",
    "read_file",
    "get_draft",
    "apply_draft_patch",
    "save_draft",
    "discard_draft",
    "acquire_lease",
    "renew_lease",
    "release_lease",
    "takeover_lease",
    "list_directory",
    "workspace_snapshot",
    "file_content",
    "draft_content",
];

pub fn is_v1_forbidden_workspace_kind(kind: &str) -> bool {
    V1_FORBIDDEN_WORKSPACE_KINDS.contains(&kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::protocol::DevicePermission;

    #[test]
    fn v2_auth_message_round_trips() {
        let raw = r#"{"protocol_version":2,"kind":"auth","token":"abc"}"#;
        let message = parse_v2_client_message(raw).expect("parse");
        match message {
            V2ClientMessage::Auth { token } => assert_eq!(token, "abc"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn v2_rejects_protocol_1() {
        let raw = r#"{"protocol_version":1,"kind":"auth","token":"abc"}"#;
        let err = parse_v2_client_message(raw).expect_err("v1");
        assert_eq!(err.error_code(), "protocol_version_mismatch");
    }

    #[test]
    fn v2_rejects_oversized_payload() {
        let huge = "x".repeat(MAX_V2_PAYLOAD_BYTES + 1);
        let raw = format!(r#"{{"protocol_version":2,"kind":"auth","token":"{huge}"}}"#);
        let err = parse_v2_client_message(&raw).expect_err("too large");
        assert_eq!(err.error_code(), "payload_too_large");
    }

    #[test]
    fn secure_pair_qr_serializes_protocol_2() {
        let qr = SecurePairQrResponse {
            protocol: PROTOCOL_VERSION_V2,
            host: "127.0.0.1".to_string(),
            port: 5175,
            otp: "otp".to_string(),
            computer_id: "comp".to_string(),
            fingerprint: "ab".repeat(32),
            endpoint: "wss://127.0.0.1:5175".to_string(),
            expires_in_seconds: 300,
            max_permission: DevicePermission::ReadOnly,
            qr_payload: "{}".to_string(),
        };
        let json = serde_json::to_value(&qr).expect("ser");
        assert_eq!(json["protocol"], 2);
        assert_eq!(json["fingerprint"], "ab".repeat(32));
        assert_eq!(json["computerId"], "comp");
    }

    #[test]
    fn forbidden_workspace_kinds_are_detected() {
        assert!(is_v1_forbidden_workspace_kind("read_file"));
        assert!(is_v1_forbidden_workspace_kind("apply_draft_patch"));
        assert!(!is_v1_forbidden_workspace_kind("auth"));
        assert!(!is_v1_forbidden_workspace_kind("input"));
    }
}
