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
use tokio::sync::broadcast;

use crate::pty::{self, LivePtySessionSnapshot, SessionState};

use pairing::PairingStore;
use protocol::{
    BridgeDevice, BridgeSnapshot, BridgeStatus, CardMeta, PairQrResponse, ServerMessage,
    TerminalSnapshotMessage, TerminalStatus,
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
    server: Mutex<Option<server::BridgeServerHandle>>,
}

impl BridgeRuntime {
    fn new() -> Self {
        let (tx, _) = broadcast::channel(PREVIEW_CHANNEL_CAPACITY);
        Self {
            tx,
            pairing: PairingStore::default(),
            server: Mutex::new(None),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerMessage> {
        self.tx.subscribe()
    }

    pub fn broadcast(&self, message: ServerMessage) {
        let _ = self.tx.send(message);
    }

    pub fn snapshot(&self) -> BridgeSnapshot {
        BridgeSnapshot {
            cards: pty::list_live_sessions()
                .into_iter()
                .map(card_meta_from_live_session)
                .collect(),
            notifications: Vec::new(),
        }
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

#[tauri::command]
pub async fn bridge_start(host: Option<String>, port: Option<u16>) -> Result<BridgeStatus, String> {
    start_bridge_runtime(host, port, !cfg!(test)).await
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

    BRIDGE_RUNTIME.broadcast(ServerMessage::Preview {
        card_id: card_id.to_string(),
        last_reply_preview: preview.last_reply_preview,
        summary_line: preview.summary_line,
        hidden_line_count: preview.hidden_line_count,
    });
}

pub fn broadcast_terminal_output(card_id: &str, data: &str, seq: u64) {
    if data.is_empty() {
        return;
    }

    BRIDGE_RUNTIME.broadcast(ServerMessage::TerminalOutput {
        card_id: card_id.to_string(),
        data: data.to_string(),
        seq,
    });
}

pub fn broadcast_state(card_id: &str, state: &SessionState) {
    BRIDGE_RUNTIME.broadcast(ServerMessage::State {
        card_id: card_id.to_string(),
        status: TerminalStatus::from(state.clone()),
    });
}

pub fn broadcast_attention(card_id: &str, kind: &str, message: &str) {
    BRIDGE_RUNTIME.broadcast(ServerMessage::Attention {
        card_id: card_id.to_string(),
        attention_kind: kind.to_string(),
        message: message.to_string(),
    });
}

pub fn broadcast_exit(card_id: &str, code: Option<u32>) {
    BRIDGE_RUNTIME.broadcast(ServerMessage::Exit {
        card_id: card_id.to_string(),
        code,
    });
}

fn card_meta_from_live_session(snapshot: LivePtySessionSnapshot) -> CardMeta {
    let preview = preview_from_output(&snapshot.terminal_output);
    let project_name = project_name_from_path(&snapshot.working_dir);
    CardMeta {
        id: snapshot.id,
        status: TerminalStatus::from(snapshot.state),
        project_path: snapshot.working_dir,
        project_name,
        last_reply_preview: preview.last_reply_preview,
        summary_line: preview.summary_line,
        hidden_line_count: preview.hidden_line_count,
        recent_output_bytes: snapshot.recent_output.len(),
    }
}

pub(super) fn terminal_snapshot_message(card_id: &str) -> Option<TerminalSnapshotMessage> {
    let snapshot = pty::attach_snapshot_for_bridge(card_id)?;
    Some(TerminalSnapshotMessage {
        card_id: snapshot.pty_id,
        data: snapshot.data,
        seq: snapshot.seq,
        rows: snapshot.rows,
        cols: snapshot.cols,
        cursor_row: snapshot.cursor_row,
        cursor_col: snapshot.cursor_col,
        history: snapshot.history,
    })
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
    default_route_ipv4_for_url().or_else(udp_route_ipv4_for_url)
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
    use std::{sync::Mutex, sync::mpsc, time::Duration};

    /// Both bridge integration tests touch the global `BRIDGE_RUNTIME`
    /// state and bind real sockets, so they cannot run in parallel.
    /// Serialise them via a process-wide mutex.
    static BRIDGE_TEST_LOCK: Mutex<()> = Mutex::new(());

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
        assert!(
            preview
                .last_reply_preview
                .contains("MCP startup incomplete")
        );
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
        assert!(
            !preview
                .last_reply_preview
                .contains("Summarize recent commits")
        );
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

            // First message should be the initial snapshot.
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
            // Drain the initial snapshot.
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
}
