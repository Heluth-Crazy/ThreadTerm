use super::*;
use std::io::{self, Write};
use std::sync::{mpsc, Arc, Mutex};

struct RecordingWriter {
    bytes: Arc<Mutex<Vec<u8>>>,
    events: mpsc::Sender<Vec<u8>>,
    partial: Option<usize>,
}

impl Write for RecordingWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if let Some(limit) = self.partial.take() {
            if limit == 0 {
                self.partial = Some(0);
                return Ok(0);
            }
            let count = data.len().min(limit);
            self.bytes
                .lock()
                .expect("recording bytes")
                .extend_from_slice(&data[..count]);
            self.events
                .send(data[..count].to_vec())
                .expect("event receiver");
            self.partial = Some(0);
            return Ok(count);
        }
        self.bytes
            .lock()
            .expect("recording bytes")
            .extend_from_slice(data);
        self.events.send(data.to_vec()).expect("event receiver");
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn request(
    data: &[u8],
) -> (
    PtyInputRequest,
    tokio::sync::oneshot::Receiver<Result<(), String>>,
) {
    let (completion, done) = tokio::sync::oneshot::channel();
    (
        PtyInputRequest {
            data: data.to_vec(),
            completion,
        },
        done,
    )
}

#[test]
fn blocked_user_cannot_overtake_protocol_or_startup() {
    let (events, seen) = mpsc::channel();
    let writer = spawn_blocked_for_startup(Box::new(RecordingWriter {
        bytes: Arc::new(Mutex::new(Vec::new())),
        events,
        partial: None,
    }))
    .expect("gated writer");
    let (user, mut user_done) = request(b"U");
    writer.input.tx.try_send(user).expect("queue user");
    writer.input.wake.try_send(()).expect("wake user");

    assert_eq!(
        writer.enqueue_protocol(b"P"),
        WriteCompletion::Committed { bytes: 1 }
    );
    assert_eq!(seen.recv().expect("protocol event"), b"P");
    assert!(matches!(
        user_done.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
}

#[test]
fn committed_startup_opens_gate_before_fifo_user_resume() {
    let (events, seen) = mpsc::channel();
    let writer = spawn_blocked_for_startup(Box::new(RecordingWriter {
        bytes: Arc::new(Mutex::new(Vec::new())),
        events,
        partial: None,
    }))
    .expect("gated writer");
    let (user, user_done) = request(b"U");
    writer.input.tx.try_send(user).expect("queue user");
    writer.input.wake.try_send(()).expect("wake user");

    assert_eq!(
        writer.enqueue_startup(b"S"),
        WriteCompletion::Committed { bytes: 1 }
    );
    assert_eq!(seen.recv().expect("startup event"), b"S");
    user_done
        .blocking_recv()
        .expect("user completion")
        .expect("user write");
    assert_eq!(seen.recv().expect("user event"), b"U");
}

#[test]
fn startup_zero_and_partial_failures_keep_gate_closed_and_fail_users() {
    for (startup, partial) in [(b"S".as_slice(), Some(0)), (b"START".as_slice(), Some(2))] {
        let (events, _seen) = mpsc::channel();
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let expected = if partial == Some(0) {
            Vec::new()
        } else {
            b"ST".to_vec()
        };
        let writer = spawn_blocked_for_startup(Box::new(RecordingWriter {
            bytes: Arc::clone(&bytes),
            events,
            partial,
        }))
        .expect("gated writer");
        let (user, user_done) = request(b"U");
        writer.input.tx.try_send(user).expect("queue user");
        writer.input.wake.try_send(()).expect("wake user");
        let outcome = writer.enqueue_startup(startup);
        assert!(matches!(
            outcome,
            WriteCompletion::FailedZeroBytes | WriteCompletion::FailedPartial { .. }
        ));
        assert!(user_done.blocking_recv().expect("user completion").is_err());
        assert_eq!(*bytes.lock().expect("failure bytes"), expected);
    }
}

#[test]
fn legacy_spawn_keeps_user_lane_open() {
    let (events, seen) = mpsc::channel();
    let writer = spawn(Box::new(RecordingWriter {
        bytes: Arc::new(Mutex::new(Vec::new())),
        events,
        partial: None,
    }))
    .expect("legacy writer");
    let (user, user_done) = request(b"U");
    writer.input.tx.try_send(user).expect("queue user");
    writer.input.wake.try_send(()).expect("wake user");
    user_done
        .blocking_recv()
        .expect("user completion")
        .expect("user write");
    assert_eq!(seen.recv().expect("legacy event"), b"U");
}
