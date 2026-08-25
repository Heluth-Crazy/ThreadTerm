use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;
use tokio::sync::oneshot;

use crate::bridge;

use super::startup::{PtyShellFamily, SessionStartup, StartupSideEffectDispatcher};
use super::writer::{InputSender, PtyWriter, WriteCompletion};

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
    pub working_dir: String,
    pub terminal_output: String,
    pub recent_output: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyAttachSnapshot {
    pub pty_id: String,
    pub data: String,
    pub seq: u64,
    pub rows: u16,
    pub cols: u16,
    pub cursor_row: u16,
    pub cursor_col: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history: Option<String>,
}

// ── Constants shared with sibling submodules ─────────────────────────────────

/// Maximum bytes retained in the per-session raw output ring used when a
/// second webview attaches mid-session.
pub(super) const OUTPUT_BUFFER_MAX_BYTES: usize = 256 * 1024;
const OUTPUT_BUFFER_TRIM_THRESHOLD_BYTES: usize = OUTPUT_BUFFER_MAX_BYTES * 2;
pub(super) const SESSION_SCROLLBACK_LINES: usize = 3000;

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
pub(super) const FLOW_CONTROL_HIGH_WATERMARK: usize = 200_000;
pub(super) const FLOW_CONTROL_LOW_WATERMARK: usize = 20_000;
/// Safety wake-up used only when no ACK/unregister/kill notification arrives.
/// Renderer lease deadlines normally wake the flow-control waiter earlier.
pub(super) const FLOW_CONTROL_WATCHDOG: Duration = Duration::from_secs(1);
pub(super) const RENDERER_CONSUMER_TTL: Duration = Duration::from_secs(30);
pub(super) const BACKGROUND_CONSUMER_TTL: Duration = Duration::from_secs(30);

/// Parse process-scoped capability flags conservatively. Only the explicit
/// true tokens are enabled; unset, empty, false and invalid values remain OFF
/// until a later evidence-backed default decision changes that policy.
pub(super) fn feature_flag_enabled(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "1" | "true" | "on" | "enabled"
    )
}

pub(super) fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .as_deref()
        .is_some_and(feature_flag_enabled)
}

static GLOBAL_OUTPUT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Debug)]
struct OutputCredit {
    seq: u64,
    bytes: usize,
}

#[derive(Debug)]
pub(super) struct OutputFlowControl {
    pending: VecDeque<OutputCredit>,
    unacked_bytes: usize,
    renderer_acks: HashMap<String, RendererAck>,
    background_acked_through: u64,
    background_last_seen: Option<Instant>,
}

#[derive(Debug)]
struct RendererAck {
    acked_through: u64,
    last_seen: Instant,
}

impl Default for OutputFlowControl {
    fn default() -> Self {
        Self {
            pending: VecDeque::new(),
            unacked_bytes: 0,
            renderer_acks: HashMap::new(),
            background_acked_through: 0,
            background_last_seen: Some(Instant::now()),
        }
    }
}

impl OutputFlowControl {
    fn track(&mut self, seq: u64, bytes: usize) {
        if bytes == 0 {
            return;
        }
        self.pending.push_back(OutputCredit { seq, bytes });
        self.unacked_bytes = self.unacked_bytes.saturating_add(bytes);
        self.settle_for_active_consumers();
    }

    fn settle_through(&mut self, through_seq: u64) {
        while self
            .pending
            .front()
            .is_some_and(|credit| credit.seq <= through_seq)
        {
            if let Some(credit) = self.pending.pop_front() {
                self.unacked_bytes = self.unacked_bytes.saturating_sub(credit.bytes);
            }
        }
    }

    fn settle_for_active_consumers(&mut self) {
        if let Some(through_seq) = self
            .renderer_acks
            .values()
            .map(|renderer| renderer.acked_through)
            .min()
        {
            self.settle_through(through_seq);
        } else if self.background_last_seen.is_some() {
            self.settle_through(self.background_acked_through);
        } else if let Some(latest) = self.pending.back().map(|credit| credit.seq) {
            self.settle_through(latest);
        }
    }

    fn register_renderer(&mut self, consumer_id: String) {
        self.renderer_acks
            .entry(consumer_id)
            .and_modify(|renderer| renderer.last_seen = Instant::now())
            .or_insert(RendererAck {
                acked_through: 0,
                last_seen: Instant::now(),
            });
    }

    fn unregister_renderer(&mut self, consumer_id: &str) {
        self.renderer_acks.remove(consumer_id);
        self.settle_for_active_consumers();
    }

    fn unregister_renderers_with_prefix(&mut self, prefix: &str) -> usize {
        let before = self.renderer_acks.len();
        self.renderer_acks
            .retain(|consumer_id, _| !consumer_id.starts_with(prefix));
        let removed = before.saturating_sub(self.renderer_acks.len());
        if removed > 0 {
            self.settle_for_active_consumers();
        }
        removed
    }

    fn ack_renderer(&mut self, consumer_id: &str, through_seq: u64) {
        let Some(acked_through) = self.renderer_acks.get_mut(consumer_id) else {
            return;
        };
        acked_through.acked_through = acked_through.acked_through.max(through_seq);
        acked_through.last_seen = Instant::now();
        self.settle_for_active_consumers();
    }

    fn ack_background(&mut self, through_seq: u64) {
        self.background_acked_through = self.background_acked_through.max(through_seq);
        self.background_last_seen = Some(Instant::now());
        if self.renderer_acks.is_empty() {
            self.settle_through(self.background_acked_through);
        }
    }

    fn prune_stale_consumers(&mut self, now: Instant) {
        let before = self.renderer_acks.len();
        self.renderer_acks.retain(|_, renderer| {
            now.saturating_duration_since(renderer.last_seen) < RENDERER_CONSUMER_TTL
        });
        let background_expired = self.background_last_seen.is_some_and(|last_seen| {
            now.saturating_duration_since(last_seen) >= BACKGROUND_CONSUMER_TTL
        });
        if background_expired {
            self.background_last_seen = None;
        }
        if self.renderer_acks.len() != before || background_expired {
            self.settle_for_active_consumers();
        }
    }

    fn next_consumer_expiry(&self) -> Option<Instant> {
        self.renderer_acks
            .values()
            .filter_map(|renderer| renderer.last_seen.checked_add(RENDERER_CONSUMER_TTL))
            .chain(
                self.background_last_seen
                    .and_then(|last_seen| last_seen.checked_add(BACKGROUND_CONSUMER_TTL)),
            )
            .min()
    }

    fn wait_duration(&self, now: Instant) -> Duration {
        self.next_consumer_expiry()
            .map(|deadline| deadline.saturating_duration_since(now))
            .unwrap_or(FLOW_CONTROL_WATCHDOG)
            .min(FLOW_CONTROL_WATCHDOG)
    }
}

// ── PtySession struct ────────────────────────────────────────────────────────

pub(super) struct PtyInputRequest {
    pub(super) data: Vec<u8>,
    pub(super) completion: oneshot::Sender<Result<(), String>>,
}

/// Represents a live PTY session.
/// All interior-mutable fields are protected by Mutex so the struct is Sync.
pub(super) struct PtySession {
    /// User/shutdown input is submitted to the same single-owner writer as
    /// protocol and startup messages. The sender preserves the existing
    /// async queue contract while the worker enforces lane priority.
    pub(super) input_tx: InputSender,
    pub(super) writer: PtyWriter,
    pub(super) generation: String,
    /// Fixed at native creation so attach responses never re-discover a shell.
    pub(super) shell_family: PtyShellFamily,
    pub(super) startup: SessionStartup,
    /// Retained for the later startup-dispatch path. Creation only records this
    /// context; output/readiness code remains its sole dispatcher owner.
    pub(super) startup_side_effects: Mutex<Option<StartupSideEffectContext>>,
    pub(super) master: Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>,
    pub(super) child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    pub(super) _working_dir: String,
    pub(super) state: RwLock<SessionState>,
    pub(super) app_handle: tauri::AppHandle,
    /// Raw circular buffer used when a second webview attaches to the same PTY.
    pub(super) output_buffer: RwLock<String>,
    /// Serializes output sequence assignment, screen-buffer advancement,
    /// replay-buffer writes, and flow-credit registration into one commit.
    /// Attach snapshots take the same lock so their payload and sequence form
    /// an atomic catch-up barrier.
    pub(super) output_commit: Mutex<()>,
    pub(super) output_seq: Mutex<u64>,
    pub(super) flow_control: Mutex<OutputFlowControl>,
    pub(super) flow_control_changed: Condvar,
    pub(super) snapshot: Mutex<super::emulator::TerminalSnapshot>,
    pub(super) last_output_at: Mutex<Option<Instant>>,
    pub(super) last_size: Mutex<(u16, u16)>,
    pub(super) suppress_output_activity_until: Mutex<Option<Instant>>,
    pub(super) killed: AtomicBool,
}

pub(super) struct StartupSideEffectContext {
    pub(super) dispatcher: StartupSideEffectDispatcher,
    pub(super) project_path: String,
}

/// Install the process-owned side-effect context exactly once. The keyed PTY
/// create gate serializes callers; this mutex also makes the invariant local
/// to the session if a future attach path reaches it through another route.
pub(super) fn install_startup_side_effect_context(
    session: &PtySession,
    dispatcher: StartupSideEffectDispatcher,
    project_path: String,
) -> Result<(), String> {
    let mut context = session
        .startup_side_effects
        .lock()
        .map_err(|_| "startup_side_effect_context_unavailable".to_string())?;
    context.get_or_insert(StartupSideEffectContext {
        dispatcher,
        project_path,
    });
    Ok(())
}

/// Write a terminal protocol response directly through the same writer used
/// by user input. This is intentionally separate from `pty_input`: device
/// queries originate on the PTY reader thread and must not be routed through
/// the renderer or wait for a WebView to be mounted.
pub(super) fn write_control_bytes(session: &PtySession, data: &[u8]) -> WriteCompletion {
    session.writer.enqueue_protocol(data)
}

/// Release the PTY owner after the direct shell has exited. On Windows,
/// ConPTY keeps the cloned output pipe open until the pseudo-console owner is
/// dropped, so waiting for reader EOF before releasing this handle deadlocks
/// session cleanup.
pub(super) fn close_master(session: &PtySession, id: &str) -> Result<bool, String> {
    let master = session
        .master
        .lock()
        .map_err(|error| format!("Failed to lock PTY master for '{id}': {error}"))?
        .take();
    let Some(master) = master else {
        return Ok(false);
    };
    drop(master);
    Ok(true)
}

// ── Event payload (sibling needs to emit it) ────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStateChangedPayload {
    pty_id: String,
    state: SessionState,
}

// ── State-machine helpers ────────────────────────────────────────────────────

/// Update session state and emit `session-state-changed` if changed.
///
/// Lock discipline (F-01): state mutation and publication stay serialized by
/// the state write guard so concurrent transitions cannot publish out of
/// order. Bridge snapshot/enrichment paths must clone `card_mirror` entries
/// and release that mutex before reading PTY state; this leaves only the
/// state -> card-mirror direction used by `broadcast_state` and removes the
/// former lock cycle without weakening event ordering.
pub(super) fn set_session_state(session: &PtySession, id: &str, new_state: SessionState) {
    update_session_state_with_publish(&session.state, new_state, |state| {
        let _ = session.app_handle.emit(
            "session-state-changed",
            SessionStateChangedPayload {
                pty_id: id.to_string(),
                state: state.clone(),
            },
        );
        bridge::broadcast_state(id, state);
    });
}

fn update_session_state_with_publish(
    state: &RwLock<SessionState>,
    new_state: SessionState,
    publish: impl FnOnce(&SessionState),
) {
    if let Ok(mut state) = state.write() {
        if *state != new_state {
            *state = new_state;
            publish(&state);
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

pub(super) fn resize_output_activity_suppressed(session: &PtySession, now: Instant) -> bool {
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
    if buffer.len() <= OUTPUT_BUFFER_TRIM_THRESHOLD_BYTES {
        return;
    }

    let target_start = buffer.len() - OUTPUT_BUFFER_MAX_BYTES;
    let mut start = target_start;
    while start < buffer.len() && !buffer.is_char_boundary(start) {
        start += 1;
    }
    buffer.drain(..start);
}

fn next_output_seq(session: &PtySession) -> u64 {
    let seq = next_global_output_seq();
    if let Ok(mut current) = session.output_seq.lock() {
        *current = seq;
    }
    seq
}

fn next_global_output_seq() -> u64 {
    GLOBAL_OUTPUT_SEQ
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            Some(current.saturating_add(1))
        })
        .unwrap_or(u64::MAX)
        .saturating_add(1)
}

pub(super) fn current_output_seq(session: &PtySession) -> u64 {
    session.output_seq.lock().map(|seq| *seq).unwrap_or(0)
}

pub(super) fn register_renderer(session: &PtySession, consumer_id: String) {
    if let Ok(mut flow) = session.flow_control.lock() {
        flow.register_renderer(consumer_id);
    }
}

pub(super) fn unregister_renderer(session: &PtySession, consumer_id: &str) {
    if let Ok(mut flow) = session.flow_control.lock() {
        flow.unregister_renderer(consumer_id);
    }
    session.flow_control_changed.notify_all();
}

pub(super) fn unregister_renderers_with_prefix(session: &PtySession, prefix: &str) -> usize {
    let removed = session
        .flow_control
        .lock()
        .map(|mut flow| flow.unregister_renderers_with_prefix(prefix))
        .unwrap_or(0);
    if removed > 0 {
        session.flow_control_changed.notify_all();
    }
    removed
}

pub(super) fn ack_renderer(session: &PtySession, consumer_id: &str, through_seq: u64) {
    if let Ok(mut flow) = session.flow_control.lock() {
        flow.ack_renderer(consumer_id, through_seq);
    }
    session.flow_control_changed.notify_all();
}

pub(super) fn ack_background(session: &PtySession, through_seq: u64) {
    if let Ok(mut flow) = session.flow_control.lock() {
        flow.ack_background(through_seq);
    }
    session.flow_control_changed.notify_all();
}

/// Atomically publish a decoded PTY chunk into every backend representation.
/// The returned duration covers emulator advancement for performance tracing.
pub(super) fn commit_output(session: &PtySession, data: &str, bytes: usize) -> (u64, Duration) {
    let _commit = session
        .output_commit
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let seq = next_output_seq(session);

    let apply_started = Instant::now();
    if let Ok(mut snapshot) = session.snapshot.lock() {
        snapshot.apply_output(data.as_bytes());
    }
    let apply_elapsed = apply_started.elapsed();

    if let Ok(mut out) = session.output_buffer.write() {
        out.push_str(data);
        trim_recent_output_buffer(&mut out);
    }

    if let Ok(mut flow) = session.flow_control.lock() {
        flow.track(seq, bytes);
    }

    (seq, apply_elapsed)
}

pub(super) fn unacked_bytes(session: &PtySession) -> usize {
    session
        .flow_control
        .lock()
        .map(|flow| flow.unacked_bytes)
        .unwrap_or(0)
}

pub(super) fn wait_for_flow_capacity(session: &PtySession) {
    wait_for_flow_capacity_inner(
        &session.flow_control,
        &session.flow_control_changed,
        &session.killed,
    );
}

fn wait_for_flow_capacity_inner(
    flow_control: &Mutex<OutputFlowControl>,
    flow_control_changed: &Condvar,
    killed: &AtomicBool,
) {
    let Ok(mut flow) = flow_control.lock() else {
        return;
    };
    flow.prune_stale_consumers(Instant::now());
    if flow.unacked_bytes < FLOW_CONTROL_HIGH_WATERMARK {
        return;
    }

    while flow.unacked_bytes > FLOW_CONTROL_LOW_WATERMARK && !killed.load(Ordering::SeqCst) {
        let wait_for = flow.wait_duration(Instant::now());
        match flow_control_changed.wait_timeout(flow, wait_for) {
            Ok((next, _)) => {
                flow = next;
                #[cfg(test)]
                FLOW_CONTROL_TEST_WAKEUPS.fetch_add(1, Ordering::Relaxed);
                flow.prune_stale_consumers(Instant::now());
            }
            Err(_) => return,
        }
    }
}

pub(super) fn attach_snapshot(id: &str, session: &PtySession) -> PtyAttachSnapshot {
    let _commit = session
        .output_commit
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let raw_buffer = session
        .output_buffer
        .read()
        .ok()
        .map(|buffer| buffer.clone())
        .unwrap_or_default();
    let seq = current_output_seq(session);

    if let Ok(snapshot) = session.snapshot.lock() {
        let payload = snapshot.snapshot_ansi();
        return build_attach_snapshot(id, seq, Some(payload), &raw_buffer, None);
    }

    let last_size = session
        .last_size
        .lock()
        .map(|size| *size)
        .unwrap_or((24, 120));
    build_attach_snapshot(id, seq, None, &raw_buffer, Some(last_size))
}

/// Decide which payload to return to a freshly-attaching webview.
///
/// When the wezterm-serialized payload is non-empty it is used verbatim.
/// When it is "visually empty" (no scrollback history and `data` is only
/// cursor-positioning escapes) and the raw `output_buffer` has content, the
/// raw buffer is returned instead so the new xterm does not render a black
/// screen. Falls back to the raw buffer alone when the wezterm snapshot lock
/// could not be acquired.
fn build_attach_snapshot(
    id: &str,
    seq: u64,
    payload: Option<super::emulator::TerminalSnapshotPayload>,
    raw_buffer: &str,
    fallback_size: Option<(u16, u16)>,
) -> PtyAttachSnapshot {
    if let Some(payload) = payload {
        if super::emulator::is_visually_empty_payload(&payload) && !raw_buffer.is_empty() {
            return PtyAttachSnapshot {
                pty_id: id.to_string(),
                data: raw_buffer.to_string(),
                seq,
                rows: payload.rows,
                cols: payload.cols,
                cursor_row: 1,
                cursor_col: 1,
                history: None,
            };
        }

        return PtyAttachSnapshot {
            pty_id: id.to_string(),
            data: payload.data,
            seq,
            rows: payload.rows,
            cols: payload.cols,
            cursor_row: payload.cursor_row,
            cursor_col: payload.cursor_col,
            history: payload.history,
        };
    }

    let (rows, cols) = fallback_size.unwrap_or((24, 120));
    PtyAttachSnapshot {
        pty_id: id.to_string(),
        data: raw_buffer.to_string(),
        seq,
        rows,
        cols,
        cursor_row: 1,
        cursor_col: 1,
        history: None,
    }
}

pub(super) fn terminal_output_snapshot(session: &PtySession) -> Option<String> {
    let payload = session.snapshot.lock().ok()?.snapshot_ansi();
    let mut output = String::new();
    if let Some(history) = payload.history {
        output.push_str(&history);
        if !output.ends_with('\n') {
            output.push('\n');
        }
    }
    output.push_str(&payload.data);

    if output.trim().is_empty() {
        None
    } else {
        Some(output)
    }
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

pub(super) fn mark_input_activity(session: &PtySession, id: &str) {
    if let Ok(mut last_output_at) = session.last_output_at.lock() {
        *last_output_at = Some(Instant::now());
    }

    match get_session_state_snapshot(session) {
        Some(SessionState::Completed | SessionState::Failed) => {}
        _ => set_session_state(session, id, SessionState::Running),
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
    mark_killed_inner(
        &session.flow_control,
        &session.flow_control_changed,
        &session.killed,
    );
}

fn mark_killed_inner(
    flow_control: &Mutex<OutputFlowControl>,
    flow_control_changed: &Condvar,
    killed: &AtomicBool,
) {
    // Synchronize the predicate change with the Condvar mutex. Without this,
    // kill can notify between the waiter's predicate check and wait call,
    // leaving the reader asleep until the watchdog/lease deadline.
    let flow = flow_control
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    killed.store(true, Ordering::SeqCst);
    drop(flow);
    flow_control_changed.notify_all();
}

pub(super) fn is_killed(session: &PtySession) -> bool {
    session.killed.load(Ordering::SeqCst)
}

#[cfg(test)]
static FLOW_CONTROL_TEST_WAKEUPS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::emulator::TerminalSnapshot;
    use std::sync::{mpsc, Arc};
    use std::thread;

    #[test]
    fn next_output_seq_is_monotonic() {
        let first = next_global_output_seq();
        let second = next_global_output_seq();
        let third = next_global_output_seq();
        assert!(first < second);
        assert!(second < third);
    }

    #[test]
    fn concurrent_state_transitions_publish_in_the_same_order_as_state_mutation() {
        use std::sync::Barrier;

        let state = Arc::new(RwLock::new(SessionState::Idle));
        let published = Arc::new(Mutex::new(Vec::new()));
        let start = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();

        for offset in 0..2 {
            let state = Arc::clone(&state);
            let published = Arc::clone(&published);
            let start = Arc::clone(&start);
            workers.push(thread::spawn(move || {
                start.wait();
                for index in 0..1_000 {
                    let next = if (index + offset) % 2 == 0 {
                        SessionState::Running
                    } else {
                        SessionState::WaitingForInput
                    };
                    update_session_state_with_publish(&state, next, |emitted| {
                        published
                            .lock()
                            .expect("published state lock")
                            .push(emitted.clone());
                    });
                }
            }));
        }

        start.wait();
        for worker in workers {
            worker.join().expect("state worker should finish");
        }

        let final_state = state.read().expect("state lock").clone();
        let last_published = published
            .lock()
            .expect("published state lock")
            .last()
            .cloned();
        assert_eq!(last_published, Some(final_state));
    }

    #[test]
    fn ack_is_cumulative_and_idempotent() {
        let mut flow = OutputFlowControl::default();
        flow.track(10, 100);
        flow.track(11, 50);

        flow.ack_background(10);
        assert_eq!(flow.unacked_bytes, 50);
        flow.ack_background(10);
        assert_eq!(flow.unacked_bytes, 50);
        flow.ack_background(11);
        assert_eq!(flow.unacked_bytes, 0);
    }

    #[test]
    fn old_ack_does_not_release_future_output() {
        let mut flow = OutputFlowControl::default();
        flow.track(20, 100);
        flow.track(21, 200);
        flow.ack_background(21);
        assert_eq!(flow.unacked_bytes, 0);

        flow.track(22, 300);
        flow.ack_background(21);
        assert_eq!(flow.unacked_bytes, 300);
    }

    #[test]
    fn high_watermark_requires_ack_down_to_low_watermark() {
        let mut flow = OutputFlowControl::default();
        flow.track(30, FLOW_CONTROL_HIGH_WATERMARK - 10_000);
        flow.track(31, 20_000);
        assert!(flow.unacked_bytes >= FLOW_CONTROL_HIGH_WATERMARK);

        flow.ack_background(30);
        assert_eq!(flow.unacked_bytes, 20_000);
        assert!(flow.unacked_bytes <= FLOW_CONTROL_LOW_WATERMARK);
    }

    #[test]
    fn renderer_ack_gates_background_settlement() {
        let mut flow = OutputFlowControl::default();
        flow.register_renderer("main".to_string());
        flow.track(40, 100);

        flow.ack_background(40);
        assert_eq!(flow.unacked_bytes, 100);

        flow.ack_renderer("main", 40);
        assert_eq!(flow.unacked_bytes, 0);
    }

    #[test]
    fn slowest_renderer_controls_settlement_until_unregistered() {
        let mut flow = OutputFlowControl::default();
        flow.register_renderer("main".to_string());
        flow.register_renderer("float".to_string());
        flow.track(50, 100);
        flow.track(51, 200);

        flow.ack_renderer("main", 51);
        flow.ack_renderer("float", 50);
        assert_eq!(flow.unacked_bytes, 200);

        flow.unregister_renderer("float");
        assert_eq!(flow.unacked_bytes, 0);
    }

    #[test]
    fn stale_renderer_ack_cannot_release_output_after_unregister() {
        let mut flow = OutputFlowControl::default();
        flow.register_renderer("old".to_string());
        flow.unregister_renderer("old");
        flow.register_renderer("current".to_string());
        flow.track(60, 100);

        flow.ack_renderer("old", 60);
        assert_eq!(flow.unacked_bytes, 100);
        flow.ack_renderer("current", 60);
        assert_eq!(flow.unacked_bytes, 0);
    }

    #[test]
    fn unregister_renderer_scope_removes_float_consumers_and_preserves_main() {
        let mut flow = OutputFlowControl::default();
        flow.register_renderer("renderer:main:main-1".to_string());
        flow.register_renderer("renderer:float:float-1".to_string());
        flow.register_renderer("renderer:float:float-2".to_string());
        flow.track(61, 100);
        flow.ack_background(61);
        flow.ack_renderer("renderer:main:main-1", 61);

        // The two lagging float renderers keep the main renderer from
        // settling credit until the float scope is explicitly detached.
        assert_eq!(flow.unacked_bytes, 100);
        assert_eq!(flow.unregister_renderers_with_prefix("renderer:float:"), 2);
        assert!(flow.renderer_acks.contains_key("renderer:main:main-1"));
        assert!(!flow.renderer_acks.contains_key("renderer:float:float-1"));
        assert!(!flow.renderer_acks.contains_key("renderer:float:float-2"));
        assert_eq!(flow.unacked_bytes, 0);
    }

    #[test]
    fn stale_renderer_lease_expires_and_background_can_resume_flow() {
        let mut flow = OutputFlowControl::default();
        flow.register_renderer("crashed-window".to_string());
        flow.track(70, 100);
        flow.ack_background(70);
        assert_eq!(flow.unacked_bytes, 100);

        let now = Instant::now();
        flow.renderer_acks
            .get_mut("crashed-window")
            .expect("renderer should be registered")
            .last_seen = now;
        flow.prune_stale_consumers(now + RENDERER_CONSUMER_TTL + Duration::from_millis(1));

        assert!(flow.renderer_acks.is_empty());
        assert_eq!(flow.unacked_bytes, 0);
    }

    #[test]
    fn renderer_lease_expires_at_the_ttl_boundary() {
        let mut flow = OutputFlowControl::default();
        flow.register_renderer("expired".to_string());
        let now = Instant::now();
        flow.renderer_acks
            .get_mut("expired")
            .expect("renderer should be registered")
            .last_seen = now;

        flow.prune_stale_consumers(now + RENDERER_CONSUMER_TTL);

        assert!(flow.renderer_acks.is_empty());
    }

    #[test]
    fn stale_background_consumer_releases_flow_when_no_renderer_is_active() {
        let mut flow = OutputFlowControl::default();
        flow.track(71, FLOW_CONTROL_HIGH_WATERMARK);
        let last_seen = Instant::now();
        flow.background_last_seen = Some(last_seen);

        flow.prune_stale_consumers(last_seen + BACKGROUND_CONSUMER_TTL);

        assert!(flow.background_last_seen.is_none());
        assert_eq!(flow.unacked_bytes, 0);
        assert!(flow.pending.is_empty());
    }

    #[test]
    fn active_background_consumer_holds_flow_until_it_acknowledges_output() {
        let mut flow = OutputFlowControl::default();
        flow.track(72, 100);
        let last_seen = Instant::now();
        flow.background_last_seen = Some(last_seen);

        flow.prune_stale_consumers(last_seen + BACKGROUND_CONSUMER_TTL - Duration::from_millis(1));

        assert!(flow.background_last_seen.is_some());
        assert_eq!(flow.unacked_bytes, 100);
        flow.ack_background(72);
        assert_eq!(flow.unacked_bytes, 0);
    }

    #[test]
    fn stale_background_consumer_does_not_bypass_an_active_renderer() {
        let mut flow = OutputFlowControl::default();
        flow.register_renderer("main".to_string());
        flow.track(73, 100);
        flow.track(74, 200);
        flow.ack_renderer("main", 73);
        let now = Instant::now();
        flow.background_last_seen = Some(now - BACKGROUND_CONSUMER_TTL);
        flow.renderer_acks
            .get_mut("main")
            .expect("renderer should remain registered")
            .last_seen = now;

        flow.prune_stale_consumers(now);

        assert!(flow.background_last_seen.is_none());
        assert_eq!(flow.unacked_bytes, 200);
        flow.ack_renderer("main", 74);
        assert_eq!(flow.unacked_bytes, 0);
    }

    #[test]
    fn flow_wait_deadline_includes_background_consumer_expiry() {
        let mut flow = OutputFlowControl::default();
        flow.register_renderer("main".to_string());
        let now = Instant::now();
        flow.renderer_acks
            .get_mut("main")
            .expect("renderer should be registered")
            .last_seen = now;
        flow.background_last_seen = Some(now - BACKGROUND_CONSUMER_TTL + Duration::from_millis(75));

        let wait = flow.wait_duration(now);

        assert!(wait >= Duration::from_millis(70));
        assert!(wait <= Duration::from_millis(80));
    }

    #[test]
    fn flow_wait_deadline_uses_nearest_renderer_expiry_and_watchdog_cap() {
        let mut flow = OutputFlowControl::default();
        flow.register_renderer("near".to_string());
        flow.register_renderer("far".to_string());
        let now = Instant::now();
        flow.renderer_acks
            .get_mut("near")
            .expect("near renderer should be registered")
            .last_seen = now - RENDERER_CONSUMER_TTL + Duration::from_millis(125);
        flow.renderer_acks
            .get_mut("far")
            .expect("far renderer should be registered")
            .last_seen = now;

        let wait = flow.wait_duration(now);
        assert!(wait >= Duration::from_millis(120));
        assert!(wait <= Duration::from_millis(130));

        flow.renderer_acks
            .get_mut("near")
            .expect("near renderer should remain registered")
            .last_seen = now;
        assert_eq!(flow.wait_duration(now), FLOW_CONTROL_WATCHDOG);
    }

    #[test]
    fn flow_wait_stays_blocked_for_slowest_renderer_until_it_unregisters() {
        struct Harness {
            flow: Mutex<OutputFlowControl>,
            changed: Condvar,
            killed: AtomicBool,
        }

        let harness = Arc::new(Harness {
            flow: Mutex::new(OutputFlowControl::default()),
            changed: Condvar::new(),
            killed: AtomicBool::new(false),
        });
        {
            let mut flow = harness.flow.lock().expect("flow lock");
            flow.register_renderer("fast".to_string());
            flow.register_renderer("slow".to_string());
            flow.track(90, FLOW_CONTROL_HIGH_WATERMARK);
            flow.track(91, 1);
            flow.ack_background(91);
            flow.ack_renderer("fast", 91);
        }

        let wakeups_before = FLOW_CONTROL_TEST_WAKEUPS.load(Ordering::Relaxed);
        let (sentinel_tx, sentinel_rx) = mpsc::channel();
        let waiter = Arc::clone(&harness);
        let handle = thread::spawn(move || {
            wait_for_flow_capacity_inner(&waiter.flow, &waiter.changed, &waiter.killed);
            sentinel_tx.send("final-sentinel").expect("send sentinel");
        });

        assert!(sentinel_rx.recv_timeout(Duration::from_millis(50)).is_err());
        {
            let mut flow = harness.flow.lock().expect("flow lock");
            flow.unregister_renderer("fast");
        }
        harness.changed.notify_all();
        assert!(sentinel_rx.recv_timeout(Duration::from_millis(50)).is_err());

        {
            let mut flow = harness.flow.lock().expect("flow lock");
            flow.unregister_renderer("slow");
        }
        harness.changed.notify_all();
        assert_eq!(
            sentinel_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("slow renderer unregister should release flow"),
            "final-sentinel"
        );
        handle.join().expect("waiter should finish");

        let wakeups = FLOW_CONTROL_TEST_WAKEUPS
            .load(Ordering::Relaxed)
            .saturating_sub(wakeups_before);
        assert!(
            wakeups <= 3,
            "expected notification-driven wakes, got {wakeups}"
        );
    }

    #[test]
    fn kill_notification_wakes_a_flow_control_waiter() {
        struct Harness {
            flow: Mutex<OutputFlowControl>,
            changed: Condvar,
            killed: AtomicBool,
        }

        let harness = Arc::new(Harness {
            flow: Mutex::new(OutputFlowControl::default()),
            changed: Condvar::new(),
            killed: AtomicBool::new(false),
        });
        harness
            .flow
            .lock()
            .expect("flow lock")
            .track(100, FLOW_CONTROL_HIGH_WATERMARK);

        let (done_tx, done_rx) = mpsc::channel();
        let waiter = Arc::clone(&harness);
        let handle = thread::spawn(move || {
            wait_for_flow_capacity_inner(&waiter.flow, &waiter.changed, &waiter.killed);
            done_tx.send(()).expect("send completion");
        });
        assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());

        mark_killed_inner(&harness.flow, &harness.changed, &harness.killed);
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("kill should wake the waiter");
        handle.join().expect("waiter should finish");
    }

    #[test]
    fn renderer_heartbeat_preserves_its_ack_watermark() {
        let mut flow = OutputFlowControl::default();
        flow.register_renderer("main".to_string());
        flow.track(80, 100);
        flow.ack_renderer("main", 80);
        flow.register_renderer("main".to_string());
        flow.track(81, 200);

        assert_eq!(
            flow.renderer_acks
                .get("main")
                .map(|renderer| renderer.acked_through),
            Some(80)
        );
        assert_eq!(flow.unacked_bytes, 200);
    }

    #[test]
    fn trim_recent_output_buffer_keeps_small_overage_until_threshold() {
        let mut buffer = "a".repeat(OUTPUT_BUFFER_MAX_BYTES + 1);
        trim_recent_output_buffer(&mut buffer);
        assert_eq!(buffer.len(), OUTPUT_BUFFER_MAX_BYTES + 1);
    }

    #[test]
    fn trim_recent_output_buffer_trims_to_recent_tail_after_threshold() {
        let mut buffer = "a".repeat(OUTPUT_BUFFER_TRIM_THRESHOLD_BYTES + 32);
        trim_recent_output_buffer(&mut buffer);
        assert_eq!(buffer.len(), OUTPUT_BUFFER_MAX_BYTES);
        assert!(buffer.chars().all(|c| c == 'a'));
    }

    #[test]
    fn trim_recent_output_buffer_preserves_utf8_boundary() {
        let prefix_len = OUTPUT_BUFFER_MAX_BYTES + 1;
        let mut buffer = "a".repeat(prefix_len);
        buffer.push('界');
        buffer.push_str(&"b".repeat(OUTPUT_BUFFER_MAX_BYTES));

        trim_recent_output_buffer(&mut buffer);

        assert!(buffer.is_char_boundary(0));
        assert!(buffer.starts_with('界') || buffer.starts_with('b'));
        assert!(buffer.len() <= OUTPUT_BUFFER_MAX_BYTES + '界'.len_utf8());
    }

    #[test]
    fn attach_snapshot_returns_raw_buffer_when_payload_visually_empty() {
        // wezterm has only seen cursor-visibility toggles, so its current
        // screen has no visible cells; the raw byte buffer still holds prior
        // output (e.g. an upgrade-prompt frame) that the freshly-attached
        // xterm should see instead of a black screen.
        let mut snapshot = TerminalSnapshot::new(24, 80, 2000);
        snapshot.apply_output(b"\x1b[?25l\x1b[?25h");
        let payload = snapshot.snapshot_ansi();
        let raw_buffer = "Installing dependencies...\r\n";

        let result = build_attach_snapshot("pty-1", 7, Some(payload.clone()), raw_buffer, None);

        assert_eq!(result.data, raw_buffer);
        assert!(result.history.is_none());
        assert_eq!(result.cursor_row, 1);
        assert_eq!(result.cursor_col, 1);
        assert_eq!(result.rows, payload.rows);
        assert_eq!(result.cols, payload.cols);
        assert_eq!(result.seq, 7);
        assert_eq!(result.pty_id, "pty-1");
    }

    #[test]
    fn attach_snapshot_uses_payload_when_payload_has_content() {
        let mut snapshot = TerminalSnapshot::new(24, 80, 2000);
        snapshot.apply_output(b"hello");
        let payload = snapshot.snapshot_ansi();

        let result = build_attach_snapshot(
            "pty-1",
            3,
            Some(payload.clone()),
            "stale raw bytes that must be ignored",
            None,
        );

        assert!(result.data.contains("hello"));
        assert_eq!(result.cursor_row, payload.cursor_row);
        assert_eq!(result.cursor_col, payload.cursor_col);
        assert_eq!(result.history, payload.history);
    }

    #[test]
    fn attach_snapshot_keeps_payload_when_raw_buffer_is_empty() {
        // No raw buffer to fall back to: keep the (visually empty) payload
        // so the existing tests / behavior are unchanged.
        let snapshot = TerminalSnapshot::new(24, 80, 2000);
        let payload = snapshot.snapshot_ansi();

        let result = build_attach_snapshot("pty-1", 1, Some(payload.clone()), "", None);

        assert_eq!(result.data, payload.data);
        assert_eq!(result.cursor_row, payload.cursor_row);
        assert_eq!(result.cursor_col, payload.cursor_col);
    }

    #[test]
    fn attach_snapshot_falls_back_to_raw_when_payload_missing() {
        // Mirrors the `snapshot.lock()` failure path: no payload available,
        // raw buffer is returned with the recorded last size.
        let result = build_attach_snapshot("pty-1", 9, None, "raw bytes", Some((30, 100)));

        assert_eq!(result.data, "raw bytes");
        assert_eq!(result.rows, 30);
        assert_eq!(result.cols, 100);
        assert_eq!(result.cursor_row, 1);
        assert_eq!(result.cursor_col, 1);
        assert!(result.history.is_none());
    }

    #[test]
    fn attach_snapshot_preserves_large_history_unicode_and_seq_watermark() {
        // Batch 1 rehydration gate: a cold renderer must receive the full
        // scrollback budget payload shape (history + screen + cursor + seq)
        // without inventing a different pty id.
        let history = (1..=SESSION_SCROLLBACK_LINES)
            .map(|i| format!("history-line-{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let payload = crate::pty::emulator::TerminalSnapshotPayload {
            data: "全屏画面 ✨\r\n".to_string(),
            rows: 40,
            cols: 120,
            cursor_row: 12,
            cursor_col: 8,
            history: Some(format!("{history}\n")),
        };

        let result = build_attach_snapshot("pty-stable", 9001, Some(payload), "ignored", None);

        assert_eq!(result.pty_id, "pty-stable");
        assert_eq!(result.seq, 9001);
        assert_eq!(result.rows, 40);
        assert_eq!(result.cols, 120);
        assert_eq!(result.cursor_row, 12);
        assert_eq!(result.cursor_col, 8);
        assert!(result.data.contains("全屏画面"));
        assert!(result.data.contains("✨"));
        let history = result.history.expect("history present");
        assert_eq!(
            history.matches("history-line-").count(),
            SESSION_SCROLLBACK_LINES
        );
        assert!(history.contains("history-line-1"));
        assert!(history.contains(&format!("history-line-{SESSION_SCROLLBACK_LINES}")));
    }

    #[test]
    fn session_scrollback_budget_is_three_thousand_lines() {
        assert_eq!(SESSION_SCROLLBACK_LINES, 3000);
    }

    #[test]
    fn capability_flags_are_strict_and_case_insensitive() {
        for value in ["1", "true", "TRUE", "on", "Enabled"] {
            assert!(feature_flag_enabled(value), "expected {value} to enable");
        }
        for value in ["", "0", "false", "off", "disabled", "yes", " true "] {
            assert!(
                !feature_flag_enabled(value),
                "expected {value:?} to disable"
            );
        }
    }
}
