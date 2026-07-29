use serde::{Deserialize, Serialize};

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
