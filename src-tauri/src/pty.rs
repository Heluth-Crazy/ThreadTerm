use dashmap::DashMap;
use dashmap::mapref::entry::Entry;
use once_cell::sync::Lazy;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use regex::RegexSet;
use serde::Serialize;
use std::io::{Read, Write};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Window};

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

// Error detection: require line-start anchors or high-confidence signals.
// The previous `\berror\b`/`\bfailed\b` matched every time a CLI mentioned
// the words "error" or "failed" anywhere — including help text, log prefixes
// and tool descriptions — which fired the attention bell continuously.
//
// Patterns below only match things the user almost certainly needs to see.
static ERROR_PATTERNS: Lazy<RegexSet> = Lazy::new(|| {
    RegexSet::new([
        r"(?im)^\s*error[:\s]",            // line starts with "Error:" / "ERROR "
        r"(?im)^\s*\[error\]",             // log prefix "[ERROR] ..."
        r"(?im)^\s*\[fatal\]",             // log prefix "[FATAL] ..."
        r"(?i)fatal error:",               // compiler-style "fatal error:"
        r"(?i)permission denied",          // shell / FS
        r"(?i)command not found",          // bash / zsh
        r"(?i)segmentation fault",         // SIGSEGV
        r"(?im)^\s*panic(?:ked)?[:\s]",    // Rust/Go panic lines
        r"(?i)traceback \(most recent",    // Python traceback
        r"(?i)unhandled exception",        // .NET / node-style
    ])
    .expect("invalid error regex")
});

/// Duration during which we suppress ERROR_PATTERNS firing after a session
/// starts. CLIs commonly print banners/help containing the word "error" during
/// bootstrap (e.g. --help output, schema descriptions), and those should not
/// trigger attention notifications.
const STARTUP_ERROR_SUPPRESS: Duration = Duration::from_secs(2);

/// How long a PTY can be quiet before the UI-level state falls back to Idle.
/// Running means "output is currently flowing", not merely "the process exists".
const OUTPUT_IDLE_GRACE: Duration = Duration::from_secs(2);
const OUTPUT_IDLE_POLL: Duration = Duration::from_millis(250);
const RESIZE_OUTPUT_ACTIVITY_SUPPRESS: Duration = Duration::from_millis(800);

static ANSI_STRIP: Lazy<regex::Regex> = Lazy::new(|| {
    regex::Regex::new(r"\x1b\[[0-9;]*[a-zA-Z]").expect("invalid ansi regex")
});

// ── Global session map ───────────────────────────────────────────────────────

/// Global map of active PTY sessions.
static PTY_SESSIONS: Lazy<DashMap<String, Arc<PtySession>>> = Lazy::new(DashMap::new);

/// Represents a live PTY session.
/// All interior-mutable fields are protected by Mutex so the struct is Sync.
struct PtySession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    _working_dir: String,
    state: RwLock<SessionState>,
    app_handle: tauri::AppHandle,
    /// Raw circular buffer used when a second webview attaches to the same PTY.
    output_buffer: RwLock<String>,
    last_output_at: Mutex<Option<Instant>>,
    last_size: Mutex<(u16, u16)>,
    suppress_output_activity_until: Mutex<Option<Instant>>,
    killed: AtomicBool,
}

const OUTPUT_BUFFER_MAX_BYTES: usize = 256 * 1024;

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

fn get_session_state_snapshot(session: &PtySession) -> Option<SessionState> {
    session.state.read().ok().map(|s| s.clone())
}

fn should_idle_after_quiet(
    state: &SessionState,
    last_output_at: Option<Instant>,
    now: Instant,
) -> bool {
    *state == SessionState::Running
        && last_output_at
            .map(|last| now.duration_since(last) >= OUTPUT_IDLE_GRACE)
            .unwrap_or(false)
}

fn resize_output_activity_suppressed(session: &PtySession, now: Instant) -> bool {
    session
        .suppress_output_activity_until
        .lock()
        .ok()
        .and_then(|until| *until)
        .map(|until| now <= until)
        .unwrap_or(false)
}

fn mark_output_activity(session: &PtySession, id: &str) {
    let now = Instant::now();
    let current_state = get_session_state_snapshot(session);

    // Full-screen TUIs often redraw immediately after SIGWINCH/resize. That
    // redraw is not user work and must not flip an idle card to Running.
    if resize_output_activity_suppressed(session, now)
        && !matches!(current_state, Some(SessionState::Running))
    {
        return;
    }

    if let Ok(mut last_output_at) = session.last_output_at.lock() {
        *last_output_at = Some(now);
    }

    match current_state {
        Some(SessionState::Completed | SessionState::Failed | SessionState::WaitingForInput) => {}
        _ => set_session_state(session, id, SessionState::Running),
    }
}

fn spawn_output_idle_watcher(id: String, session: Arc<PtySession>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(OUTPUT_IDLE_POLL);

        if session.killed.load(Ordering::SeqCst) {
            break;
        }

        let state = match get_session_state_snapshot(&session) {
            Some(state) => state,
            None => continue,
        };

        if matches!(state, SessionState::Completed | SessionState::Failed) {
            break;
        }

        let last_output_at = session
            .last_output_at
            .lock()
            .ok()
            .and_then(|last| *last);

        if should_idle_after_quiet(&state, last_output_at, Instant::now()) {
            set_session_state(&session, &id, SessionState::Idle);
        }
    });
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

#[cfg(target_os = "macos")]
static LOGIN_SHELL_PATH: Lazy<Option<String>> = Lazy::new(resolve_macos_login_shell_path);

#[cfg(target_os = "macos")]
const MACOS_FALLBACK_PATH: &str =
    "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

#[cfg(target_os = "macos")]
fn resolve_macos_login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());

    let output = Command::new(&shell)
        .arg("-l")
        .arg("-c")
        .arg("printf '__THREADTERM_PATH_BEGIN__%s__THREADTERM_PATH_END__\\n' \"$PATH\"")
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let path = stdout
        .split("__THREADTERM_PATH_BEGIN__")
        .nth(1)?
        .split("__THREADTERM_PATH_END__")
        .next()?
        .trim();

    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

#[cfg(target_os = "macos")]
fn merge_path_values(values: &[&str]) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut parts = Vec::new();

    for value in values {
        for part in value.split(':') {
            let trimmed = part.trim();
            if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
                continue;
            }
            parts.push(trimmed.to_string());
        }
    }

    parts.join(":")
}

fn configure_shell_command(cmd: &mut CommandBuilder, shell: &str) {
    #[cfg(target_os = "macos")]
    {
        if shell.ends_with("/zsh")
            || shell == "zsh"
            || shell.ends_with("/bash")
            || shell == "bash"
        {
            cmd.arg("-l");
        }

        let process_path = std::env::var("PATH").unwrap_or_default();
        let login_path = LOGIN_SHELL_PATH.as_deref().unwrap_or("");
        let home = std::env::var("HOME").unwrap_or_default();
        let user_bin_path = format!("{home}/.local/bin:{home}/.cargo/bin:{home}/.bun/bin");
        let path = merge_path_values(&[
            login_path,
            &process_path,
            MACOS_FALLBACK_PATH,
            &user_bin_path,
        ]);
        cmd.env("PATH", path);
    }

    cmd.env("SHELL", shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("FORCE_COLOR", "3");
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
    if PTY_SESSIONS.contains_key(&id) {
        tracing::debug!(id = %id, "pty_create: id already bound, returning existing session");
        return Ok(id);
    }

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
    configure_shell_command(&mut cmd, &shell);

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
        state: RwLock::new(SessionState::Idle),
        app_handle: window.app_handle().clone(),
        output_buffer: RwLock::new(String::with_capacity(
            OUTPUT_BUFFER_MAX_BYTES.min(8192),
        )),
        last_output_at: Mutex::new(None),
        last_size: Mutex::new((rows, cols)),
        suppress_output_activity_until: Mutex::new(None),
        killed: AtomicBool::new(false),
    });

    let session_for_stream = session.clone();
    match PTY_SESSIONS.entry(id.clone()) {
        Entry::Occupied(_) => {
            // Idempotent: if a PTY with this id already exists (e.g. a
            // second webview — typically the floating-terminal overlay —
            // mounted xterm for the same card while the main window's
            // Shell was still alive), kill the redundant child we just
            // spawned (avoids a fork leak) and return Ok(id). The caller
            // attaches to the existing session's `pty-output` broadcast
            // via the listen API, so no state is lost.
            if let Ok(mut c) = session.child.lock() {
                let _ = c.kill();
            }
            tracing::debug!(id = %id, "pty_create: id already bound, returning existing session");
            return Ok(id);
        }
        Entry::Vacant(e) => {
            e.insert(session);
        }
    }

    // Spawn a background thread to read PTY output and emit events. The
    // session remains Idle until bytes actually flow from the PTY.
    spawn_output_idle_watcher(id.clone(), session_for_stream.clone());
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
    let session_start = Instant::now();

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

                // Keep raw PTY bytes so a second webview can replay the same
                // terminal control stream instead of looking like a fresh shell.
                if let Ok(mut out) = session.output_buffer.write() {
                    out.push_str(&data);
                    trim_recent_output_buffer(&mut out);
                }

                // Strip ANSI escape codes for pattern matching
                let cleaned = ANSI_STRIP.replace_all(&data, "");
                let waiting_for_input = WAITING_PATTERNS.is_match(&cleaned);

                if !waiting_for_input {
                    mark_output_activity(&session, &id);
                }

                // Detect waiting-for-input patterns
                if waiting_for_input {
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
                    }
                }

                // Detect error patterns (emit attention but don't change state to Failed).
                //
                // Skip during STARTUP_ERROR_SUPPRESS to avoid false positives from
                // CLI banners/help output that legitimately mention "error".
                if session_start.elapsed() > STARTUP_ERROR_SUPPRESS
                    && ERROR_PATTERNS.is_match(&cleaned)
                {
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
    let wait_code = session
        .child
        .lock()
        .ok()
        .and_then(|mut child| {
            child.wait().ok().map(|status| {
                if status.success() { 0u32 } else { 1u32 }
            })
        });
    let code = if session.killed.load(Ordering::SeqCst) {
        None
    } else {
        wait_code
    };

    match code {
        Some(0) => set_session_state(&session, &id, SessionState::Completed),
        Some(_) => set_session_state(&session, &id, SessionState::Failed),
        None => set_session_state(&session, &id, SessionState::Idle),
    }

    let _ = app_handle.emit(
        "pty-exit",
        PtyExitPayload {
            id: id.clone(),
            code,
        },
    );

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

    // User input clears the waiting state; the session becomes Running only
    // once the PTY emits output again.
    {
        let is_waiting = session
            .state
            .read()
            .ok()
            .map(|s| *s == SessionState::WaitingForInput)
            .unwrap_or(false);
        if is_waiting {
            set_session_state(&session, &id, SessionState::Idle);
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

/// Resize a PTY session.
#[tauri::command]
pub async fn pty_resize(id: String, rows: u16, cols: u16) -> Result<(), String> {
    let session = PTY_SESSIONS
        .get(&id)
        .ok_or_else(|| format!("PTY session '{}' not found", id))?;

    {
        let mut last_size = session
            .last_size
            .lock()
            .map_err(|e| format!("Failed to lock PTY size: {e}"))?;
        if *last_size == (rows, cols) {
            return Ok(());
        }
        *last_size = (rows, cols);
    }

    if let Ok(mut until) = session.suppress_output_activity_until.lock() {
        *until = Some(Instant::now() + RESIZE_OUTPUT_ACTIVITY_SUPPRESS);
    }

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
        session.killed.store(true, Ordering::SeqCst);
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

/// Read recent output for a live PTY session so a second webview can render
/// context immediately after attaching instead of looking like a fresh shell.
#[tauri::command]
pub async fn pty_get_recent_output(pty_id: String) -> Result<Option<String>, String> {
    Ok(get_recent_output(&pty_id))
}

/// Read the recent output buffer for a PTY session.
pub fn get_recent_output(pty_id: &str) -> Option<String> {
    let session = PTY_SESSIONS.get(pty_id)?;
    let buf = session.output_buffer.read().ok()?;
    if buf.is_empty() {
        None
    } else {
        Some(buf.clone())
    }
}

fn trim_recent_output_buffer(buffer: &mut String) {
    if buffer.len() <= OUTPUT_BUFFER_MAX_BYTES {
        return;
    }

    let target_start = buffer.len() - OUTPUT_BUFFER_MAX_BYTES;
    let start = buffer
        .char_indices()
        .map(|(idx, _)| idx)
        .find(|idx| *idx >= target_start)
        .unwrap_or(buffer.len());
    buffer.drain(..start);
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
    fn test_running_goes_idle_after_output_quiets() {
        let last_output_at = Instant::now() - OUTPUT_IDLE_GRACE - Duration::from_millis(1);
        assert!(should_idle_after_quiet(
            &SessionState::Running,
            Some(last_output_at),
            Instant::now()
        ));
    }

    #[test]
    fn test_waiting_does_not_idle_after_output_quiets() {
        let last_output_at = Instant::now() - OUTPUT_IDLE_GRACE - Duration::from_millis(1);
        assert!(!should_idle_after_quiet(
            &SessionState::WaitingForInput,
            Some(last_output_at),
            Instant::now()
        ));
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
            // Real errors (should match)
            ("Error: file not found", true),
            ("ERROR  something bad", true),
            ("[ERROR] invalid config", true),
            ("  [Fatal] db unreachable", true),
            ("fatal error: cannot find <stdio.h>", true),
            ("command not found", true),
            ("bash: cd: permission denied", true),
            ("Segmentation fault (core dumped)", true),
            ("panic: runtime error", true),
            ("panicked at 'assertion failed'", true),
            ("Traceback (most recent call last):", true),
            ("Unhandled exception in thread", true),

            // Previously false-positive, now correctly ignored
            ("Build succeeded", false),
            ("Everything is fine", false),
            ("The --error flag is optional", false),
            ("Errors (0)", false),
            ("help: see `cli errors` for details", false),
            ("Build failed", false), // too generic without a prefix anchor
            ("No errors detected", false),
        ];
        for (input, expected) in test_cases {
            assert_eq!(
                ERROR_PATTERNS.is_match(input),
                expected,
                "Failed for: {input:?}"
            );
        }
    }
}
