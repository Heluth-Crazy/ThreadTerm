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
use super::startup::{PtyStartupTrigger, StartupOutputObservation};
use super::utf8::Utf8StreamDecoder;
use super::writer::WriteCompletion;

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

/// ConPTY 1.22+ can issue a DA1 query while the shell is starting and wait
/// for the terminal response before producing a prompt. The response must be
/// owned by the backend because a card may not have mounted xterm yet.
const DA1_REPLY: &[u8] = b"\x1b[?1;2c";

static DA1_AUTHORITY_ENABLED: Lazy<bool> =
    Lazy::new(|| session::env_flag_enabled("THREADTERM_DA1_AUTHORITY"));

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum DeviceAttributeParserState {
    #[default]
    Ground,
    Esc,
    Csi,
    CsiZero,
    CsiPassthrough,
    Osc,
    OscEsc,
    Dcs,
    DcsEsc,
}

#[derive(Debug, PartialEq, Eq)]
enum DeviceAttributeToken {
    Passthrough(Vec<u8>),
    Da1Query(Vec<u8>),
}

#[derive(Default)]
struct DeviceAttributeResponder {
    state: DeviceAttributeParserState,
    /// Only an incomplete ESC/CSI prefix is buffered. OSC/DCS payloads are
    /// emitted as they arrive and retain at most an ESC terminator tail.
    pending: Vec<u8>,
}

struct DeviceAttributeScan {
    da1_queries: usize,
    tokens: Vec<DeviceAttributeToken>,
}

impl DeviceAttributeResponder {
    #[allow(dead_code)]
    fn consume(&mut self, bytes: &[u8]) -> DeviceAttributeScan {
        scan_tokens(self.consume_tokens(bytes))
    }

    fn consume_tokens(&mut self, bytes: &[u8]) -> Vec<DeviceAttributeToken> {
        let mut tokens = Vec::new();
        for &byte in bytes {
            self.feed(byte, &mut tokens);
        }
        tokens
    }

    fn passthrough(&mut self, bytes: &[u8]) -> Vec<DeviceAttributeToken> {
        let mut tokens = Vec::new();
        if !self.pending.is_empty() {
            push_passthrough(&mut tokens, std::mem::take(&mut self.pending));
        }
        if !bytes.is_empty() {
            push_passthrough(&mut tokens, bytes.to_vec());
        }
        self.state = DeviceAttributeParserState::Ground;
        tokens
    }

    fn finish(&mut self) -> Vec<u8> {
        self.state = DeviceAttributeParserState::Ground;
        std::mem::take(&mut self.pending)
    }

    fn discard(&mut self) {
        self.state = DeviceAttributeParserState::Ground;
        self.pending.clear();
    }

    fn buffered_len(&self) -> usize {
        self.pending.len()
    }

    fn feed(&mut self, byte: u8, tokens: &mut Vec<DeviceAttributeToken>) {
        loop {
            match self.state {
                DeviceAttributeParserState::Ground => {
                    if byte == 0x1b {
                        self.pending.push(byte);
                        self.state = DeviceAttributeParserState::Esc;
                    } else {
                        push_passthrough(tokens, vec![byte]);
                    }
                    return;
                }
                DeviceAttributeParserState::Esc => match byte {
                    b'[' => {
                        self.pending.push(byte);
                        self.state = DeviceAttributeParserState::Csi;
                        return;
                    }
                    b']' => {
                        self.pending.push(byte);
                        push_passthrough(tokens, std::mem::take(&mut self.pending));
                        self.state = DeviceAttributeParserState::Osc;
                        return;
                    }
                    b'P' => {
                        self.pending.push(byte);
                        push_passthrough(tokens, std::mem::take(&mut self.pending));
                        self.state = DeviceAttributeParserState::Dcs;
                        return;
                    }
                    _ => {
                        push_passthrough(tokens, std::mem::take(&mut self.pending));
                        self.state = DeviceAttributeParserState::Ground;
                        // The byte following ESC starts a fresh sequence.
                    }
                },
                DeviceAttributeParserState::Csi => {
                    if byte == b'c' {
                        self.pending.push(byte);
                        tokens.push(DeviceAttributeToken::Da1Query(std::mem::take(
                            &mut self.pending,
                        )));
                        self.state = DeviceAttributeParserState::Ground;
                        return;
                    }
                    if byte == b'0' {
                        self.pending.push(byte);
                        self.state = DeviceAttributeParserState::CsiZero;
                        return;
                    }
                    push_passthrough(tokens, std::mem::take(&mut self.pending));
                    self.state = DeviceAttributeParserState::CsiPassthrough;
                    // Re-process the first non-DA1 byte in passthrough mode.
                }
                DeviceAttributeParserState::CsiZero => {
                    if byte == b'c' {
                        self.pending.push(byte);
                        tokens.push(DeviceAttributeToken::Da1Query(std::mem::take(
                            &mut self.pending,
                        )));
                        self.state = DeviceAttributeParserState::Ground;
                        return;
                    }
                    push_passthrough(tokens, std::mem::take(&mut self.pending));
                    self.state = DeviceAttributeParserState::CsiPassthrough;
                }
                DeviceAttributeParserState::CsiPassthrough => {
                    if byte == 0x1b {
                        self.pending.push(byte);
                        self.state = DeviceAttributeParserState::Esc;
                        return;
                    }
                    let is_final = (0x40..=0x7e).contains(&byte);
                    push_passthrough(tokens, vec![byte]);
                    if is_final {
                        self.state = DeviceAttributeParserState::Ground;
                    }
                    return;
                }
                DeviceAttributeParserState::Osc => {
                    if byte == 0x07 {
                        push_passthrough(tokens, vec![byte]);
                        self.state = DeviceAttributeParserState::Ground;
                    } else if byte == 0x1b {
                        self.pending.push(byte);
                        self.state = DeviceAttributeParserState::OscEsc;
                    } else {
                        push_passthrough(tokens, vec![byte]);
                    }
                    return;
                }
                DeviceAttributeParserState::OscEsc => {
                    if byte == b'\\' {
                        let mut terminator = std::mem::take(&mut self.pending);
                        terminator.push(byte);
                        push_passthrough(tokens, terminator);
                        self.state = DeviceAttributeParserState::Ground;
                        return;
                    }
                    push_passthrough(tokens, std::mem::take(&mut self.pending));
                    self.state = DeviceAttributeParserState::Osc;
                    // Re-process this byte as OSC payload.
                }
                DeviceAttributeParserState::Dcs => {
                    if byte == 0x1b {
                        self.pending.push(byte);
                        self.state = DeviceAttributeParserState::DcsEsc;
                    } else {
                        push_passthrough(tokens, vec![byte]);
                    }
                    return;
                }
                DeviceAttributeParserState::DcsEsc => {
                    if byte == b'\\' {
                        let mut terminator = std::mem::take(&mut self.pending);
                        terminator.push(byte);
                        push_passthrough(tokens, terminator);
                        self.state = DeviceAttributeParserState::Ground;
                        return;
                    }
                    push_passthrough(tokens, std::mem::take(&mut self.pending));
                    self.state = DeviceAttributeParserState::Dcs;
                    // Re-process this byte as DCS payload.
                }
            }
        }
    }
}

fn push_passthrough(tokens: &mut Vec<DeviceAttributeToken>, bytes: Vec<u8>) {
    if bytes.is_empty() {
        return;
    }
    if let Some(DeviceAttributeToken::Passthrough(previous)) = tokens.last_mut() {
        previous.extend_from_slice(&bytes);
    } else {
        tokens.push(DeviceAttributeToken::Passthrough(bytes));
    }
}

fn scan_device_attributes(
    responder: &mut DeviceAttributeResponder,
    bytes: &[u8],
    authority_enabled: bool,
) -> DeviceAttributeScan {
    let tokens = if authority_enabled {
        responder.consume_tokens(bytes)
    } else {
        responder.passthrough(bytes)
    };
    scan_tokens(tokens)
}

fn scan_tokens(tokens: Vec<DeviceAttributeToken>) -> DeviceAttributeScan {
    let da1_queries = tokens
        .iter()
        .filter(|token| matches!(token, DeviceAttributeToken::Da1Query(_)))
        .count();
    DeviceAttributeScan {
        da1_queries,
        tokens,
    }
}

#[cfg(test)]
fn visible_from_tokens(tokens: &[DeviceAttributeToken]) -> Vec<u8> {
    tokens
        .iter()
        .filter_map(|token| match token {
            DeviceAttributeToken::Passthrough(data) => Some(data.as_slice()),
            DeviceAttributeToken::Da1Query(_) => None,
        })
        .flatten()
        .copied()
        .collect()
}

struct DeviceAttributeResolution {
    visible: Vec<u8>,
    committed_queries: usize,
    failure: Option<WriteCompletion>,
}

/// Apply the ordered DA1 decisions without coupling parser tests to a live
/// Tauri session. The callback is called once per query and is expected to
/// enqueue the fixed protocol reply through the single writer.
fn resolve_device_attribute_tokens(
    tokens: Vec<DeviceAttributeToken>,
    mut write_reply: impl FnMut(&[u8]) -> WriteCompletion,
) -> DeviceAttributeResolution {
    let mut visible = Vec::new();
    let mut committed_queries = 0;
    let mut failure = None;

    for token in tokens {
        match token {
            DeviceAttributeToken::Passthrough(data) => visible.extend_from_slice(&data),
            DeviceAttributeToken::Da1Query(raw_query) => match write_reply(DA1_REPLY) {
                WriteCompletion::Committed { .. } => committed_queries += 1,
                WriteCompletion::RejectedBeforeWrite | WriteCompletion::FailedZeroBytes => {
                    visible.extend_from_slice(&raw_query);
                }
                outcome @ (WriteCompletion::FailedPartial { .. }
                | WriteCompletion::FailedUnknown) => {
                    failure = Some(outcome);
                    break;
                }
            },
        }
    }

    DeviceAttributeResolution {
        visible,
        committed_queries,
        failure,
    }
}

#[cfg(feature = "terminal-startup-harness")]
fn map_da1_write_completion(
    completion: &WriteCompletion,
) -> crate::terminal_startup_harness::HarnessDa1Outcome {
    use crate::terminal_startup_harness::HarnessDa1Outcome;

    match completion {
        WriteCompletion::Committed { .. } => HarnessDa1Outcome::Committed,
        WriteCompletion::RejectedBeforeWrite => HarnessDa1Outcome::Rejected,
        WriteCompletion::FailedZeroBytes => HarnessDa1Outcome::Zero,
        WriteCompletion::FailedPartial { .. } => HarnessDa1Outcome::Partial,
        WriteCompletion::FailedUnknown => HarnessDa1Outcome::Unknown,
    }
}

#[cfg(feature = "terminal-startup-harness")]
fn write_da1_reply_with_harness(id: &str, ses: &Arc<PtySession>, reply: &[u8]) -> WriteCompletion {
    use crate::terminal_startup_harness::{self, HarnessDa1Outcome};

    let generation = ses.generation.clone();
    // Each harness operation locks its state only for the bounded counter or
    // fault transition. The state lock is released before the writer wait.
    let _ = terminal_startup_harness::record_da1_outcome(id, &generation, HarnessDa1Outcome::Query);
    let fault = terminal_startup_harness::take_da1_fault(id, &generation);
    let completion = if matches!(
        fault,
        crate::terminal_startup_harness::HarnessDa1Fault::None
    ) {
        // Keep the no-fault feature path byte-for-byte equivalent to
        // production. Fault injection is only a non-shipping test seam.
        session::write_control_bytes(ses, reply)
    } else {
        ses.writer.enqueue_protocol_with_da1_fault(reply, fault)
    };

    let outcome = map_da1_write_completion(&completion);
    let _ = terminal_startup_harness::record_da1_outcome(id, &generation, outcome);
    if completion.is_terminal_failure() {
        let _ =
            terminal_startup_harness::record_da1_outcome(id, &generation, HarnessDa1Outcome::Fatal);
    }
    completion
}

fn da1_authority_enabled() -> bool {
    *DA1_AUTHORITY_ENABLED
}

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
    generation: String,
}

#[derive(Clone, Serialize)]
struct PtyProtocolFailurePayload {
    id: String,
    code: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttentionRequiredPayload {
    pty_id: String,
    session_id: String,
    #[serde(rename = "type")]
    attention_type: String,
    message: String,
    fingerprint: String,
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
const FAST_FLUSH_TAIL_BYTES: usize = 2_048;

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

#[derive(Debug, Default)]
struct RawCreditLedger {
    deferred: usize,
}

impl RawCreditLedger {
    /// Account one raw read without acknowledging bytes that remain buffered
    /// in either the DA parser or UTF-8 decoder.
    fn account_read(&mut self, raw_len: usize, new_deferred: usize) -> usize {
        let available = self
            .deferred
            .checked_add(raw_len)
            .expect("PTY raw credit ledger overflow");
        let eligible = available
            .checked_sub(new_deferred)
            .expect("PTY raw credit ledger deferred bytes exceed available bytes");
        self.deferred = new_deferred;
        eligible
    }

    fn settle_deferred(&mut self) -> usize {
        std::mem::take(&mut self.deferred)
    }
}

fn add_raw_credit(pending_bytes: &mut usize, credit: usize) {
    *pending_bytes = pending_bytes
        .checked_add(credit)
        .expect("PTY pending raw credit overflow");
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

#[derive(Default)]
struct FastFlushDetector {
    cleaned_tail: String,
}

impl FastFlushDetector {
    fn observe(&mut self, data: &str, session_start: Instant) -> bool {
        self.cleaned_tail
            .push_str(&ANSI_STRIP.replace_all(data, ""));
        if self.cleaned_tail.len() > FAST_FLUSH_TAIL_BYTES {
            let mut start = self.cleaned_tail.len() - FAST_FLUSH_TAIL_BYTES;
            while !self.cleaned_tail.is_char_boundary(start) {
                start += 1;
            }
            self.cleaned_tail.drain(..start);
        }
        WAITING_PATTERNS.is_match(&self.cleaned_tail)
            || (session_start.elapsed() > STARTUP_ERROR_SUPPRESS
                && ERROR_PATTERNS.is_match(&self.cleaned_tail))
    }

    fn clear(&mut self) {
        self.cleaned_tail.clear();
    }
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

fn observe_startup_output(
    id: &str,
    ses: &Arc<PtySession>,
    bytes: &[u8],
) -> Result<StartupOutputObservation, String> {
    let observation = ses.startup.observe_output(bytes, |snapshot| {
        if registry::is_current(id, ses) {
            super::startup::emit_startup_state(&ses.app_handle, snapshot);
        }
    })?;
    #[cfg(feature = "terminal-startup-harness")]
    record_startup_output_evidence(id, ses, &observation);
    if observation.became_ready {
        let _ = super::startup::dispatch_if_ready(id, ses)?;
    }
    Ok(observation)
}

fn finish_startup_output(
    id: &str,
    ses: &Arc<PtySession>,
) -> Result<StartupOutputObservation, String> {
    let observation = ses.startup.finish_output(|snapshot| {
        if registry::is_current(id, ses) {
            super::startup::emit_startup_state(&ses.app_handle, snapshot);
        }
    })?;
    #[cfg(feature = "terminal-startup-harness")]
    record_startup_output_evidence(id, ses, &observation);
    if observation.became_ready {
        let _ = super::startup::dispatch_if_ready(id, ses)?;
    }
    Ok(observation)
}

#[cfg(feature = "terminal-startup-harness")]
fn record_startup_output_evidence(
    id: &str,
    ses: &Arc<PtySession>,
    observation: &StartupOutputObservation,
) {
    if !observation.marker_matched && !observation.first_output_observed {
        return;
    }
    let evidence = crate::terminal_startup_harness::HarnessOutputEvidence {
        marker_matched: observation.marker_matched,
        first_output_observed: observation.first_output_observed,
    };
    let _ = crate::terminal_startup_harness::record_output_evidence(id, &ses.generation, evidence);
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
    let mut raw_credit = RawCreditLedger::default();
    let mut pending_since: Option<Instant> = None;
    let mut fast_flush_detector = FastFlushDetector::default();
    let mut device_attributes = DeviceAttributeResponder::default();
    let mut protocol_failed = false;

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
                &mut fast_flush_detector,
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

                let raw_byte_count = bytes.len();
                let scan =
                    scan_device_attributes(&mut device_attributes, &bytes, da1_authority_enabled());

                // Resolve tokens in source order. A query is omitted only
                // after its protocol-lane write is fully committed. Queue
                // rejection/zero-byte failure restores the original bytes at
                // this exact position; partial/unknown completion cannot be
                // safely restored and terminates this generation.
                let resolution = resolve_device_attribute_tokens(scan.tokens, |reply| {
                    #[cfg(feature = "terminal-startup-harness")]
                    {
                        write_da1_reply_with_harness(&id, &ses, reply)
                    }
                    #[cfg(not(feature = "terminal-startup-harness"))]
                    {
                        session::write_control_bytes(&ses, reply)
                    }
                });
                protocol_failed |= resolution.failure.is_some();

                // DA1 ownership is resolved before startup output inspection so
                // query bytes can never become a false FirstOutput signal.
                let startup_output = match observe_startup_output(&id, &ses, &resolution.visible) {
                    Ok(observation) => observation,
                    Err(_) => {
                        // An unknown observer state must never fall back to
                        // renderer-visible bytes: a private marker may be in
                        // this read. Account the raw read, kill the generation,
                        // and let the terminal path settle/drop all tails.
                        tracing::warn!(
                            id = %id,
                            code = "startup_observer_unavailable",
                            "PTY startup output observer failed"
                        );
                        let new_deferred = device_attributes
                            .buffered_len()
                            .checked_add(decoder.buffered_len())
                            .expect("PTY parser/decode deferred credit overflow");
                        let eligible_credit = raw_credit.account_read(raw_byte_count, new_deferred);
                        if eligible_credit > 0 {
                            if pending_since.is_none() {
                                pending_since = Some(Instant::now());
                            }
                            add_raw_credit(&mut pending_bytes, eligible_credit);
                        }
                        protocol_failed = true;
                        terminate_after_protocol_failure(&id, &ses, &app_handle);
                        break;
                    }
                };
                let data = decoder.decode(&startup_output.visible);
                let new_deferred = device_attributes
                    .buffered_len()
                    .checked_add(startup_output.buffered_len)
                    .expect("PTY parser/startup deferred credit overflow")
                    .checked_add(decoder.buffered_len())
                    .expect("PTY parser/decode deferred credit overflow");
                // Only bytes released from parser/decoder buffering become
                // eligible for coalescing/ACK. Deferred bytes are settled
                // once at EOF or terminal protocol failure below.
                let eligible_credit = raw_credit.account_read(raw_byte_count, new_deferred);
                if eligible_credit > 0 {
                    if pending_since.is_none() {
                        pending_since = Some(Instant::now());
                    }
                    add_raw_credit(&mut pending_bytes, eligible_credit);
                }
                if data.is_empty() {
                    if protocol_failed {
                        // Wake any flow-control waiter before publishing the
                        // already-decided bytes from this read.
                        terminate_after_protocol_failure(&id, &ses, &app_handle);
                    }
                    if (scan.da1_queries > 0 || startup_output.matched > 0) && !protocol_failed {
                        flush_pending_pty_output(
                            &id,
                            &mut pending,
                            &mut pending_bytes,
                            &mut pending_since,
                            &mut fast_flush_detector,
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
                    if protocol_failed {
                        break;
                    }
                    continue;
                }

                pending.push_str(&data);

                if protocol_failed {
                    terminate_after_protocol_failure(&id, &ses, &app_handle);
                    break;
                }

                let force_flush = resolution.committed_queries > 0
                    || startup_output.matched > 0
                    || fast_flush_detector.observe(&data, session_start);
                if coalesce_should_flush(pending_bytes, pending_since, force_flush) {
                    flush_pending_pty_output(
                        &id,
                        &mut pending,
                        &mut pending_bytes,
                        &mut pending_since,
                        &mut fast_flush_detector,
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
                    &mut fast_flush_detector,
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
                    &mut fast_flush_detector,
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
                    &mut fast_flush_detector,
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

    if protocol_failed {
        // The parser may already have consumed bytes after the failed query
        // into an incomplete ESC/CSI tail. Do not let that tail escape after
        // the failed protocol point; deferred raw credit is settled exactly
        // once below together with the terminal decoder state. The startup
        // marker tail is private too and must be dropped with the DA1 tail.
        device_attributes.discard();
        let _ = ses.startup.discard_output();
    } else {
        let tail = device_attributes.finish();
        if !tail.is_empty() {
            match observe_startup_output(&id, &ses, &tail) {
                Ok(tail_output) => {
                    let tail_data = decoder.decode(&tail_output.visible);
                    if !tail_data.is_empty() {
                        pending.push_str(&tail_data);
                    }
                }
                Err(_) => {
                    tracing::warn!(
                        id = %id,
                        code = "startup_observer_unavailable",
                        "PTY startup output observer failed at EOF"
                    );
                    protocol_failed = true;
                    let _ = ses.startup.discard_output();
                }
            }
        }
        if !protocol_failed {
            match finish_startup_output(&id, &ses) {
                Ok(startup_tail) => {
                    let tail_data = decoder.decode(&startup_tail.visible);
                    if !tail_data.is_empty() {
                        pending.push_str(&tail_data);
                    }
                }
                Err(_) => {
                    tracing::warn!(
                        id = %id,
                        code = "startup_observer_unavailable",
                        "PTY startup output observer failed at EOF"
                    );
                    protocol_failed = true;
                    let _ = ses.startup.discard_output();
                }
            }
        }
    }
    let trailing = decoder.flush_lossy();
    if !trailing.is_empty() {
        if pending_since.is_none() {
            pending_since = Some(Instant::now());
        }
        pending.push_str(&trailing);
    }
    let deferred_credit = raw_credit.settle_deferred();
    if deferred_credit > 0 {
        if pending_since.is_none() {
            pending_since = Some(Instant::now());
        }
        add_raw_credit(&mut pending_bytes, deferred_credit);
    }
    if !pending.is_empty() || pending_bytes > 0 {
        flush_pending_pty_output(
            &id,
            &mut pending,
            &mut pending_bytes,
            &mut pending_since,
            &mut fast_flush_detector,
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
    // A stale reader must not publish its final preview into a replacement.
    if registry::is_current(&id, &ses) {
        flush_preview(&id, "", &ses);
    }

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

    // A reader can outlive its registry entry when the same PTY id is
    // replaced. Once that happens this Arc is stale and must not cancel,
    // publish, broadcast, or remove the replacement generation.
    if !registry::is_current(&id, &ses) {
        tracing::debug!(id = %id, "ignoring stale PTY reader exit");
        return;
    }

    let _ = ses.startup.cancel(PtyStartupTrigger::PtyExit, |snapshot| {
        if registry::is_current(&id, &ses) {
            super::startup::emit_startup_state(&ses.app_handle, snapshot);
        }
    });

    if !registry::is_current(&id, &ses) {
        return;
    }

    if protocol_failed {
        session::set_session_state(&ses, &id, SessionState::Failed);
    } else {
        match code {
            Some(0) => session::set_session_state(&ses, &id, SessionState::Completed),
            Some(_) => session::set_session_state(&ses, &id, SessionState::Failed),
            None => session::set_session_state(&ses, &id, SessionState::Idle),
        }
    }

    if !registry::is_current(&id, &ses) {
        return;
    }

    let _ = app_handle.emit(
        "pty-exit",
        PtyExitPayload {
            id: id.clone(),
            code,
            generation: ses.generation.clone(),
        },
    );

    if !registry::is_current(&id, &ses) {
        return;
    }

    bridge::broadcast_exit(&id, code);

    // Remove session from map.
    if !registry::is_current(&id, &ses) {
        return;
    }
    if registry::remove_if_same(&id, &ses).is_some() {
        super::shutdown::forget(&id);
    }
    tracing::info!(id = %id, "PTY session ended");
}

fn terminate_after_protocol_failure(id: &str, session: &Arc<PtySession>, app_handle: &AppHandle) {
    session::mark_killed(session);
    if let Ok(mut child) = session.child.lock() {
        let _ = child.kill();
    }
    let _ = session::close_master(session, id);
    let _ = app_handle.emit(
        "pty-protocol-failure",
        PtyProtocolFailurePayload {
            id: id.to_string(),
            code: "protocol_reply_partial",
        },
    );
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
    fast_flush_detector: &mut FastFlushDetector,
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
        if *pending_bytes > 0 {
            // A backend-owned query (for example DA1) may consume every
            // visible byte in a PTY chunk. Publish an empty sequenced frame
            // so renderer ACK/flow credit still advances without exposing the
            // query to xterm.
            let _ = emit_pty_output_chunk(
                id,
                "",
                *pending_bytes,
                ses,
                app_handle,
                last_attention_time,
                last_preview_flush,
                attention_debounce,
                session_start,
            );
        }
        *pending_bytes = 0;
        *pending_since = None;
        fast_flush_detector.clear();
        return;
    }

    let data = std::mem::take(pending);
    let byte_count = *pending_bytes;
    *pending_bytes = 0;
    *pending_since = None;
    fast_flush_detector.clear();

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
    // `byte_count` is the ledger's eligible raw credit. Never infer credit
    // from the decoded UTF-8 length: EOF tails may be visible with zero new
    // raw bytes after an earlier empty frame settled their input.
    let ack_bytes = byte_count;
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

    if data.is_empty() {
        return apply_elapsed;
    }

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
            let fingerprint = matching_line_fingerprint(&cleaned, &WAITING_PATTERNS);
            let _ = app_handle.emit(
                "attention-required",
                AttentionRequiredPayload {
                    pty_id: id.to_string(),
                    session_id: id.to_string(),
                    attention_type: "waiting".to_string(),
                    message: "Agent needs your input".to_string(),
                    fingerprint,
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
        let fingerprint = matching_line_fingerprint(&cleaned, &ERROR_PATTERNS);
        let _ = app_handle.emit(
            "attention-required",
            AttentionRequiredPayload {
                pty_id: id.to_string(),
                session_id: id.to_string(),
                attention_type: "error".to_string(),
                message: "Agent encountered an error".to_string(),
                fingerprint,
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

fn matching_line_fingerprint(cleaned: &str, patterns: &RegexSet) -> String {
    let matching_line = cleaned
        .lines()
        .rev()
        .find(|line| patterns.is_match(line))
        .unwrap_or(cleaned);
    matching_line
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect()
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

    struct RawCreditProbe {
        responder: DeviceAttributeResponder,
        startup: Option<crate::pty::startup::SessionStartup>,
        decoder: Utf8StreamDecoder,
        ledger: RawCreditLedger,
        pending: String,
        pending_credit: usize,
        protocol_failed: bool,
        frames: Vec<(String, usize)>,
    }

    impl RawCreditProbe {
        fn new() -> Self {
            Self {
                responder: DeviceAttributeResponder::default(),
                startup: None,
                decoder: Utf8StreamDecoder::default(),
                ledger: RawCreditLedger::default(),
                pending: String::new(),
                pending_credit: 0,
                protocol_failed: false,
                frames: Vec::new(),
            }
        }

        fn read(&mut self, raw: &[u8], outcome: WriteCompletion) {
            let scan = scan_device_attributes(&mut self.responder, raw, true);
            let resolution = resolve_device_attribute_tokens(scan.tokens, |_| outcome.clone());
            self.protocol_failed |= resolution.failure.is_some();
            let startup_output = self
                .startup
                .as_ref()
                .map(|startup| {
                    startup
                        .observe_output(&resolution.visible, |_| {})
                        .expect("startup observer")
                })
                .unwrap_or_else(|| StartupOutputObservation {
                    visible: resolution.visible.clone(),
                    matched: 0,
                    buffered_len: 0,
                    #[cfg(any(test, feature = "terminal-startup-harness"))]
                    marker_matched: false,
                    #[cfg(any(test, feature = "terminal-startup-harness"))]
                    first_output_observed: false,
                    became_ready: false,
                });
            let data = self.decoder.decode(&startup_output.visible);
            let new_deferred = self
                .responder
                .buffered_len()
                .checked_add(startup_output.buffered_len)
                .expect("probe startup deferred credit overflow")
                .checked_add(self.decoder.buffered_len())
                .expect("probe deferred credit overflow");
            let eligible = self.ledger.account_read(raw.len(), new_deferred);
            add_raw_credit(&mut self.pending_credit, eligible);
            self.pending.push_str(&data);

            if (scan.da1_queries > 0 || startup_output.matched > 0) && !self.protocol_failed {
                self.flush();
            }
        }

        fn timeout(&mut self) {
            if self.pending_credit > 0 {
                self.flush();
            }
        }

        fn eof(&mut self) {
            if self.protocol_failed {
                self.responder.discard();
                if let Some(startup) = &self.startup {
                    startup.discard_output().expect("discard startup observer");
                }
            } else {
                let tail = self.responder.finish();
                let startup_output = self
                    .startup
                    .as_ref()
                    .map(|startup| startup.observe_output(&tail, |_| {}).expect("startup tail"))
                    .unwrap_or_else(|| StartupOutputObservation {
                        visible: tail.clone(),
                        matched: 0,
                        buffered_len: 0,
                        #[cfg(any(test, feature = "terminal-startup-harness"))]
                        marker_matched: false,
                        #[cfg(any(test, feature = "terminal-startup-harness"))]
                        first_output_observed: false,
                        became_ready: false,
                    });
                self.pending
                    .push_str(&self.decoder.decode(&startup_output.visible));
                if let Some(startup) = &self.startup {
                    let startup_tail = startup.finish_output(|_| {}).expect("startup EOF");
                    self.pending
                        .push_str(&self.decoder.decode(&startup_tail.visible));
                }
            }
            self.pending.push_str(&self.decoder.flush_lossy());
            add_raw_credit(&mut self.pending_credit, self.ledger.settle_deferred());
            self.flush();
        }

        fn flush(&mut self) {
            if self.pending.is_empty() && self.pending_credit == 0 {
                return;
            }
            self.frames
                .push((std::mem::take(&mut self.pending), self.pending_credit));
            self.pending_credit = 0;
        }
    }

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
    fn matching_line_fingerprint_is_stable_across_spacing_and_uses_last_match() {
        let first = matching_line_fingerprint(
            "noise\nContinue?   [y/n]\nother\nApprove   request? [y/n]\n",
            &WAITING_PATTERNS,
        );
        let second = matching_line_fingerprint("Approve request?   [y/n]\r\n", &WAITING_PATTERNS);
        assert_eq!(first, "Approve request? [y/n]");
        assert_eq!(second, first);
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
    fn fast_flush_detector_preserves_short_matches_split_across_reads() {
        let mut detector = FastFlushDetector::default();
        let session_start = Instant::now();

        assert!(!detector.observe("\u{1b}[33mpress ", session_start));
        assert!(detector.observe("enter\u{1b}[0m", session_start));
    }

    #[test]
    fn fast_flush_detector_keeps_only_a_bounded_recent_tail() {
        let mut detector = FastFlushDetector::default();
        let session_start = Instant::now();

        assert!(!detector.observe(&"x".repeat(100_000), session_start));
        assert!(detector.cleaned_tail.len() <= FAST_FLUSH_TAIL_BYTES);
    }

    #[test]
    fn device_attribute_responder_filters_only_explicit_da1_queries() {
        let mut responder = DeviceAttributeResponder::default();
        let scan = responder.consume(b"before\x1b[cfollow\x1b[0c!");

        assert_eq!(visible_from_tokens(&scan.tokens), b"beforefollow!");
        assert_eq!(scan.da1_queries, 2);
    }

    #[test]
    fn device_attribute_responder_preserves_split_and_non_da1_sequences() {
        let mut responder = DeviceAttributeResponder::default();
        assert_eq!(visible_from_tokens(&responder.consume(b"\x1b").tokens), b"");
        assert_eq!(visible_from_tokens(&responder.consume(b"[").tokens), b"");
        assert_eq!(visible_from_tokens(&responder.consume(b"0").tokens), b"");
        let completed = responder.consume(b"c");
        assert_eq!(visible_from_tokens(&completed.tokens), b"");
        assert_eq!(completed.da1_queries, 1);

        let preserved = responder.consume(b"\x1b[12;34Htext");
        assert_eq!(visible_from_tokens(&preserved.tokens), b"\x1b[12;34Htext");
        assert_eq!(preserved.da1_queries, 0);
    }

    #[test]
    fn device_attribute_responder_flushes_partial_prefix_at_eof() {
        let mut responder = DeviceAttributeResponder::default();
        let scan = responder.consume(b"x\x1b[");
        assert_eq!(visible_from_tokens(&scan.tokens), b"x");
        assert_eq!(responder.finish(), b"\x1b[");
    }

    #[test]
    fn raw_credit_pipeline_preserves_deferred_bytes() {
        let mut query = RawCreditProbe::new();
        query.read(b"\x1b", WriteCompletion::Committed { bytes: 3 });
        query.timeout();
        assert!(query.frames.is_empty(), "split ESC must not ACK early");
        query.read(b"[c", WriteCompletion::Committed { bytes: 3 });
        assert_eq!(query.frames, vec![(String::new(), 3)]);

        let mut ascii_split_utf8 = RawCreditProbe::new();
        ascii_split_utf8.read(b"ascii\xE2", WriteCompletion::Committed { bytes: 3 });
        ascii_split_utf8.timeout();
        assert_eq!(ascii_split_utf8.frames, vec![("ascii".to_string(), 5)]);
        ascii_split_utf8.eof();
        assert_eq!(ascii_split_utf8.frames[1].1, 1);
        assert_eq!(
            ascii_split_utf8
                .frames
                .iter()
                .map(|(_, n)| n)
                .sum::<usize>(),
            6
        );

        let mut split_utf8 = RawCreditProbe::new();
        split_utf8.read(&[0xE2], WriteCompletion::Committed { bytes: 3 });
        split_utf8.timeout();
        assert!(
            split_utf8.frames.is_empty(),
            "split UTF-8 must not ACK early"
        );
        split_utf8.read(&[0x82], WriteCompletion::Committed { bytes: 3 });
        split_utf8.timeout();
        assert!(
            split_utf8.frames.is_empty(),
            "deferred UTF-8 must stay buffered"
        );
        split_utf8.eof();
        assert_eq!(split_utf8.frames.iter().map(|(_, n)| n).sum::<usize>(), 2);

        let mut complete_utf8 = RawCreditProbe::new();
        complete_utf8.read(&[0xE2], WriteCompletion::Committed { bytes: 3 });
        complete_utf8.timeout();
        assert!(complete_utf8.frames.is_empty());
        complete_utf8.read(&[0x82], WriteCompletion::Committed { bytes: 3 });
        complete_utf8.timeout();
        assert!(complete_utf8.frames.is_empty());
        complete_utf8.read(&[0xAC], WriteCompletion::Committed { bytes: 3 });
        complete_utf8.timeout();
        assert_eq!(complete_utf8.frames, vec![("€".to_string(), 3)]);
        assert_eq!(
            complete_utf8.frames.iter().map(|(_, n)| n).sum::<usize>(),
            3
        );

        let mut parser_eof = RawCreditProbe::new();
        parser_eof.read(b"\x1b[", WriteCompletion::Committed { bytes: 3 });
        parser_eof.timeout();
        assert!(
            parser_eof.frames.is_empty(),
            "incomplete CSI must not ACK early"
        );
        parser_eof.eof();
        assert_eq!(parser_eof.frames, vec![("\x1b[".to_string(), 2)]);

        let mut failed = RawCreditProbe::new();
        let failed_raw = b"before\x1b[c-after\x1b[";
        failed.read(
            failed_raw,
            WriteCompletion::FailedPartial { committed_bytes: 2 },
        );
        assert!(
            failed.frames.is_empty(),
            "failure waits for terminal settlement"
        );
        failed.eof();
        assert_eq!(
            failed.frames,
            vec![("before".to_string(), failed_raw.len())]
        );
    }

    fn marker_startup() -> crate::pty::startup::SessionStartup {
        crate::pty::startup::SessionStartup::new(
            crate::pty::startup::PtyStartupCoordinator::explicit(
                "pty",
                "0123456789abcdef0123456789abcdef",
                crate::pty::startup::PtyStartupIntent::Provider {
                    provider: crate::pty::startup::AgentSessionProvider::Codex,
                    command: "codex".to_owned(),
                    card_id: "card".to_owned(),
                    action: crate::pty::startup::PtyStartupAction::Start,
                    side_effect_plan: crate::pty::startup::PtyStartupSideEffectPlan::Discover,
                },
            )
            .expect("startup coordinator"),
        )
    }

    fn ready_marker() -> Vec<u8> {
        let mut marker = b"\x1b]777;threadterm;ready;".to_vec();
        marker.extend_from_slice(b"0123456789abcdef0123456789abcdef");
        marker.push(0x07);
        marker
    }

    #[test]
    fn marker_only_chunk_publishes_empty_frame_and_exact_credit() {
        let startup = marker_startup();
        startup
            .configure_output_marker("0123456789abcdef0123456789abcdef", true)
            .unwrap();
        let marker = ready_marker();
        let mut probe = RawCreditProbe::new();
        probe.startup = Some(startup);
        probe.read(&marker, WriteCompletion::Committed { bytes: 3 });
        assert_eq!(probe.frames, vec![(String::new(), marker.len())]);
    }

    #[test]
    fn da1_marker_and_utf8_credit_once_in_source_order() {
        let startup = marker_startup();
        startup
            .configure_output_marker("0123456789abcdef0123456789abcdef", true)
            .unwrap();
        let mut raw = b"\x1b[c".to_vec();
        raw.extend_from_slice(&ready_marker());
        raw.extend_from_slice("中文🙂".as_bytes());
        let expected_len = raw.len();
        let mut probe = RawCreditProbe::new();
        probe.startup = Some(startup);
        probe.read(
            &raw,
            WriteCompletion::Committed {
                bytes: DA1_REPLY.len(),
            },
        );
        assert_eq!(probe.frames, vec![("中文🙂".to_owned(), expected_len)]);
        assert_eq!(
            probe.frames.iter().map(|(_, bytes)| bytes).sum::<usize>(),
            expected_len
        );
    }

    #[test]
    fn device_attribute_authority_off_preserves_renderer_bytes() {
        let mut responder = DeviceAttributeResponder::default();
        let scan = scan_device_attributes(&mut responder, b"x\x1b[c", false);

        assert_eq!(visible_from_tokens(&scan.tokens), b"x\x1b[c");
        assert_eq!(scan.da1_queries, 0);
    }

    #[test]
    fn device_attribute_parser_keeps_osc_and_dcs_queries_opaque() {
        let input = b"\x1b]777;fake\x1b[c\x07\x1bPfake\x1b[0c\x1b\\";
        let mut responder = DeviceAttributeResponder::default();
        let scan = responder.consume(input);

        assert_eq!(visible_from_tokens(&scan.tokens), input);
        assert_eq!(scan.da1_queries, 0);
    }

    #[test]
    fn device_attribute_parser_keeps_utf8_continuations_opaque() {
        // U+041C (М) is D0 9C. The continuation byte must not terminate an
        // OSC/DCS payload or expose the query-looking bytes inside it.
        let input = b"\x1b]opaque \xD0\x9C \x1b[c\x1b\\\x1bPopaque \xD0\x9C \x1b[0c\x1b\\";
        let mut responder = DeviceAttributeResponder::default();
        let scan = responder.consume(input);

        assert_eq!(scan.da1_queries, 0);
        assert_eq!(visible_from_tokens(&scan.tokens), input);
    }

    #[test]
    fn device_attribute_parser_preserves_unsupported_and_malformed_csi() {
        let input = b"\x1b[?1;2c\x1b[12;34H\x1b[00c\x1b[0x";
        let mut responder = DeviceAttributeResponder::default();
        let scan = responder.consume(input);

        assert_eq!(visible_from_tokens(&scan.tokens), input);
        assert_eq!(scan.da1_queries, 0);
        assert_eq!(responder.finish(), b"");
    }

    #[test]
    fn device_attribute_parser_handles_repeated_adjacent_da1() {
        let mut responder = DeviceAttributeResponder::default();
        let scan = responder.consume(b"\x1b[c\x1b[0c\x1b[c");

        assert_eq!(visible_from_tokens(&scan.tokens), b"");
        assert_eq!(scan.da1_queries, 3);
        assert_eq!(
            scan.tokens,
            vec![
                DeviceAttributeToken::Da1Query(b"\x1b[c".to_vec()),
                DeviceAttributeToken::Da1Query(b"\x1b[0c".to_vec()),
                DeviceAttributeToken::Da1Query(b"\x1b[c".to_vec()),
            ]
        );
    }

    #[test]
    fn device_attribute_resolution_restores_rejected_queries_in_place() {
        let mut responder = DeviceAttributeResponder::default();
        let scan = responder.consume(b"before\x1b[c-middle-\x1b[0c-after");
        let mut outcomes = [
            WriteCompletion::RejectedBeforeWrite,
            WriteCompletion::Committed {
                bytes: DA1_REPLY.len(),
            },
        ]
        .into_iter();
        let resolved = resolve_device_attribute_tokens(scan.tokens, |_| {
            outcomes.next().expect("one outcome per query")
        });

        assert_eq!(resolved.visible, b"before\x1b[c-middle--after");
        assert_eq!(resolved.committed_queries, 1);
        assert!(resolved.failure.is_none());
    }

    #[test]
    fn device_attribute_resolution_does_not_restore_partial_query() {
        let mut responder = DeviceAttributeResponder::default();
        let scan = responder.consume(b"before\x1b[c-after");
        let resolved = resolve_device_attribute_tokens(scan.tokens, |_| {
            WriteCompletion::FailedPartial { committed_bytes: 2 }
        });

        assert_eq!(resolved.visible, b"before");
        assert_eq!(
            resolved.failure,
            Some(WriteCompletion::FailedPartial { committed_bytes: 2 })
        );
    }

    #[test]
    fn device_attribute_failure_discards_suffix_and_split_tail() {
        let mut responder = DeviceAttributeResponder::default();
        let scan = responder.consume(b"before\x1b[c-after\x1b[");
        let resolved = resolve_device_attribute_tokens(scan.tokens, |_| {
            WriteCompletion::FailedPartial { committed_bytes: 2 }
        });

        assert_eq!(resolved.visible, b"before");
        assert!(resolved.failure.is_some());
        responder.discard();
        assert!(responder.finish().is_empty());
    }

    #[test]
    fn device_attribute_resolution_restores_zero_byte_query() {
        let mut responder = DeviceAttributeResponder::default();
        let scan = responder.consume(b"before\x1b[c-after");
        let resolved =
            resolve_device_attribute_tokens(scan.tokens, |_| WriteCompletion::FailedZeroBytes);

        assert_eq!(resolved.visible, b"before\x1b[c-after");
        assert!(resolved.failure.is_none());
    }

    #[cfg(feature = "terminal-startup-harness")]
    #[test]
    fn harness_da1_mapper_preserves_truthful_write_outcomes() {
        use crate::terminal_startup_harness::HarnessDa1Outcome;

        let cases = [
            (
                WriteCompletion::Committed {
                    bytes: DA1_REPLY.len(),
                },
                HarnessDa1Outcome::Committed,
            ),
            (
                WriteCompletion::RejectedBeforeWrite,
                HarnessDa1Outcome::Rejected,
            ),
            (WriteCompletion::FailedZeroBytes, HarnessDa1Outcome::Zero),
            (
                WriteCompletion::FailedPartial { committed_bytes: 1 },
                HarnessDa1Outcome::Partial,
            ),
            (WriteCompletion::FailedUnknown, HarnessDa1Outcome::Unknown),
        ];

        for (completion, expected) in cases {
            assert_eq!(map_da1_write_completion(&completion), expected);
        }
    }

    #[cfg(feature = "terminal-startup-harness")]
    #[test]
    fn harness_da1_callback_outcomes_preserve_resolver_fallback_contract() {
        use crate::terminal_startup_harness::HarnessDa1Fault;

        let cases = [
            (
                HarnessDa1Fault::Reject,
                WriteCompletion::RejectedBeforeWrite,
                b"before\x1b[c-after".as_slice(),
                None,
            ),
            (
                HarnessDa1Fault::Zero,
                WriteCompletion::FailedZeroBytes,
                b"before\x1b[c-after".as_slice(),
                None,
            ),
            (
                HarnessDa1Fault::Partial,
                WriteCompletion::FailedPartial { committed_bytes: 1 },
                b"before".as_slice(),
                Some(WriteCompletion::FailedPartial { committed_bytes: 1 }),
            ),
            (
                HarnessDa1Fault::Unknown,
                WriteCompletion::FailedUnknown,
                b"before".as_slice(),
                Some(WriteCompletion::FailedUnknown),
            ),
        ];

        for (_fault, completion, expected_visible, expected_failure) in cases {
            let mut responder = DeviceAttributeResponder::default();
            let scan = responder.consume(b"before\x1b[c-after");
            let resolved = resolve_device_attribute_tokens(scan.tokens, |_| completion.clone());

            assert_eq!(resolved.visible, expected_visible);
            assert_eq!(resolved.failure, expected_failure);
        }
    }

    #[test]
    fn da1_reply_is_the_xterm_aligned_fixed_response() {
        assert_eq!(DA1_REPLY, b"\x1b[?1;2c");
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
