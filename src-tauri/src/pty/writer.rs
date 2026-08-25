//! Single-owner PTY writer arbitration.
//!
//! The PTY master has one actual writer thread.  Producers use separate,
//! bounded lanes so a protocol response can overtake a large user request at
//! a chunk boundary without changing the FIFO order of user requests.

use std::io::{ErrorKind, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::Arc;

use tokio::sync::mpsc as tokio_mpsc;

use super::session::PtyInputRequest;

#[cfg(feature = "terminal-startup-harness")]
use crate::terminal_startup_harness::HarnessDa1Fault;

mod gate;
#[cfg(test)]
mod gate_tests;
use gate::StartupGate;

pub(super) const PROTOCOL_QUEUE_CAPACITY: usize = 32;
pub(super) const STARTUP_QUEUE_CAPACITY: usize = 1;
pub(super) const USER_QUEUE_CAPACITY: usize = 1024;
pub(super) const USER_WRITE_CHUNK_BYTES: usize = 4 * 1024;

/// The result of one complete attempted message write.
///
/// A `FailedPartial` or `FailedUnknown` result is terminal for the writer:
/// replaying the original message could duplicate bytes already accepted by
/// the PTY.  `FailedZeroBytes` is known not to have committed any bytes and
/// is therefore safe for the caller to handle as a before-write failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum WriteCompletion {
    Committed { bytes: usize },
    RejectedBeforeWrite,
    FailedZeroBytes,
    FailedPartial { committed_bytes: usize },
    FailedUnknown,
}

impl WriteCompletion {
    pub(super) fn is_terminal_failure(&self) -> bool {
        matches!(self, Self::FailedPartial { .. } | Self::FailedUnknown)
    }
}

struct ProtocolWriteRequest {
    data: Vec<u8>,
    completion: mpsc::Sender<WriteCompletion>,
    #[cfg(feature = "terminal-startup-harness")]
    fault: HarnessDa1Fault,
}

impl ProtocolWriteRequest {
    fn new(data: &[u8], completion: mpsc::Sender<WriteCompletion>) -> Self {
        Self {
            data: data.to_vec(),
            completion,
            #[cfg(feature = "terminal-startup-harness")]
            fault: HarnessDa1Fault::None,
        }
    }

    #[cfg(feature = "terminal-startup-harness")]
    #[allow(dead_code)]
    fn with_fault(
        data: &[u8],
        completion: mpsc::Sender<WriteCompletion>,
        fault: HarnessDa1Fault,
    ) -> Self {
        Self {
            data: data.to_vec(),
            completion,
            fault,
        }
    }

    fn write(&self, writer: &mut Box<dyn Write + Send>) -> WriteCompletion {
        #[cfg(feature = "terminal-startup-harness")]
        {
            match self.fault {
                HarnessDa1Fault::None => write_bytes(writer, &self.data),
                // Reject is returned before admission by the public harness
                // entry point. Keep this branch defensive for an internal
                // request constructed by a test or a future caller.
                HarnessDa1Fault::Reject => WriteCompletion::RejectedBeforeWrite,
                HarnessDa1Fault::Zero => WriteCompletion::FailedZeroBytes,
                HarnessDa1Fault::Partial => write_da1_partial(writer, &self.data),
                HarnessDa1Fault::Unknown => WriteCompletion::FailedUnknown,
            }
        }

        #[cfg(not(feature = "terminal-startup-harness"))]
        {
            write_bytes(writer, &self.data)
        }
    }
}

struct StartupWriteRequest {
    data: Vec<u8>,
    completion: mpsc::Sender<WriteCompletion>,
}

/// A cloneable sender retained by `PtySession` and used by the existing
/// async shutdown/input paths.  The wake channel is deliberately separate
/// from the user queue: it only wakes the worker and never carries bytes.
#[derive(Clone)]
pub(super) struct InputSender {
    tx: tokio_mpsc::Sender<PtyInputRequest>,
    wake: SyncSender<()>,
}

impl InputSender {
    pub(super) async fn send(&self, request: PtyInputRequest) -> Result<(), ()> {
        self.tx.send(request).await.map_err(|_| ())?;
        // A wake is only a coalesced edge notification. If one is already
        // pending, the worker will observe the queued request while handling
        // that edge; retaining a history of one wake per request would leave
        // stale notifications behind and make the worker spin.
        let _ = self.wake.try_send(());
        Ok(())
    }
}

struct ActiveUserRequest {
    request: PtyInputRequest,
    offset: usize,
}

impl ActiveUserRequest {
    fn new(request: PtyInputRequest) -> Self {
        Self { request, offset: 0 }
    }

    fn remaining(&self) -> &[u8] {
        &self.request.data[self.offset..]
    }

    fn advance(&mut self, bytes: usize) {
        self.offset = self.offset.saturating_add(bytes);
    }

    fn is_complete(&self) -> bool {
        self.offset >= self.request.data.len()
    }
}

/// Handles for the protocol and startup lanes.  User input uses
/// [`InputSender`] above so existing callers keep their async FIFO contract.
pub(super) struct PtyWriter {
    input: InputSender,
    protocol: SyncSender<ProtocolWriteRequest>,
    startup: SyncSender<StartupWriteRequest>,
    stopped: Arc<AtomicBool>,
    startup_gate: Option<StartupGate>,
}

impl PtyWriter {
    pub(super) fn input_sender(&self) -> InputSender {
        self.input.clone()
    }

    /// Enqueue and synchronously await a protocol completion.  A full or
    /// closed protocol lane is a before-write rejection and never writes any
    /// bytes.  The reader thread is the caller, so waiting here does not block
    /// the PTY writer itself.
    pub(super) fn enqueue_protocol(&self, data: &[u8]) -> WriteCompletion {
        if self.stopped.load(Ordering::Acquire) {
            return WriteCompletion::RejectedBeforeWrite;
        }
        let (completion_tx, completion_rx) = mpsc::channel();
        let request = ProtocolWriteRequest::new(data, completion_tx);
        match self.protocol.try_send(request) {
            Ok(()) => {
                let _ = self.input.wake.try_send(());
                completion_rx
                    .recv()
                    .unwrap_or(WriteCompletion::FailedUnknown)
            }
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                WriteCompletion::RejectedBeforeWrite
            }
        }
    }

    /// Feature-only writer-path fault injection for the Windows startup
    /// harness.  `None` delegates to the production path exactly; all other
    /// outcomes still enter the ordinary protocol lane except `Reject`, which
    /// is deliberately returned before admission.
    #[cfg(feature = "terminal-startup-harness")]
    #[allow(dead_code)]
    pub(super) fn enqueue_protocol_with_da1_fault(
        &self,
        data: &[u8],
        fault: HarnessDa1Fault,
    ) -> WriteCompletion {
        if matches!(fault, HarnessDa1Fault::None) {
            return self.enqueue_protocol(data);
        }
        if matches!(fault, HarnessDa1Fault::Reject) {
            return WriteCompletion::RejectedBeforeWrite;
        }
        if self.stopped.load(Ordering::Acquire) {
            return WriteCompletion::RejectedBeforeWrite;
        }

        let (completion_tx, completion_rx) = mpsc::channel();
        let request = ProtocolWriteRequest::with_fault(data, completion_tx, fault);
        match self.protocol.try_send(request) {
            Ok(()) => {
                let _ = self.input.wake.try_send(());
                completion_rx
                    .recv()
                    .unwrap_or(WriteCompletion::FailedUnknown)
            }
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                WriteCompletion::RejectedBeforeWrite
            }
        }
    }

    /// Startup has one bounded slot.  This is kept separate from protocol so
    /// a future startup coordinator cannot consume protocol capacity.
    pub(super) fn enqueue_startup(&self, data: &[u8]) -> WriteCompletion {
        if self.stopped.load(Ordering::Acquire) {
            return WriteCompletion::RejectedBeforeWrite;
        }
        let (completion_tx, completion_rx) = mpsc::channel();
        let request = StartupWriteRequest {
            data: data.to_vec(),
            completion: completion_tx,
        };
        match self.startup.try_send(request) {
            Ok(()) => {
                let _ = self.input.wake.try_send(());
                let outcome = completion_rx
                    .recv()
                    .unwrap_or(WriteCompletion::FailedUnknown);
                if matches!(outcome, WriteCompletion::FailedUnknown) {
                    if let Some(gate) = &self.startup_gate {
                        gate.fail();
                    }
                }
                outcome
            }
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                WriteCompletion::RejectedBeforeWrite
            }
        }
    }
}

/// Start the sole writer worker for a PTY master writer.
pub(super) fn spawn(writer: Box<dyn Write + Send>) -> Result<PtyWriter, std::io::Error> {
    spawn_with_gate(writer, None)
}

/// Start a writer whose user lane remains queued, but not writable, until its
/// one startup request commits.  This is additive; legacy callers use
/// [`spawn`] and retain the open-lane behavior.
pub(super) fn spawn_blocked_for_startup(
    writer: Box<dyn Write + Send>,
) -> Result<PtyWriter, std::io::Error> {
    spawn_with_gate(writer, Some(StartupGate::closed()))
}

fn spawn_with_gate(
    writer: Box<dyn Write + Send>,
    startup_gate: Option<StartupGate>,
) -> Result<PtyWriter, std::io::Error> {
    let (user_tx, user_rx) = tokio_mpsc::channel(USER_QUEUE_CAPACITY);
    let (protocol_tx, protocol_rx) = mpsc::sync_channel(PROTOCOL_QUEUE_CAPACITY);
    let (startup_tx, startup_rx) = mpsc::sync_channel(STARTUP_QUEUE_CAPACITY);
    let (wake_tx, wake_rx) = mpsc::sync_channel(1);
    let stopped = Arc::new(AtomicBool::new(false));

    let worker_stopped = Arc::clone(&stopped);
    let writer_gate = startup_gate.clone();
    std::thread::Builder::new()
        .name("threadterm-pty-writer".to_owned())
        .spawn(move || {
            run_worker(
                writer,
                user_rx,
                protocol_rx,
                startup_rx,
                wake_rx,
                worker_stopped,
                startup_gate,
            );
        })?;

    Ok(PtyWriter {
        input: InputSender {
            tx: user_tx,
            wake: wake_tx,
        },
        protocol: protocol_tx,
        startup: startup_tx,
        stopped,
        startup_gate: writer_gate,
    })
}

fn run_worker(
    mut writer: Box<dyn Write + Send>,
    mut user_rx: tokio_mpsc::Receiver<PtyInputRequest>,
    protocol_rx: Receiver<ProtocolWriteRequest>,
    startup_rx: Receiver<StartupWriteRequest>,
    wake_rx: Receiver<()>,
    stopped: Arc<AtomicBool>,
    startup_gate: Option<StartupGate>,
) {
    let mut active_user: Option<ActiveUserRequest> = None;
    let mut user_disconnected = false;

    loop {
        // A request already in progress retains its user-lane FIFO position;
        // only the two higher lanes can run before its next 4 KiB chunk.
        if let Some(mut request) = active_user.take() {
            let mut priority_failure = None;
            loop {
                if let Some(outcome) = try_process_protocol(&mut writer, &protocol_rx) {
                    if outcome.is_terminal_failure() {
                        priority_failure = Some(outcome);
                        break;
                    }
                    continue;
                }
                if let Some(outcome) =
                    try_process_startup(&mut writer, &startup_rx, startup_gate.as_ref())
                {
                    if startup_failure_is_terminal(&outcome) {
                        priority_failure = Some(outcome);
                        break;
                    }
                    continue;
                }
                break;
            }
            if let Some(outcome) = priority_failure {
                let _ = request
                    .request
                    .completion
                    .send(Err(user_failure_message(&outcome)));
                drain_failed(&mut user_rx, &protocol_rx, &startup_rx, &outcome);
                break;
            }

            let chunk_len = request.remaining().len().min(USER_WRITE_CHUNK_BYTES);
            let outcome = write_bytes(&mut writer, &request.remaining()[..chunk_len]);
            match outcome {
                WriteCompletion::Committed { .. } => {
                    request.advance(chunk_len);
                    if request.is_complete() {
                        let _ = request.request.completion.send(Ok(()));
                    } else {
                        active_user = Some(request);
                    }
                }
                WriteCompletion::FailedZeroBytes | WriteCompletion::RejectedBeforeWrite => {
                    let _ = request
                        .request
                        .completion
                        .send(Err(user_failure_message(&outcome)));
                    drain_failed(&mut user_rx, &protocol_rx, &startup_rx, &outcome);
                    break;
                }
                WriteCompletion::FailedPartial { .. } | WriteCompletion::FailedUnknown => {
                    let _ = request
                        .request
                        .completion
                        .send(Err(user_failure_message(&outcome)));
                    drain_failed(&mut user_rx, &protocol_rx, &startup_rx, &outcome);
                    break;
                }
            }
            continue;
        }

        // Fixed priority at every scheduling boundary.
        if let Some(outcome) = try_process_protocol(&mut writer, &protocol_rx) {
            if outcome.is_terminal_failure() {
                drain_failed(&mut user_rx, &protocol_rx, &startup_rx, &outcome);
                break;
            }
            continue;
        }
        if let Some(outcome) = try_process_startup(&mut writer, &startup_rx, startup_gate.as_ref())
        {
            if startup_failure_is_terminal(&outcome) {
                drain_failed(&mut user_rx, &protocol_rx, &startup_rx, &outcome);
                break;
            }
            continue;
        }

        if startup_gate.as_ref().is_some_and(|gate| !gate.is_open()) {
            if user_rx.is_closed() {
                break;
            }
            if wake_rx.recv().is_err() {
                break;
            }
            continue;
        }

        match user_rx.try_recv() {
            Ok(request) => {
                active_user = Some(ActiveUserRequest::new(request));
                continue;
            }
            Err(tokio_mpsc::error::TryRecvError::Disconnected) => {
                user_disconnected = true;
            }
            Err(tokio_mpsc::error::TryRecvError::Empty) => {}
        }

        if user_disconnected {
            // The session owns all three lane handles together. Once the
            // user sender is disconnected no producer can legitimately add a
            // later high-priority request; any queued request is resolved by
            // the final drain below without being replayed.
            break;
        }

        if wake_rx.recv().is_err() {
            break;
        }
    }

    stopped.store(true, Ordering::Release);
    // Send an explicit error to every request that was accepted by a lane but
    // could not run.  No caller may wait forever and no payload is replayed.
    drain_failed(
        &mut user_rx,
        &protocol_rx,
        &startup_rx,
        &WriteCompletion::FailedUnknown,
    );
}

fn try_process_protocol(
    writer: &mut Box<dyn Write + Send>,
    receiver: &Receiver<ProtocolWriteRequest>,
) -> Option<WriteCompletion> {
    let request = match receiver.try_recv() {
        Ok(request) => request,
        Err(TryRecvError::Empty | TryRecvError::Disconnected) => return None,
    };
    let outcome = request.write(writer);
    let _ = request.completion.send(outcome.clone());
    Some(outcome)
}

fn try_process_startup(
    writer: &mut Box<dyn Write + Send>,
    receiver: &Receiver<StartupWriteRequest>,
    startup_gate: Option<&StartupGate>,
) -> Option<WriteCompletion> {
    let request = match receiver.try_recv() {
        Ok(request) => request,
        Err(TryRecvError::Empty | TryRecvError::Disconnected) => return None,
    };
    let outcome = write_bytes(writer, &request.data);
    if let Some(gate) = startup_gate {
        match outcome {
            WriteCompletion::Committed { .. } => gate.open(),
            WriteCompletion::FailedZeroBytes
            | WriteCompletion::FailedPartial { .. }
            | WriteCompletion::FailedUnknown => gate.fail(),
            WriteCompletion::RejectedBeforeWrite => {}
        }
    }
    let _ = request.completion.send(outcome.clone());
    Some(outcome)
}

fn startup_failure_is_terminal(outcome: &WriteCompletion) -> bool {
    matches!(
        outcome,
        WriteCompletion::FailedZeroBytes
            | WriteCompletion::FailedPartial { .. }
            | WriteCompletion::FailedUnknown
    )
}

fn drain_failed(
    user_rx: &mut tokio_mpsc::Receiver<PtyInputRequest>,
    protocol_rx: &Receiver<ProtocolWriteRequest>,
    startup_rx: &Receiver<StartupWriteRequest>,
    outcome: &WriteCompletion,
) {
    while let Ok(request) = user_rx.try_recv() {
        let _ = request.completion.send(Err(user_failure_message(outcome)));
    }
    while let Ok(request) = protocol_rx.try_recv() {
        // These requests are still in their queue, so no byte was handed to
        // the PTY. Preserve the protocol caller's before-write fallback.
        let _ = request
            .completion
            .send(WriteCompletion::RejectedBeforeWrite);
    }
    while let Ok(request) = startup_rx.try_recv() {
        let _ = request
            .completion
            .send(WriteCompletion::RejectedBeforeWrite);
    }
}

fn write_bytes(writer: &mut Box<dyn Write + Send>, bytes: &[u8]) -> WriteCompletion {
    let mut committed = 0usize;
    while committed < bytes.len() {
        match writer.write(&bytes[committed..]) {
            Ok(0) => {
                return if committed == 0 {
                    WriteCompletion::FailedZeroBytes
                } else {
                    WriteCompletion::FailedPartial {
                        committed_bytes: committed,
                    }
                };
            }
            Ok(written) => {
                committed = committed.saturating_add(written);
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => {
                return if committed == 0 {
                    WriteCompletion::FailedZeroBytes
                } else {
                    WriteCompletion::FailedPartial {
                        committed_bytes: committed,
                    }
                };
            }
        }
    }

    loop {
        match writer.flush() {
            Ok(()) => break,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => {
                return if committed == 0 {
                    WriteCompletion::FailedZeroBytes
                } else {
                    WriteCompletion::FailedPartial {
                        committed_bytes: committed,
                    }
                };
            }
        }
    }

    WriteCompletion::Committed { bytes: committed }
}

#[cfg(feature = "terminal-startup-harness")]
const HARNESS_DA1_PARTIAL_PREFIX_BYTES: usize = 3;

/// Commit only the fixed harness prefix through the real writer, including
/// its flush.  A successful prefix write is then deliberately reported as a
/// terminal partial failure so no caller can replay the uncommitted suffix.
#[cfg(feature = "terminal-startup-harness")]
fn write_da1_partial(writer: &mut Box<dyn Write + Send>, data: &[u8]) -> WriteCompletion {
    // The harness sends the seven-byte DA1 reply. Keep this defensive for
    // writer-only tests that use shorter payloads: a partial write still has
    // to contain at least one byte and remain a proper prefix.
    let prefix_len = data
        .len()
        .saturating_sub(1)
        .min(HARNESS_DA1_PARTIAL_PREFIX_BYTES);
    if prefix_len == 0 {
        return WriteCompletion::FailedZeroBytes;
    }

    match write_bytes(writer, &data[..prefix_len]) {
        WriteCompletion::Committed { bytes } => WriteCompletion::FailedPartial {
            committed_bytes: bytes,
        },
        outcome => outcome,
    }
}

fn user_failure_message(outcome: &WriteCompletion) -> String {
    match outcome {
        WriteCompletion::FailedPartial { .. } | WriteCompletion::FailedUnknown => {
            "PTY writer stopped after a partial write".to_string()
        }
        WriteCompletion::FailedZeroBytes => "PTY writer committed zero bytes".to_string(),
        WriteCompletion::RejectedBeforeWrite => "PTY writer rejected the request".to_string(),
        WriteCompletion::Committed { .. } => "PTY writer request completed".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;
    use tokio::sync::oneshot;

    #[derive(Clone)]
    struct ScriptedWriter {
        bytes: Arc<Mutex<Vec<u8>>>,
        max_write: usize,
        fail_after: Option<usize>,
        calls: Arc<Mutex<usize>>,
    }

    impl Write for ScriptedWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let mut calls = self.calls.lock().expect("calls lock");
            if self.fail_after.is_some_and(|limit| *calls >= limit) {
                return Ok(0);
            }
            *calls += 1;
            let amount = bytes.len().min(self.max_write.max(1));
            self.bytes
                .lock()
                .expect("bytes lock")
                .extend_from_slice(&bytes[..amount]);
            Ok(amount)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct InterruptedWriter {
        bytes: Arc<Mutex<Vec<u8>>>,
        write_interruptions: usize,
        flush_interruptions: usize,
    }

    impl Write for InterruptedWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.write_interruptions > 0 {
                self.write_interruptions -= 1;
                return Err(io::Error::from(io::ErrorKind::Interrupted));
            }
            self.bytes
                .lock()
                .expect("interrupted writer bytes lock")
                .extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            if self.flush_interruptions > 0 {
                self.flush_interruptions -= 1;
                return Err(io::Error::from(io::ErrorKind::Interrupted));
            }
            Ok(())
        }
    }

    struct ZeroThenWrites {
        bytes: Arc<Mutex<Vec<u8>>>,
        calls: Arc<Mutex<usize>>,
        first: bool,
    }

    impl Write for ZeroThenWrites {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            *self.calls.lock().expect("zero writer calls lock") += 1;
            if self.first {
                self.first = false;
                return Ok(0);
            }
            self.bytes
                .lock()
                .expect("zero writer bytes lock")
                .extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct BarrierWriter {
        bytes: Arc<Mutex<Vec<u8>>>,
        first_chunk_written: Option<mpsc::Sender<()>>,
        release_first_chunk: Option<mpsc::Receiver<()>>,
        first: bool,
    }

    impl Write for BarrierWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.bytes
                .lock()
                .expect("barrier writer bytes lock")
                .extend_from_slice(bytes);
            if self.first {
                self.first = false;
                self.first_chunk_written
                    .take()
                    .expect("first chunk signal")
                    .send(())
                    .expect("first chunk receiver");
                self.release_first_chunk
                    .take()
                    .expect("first chunk release")
                    .recv()
                    .expect("first chunk release sender");
            }
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    type TestWriterHandle = (PtyWriter, Arc<Mutex<Vec<u8>>>, Arc<Mutex<usize>>);

    fn new_writer(max_write: usize, fail_after: Option<usize>) -> TestWriterHandle {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let calls = Arc::new(Mutex::new(0));
        let writer = ScriptedWriter {
            bytes: Arc::clone(&bytes),
            max_write,
            fail_after,
            calls: Arc::clone(&calls),
        };
        let handle = spawn(Box::new(writer)).expect("spawn writer");
        (handle, bytes, calls)
    }

    fn user_request(data: Vec<u8>) -> (PtyInputRequest, oneshot::Receiver<Result<(), String>>) {
        let (completion, completed) = oneshot::channel();
        (PtyInputRequest { data, completion }, completed)
    }

    #[tokio::test]
    async fn explicit_write_loop_reports_partial_progress() {
        let (writer, _bytes, _calls) = new_writer(2, Some(1));
        let outcome = writer.enqueue_protocol(b"abcd");
        assert_eq!(
            outcome,
            WriteCompletion::FailedPartial { committed_bytes: 2 }
        );
    }

    #[test]
    fn interrupted_write_and_flush_are_retried() {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let writer = InterruptedWriter {
            bytes: Arc::clone(&bytes),
            write_interruptions: 2,
            flush_interruptions: 3,
        };
        let mut writer: Box<dyn Write + Send> = Box::new(writer);

        assert_eq!(
            write_bytes(&mut writer, b"retry-me"),
            WriteCompletion::Committed { bytes: 8 }
        );
        assert_eq!(*bytes.lock().expect("interrupted result lock"), b"retry-me");
    }

    #[tokio::test]
    async fn user_requests_are_fifo_and_large_requests_are_chunked() {
        let (writer, bytes, _calls) = new_writer(4096, None);
        let first = user_request(vec![b'a'; USER_WRITE_CHUNK_BYTES + 1]);
        let second = user_request(vec![b'b'; 1]);
        writer.input.send(first.0).await.expect("first enqueue");
        writer.input.send(second.0).await.expect("second enqueue");
        first
            .1
            .await
            .expect("first completion")
            .expect("first write");
        second
            .1
            .await
            .expect("second completion")
            .expect("second write");
        let bytes = bytes.lock().expect("bytes lock");
        assert_eq!(bytes.len(), USER_WRITE_CHUNK_BYTES + 2);
        assert!(bytes[..USER_WRITE_CHUNK_BYTES + 1]
            .iter()
            .all(|byte| *byte == b'a'));
        assert_eq!(bytes[USER_WRITE_CHUNK_BYTES + 1], b'b');
    }

    #[test]
    fn protocol_and_startup_precede_current_user_at_chunk_boundary() {
        assert_eq!(PROTOCOL_QUEUE_CAPACITY, 32);
        assert_eq!(STARTUP_QUEUE_CAPACITY, 1);
        assert_eq!(USER_QUEUE_CAPACITY, 1024);

        let bytes = Arc::new(Mutex::new(Vec::new()));
        let (first_chunk_written, first_chunk_ready) = mpsc::channel();
        let (release, release_first_chunk) = mpsc::channel();
        let writer = spawn(Box::new(BarrierWriter {
            bytes: Arc::clone(&bytes),
            first_chunk_written: Some(first_chunk_written),
            release_first_chunk: Some(release_first_chunk),
            first: true,
        }))
        .expect("spawn barrier writer");

        let paste_len = 1024 * 1024;
        let (first, first_done) = user_request(vec![b'u'; paste_len]);
        let (later, later_done) = user_request(vec![b'l']);
        writer.input.tx.try_send(first).expect("first user enqueue");
        writer.input.wake.try_send(()).expect("wake first user");
        first_chunk_ready
            .recv_timeout(Duration::from_secs(1))
            .expect("first chunk write barrier");

        writer.input.tx.try_send(later).expect("later user enqueue");
        let (startup_done, startup_result) = mpsc::channel();
        writer
            .startup
            .try_send(StartupWriteRequest {
                data: b"S".to_vec(),
                completion: startup_done,
            })
            .expect("startup enqueue");
        let (protocol_done, protocol_result) = mpsc::channel();
        writer
            .protocol
            .try_send(ProtocolWriteRequest::new(b"P", protocol_done))
            .expect("protocol enqueue");
        // The initial wake can still be coalesced while the worker is blocked
        // inside the first write; a full wake slot is the expected no-op.
        let _ = writer.input.wake.try_send(());
        release.send(()).expect("release first chunk");

        assert_eq!(
            protocol_result
                .recv_timeout(Duration::from_secs(1))
                .expect("protocol completion"),
            WriteCompletion::Committed { bytes: 1 }
        );
        assert_eq!(
            startup_result
                .recv_timeout(Duration::from_secs(1))
                .expect("startup completion"),
            WriteCompletion::Committed { bytes: 1 }
        );
        first_done
            .blocking_recv()
            .expect("first user completion")
            .expect("first user write");
        later_done
            .blocking_recv()
            .expect("later user completion")
            .expect("later user write");

        let mut expected = vec![b'u'; USER_WRITE_CHUNK_BYTES];
        expected.extend_from_slice(b"PS");
        expected.extend(std::iter::repeat(b'u').take(paste_len - USER_WRITE_CHUNK_BYTES));
        expected.push(b'l');
        assert_eq!(*bytes.lock().expect("barrier result lock"), expected);
    }

    #[test]
    fn zero_byte_failure_does_not_report_a_partial_commit() {
        let (writer, _bytes, _calls) = new_writer(4096, Some(0));
        assert_eq!(
            writer.enqueue_protocol(b"reply"),
            WriteCompletion::FailedZeroBytes
        );
    }

    #[test]
    fn protocol_queue_has_a_bounded_capacity() {
        let (protocol_tx, _protocol_rx) = mpsc::sync_channel(PROTOCOL_QUEUE_CAPACITY);
        let (completion, _done) = mpsc::channel();
        for _ in 0..PROTOCOL_QUEUE_CAPACITY {
            protocol_tx
                .try_send(ProtocolWriteRequest::new(&[], completion.clone()))
                .expect("capacity should accept exactly 32");
        }
        assert!(protocol_tx
            .try_send(ProtocolWriteRequest::new(&[], completion))
            .is_err());
    }

    #[test]
    fn writer_failure_resolves_pending_requests() {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let calls = Arc::new(Mutex::new(0));
        let writer = spawn(Box::new(ZeroThenWrites {
            bytes: Arc::clone(&bytes),
            calls: Arc::clone(&calls),
            first: true,
        }))
        .expect("spawn zero-then-write writer");
        let (first, first_done) = user_request(vec![b'a'; 2]);
        let (second, second_done) = user_request(vec![b'b']);
        writer.input.tx.try_send(first).expect("first enqueue");
        writer.input.tx.try_send(second).expect("second enqueue");
        writer.input.wake.try_send(()).expect("wake zero writer");
        assert!(first_done
            .blocking_recv()
            .expect("first completion")
            .is_err());
        assert!(second_done
            .blocking_recv()
            .expect("second completion")
            .is_err());
        assert!(bytes.lock().expect("zero result lock").is_empty());
        assert_eq!(*calls.lock().expect("zero calls lock"), 1);
    }

    #[cfg(feature = "terminal-startup-harness")]
    #[test]
    fn harness_none_is_the_production_protocol_path() {
        let data = b"\x1b[?1;2c";
        let (production, production_bytes, production_calls) = new_writer(4096, None);
        let (harness, harness_bytes, harness_calls) = new_writer(4096, None);

        assert_eq!(
            production.enqueue_protocol(data),
            harness.enqueue_protocol_with_da1_fault(data, HarnessDa1Fault::None)
        );
        assert_eq!(
            *production_bytes.lock().expect("production bytes"),
            *harness_bytes.lock().expect("harness bytes")
        );
        assert_eq!(
            *production_calls.lock().expect("production calls"),
            *harness_calls.lock().expect("harness calls")
        );
    }

    #[cfg(feature = "terminal-startup-harness")]
    #[test]
    fn harness_reject_is_before_admission_and_does_not_write() {
        let (writer, bytes, calls) = new_writer(4096, None);

        assert_eq!(
            writer.enqueue_protocol_with_da1_fault(b"reply", HarnessDa1Fault::Reject),
            WriteCompletion::RejectedBeforeWrite
        );
        assert!(bytes.lock().expect("reject bytes").is_empty());
        assert_eq!(*calls.lock().expect("reject calls"), 0);

        assert_eq!(
            writer.enqueue_protocol(b"ok"),
            WriteCompletion::Committed { bytes: 2 }
        );
        assert_eq!(*bytes.lock().expect("post-reject bytes"), b"ok");
    }

    #[cfg(feature = "terminal-startup-harness")]
    #[test]
    fn harness_zero_is_admitted_without_writing_and_keeps_writer_usable() {
        let (writer, bytes, calls) = new_writer(4096, None);

        assert_eq!(
            writer.enqueue_protocol_with_da1_fault(b"reply", HarnessDa1Fault::Zero),
            WriteCompletion::FailedZeroBytes
        );
        assert!(bytes.lock().expect("zero bytes").is_empty());
        assert_eq!(*calls.lock().expect("zero calls"), 0);

        assert_eq!(
            writer.enqueue_protocol(b"ok"),
            WriteCompletion::Committed { bytes: 2 }
        );
        assert_eq!(*bytes.lock().expect("post-zero bytes"), b"ok");
        assert_eq!(*calls.lock().expect("post-zero calls"), 1);
    }

    #[cfg(feature = "terminal-startup-harness")]
    #[test]
    fn harness_partial_writes_one_prefix_then_drains_terminally() {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let calls = Arc::new(Mutex::new(0));
        let writer = spawn(Box::new(ScriptedWriter {
            bytes: Arc::clone(&bytes),
            max_write: 4096,
            fail_after: None,
            calls: Arc::clone(&calls),
        }))
        .expect("partial writer");

        let (user, user_done) = user_request(b"user".to_vec());
        writer.input.tx.try_send(user).expect("queue user");
        let (startup_done, startup_result) = mpsc::channel();
        writer
            .startup
            .try_send(StartupWriteRequest {
                data: b"startup".to_vec(),
                completion: startup_done,
            })
            .expect("queue startup");

        let reply = b"\x1b[?1;2c";
        assert_eq!(
            writer.enqueue_protocol_with_da1_fault(reply, HarnessDa1Fault::Partial),
            WriteCompletion::FailedPartial { committed_bytes: 3 }
        );
        assert_eq!(*bytes.lock().expect("partial bytes"), &reply[..3]);
        assert_eq!(*calls.lock().expect("partial calls"), 1);
        assert!(user_done
            .blocking_recv()
            .expect("drained user completion")
            .is_err());
        assert_eq!(
            startup_result
                .recv_timeout(Duration::from_secs(1))
                .expect("drained startup completion"),
            WriteCompletion::RejectedBeforeWrite
        );
    }

    #[cfg(feature = "terminal-startup-harness")]
    #[test]
    fn harness_partial_returns_truthful_underlying_prefix_failure() {
        let (writer, bytes, calls) = new_writer(2, Some(1));
        let reply = b"\x1b[?1;2c";

        assert_eq!(
            writer.enqueue_protocol_with_da1_fault(reply, HarnessDa1Fault::Partial),
            WriteCompletion::FailedPartial { committed_bytes: 2 }
        );
        assert_eq!(*bytes.lock().expect("failed partial bytes"), &reply[..2]);
        assert_eq!(*calls.lock().expect("failed partial calls"), 1);
    }

    #[cfg(feature = "terminal-startup-harness")]
    #[test]
    fn harness_unknown_writes_nothing_and_drains_terminally() {
        let (writer, bytes, calls) = {
            let bytes = Arc::new(Mutex::new(Vec::new()));
            let calls = Arc::new(Mutex::new(0));
            let writer = spawn_blocked_for_startup(Box::new(ScriptedWriter {
                bytes: Arc::clone(&bytes),
                max_write: 4096,
                fail_after: None,
                calls: Arc::clone(&calls),
            }))
            .expect("unknown writer");
            (writer, bytes, calls)
        };
        let (user, user_done) = user_request(b"user".to_vec());
        writer.input.tx.try_send(user).expect("queue user");

        assert_eq!(
            writer.enqueue_protocol_with_da1_fault(b"\x1b[?1;2c", HarnessDa1Fault::Unknown),
            WriteCompletion::FailedUnknown
        );
        assert!(bytes.lock().expect("unknown bytes").is_empty());
        assert_eq!(*calls.lock().expect("unknown calls"), 0);
        assert!(user_done
            .blocking_recv()
            .expect("drained unknown user")
            .is_err());
        assert_eq!(
            writer.enqueue_protocol(b"after"),
            WriteCompletion::RejectedBeforeWrite
        );
    }

    #[cfg(feature = "terminal-startup-harness")]
    #[test]
    fn harness_protocol_fault_keeps_protocol_priority_over_startup_and_user() {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let writer = spawn_blocked_for_startup(Box::new(ScriptedWriter {
            bytes: Arc::clone(&bytes),
            max_write: 4096,
            fail_after: None,
            calls: Arc::new(Mutex::new(0)),
        }))
        .expect("priority writer");
        let (user, user_done) = user_request(b"U".to_vec());
        writer.input.tx.try_send(user).expect("queue user");
        let (startup_done, startup_result) = mpsc::channel();
        writer
            .startup
            .try_send(StartupWriteRequest {
                data: b"S".to_vec(),
                completion: startup_done,
            })
            .expect("queue startup");

        assert_eq!(
            writer.enqueue_protocol_with_da1_fault(b"reply", HarnessDa1Fault::Zero),
            WriteCompletion::FailedZeroBytes
        );
        assert_eq!(
            startup_result
                .recv_timeout(Duration::from_secs(1))
                .expect("startup completion"),
            WriteCompletion::Committed { bytes: 1 }
        );
        user_done
            .blocking_recv()
            .expect("user completion")
            .expect("user write");
        assert_eq!(*bytes.lock().expect("priority bytes"), b"SU");
    }

    #[allow(dead_code)]
    fn _worker_is_sendable() {
        fn assert_send<T: Send>() {}
        assert_send::<PtyWriter>();
        let _ = thread::current();
    }
}
