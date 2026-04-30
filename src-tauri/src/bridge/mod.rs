pub mod protocol;

mod pairing;
mod server;

use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use regex::Regex;
use tokio::sync::broadcast;

use crate::pty::{self, LivePtySessionSnapshot, SessionState};

use pairing::PairingStore;
use protocol::{
    BridgeDevice, BridgeSnapshot, BridgeStatus, CardMeta, PairQrResponse, ServerMessage,
    TerminalStatus,
};

const DEFAULT_BRIDGE_HOST: &str = "127.0.0.1";
const DEFAULT_BRIDGE_PORT: u16 = 5174;
const PREVIEW_MAX_LINES: usize = 8;
const PREVIEW_CHANNEL_CAPACITY: usize = 1024;

static ANSI_STRIP: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[()][A-Za-z0-9])")
        .expect("invalid bridge ansi regex")
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

#[tauri::command]
pub async fn bridge_start(host: Option<String>, port: Option<u16>) -> Result<BridgeStatus, String> {
    let runtime = BRIDGE_RUNTIME.clone();

    let already_running = {
        runtime
            .server
            .lock()
            .map_err(|e| format!("Bridge state unavailable: {e}"))?
            .is_some()
    };
    if already_running {
        return Ok(runtime.status());
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

pub fn broadcast_preview(card_id: &str, output: &str) {
    let (last_reply_preview, hidden_line_count) = preview_from_output(output);
    if last_reply_preview.is_empty() {
        return;
    }

    BRIDGE_RUNTIME.broadcast(ServerMessage::Preview {
        card_id: card_id.to_string(),
        last_reply_preview,
        hidden_line_count,
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
    let (last_reply_preview, hidden_line_count) = preview_from_output(&snapshot.recent_output);
    CardMeta {
        id: snapshot.id,
        status: TerminalStatus::from(snapshot.state),
        last_reply_preview,
        hidden_line_count,
        recent_output_bytes: snapshot.recent_output.len(),
    }
}

fn preview_from_output(output: &str) -> (String, usize) {
    let cleaned = ANSI_STRIP.replace_all(output, "");
    let lines: Vec<String> = cleaned
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.chars().take(240).collect::<String>())
        .collect();

    let hidden_line_count = lines.len().saturating_sub(PREVIEW_MAX_LINES);
    let preview = lines
        .iter()
        .skip(hidden_line_count)
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");

    (preview, hidden_line_count)
}

fn public_host_for_url(host: &str) -> String {
    match host {
        "0.0.0.0" | "::" => "127.0.0.1".to_string(),
        value => value.to_string(),
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

    #[test]
    fn preview_strips_ansi_and_reports_hidden_lines() {
        let input = "\x1b[31mone\x1b[0m\n\n two \nthree\nfour\nfive\nsix\nseven\neight\nnine\n";
        let (preview, hidden) = preview_from_output(input);

        assert_eq!(hidden, 1);
        assert!(!preview.contains("\x1b"));
        assert!(preview.starts_with("two"));
        assert!(preview.ends_with("nine"));
    }

    #[test]
    fn wildcard_bind_host_uses_loopback_for_display_url() {
        assert_eq!(public_host_for_url("0.0.0.0"), "127.0.0.1");
        assert_eq!(public_host_for_url("192.168.1.2"), "192.168.1.2");
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
