use crate::service_child::{spawn_managed_service_child, ManagedServiceChild};
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

use super::owner::{self, SessionOwner};
use super::{probe, protocol, transport};

const RESPONSE_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_SPAWN_BACKOFF: Duration = Duration::from_secs(30);

type PendingRequest = oneshot::Sender<Result<Value, String>>;
pub(super) type PendingMap = std::sync::Arc<Mutex<HashMap<u64, PendingRequest>>>;

pub(super) static CLAUDE_CHAT_MANAGER: Lazy<ClaudeChatManager> =
    Lazy::new(ClaudeChatManager::default);

#[derive(Default)]
pub(super) struct ClaudeChatManager {
    state: Mutex<ClaudeChatState>,
}

#[derive(Default)]
struct ClaudeChatState {
    child: Option<ManagedServiceChild>,
    stdin: Option<std::sync::Arc<Mutex<ChildStdin>>>,
    pending: PendingMap,
    next_id: u64,
    last_error: Option<String>,
    card_sessions: HashMap<String, String>,
    spawn_failures: u32,
    last_spawn_attempt: Option<Instant>,
    stderr_ring: std::sync::Arc<Mutex<String>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeChatDisconnectedPayload {
    message: String,
}

impl ClaudeChatManager {
    /// Stop the shared host and release every card/session owner during app
    /// shutdown. This is idempotent and intentionally does not try to send a
    /// protocol request: the event loop is already closing, so terminating the
    /// managed process tree is the authoritative final boundary.
    pub(super) async fn shutdown(&self) {
        let (mut child, pending, card_sessions) = {
            let mut state = self.state.lock().await;
            state.stdin = None;
            state.last_error = None;
            (
                state.child.take(),
                state.pending.clone(),
                std::mem::take(&mut state.card_sessions),
            )
        };

        for (card_id, session_id) in card_sessions {
            owner::release(&session_id, &SessionOwner::Chat { card_id });
        }
        let pending = std::mem::take(&mut *pending.lock().await);
        for (_, sender) in pending {
            let _ = sender.send(Err("Claude sidecar stopped during app shutdown".to_string()));
        }
        if let Some(child) = child.as_mut() {
            child.terminate();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        }
    }

    async fn ensure_process(&self, app: &AppHandle) -> Result<(), String> {
        let mut state = self.state.lock().await;
        if state.stdin.is_some() {
            return Ok(());
        }

        if let Some(last_attempt) = state.last_spawn_attempt {
            let backoff = spawn_backoff(state.spawn_failures);
            let elapsed = last_attempt.elapsed();
            if state.spawn_failures > 0 && elapsed < backoff {
                let wait = backoff - elapsed;
                return Err(format!(
                    "Claude sidecar restart is backing off; retry in {}s",
                    wait.as_secs().max(1)
                ));
            }
        }
        state.last_spawn_attempt = Some(Instant::now());

        let script = sidecar_script_path(app)?;
        let mut command = Command::new(probe::node_program());
        command
            .arg(&script)
            .env("THREADTERM_CLAUDE_PATH", probe::claude_executable())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(feature = "stats-proxy")]
        for (key, value) in crate::stats::proxy::prepare_env("claude", None).await? {
            command.env(key, value);
        }

        let mut child = match spawn_managed_service_child(command) {
            Ok(child) => child,
            Err(err) => {
                state.spawn_failures = state.spawn_failures.saturating_add(1);
                let message = format!("Failed to start Claude sidecar: {err}");
                state.last_error = Some(message.clone());
                return Err(message);
            }
        };

        let stdin = child
            .stdin()
            .take()
            .ok_or_else(|| "Claude sidecar stdin is unavailable".to_string())?;
        let stdout = child
            .stdout()
            .take()
            .ok_or_else(|| "Claude sidecar stdout is unavailable".to_string())?;
        let stderr = child.stderr().take();

        let pending = state.pending.clone();
        let app_for_stdout = app.clone();
        tokio::spawn(async move {
            transport::read_stdout(app_for_stdout, stdout, pending).await;
        });
        if let Some(stderr) = stderr {
            let ring = state.stderr_ring.clone();
            tokio::spawn(async move {
                transport::read_stderr(stderr, ring).await;
            });
        }

        state.child = Some(child);
        state.stdin = Some(std::sync::Arc::new(Mutex::new(stdin)));
        state.last_error = None;
        Ok(())
    }

    /// `spawn_if_needed` is true only for entry points that legitimately boot
    /// the sidecar (start, history). Everything else must not resurrect a dead
    /// sidecar as a side effect — an interrupt/stop aimed at a crashed process
    /// has nothing to talk to.
    pub(super) async fn send_request(
        &self,
        app: &AppHandle,
        op: &str,
        params: Value,
        spawn_if_needed: bool,
    ) -> Result<Value, String> {
        if spawn_if_needed {
            self.ensure_process(app).await?;
        }
        let (id, stdin, pending) = {
            let mut state = self.state.lock().await;
            let stdin = state
                .stdin
                .as_ref()
                .cloned()
                .ok_or_else(|| "Claude sidecar is not running".to_string())?;
            state.next_id = state.next_id.saturating_add(1);
            (state.next_id, stdin, state.pending.clone())
        };

        let mut request = match params {
            Value::Object(map) => map,
            Value::Null => Map::new(),
            other => {
                return Err(format!("sidecar request params must be an object: {other}"));
            }
        };
        request.insert("id".into(), json!(id));
        request.insert("op".into(), json!(op));
        let line = format!("{}\n", Value::Object(request));

        let (tx, rx) = oneshot::channel();
        pending.lock().await.insert(id, tx);
        if let Err(err) = transport::write_line(stdin, line).await {
            pending.lock().await.remove(&id);
            return Err(err);
        }

        match tokio::time::timeout(RESPONSE_TIMEOUT, rx).await {
            Ok(Ok(response)) => {
                if response.is_ok() {
                    // A crash-then-respawn loop must keep escalating its
                    // backoff, so health only resets on a served request —
                    // not on a spawn that might die moments later.
                    self.mark_healthy().await;
                }
                response
            }
            Ok(Err(_)) => Err("Claude sidecar response channel closed".to_string()),
            Err(_) => {
                pending.lock().await.remove(&id);
                Err(format!("Claude sidecar request `{op}` timed out"))
            }
        }
    }

    async fn mark_healthy(&self) {
        let mut state = self.state.lock().await;
        if state.spawn_failures != 0 {
            state.spawn_failures = 0;
        }
    }

    pub(super) async fn register_card_session(&self, card_id: String, session_id: String) {
        let mut state = self.state.lock().await;
        state.card_sessions.insert(card_id, session_id);
    }

    pub(super) async fn unregister_card_session(&self, card_id: &str) {
        let mut state = self.state.lock().await;
        if let Some(session_id) = state.card_sessions.remove(card_id) {
            owner::release(
                &session_id,
                &SessionOwner::Chat {
                    card_id: card_id.to_owned(),
                },
            );
        }
    }

    /// The reader saw the bound session id for a card (`session.status ready`).
    /// This is where a fresh session gets claimed and where a resume rotation
    /// (design P0-2) moves the owner claim from the old id to the new one.
    pub(super) async fn note_card_session(&self, card_id: &str, session_id: &str) {
        let previous = {
            let mut state = self.state.lock().await;
            let previous = state.card_sessions.get(card_id).cloned();
            state
                .card_sessions
                .insert(card_id.to_owned(), session_id.to_owned());
            previous
        };
        if previous.as_deref() == Some(session_id) {
            return;
        }
        let chat_owner = SessionOwner::Chat {
            card_id: card_id.to_owned(),
        };
        if let Err(existing) = owner::rebind(previous.as_deref(), session_id, chat_owner) {
            tracing::warn!(
                target: "claude_chat",
                card_id,
                session_id,
                existing = %owner::describe(&existing),
                "Session owner rebind conflict on rotated id"
            );
        }
    }

    pub(super) async fn handle_disconnect(&self, app: AppHandle, message: String) {
        let (pending_map, card_sessions) = {
            let mut state = self.state.lock().await;
            state.child = None;
            state.stdin = None;
            state.spawn_failures = state.spawn_failures.saturating_add(1);
            state.last_error = Some(message.clone());
            let sessions = std::mem::take(&mut state.card_sessions);
            (state.pending.clone(), sessions)
        };
        for (card_id, session_id) in card_sessions {
            owner::release(&session_id, &SessionOwner::Chat { card_id });
        }
        let pending = std::mem::take(&mut *pending_map.lock().await);
        for (_, tx) in pending {
            let _ = tx.send(Err(message.clone()));
        }
        let _ = app.emit(
            protocol::DISCONNECTED_EVENT,
            ClaudeChatDisconnectedPayload { message },
        );
    }
}

fn spawn_backoff(failures: u32) -> Duration {
    let exp = failures.min(5);
    Duration::from_secs(1u64 << exp).min(MAX_SPAWN_BACKOFF)
}

fn sidecar_script_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(overridden) = std::env::var("THREADTERM_CLAUDE_SIDECAR") {
        let path = PathBuf::from(overridden);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!(
            "THREADTERM_CLAUDE_SIDECAR points to a missing file: {}",
            path.display()
        ));
    }
    if let Ok(resource) = app
        .path()
        .resolve("sidecar/claude-host.mjs", BaseDirectory::Resource)
    {
        if resource.exists() {
            return Ok(resource);
        }
    }
    // Dev fallback: depending on how the backend was launched the working
    // directory is either the repository root (npm scripts) or src-tauri/
    // (`tauri dev` running cargo), so try both in-tree locations.
    for candidate in [
        "sidecar/claude-host/dist/claude-host.mjs",
        "../sidecar/claude-host/dist/claude-host.mjs",
    ] {
        let path = PathBuf::from(candidate);
        if path.exists() {
            return Ok(path);
        }
    }
    Err("Claude sidecar script not found (build it with `npm run build:sidecar`)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_backoff_escalates_and_caps() {
        assert_eq!(spawn_backoff(0), Duration::from_secs(1));
        assert_eq!(spawn_backoff(1), Duration::from_secs(2));
        assert_eq!(spawn_backoff(4), Duration::from_secs(16));
        assert_eq!(spawn_backoff(5), MAX_SPAWN_BACKOFF);
        assert_eq!(spawn_backoff(50), MAX_SPAWN_BACKOFF);
    }

    #[tokio::test]
    async fn empty_shutdown_is_idempotent() {
        let manager = ClaudeChatManager::default();
        manager.shutdown().await;
        manager.shutdown().await;
    }
}
