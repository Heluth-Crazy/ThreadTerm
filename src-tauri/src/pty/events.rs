use std::io::Read;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use portable_pty::ExitStatus;
use regex::RegexSet;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::bridge;

use super::registry;
use super::session::{self, PtySession, SessionState, OUTPUT_IDLE_POLL, STARTUP_ERROR_SUPPRESS};
use super::utf8::Utf8StreamDecoder;

const MAIN_WINDOW_LABEL: &str = "main";
const FLOAT_WINDOW_LABEL: &str = "float";

// ── Regex patterns (compiled once) ───────────────────────────────────────────

pub(super) static WAITING_PATTERNS: Lazy<RegexSet> = Lazy::new(|| {
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
pub(super) static ERROR_PATTERNS: Lazy<RegexSet> = Lazy::new(|| {
    RegexSet::new([
        r"(?im)^\s*error[:\s]",         // line starts with "Error:" / "ERROR "
        r"(?im)^\s*\[error\]",          // log prefix "[ERROR] ..."
        r"(?im)^\s*\[fatal\]",          // log prefix "[FATAL] ..."
        r"(?i)fatal error:",            // compiler-style "fatal error:"
        r"(?i)permission denied",       // shell / FS
        r"(?i)command not found",       // bash / zsh
        r"(?i)segmentation fault",      // SIGSEGV
        r"(?im)^\s*panic(?:ked)?[:\s]", // Rust/Go panic lines
        r"(?i)traceback \(most recent", // Python traceback
        r"(?i)unhandled exception",     // .NET / node-style
    ])
    .expect("invalid error regex")
});

pub(super) static ANSI_STRIP: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r"\x1b\[[0-9;]*[a-zA-Z]").expect("invalid ansi regex"));

// ── Event payloads ───────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
struct PtyOutputPayload {
    id: String,
    data: String,
    seq: u64,
}

#[derive(Clone, Serialize)]
struct PtyExitPayload {
    id: String,
    code: Option<u32>,
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

// ── Background workers ───────────────────────────────────────────────────────

pub(super) fn spawn_output_idle_watcher(id: String, ses: Arc<PtySession>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(OUTPUT_IDLE_POLL);

        if session::is_killed(&ses) {
            break;
        }

        let state = match session::get_session_state_snapshot(&ses) {
            Some(state) => state,
            None => continue,
        };

        if matches!(state, SessionState::Completed | SessionState::Failed) {
            break;
        }

        let last_output_at = ses.last_output_at.lock().ok().and_then(|last| *last);

        if session::should_idle_after_quiet(&state, last_output_at, Instant::now()) {
            session::set_session_state(&ses, &id, SessionState::Idle);
        }
    });
}

/// Coalesce the expensive full-screen snapshot + card/mobile preview broadcast
/// to at most once per interval instead of once per ~8KB chunk. Everything that
/// is actually realtime — the visible terminal (`pty-output`), the mobile mirror
/// (`broadcast_terminal_output`), raw-output buffering, and waiting/attention
/// detection — stays per-chunk; only the redundant per-chunk re-serialization of
/// the whole screen is throttled. A waiting-state change or EOF forces an
/// immediate flush so the preview is never visibly stale when it matters.
const PREVIEW_FLUSH_INTERVAL: Duration = Duration::from_millis(100);
const COALESCE_WINDOW: Duration = Duration::from_millis(16);
const COALESCE_MAX_BYTES: usize = 65_536;
const COALESCE_RAW_QUEUE_CAPACITY: usize = 16;

enum PtyReadMessage {
    Chunk {
        bytes: Vec<u8>,
        read_elapsed: Duration,
    },
    ReadError {
        error: String,
    },
}

enum PtyReadEvent {
    Message(PtyReadMessage),
    Timeout,
    Disconnected,
}

/// Whether to (re)broadcast the preview snapshot this chunk: forced on a state
/// change, otherwise rate-limited to one flush per [`PREVIEW_FLUSH_INTERVAL`].
fn should_flush_preview(since_last_flush: Duration, force: bool) -> bool {
    force || since_last_flush >= PREVIEW_FLUSH_INTERVAL
}

fn coalesce_decide(pending_bytes: usize, elapsed: Option<Duration>, force: bool) -> bool {
    if force {
        return true;
    }
    if pending_bytes >= COALESCE_MAX_BYTES {
        return true;
    }
    matches!(elapsed, Some(elapsed) if elapsed >= COALESCE_WINDOW)
}

fn coalesce_should_flush(
    pending_bytes: usize,
    pending_since: Option<Instant>,
    force: bool,
) -> bool {
    coalesce_decide(
        pending_bytes,
        pending_since.map(|since| since.elapsed()),
        force,
    )
}

/// Serialize the current screen snapshot and broadcast it as the card/mobile
/// preview. Extracted so the per-chunk hot path can call it on a throttled
/// cadence instead of every chunk; `data` is only a fallback when the snapshot
/// is empty. The bridge invokes the closure only while a WebSocket receiver
/// exists, so bridge-disabled and no-subscriber sessions do not serialize the
/// emulator merely to discard the result.
fn flush_preview(id: &str, data: &str, ses: &Arc<PtySession>) {
    bridge::broadcast_preview(id, || {
        session::terminal_output_snapshot(ses).unwrap_or_else(|| data.to_string())
    });
}

fn recv_next_pty_read(
    rx: &mpsc::Receiver<PtyReadMessage>,
    pending_since: Option<Instant>,
) -> PtyReadEvent {
    if let Some(since) = pending_since {
        match COALESCE_WINDOW.checked_sub(since.elapsed()) {
            Some(timeout) if timeout > Duration::ZERO => match rx.recv_timeout(timeout) {
                Ok(message) => PtyReadEvent::Message(message),
                Err(mpsc::RecvTimeoutError::Timeout) => PtyReadEvent::Timeout,
                Err(mpsc::RecvTimeoutError::Disconnected) => PtyReadEvent::Disconnected,
            },
            _ => PtyReadEvent::Timeout,
        }
    } else {
        match rx.recv() {
            Ok(message) => PtyReadEvent::Message(message),
            Err(_) => PtyReadEvent::Disconnected,
        }
    }
}

fn output_requests_fast_flush(data: &str, session_start: Instant) -> bool {
    let cleaned = ANSI_STRIP.replace_all(data, "");
    WAITING_PATTERNS.is_match(&cleaned)
        || (session_start.elapsed() > STARTUP_ERROR_SUPPRESS && ERROR_PATTERNS.is_match(&cleaned))
}

fn spawn_pty_reader(
    mut reader: Box<dyn Read + Send>,
    ses: Arc<PtySession>,
    tx: mpsc::SyncSender<PtyReadMessage>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            if session::is_killed(&ses) {
                break;
            }

            let read_t = Instant::now();
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let read_elapsed = read_t.elapsed();
                    if tx
                        .send(PtyReadMessage::Chunk {
                            bytes: buf[..n].to_vec(),
                            read_elapsed,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(PtyReadMessage::ReadError {
                        error: e.to_string(),
                    });
                    break;
                }
            }
        }
    });
}

/// Background reader: reads chunks from the PTY and emits Tauri events.
pub(super) fn stream_pty_output(
    id: String,
    reader: Box<dyn Read + Send>,
    ses: Arc<PtySession>,
    app_handle: AppHandle,
) {
    let (read_tx, read_rx) = mpsc::sync_channel(COALESCE_RAW_QUEUE_CAPACITY);
    spawn_pty_reader(reader, ses.clone(), read_tx);

    let mut last_attention_time = Instant::now() - Duration::from_secs(60);
    let attention_debounce = Duration::from_secs(5);
    // Start "stale" so the very first chunk flushes a preview immediately.
    let mut last_preview_flush = Instant::now() - PREVIEW_FLUSH_INTERVAL;
    let session_start = Instant::now();
    let mut decoder = Utf8StreamDecoder::default();
    let mut pending = String::new();
    let mut pending_bytes = 0usize;
    let mut pending_since: Option<Instant> = None;

    // Throughput profile (emitted at EOF for large outputs): splits stream time
    // across flow-control backpressure, ConPTY read, emulator advance, and
    // emit/IPC so a Windows benchmark reveals where the residual cost lives.
    // Pure measurement — no behavior change.
    let mut prof_flow = Duration::ZERO;
    let mut prof_read = Duration::ZERO;
    let mut prof_apply = Duration::ZERO;
    let mut prof_emit = Duration::ZERO;
    let mut prof_read_chunks: u64 = 0;
    let mut prof_emit_chunks: u64 = 0;
    let mut prof_bytes: u64 = 0;

    loop {
        if session::unacked_bytes(&ses) >= session::FLOW_CONTROL_HIGH_WATERMARK {
            flush_pending_pty_output(
                &id,
                &mut pending,
                &mut pending_bytes,
                &mut pending_since,
                &ses,
                &app_handle,
                &mut last_attention_time,
                &mut last_preview_flush,
                attention_debounce,
                session_start,
                &mut prof_apply,
                &mut prof_emit,
                &mut prof_emit_chunks,
            );
        }

        let flow_t = Instant::now();
        session::wait_for_flow_capacity(&ses);
        prof_flow += flow_t.elapsed();
        if session::is_killed(&ses) {
            break;
        }

        match recv_next_pty_read(&read_rx, pending_since) {
            PtyReadEvent::Message(PtyReadMessage::Chunk {
                bytes,
                read_elapsed,
            }) => {
                prof_read += read_elapsed;
                prof_read_chunks += 1;
                prof_bytes += bytes.len() as u64;

                let data = decoder.decode(&bytes);
                if data.is_empty() {
                    continue;
                }

                if pending_since.is_none() {
                    pending_since = Some(Instant::now());
                }
                pending_bytes = pending_bytes.saturating_add(data.len());
                pending.push_str(&data);

                let force_flush = output_requests_fast_flush(&pending, session_start);
                if coalesce_should_flush(pending_bytes, pending_since, force_flush) {
                    flush_pending_pty_output(
                        &id,
                        &mut pending,
                        &mut pending_bytes,
                        &mut pending_since,
                        &ses,
                        &app_handle,
                        &mut last_attention_time,
                        &mut last_preview_flush,
                        attention_debounce,
                        session_start,
                        &mut prof_apply,
                        &mut prof_emit,
                        &mut prof_emit_chunks,
                    );
                }
            }
            PtyReadEvent::Message(PtyReadMessage::ReadError { error }) => {
                tracing::warn!(id = %id, error = %error, "PTY reader stopped after read error");
                flush_pending_pty_output(
                    &id,
                    &mut pending,
                    &mut pending_bytes,
                    &mut pending_since,
                    &ses,
                    &app_handle,
                    &mut last_attention_time,
                    &mut last_preview_flush,
                    attention_debounce,
                    session_start,
                    &mut prof_apply,
                    &mut prof_emit,
                    &mut prof_emit_chunks,
                );
                break;
            }
            PtyReadEvent::Timeout => {
                flush_pending_pty_output(
                    &id,
                    &mut pending,
                    &mut pending_bytes,
                    &mut pending_since,
                    &ses,
                    &app_handle,
                    &mut last_attention_time,
                    &mut last_preview_flush,
                    attention_debounce,
                    session_start,
                    &mut prof_apply,
                    &mut prof_emit,
                    &mut prof_emit_chunks,
                );
            }
            PtyReadEvent::Disconnected => {
                flush_pending_pty_output(
                    &id,
                    &mut pending,
                    &mut pending_bytes,
                    &mut pending_since,
                    &ses,
                    &app_handle,
                    &mut last_attention_time,
                    &mut last_preview_flush,
                    attention_debounce,
                    session_start,
                    &mut prof_apply,
                    &mut prof_emit,
                    &mut prof_emit_chunks,
                );
                break;
            }
        }
    }

    let trailing = decoder.flush_lossy();
    if !trailing.is_empty() {
        if pending_since.is_none() {
            pending_since = Some(Instant::now());
        }
        pending_bytes = pending_bytes.saturating_add(trailing.len());
        pending.push_str(&trailing);
        flush_pending_pty_output(
            &id,
            &mut pending,
            &mut pending_bytes,
            &mut pending_since,
            &ses,
            &app_handle,
            &mut last_attention_time,
            &mut last_preview_flush,
            attention_debounce,
            session_start,
            &mut prof_apply,
            &mut prof_emit,
            &mut prof_emit_chunks,
        );
    }

    // Output has ended — guarantee the final screen is reflected in the
    // card/mobile preview even if the last chunk fell inside the throttle window.
    flush_preview(&id, "", &ses);

    // Throughput profile for large outputs (e.g. the Windows benchmark): one
    // line showing where stream time went. Quiet for normal small sessions.
    if prof_bytes > 262_144 {
        tracing::info!(
            target: "pty_perf",
            id = %id,
            chunks = prof_emit_chunks,
            read_chunks = prof_read_chunks,
            bytes = prof_bytes,
            total_ms = session_start.elapsed().as_millis() as u64,
            flow_wait_ms = prof_flow.as_millis() as u64,
            read_ms = prof_read.as_millis() as u64,
            apply_ms = prof_apply.as_millis() as u64,
            emit_ms = prof_emit.as_millis() as u64,
            "PTY output stream profile"
        );
    }

    // Determine exit code and update state.
    let wait_code = ses
        .child
        .lock()
        .ok()
        .and_then(|mut child| child.wait().ok().and_then(exit_code_from_status));
    let code = if session::is_killed(&ses) {
        None
    } else {
        wait_code
    };

    match code {
        Some(0) => session::set_session_state(&ses, &id, SessionState::Completed),
        Some(_) => session::set_session_state(&ses, &id, SessionState::Failed),
        None => session::set_session_state(&ses, &id, SessionState::Idle),
    }

    let _ = app_handle.emit(
        "pty-exit",
        PtyExitPayload {
            id: id.clone(),
            code,
        },
    );
    bridge::broadcast_exit(&id, code);

    // Remove session from map.
    registry::remove(&id);
    tracing::info!(id = %id, "PTY session ended");
}

fn exit_code_from_status(status: ExitStatus) -> Option<u32> {
    // portable-pty exposes signal exits through Display but not via a typed
    // accessor. Keep those as unknown so frontend killed/signal semantics stay
    // distinct from a real exit code 1.
    if !status.success() && status.to_string().starts_with("Terminated by ") {
        return None;
    }
    Some(status.exit_code())
}

#[allow(clippy::too_many_arguments)]
fn flush_pending_pty_output(
    id: &str,
    pending: &mut String,
    pending_bytes: &mut usize,
    pending_since: &mut Option<Instant>,
    ses: &Arc<PtySession>,
    app_handle: &AppHandle,
    last_attention_time: &mut Instant,
    last_preview_flush: &mut Instant,
    attention_debounce: Duration,
    session_start: Instant,
    prof_apply: &mut Duration,
    prof_emit: &mut Duration,
    prof_emit_chunks: &mut u64,
) {
    if pending.is_empty() {
        *pending_bytes = 0;
        *pending_since = None;
        return;
    }

    let data = std::mem::take(pending);
    let byte_count = *pending_bytes;
    *pending_bytes = 0;
    *pending_since = None;

    let emit_t = Instant::now();
    let apply_elapsed = emit_pty_output_chunk(
        id,
        &data,
        byte_count,
        ses,
        app_handle,
        last_attention_time,
        last_preview_flush,
        attention_debounce,
        session_start,
    );
    *prof_apply += apply_elapsed;
    *prof_emit += emit_t.elapsed().saturating_sub(apply_elapsed);
    *prof_emit_chunks = prof_emit_chunks.saturating_add(1);
}

#[allow(clippy::too_many_arguments)]
fn emit_pty_output_chunk(
    id: &str,
    data: &str,
    byte_count: usize,
    ses: &Arc<PtySession>,
    app_handle: &AppHandle,
    last_attention_time: &mut Instant,
    last_preview_flush: &mut Instant,
    attention_debounce: Duration,
    session_start: Instant,
) -> Duration {
    let ack_bytes = if byte_count == 0 {
        data.len()
    } else {
        byte_count
    };
    // Commit the sequence, emulator snapshot, replay buffer, and flow credit
    // under one lock before publishing the event. A concurrent attach can
    // therefore observe either the whole chunk or none of it, never a payload
    // paired with the previous sequence number.
    let (seq, apply_elapsed) = session::commit_output(ses, data, ack_bytes);
    emit_pty_output_to_terminal_windows(
        app_handle,
        PtyOutputPayload {
            id: id.to_string(),
            data: data.to_string(),
            seq,
        },
    );
    bridge::broadcast_terminal_output(id, data, seq);

    // Strip ANSI escape codes for pattern matching.
    let cleaned = ANSI_STRIP.replace_all(data, "");
    // Windows ConPTY replays the whole visible screen after a resize; that
    // replay re-emits any prompt text already on screen and would re-trigger
    // the waiting/error attention notifications for input the user already
    // saw. During the post-resize suppression window (see pty_resize), treat
    // the output as a redraw: no attention detection, no waiting-state flip.
    let resize_redraw = session::resize_output_activity_suppressed(ses, Instant::now());
    let waiting_for_input = !resize_redraw && WAITING_PATTERNS.is_match(&cleaned);
    let mut force_preview = false;

    if !waiting_for_input {
        session::mark_output_activity(ses, id);
    }

    if waiting_for_input {
        let already_waiting = ses
            .state
            .read()
            .ok()
            .map(|s| *s == SessionState::WaitingForInput)
            .unwrap_or(false);

        if !already_waiting {
            session::set_session_state(ses, id, SessionState::WaitingForInput);
            // A new prompt appeared — refresh the preview now, not on the next tick.
            force_preview = true;
        }

        if last_attention_time.elapsed() > attention_debounce {
            *last_attention_time = Instant::now();
            let _ = app_handle.emit(
                "attention-required",
                AttentionRequiredPayload {
                    pty_id: id.to_string(),
                    session_id: id.to_string(),
                    attention_type: "waiting".to_string(),
                    message: "Agent needs your input".to_string(),
                },
            );
            bridge::broadcast_attention(id, "waiting", "Agent needs your input");
        }
    }

    // Detect error patterns (emit attention but don't change state to Failed).
    //
    // Skip during STARTUP_ERROR_SUPPRESS to avoid false positives from CLI
    // banners/help output that legitimately mention "error".
    if !resize_redraw
        && session_start.elapsed() > STARTUP_ERROR_SUPPRESS
        && ERROR_PATTERNS.is_match(&cleaned)
        && last_attention_time.elapsed() > attention_debounce
    {
        *last_attention_time = Instant::now();
        let _ = app_handle.emit(
            "attention-required",
            AttentionRequiredPayload {
                pty_id: id.to_string(),
                session_id: id.to_string(),
                attention_type: "error".to_string(),
                message: "Agent encountered an error".to_string(),
            },
        );
        bridge::broadcast_attention(id, "failed", "Agent encountered an error");
    }

    // Coalesced snapshot + preview — the expensive part, kept off the per-chunk
    // path. Forced on a state change, otherwise at most once per interval.
    if should_flush_preview(last_preview_flush.elapsed(), force_preview) {
        flush_preview(id, data, ses);
        *last_preview_flush = Instant::now();
    }

    apply_elapsed
}

fn emit_pty_output_to_terminal_windows(app_handle: &AppHandle, payload: PtyOutputPayload) {
    let _ = app_handle.emit_to(MAIN_WINDOW_LABEL, "pty-output", payload.clone());
    if app_handle.get_webview_window(FLOAT_WINDOW_LABEL).is_some() {
        let _ = app_handle.emit_to(FLOAT_WINDOW_LABEL, "pty-output", payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_flush_preview_throttles_unless_forced() {
        // A state change (e.g. a new prompt) forces an immediate flush.
        assert!(should_flush_preview(Duration::from_millis(0), true));
        // Within the interval and not forced → coalesced, no per-chunk flush.
        assert!(!should_flush_preview(
            PREVIEW_FLUSH_INTERVAL - Duration::from_millis(1),
            false
        ));
        // At or past the interval → flush.
        assert!(should_flush_preview(PREVIEW_FLUSH_INTERVAL, false));
    }

    #[test]
    fn coalesce_decide_flushes_when_forced() {
        assert!(coalesce_decide(0, None, true));
        assert!(coalesce_decide(1, Some(Duration::from_millis(0)), true));
    }

    #[test]
    fn coalesce_decide_holds_small_recent_output() {
        assert!(!coalesce_decide(
            COALESCE_MAX_BYTES - 1,
            Some(COALESCE_WINDOW - Duration::from_millis(1)),
            false,
        ));
    }

    #[test]
    fn coalesce_decide_flushes_at_size_or_window_limit() {
        assert!(coalesce_decide(COALESCE_MAX_BYTES, None, false));
        assert!(coalesce_decide(1, Some(COALESCE_WINDOW), false));
    }

    #[test]
    fn coalesce_should_flush_uses_pending_age() {
        assert!(coalesce_should_flush(
            1,
            Some(Instant::now() - COALESCE_WINDOW),
            false,
        ));
    }

    #[test]
    fn exit_code_from_status_preserves_exact_codes() {
        assert_eq!(
            exit_code_from_status(ExitStatus::with_exit_code(0)),
            Some(0)
        );
        assert_eq!(
            exit_code_from_status(ExitStatus::with_exit_code(1)),
            Some(1)
        );
        assert_eq!(
            exit_code_from_status(ExitStatus::with_exit_code(127)),
            Some(127)
        );
    }

    #[test]
    fn exit_code_from_status_keeps_signal_only_status_unknown() {
        let status = ExitStatus::with_signal("SIGTERM");
        assert_eq!(exit_code_from_status(status), None);
    }
}
