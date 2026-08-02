use std::time::Duration;

use once_cell::sync::Lazy;
use rand::{distributions::Alphanumeric, Rng};

use super::{
    identity::IdentityLoadError,
    network::{DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT, DEFAULT_SECURE_BRIDGE_PORT},
    protocol::BridgeStatus,
    secure_identity_store, secure_server, server, BRIDGE_RUNTIME,
};

const BRIDGE_ENABLED_SETTING: &str = "mobile_bridge.enabled";
const BRIDGE_HOST_SETTING: &str = "mobile_bridge.host";
const BRIDGE_PORT_SETTING: &str = "mobile_bridge.port";
const BRIDGE_SERVER_ID_SETTING: &str = "mobile_bridge.server_id";
const SECURE_BRIDGE_ENABLED_SETTING: &str = "mobile_bridge.secure_enabled";
const SECURE_BRIDGE_PORT_SETTING: &str = "mobile_bridge.secure_port";

static BRIDGE_LIFECYCLE_GATE: Lazy<tokio::sync::Mutex<()>> =
    Lazy::new(|| tokio::sync::Mutex::new(()));

pub(super) fn restore_bridge_on_startup() {
    if !persisted_bridge_enabled() {
        return;
    }

    let persisted_host = crate::db::get_setting(BRIDGE_HOST_SETTING)
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BRIDGE_HOST.to_string());
    if persisted_host != DEFAULT_BRIDGE_HOST {
        tracing::warn!(
            previous_host = %persisted_host,
            "Migrating mobile bridge away from direct LAN exposure"
        );
        if let Err(error) = crate::db::set_setting(BRIDGE_HOST_SETTING, DEFAULT_BRIDGE_HOST) {
            tracing::warn!(error = %error, "Failed to persist loopback-only bridge migration");
        }
    }
    let host = DEFAULT_BRIDGE_HOST.to_string();
    let port = crate::db::get_setting(BRIDGE_PORT_SETTING)
        .ok()
        .flatten()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_BRIDGE_PORT);

    tauri::async_runtime::spawn(async move {
        match restore_bridge_runtime(host, port).await {
            Ok(Some(status)) => {
                tracing::info!(
                    host = ?status.host,
                    port = ?status.port,
                    "Mobile bridge restored from settings"
                );
            }
            Ok(None) => {
                tracing::debug!(
                    "Skipped mobile bridge restore because it was disabled before startup completed"
                );
            }
            Err(error) => {
                tracing::warn!(error = %error, "Failed to restore mobile bridge from settings");
            }
        }
    });
}

pub(super) fn set_app_handle(app_handle: tauri::AppHandle) {
    BRIDGE_RUNTIME.set_app_handle(app_handle);
}

pub(super) async fn start_bridge_runtime(
    host: Option<String>,
    port: Option<u16>,
    persist_enabled: bool,
) -> Result<BridgeStatus, String> {
    let _lifecycle = BRIDGE_LIFECYCLE_GATE.lock().await;
    start_bridge_runtime_locked(host, port, persist_enabled).await
}

async fn restore_bridge_runtime(host: String, port: u16) -> Result<Option<BridgeStatus>, String> {
    let _lifecycle = BRIDGE_LIFECYCLE_GATE.lock().await;
    // Startup restoration is spawned asynchronously. A user can disable the
    // bridge while that task is waiting to run, so the persisted intent must
    // be re-read inside the same gate used by start and stop.
    if !persisted_bridge_enabled() {
        return Ok(None);
    }
    start_bridge_runtime_locked(Some(host), Some(port), true)
        .await
        .map(Some)
}

async fn start_bridge_runtime_locked(
    host: Option<String>,
    port: Option<u16>,
    persist_enabled: bool,
) -> Result<BridgeStatus, String> {
    let runtime = BRIDGE_RUNTIME.clone();

    let existing_server_stopping = {
        runtime
            .server
            .lock()
            .map_err(|e| format!("Bridge state unavailable: {e}"))?
            .as_ref()
            .map(|handle| handle.is_stopping())
    };
    if let Some(stopping) = existing_server_stopping {
        let status = runtime.status();
        if stopping {
            return Err(
                "Mobile bridge shutdown is incomplete; retry stop before starting it again."
                    .to_string(),
            );
        }
        if persist_enabled {
            persist_bridge_running(&status);
        }
        return Ok(status);
    }

    let requested_host = host
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BRIDGE_HOST.to_string());
    if requested_host != DEFAULT_BRIDGE_HOST {
        return Err(
            "Direct LAN binding is disabled. Keep ThreadTerm on this computer and publish it through an HTTPS secure tunnel."
                .to_string(),
        );
    }
    let bind_host = DEFAULT_BRIDGE_HOST.to_string();
    let bind_port = port.unwrap_or(DEFAULT_BRIDGE_PORT);
    let handle = server::start(runtime.clone(), bind_host, bind_port).await?;

    {
        let mut guard = runtime
            .server
            .lock()
            .map_err(|e| format!("Bridge state unavailable: {e}"))?;
        *guard = Some(handle);
    }

    // Secure listener is independently switchable; restore only when previously enabled.
    if persisted_secure_bridge_enabled() {
        if let Err(error) = start_secure_bridge_runtime_locked(None, persist_enabled).await {
            tracing::warn!(error = %error, "Secure mobile bridge failed to start alongside v1");
        }
    }

    let status = runtime.status();
    tracing::info!(
        host = ?status.host,
        port = ?status.port,
        secure_port = ?status.secure_port,
        "Mobile bridge started"
    );
    if persist_enabled {
        persist_bridge_running(&status);
    }
    Ok(status)
}

pub(super) async fn start_secure_bridge_runtime(
    port: Option<u16>,
    persist_enabled: bool,
) -> Result<BridgeStatus, String> {
    let _lifecycle = BRIDGE_LIFECYCLE_GATE.lock().await;
    start_secure_bridge_runtime_locked(port, persist_enabled).await
}

async fn start_secure_bridge_runtime_locked(
    port: Option<u16>,
    persist_enabled: bool,
) -> Result<BridgeStatus, String> {
    let runtime = BRIDGE_RUNTIME.clone();

    let existing_stopping = {
        runtime
            .secure_server
            .lock()
            .map_err(|e| format!("Bridge state unavailable: {e}"))?
            .as_ref()
            .map(|handle| handle.is_stopping())
    };
    if let Some(stopping) = existing_stopping {
        let status = runtime.status();
        if stopping {
            return Err(
                "Secure mobile bridge shutdown is incomplete; retry stop before starting it again."
                    .to_string(),
            );
        }
        if persist_enabled {
            persist_secure_bridge_running(&status);
        }
        return Ok(status);
    }

    let store = secure_identity_store();
    let identity = match store.load_or_create() {
        Ok(identity) => identity,
        Err(IdentityLoadError::Corrupt { reason }) => {
            return Err(format!(
                "Secure bridge identity_error: {reason}. Rotate the desktop identity before enabling the secure bridge."
            ));
        }
        Err(IdentityLoadError::Missing) => {
            return Err("Secure bridge identity is missing.".to_string());
        }
    };

    let bind_port = port
        .or_else(|| {
            crate::db::get_setting(SECURE_BRIDGE_PORT_SETTING)
                .ok()
                .flatten()
                .and_then(|value| value.parse::<u16>().ok())
        })
        .unwrap_or(DEFAULT_SECURE_BRIDGE_PORT);

    let handle = if bind_port == 0 {
        secure_server::start_on_ephemeral(
            runtime.clone(),
            DEFAULT_BRIDGE_HOST.to_string(),
            identity,
        )
        .await?
    } else {
        secure_server::start(
            runtime.clone(),
            DEFAULT_BRIDGE_HOST.to_string(),
            bind_port,
            identity,
        )
        .await?
    };

    {
        let mut guard = runtime
            .secure_server
            .lock()
            .map_err(|e| format!("Bridge state unavailable: {e}"))?;
        *guard = Some(handle);
    }

    let status = runtime.status();
    tracing::info!(
        secure_port = ?status.secure_port,
        fingerprint = ?status.fingerprint_short,
        "Secure mobile bridge started"
    );
    if persist_enabled {
        persist_secure_bridge_running(&status);
    }
    Ok(status)
}

pub(super) async fn stop_bridge_runtime(timeout: Duration) -> Result<BridgeStatus, String> {
    let _lifecycle = BRIDGE_LIFECYCLE_GATE.lock().await;
    let runtime = BRIDGE_RUNTIME.clone();

    let mut secure_handle = runtime
        .secure_server
        .lock()
        .map_err(|e| format!("Bridge state unavailable: {e}"))?
        .take();
    let secure_stop = if let Some(handle) = secure_handle.as_mut() {
        handle.stop(timeout).await
    } else {
        Ok(())
    };

    let mut handle = runtime
        .server
        .lock()
        .map_err(|e| format!("Bridge state unavailable: {e}"))?
        .take();

    let stop_result = if let Some(handle) = handle.as_mut() {
        handle.stop(timeout).await
    } else {
        Ok(())
    };

    if !cfg!(test) {
        if let Err(error) = crate::db::set_setting(BRIDGE_ENABLED_SETTING, "false") {
            tracing::debug!(error = %error, "Failed to persist mobile bridge stopped state");
        }
        if let Err(error) = crate::db::set_setting(SECURE_BRIDGE_ENABLED_SETTING, "false") {
            tracing::debug!(error = %error, "Failed to persist secure bridge stopped state");
        }
    }

    if let Err(error) = secure_stop {
        if let Some(handle) = secure_handle {
            let mut server = runtime
                .secure_server
                .lock()
                .unwrap_or_else(|lock_error| lock_error.into_inner());
            *server = Some(handle);
        }
        // Restore legacy handle if we took it after secure failure path.
        if let Some(handle) = handle {
            let mut server = runtime
                .server
                .lock()
                .unwrap_or_else(|lock_error| lock_error.into_inner());
            *server = Some(handle);
        }
        return Err(error);
    }

    match stop_result {
        Ok(()) => Ok(runtime.status()),
        Err(error) => {
            if let Some(handle) = handle {
                let mut server = runtime
                    .server
                    .lock()
                    .unwrap_or_else(|lock_error| lock_error.into_inner());
                *server = Some(handle);
            }
            Err(error)
        }
    }
}

pub(super) async fn stop_secure_bridge_runtime(timeout: Duration) -> Result<BridgeStatus, String> {
    let _lifecycle = BRIDGE_LIFECYCLE_GATE.lock().await;
    let runtime = BRIDGE_RUNTIME.clone();
    let mut handle = runtime
        .secure_server
        .lock()
        .map_err(|e| format!("Bridge state unavailable: {e}"))?
        .take();

    let stop_result = if let Some(handle) = handle.as_mut() {
        handle.stop(timeout).await
    } else {
        Ok(())
    };

    if !cfg!(test) {
        if let Err(error) = crate::db::set_setting(SECURE_BRIDGE_ENABLED_SETTING, "false") {
            tracing::debug!(error = %error, "Failed to persist secure bridge stopped state");
        }
    }

    match stop_result {
        Ok(()) => Ok(runtime.status()),
        Err(error) => {
            if let Some(handle) = handle {
                let mut server = runtime
                    .secure_server
                    .lock()
                    .unwrap_or_else(|lock_error| lock_error.into_inner());
                *server = Some(handle);
            }
            Err(error)
        }
    }
}

/// Rotate the desktop TLS identity and revoke all secure-workspace tokens.
pub(super) async fn rotate_secure_identity() -> Result<BridgeStatus, String> {
    let _lifecycle = BRIDGE_LIFECYCLE_GATE.lock().await;
    let runtime = BRIDGE_RUNTIME.clone();

    // Stop secure listener before rotating material.
    let mut handle = runtime
        .secure_server
        .lock()
        .map_err(|e| format!("Bridge state unavailable: {e}"))?
        .take();
    if let Some(handle) = handle.as_mut() {
        handle.stop(Duration::from_secs(2)).await?;
    }

    let store = secure_identity_store();
    let identity = store.rotate()?;
    let revoked = runtime.pairing.revoke_all_secure_devices()?;
    tracing::info!(
        computer_id = %identity.computer_id,
        revoked_devices = revoked,
        "Rotated secure bridge identity"
    );
    Ok(runtime.status())
}

fn persisted_bridge_enabled() -> bool {
    crate::db::get_setting(BRIDGE_ENABLED_SETTING)
        .ok()
        .flatten()
        .map(|value| value == "true")
        .unwrap_or(false)
}

pub(super) fn load_or_create_bridge_server_id() -> String {
    if let Ok(Some(existing)) = crate::db::get_setting(BRIDGE_SERVER_ID_SETTING) {
        let existing = existing.trim();
        if (24..=128).contains(&existing.len())
            && existing
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return existing.to_string();
        }
        tracing::warn!("Ignoring invalid persisted mobile bridge computer identity");
    }

    let server_id: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();
    if let Err(error) = crate::db::set_setting(BRIDGE_SERVER_ID_SETTING, &server_id) {
        tracing::warn!(
            error = %error,
            "Failed to persist mobile bridge computer identity; devices will need to pair again after restart"
        );
    }
    server_id
}

fn persist_bridge_running(status: &BridgeStatus) {
    if !status.running {
        return;
    }

    if let Err(error) = crate::db::set_setting(BRIDGE_ENABLED_SETTING, "true") {
        tracing::debug!(error = %error, "Failed to persist mobile bridge enabled state");
    }
    if let Some(host) = status.host.as_deref() {
        if let Err(error) = crate::db::set_setting(BRIDGE_HOST_SETTING, host) {
            tracing::debug!(error = %error, "Failed to persist mobile bridge host");
        }
    }
    if let Some(port) = status.port {
        if let Err(error) = crate::db::set_setting(BRIDGE_PORT_SETTING, &port.to_string()) {
            tracing::debug!(error = %error, "Failed to persist mobile bridge port");
        }
    }
}

fn persisted_secure_bridge_enabled() -> bool {
    crate::db::get_setting(SECURE_BRIDGE_ENABLED_SETTING)
        .ok()
        .flatten()
        .map(|value| value == "true")
        .unwrap_or(false)
}

fn persist_secure_bridge_running(status: &BridgeStatus) {
    if !status.secure_running.unwrap_or(false) {
        return;
    }
    if let Err(error) = crate::db::set_setting(SECURE_BRIDGE_ENABLED_SETTING, "true") {
        tracing::debug!(error = %error, "Failed to persist secure bridge enabled state");
    }
    if let Some(port) = status.secure_port {
        if let Err(error) = crate::db::set_setting(SECURE_BRIDGE_PORT_SETTING, &port.to_string()) {
            tracing::debug!(error = %error, "Failed to persist secure bridge port");
        }
    }
}
