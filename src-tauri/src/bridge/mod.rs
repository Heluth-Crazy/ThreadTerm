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
    use std::{sync::mpsc, time::Duration};

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
}
