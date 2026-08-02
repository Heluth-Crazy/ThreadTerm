use std::time::Duration;

use super::{
    broadcast_theme,
    network::{normalize_pair_public_target, DEFAULT_BRIDGE_PORT},
    protocol::{
        AppThemeTokens, BridgeDevice, BridgeStatus, CardMeta, DevicePermission,
        MobileWorkbenchProjection, NotificationEntry, PairQrResponse, SecurePairQrResponse,
        ServerMessage, TerminalThemeTokens, ThemeMode,
    },
    runtime::{
        rotate_secure_identity, start_bridge_runtime, start_secure_bridge_runtime,
        stop_bridge_runtime, stop_secure_bridge_runtime,
    },
    secure_identity_store, BRIDGE_RUNTIME,
};

pub(super) async fn start(host: Option<String>, port: Option<u16>) -> Result<BridgeStatus, String> {
    start_bridge_runtime(host, port, !cfg!(test)).await
}

pub(super) async fn sync_cards(cards: Vec<CardMeta>) -> Result<(), String> {
    BRIDGE_RUNTIME.sync_cards(cards);
    Ok(())
}

pub(super) async fn sync_state(
    cards: Vec<CardMeta>,
    notifications: Vec<NotificationEntry>,
    workbench: Option<MobileWorkbenchProjection>,
) -> Result<(), String> {
    BRIDGE_RUNTIME.sync_state(cards, notifications, workbench);
    Ok(())
}

pub(super) async fn resolve_spawn(
    request_id: String,
    ok: bool,
    card_id: Option<String>,
    error_code: Option<String>,
    message: Option<String>,
) -> Result<(), String> {
    BRIDGE_RUNTIME.broadcast(ServerMessage::SpawnResult {
        request_id,
        ok,
        card_id,
        error_code,
        message,
    });
    Ok(())
}

pub(super) async fn resolve_activate(
    request_id: String,
    ok: bool,
    card_id: Option<String>,
    error_code: Option<String>,
    message: Option<String>,
) -> Result<(), String> {
    BRIDGE_RUNTIME.broadcast(ServerMessage::ActivateResult {
        request_id,
        ok,
        card_id,
        error_code,
        message,
    });
    Ok(())
}

pub(super) async fn resolve_close(
    request_id: String,
    ok: bool,
    card_id: Option<String>,
    error_code: Option<String>,
    message: Option<String>,
) -> Result<(), String> {
    BRIDGE_RUNTIME.broadcast(ServerMessage::CloseResult {
        request_id,
        ok,
        card_id,
        error_code,
        message,
    });
    Ok(())
}

pub(super) async fn resolve_rename_card(
    request_id: String,
    ok: bool,
    card_id: Option<String>,
    error_code: Option<String>,
    message: Option<String>,
) -> Result<(), String> {
    BRIDGE_RUNTIME.broadcast(ServerMessage::RenameResult {
        request_id,
        ok,
        card_id,
        error_code,
        message,
    });
    Ok(())
}

pub(super) async fn stop() -> Result<BridgeStatus, String> {
    stop_bridge_runtime(Duration::from_secs(2)).await
}

pub(super) async fn status(_refresh: Option<bool>) -> Result<BridgeStatus, String> {
    Ok(BRIDGE_RUNTIME.status())
}

pub(super) async fn has_subscribers() -> Result<bool, String> {
    Ok(BRIDGE_RUNTIME.has_subscribers())
}

pub(super) async fn pair_qr(
    public_url: Option<String>,
    permission: Option<DevicePermission>,
) -> Result<PairQrResponse, String> {
    let status = BRIDGE_RUNTIME.status();
    if !status.running {
        return Err("Start mobile access before creating a pairing code.".to_string());
    }
    let local_port = status.port.unwrap_or(DEFAULT_BRIDGE_PORT);
    let target = normalize_pair_public_target(public_url.as_deref(), local_port)?;
    let server_id = BRIDGE_RUNTIME.server_id().to_string();

    Ok(BRIDGE_RUNTIME.pairing.create_pair_qr_for_target(
        target.base_url,
        target.host,
        target.port,
        server_id,
        permission.unwrap_or(DevicePermission::ReadOnly),
    ))
}

pub(super) async fn secure_pair_qr(
    permission: Option<DevicePermission>,
) -> Result<SecurePairQrResponse, String> {
    let status = BRIDGE_RUNTIME.status();
    if !status.secure_running.unwrap_or(false) {
        // Auto-start the secure listener when the desktop requests a secure QR.
        start_secure_bridge_runtime(None, !cfg!(test)).await?;
    }
    let status = BRIDGE_RUNTIME.status();
    let host = status
        .secure_host
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = status
        .secure_port
        .ok_or_else(|| "Secure mobile bridge is not listening.".to_string())?;
    let store = secure_identity_store();
    let identity = store
        .load()
        .map(|(identity, _)| identity)
        .map_err(|error| error.to_string())?;

    Ok(BRIDGE_RUNTIME.pairing.create_secure_pair_qr(
        host,
        port,
        identity.computer_id,
        identity.fingerprint_sha256,
        permission.unwrap_or(DevicePermission::ReadOnly),
    ))
}

pub(super) async fn start_secure(port: Option<u16>) -> Result<BridgeStatus, String> {
    start_secure_bridge_runtime(port, !cfg!(test)).await
}

pub(super) async fn stop_secure() -> Result<BridgeStatus, String> {
    stop_secure_bridge_runtime(Duration::from_secs(2)).await
}

pub(super) async fn rotate_identity() -> Result<BridgeStatus, String> {
    rotate_secure_identity().await
}

pub(super) async fn devices() -> Result<Vec<BridgeDevice>, String> {
    Ok(BRIDGE_RUNTIME.pairing.list_devices())
}

pub(super) async fn revoke_device(device_id: String) -> Result<bool, String> {
    let runtime = BRIDGE_RUNTIME.clone();
    tokio::task::spawn_blocking(move || runtime.pairing.revoke_device(&device_id))
        .await
        .map_err(|error| format!("Failed to join mobile bridge revocation task: {error}"))?
}

pub(super) async fn publish_theme(
    app: AppThemeTokens,
    terminal: TerminalThemeTokens,
    mode: ThemeMode,
) -> Result<(), String> {
    broadcast_theme(app, terminal, mode);
    Ok(())
}
