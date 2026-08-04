#[path = "bridge/protocol.rs"]
pub mod protocol;

use crate::pty::SessionState;
use protocol::{
    AppThemeTokens, BridgeDevice, BridgeStatus, CardMeta, DevicePermission, MobileCloseResolution,
    MobileWorkbenchProjection, NotificationEntry, PairQrResponse, TerminalThemeTokens, ThemeMode,
};

const DISABLED_MESSAGE: &str = "Mobile bridge is disabled in this build.";

pub(crate) struct PreparedCardRemoval;

fn stopped_status() -> BridgeStatus {
    BridgeStatus {
        running: false,
        host: None,
        port: None,
        url: None,
        secure_running: Some(false),
        secure_host: None,
        secure_port: None,
        secure_endpoint: None,
        identity_status: None,
        fingerprint_short: None,
        computer_id: None,
    }
}

pub fn restore_bridge_on_startup() {}

pub fn set_app_handle(_app_handle: tauri::AppHandle) {}

#[tauri::command]
pub async fn bridge_start(
    _host: Option<String>,
    _port: Option<u16>,
) -> Result<BridgeStatus, String> {
    Err(DISABLED_MESSAGE.to_string())
}

#[tauri::command]
pub async fn bridge_stop() -> Result<BridgeStatus, String> {
    Ok(stopped_status())
}

#[tauri::command]
pub async fn bridge_status(_refresh: Option<bool>) -> Result<BridgeStatus, String> {
    Ok(stopped_status())
}

#[tauri::command]
pub async fn bridge_has_subscribers() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub async fn bridge_pair_qr(
    _public_url: Option<String>,
    _permission: Option<DevicePermission>,
) -> Result<PairQrResponse, String> {
    Err(DISABLED_MESSAGE.to_string())
}

#[tauri::command]
pub async fn bridge_secure_pair_qr(
    _permission: Option<DevicePermission>,
) -> Result<protocol::SecurePairQrResponse, String> {
    Err(DISABLED_MESSAGE.to_string())
}

#[tauri::command]
pub async fn bridge_start_secure(_port: Option<u16>) -> Result<BridgeStatus, String> {
    Err(DISABLED_MESSAGE.to_string())
}

#[tauri::command]
pub async fn bridge_stop_secure() -> Result<BridgeStatus, String> {
    Ok(stopped_status())
}

#[tauri::command]
pub async fn bridge_rotate_secure_identity() -> Result<BridgeStatus, String> {
    Err(DISABLED_MESSAGE.to_string())
}

#[tauri::command]
pub async fn bridge_devices() -> Result<Vec<BridgeDevice>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn bridge_revoke_device(_device_id: String) -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub async fn bridge_sync_cards(_cards: Vec<CardMeta>) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn bridge_sync_state(
    _cards: Vec<CardMeta>,
    _notifications: Vec<NotificationEntry>,
    _workbench: Option<MobileWorkbenchProjection>,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn bridge_resolve_mobile_spawn(
    _request_id: String,
    _ok: bool,
    _card_id: Option<String>,
    _error_code: Option<String>,
    _message: Option<String>,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn bridge_resolve_mobile_activate(
    _request_id: String,
    _ok: bool,
    _card_id: Option<String>,
    _error_code: Option<String>,
    _message: Option<String>,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn bridge_resolve_mobile_close(_result: MobileCloseResolution) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn bridge_resolve_mobile_rename_card(
    _request_id: String,
    _ok: bool,
    _card_id: Option<String>,
    _error_code: Option<String>,
    _message: Option<String>,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn bridge_broadcast_theme(
    _app: AppThemeTokens,
    _terminal: TerminalThemeTokens,
    _mode: ThemeMode,
) -> Result<(), String> {
    Ok(())
}

pub fn broadcast_preview<F>(_card_id: &str, _build_output: F)
where
    F: FnOnce() -> String,
{
}

pub fn broadcast_terminal_output(_card_id: &str, _data: &str, _seq: u64) {}

pub fn broadcast_theme(_app: AppThemeTokens, _terminal: TerminalThemeTokens, _mode: ThemeMode) {}

pub fn broadcast_state(_card_id: &str, _state: &SessionState) {}

pub fn broadcast_attention(_card_id: &str, _kind: &str, _message: &str) {}

pub fn broadcast_exit(_card_id: &str, _code: Option<u32>) {}

pub fn broadcast_card_added(_card_id: &str) {}

pub(crate) fn prepare_card_removed(
    _pty_id: &str,
    _state: SessionState,
    _working_dir: &str,
) -> PreparedCardRemoval {
    PreparedCardRemoval
}

pub(crate) fn broadcast_card_removed(_removal: PreparedCardRemoval) {}
