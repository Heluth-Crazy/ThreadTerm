pub mod protocol;

mod authz;
mod commands;
mod identity;
mod network;
mod pairing;
mod preview;
mod projection;
mod runtime;
mod secure_server;
mod server;
mod workspace_adapter;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use once_cell::sync::{Lazy, OnceCell};
use rand::{distributions::Alphanumeric, Rng};
use tauri::Emitter;
use tokio::sync::broadcast;

use crate::pty::{self, SessionState};

use identity::{fingerprint_short, SecureIdentityStatus, SecureIdentityStore};
use pairing::PairingStore;
use preview::preview_from_output;
#[cfg(test)]
use projection::card_meta_tombstone;
use projection::{card_meta_from_live_session, terminal_snapshot_message, BridgeStateMirror};
use protocol::{
    AppThemeTokens, BridgeDevice, BridgeStatus, BridgeTheme, CardMeta, DevicePermission,
    MobileCardRequest, MobileCloseRequest, MobileCloseResolution, MobileRenameCardRequest,
    MobileSpawnCardRequest, MobileWorkbenchProjection, NotificationEntry, PairQrResponse,
    ServerMessage, TerminalStatus, TerminalThemeTokens, ThemeMode,
};
use runtime::load_or_create_bridge_server_id;
#[cfg(test)]
use runtime::stop_bridge_runtime;

const PREVIEW_CHANNEL_CAPACITY: usize = 1024;

pub static BRIDGE_RUNTIME: Lazy<Arc<BridgeRuntime>> = Lazy::new(|| Arc::new(BridgeRuntime::new()));

static SECURE_IDENTITY_DIR: OnceCell<PathBuf> = OnceCell::new();

/// Configure the managed-state directory used for the secure bridge identity.
/// Must be called once during app startup before enabling the secure listener.
pub fn configure_secure_identity_dir(state_dir: PathBuf) {
    let _ = SECURE_IDENTITY_DIR.set(state_dir);
}

pub(crate) fn secure_identity_store() -> SecureIdentityStore {
    let dir = SECURE_IDENTITY_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("threadterm-bridge-identity"));
    SecureIdentityStore::new(dir)
}

pub struct BridgeRuntime {
    tx: broadcast::Sender<ServerMessage>,
    pub pairing: PairingStore,
    theme: Mutex<BridgeTheme>,
    server: Mutex<Option<server::BridgeServerHandle>>,
    secure_server: Mutex<Option<secure_server::SecureServerHandle>>,
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
            secure_server: Mutex::new(None),
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

    pub(crate) fn runtime_id(&self) -> &str {
        &self.runtime_id
    }

    pub(crate) fn server_id(&self) -> &str {
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

    pub fn emit_remove_request(&self, request: MobileCloseRequest) -> Result<(), String> {
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
        let legacy = self.server.lock().ok().and_then(|guard| {
            guard
                .as_ref()
                .map(|handle| (handle.host.clone(), handle.port))
        });
        let secure = self.secure_server.lock().ok().and_then(|guard| {
            guard.as_ref().map(|handle| {
                (
                    handle.host.clone(),
                    handle.port,
                    handle.fingerprint_sha256.clone(),
                    handle.computer_id.clone(),
                )
            })
        });
        let identity_status = secure_identity_store().status();
        let (identity_status_wire, fingerprint_short_opt, computer_id_opt) = match &identity_status
        {
            SecureIdentityStatus::Ready {
                computer_id,
                fingerprint_sha256,
                recovered_backup: _,
                ..
            } => (
                Some(identity_status.as_wire().to_string()),
                Some(fingerprint_short(fingerprint_sha256)),
                Some(computer_id.clone()),
            ),
            SecureIdentityStatus::IdentityError { .. } => {
                (Some("identity_error".to_string()), None, None)
            }
            SecureIdentityStatus::Missing => (Some("missing".to_string()), None, None),
        };

        match (legacy, secure) {
            (Some((host, port)), Some((secure_host, secure_port, _fp, computer_id))) => {
                BridgeStatus {
                    running: true,
                    url: Some(format!("http://{host}:{port}")),
                    host: Some(host),
                    port: Some(port),
                    secure_running: Some(true),
                    secure_host: Some(secure_host.clone()),
                    secure_port: Some(secure_port),
                    secure_endpoint: Some(format!("wss://{secure_host}:{secure_port}")),
                    identity_status: identity_status_wire,
                    fingerprint_short: fingerprint_short_opt,
                    computer_id: Some(computer_id),
                }
            }
            (Some((host, port)), None) => BridgeStatus {
                running: true,
                url: Some(format!("http://{host}:{port}")),
                host: Some(host),
                port: Some(port),
                secure_running: Some(false),
                secure_host: None,
                secure_port: None,
                secure_endpoint: None,
                identity_status: identity_status_wire,
                fingerprint_short: fingerprint_short_opt,
                computer_id: computer_id_opt,
            },
            (None, Some((secure_host, secure_port, _fp, computer_id))) => BridgeStatus {
                running: false,
                host: None,
                port: None,
                url: None,
                secure_running: Some(true),
                secure_host: Some(secure_host.clone()),
                secure_port: Some(secure_port),
                secure_endpoint: Some(format!("wss://{secure_host}:{secure_port}")),
                identity_status: identity_status_wire,
                fingerprint_short: fingerprint_short_opt,
                computer_id: Some(computer_id),
            },
            (None, None) => BridgeStatus {
                running: false,
                host: None,
                port: None,
                url: None,
                secure_running: Some(false),
                secure_host: None,
                secure_port: None,
                secure_endpoint: None,
                identity_status: identity_status_wire,
                fingerprint_short: fingerprint_short_opt,
                computer_id: computer_id_opt,
            },
        }
    }
}

pub fn restore_bridge_on_startup() {
    runtime::restore_bridge_on_startup();
}

pub fn set_app_handle(app_handle: tauri::AppHandle) {
    runtime::set_app_handle(app_handle);
}

#[tauri::command]
pub async fn bridge_start(host: Option<String>, port: Option<u16>) -> Result<BridgeStatus, String> {
    commands::start(host, port).await
}

#[tauri::command]
pub async fn bridge_sync_cards(cards: Vec<CardMeta>) -> Result<(), String> {
    commands::sync_cards(cards).await
}

#[tauri::command]
pub async fn bridge_sync_state(
    cards: Vec<CardMeta>,
    notifications: Vec<NotificationEntry>,
    workbench: Option<MobileWorkbenchProjection>,
) -> Result<(), String> {
    commands::sync_state(cards, notifications, workbench).await
}

#[tauri::command]
pub async fn bridge_resolve_mobile_spawn(
    request_id: String,
    ok: bool,
    card_id: Option<String>,
    error_code: Option<String>,
    message: Option<String>,
) -> Result<(), String> {
    commands::resolve_spawn(request_id, ok, card_id, error_code, message).await
}

#[tauri::command]
pub async fn bridge_resolve_mobile_activate(
    request_id: String,
    ok: bool,
    card_id: Option<String>,
    error_code: Option<String>,
    message: Option<String>,
) -> Result<(), String> {
    commands::resolve_activate(request_id, ok, card_id, error_code, message).await
}

#[tauri::command]
pub async fn bridge_resolve_mobile_close(result: MobileCloseResolution) -> Result<(), String> {
    commands::resolve_close(result).await
}

#[tauri::command]
pub async fn bridge_resolve_mobile_rename_card(
    request_id: String,
    ok: bool,
    card_id: Option<String>,
    error_code: Option<String>,
    message: Option<String>,
) -> Result<(), String> {
    commands::resolve_rename_card(request_id, ok, card_id, error_code, message).await
}

#[tauri::command]
pub async fn bridge_stop() -> Result<BridgeStatus, String> {
    commands::stop().await
}

#[tauri::command]
pub async fn bridge_status(_refresh: Option<bool>) -> Result<BridgeStatus, String> {
    commands::status(_refresh).await
}

#[tauri::command]
pub async fn bridge_has_subscribers() -> Result<bool, String> {
    commands::has_subscribers().await
}

#[tauri::command]
pub async fn bridge_pair_qr(
    public_url: Option<String>,
    permission: Option<DevicePermission>,
) -> Result<PairQrResponse, String> {
    commands::pair_qr(public_url, permission).await
}

#[tauri::command]
pub async fn bridge_secure_pair_qr(
    permission: Option<DevicePermission>,
) -> Result<protocol::SecurePairQrResponse, String> {
    commands::secure_pair_qr(permission).await
}

#[tauri::command]
pub async fn bridge_start_secure(port: Option<u16>) -> Result<BridgeStatus, String> {
    commands::start_secure(port).await
}

#[tauri::command]
pub async fn bridge_stop_secure() -> Result<BridgeStatus, String> {
    commands::stop_secure().await
}

#[tauri::command]
pub async fn bridge_rotate_secure_identity() -> Result<BridgeStatus, String> {
    commands::rotate_identity().await
}

#[tauri::command]
pub async fn bridge_devices() -> Result<Vec<BridgeDevice>, String> {
    commands::devices().await
}

#[tauri::command]
pub async fn bridge_revoke_device(device_id: String) -> Result<bool, String> {
    commands::revoke_device(device_id).await
}

#[tauri::command]
pub async fn bridge_broadcast_theme(
    app: AppThemeTokens,
    terminal: TerminalThemeTokens,
    mode: ThemeMode,
) -> Result<(), String> {
    commands::publish_theme(app, terminal, mode).await
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
    #[ignore = "Playwright launches this real bridge fixture explicitly"]
    fn browser_e2e_fixture_server() {
        use std::{
            env, fs,
            path::PathBuf,
            time::{Duration, Instant},
        };

        let fixture_dir = PathBuf::from(
            env::var("THREADTERM_REAL_BRIDGE_FIXTURE_DIR")
                .expect("THREADTERM_REAL_BRIDGE_FIXTURE_DIR must be set"),
        );
        fs::create_dir_all(&fixture_dir).expect("create real bridge fixture directory");
        let descriptor_path = fixture_dir.join("descriptor.json");
        let stop_path = fixture_dir.join("stop");
        let disconnect_path = fixture_dir.join("disconnect");
        let disconnected_path = fixture_dir.join("disconnected");
        let resume_path = fixture_dir.join("resume");
        let resumed_path = fixture_dir.join("resumed");

        let _guard = BRIDGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let runtime = tokio::runtime::Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let _ = bridge_stop().await;
            let status = bridge_start(Some("127.0.0.1".to_string()), Some(0))
                .await
                .expect("start real browser bridge fixture");
            let port = status.port.expect("real browser bridge fixture port");

            let mut card = fix2_make_card("real-browser-card", false);
            card.last_reply_preview = "Real bridge browser fixture".to_string();
            card.summary_line = Some("Real bridge browser fixture".to_string());
            BRIDGE_RUNTIME.sync_cards(vec![card]);

            let pair_qr =
                bridge_pair_qr(Some("127.0.0.1".to_string()), Some(DevicePermission::Full))
                    .await
                    .expect("create browser pairing code");
            let descriptor = serde_json::json!({
                "pairUrl": pair_qr.url,
                "serverId": BRIDGE_RUNTIME.server_id(),
                "port": port,
                "cardName": "ThreadTerm",
                "disconnectPath": disconnect_path,
                "disconnectedPath": disconnected_path,
                "resumePath": resume_path,
                "resumedPath": resumed_path,
                "recoveredPreview": "Recovered state from the real bridge",
            });
            let pending_descriptor_path = fixture_dir.join("descriptor.json.tmp");
            fs::write(
                &pending_descriptor_path,
                serde_json::to_vec(&descriptor).expect("serialize real bridge descriptor"),
            )
            .expect("write real bridge descriptor");
            fs::rename(&pending_descriptor_path, &descriptor_path)
                .expect("publish real bridge descriptor");

            let deadline = Instant::now() + Duration::from_secs(180);
            let mut disconnected = false;
            let mut resumed = false;
            while !stop_path.exists() && Instant::now() < deadline {
                if !disconnected && disconnect_path.exists() {
                    bridge_stop()
                        .await
                        .expect("disconnect real browser bridge fixture");
                    fs::write(&disconnected_path, "disconnected")
                        .expect("acknowledge real bridge disconnect");
                    disconnected = true;
                }
                if disconnected && !resumed && resume_path.exists() {
                    let mut recovered_card = fix2_make_card("real-browser-card", false);
                    recovered_card.last_reply_preview =
                        "Recovered state from the real bridge".to_string();
                    recovered_card.summary_line =
                        Some("Recovered state from the real bridge".to_string());
                    BRIDGE_RUNTIME.sync_cards(vec![recovered_card]);

                    let resumed_status = bridge_start(Some("127.0.0.1".to_string()), Some(port))
                        .await
                        .expect("resume real browser bridge fixture");
                    assert_eq!(resumed_status.port, Some(port));
                    fs::write(&resumed_path, "resumed").expect("acknowledge real bridge resume");
                    resumed = true;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }

            bridge_stop()
                .await
                .expect("stop real browser bridge fixture");
        });
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
                "episodeKey": "episode-1",
                "signalSource": "agent_cli_prompt",
                "confidence": "compatible"
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
        let notification_json = serde_json::to_value(&snapshot.notifications[0])
            .expect("notification should serialize");
        assert_eq!(
            notification_json["routing"]["signalSource"],
            "agent_cli_prompt"
        );
        assert_eq!(notification_json["routing"]["confidence"], "compatible");
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
