use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ClientClass {
    /// Existing browser/mobile plaintext terminal clients.
    #[default]
    LegacyTerminal,
    /// Installed native clients paired over pinned TLS v2.
    SecureWorkspace,
}

impl ClientClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LegacyTerminal => "legacy_terminal",
            Self::SecureWorkspace => "secure_workspace",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "secure_workspace" => Self::SecureWorkspace,
            _ => Self::LegacyTerminal,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub running: bool,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub url: Option<String>,
    /// Secure TLS v2 listener state (independent of plaintext v1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secure_running: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secure_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secure_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secure_endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint_short: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computer_id: Option<String>,
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
    /// Client capability class. Defaults to legacy_terminal for old rows/clients.
    #[serde(default)]
    pub client_class: ClientClass,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MobileCloseMode {
    Graceful,
    Continue,
    Keep,
    Force,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileCloseRequest {
    pub request_id: String,
    pub card_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<MobileCloseMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileCloseResolution {
    pub request_id: String,
    pub ok: bool,
    pub card_id: Option<String>,
    pub error_code: Option<String>,
    pub message: Option<String>,
    pub outcome: Option<String>,
    pub attempt_id: Option<String>,
    pub stage: Option<String>,
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
