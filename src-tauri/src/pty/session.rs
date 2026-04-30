use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;

use crate::bridge;

// ── Public types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub enum SessionState {
    Idle,
    Running,
    WaitingForInput,
    Completed,
    Failed,
}

#[derive(Clone, Serialize)]
pub struct LivePtySessionSnapshot {
    pub id: String,
    pub state: SessionState,
    pub recent_output: String,
}

// ── Constants shared with sibling submodules ─────────────────────────────────

/// Maximum bytes retained in the per-session raw output ring used when a
/// second webview attaches mid-session.
pub(super) const OUTPUT_BUFFER_MAX_BYTES: usize = 256 * 1024;

/// Duration during which we suppress ERROR_PATTERNS firing after a session
/// starts. CLIs commonly print banners/help containing the word "error" during
/// bootstrap (e.g. --help output, schema descriptions), and those should not
/// trigger attention notifications.
pub(super) const STARTUP_ERROR_SUPPRESS: Duration = Duration::from_secs(2);

/// How long a PTY can be quiet before the UI-level state falls back to Idle.
/// Running means "output is currently flowing", not merely "the process exists".
pub(super) const OUTPUT_IDLE_GRACE: Duration = Duration::from_secs(2);
pub(super) const OUTPUT_IDLE_POLL: Duration = Duration::from_millis(250);
pub(super) const RESIZE_OUTPUT_ACTIVITY_SUPPRESS: Duration = Duration::from_millis(800);

// ── PtySession struct ────────────────────────────────────────────────────────

/// Represents a live PTY session.
/// All interior-mutable fields are protected by Mutex so the struct is Sync.
pub(super) struct PtySession {
    pub(super) writer: Mutex<Box<dyn Write + Send>>,
    pub(super) master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    pub(super) child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    pub(super) _working_dir: String,
    pub(super) state: RwLock<SessionState>,
    pub(super) app_handle: tauri::AppHandle,
    /// Raw circular buffer used when a second webview attaches to the same PTY.
    pub(super) output_buffer: RwLock<String>,
    pub(super) last_output_at: Mutex<Option<Instant>>,
    pub(super) last_size: Mutex<(u16, u16)>,
    pub(super) suppress_output_activity_until: Mutex<Option<Instant>>,
    pub(super) killed: AtomicBool,
}

// Safety: every non-Sync field is behind a Mutex / RwLock.
unsafe impl Sync for PtySession {}

// ── Event payload (sibling needs to emit it) ────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStateChangedPayload {
    pty_id: String,
    state: SessionState,
}

// ── State-machine helpers ────────────────────────────────────────────────────

/// Update session state and emit `session-state-changed` if changed.
pub(super) fn set_session_state(session: &PtySession, id: &str, new_state: SessionState) {
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
            bridge::broadcast_state(id, &*state);
        }
    }
}

pub(super) fn get_session_state_snapshot(session: &PtySession) -> Option<SessionState> {
    session.state.read().ok().map(|s| s.clone())
}

pub(super) fn should_idle_after_quiet(
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

pub(super) fn mark_output_activity(session: &PtySession, id: &str) {
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

pub(super) fn trim_recent_output_buffer(buffer: &mut String) {
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

/// Clear the WaitingForInput state; the session becomes Running again only
/// once the PTY emits more output.
pub(super) fn clear_waiting_for_input(session: &PtySession, id: &str) {
    let is_waiting = session
        .state
        .read()
        .ok()
        .map(|s| *s == SessionState::WaitingForInput)
        .unwrap_or(false);
    if is_waiting {
        set_session_state(session, id, SessionState::Idle);
    }
}

/// Suppress output activity tracking for a brief window — used when a resize
/// triggers a SIGWINCH that causes full-screen TUIs to redraw.
pub(super) fn suppress_output_activity_for(session: &PtySession, window: Duration) {
    if let Ok(mut until) = session.suppress_output_activity_until.lock() {
        *until = Some(Instant::now() + window);
    }
}

/// Mark the session as user-killed so the reader thread stops emitting an
/// exit code.
pub(super) fn mark_killed(session: &PtySession) {
    session.killed.store(true, Ordering::SeqCst);
}

pub(super) fn is_killed(session: &PtySession) -> bool {
    session.killed.load(Ordering::SeqCst)
}
