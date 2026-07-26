pub mod protocol;

mod pairing;
mod preview;
mod server;

use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use once_cell::sync::{Lazy, OnceCell};
use rand::{distributions::Alphanumeric, Rng};
use tauri::Emitter;
use tokio::sync::broadcast;

use crate::pty::{self, LivePtySessionSnapshot, SessionState};

use pairing::PairingStore;
use preview::preview_from_output;
use protocol::{
    AppThemeTokens, BridgeDevice, BridgeSnapshot, BridgeStatus, BridgeTheme, CardMeta,
    DevicePermission, MobileCardRequest, MobileRenameCardRequest, MobileSpawnCardRequest,
    MobileWorkbenchProjection, NotificationEntry, PairQrResponse, ServerMessage,
    TerminalSnapshotMessage, TerminalStatus, TerminalThemeTokens, ThemeMode,
};

const DEFAULT_BRIDGE_HOST: &str = "127.0.0.1";
const DEFAULT_BRIDGE_PORT: u16 = 5174;
const PREVIEW_CHANNEL_CAPACITY: usize = 1024;
const BRIDGE_ENABLED_SETTING: &str = "mobile_bridge.enabled";
const BRIDGE_HOST_SETTING: &str = "mobile_bridge.host";
const BRIDGE_PORT_SETTING: &str = "mobile_bridge.port";
const BRIDGE_SERVER_ID_SETTING: &str = "mobile_bridge.server_id";

pub static BRIDGE_RUNTIME: Lazy<Arc<BridgeRuntime>> = Lazy::new(|| Arc::new(BridgeRuntime::new()));
static BRIDGE_LIFECYCLE_GATE: Lazy<tokio::sync::Mutex<()>> =
    Lazy::new(|| tokio::sync::Mutex::new(()));

pub struct BridgeRuntime {
    tx: broadcast::Sender<ServerMessage>,
    pub pairing: PairingStore,
    theme: Mutex<BridgeTheme>,
    server: Mutex<Option<server::BridgeServerHandle>>,
    app_handle: Mutex<Option<tauri::AppHandle>>,
    state_mirror: Mutex<BridgeStateMirror>,
    server_id: OnceCell<String>,
    runtime_id: String,
    terminal_stream_seq: Mutex<u64>,
    #[cfg(test)]
    preview_snapshot_serializations: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    snapshot_card_enrichments: std::sync::atomic::AtomicUsize,
}

#[derive(Default)]
struct BridgeStateMirror {
    cards: Vec<CardMeta>,
    notifications: Vec<NotificationEntry>,
    workbench: Option<MobileWorkbenchProjection>,
    initialized: bool,
}

pub(crate) struct PreparedCardRemoval {
    card: CardMeta,
}

impl BridgeRuntime {
    fn new() -> Self {
        let (tx, _) = broadcast::channel(PREVIEW_CHANNEL_CAPACITY);
        Self {
            tx,
            pairing: PairingStore::default(),
            theme: Mutex::new(BridgeTheme::default()),
            server: Mutex::new(None),
            app_handle: Mutex::new(None),
            state_mirror: Mutex::new(BridgeStateMirror::default()),
            server_id: OnceCell::new(),
            runtime_id: rand::thread_rng()
                .sample_iter(&Alphanumeric)
                .take(20)
                .map(char::from)
                .collect(),
            terminal_stream_seq: Mutex::new(0),
            #[cfg(test)]
            preview_snapshot_serializations: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            snapshot_card_enrichments: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerMessage> {
        self.tx.subscribe()
    }

    pub fn has_subscribers(&self) -> bool {
        self.tx.receiver_count() > 0
    }

    fn runtime_id(&self) -> &str {
        &self.runtime_id
    }

    fn server_id(&self) -> &str {
        self.server_id.get_or_init(load_or_create_bridge_server_id)
    }

    fn current_terminal_stream_seq(&self) -> u64 {
        match self.terminal_stream_seq.lock() {
            Ok(stream_seq) => *stream_seq,
            Err(poisoned) => *poisoned.into_inner(),
        }
    }

    fn broadcast_terminal_frame(&self, card_id: String, data: String, seq: u64) {
        let mut stream_seq = match self.terminal_stream_seq.lock() {
            Ok(stream_seq) => stream_seq,
            Err(poisoned) => poisoned.into_inner(),
        };
        *stream_seq = stream_seq.saturating_add(1);
        let _ = self.tx.send(ServerMessage::TerminalOutput {
            card_id,
            data,
            seq,
            runtime_id: self.runtime_id.clone(),
            stream_seq: *stream_seq,
        });
    }

    pub fn broadcast(&self, message: ServerMessage) {
        let _ = self.tx.send(message);
    }

    pub fn set_app_handle(&self, app_handle: tauri::AppHandle) {
        if let Ok(mut current) = self.app_handle.lock() {
            *current = Some(app_handle);
        }
    }

    pub fn set_theme(&self, theme: BridgeTheme) {
        if let Ok(mut current) = self.theme.lock() {
            *current = theme.clone();
        }
        self.broadcast(ServerMessage::Theme {
            app: theme.app,
            terminal: theme.terminal,
            mode: theme.mode,
        });
    }

    pub fn current_theme(&self) -> BridgeTheme {
        self.theme
            .lock()
            .map(|theme| theme.clone())
            .unwrap_or_default()
    }

    pub fn snapshot(&self) -> BridgeSnapshot {
        self.snapshot_with_enricher(enrich_card_with_live_state)
    }

    fn snapshot_with_enricher<F>(&self, mut enrich: F) -> BridgeSnapshot
    where
        F: FnMut(CardMeta) -> CardMeta,
    {
        let (initialized, cards, notifications, workbench) = self
            .state_mirror
            .lock()
            .map(|state| {
                (
                    state.initialized,
                    state.cards.clone(),
                    state.notifications.clone(),
                    state.workbench.clone(),
                )
            })
            .unwrap_or_else(|_| (false, Vec::new(), Vec::new(), None));
        if !initialized {
            return BridgeSnapshot {
                cards: Vec::new(),
                notifications: Vec::new(),
                workbench: None,
                warming_up: true,
                server_id: self.server_id().to_string(),
                runtime_id: self.runtime_id.clone(),
                stream_seq: self.current_terminal_stream_seq(),
            };
        }

        // F-01 lock discipline: CLONE under `state_mirror`, ENRICH outside
        // the lock. `enrich_card_with_live_state` calls
        // `pty::live_session_snapshot`, which reads PTY state. Acquiring the
        // PTY state lock while holding `state_mirror` is the reverse order of
        // `pty::session::set_session_state` -> `bridge::broadcast_state` ->
        // `card_id_for_pty` (which locks `state_mirror`); together they can
        // deadlock. The previous snapshot behavior (cards after enrichment)
        // is preserved bit-for-bit — only the lock scope changes.
        let cards = cards
            .into_iter()
            .map(|card| {
                #[cfg(test)]
                self.snapshot_card_enrichments
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                enrich(card)
            })
            .collect();

        BridgeSnapshot {
            cards,
            notifications,
            workbench,
            warming_up: false,
            server_id: self.server_id().to_string(),
            runtime_id: self.runtime_id.clone(),
            stream_seq: self.current_terminal_stream_seq(),
        }
    }

    pub fn sync_cards(&self, cards: Vec<CardMeta>) {
        if let Ok(mut mirror) = self.state_mirror.lock() {
            mirror.cards = cards;
            mirror.initialized = true;
        }
        self.broadcast_state_snapshot_if_subscribed();
    }

    pub fn sync_state(
        &self,
        cards: Vec<CardMeta>,
        notifications: Vec<NotificationEntry>,
        workbench: Option<MobileWorkbenchProjection>,
    ) {
        if let Ok(mut mirror) = self.state_mirror.lock() {
            mirror.cards = cards;
            mirror.notifications = notifications;
            mirror.workbench = workbench;
            mirror.initialized = true;
        }
        self.broadcast_state_snapshot_if_subscribed();
    }

    fn broadcast_state_snapshot_if_subscribed(&self) {
        // The mirror is durable bridge state and must always be updated, even
        // with no WebSocket clients. The enriched snapshot is broadcast-only
        // work; a later HTTP/WebSocket client builds a fresh snapshot on
        // demand, so there is no reason to serialize every live terminal now.
        if !self.has_subscribers() {
            return;
        }
        let snapshot = self.snapshot();
        self.broadcast(ServerMessage::from(snapshot.clone()));
        // FIX-2 (deep-research-defect-fix / second-diagnosis 问题一-D):
        // terminal_snapshot is sent ONLY on first connect / reconnect /
        // Lagged-recovery (server.rs::initial_messages_for_client) and on
        // single-card add (broadcast_card_added). Card-mirror metadata sync
        // must NOT re-broadcast every live card's full screen snapshot —
        // that was the dominant WS amplification under sustained output.
        // Live screen content is already delivered incrementally via the
        // independent broadcast_terminal_output channel, so dropping the
        // per-sync full re-snapshot does not lose any client state.
    }

    pub fn pty_id_for_card(&self, card_id: &str) -> String {
        self.state_mirror
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .cards
                    .iter()
                    .find(|card| card.id == card_id)
                    .and_then(|card| card.pty_id.clone())
            })
            .unwrap_or_else(|| card_id.to_string())
    }

    pub fn card_id_for_pty(&self, pty_id: &str) -> String {
        self.state_mirror
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .cards
                    .iter()
                    .find(|card| {
                        card.id == pty_id
                            || card
                                .pty_id
                                .as_deref()
                                .map(|candidate| candidate == pty_id)
                                .unwrap_or(false)
                    })
                    .map(|card| card.id.clone())
            })
            .unwrap_or_else(|| pty_id.to_string())
    }

    fn mirrored_card_for_pty(&self, pty_id: &str) -> Option<CardMeta> {
        self.mirrored_card_for_pty_with_enricher(pty_id, enrich_card_with_live_state)
    }

    fn cloned_mirrored_card_for_pty(&self, pty_id: &str) -> Option<CardMeta> {
        self.state_mirror.lock().ok().and_then(|state| {
            state
                .cards
                .iter()
                .find(|card| {
                    card.id == pty_id
                        || card
                            .pty_id
                            .as_deref()
                            .map(|candidate| candidate == pty_id)
                            .unwrap_or(false)
                })
                .cloned()
        })
    }

    fn mirrored_card_for_pty_with_enricher<F>(&self, pty_id: &str, enrich: F) -> Option<CardMeta>
    where
        F: FnOnce(CardMeta) -> CardMeta,
    {
        // F-01 lock discipline: find+clone under `state_mirror`, enrich
        // outside. `enrich_card_with_live_state` reenters PTY state via
        // `pty::live_session_snapshot`, which would reverse
        // `set_session_state`'s lock order and risk deadlock.
        self.cloned_mirrored_card_for_pty(pty_id).map(enrich)
    }

    fn mirrored_card_for_removal(&self, pty_id: &str) -> Option<CardMeta> {
        self.cloned_mirrored_card_for_pty(pty_id).map(|mut card| {
            card.pty_live = false;
            card.pty_state = None;
            card
        })
    }

    fn prepare_card_removal(
        &self,
        pty_id: &str,
        state: SessionState,
        working_dir: &str,
    ) -> PreparedCardRemoval {
        let card = self
            .mirrored_card_for_removal(pty_id)
            .unwrap_or_else(|| card_meta_tombstone(pty_id, state, working_dir));
        PreparedCardRemoval { card }
    }

    fn broadcast_preview_lazy<F>(&self, card_id: &str, build_output: F)
    where
        F: FnOnce() -> String,
    {
        if !self.has_subscribers() {
            return;
        }

        #[cfg(test)]
        self.preview_snapshot_serializations
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let output = build_output();
        let preview = preview_from_output(&output);
        if preview.last_reply_preview.is_empty() {
            return;
        }
        let bridge_card_id = self.card_id_for_pty(card_id);

        self.broadcast(ServerMessage::Preview {
            card_id: bridge_card_id,
            last_reply_preview: preview.last_reply_preview,
            summary_line: preview.summary_line,
            hidden_line_count: preview.hidden_line_count,
        });
    }

    pub fn emit_spawn_request(&self, request: MobileSpawnCardRequest) -> Result<(), String> {
        self.emit_desktop_event("mobile://spawn-card", request)
    }

    pub fn emit_activate_request(&self, request: MobileCardRequest) -> Result<(), String> {
        self.emit_desktop_event("mobile://activate-card", request)
    }

    pub fn emit_remove_request(&self, request: MobileCardRequest) -> Result<(), String> {
        self.emit_desktop_event("mobile://remove-card", request)
    }

    pub fn emit_rename_card_request(&self, request: MobileRenameCardRequest) -> Result<(), String> {
        self.emit_desktop_event("mobile://rename-card", request)
    }

    fn emit_desktop_event<T>(&self, event: &str, payload: T) -> Result<(), String>
    where
        T: serde::Serialize + Clone,
    {
        let app_handle = self
            .app_handle
            .lock()
            .map_err(|e| format!("Bridge app handle unavailable: {e}"))?
            .clone()
            .ok_or_else(|| "Desktop window is unavailable.".to_string())?;
        app_handle
            .emit(event, payload)
            .map_err(|e| format!("Failed to emit desktop bridge event: {e}"))
    }

    fn status(&self) -> BridgeStatus {
        match self.server.lock().ok().and_then(|guard| {
            guard
                .as_ref()
                .map(|handle| (handle.host.clone(), handle.port))
        }) {
            Some((host, port)) => BridgeStatus {
                running: true,
                url: Some(format!("http://{host}:{port}")),
                host: Some(host),
                port: Some(port),
            },
            None => BridgeStatus {
                running: false,
                host: None,
                port: None,
                url: None,
            },
        }
    }
}

pub fn restore_bridge_on_startup() {
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

pub fn set_app_handle(app_handle: tauri::AppHandle) {
    BRIDGE_RUNTIME.set_app_handle(app_handle);
}

#[tauri::command]
pub async fn bridge_start(host: Option<String>, port: Option<u16>) -> Result<BridgeStatus, String> {
    start_bridge_runtime(host, port, !cfg!(test)).await
}

#[tauri::command]
pub async fn bridge_sync_cards(cards: Vec<CardMeta>) -> Result<(), String> {
    BRIDGE_RUNTIME.sync_cards(cards);
    Ok(())
}

#[tauri::command]
pub async fn bridge_sync_state(
    cards: Vec<CardMeta>,
    notifications: Vec<NotificationEntry>,
    workbench: Option<MobileWorkbenchProjection>,
) -> Result<(), String> {
    BRIDGE_RUNTIME.sync_state(cards, notifications, workbench);
    Ok(())
}

#[tauri::command]
pub async fn bridge_resolve_mobile_spawn(
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

#[tauri::command]
pub async fn bridge_resolve_mobile_activate(
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

#[tauri::command]
pub async fn bridge_resolve_mobile_close(
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

#[tauri::command]
pub async fn bridge_resolve_mobile_rename_card(
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

async fn start_bridge_runtime(
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

    let status = runtime.status();
    tracing::info!(
        host = ?status.host,
        port = ?status.port,
        "Mobile bridge started"
    );
    if persist_enabled {
        persist_bridge_running(&status);
    }
    Ok(status)
}

#[tauri::command]
pub async fn bridge_stop() -> Result<BridgeStatus, String> {
    stop_bridge_runtime(Duration::from_secs(2)).await
}

async fn stop_bridge_runtime(timeout: Duration) -> Result<BridgeStatus, String> {
    let _lifecycle = BRIDGE_LIFECYCLE_GATE.lock().await;
    let runtime = BRIDGE_RUNTIME.clone();
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

fn persisted_bridge_enabled() -> bool {
    crate::db::get_setting(BRIDGE_ENABLED_SETTING)
        .ok()
        .flatten()
        .map(|value| value == "true")
        .unwrap_or(false)
}

fn load_or_create_bridge_server_id() -> String {
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

#[tauri::command]
pub async fn bridge_status(_refresh: Option<bool>) -> Result<BridgeStatus, String> {
    Ok(BRIDGE_RUNTIME.status())
}

#[tauri::command]
pub async fn bridge_has_subscribers() -> Result<bool, String> {
    Ok(BRIDGE_RUNTIME.has_subscribers())
}

#[tauri::command]
pub async fn bridge_pair_qr(
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

struct PairPublicTarget {
    base_url: String,
    host: String,
    port: u16,
}

fn normalize_pair_public_target(
    public_url: Option<&str>,
    local_port: u16,
) -> Result<PairPublicTarget, String> {
    let Some(value) = public_url.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(PairPublicTarget {
            base_url: format!("http://{DEFAULT_BRIDGE_HOST}:{local_port}"),
            host: DEFAULT_BRIDGE_HOST.to_string(),
            port: local_port,
        });
    };
    if matches!(value, "127.0.0.1" | "localhost") {
        return Ok(PairPublicTarget {
            base_url: format!("http://{DEFAULT_BRIDGE_HOST}:{local_port}"),
            host: DEFAULT_BRIDGE_HOST.to_string(),
            port: local_port,
        });
    }

    let uri = value
        .parse::<axum::http::Uri>()
        .map_err(|_| "Secure tunnel address must be a valid HTTPS origin.".to_string())?;
    let scheme = uri
        .scheme_str()
        .ok_or_else(|| "Secure tunnel address must start with https://.".to_string())?;
    let authority = uri
        .authority()
        .ok_or_else(|| "Secure tunnel address must include a host.".to_string())?;
    let host = authority.host();
    let loopback = matches!(host, "127.0.0.1" | "localhost" | "::1");
    if scheme != "https" && !(scheme == "http" && loopback) {
        return Err(
            "Phone pairing requires an HTTPS secure tunnel. Plain HTTP is allowed only on this computer."
                .to_string(),
        );
    }
    if uri.path() != "/" || uri.query().is_some() {
        return Err(
            "Secure tunnel address must contain only its origin, without a path or query."
                .to_string(),
        );
    }

    let port = authority
        .port_u16()
        .unwrap_or(if scheme == "https" { 443 } else { local_port });
    Ok(PairPublicTarget {
        base_url: format!("{scheme}://{authority}"),
        host: host.to_string(),
        port,
    })
}

#[tauri::command]
pub async fn bridge_devices() -> Result<Vec<BridgeDevice>, String> {
    Ok(BRIDGE_RUNTIME.pairing.list_devices())
}

#[tauri::command]
pub async fn bridge_revoke_device(device_id: String) -> Result<bool, String> {
    let runtime = BRIDGE_RUNTIME.clone();
    tokio::task::spawn_blocking(move || runtime.pairing.revoke_device(&device_id))
        .await
        .map_err(|error| format!("Failed to join mobile bridge revocation task: {error}"))?
}

#[tauri::command]
pub async fn bridge_broadcast_theme(
    app: AppThemeTokens,
    terminal: TerminalThemeTokens,
    mode: ThemeMode,
) -> Result<(), String> {
    broadcast_theme(app, terminal, mode);
    Ok(())
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

pub fn broadcast_preview<F>(card_id: &str, build_output: F)
where
    F: FnOnce() -> String,
{
    BRIDGE_RUNTIME.broadcast_preview_lazy(card_id, build_output);
}

pub fn broadcast_terminal_output(card_id: &str, data: &str, seq: u64) {
    if data.is_empty() || !BRIDGE_RUNTIME.has_subscribers() {
        return;
    }
    let bridge_card_id = BRIDGE_RUNTIME.card_id_for_pty(card_id);
    BRIDGE_RUNTIME.broadcast_terminal_frame(bridge_card_id, data.to_string(), seq);
}

pub fn broadcast_theme(app: AppThemeTokens, terminal: TerminalThemeTokens, mode: ThemeMode) {
    BRIDGE_RUNTIME.set_theme(BridgeTheme {
        app,
        terminal,
        mode,
    });
}

pub fn broadcast_state(card_id: &str, state: &SessionState) {
    let bridge_card_id = BRIDGE_RUNTIME.card_id_for_pty(card_id);
    BRIDGE_RUNTIME.broadcast(ServerMessage::State {
        card_id: bridge_card_id,
        status: TerminalStatus::from(state.clone()),
    });
}

pub fn broadcast_attention(card_id: &str, kind: &str, message: &str) {
    let bridge_card_id = BRIDGE_RUNTIME.card_id_for_pty(card_id);
    BRIDGE_RUNTIME.broadcast(ServerMessage::Attention {
        card_id: bridge_card_id,
        attention_kind: kind.to_string(),
        message: message.to_string(),
    });
}

pub fn broadcast_exit(card_id: &str, code: Option<u32>) {
    let bridge_card_id = BRIDGE_RUNTIME.card_id_for_pty(card_id);
    BRIDGE_RUNTIME.broadcast(ServerMessage::Exit {
        card_id: bridge_card_id,
        code,
    });
}

/// Broadcast that a desktop PTY session was created so connected mobile
/// clients add the card without waiting for a reconnect/snapshot. The
/// snapshot is read from the registry, so this must be called *after* the
/// session has been inserted.
pub fn broadcast_card_added(card_id: &str) {
    if !BRIDGE_RUNTIME.has_subscribers() {
        return;
    }
    let Some(snapshot) = pty::live_session_snapshot(card_id) else {
        return;
    };
    let card = BRIDGE_RUNTIME
        .mirrored_card_for_pty(card_id)
        .unwrap_or_else(|| card_meta_from_live_session(snapshot));
    BRIDGE_RUNTIME.broadcast(ServerMessage::CardAdded { card: card.clone() });
    broadcast_terminal_snapshots_for_cards(&[card]);
}

/// Broadcast that a desktop PTY session was explicitly closed (the
/// `pty_kill` path, which also covers the mobile close entry) so connected
/// mobile clients drop the card immediately. `CardRemoved` keeps the v1 full
/// `CardMeta` shape, but removal only needs identity and lightweight session
/// metadata: never serialize the terminal merely to build this event.
pub(crate) fn prepare_card_removed(
    pty_id: &str,
    state: SessionState,
    working_dir: &str,
) -> PreparedCardRemoval {
    BRIDGE_RUNTIME.prepare_card_removal(pty_id, state, working_dir)
}

pub(crate) fn broadcast_card_removed(removal: PreparedCardRemoval) {
    BRIDGE_RUNTIME.broadcast(ServerMessage::CardRemoved { card: removal.card });
}

fn card_meta_tombstone(pty_id: &str, state: SessionState, working_dir: &str) -> CardMeta {
    CardMeta {
        id: pty_id.to_string(),
        pty_id: None,
        status: TerminalStatus::from(state),
        project_path: working_dir.to_string(),
        project_name: project_name_from_path(working_dir),
        worktree_path: None,
        branch_label: None,
        terminal_type: Some("shell".to_string()),
        command: None,
        created_at: None,
        last_activity: None,
        last_reply_preview: String::new(),
        summary_line: None,
        hidden_line_count: 0,
        recent_output_bytes: 0,
        message_count: None,
        unread: None,
        provider_session_state: None,
        pty_live: false,
        pty_state: None,
        attachable: false,
    }
}

fn card_meta_from_live_session(snapshot: LivePtySessionSnapshot) -> CardMeta {
    let preview = preview_from_output(&snapshot.terminal_output);
    let project_name = project_name_from_path(&snapshot.working_dir);
    let status = TerminalStatus::from(snapshot.state);
    CardMeta {
        id: snapshot.id,
        pty_id: None,
        status: status.clone(),
        project_path: snapshot.working_dir,
        project_name,
        worktree_path: None,
        branch_label: None,
        terminal_type: Some("shell".to_string()),
        command: None,
        created_at: None,
        last_activity: None,
        last_reply_preview: preview.last_reply_preview,
        summary_line: preview.summary_line,
        hidden_line_count: preview.hidden_line_count,
        recent_output_bytes: snapshot.recent_output.len(),
        message_count: None,
        unread: None,
        provider_session_state: None,
        pty_live: true,
        pty_state: Some(status),
        attachable: true,
    }
}

pub(super) fn terminal_snapshot_message(
    runtime: &BridgeRuntime,
    card_id: &str,
) -> Option<TerminalSnapshotMessage> {
    let pty_id = runtime.pty_id_for_card(card_id);
    let snapshot = pty::attach_snapshot_for_bridge(&pty_id)?;
    let bridge_card_id = runtime.card_id_for_pty(&snapshot.pty_id);
    Some(TerminalSnapshotMessage {
        card_id: bridge_card_id,
        data: snapshot.data,
        seq: snapshot.seq,
        runtime_id: runtime.runtime_id().to_string(),
        stream_seq: runtime.current_terminal_stream_seq(),
        rows: snapshot.rows,
        cols: snapshot.cols,
        cursor_row: snapshot.cursor_row,
        cursor_col: snapshot.cursor_col,
        history: snapshot.history,
    })
}

fn broadcast_terminal_snapshots_for_cards(cards: &[CardMeta]) {
    for card in cards {
        if !card.pty_live {
            continue;
        }
        if let Some(snapshot) = terminal_snapshot_message(&BRIDGE_RUNTIME, &card.id) {
            BRIDGE_RUNTIME.broadcast(ServerMessage::TerminalSnapshot { snapshot });
        }
    }
}

fn enrich_card_with_live_state(mut card: CardMeta) -> CardMeta {
    let pty_id = card.pty_id.clone().unwrap_or_else(|| card.id.clone());
    let Some(snapshot) = pty::live_session_snapshot(&pty_id) else {
        card.pty_live = false;
        card.pty_state = None;
        return card;
    };

    let preview = preview_from_output(&snapshot.terminal_output);
    let status = TerminalStatus::from(snapshot.state);
    card.pty_id = Some(snapshot.id);
    card.status = status.clone();
    card.pty_live = true;
    card.pty_state = Some(status);
    card.recent_output_bytes = snapshot.recent_output.len();
    if !preview.last_reply_preview.is_empty() {
        card.last_reply_preview = preview.last_reply_preview;
        card.summary_line = preview.summary_line;
        card.hidden_line_count = preview.hidden_line_count;
    }
    card
}

fn project_name_from_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return "Unknown project".to_string();
    }

    Path::new(trimmed)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, sync::Mutex, time::Duration};

    /// Both bridge integration tests touch the global `BRIDGE_RUNTIME`
    /// state and bind real sockets, so they cannot run in parallel.
    /// Serialise them via a process-wide mutex.
    static BRIDGE_TEST_LOCK: Mutex<()> = Mutex::new(());

    async fn raw_http_request(port: u16, request: String) -> String {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpStream,
        };

        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect to bridge server");
        stream
            .write_all(request.as_bytes())
            .await
            .expect("write bridge HTTP request");
        stream.flush().await.expect("flush bridge HTTP request");

        let mut response = vec![0; 16 * 1024];
        let bytes_read = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut response))
            .await
            .expect("bridge HTTP response should arrive")
            .expect("read bridge HTTP response");
        response.truncate(bytes_read);
        String::from_utf8_lossy(&response).into_owned()
    }

    fn response_header(response: &str, name: &str) -> Option<String> {
        response.lines().find_map(|line| {
            let (header_name, value) = line.split_once(':')?;
            header_name
                .eq_ignore_ascii_case(name)
                .then(|| value.trim().to_string())
        })
    }

    fn assert_http_status(response: &str, code: u16) {
        assert!(
            response.starts_with(&format!("HTTP/1.1 {code} ")),
            "expected HTTP {code}, got: {}",
            response.lines().next().unwrap_or(response)
        );
    }

    #[test]
    fn project_name_uses_working_directory_leaf() {
        assert_eq!(
            project_name_from_path("/Users/me/projects/ThreadTerm"),
            "ThreadTerm"
        );
        assert_eq!(project_name_from_path(""), "Unknown project");
    }

    #[test]
    fn pairing_target_requires_https_away_from_loopback() {
        let secure = normalize_pair_public_target(Some("https://threadterm.example.ts.net"), 5174)
            .expect("HTTPS tunnel origin should be accepted");
        assert_eq!(secure.base_url, "https://threadterm.example.ts.net");
        assert_eq!(secure.host, "threadterm.example.ts.net");
        assert_eq!(secure.port, 443);

        let local = normalize_pair_public_target(None, 5174)
            .expect("local-only access should remain available");
        assert_eq!(local.base_url, "http://127.0.0.1:5174");

        assert!(
            normalize_pair_public_target(Some("http://192.168.1.42:5174"), 5174)
                .err()
                .expect("remote plaintext must be rejected")
                .contains("requires an HTTPS secure tunnel")
        );
        assert!(normalize_pair_public_target(
            Some("https://threadterm.example.ts.net/mobile?token=leak"),
            5174,
        )
        .err()
        .expect("tunnel origin must not contain a path or query")
        .contains("without a path or query"));
    }

    #[test]
    fn bridge_start_returns_after_binding() {
        let _guard = BRIDGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (tx, rx) = mpsc::channel();

        std::thread::spawn(move || {
            let runtime = tokio::runtime::Runtime::new().expect("create tokio runtime");
            let result = runtime.block_on(bridge_start(Some("127.0.0.1".to_string()), Some(0)));
            let _ = tx.send(result);
        });

        let status = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("bridge_start should not deadlock")
            .expect("bridge_start should succeed");
        assert!(status.running);

        let runtime = tokio::runtime::Runtime::new().expect("create tokio runtime");
        runtime
            .block_on(bridge_stop())
            .expect("bridge_stop should succeed");
    }

    #[test]
    fn concurrent_bridge_starts_share_the_same_server() {
        let _guard = BRIDGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let runtime = tokio::runtime::Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let _ = bridge_stop().await;

            let (first, second) = tokio::join!(
                bridge_start(Some("127.0.0.1".to_string()), Some(0)),
                bridge_start(Some("127.0.0.1".to_string()), Some(0)),
            );
            let first = first.expect("first bridge_start should succeed");
            let second = second.expect("second bridge_start should succeed");
            assert!(first.running && second.running);
            assert_eq!(first.host, second.host);
            assert_eq!(first.port, second.port);

            bridge_stop().await.expect("bridge_stop should succeed");
        });
    }

    #[test]
    fn failed_stop_keeps_managed_generation_until_retry_drains() {
        let _guard = BRIDGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let runtime = tokio::runtime::Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let _ = bridge_stop().await;
            bridge_start(Some("127.0.0.1".to_string()), Some(0))
                .await
                .expect("bridge_start should succeed");
            let activity = BRIDGE_RUNTIME
                .server
                .lock()
                .expect("bridge server state")
                .as_ref()
                .expect("bridge server handle")
                .hold_activity_for_test();

            let first_error = stop_bridge_runtime(Duration::from_millis(10))
                .await
                .expect_err("tracked work should make the first stop fail");
            assert!(first_error.contains("remained after forced cancellation"));
            assert!(bridge_status(None).await.expect("bridge status").running);
            assert!(bridge_start(Some("127.0.0.1".to_string()), Some(0))
                .await
                .expect_err("start must not replace an incompletely stopped generation")
                .contains("shutdown is incomplete"));

            drop(activity);
            let stopped = stop_bridge_runtime(Duration::from_secs(1))
                .await
                .expect("second stop should succeed after activity drains");
            assert!(!stopped.running);
        });
    }

    #[test]
    fn snapshot_requires_bearer_and_cross_origin_preflight_is_denied() {
        let _guard = BRIDGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let runtime = tokio::runtime::Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let _ = bridge_stop().await;

            let status = bridge_start(Some("127.0.0.1".to_string()), Some(0))
                .await
                .expect("bridge_start should succeed");
            let port = status.port.expect("port should be bound");

            let qr = bridge_pair_qr(Some("127.0.0.1".to_string()), None)
                .await
                .expect("pair_qr should succeed");
            let pair_response = BRIDGE_RUNTIME
                .pairing
                .pair(super::protocol::PairRequest {
                    otp: qr.otp,
                    device_name: "snapshot-auth-test".to_string(),
                    permission: None,
                })
                .expect("pairing should succeed");
            let token = pair_response.device_token;

            let preflight = raw_http_request(
                port,
                format!(
                    "OPTIONS /snapshot HTTP/1.1\r\n\
                     Host: 127.0.0.1:{port}\r\n\
                     Origin: http://192.168.1.42:5174\r\n\
                     Access-Control-Request-Method: GET\r\n\
                     Access-Control-Request-Headers: authorization,content-type\r\n\
                     Connection: close\r\n\r\n"
                ),
            )
            .await;
            assert_http_status(&preflight, 405);
            assert!(response_header(&preflight, "access-control-allow-origin").is_none());

            let missing = raw_http_request(
                port,
                format!(
                    "GET /snapshot HTTP/1.1\r\n\
                     Host: 127.0.0.1:{port}\r\n\
                     Connection: close\r\n\r\n"
                ),
            )
            .await;
            assert_http_status(&missing, 401);

            let invalid = raw_http_request(
                port,
                format!(
                    "GET /snapshot HTTP/1.1\r\n\
                     Host: 127.0.0.1:{port}\r\n\
                     Authorization: Bearer invalid-token\r\n\
                     Connection: close\r\n\r\n"
                ),
            )
            .await;
            assert_http_status(&invalid, 401);

            let bearer = raw_http_request(
                port,
                format!(
                    "GET /snapshot HTTP/1.1\r\n\
                     Host: 127.0.0.1:{port}\r\n\
                     Authorization: Bearer {token}\r\n\
                     Connection: close\r\n\r\n"
                ),
            )
            .await;
            assert_http_status(&bearer, 200);
            assert!(bearer.contains(r#""kind":"snapshot""#));

            let wrong_origin = raw_http_request(
                port,
                format!(
                    "GET /snapshot HTTP/1.1\r\n\
                     Host: 127.0.0.1:{port}\r\n\
                     Origin: https://attacker.example\r\n\
                     Authorization: Bearer {token}\r\n\
                     Connection: close\r\n\r\n"
                ),
            )
            .await;
            assert_http_status(&wrong_origin, 403);
            assert!(!wrong_origin.contains(r#""kind":"snapshot""#));

            let same_origin = raw_http_request(
                port,
                format!(
                    "GET /snapshot HTTP/1.1\r\n\
                     Host: 127.0.0.1:{port}\r\n\
                     Origin: http://127.0.0.1:{port}\r\n\
                     Authorization: Bearer {token}\r\n\
                     Connection: close\r\n\r\n"
                ),
            )
            .await;
            assert_http_status(&same_origin, 200);
            assert!(same_origin.contains(r#""kind":"snapshot""#));

            let query = raw_http_request(
                port,
                format!(
                    "GET /snapshot?token={token} HTTP/1.1\r\n\
                     Host: 127.0.0.1:{port}\r\n\
                     Connection: close\r\n\r\n"
                ),
            )
            .await;
            assert_http_status(&query, 401);
            assert!(!query.contains(r#""kind":"snapshot""#));

            bridge_stop().await.expect("bridge_stop should succeed");
        });
    }

    /// S2-1: wscat-style end-to-end test. Boots the real axum server,
    /// runs the pairing handshake, opens a websocket and confirms that
    /// wrong / missing `protocol_version` triggers
    /// `protocol_version_mismatch` while the correct version round-trips.
    #[test]
    fn websocket_rejects_protocol_version_mismatch() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        let _guard = BRIDGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let runtime = tokio::runtime::Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            // Tests share a global `BRIDGE_RUNTIME`; another test may
            // have left a stale handle pointing at a runtime that has
            // since been dropped. Tear it down first so we get a fresh
            // listener bound on _this_ runtime's reactor.
            let _ = bridge_stop().await;

            let status = bridge_start(Some("127.0.0.1".to_string()), Some(0))
                .await
                .expect("bridge_start should succeed");
            assert!(status.running);
            let port = status.port.expect("port should be bound");

            // 1. Pair through the same code-path the real mobile UI uses.
            let qr = bridge_pair_qr(Some("127.0.0.1".to_string()), None)
                .await
                .expect("pair_qr should succeed");
            let pair_response = BRIDGE_RUNTIME
                .pairing
                .pair(super::protocol::PairRequest {
                    otp: qr.otp,
                    device_name: "wscat-style-test".to_string(),
                    permission: None,
                })
                .expect("pairing should succeed");
            let token = pair_response.device_token;

            // 2. Open the websocket and authenticate in the first frame.
            let url = format!("ws://127.0.0.1:{port}/ws");
            let auth_frame = format!(r#"{{"protocol_version":1,"kind":"auth","token":"{token}"}}"#);
            let (mut ws, _) = tokio_tungstenite::connect_async(&url)
                .await
                .expect("websocket should connect");
            ws.send(Message::Text(auth_frame.clone()))
                .await
                .expect("auth frame should send");

            // Initial messages are theme first, then the current card snapshot.
            let theme = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
                .await
                .expect("theme should arrive in time")
                .expect("theme stream should not end")
                .expect("theme should be well-formed");
            let theme_text = match theme {
                Message::Text(text) => text,
                other => panic!("expected text theme, got {other:?}"),
            };
            let theme_value: serde_json::Value =
                serde_json::from_str(&theme_text).expect("theme must be JSON");
            assert_eq!(theme_value["protocol_version"], 1);
            assert_eq!(theme_value["kind"], "theme");

            let initial = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
                .await
                .expect("snapshot should arrive in time")
                .expect("snapshot stream should not end")
                .expect("snapshot should be well-formed");
            let initial_text = match initial {
                Message::Text(text) => text,
                other => panic!("expected text snapshot, got {other:?}"),
            };
            let initial_value: serde_json::Value =
                serde_json::from_str(&initial_text).expect("snapshot must be JSON");
            assert_eq!(initial_value["protocol_version"], 1);
            assert_eq!(initial_value["kind"], "snapshot");

            // 3. Wrong protocol version → `protocol_version_mismatch` error.
            ws.send(Message::Text(
                r#"{"protocol_version":2,"kind":"ping"}"#.to_string(),
            ))
            .await
            .expect("send should succeed");

            let err = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
                .await
                .expect("error response should arrive")
                .expect("ws stream should not end")
                .expect("ws message should parse");
            let err_text = match err {
                Message::Text(text) => text,
                other => panic!("expected text error, got {other:?}"),
            };
            let err_value: serde_json::Value = serde_json::from_str(&err_text).unwrap();
            assert_eq!(err_value["protocol_version"], 1);
            assert_eq!(err_value["kind"], "error");
            assert_eq!(err_value["code"], "protocol_version_mismatch");

            // The server must close the socket after rejecting a version
            // mismatch (per `handle_socket` in server.rs).
            let next = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
                .await
                .expect("close frame should arrive");
            assert!(
                matches!(next, None | Some(Ok(Message::Close(_))) | Some(Err(_))),
                "server should close after version mismatch, got {next:?}"
            );

            // 4. Reconnect with no `protocol_version` field → same error.
            let (mut ws2, _) = tokio_tungstenite::connect_async(&url)
                .await
                .expect("reconnect should succeed");
            ws2.send(Message::Text(auth_frame.clone()))
                .await
                .expect("auth frame should send on reconnect");
            // Drain initial theme + snapshot.
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), ws2.next())
                .await
                .expect("theme should arrive on reconnect");
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), ws2.next())
                .await
                .expect("snapshot should arrive on reconnect");

            ws2.send(Message::Text(r#"{"kind":"ping"}"#.to_string()))
                .await
                .expect("send should succeed");
            let err2 = tokio::time::timeout(std::time::Duration::from_secs(2), ws2.next())
                .await
                .expect("error should arrive")
                .expect("ws stream should not end")
                .expect("ws message should parse");
            let err2_text = match err2 {
                Message::Text(text) => text,
                other => panic!("expected text error, got {other:?}"),
            };
            let err2_value: serde_json::Value = serde_json::from_str(&err2_text).unwrap();
            assert_eq!(err2_value["code"], "protocol_version_mismatch");

            // 5. Correct version → `pong`.
            let (mut ws3, _) = tokio_tungstenite::connect_async(&url)
                .await
                .expect("reconnect again should succeed");
            ws3.send(Message::Text(auth_frame))
                .await
                .expect("auth frame should send on final reconnect");
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), ws3.next())
                .await
                .expect("theme should arrive again");
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), ws3.next())
                .await
                .expect("snapshot should arrive again");

            ws3.send(Message::Text(
                r#"{"protocol_version":1,"kind":"ping"}"#.to_string(),
            ))
            .await
            .expect("send should succeed");
            let pong = tokio::time::timeout(std::time::Duration::from_secs(2), ws3.next())
                .await
                .expect("pong should arrive")
                .expect("ws stream should not end")
                .expect("ws message should parse");
            let pong_text = match pong {
                Message::Text(text) => text,
                other => panic!("expected pong, got {other:?}"),
            };
            let pong_value: serde_json::Value = serde_json::from_str(&pong_text).unwrap();
            assert_eq!(pong_value["protocol_version"], 1);
            assert_eq!(pong_value["kind"], "pong");

            bridge_stop().await.expect("bridge_stop should succeed");
        });
    }

    #[test]
    fn websocket_accepts_first_frame_auth_without_query_token() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        let _guard = BRIDGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let runtime = tokio::runtime::Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let _ = bridge_stop().await;

            let status = bridge_start(Some("127.0.0.1".to_string()), Some(0))
                .await
                .expect("bridge_start should succeed");
            let port = status.port.expect("port should be bound");

            let qr = bridge_pair_qr(Some("127.0.0.1".to_string()), None)
                .await
                .expect("pair_qr should succeed");
            let pair_response = BRIDGE_RUNTIME
                .pairing
                .pair(super::protocol::PairRequest {
                    otp: qr.otp,
                    device_name: "first-frame-auth-test".to_string(),
                    permission: None,
                })
                .expect("pairing should succeed");
            let token = pair_response.device_token;

            let url = format!("ws://127.0.0.1:{port}/ws");
            let (mut ws, _) = tokio_tungstenite::connect_async(&url)
                .await
                .expect("websocket should connect without query token");

            ws.send(Message::Text(format!(
                r#"{{"protocol_version":1,"kind":"auth","token":"{token}"}}"#
            )))
            .await
            .expect("auth frame should send");

            let theme = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
                .await
                .expect("theme should arrive after auth")
                .expect("ws stream should not end")
                .expect("theme should parse");
            let theme_text = match theme {
                Message::Text(text) => text,
                other => panic!("expected text theme, got {other:?}"),
            };
            let theme_value: serde_json::Value =
                serde_json::from_str(&theme_text).expect("theme must be JSON");
            assert_eq!(theme_value["protocol_version"], 1);
            assert_eq!(theme_value["kind"], "theme");

            let initial = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
                .await
                .expect("snapshot should arrive after auth")
                .expect("ws stream should not end")
                .expect("snapshot should parse");
            let initial_text = match initial {
                Message::Text(text) => text,
                other => panic!("expected text snapshot, got {other:?}"),
            };
            let initial_value: serde_json::Value =
                serde_json::from_str(&initial_text).expect("snapshot must be JSON");
            assert_eq!(initial_value["protocol_version"], 1);
            assert_eq!(initial_value["kind"], "snapshot");

            bridge_stop().await.expect("bridge_stop should succeed");
        });
    }

    #[test]
    fn revoking_device_closes_idle_websocket() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        let _guard = BRIDGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let runtime = tokio::runtime::Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let _ = bridge_stop().await;
            let status = bridge_start(Some("127.0.0.1".to_string()), Some(0))
                .await
                .expect("bridge_start should succeed");
            let port = status.port.expect("port should be bound");
            let qr = bridge_pair_qr(Some("127.0.0.1".to_string()), None)
                .await
                .expect("pair_qr should succeed");
            let paired = BRIDGE_RUNTIME
                .pairing
                .pair(super::protocol::PairRequest {
                    otp: qr.otp,
                    device_name: "revoke-live-socket".to_string(),
                    permission: None,
                })
                .expect("pairing should succeed");

            let url = format!("ws://127.0.0.1:{port}/ws");
            let (mut ws, _) = tokio_tungstenite::connect_async(&url)
                .await
                .expect("websocket should connect");
            ws.send(Message::Text(format!(
                r#"{{"protocol_version":1,"kind":"auth","token":"{}"}}"#,
                paired.device_token
            )))
            .await
            .expect("auth frame should send");
            for label in ["theme", "snapshot"] {
                tokio::time::timeout(Duration::from_secs(2), ws.next())
                    .await
                    .unwrap_or_else(|_| panic!("{label} should arrive"))
                    .expect("websocket should stay open")
                    .expect("initial message should parse");
            }

            assert!(bridge_revoke_device(paired.device.id)
                .await
                .expect("revoke should succeed"));

            let error = tokio::time::timeout(Duration::from_secs(2), ws.next())
                .await
                .expect("revocation error should arrive")
                .expect("websocket should send an error before closing")
                .expect("revocation message should parse");
            let Message::Text(error) = error else {
                panic!("expected revocation error text");
            };
            let error: serde_json::Value =
                serde_json::from_str(&error).expect("revocation error should be JSON");
            assert_eq!(error["code"], "auth_revoked");

            let close = tokio::time::timeout(Duration::from_secs(2), ws.next())
                .await
                .expect("close frame should arrive");
            assert!(matches!(
                close,
                None | Some(Ok(Message::Close(_))) | Some(Err(_))
            ));
            bridge_stop().await.expect("bridge_stop should succeed");
        });
    }

    #[test]
    fn expired_device_closes_idle_websocket() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        let _guard = BRIDGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let runtime = tokio::runtime::Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let _ = bridge_stop().await;
            let status = bridge_start(Some("127.0.0.1".to_string()), Some(0))
                .await
                .expect("bridge_start should succeed");
            let port = status.port.expect("port should be bound");
            let qr = bridge_pair_qr(Some("127.0.0.1".to_string()), None)
                .await
                .expect("pair_qr should succeed");
            let paired = BRIDGE_RUNTIME
                .pairing
                .pair(super::protocol::PairRequest {
                    otp: qr.otp,
                    device_name: "expire-live-socket".to_string(),
                    permission: None,
                })
                .expect("pairing should succeed");

            let url = format!("ws://127.0.0.1:{port}/ws");
            let (mut ws, _) = tokio_tungstenite::connect_async(&url)
                .await
                .expect("websocket should connect");
            ws.send(Message::Text(format!(
                r#"{{"protocol_version":1,"kind":"auth","token":"{}"}}"#,
                paired.device_token
            )))
            .await
            .expect("auth frame should send");
            for _ in 0..2 {
                tokio::time::timeout(Duration::from_secs(2), ws.next())
                    .await
                    .expect("initial message should arrive")
                    .expect("websocket should stay open")
                    .expect("initial message should parse");
            }

            BRIDGE_RUNTIME.pairing.expire_device(&paired.device.id);
            let error = tokio::time::timeout(Duration::from_secs(2), ws.next())
                .await
                .expect("expiry error should arrive")
                .expect("websocket should send an error before closing")
                .expect("expiry message should parse");
            assert!(matches!(error, Message::Text(_)));
            let close = tokio::time::timeout(Duration::from_secs(2), ws.next())
                .await
                .expect("close frame should arrive");
            assert!(matches!(
                close,
                None | Some(Ok(Message::Close(_))) | Some(Err(_))
            ));
            bridge_stop().await.expect("bridge_stop should succeed");
        });
    }

    #[test]
    fn bridge_stop_closes_active_websocket_before_returning() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        let _guard = BRIDGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let runtime = tokio::runtime::Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let _ = bridge_stop().await;
            let status = bridge_start(Some("127.0.0.1".to_string()), Some(0))
                .await
                .expect("bridge_start should succeed");
            let port = status.port.expect("port should be bound");
            let qr = bridge_pair_qr(Some("127.0.0.1".to_string()), None)
                .await
                .expect("pair_qr should succeed");
            let paired = BRIDGE_RUNTIME
                .pairing
                .pair(super::protocol::PairRequest {
                    otp: qr.otp,
                    device_name: "stop-live-socket".to_string(),
                    permission: None,
                })
                .expect("pairing should succeed");

            let url = format!("ws://127.0.0.1:{port}/ws");
            let (mut ws, _) = tokio_tungstenite::connect_async(&url)
                .await
                .expect("websocket should connect");
            ws.send(Message::Text(format!(
                r#"{{"protocol_version":1,"kind":"auth","token":"{}"}}"#,
                paired.device_token
            )))
            .await
            .expect("auth frame should send");
            for _ in 0..2 {
                tokio::time::timeout(Duration::from_secs(2), ws.next())
                    .await
                    .expect("initial message should arrive")
                    .expect("websocket should stay open")
                    .expect("initial message should parse");
            }

            let status = bridge_stop().await.expect("bridge_stop should succeed");
            assert!(!status.running);

            let error = tokio::time::timeout(Duration::from_secs(2), ws.next())
                .await
                .expect("shutdown error should already be buffered")
                .expect("websocket should send an error before closing")
                .expect("shutdown message should parse");
            let Message::Text(error) = error else {
                panic!("expected bridge shutdown error text");
            };
            let error: serde_json::Value =
                serde_json::from_str(&error).expect("shutdown error should be JSON");
            assert_eq!(error["code"], "bridge_stopped");

            let close = tokio::time::timeout(Duration::from_secs(2), ws.next())
                .await
                .expect("close frame should already be buffered");
            assert!(matches!(
                close,
                None | Some(Ok(Message::Close(_))) | Some(Err(_))
            ));
        });
    }

    // ── FIX-2 (deep-research-defect-fix / second-diagnosis 问题一-D) ──────
    fn fix2_make_card(id: &str, pty_live: bool) -> CardMeta {
        CardMeta {
            id: id.to_string(),
            pty_id: Some(id.to_string()),
            status: TerminalStatus::Idle,
            project_path: "/tmp/ThreadTerm".to_string(),
            project_name: "ThreadTerm".to_string(),
            worktree_path: None,
            branch_label: None,
            terminal_type: Some("shell".to_string()),
            command: None,
            created_at: Some(1),
            last_activity: Some(2),
            last_reply_preview: String::new(),
            summary_line: None,
            hidden_line_count: 0,
            recent_output_bytes: 0,
            message_count: None,
            unread: None,
            provider_session_state: None,
            pty_live,
            pty_state: None,
            attachable: true,
        }
    }

    #[test]
    fn preview_snapshot_source_is_lazy_without_subscribers() {
        let runtime = BridgeRuntime::new();

        runtime.broadcast_preview_lazy("preview-card", || {
            panic!("preview source must not be built without a receiver")
        });
        assert_eq!(
            runtime
                .preview_snapshot_serializations
                .load(std::sync::atomic::Ordering::Relaxed),
            0
        );

        let mut rx = runtime.subscribe();
        runtime.broadcast_preview_lazy("preview-card", || "ready".to_string());
        assert_eq!(
            runtime
                .preview_snapshot_serializations
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
        assert!(matches!(
            rx.try_recv(),
            Ok(ServerMessage::Preview {
                card_id,
                last_reply_preview,
                ..
            }) if card_id == "preview-card" && last_reply_preview == "ready"
        ));
    }

    #[test]
    fn sync_cards_skips_enrichment_without_subscribers_but_keeps_mirror_current() {
        let runtime = BridgeRuntime::new();
        runtime.sync_cards(vec![fix2_make_card("sync-lazy", true)]);

        assert_eq!(
            runtime
                .snapshot_card_enrichments
                .load(std::sync::atomic::Ordering::Relaxed),
            0,
            "broadcast-only snapshot enrichment must be skipped without receivers"
        );

        // HTTP /snapshot and a newly-authenticated WebSocket call snapshot()
        // on demand, so the durable mirror must still be available.
        let snapshot = runtime.snapshot();
        assert_eq!(snapshot.cards.len(), 1);
        assert_eq!(snapshot.cards[0].id, "sync-lazy");
        assert_eq!(
            runtime
                .snapshot_card_enrichments
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
    }

    #[test]
    fn snapshot_and_mirrored_lookup_release_card_mirror_before_enriching() {
        let runtime = BridgeRuntime::new();
        runtime.sync_cards(vec![fix2_make_card("lock-scope", false)]);

        let snapshot = runtime.snapshot_with_enricher(|card| {
            assert!(
                runtime.state_mirror.try_lock().is_ok(),
                "snapshot enricher must run after state_mirror is released"
            );
            card
        });
        assert_eq!(snapshot.cards.len(), 1);

        let mirrored = runtime
            .mirrored_card_for_pty_with_enricher("lock-scope", |card| {
                assert!(
                    runtime.state_mirror.try_lock().is_ok(),
                    "mirrored-card enricher must run after state_mirror is released"
                );
                card
            })
            .expect("mirrored card should exist");
        assert_eq!(mirrored.id, "lock-scope");
    }

    #[test]
    fn sync_state_keeps_notifications_and_workbench_in_reconnect_snapshot() {
        let runtime = BridgeRuntime::new();
        let notification: NotificationEntry = serde_json::from_value(serde_json::json!({
            "id": "notification-1",
            "cardId": "state-card",
            "kind": "waiting",
            "message": "Input requested",
            "createdAt": 42,
            "title": "Waiting for input",
            "body": "Input requested",
            "read": false,
            "routing": {
                "origin": "pty",
                "family": "interaction",
                "episodeKey": "episode-1"
            }
        }))
        .expect("notification fixture should deserialize");
        let workbench: MobileWorkbenchProjection = serde_json::from_value(serde_json::json!({
            "generatedAt": 100,
            "summary": {
                "attention": 1,
                "normalRunning": 0,
                "review": 0,
                "failed": 0
            },
            "attentionItems": [],
            "executionGroups": [],
            "rules": {
                "includeWaiting": true,
                "includeFailed": true,
                "includeCompletedReview": true,
                "stalledEnabled": true,
                "stalledThresholdMinutes": 15,
                "stalledExcludedCount": 0
            },
            "capabilities": {
                "openTerminal": true,
                "respondToStructuredRequest": false,
                "updateRules": false,
                "updateNotificationReadState": false
            }
        }))
        .expect("workbench fixture should deserialize");

        runtime.sync_state(
            vec![fix2_make_card("state-card", false)],
            vec![notification],
            Some(workbench),
        );
        let snapshot = runtime.snapshot();

        assert_eq!(snapshot.cards[0].id, "state-card");
        assert_eq!(snapshot.notifications[0].id, "notification-1");
        assert_eq!(
            snapshot
                .workbench
                .as_ref()
                .map(|projection| projection.generated_at),
            Some(100)
        );
        assert!(!snapshot.warming_up);
    }

    #[test]
    fn card_removed_prefers_raw_mirror_and_tombstone_keeps_v1_shape() {
        let runtime = BridgeRuntime::new();
        let mut mirrored = fix2_make_card("desktop-card", true);
        mirrored.pty_id = Some("pty-card".to_string());
        mirrored.last_reply_preview = "preserved mirror preview".to_string();
        runtime.sync_cards(vec![mirrored]);

        let removed = runtime
            .prepare_card_removal("pty-card", SessionState::Idle, "ignored-fallback")
            .card;
        assert_eq!(removed.id, "desktop-card");
        assert_eq!(removed.last_reply_preview, "preserved mirror preview");
        assert!(!removed.pty_live);
        assert!(removed.pty_state.is_none());

        let tombstone = card_meta_tombstone("missing-pty", SessionState::Running, "C:\\repo");
        assert_eq!(tombstone.id, "missing-pty");
        assert_eq!(tombstone.project_path, "C:\\repo");
        assert!(tombstone.last_reply_preview.is_empty());
        assert_eq!(tombstone.recent_output_bytes, 0);
        assert!(!tombstone.pty_live);
        assert!(!tombstone.attachable);

        let json = serde_json::to_value(protocol::versioned_server_message(
            ServerMessage::CardRemoved { card: tombstone },
        ))
        .expect("CardRemoved tombstone should serialize");
        assert_eq!(json["protocol_version"], protocol::PROTOCOL_VERSION);
        assert_eq!(json["kind"], "card_removed");
        assert_eq!(json["card"]["id"], "missing-pty");
        assert_eq!(json["card"]["projectPath"], "C:\\repo");
    }

    #[test]
    fn sync_cards_broadcasts_snapshot_but_not_terminal_snapshots() {
        // FIX-2: card-mirror metadata sync must emit exactly one Snapshot
        // and MUST NOT re-broadcast any TerminalSnapshot (the dominant WS
        // amplification under sustained output). This holds regardless of
        // pty_live because the per-sync full re-snapshot call was removed
        // entirely; terminal_snapshot now flows only via
        // initial_messages_for_client (connect/reconnect/Lagged) and
        // broadcast_card_added (single-card add).
        let _guard = BRIDGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut rx = BRIDGE_RUNTIME.subscribe();

        BRIDGE_RUNTIME.sync_cards(vec![
            fix2_make_card("fix2-a", true),
            fix2_make_card("fix2-b", false),
        ]);

        let mut snapshot_count = 0;
        let mut terminal_snapshot_count = 0;
        while let Ok(message) = rx.try_recv() {
            match message {
                ServerMessage::Snapshot { .. } => snapshot_count += 1,
                ServerMessage::TerminalSnapshot { .. } => terminal_snapshot_count += 1,
                _ => {}
            }
        }

        assert_eq!(
            snapshot_count, 1,
            "sync_cards must broadcast exactly one Snapshot"
        );
        assert_eq!(
            terminal_snapshot_count, 0,
            "FIX-2: sync_cards must NOT re-broadcast TerminalSnapshot"
        );
    }
}
