//! Reliable provider-event ingress for the single durability projection.
//!
//! Provider readers cannot wait for SQLite: several emit while holding their
//! own worker state, while projection takes the provider registry fence.  The
//! primary queue therefore stays non-blocking with respect to the consumer.
//! A small in-memory prefix spills to an owned append-only file when the
//! consumer falls behind.  The broadcast sender is only an observation tap;
//! lagging tap receivers never affect durable projection.

use crate::providers::ProviderEvent;
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fmt,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
};
use tokio::sync::broadcast;
use uuid::Uuid;

const TAP_CAPACITY: usize = 1_024;
const MEMORY_EVENT_LIMIT: usize = 256;
const MEMORY_BYTE_LIMIT: usize = 512 * 1_024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProviderEvent {
    provider: String,
    session_id: String,
    native_id: Option<String>,
    turn_id: Option<String>,
    kind: String,
    data: serde_json::Value,
    /// `ProviderEvent` intentionally omits this from public serialization.
    /// The private spool must retain it for generation fencing.
    worker_token: Option<String>,
}

impl From<&ProviderEvent> for StoredProviderEvent {
    fn from(event: &ProviderEvent) -> Self {
        Self {
            provider: event.provider.clone(),
            session_id: event.session_id.clone(),
            native_id: event.native_id.clone(),
            turn_id: event.turn_id.clone(),
            kind: event.kind.clone(),
            data: event.data.clone(),
            worker_token: event.worker_token.clone(),
        }
    }
}

impl From<StoredProviderEvent> for ProviderEvent {
    fn from(event: StoredProviderEvent) -> Self {
        Self {
            provider: event.provider,
            session_id: event.session_id,
            native_id: event.native_id,
            turn_id: event.turn_id,
            kind: event.kind,
            data: event.data,
            worker_token: event.worker_token,
        }
    }
}

struct Spool {
    path: PathBuf,
    file: File,
    read_offset: u64,
    pending: usize,
}

struct QueueState {
    memory: VecDeque<Vec<u8>>,
    memory_bytes: usize,
    spool: Option<Spool>,
    /// Tail retained in memory only after spool I/O fails. It is separate so
    /// it can never overtake an older spool backlog.
    fallback_tail: VecDeque<Vec<u8>>,
    fallback_bytes: usize,
    spool_failed: bool,
    failure: Option<String>,
    senders: usize,
    receiver_closed: bool,
}

struct QueueInner {
    state: Mutex<QueueState>,
    ready: Condvar,
    spool_dir: PathBuf,
}

impl QueueInner {
    fn new(spool_dir: PathBuf) -> Self {
        Self {
            state: Mutex::new(QueueState {
                memory: VecDeque::new(),
                memory_bytes: 0,
                spool: None,
                fallback_tail: VecDeque::new(),
                fallback_bytes: 0,
                spool_failed: false,
                failure: None,
                senders: 1,
                receiver_closed: false,
            }),
            ready: Condvar::new(),
            spool_dir,
        }
    }

    fn enqueue(&self, bytes: Vec<u8>) -> Result<(), SendError> {
        let mut state = self.state.lock().map_err(|_| SendError)?;
        if state.receiver_closed || state.failure.is_some() {
            return Err(SendError);
        }
        let fits_memory = !state.spool_failed
            && state.spool.is_none()
            && state.memory.len() < MEMORY_EVENT_LIMIT
            && state.memory_bytes.saturating_add(bytes.len()) <= MEMORY_BYTE_LIMIT;
        if fits_memory {
            state.memory_bytes += bytes.len();
            state.memory.push_back(bytes);
        } else if state.spool_failed {
            state.fallback_bytes += bytes.len();
            state.fallback_tail.push_back(bytes);
        } else if let Err(error) = append_spool(&self.spool_dir, &mut state.spool, &bytes) {
            // A filesystem failure cannot be made both bounded and lossless.
            // Keep correctness for the live process and surface the loss of the
            // normal memory bound instead of silently discarding a chat event.
            eprintln!("provider event spool unavailable; retaining event in memory: {error}");
            state.spool_failed = true;
            state.fallback_bytes += bytes.len();
            state.fallback_tail.push_back(bytes);
        }
        drop(state);
        self.ready.notify_one();
        Ok(())
    }

    fn try_pop(&self, state: &mut QueueState) -> Result<Option<ProviderEvent>, RecvError> {
        if let Some(failure) = &state.failure {
            return Err(RecvError::Failed(failure.clone()));
        }
        let bytes = if let Some(bytes) = state.memory.pop_front() {
            state.memory_bytes = state.memory_bytes.saturating_sub(bytes.len());
            Some(bytes)
        } else if state.spool.as_ref().is_some_and(|spool| spool.pending > 0) {
            match read_spool(&mut state.spool) {
                Ok(bytes) => Some(bytes),
                Err(error) => {
                    let failure = format!("provider event spool could not be read: {error}");
                    eprintln!("{failure}");
                    state.failure = Some(failure.clone());
                    return Err(RecvError::Failed(failure));
                }
            }
        } else if let Some(bytes) = state.fallback_tail.pop_front() {
            state.fallback_bytes = state.fallback_bytes.saturating_sub(bytes.len());
            if state.fallback_tail.is_empty() {
                state.spool_failed = false;
            }
            Some(bytes)
        } else {
            None
        };
        let Some(bytes) = bytes else {
            return Ok(None);
        };
        let stored: StoredProviderEvent = match serde_json::from_slice(&bytes) {
            Ok(stored) => stored,
            Err(error) => {
                let failure = format!("provider event queue contained an invalid record: {error}");
                eprintln!("{failure}");
                state.failure = Some(failure.clone());
                return Err(RecvError::Failed(failure));
            }
        };
        Ok(Some(stored.into()))
    }

    fn close_receiver(&self) {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        state.receiver_closed = true;
        state.memory.clear();
        state.memory_bytes = 0;
        state.fallback_tail.clear();
        state.fallback_bytes = 0;
        remove_spool(&mut state.spool);
        drop(state);
        self.ready.notify_all();
    }
}

impl Drop for QueueInner {
    fn drop(&mut self) {
        if let Ok(state) = self.state.get_mut() {
            remove_spool(&mut state.spool);
        }
    }
}

fn append_spool(dir: &Path, spool: &mut Option<Spool>, bytes: &[u8]) -> std::io::Result<()> {
    if spool.is_none() {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(format!("provider-events-{}.spool", Uuid::new_v4()));
        let file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)?;
        *spool = Some(Spool {
            path,
            file,
            read_offset: 0,
            pending: 0,
        });
    }
    let spool = spool.as_mut().expect("spool initialized");
    let original_len = spool.file.metadata()?.len();
    spool.file.seek(SeekFrom::End(0))?;
    let result = spool
        .file
        .write_all(&(bytes.len() as u64).to_le_bytes())
        .and_then(|_| spool.file.write_all(bytes));
    if let Err(error) = result {
        let _ = spool.file.set_len(original_len);
        return Err(error);
    }
    spool.pending += 1;
    Ok(())
}

fn read_spool(spool: &mut Option<Spool>) -> std::io::Result<Vec<u8>> {
    let current = spool.as_mut().expect("pending spool");
    current.file.seek(SeekFrom::Start(current.read_offset))?;
    let mut header = [0_u8; 8];
    current.file.read_exact(&mut header)?;
    let length_u64 = u64::from_le_bytes(header);
    let file_len = current.file.metadata()?.len();
    let remaining = file_len.saturating_sub(current.read_offset.saturating_add(8));
    if length_u64 > remaining {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "provider event spool record extends past end of file",
        ));
    }
    let length = usize::try_from(length_u64).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "provider event spool record cannot fit in address space",
        )
    })?;
    let mut bytes = vec![0_u8; length];
    current.file.read_exact(&mut bytes)?;
    current.read_offset += 8 + length as u64;
    current.pending -= 1;
    if current.pending == 0 {
        remove_spool(spool);
    }
    Ok(bytes)
}

fn remove_spool(spool: &mut Option<Spool>) {
    if let Some(spool) = spool.take() {
        let path = spool.path.clone();
        drop(spool);
        if let Err(error) = std::fs::remove_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "provider event spool cleanup failed for {}: {error}",
                    path.display()
                );
            }
        }
    }
}

pub(crate) struct Sender {
    queue: Option<Arc<QueueInner>>,
    tap: broadcast::Sender<ProviderEvent>,
}

impl Clone for Sender {
    fn clone(&self) -> Self {
        if let Some(queue) = &self.queue {
            if let Ok(mut state) = queue.state.lock() {
                state.senders += 1;
            }
        }
        Self {
            queue: self.queue.clone(),
            tap: self.tap.clone(),
        }
    }
}

impl Drop for Sender {
    fn drop(&mut self) {
        let Some(queue) = &self.queue else {
            return;
        };
        let mut state = match queue.state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        state.senders = state.senders.saturating_sub(1);
        let closed = state.senders == 0;
        drop(state);
        if closed {
            queue.ready.notify_all();
        }
    }
}

impl Sender {
    pub(crate) fn send(&self, event: ProviderEvent) -> Result<(), SendError> {
        let primary = if let Some(queue) = &self.queue {
            let bytes =
                serde_json::to_vec(&StoredProviderEvent::from(&event)).map_err(|_| SendError)?;
            queue.enqueue(bytes)
        } else {
            Ok(())
        };
        let _ = self.tap.send(event);
        primary
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<ProviderEvent> {
        self.tap.subscribe()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SendError;

impl fmt::Display for SendError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("provider event receiver is closed")
    }
}

pub(crate) struct ProjectionReceiver {
    queue: Arc<QueueInner>,
}

impl ProjectionReceiver {
    pub(crate) fn blocking_recv(&mut self) -> Result<ProviderEvent, RecvError> {
        let mut state = self.queue.state.lock().map_err(|_| RecvError::Closed)?;
        loop {
            if let Some(event) = self.queue.try_pop(&mut state)? {
                return Ok(event);
            }
            if state.receiver_closed || state.senders == 0 {
                return Err(RecvError::Closed);
            }
            state = self
                .queue
                .ready
                .wait(state)
                .map_err(|_| RecvError::Closed)?;
        }
    }

    pub(crate) fn try_recv(&mut self) -> Result<ProviderEvent, TryRecvError> {
        let mut state = self.queue.state.lock().map_err(|_| TryRecvError::Closed)?;
        match self.queue.try_pop(&mut state) {
            Ok(Some(event)) => Ok(event),
            Ok(None) if state.receiver_closed || state.senders == 0 => Err(TryRecvError::Closed),
            Ok(None) => Err(TryRecvError::Empty),
            Err(RecvError::Closed) => Err(TryRecvError::Closed),
            Err(RecvError::Failed(reason)) => Err(TryRecvError::Failed(reason)),
        }
    }
}

impl Drop for ProjectionReceiver {
    fn drop(&mut self) {
        self.queue.close_receiver();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RecvError {
    Closed,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TryRecvError {
    Empty,
    Closed,
    Failed(String),
}

pub(crate) fn channel(spool_dir: &Path) -> (Sender, ProjectionReceiver) {
    let (tap, _) = broadcast::channel(TAP_CAPACITY);
    let queue = Arc::new(QueueInner::new(spool_dir.to_owned()));
    (
        Sender {
            queue: Some(Arc::clone(&queue)),
            tap,
        },
        ProjectionReceiver { queue },
    )
}

/// Tap-only sender used by isolated adapter probes and unit tests which do not
/// own the runtime's durability projection.
pub(crate) fn tap_channel(capacity: usize) -> (Sender, broadcast::Receiver<ProviderEvent>) {
    let (tap, receiver) = broadcast::channel(capacity);
    (Sender { queue: None, tap }, receiver)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(index: usize, worker_token: &str) -> ProviderEvent {
        ProviderEvent {
            provider: "codex".into(),
            session_id: "session".into(),
            native_id: Some("native".into()),
            turn_id: Some("turn".into()),
            kind: if index == 1_500 {
                "chat.turn.completed"
            } else {
                "chat.delta"
            }
            .into(),
            data: json!({"index":index,"part":{"type":"text","text":"x".repeat(4096)}}),
            worker_token: Some(worker_token.into()),
        }
    }

    #[test]
    fn stalled_consumer_spools_fifo_without_losing_worker_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let unrelated = dir.path().join("keep-me.txt");
        std::fs::write(&unrelated, "unrelated").unwrap();
        let (sender, mut receiver) = channel(dir.path());
        let mut observer = sender.subscribe();
        for index in 0..2_048 {
            sender.send(event(index, "worker-generation")).unwrap();
        }
        let queue = sender.queue.as_ref().unwrap();
        let state = queue.state.lock().unwrap();
        assert!(state.memory.len() <= MEMORY_EVENT_LIMIT);
        assert!(state.memory_bytes <= MEMORY_BYTE_LIMIT);
        drop(state);
        let spool_paths = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("spool"))
            .collect::<Vec<_>>();
        assert_eq!(
            spool_paths.len(),
            1,
            "large stalled burst must spill to one owned file"
        );
        for index in 0..2_048 {
            let observed = receiver.blocking_recv().unwrap();
            assert_eq!(observed.data["index"], index);
            assert_eq!(observed.worker_token.as_deref(), Some("worker-generation"));
            assert_eq!(
                observed.kind,
                if index == 1_500 {
                    "chat.turn.completed"
                } else {
                    "chat.delta"
                }
            );
        }
        assert!(matches!(
            observer.try_recv(),
            Err(broadcast::error::TryRecvError::Lagged(_))
        ));
        assert!(unrelated.exists());
        assert!(!std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .any(|path| path.extension().and_then(|value| value.to_str()) == Some("spool")));
    }

    #[test]
    fn dropping_receiver_removes_an_owned_spool() {
        let dir = tempfile::tempdir().unwrap();
        let unrelated = dir.path().join("keep-me.txt");
        std::fs::write(&unrelated, "unrelated").unwrap();
        let (sender, receiver) = channel(dir.path());
        for index in 0..512 {
            sender.send(event(index, "worker")).unwrap();
        }
        assert!(std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .any(|path| path.extension().and_then(|value| value.to_str()) == Some("spool")));
        drop(receiver);
        assert!(unrelated.exists());
        assert!(!std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .any(|path| path.extension().and_then(|value| value.to_str()) == Some("spool")));
        assert_eq!(sender.send(event(513, "worker")), Err(SendError));
    }

    #[test]
    fn spool_write_failure_keeps_the_new_tail_after_the_old_spool_backlog() {
        let dir = tempfile::tempdir().unwrap();
        let (sender, mut receiver) = channel(dir.path());
        for index in 0..512 {
            sender.send(event(index, "worker")).unwrap();
        }
        {
            let queue = sender.queue.as_ref().unwrap();
            let mut state = queue.state.lock().unwrap();
            let spool = state.spool.as_mut().expect("burst spilled");
            spool.file = OpenOptions::new().read(true).open(&spool.path).unwrap();
        }
        sender.send(event(512, "worker")).unwrap();
        sender.send(event(513, "worker")).unwrap();
        for index in 0..514 {
            assert_eq!(receiver.blocking_recv().unwrap().data["index"], index);
        }
    }

    #[test]
    fn unreadable_spool_reports_failure_instead_of_clean_channel_closure() {
        let dir = tempfile::tempdir().unwrap();
        let (sender, mut receiver) = channel(dir.path());
        for index in 0..512 {
            sender.send(event(index, "worker")).unwrap();
        }
        let prefix = {
            let state = sender.queue.as_ref().unwrap().state.lock().unwrap();
            state.spool.as_ref().unwrap().file.set_len(0).unwrap();
            state.memory.len()
        };
        for index in 0..prefix {
            assert_eq!(receiver.blocking_recv().unwrap().data["index"], index);
        }
        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Failed(_))));
        assert!(matches!(
            receiver.blocking_recv(),
            Err(RecvError::Failed(_))
        ));
        assert_eq!(sender.send(event(512, "worker")), Err(SendError));
    }
}
