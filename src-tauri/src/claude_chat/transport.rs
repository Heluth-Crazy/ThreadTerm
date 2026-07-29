use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

use super::manager::{PendingMap, CLAUDE_CHAT_MANAGER};
use super::protocol::{self, classify_line, SidecarLine};

const STDERR_RING_CAPACITY: usize = 64 * 1024;

pub(super) async fn write_line(
    stdin: std::sync::Arc<Mutex<ChildStdin>>,
    line: String,
) -> Result<(), String> {
    let mut guard = stdin.lock().await;
    guard
        .write_all(line.as_bytes())
        .await
        .map_err(|err| format!("Failed to write to Claude sidecar: {err}"))?;
    guard
        .flush()
        .await
        .map_err(|err| format!("Failed to flush Claude sidecar stdin: {err}"))
}

pub(super) async fn read_stdout(app: AppHandle, stdout: ChildStdout, pending: PendingMap) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => handle_sidecar_line(&app, &pending, line).await,
            Ok(None) => {
                CLAUDE_CHAT_MANAGER
                    .handle_disconnect(app, "Claude sidecar disconnected".to_string())
                    .await;
                break;
            }
            Err(err) => {
                CLAUDE_CHAT_MANAGER
                    .handle_disconnect(app, format!("Claude sidecar read failed: {err}"))
                    .await;
                break;
            }
        }
    }
}

pub(super) async fn read_stderr(stderr: ChildStderr, ring: std::sync::Arc<Mutex<String>>) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::debug!(target: "claude_chat", stderr = %line, "Claude sidecar stderr");
        let mut ring = ring.lock().await;
        ring.push_str(&line);
        ring.push('\n');
        trim_stderr_ring(&mut ring, STDERR_RING_CAPACITY);
    }
}

/// Trim the ring to `capacity` bytes from the front without ever cutting a
/// UTF-8 code point in half (String::drain panics on a non-boundary index).
fn trim_stderr_ring(ring: &mut String, capacity: usize) {
    if ring.len() <= capacity {
        return;
    }
    let mut cut = ring.len() - capacity;
    while cut < ring.len() && !ring.is_char_boundary(cut) {
        cut += 1;
    }
    ring.drain(..cut);
}

async fn handle_sidecar_line(app: &AppHandle, pending: &PendingMap, line: String) {
    match classify_line(&line) {
        SidecarLine::Response { id, result } => {
            if let Some(tx) = pending.lock().await.remove(&id) {
                let _ = tx.send(result);
            }
        }
        SidecarLine::Event { ev, raw } => {
            if ev == protocol::EV_HOST_FATAL {
                let message = raw
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Claude sidecar reported a fatal error")
                    .to_owned();
                CLAUDE_CHAT_MANAGER
                    .handle_disconnect(app.clone(), message)
                    .await;
                return;
            }
            if ev == "session.status" {
                if let (Some(card_id), Some(session_id)) = (
                    raw.get("cardId").and_then(Value::as_str),
                    raw.get("sessionId").and_then(Value::as_str),
                ) {
                    CLAUDE_CHAT_MANAGER
                        .note_card_session(card_id, session_id)
                        .await;
                }
            }
            let event_name = if ev == protocol::EV_SESSION_REQUEST
                || ev == protocol::EV_SESSION_REQUEST_CANCELLED
            {
                protocol::REQUEST_EVENT
            } else {
                protocol::EVENT_EVENT
            };
            let _ = app.emit(event_name, raw);
        }
        SidecarLine::Malformed(reason) => {
            tracing::warn!(target: "claude_chat", line = %line, reason = %reason, "Ignored malformed sidecar line");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stderr_ring_trims_on_char_boundaries() {
        // 4-byte emoji straddling the cut point must not panic.
        let mut ring = "😀".repeat(10);
        trim_stderr_ring(&mut ring, 10);
        assert!(ring.len() <= 12);
        assert!(ring.chars().all(|c| c == '😀'));

        let mut ascii = "abcdef".to_string();
        trim_stderr_ring(&mut ascii, 4);
        assert_eq!(ascii, "cdef");

        let mut small = "ab".to_string();
        trim_stderr_ring(&mut small, 4);
        assert_eq!(small, "ab");
    }
}
