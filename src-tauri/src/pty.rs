use dashmap::DashMap;
use dashmap::mapref::entry::Entry;
use once_cell::sync::Lazy;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use regex::RegexSet;
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Window};
use tokio::sync::broadcast;
use tauri_plugin_notification::NotificationExt;

// ── Session state machine ────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub enum SessionState {
    Idle,
    Running,
    WaitingForInput,
    Completed,
    Failed,
}

// ── Regex patterns (compiled once) ───────────────────────────────────────────

static WAITING_PATTERNS: Lazy<RegexSet> = Lazy::new(|| {
    RegexSet::new([
        r"(?i)\[y/n\]",
        r"(?i)\(y/n\)",
        r"(?i)press enter",
        r"(?i)permission",
        r"(?i)approve",
        r"(?i)allow",
        r"(?i)do you want",
        r"(?i)continue\?",
    ])
    .expect("invalid waiting regex")
});

static ERROR_PATTERNS: Lazy<RegexSet> = Lazy::new(|| {
    RegexSet::new([
        r"(?i)\berror\b",
        r"(?i)\bfailed\b",
        r"(?i)permission denied",
        r"(?i)command not found",
    ])
    .expect("invalid error regex")
});

static ANSI_STRIP: Lazy<regex::Regex> = Lazy::new(|| {
    regex::Regex::new(r"\x1b\[[0-9;]*[a-zA-Z]").expect("invalid ansi regex")
});

// ── Global session map ───────────────────────────────────────────────────────

/// Global map of active PTY sessions.
static PTY_SESSIONS: Lazy<DashMap<String, Arc<PtySession>>> = Lazy::new(DashMap::new);

/// Broadcast channels for WebSocket subscribers (web/mobile mode).
/// Maps session ID → broadcast::Sender so HTTP WS clients can receive PTY output.
static PTY_WS_BROADCAST: Lazy<DashMap<String, broadcast::Sender<String>>> =
    Lazy::new(DashMap::new);

/// Represents a live PTY session.
/// All interior-mutable fields are protected by Mutex so the struct is Sync.
struct PtySession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    _working_dir: String,
    state: RwLock<SessionState>,
    app_handle: tauri::AppHandle,
    /// Circular buffer of the last 200 lines of output (for handoff context).
    output_buffer: RwLock<Vec<String>>,
}

const OUTPUT_BUFFER_MAX_LINES: usize = 200;

// Safety: every non-Sync field is behind a Mutex / RwLock.
unsafe impl Sync for PtySession {}

// ── Event payloads ───────────────────────────────────────────────────────────

/// Payload emitted on `pty-output` events.
#[derive(Clone, Serialize)]
struct PtyOutputPayload {
    id: String,
    data: String,
}

/// Payload emitted on `pty-exit` events.
#[derive(Clone, Serialize)]
struct PtyExitPayload {
    id: String,
    code: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStateChangedPayload {
    pty_id: String,
    state: SessionState,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttentionRequiredPayload {
    pty_id: String,
    session_id: String,
    #[serde(rename = "type")]
    attention_type: String,
    message: String,
}

/// Update session state and emit `session-state-changed` if changed.
fn set_session_state(session: &PtySession, id: &str, new_state: SessionState) {
    if let Ok(mut state) = session.state.write() {
        if *state != new_state {
            *state = new_state.clone();
            let _ = session.app_handle.emit(
                "session-state-changed",
                SessionStateChangedPayload {
                    pty_id: id.to_string(),
                    state: new_state,
                },
            );
        }
    }
}

/// Returns the default shell for the current platform.
fn default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        if which_exists("powershell.exe") {
            "powershell.exe".to_string()
        } else {
            "cmd.exe".to_string()
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if std::path::Path::new("/bin/zsh").exists() {
            "/bin/zsh".to_string()
        } else {
            "/bin/bash".to_string()
        }
    }
}

#[cfg(target_os = "windows")]
fn which_exists(name: &str) -> bool {
    std::process::Command::new("where")
        .arg(name)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Create a new PTY session and begin streaming output.
#[tauri::command]
pub async fn pty_create(
    id: String,
    working_dir: String,
    rows: u16,
    cols: u16,
    window: Window,
) -> Result<String, String> {
    let pty_system = NativePtySystem::default();

    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&working_dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("FORCE_COLOR", "3");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;

    // Drop the slave so reads on master detect EOF when the child exits.
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    let session = Arc::new(PtySession {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        _working_dir: working_dir,
        state: RwLock::new(SessionState::Running),
        app_handle: window.app_handle().clone(),
        output_buffer: RwLock::new(Vec::with_capacity(OUTPUT_BUFFER_MAX_LINES)),
    });

    let session_for_stream = session.clone();
    match PTY_SESSIONS.entry(id.clone()) {
        Entry::Occupied(_) => {
            if let Ok(mut c) = session.child.lock() {
                let _ = c.kill();
            }
            return Err(format!("PTY session '{}' already exists", id));
        }
        Entry::Vacant(e) => {
            e.insert(session);
        }
    }

    // Spawn a background thread to read PTY output and emit events.
    let stream_id = id.clone();
    let handle = window.app_handle().clone();
    std::thread::spawn(move || {
        stream_pty_output(stream_id, reader, session_for_stream, handle);
    });

    tracing::info!(id = %id, shell = %shell, "PTY session created");
    Ok(id)
}

/// Background reader: reads chunks from the PTY and emits Tauri events.
fn stream_pty_output(
    id: String,
    mut reader: Box<dyn Read + Send>,
    session: Arc<PtySession>,
    app_handle: AppHandle,
) {
    let mut buf = [0u8; 8192];
    let mut last_attention_time = Instant::now() - Duration::from_secs(60);
    let attention_debounce = Duration::from_secs(5);

    loop {
        match reader.read(&mut buf) {
            Ok(0) => break, // EOF – child exited
            Ok(n) => {
                let data = String::from_utf8_lossy(&buf[..n]).to_string();
                let _ = app_handle.emit(
                    "pty-output",
                    PtyOutputPayload {
                        id: id.clone(),
                        data: data.clone(),
                    },
                );

                // Relay to WebSocket subscribers (web/mobile mode)
                if let Some(tx) = PTY_WS_BROADCAST.get(&id) {
                    let payload = serde_json::json!({ "type": "pty-output", "id": id, "data": data }).to_string();
                    let _ = tx.send(payload);
                }

                // Append to output buffer (keep last OUTPUT_BUFFER_MAX_LINES lines)
                if let Ok(mut buf) = session.output_buffer.write() {
                    for line in data.lines() {
                        if buf.len() >= OUTPUT_BUFFER_MAX_LINES {
                            buf.remove(0);
                        }
                        buf.push(line.to_string());
                    }
                }

                // Strip ANSI escape codes for pattern matching
                let cleaned = ANSI_STRIP.replace_all(&data, "");

                // Detect waiting-for-input patterns
                if WAITING_PATTERNS.is_match(&cleaned) {
                    let already_waiting = session
                        .state
                        .read()
                        .ok()
                        .map(|s| *s == SessionState::WaitingForInput)
                        .unwrap_or(false);

                    if !already_waiting {
                        set_session_state(&session, &id, SessionState::WaitingForInput);
                    }

                    if last_attention_time.elapsed() > attention_debounce {
                        last_attention_time = Instant::now();
                        let _ = app_handle.emit(
                            "attention-required",
                            AttentionRequiredPayload {
                                pty_id: id.clone(),
                                session_id: id.clone(),
                                attention_type: "waiting".to_string(),
                                message: "Agent needs your input".to_string(),
                            },
                        );
                        let _ = session
                            .app_handle
                            .notification()
                            .builder()
                            .title("Agent Needs Attention")
                            .body(format!("Session {} needs your input", &id))
                            .show();
                    }
                }

                // Detect error patterns (emit attention but don't change state to Failed)
                if ERROR_PATTERNS.is_match(&cleaned) {
                    if last_attention_time.elapsed() > attention_debounce {
                        last_attention_time = Instant::now();
                        let _ = app_handle.emit(
                            "attention-required",
                            AttentionRequiredPayload {
                                pty_id: id.clone(),
                                session_id: id.clone(),
                                attention_type: "error".to_string(),
                                message: "Agent encountered an error".to_string(),
                            },
                        );
                    }
                }
            }
            Err(e) => {
                tracing::warn!(id = %id, error = %e, "PTY read error");
                break;
            }
        }
    }

    // Determine exit code and update state.
    let code = session
        .child
        .lock()
        .ok()
        .and_then(|mut child| {
            child.wait().ok().map(|status| {
                if status.success() { 0u32 } else { 1u32 }
            })
        });

    match code {
        Some(0) => set_session_state(&session, &id, SessionState::Completed),
        Some(_) => set_session_state(&session, &id, SessionState::Failed),
        None => set_session_state(&session, &id, SessionState::Failed),
    }

    let _ = app_handle.emit(
        "pty-exit",
        PtyExitPayload {
            id: id.clone(),
            code,
        },
    );

    // Relay exit to WebSocket subscribers and clean up channel
    if let Some((_, tx)) = PTY_WS_BROADCAST.remove(&id) {
        let payload = serde_json::json!({ "type": "pty-exit", "id": id, "code": code }).to_string();
        let _ = tx.send(payload);
    }

    // Remove session from map.
    PTY_SESSIONS.remove(&id);
    tracing::info!(id = %id, "PTY session ended");
}

/// Write data (keystrokes) to a PTY session.
#[tauri::command]
pub async fn pty_input(id: String, data: String) -> Result<(), String> {
    let session = PTY_SESSIONS
        .get(&id)
        .ok_or_else(|| format!("PTY session '{}' not found", id))?;

    // Transition from WaitingForInput back to Running when user sends input
    {
        let is_waiting = session
            .state
            .read()
            .ok()
            .map(|s| *s == SessionState::WaitingForInput)
            .unwrap_or(false);
        if is_waiting {
            set_session_state(&session, &id, SessionState::Running);
        }
    }

    let mut writer = session
        .writer
        .lock()
        .map_err(|e| format!("Failed to lock PTY writer: {e}"))?;

    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to PTY: {e}"))?;

    writer
        .flush()
        .map_err(|e| format!("Failed to flush PTY: {e}"))?;

    Ok(())
}

/// Write to a PTY session whose key matches the given prefix (for session lookup).
pub fn write_to_session_by_prefix(prefix: &str, data: &str) -> Result<(), String> {
    // Collect key first, drop DashMap read reference before acquiring Mutex
    let key = PTY_SESSIONS
        .iter()
        .find(|e| e.key() == prefix || e.key().starts_with(prefix))
        .map(|e| e.key().clone());

    let key = key.ok_or_else(|| format!("No PTY session found for: {prefix}"))?;

    let session = PTY_SESSIONS.get(&key)
        .ok_or_else(|| format!("PTY session disappeared: {key}"))?;

    // Transition from WaitingForInput back to Running
    {
        let is_waiting = session
            .state
            .read()
            .ok()
            .map(|s| *s == SessionState::WaitingForInput)
            .unwrap_or(false);
        if is_waiting {
            set_session_state(&session, &key, SessionState::Running);
        }
    }

    let mut writer = session.writer.lock()
        .map_err(|e| format!("lock error: {e}"))?;
    writer.write_all(data.as_bytes())
        .map_err(|e| format!("write error: {e}"))?;
    writer.flush()
        .map_err(|e| format!("flush error: {e}"))?;
    Ok(())
}

/// Resize a PTY session.
#[tauri::command]
pub async fn pty_resize(id: String, rows: u16, cols: u16) -> Result<(), String> {
    let session = PTY_SESSIONS
        .get(&id)
        .ok_or_else(|| format!("PTY session '{}' not found", id))?;

    let master = session
        .master
        .lock()
        .map_err(|e| format!("Failed to lock PTY master: {e}"))?;

    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {e}"))?;

    Ok(())
}

/// Kill a PTY session and clean up resources.
#[tauri::command]
pub async fn pty_kill(id: String) -> Result<(), String> {
    if let Some((_, session)) = PTY_SESSIONS.remove(&id) {
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
        // Drop the Arc<PtySession> — when the reader thread also drops its
        // clone the master fd is closed and the reader gets EOF.
        drop(session);
        tracing::info!(id = %id, "PTY session killed");
        Ok(())
    } else {
        Err(format!("PTY session '{}' not found", id))
    }
}

/// Get the current state of a PTY session.
#[tauri::command]
pub async fn pty_get_session_state(pty_id: String) -> Result<SessionState, String> {
    let session = PTY_SESSIONS
        .get(&pty_id)
        .ok_or_else(|| format!("PTY session '{}' not found", pty_id))?;

    session
        .state
        .read()
        .map(|s| s.clone())
        .map_err(|e| format!("Failed to read session state: {e}"))
}

/// Create a PTY session running a specific command (used by ai.rs and http_server).
pub fn create_command_pty(
    id: String,
    working_dir: String,
    program: &str,
    args: &[&str],
    rows: u16,
    cols: u16,
    app_handle: AppHandle,
) -> Result<String, String> {
    let pty_system = NativePtySystem::default();
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut cmd = CommandBuilder::new(program);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.cwd(&working_dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("FORCE_COLOR", "3");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {e}"))?;

    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    let session = Arc::new(PtySession {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        _working_dir: working_dir,
        state: RwLock::new(SessionState::Running),
        app_handle: app_handle.clone(),
        output_buffer: RwLock::new(Vec::with_capacity(OUTPUT_BUFFER_MAX_LINES)),
    });

    let session_for_stream = session.clone();
    match PTY_SESSIONS.entry(id.clone()) {
        Entry::Occupied(_) => {
            if let Ok(mut c) = session.child.lock() {
                let _ = c.kill();
            }
            return Err(format!("PTY session '{}' already exists", id));
        }
        Entry::Vacant(e) => {
            e.insert(session);
        }
    }

    let stream_id = id.clone();
    std::thread::spawn(move || {
        stream_pty_output(stream_id, reader, session_for_stream, app_handle);
    });

    tracing::info!(id = %id, program = %program, "Command PTY session created");
    Ok(id)
}

// ── Public helpers for HTTP server ───────────────────────────────────────────

/// Returns a snapshot of active session IDs, their states, and working directories.
pub fn list_sessions_internal() -> Vec<(String, SessionState, String)> {
    PTY_SESSIONS
        .iter()
        .map(|entry| {
            let state = entry
                .state
                .read()
                .map(|s| s.clone())
                .unwrap_or(SessionState::Idle);
            let working_dir = entry._working_dir.clone();
            (entry.key().clone(), state, working_dir)
        })
        .collect()
}

/// Write text to a PTY session directly (for HTTP/CLI use).
pub fn pty_write_internal(pty_id: &str, text: String) -> Result<(), String> {
    let session = PTY_SESSIONS
        .get(pty_id)
        .ok_or_else(|| format!("Session {pty_id} not found"))?;

    {
        let is_waiting = session
            .state
            .read()
            .ok()
            .map(|s| *s == SessionState::WaitingForInput)
            .unwrap_or(false);
        if is_waiting {
            set_session_state(&session, pty_id, SessionState::Running);
        }
    }

    let mut writer = session
        .writer
        .lock()
        .map_err(|e| format!("Failed to lock PTY writer: {e}"))?;
    writer
        .write_all(text.as_bytes())
        .map_err(|e| format!("Failed to write to PTY: {e}"))?;
    writer
        .flush()
        .map_err(|e| format!("Failed to flush PTY: {e}"))?;
    Ok(())
}

/// Read the recent output buffer for a PTY session (for handoff context).
pub fn get_recent_output(pty_id: &str) -> Option<String> {
    let session = PTY_SESSIONS.get(pty_id)?;
    let buf = session.output_buffer.read().ok()?;
    if buf.is_empty() {
        None
    } else {
        Some(buf.join("\n"))
    }
}

/// Register a WebSocket broadcast channel for a PTY session.
/// Returns a receiver that will get all future PTY output for this session.
pub fn register_ws_channel(id: &str) -> broadcast::Receiver<String> {
    if let Some(existing) = PTY_WS_BROADCAST.get(id) {
        return existing.subscribe();
    }
    let (tx, rx) = broadcast::channel(256);
    PTY_WS_BROADCAST.insert(id.to_string(), tx);
    rx
}

/// Kill a PTY session (non-async, for HTTP server use).
pub fn pty_kill_internal(id: &str) -> Result<(), String> {
    if let Some((_, session)) = PTY_SESSIONS.remove(id) {
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
        PTY_WS_BROADCAST.remove(id);
        drop(session);
        tracing::info!(id = %id, "PTY session killed (internal)");
        Ok(())
    } else {
        Err(format!("PTY session '{}' not found", id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_state_default() {
        let state = SessionState::Running;
        assert_eq!(format!("{:?}", state), "Running");
    }

    #[test]
    fn test_session_state_variants() {
        let states = vec![
            SessionState::Idle,
            SessionState::Running,
            SessionState::WaitingForInput,
            SessionState::Completed,
            SessionState::Failed,
        ];
        for s in states {
            let json = serde_json::to_string(&s).expect("serialize failed");
            assert!(!json.is_empty());
        }
    }

    #[test]
    fn test_ansi_strip_regex() {
        let input = "\x1b[32mHello\x1b[0m World";
        let cleaned = ANSI_STRIP.replace_all(input, "");
        assert_eq!(cleaned, "Hello World");
    }

    #[test]
    fn test_waiting_patterns_match() {
        let test_cases = vec![
            ("Do you want to continue? [Y/n]", true),
            ("Press Enter to approve", true),
            ("Permission denied", true),
            ("Hello world", false),
            ("git status output", false),
        ];
        for (input, expected) in test_cases {
            assert_eq!(
                WAITING_PATTERNS.is_match(input),
                expected,
                "Failed for: {input}"
            );
        }
    }

    #[test]
    fn test_error_patterns_match() {
        let test_cases = vec![
            ("Error: file not found", true),
            ("command not found", true),
            ("Build failed", true),
            ("Build succeeded", false),
            ("Everything is fine", false),
        ];
        for (input, expected) in test_cases {
            assert_eq!(
                ERROR_PATTERNS.is_match(input),
                expected,
                "Failed for: {input}"
            );
        }
    }
}
