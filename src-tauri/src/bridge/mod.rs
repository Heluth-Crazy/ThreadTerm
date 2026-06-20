pub mod protocol;

mod pairing;
mod server;

use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    path::Path,
    process::Command,
    sync::{Arc, Mutex},
};

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::Emitter;
use tokio::sync::broadcast;

use crate::pty::{self, LivePtySessionSnapshot, SessionState};

use pairing::PairingStore;
use protocol::{
    AppThemeTokens, BridgeDevice, BridgeSnapshot, BridgeStatus, BridgeTheme, CardMeta,
    MobileCardRequest, MobileRenameCardRequest, MobileSpawnCardRequest, PairQrResponse,
    ServerMessage,
    TerminalSnapshotMessage, TerminalStatus, TerminalThemeTokens, ThemeMode,
};

const DEFAULT_BRIDGE_HOST: &str = "127.0.0.1";
const DEFAULT_BRIDGE_PORT: u16 = 5174;
const PREVIEW_MAX_LINES: usize = 8;
const PREVIEW_CHANNEL_CAPACITY: usize = 1024;
const BRIDGE_ENABLED_SETTING: &str = "mobile_bridge.enabled";
const BRIDGE_HOST_SETTING: &str = "mobile_bridge.host";
const BRIDGE_PORT_SETTING: &str = "mobile_bridge.port";

static ANSI_STRIP: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[()][A-Za-z0-9])")
        .expect("invalid bridge ansi regex")
});
static CONTROL_STRIP: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]").expect("invalid bridge control regex")
});

pub static BRIDGE_RUNTIME: Lazy<Arc<BridgeRuntime>> = Lazy::new(|| Arc::new(BridgeRuntime::new()));

pub struct BridgeRuntime {
    tx: broadcast::Sender<ServerMessage>,
    pub pairing: PairingStore,
    theme: Mutex<BridgeTheme>,
    server: Mutex<Option<server::BridgeServerHandle>>,
    app_handle: Mutex<Option<tauri::AppHandle>>,
    card_mirror: Mutex<Vec<CardMeta>>,
    card_mirror_initialized: Mutex<bool>,
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
            card_mirror: Mutex::new(Vec::new()),
            card_mirror_initialized: Mutex::new(false),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerMessage> {
        self.tx.subscribe()
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
        let initialized = self
            .card_mirror_initialized
            .lock()
            .map(|value| *value)
            .unwrap_or(false);
        if !initialized {
            return BridgeSnapshot {
                cards: Vec::new(),
                notifications: Vec::new(),
                warming_up: true,
            };
        }

        let cards = self
            .card_mirror
            .lock()
            .map(|cards| {
                cards
                    .iter()
                    .cloned()
                    .map(enrich_card_with_live_state)
                    .collect()
            })
            .unwrap_or_default();

        BridgeSnapshot {
            cards,
            notifications: Vec::new(),
            warming_up: false,
        }
    }

    pub fn sync_cards(&self, cards: Vec<CardMeta>) {
        if let Ok(mut mirror) = self.card_mirror.lock() {
            *mirror = cards;
        }
        if let Ok(mut initialized) = self.card_mirror_initialized.lock() {
            *initialized = true;
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
        self.card_mirror
            .lock()
            .ok()
            .and_then(|cards| {
                cards
                    .iter()
                    .find(|card| card.id == card_id)
                    .and_then(|card| card.pty_id.clone())
            })
            .unwrap_or_else(|| card_id.to_string())
    }

    pub fn card_id_for_pty(&self, pty_id: &str) -> String {
        self.card_mirror
            .lock()
            .ok()
            .and_then(|cards| {
                cards
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
        self.card_mirror.lock().ok().and_then(|cards| {
            cards
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
                .map(enrich_card_with_live_state)
        })
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

    pub fn emit_rename_card_request(
        &self,
        request: MobileRenameCardRequest,
    ) -> Result<(), String> {
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
                url: Some(format!("http://{}:{port}", public_host_for_url(&host))),
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
    let enabled = crate::db::get_setting(BRIDGE_ENABLED_SETTING)
        .ok()
        .flatten()
        .map(|value| value == "true")
        .unwrap_or(false);
    if !enabled {
        return;
    }

    let host = crate::db::get_setting(BRIDGE_HOST_SETTING)
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BRIDGE_HOST.to_string());
    let port = crate::db::get_setting(BRIDGE_PORT_SETTING)
        .ok()
        .flatten()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_BRIDGE_PORT);

    tauri::async_runtime::spawn(async move {
        match start_bridge_runtime(Some(host), Some(port), true).await {
            Ok(status) => {
                tracing::info!(
                    host = ?status.host,
                    port = ?status.port,
                    "Mobile bridge restored from settings"
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
    let runtime = BRIDGE_RUNTIME.clone();

    let already_running = {
        runtime
            .server
            .lock()
            .map_err(|e| format!("Bridge state unavailable: {e}"))?
            .is_some()
    };
    if already_running {
        let status = runtime.status();
        if persist_enabled {
            persist_bridge_running(&status);
        }
        return Ok(status);
    }

    let bind_host = host
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BRIDGE_HOST.to_string());
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
    let runtime = BRIDGE_RUNTIME.clone();
    let handle = runtime
        .server
        .lock()
        .map_err(|e| format!("Bridge state unavailable: {e}"))?
        .take();

    if let Some(mut handle) = handle {
        if let Some(shutdown) = handle.shutdown.take() {
            let _ = shutdown.send(());
        }
    }

    if !cfg!(test) {
        if let Err(error) = crate::db::set_setting(BRIDGE_ENABLED_SETTING, "false") {
            tracing::debug!(error = %error, "Failed to persist mobile bridge stopped state");
        }
    }

    Ok(runtime.status())
}

#[tauri::command]
pub async fn bridge_status() -> Result<BridgeStatus, String> {
    Ok(BRIDGE_RUNTIME.status())
}

#[tauri::command]
pub async fn bridge_pair_qr(host: Option<String>) -> Result<PairQrResponse, String> {
    let status = BRIDGE_RUNTIME.status();
    let port = status.port.unwrap_or(DEFAULT_BRIDGE_PORT);
    let pair_host = host
        .filter(|value| !value.trim().is_empty())
        .or(status.host)
        .map(|value| public_host_for_url(&value))
        .unwrap_or_else(|| "127.0.0.1".to_string());

    Ok(BRIDGE_RUNTIME.pairing.create_pair_qr(pair_host, port))
}

#[tauri::command]
pub async fn bridge_devices() -> Result<Vec<BridgeDevice>, String> {
    Ok(BRIDGE_RUNTIME.pairing.list_devices())
}

#[tauri::command]
pub async fn bridge_revoke_device(device_id: String) -> Result<bool, String> {
    Ok(BRIDGE_RUNTIME.pairing.revoke_device(&device_id))
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

pub fn broadcast_preview(card_id: &str, output: &str) {
    let preview = preview_from_output(output);
    if preview.last_reply_preview.is_empty() {
        return;
    }
    let bridge_card_id = BRIDGE_RUNTIME.card_id_for_pty(card_id);

    BRIDGE_RUNTIME.broadcast(ServerMessage::Preview {
        card_id: bridge_card_id,
        last_reply_preview: preview.last_reply_preview,
        summary_line: preview.summary_line,
        hidden_line_count: preview.hidden_line_count,
    });
}

pub fn broadcast_terminal_output(card_id: &str, data: &str, seq: u64) {
    if data.is_empty() {
        return;
    }
    let bridge_card_id = BRIDGE_RUNTIME.card_id_for_pty(card_id);

    BRIDGE_RUNTIME.broadcast(ServerMessage::TerminalOutput {
        card_id: bridge_card_id,
        data: data.to_string(),
        seq,
    });
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
/// mobile clients drop the card immediately. The caller must pass a
/// snapshot taken *before* the session left the registry, because the
/// protocol requires a full `CardMeta` and the mobile reducer keys removal
/// on `card.id`.
pub fn broadcast_card_removed(snapshot: LivePtySessionSnapshot) {
    let pty_id = snapshot.id.clone();
    let card = BRIDGE_RUNTIME
        .mirrored_card_for_pty(&pty_id)
        .unwrap_or_else(|| card_meta_from_live_session(snapshot));
    BRIDGE_RUNTIME.broadcast(ServerMessage::CardRemoved { card });
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

pub(super) fn terminal_snapshot_message(card_id: &str) -> Option<TerminalSnapshotMessage> {
    let pty_id = BRIDGE_RUNTIME.pty_id_for_card(card_id);
    let snapshot = pty::attach_snapshot_for_bridge(&pty_id)?;
    let bridge_card_id = BRIDGE_RUNTIME.card_id_for_pty(&snapshot.pty_id);
    Some(TerminalSnapshotMessage {
        card_id: bridge_card_id,
        data: snapshot.data,
        seq: snapshot.seq,
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
        if let Some(snapshot) = terminal_snapshot_message(&card.id) {
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

#[derive(Debug, PartialEq, Eq)]
struct BridgePreview {
    last_reply_preview: String,
    summary_line: Option<String>,
    hidden_line_count: usize,
}

fn preview_from_output(output: &str) -> BridgePreview {
    let ansi_cleaned = ANSI_STRIP.replace_all(output, "");
    let control_cleaned = CONTROL_STRIP.replace_all(&ansi_cleaned, "");
    let newline_cleaned = control_cleaned.replace('\r', "\n");
    let all_lines: Vec<String> = newline_cleaned
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.chars().take(240).collect::<String>())
        .collect();
    let composer_stripped_lines = strip_trailing_ai_composer_region(&all_lines);
    let source_lines = if composer_stripped_lines.is_empty() {
        all_lines
    } else {
        composer_stripped_lines
    };
    let filtered_lines: Vec<String> = source_lines
        .iter()
        .filter(|line| !is_mobile_preview_noise_line(line))
        .cloned()
        .collect();
    let lines = if filtered_lines.is_empty() {
        source_lines
    } else {
        filtered_lines
    };
    let lines = dedupe_preview_lines(lines);

    let hidden_line_count = lines.len().saturating_sub(PREVIEW_MAX_LINES);
    let visible_lines = lines
        .iter()
        .skip(hidden_line_count)
        .cloned()
        .collect::<Vec<_>>();
    let summary_line = summary_line_from_preview_lines(&visible_lines);

    BridgePreview {
        last_reply_preview: visible_lines.join("\n"),
        summary_line,
        hidden_line_count,
    }
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

fn strip_trailing_ai_composer_region(lines: &[String]) -> Vec<String> {
    let mut end = lines.len();
    let mut saw_composer_chrome = false;

    while end > 0 && is_ai_composer_chrome_line(&lines[end - 1]) {
        saw_composer_chrome = true;
        end -= 1;
    }

    let mut removed_composer_input = false;
    while end > 0 && is_ai_composer_input_line(&lines[end - 1], saw_composer_chrome) {
        removed_composer_input = true;
        saw_composer_chrome = true;
        end -= 1;
    }

    if removed_composer_input {
        while end > 0 && is_ai_composer_chrome_line(&lines[end - 1]) {
            end -= 1;
        }
    }

    lines[..end].to_vec()
}

fn is_ai_composer_chrome_line(line: &str) -> bool {
    let normalized = line.trim();
    normalized.is_empty() || is_mobile_preview_noise_line(normalized)
}

fn is_ai_composer_input_line(line: &str, saw_composer_chrome: bool) -> bool {
    let normalized = line.trim();
    let Some(first) = normalized.chars().next() else {
        return false;
    };

    matches!(first, '›' | '❯' | '▸' | '▹' | '▶' | '➤')
        || (saw_composer_chrome && normalized.starts_with("> "))
}

fn dedupe_preview_lines(lines: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for line in lines {
        let duplicate = out
            .last()
            .map(|previous: &String| preview_signature(previous) == preview_signature(&line))
            .unwrap_or(false);
        if !duplicate {
            out.push(line);
        }
    }
    out
}

fn preview_signature(line: &str) -> String {
    line.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn summary_line_from_preview_lines(lines: &[String]) -> Option<String> {
    lines.iter().rev().find_map(|line| {
        let trimmed = line.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn is_mobile_preview_noise_line(line: &str) -> bool {
    let normalized = line.trim();
    let lower = normalized.to_lowercase();

    lower.contains("trellis sessionstart")
        || lower.contains("hooks need review before they can run")
        || lower.contains("open /hooks to review")
        || lower.contains("mcp startup incomplete")
        || lower.contains("mcp client for")
        || lower.contains("starting mcp")
        || lower.contains("mcp servers")
        || (lower.contains("tip:") && lower.contains("/fast"))
        || normalized.starts_with('›')
}

fn public_host_for_url(host: &str) -> String {
    match host {
        "0.0.0.0" | "::" => lan_ipv4_for_url().unwrap_or_else(|| "127.0.0.1".to_string()),
        value => value.to_string(),
    }
}

fn lan_ipv4_for_url() -> Option<String> {
    physical_adapter_ipv4_for_url()
        .or_else(default_route_ipv4_for_url)
        .or_else(udp_route_ipv4_for_url)
}

#[cfg(target_os = "windows")]
fn physical_adapter_ipv4_for_url() -> Option<String> {
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
Get-NetAdapter | ForEach-Object {
  $adapter = $_
  $metric = (Get-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 | Select-Object -First 1 -ExpandProperty InterfaceMetric)
  Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 | ForEach-Object {
    "{0}`t{1}`t{2}`t{3}`t{4}`t{5}`t{6}" -f $_.IPAddress,$adapter.Status,$adapter.HardwareInterface,$adapter.Virtual,$metric,$adapter.Name,$adapter.InterfaceDescription
  }
}
"#;

    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    windows_physical_adapter_ipv4_from_tsv(&stdout)
}

#[cfg(not(target_os = "windows"))]
fn physical_adapter_ipv4_for_url() -> Option<String> {
    None
}

#[cfg(any(test, target_os = "windows"))]
fn windows_physical_adapter_ipv4_from_tsv(output: &str) -> Option<String> {
    let mut candidates = Vec::new();
    for (index, line) in output.lines().enumerate() {
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 7 {
            continue;
        }

        let status = fields[1].trim();
        let hardware_interface = fields[2];
        let virtual_adapter = fields[3];
        let metric = fields[4].trim().parse::<u32>().unwrap_or(u32::MAX);
        let alias = fields[5];
        let description = fields[6];

        if !status.eq_ignore_ascii_case("up")
            || !windows_bool(hardware_interface)
            || windows_bool(virtual_adapter)
            || looks_like_windows_virtual_adapter(alias, description)
        {
            continue;
        }

        let Ok(ip) = fields[0].trim().parse::<Ipv4Addr>() else {
            continue;
        };
        if !lan_ipv4_candidate(ip) {
            continue;
        }

        candidates.push((metric, index, ip));
    }

    candidates.sort_by_key(|(metric, index, _)| (*metric, *index));
    candidates
        .into_iter()
        .next()
        .map(|(_, _, ip)| ip.to_string())
}

#[cfg(any(test, target_os = "windows"))]
fn windows_bool(value: &str) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "true" | "1")
}

#[cfg(any(test, target_os = "windows"))]
fn looks_like_windows_virtual_adapter(alias: &str, description: &str) -> bool {
    const VIRTUAL_ADAPTER_KEYWORDS: &[&str] = &[
        "vpn",
        "tun",
        "tap",
        "wintun",
        "wireguard",
        "tailscale",
        "zerotier",
        "virtual",
        "vmware",
        "virtualbox",
        "hyper-v",
        "loopback",
        "docker",
        "wsl",
    ];

    let combined = format!("{alias} {description}").to_ascii_lowercase();
    VIRTUAL_ADAPTER_KEYWORDS
        .iter()
        .any(|keyword| combined.contains(keyword))
}

#[cfg(target_os = "macos")]
fn default_route_ipv4_for_url() -> Option<String> {
    let output = Command::new("route")
        .args(["-n", "get", "default"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    let interface = stdout.lines().find_map(|line| {
        let line = line.trim();
        line.strip_prefix("interface:").map(str::trim)
    })?;
    interface_ipv4_for_url(interface)
}

#[cfg(not(target_os = "macos"))]
fn default_route_ipv4_for_url() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn interface_ipv4_for_url(interface: &str) -> Option<String> {
    let output = Command::new("ifconfig").arg(interface).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    stdout.lines().find_map(|line| {
        let trimmed = line.trim();
        let ip = trimmed.strip_prefix("inet ")?.split_whitespace().next()?;
        lan_ipv4_candidate(ip.parse().ok()?).then(|| ip.to_string())
    })
}

fn udp_route_ipv4_for_url() -> Option<String> {
    let socket = UdpSocket::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0))).ok()?;
    socket
        .connect(SocketAddr::from((Ipv4Addr::new(8, 8, 8, 8), 80)))
        .ok()?;
    let local_addr = socket.local_addr().ok()?;
    match local_addr.ip() {
        IpAddr::V4(ip) if lan_ipv4_candidate(ip) => Some(ip.to_string()),
        _ => None,
    }
}

fn lan_ipv4_candidate(ip: Ipv4Addr) -> bool {
    !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local() && !ip.is_broadcast()
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
    fn preview_strips_ansi_and_reports_hidden_lines() {
        let input = "\x1b[31mone\x1b[0m\n\n two \nthree\nfour\nfive\nsix\nseven\neight\nnine\n";
        let preview = preview_from_output(input);

        assert_eq!(preview.hidden_line_count, 1);
        assert_eq!(preview.summary_line.as_deref(), Some("nine"));
        assert!(!preview.last_reply_preview.contains("\x1b"));
        assert!(preview.last_reply_preview.starts_with("two"));
        assert!(preview.last_reply_preview.ends_with("nine"));
    }

    #[test]
    fn preview_filters_mobile_bridge_noise() {
        let input = [
            "• Trellis SessionStart injected: workflow loaded",
            "MCP client for `pencil` failed to start",
            "Open /hooks to review them.",
            "Real assistant response line",
            "› Summarize recent commits",
        ]
        .join("\n");
        let preview = preview_from_output(&input);

        assert_eq!(preview.hidden_line_count, 0);
        assert_eq!(preview.last_reply_preview, "Real assistant response line");
        assert_eq!(
            preview.summary_line.as_deref(),
            Some("Real assistant response line")
        );
    }

    #[test]
    fn preview_keeps_output_when_every_line_matches_noise_filter() {
        let input = "MCP startup incomplete\n› waiting for input\n";
        let preview = preview_from_output(input);

        assert_eq!(preview.hidden_line_count, 0);
        assert!(preview
            .last_reply_preview
            .contains("MCP startup incomplete"));
        assert!(preview.last_reply_preview.contains("waiting for input"));
    }

    #[test]
    fn preview_summary_ignores_trailing_ai_composer_prompt() {
        let input = "Here is the answer.\nIt is safe to continue.\n› Summarize recent commits\n";
        let preview = preview_from_output(input);

        assert_eq!(
            preview.summary_line.as_deref(),
            Some("It is safe to continue.")
        );
        assert!(!preview
            .last_reply_preview
            .contains("Summarize recent commits"));
    }

    #[test]
    fn preview_deduplicates_repeated_mobile_lines() {
        let input = "收到，测试消息正常。\n收到，测试消息正常。\n下一步继续。\n";
        let preview = preview_from_output(input);

        assert_eq!(
            preview.last_reply_preview,
            "收到，测试消息正常。\n下一步继续。"
        );
        assert_eq!(preview.summary_line.as_deref(), Some("下一步继续。"));
    }

    #[test]
    fn preview_preserves_lines_split_across_output_chunks_when_source_is_cumulative() {
        // Mirrors the bridge path where emit_pty_output_chunk previews the
        // terminal snapshot/cumulative output, not just the latest raw chunk.
        let first_chunk = "Building pack";
        let second_chunk = "age\nDone\n";
        let cumulative = format!("{first_chunk}{second_chunk}");
        let latest_chunk_only = preview_from_output(second_chunk);
        let preview = preview_from_output(&cumulative);

        assert_eq!(latest_chunk_only.summary_line.as_deref(), Some("Done"));
        assert_eq!(preview.last_reply_preview, "Building package\nDone");
        assert_eq!(preview.summary_line.as_deref(), Some("Done"));
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
    fn wildcard_bind_host_uses_lan_ip_for_display_url() {
        let display_host = public_host_for_url("0.0.0.0");

        assert_ne!(display_host, "0.0.0.0");
        assert_ne!(display_host, "172.18.0.1");
        assert!(display_host.parse::<Ipv4Addr>().is_ok());
        assert_eq!(public_host_for_url("192.168.1.2"), "192.168.1.2");
    }

    #[test]
    fn lan_ipv4_candidate_rejects_non_lan_addresses() {
        assert!(!lan_ipv4_candidate(Ipv4Addr::new(127, 0, 0, 1)));
        assert!(!lan_ipv4_candidate(Ipv4Addr::new(0, 0, 0, 0)));
        assert!(!lan_ipv4_candidate(Ipv4Addr::new(169, 254, 1, 2)));
        assert!(!lan_ipv4_candidate(Ipv4Addr::new(255, 255, 255, 255)));
        assert!(lan_ipv4_candidate(Ipv4Addr::new(192, 168, 1, 67)));
    }

    #[test]
    fn windows_physical_adapter_parser_skips_virtual_and_tunnel_adapters() {
        let output = [
            "100.88.1.10\tUp\tFalse\tTrue\t1\tTailscale\tTailscale Tunnel",
            "172.28.144.1\tUp\tTrue\tTrue\t5\tvEthernet (WSL)\tHyper-V Virtual Ethernet Adapter",
            "10.8.0.2\tUp\tTrue\tFalse\t10\tWireGuard Tunnel\tWireGuard Tunnel",
            "192.168.1.67\tUp\tTrue\tFalse\t25\tWi-Fi\tIntel(R) Wi-Fi 6 AX201",
        ]
        .join("\n");

        assert_eq!(
            windows_physical_adapter_ipv4_from_tsv(&output).as_deref(),
            Some("192.168.1.67")
        );
    }

    #[test]
    fn windows_physical_adapter_parser_prefers_lower_interface_metric() {
        let output = [
            "192.168.1.67\tUp\tTrue\tFalse\t50\tWi-Fi\tIntel(R) Wi-Fi 6 AX201",
            "10.0.0.12\tUp\tTrue\tFalse\t10\tEthernet\tRealtek PCIe GbE Family Controller",
        ]
        .join("\n");

        assert_eq!(
            windows_physical_adapter_ipv4_from_tsv(&output).as_deref(),
            Some("10.0.0.12")
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
    fn snapshot_auth_paths_and_cors_preflight_are_compatible_and_restricted() {
        let _guard = BRIDGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let runtime = tokio::runtime::Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let _ = bridge_stop().await;

            let status = bridge_start(Some("127.0.0.1".to_string()), Some(0))
                .await
                .expect("bridge_start should succeed");
            let port = status.port.expect("port should be bound");

            let qr = bridge_pair_qr(Some("127.0.0.1".to_string()))
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
            assert!(
                preflight.starts_with("HTTP/1.1 200 ") || preflight.starts_with("HTTP/1.1 204 "),
                "expected successful preflight, got: {}",
                preflight.lines().next().unwrap_or(&preflight)
            );
            assert_eq!(
                response_header(&preflight, "access-control-allow-origin").as_deref(),
                Some("*")
            );
            let methods = response_header(&preflight, "access-control-allow-methods")
                .expect("CORS allow-methods header")
                .to_ascii_uppercase();
            assert!(methods.contains("GET"));
            assert!(methods.contains("POST"));
            assert!(!methods.contains("DELETE"));
            let headers = response_header(&preflight, "access-control-allow-headers")
                .expect("CORS allow-headers header")
                .to_ascii_lowercase();
            assert!(headers.contains("authorization"));
            assert!(headers.contains("content-type"));

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

            let query = raw_http_request(
                port,
                format!(
                    "GET /snapshot?token={token} HTTP/1.1\r\n\
                     Host: 127.0.0.1:{port}\r\n\
                     Connection: close\r\n\r\n"
                ),
            )
            .await;
            assert_http_status(&query, 200);
            assert!(query.contains(r#""kind":"snapshot""#));

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
            let qr = bridge_pair_qr(Some("127.0.0.1".to_string()))
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

            // 2. Open the websocket with the device token.
            let url = format!("ws://127.0.0.1:{port}/ws?token={token}");
            let (mut ws, _) = tokio_tungstenite::connect_async(&url)
                .await
                .expect("websocket should connect");

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

            let qr = bridge_pair_qr(Some("127.0.0.1".to_string()))
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

    // ── FIX-2 (deep-research-defect-fix / second-diagnosis 问题一-D) ──────
    fn fix2_make_card(id: &str, pty_live: bool) -> CardMeta {
        CardMeta {
            id: id.to_string(),
            pty_id: Some(id.to_string()),
            status: TerminalStatus::Idle,
            project_path: "/tmp/ThreadTerm".to_string(),
            project_name: "ThreadTerm".to_string(),
            worktree_path: None,
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
