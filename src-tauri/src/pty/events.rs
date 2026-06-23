use std::io::Read;
use std::sync::Arc;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use portable_pty::ExitStatus;
use regex::RegexSet;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::bridge;

use super::registry;
use super::session::{self, PtySession, SessionState, OUTPUT_IDLE_POLL, STARTUP_ERROR_SUPPRESS};
use super::utf8::Utf8StreamDecoder;

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

/// Whether to (re)broadcast the preview snapshot this chunk: forced on a state
/// change, otherwise rate-limited to one flush per [`PREVIEW_FLUSH_INTERVAL`].
fn should_flush_preview(since_last_flush: Duration, force: bool) -> bool {
    force || since_last_flush >= PREVIEW_FLUSH_INTERVAL
}

/// Serialize the current screen snapshot and broadcast it as the card/mobile
/// preview. Extracted so the per-chunk hot path can call it on a throttled
/// cadence instead of every chunk; `data` is only a fallback when the snapshot
/// is empty. `broadcast_preview` itself no-ops on empty content.
fn flush_preview(id: &str, data: &str, ses: &Arc<PtySession>) {
    let preview_source = session::terminal_output_snapshot(ses).unwrap_or_else(|| data.to_string());
    bridge::broadcast_preview(id, &preview_source);
}

/// Background reader: reads chunks from the PTY and emits Tauri events.
pub(super) fn stream_pty_output(
    id: String,
    mut reader: Box<dyn Read + Send>,
    ses: Arc<PtySession>,
    app_handle: AppHandle,
) {
    let mut buf = [0u8; 8192];
    let mut block_parser = super::blocks::BlockParser::new(id.clone());
    let mut last_attention_time = Instant::now() - Duration::from_secs(60);
    let attention_debounce = Duration::from_secs(5);
    // Start "stale" so the very first chunk flushes a preview immediately.
    let mut last_preview_flush = Instant::now() - PREVIEW_FLUSH_INTERVAL;
    let session_start = Instant::now();
    let mut decoder = Utf8StreamDecoder::default();

    loop {
        while session::unacked_bytes(&ses) >= session::FLOW_CONTROL_HIGH_WATERMARK {
            if session::is_killed(&ses) {
                break;
            }
            std::thread::sleep(session::FLOW_CONTROL_SLEEP);
            if session::unacked_bytes(&ses) <= session::FLOW_CONTROL_LOW_WATERMARK {
                break;
            }
        }
        if session::is_killed(&ses) {
            break;
        }

        match reader.read(&mut buf) {
            Ok(0) => break, // EOF – child exited
            Ok(n) => {
                if let Ok(mut snapshot) = ses.snapshot.lock() {
                    snapshot.apply_output(&buf[..n]);
                }

                let data = decoder.decode(&buf[..n]);
                if data.is_empty() {
                    continue;
                }
                emit_pty_output_chunk(
                    &id,
                    &data,
                    &ses,
                    &app_handle,
                    &mut block_parser,
                    &mut last_attention_time,
                    &mut last_preview_flush,
                    attention_debounce,
                    session_start,
                );
            }
            Err(e) => {
                tracing::warn!(id = %id, error = %e, "PTY read error");
                break;
            }
        }
    }

    let trailing = decoder.flush_lossy();
    if !trailing.is_empty() {
        emit_pty_output_chunk(
            &id,
            &trailing,
            &ses,
            &app_handle,
            &mut block_parser,
            &mut last_attention_time,
            &mut last_preview_flush,
            attention_debounce,
            session_start,
        );
    }

    // Output has ended — guarantee the final screen is reflected in the
    // card/mobile preview even if the last chunk fell inside the throttle window.
    flush_preview(&id, "", &ses);

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

fn emit_pty_output_chunk(
    id: &str,
    data: &str,
    ses: &Arc<PtySession>,
    app_handle: &AppHandle,
    block_parser: &mut super::blocks::BlockParser,
    last_attention_time: &mut Instant,
    last_preview_flush: &mut Instant,
    attention_debounce: Duration,
    session_start: Instant,
) {
    // Stage 3 default-off: ingest only when the user has installed
    // the shell integration and flipped the runtime switch via
    // `set_command_blocks_enabled`. Skipping `ingest` entirely is
    // important — even feeding bytes into the parser builds up
    // OSC state that leaks across enable→disable→enable cycles.
    if super::block_parser_enabled() {
        for event in block_parser.ingest(data) {
            event.emit(app_handle);
        }
    }

    let seq = session::next_output_seq(ses);
    let _ = app_handle.emit(
        "pty-output",
        PtyOutputPayload {
            id: id.to_string(),
            data: data.to_string(),
            seq,
        },
    );
    session::add_unacked(ses, data.as_bytes().len());
    bridge::broadcast_terminal_output(id, data, seq);

    // Keep raw PTY bytes so a second webview can replay the same terminal
    // control stream until backend screen snapshots are enabled.
    if let Ok(mut out) = ses.output_buffer.write() {
        out.push_str(data);
        session::trim_recent_output_buffer(&mut out);
    }

    // Strip ANSI escape codes for pattern matching.
    let cleaned = ANSI_STRIP.replace_all(data, "");
    let waiting_for_input = WAITING_PATTERNS.is_match(&cleaned);
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
    if session_start.elapsed() > STARTUP_ERROR_SUPPRESS && ERROR_PATTERNS.is_match(&cleaned) {
        if last_attention_time.elapsed() > attention_debounce {
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
    }

    // Coalesced snapshot + preview — the expensive part, kept off the per-chunk
    // path. Forced on a state change, otherwise at most once per interval.
    if should_flush_preview(last_preview_flush.elapsed(), force_preview) {
        flush_preview(id, data, ses);
        *last_preview_flush = Instant::now();
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
