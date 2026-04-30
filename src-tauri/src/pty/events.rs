use std::io::Read;
use std::sync::Arc;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use regex::RegexSet;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::bridge;

use super::registry;
use super::session::{self, PtySession, SessionState, OUTPUT_IDLE_POLL, STARTUP_ERROR_SUPPRESS};

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
    let session_start = Instant::now();

    loop {
        match reader.read(&mut buf) {
            Ok(0) => break, // EOF – child exited
            Ok(n) => {
                let data = String::from_utf8_lossy(&buf[..n]).to_string();
                // Stage 3 default-off: ingest only when the user has installed
                // the shell integration and flipped the runtime switch via
                // `set_command_blocks_enabled`. Skipping `ingest` entirely is
                // important — even feeding bytes into the parser builds up
                // OSC state that leaks across enable→disable→enable cycles.
                if super::block_parser_enabled() {
                    for event in block_parser.ingest(&data) {
                        event.emit(&app_handle);
                    }
                }
                let _ = app_handle.emit(
                    "pty-output",
                    PtyOutputPayload {
                        id: id.clone(),
                        data: data.clone(),
                    },
                );
                bridge::broadcast_preview(&id, &data);

                // Keep raw PTY bytes so a second webview can replay the same
                // terminal control stream instead of looking like a fresh shell.
                if let Ok(mut out) = ses.output_buffer.write() {
                    out.push_str(&data);
                    session::trim_recent_output_buffer(&mut out);
                }

                // Strip ANSI escape codes for pattern matching
                let cleaned = ANSI_STRIP.replace_all(&data, "");
                let waiting_for_input = WAITING_PATTERNS.is_match(&cleaned);

                if !waiting_for_input {
                    session::mark_output_activity(&ses, &id);
                }

                // Detect waiting-for-input patterns
                if waiting_for_input {
                    let already_waiting = ses
                        .state
                        .read()
                        .ok()
                        .map(|s| *s == SessionState::WaitingForInput)
                        .unwrap_or(false);

                    if !already_waiting {
                        session::set_session_state(&ses, &id, SessionState::WaitingForInput);
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
                        bridge::broadcast_attention(&id, "waiting", "Agent needs your input");
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
                        bridge::broadcast_attention(&id, "failed", "Agent encountered an error");
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
    let wait_code = ses.child.lock().ok().and_then(|mut child| {
        child
            .wait()
            .ok()
            .map(|status| if status.success() { 0u32 } else { 1u32 })
    });
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
