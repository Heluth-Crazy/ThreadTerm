use crate::db::Database;
use crate::output_loss::{LossRecord, SidecarWriter};
use anyhow::Result;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
use tokio::sync::Notify;

#[cfg(test)]
#[path = "output_bench_tests.rs"]
mod output_bench_tests;

#[cfg(test)]
#[path = "output_retry_tests.rs"]
mod output_retry_tests;

/// Bytes a stream may hold while the database refuses them. Dropping older
/// bytes advances the durable cursor past them, so a client reads an explicit
/// history gap instead of silently missing output.
const MAX_PENDING_BYTES: usize = 4 * 1024 * 1024;
/// Lock order: map (lookup only, released before stream) -> session stream -> commit gate -> DB.
/// Notifications run after releasing every lock.
pub struct OutputStore {
    streams: Mutex<HashMap<String, Arc<Mutex<Stream>>>>,
    /// Output INSERTs queue here, one at a time, instead of all contending for the DB connection mutex, which is
    /// not fair: with eight flooding sessions, other requests' DB reads waited about 4x longer (output flood
    /// benchmark, 10-31-output-storage-path).
    commit_gate: Mutex<()>,
    notify: Notify,
    retry: Arc<(Mutex<RetryState>, Condvar)>,
    pending_bytes: AtomicUsize,
    // Independent of stream/DB locks so shutdown can snapshot a blocked retry.
    losses: Mutex<HashMap<String, LossRecord>>,
    sidecars: OnceLock<SidecarWriter>,
}
#[derive(Debug, PartialEq, Eq)]
pub enum FlushOutcome {
    Clean { durable_end: i64 },
    Retryable { pending_bytes: usize },
}
#[derive(Default)]
struct RetryState {
    started: bool,
    stopped: bool,
    generation: u64,
}
struct Stream {
    /// The durable cursor: only advanced after the database accepted the bytes.
    cursor: i64,
    /// Set by `seed` or by the first commit with bytes, which reads the persisted
    /// end itself so a relaunched session never reuses a taken offset.
    seeded: bool,
    retention_check_at: i64,
    /// Drained bytes the database has not accepted yet (see `append`).
    pending: Vec<u8>,
    degraded: bool,
    marker_pending: bool,
    retry_at: Instant,
    backoff: Duration,
}
impl Stream {
    fn new() -> Self {
        Self {
            cursor: 0,
            seeded: false,
            retention_check_at: crate::retention::ACTIVE_TERMINAL_BYTES + crate::retention::ACTIVE_OUTPUT_MARGIN,
            pending: Vec::new(),
            degraded: false,
            marker_pending: false,
            retry_at: Instant::now(),
            backoff: Duration::from_millis(250),
        }
    }
}
impl OutputStore {
    fn stream(&self, session_id: &str) -> Arc<Mutex<Stream>> {
        self.streams
            .lock()
            .expect("output lock poisoned")
            .entry(session_id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(Stream::new())))
            .clone()
    }

    /// Persists one drained chunk and returns its durable start offset.
    ///
    /// Storage failure policy: the durable cursor advances only after the
    /// database accepted the bytes. A refused chunk stays in `pending`, the
    /// terminal is marked storage-degraded, and the next chunk retries the
    /// whole pending prefix in one write. Shared appends also schedule quiet-tail
    /// retries; EOF and shutdown explicitly flush. The PTY reader keeps draining
    /// (pty.rs), so the child never blocks on a full console pipe; the live
    /// view resumes from the unchanged cursor once storage accepts data again.
    /// The stream lock is held across the write on purpose: two appends for one
    /// session must never compute the same start offset.
    pub fn append(&self, db: &Database, session_id: &str, data: &[u8]) -> Result<i64> {
        let stream = self.stream(session_id);
        let mut stream = stream.lock().expect("stream lock poisoned");
        let result = self.commit(db, session_id, &mut stream, data);
        drop(stream);
        if result.is_ok() {
            self.notify.notify_waiters();
        }
        result
    }

    /// Production append: supplies the shared DB for the lazily started retry worker.
    pub fn append_shared(
        self: &Arc<Self>,
        db: &Arc<Database>,
        session_id: &str,
        data: &[u8],
    ) -> Result<i64> {
        let result = self.append(db, session_id, data);
        let retry = result.is_err() || self.stream(session_id).lock().unwrap().degraded;
        if retry {
            self.start_retry_worker(db);
        }
        result
    }

    pub fn flush_pending(&self, db: &Database, session_id: &str) -> Result<FlushOutcome> {
        let stream = self.stream(session_id);
        let mut stream = stream.lock().expect("stream lock poisoned");
        let result = self.commit(db, session_id, &mut stream, &[]);
        let committed = result.is_ok();
        let outcome = match result {
            Ok(_) => FlushOutcome::Clean {
                durable_end: stream.cursor,
            },
            _ => FlushOutcome::Retryable {
                pending_bytes: stream.pending.len(),
            },
        };
        drop(stream);
        if committed {
            self.notify.notify_waiters();
        }
        Ok(outcome)
    }

    fn commit(
        &self,
        db: &Database,
        session_id: &str,
        stream: &mut Stream,
        data: &[u8],
    ) -> Result<i64> {
        let mut batch = std::mem::take(&mut stream.pending);
        batch.extend_from_slice(data);
        self.pending_bytes.fetch_add(data.len(), Ordering::Relaxed);
        if batch.is_empty() {
            self.recover_marker(db, session_id, stream);
            return Ok(stream.cursor);
        }
        // Include in-flight bytes from the first moment: a shutdown cannot take
        // this stream lock while the append is waiting for the database, and the
        // self-seed read below is such a wait.
        self.losses.lock().unwrap().insert(
            session_id.to_owned(), LossRecord::new(session_id, stream.cursor, batch.len()),
        );
        // A relaunched session continues the retained byte stream: the entry
        // learns the persisted end itself, so an append can never reuse a taken
        // offset even when the caller forgot (or had no reason) to `seed`.
        if !stream.seeded {
            match db.output_end(session_id) {
                Ok(end) => {
                    stream.seeded = true;
                    stream.cursor = stream.cursor.max(end);
                }
                Err(error) => return self.refuse(db, session_id, stream, batch, error),
            }
        }
        // Bounded memory: discarded bytes are skipped by advancing the durable
        // cursor, which leaves a gap the output transport reports explicitly.
        if batch.len() > MAX_PENDING_BYTES {
            let dropped = batch.len() - MAX_PENDING_BYTES;
            batch.drain(..dropped);
            self.pending_bytes.fetch_sub(dropped, Ordering::Relaxed);
            stream.cursor += dropped as i64;
        }
        let start = stream.cursor;
        // Include in-flight bytes: shutdown cannot take this stream lock while
        // its first INSERT is waiting for the database connection.
        self.losses.lock().unwrap().insert(
            session_id.to_owned(), LossRecord::new(session_id, start, batch.len()),
        );
        let written = {
            let _gate = self.commit_gate.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            db.append_output(session_id, start, &batch)
        };
        if let Err(error) = written {
            return self.refuse(db, session_id, stream, batch, error);
        }
        self.pending_bytes.fetch_sub(batch.len(), Ordering::Relaxed);
        self.losses.lock().unwrap().remove(session_id);
        stream.cursor += batch.len() as i64;
        if stream.cursor > stream.retention_check_at {
            // One indexed retained-start check per margin, never a scan/trim per chunk.
            // Failed checks retry on a later append without making a durable write fail.
            match db.output_start(session_id) {
                Ok(Some(from)) => {
                    if stream.cursor - from > crate::retention::ACTIVE_TERMINAL_BYTES + crate::retention::ACTIVE_OUTPUT_MARGIN {
                        db.schedule_retention();
                        stream.retention_check_at = stream.cursor + crate::retention::ACTIVE_OUTPUT_MARGIN;
                    } else {
                        stream.retention_check_at = from + crate::retention::ACTIVE_TERMINAL_BYTES + crate::retention::ACTIVE_OUTPUT_MARGIN;
                    }
                }
                Ok(None) => {}
                Err(error) => eprintln!("Output retention check deferred: {error:#}"),
            }
        }
        self.recover_marker(db, session_id, stream);
        Ok(start)
    }

    /// A refused write and a refused self-seed take the same path: the bytes stay
    /// pending, the terminal is marked storage-degraded, and the retry worker
    /// owns the stream until the database accepts them.
    fn refuse(
        &self,
        db: &Database,
        session_id: &str,
        stream: &mut Stream,
        batch: Vec<u8>,
        error: anyhow::Error,
    ) -> Result<i64> {
        let start = stream.cursor;
        stream.pending = batch;
        if !stream.degraded {
            stream.degraded = true;
            stream.retry_at = Instant::now() + Duration::from_millis(250);
            eprintln!("Terminal output for {session_id} could not be saved: {error}");
            // Record independently before trying the marker: its connection
            // mutex may itself be blocked after the refused output INSERT.
            self.losses.lock().unwrap().insert(
                session_id.to_owned(), LossRecord::new(session_id, start, stream.pending.len()),
            );
            self.sidecars(db).write(LossRecord::new(session_id, start, stream.pending.len()));
            stream.marker_pending = db.mark_terminal_storage_degraded(session_id, start).is_err();
        }
        Err(error)
    }

    /// Drops a finished session's entry. The retry worker still owns a stream
    /// with pending bytes or a degraded marker, so those stay.
    pub fn forget(&self, session_id: &str) {
        let mut streams = self.streams.lock().expect("output lock poisoned");
        let idle = match streams.get(session_id) {
            None => false,
            Some(stream) => match stream.try_lock() {
                Err(_) => false,
                Ok(stream) => stream.pending.is_empty() && !stream.degraded,
            },
        };
        if idle {
            streams.remove(session_id);
        }
    }

    fn sidecars(&self, db: &Database) -> &SidecarWriter {
        self.sidecars.get_or_init(|| SidecarWriter::new(db.path()))
    }

    fn recover_marker(&self, db: &Database, session_id: &str, stream: &mut Stream) {
        if stream.degraded && db.clear_terminal_storage_degraded(session_id).is_ok() {
            stream.degraded = false;
            stream.marker_pending = false;
            self.losses.lock().unwrap().remove(session_id);
            self.sidecars(db).remove(session_id);
            eprintln!("Terminal output storage recovered for {session_id}");
        }
        if !stream.degraded {
            stream.backoff = Duration::from_millis(250);
        }
    }
    fn snapshot(&self) -> Vec<(String, Arc<Mutex<Stream>>)> {
        self.streams
            .lock()
            .expect("output lock poisoned")
            .iter()
            .map(|(id, stream)| (id.clone(), stream.clone()))
            .collect()
    }

    fn start_retry_worker(self: &Arc<Self>, db: &Arc<Database>) {
        let (state, wake) = &*self.retry;
        let mut state = state.lock().unwrap();
        state.generation = state.generation.wrapping_add(1);
        wake.notify_one();
        if state.started || state.stopped {
            return;
        }
        state.started = true;
        let store = Arc::downgrade(self);
        let db = Arc::downgrade(db);
        let signal = self.retry.clone();
        if let Err(error) = thread::Builder::new()
            .name("output-retry".into())
            .spawn(move || loop {
                let generation = {
                    let state = signal.0.lock().unwrap();
                    if state.stopped {
                        break;
                    }
                    state.generation
                };
                let Some(store) = store.upgrade() else {
                    break;
                };
                let Some(db) = db.upgrade() else {
                    break;
                };
                let mut sleep = None;
                for (id, stream) in store.snapshot() {
                    if signal.0.lock().unwrap().stopped {
                        break;
                    }
                    let Ok(mut stream) = stream.try_lock() else {
                        sleep = Some(
                            sleep
                                .unwrap_or(Duration::from_millis(250))
                                .min(Duration::from_millis(250)),
                        );
                        continue;
                    };
                    if stream.pending.is_empty() && !stream.degraded {
                        continue;
                    }
                    let now = Instant::now();
                    if now >= stream.retry_at {
                        if stream.marker_pending {
                            stream.marker_pending = db.mark_terminal_storage_degraded(&id, stream.cursor).is_err();
                            if stream.marker_pending {
                                store.sidecars(&db).write(LossRecord::new(&id, stream.cursor, stream.pending.len()));
                            }
                        }
                        let result = store.commit(&db, &id, &mut stream, &[]);
                        if result.is_err() || stream.degraded {
                            stream.backoff = (stream.backoff * 2).min(Duration::from_secs(5));
                            stream.retry_at = Instant::now() + stream.backoff;
                        }
                        let committed = result.is_ok();
                        let next = stream.retry_at.saturating_duration_since(Instant::now());
                        let pending = !stream.pending.is_empty() || stream.degraded;
                        drop(stream);
                        if committed {
                            store.notify.notify_waiters();
                        }
                        if pending {
                            sleep = Some(sleep.unwrap_or(next).min(next));
                        }
                    } else {
                        let next = stream.retry_at - now;
                        sleep = Some(sleep.unwrap_or(next).min(next));
                    }
                }
                drop(db);
                drop(store);
                let state = signal.0.lock().unwrap();
                let unchanged = |s: &mut RetryState| !s.stopped && s.generation == generation;
                if let Some(delay) = sleep {
                    drop(
                        signal
                            .1
                            .wait_timeout_while(state, delay, unchanged)
                            .unwrap(),
                    );
                } else {
                    drop(signal.1.wait_while(state, unchanged).unwrap());
                }
            })
        {
            state.started = false;
            eprintln!("Could not start terminal output retry worker: {error}");
        }
    }

    fn stop_retry_worker(&self) {
        let mut state = self.retry.0.lock().unwrap();
        state.stopped = true;
        self.retry.1.notify_all();
    }

    /// Bound the caller's wait even if the existing SQLite writer is blocked.
    /// A fixed two-pass helper may finish its in-flight commit after the deadline.
    pub fn drain_pending(self: &Arc<Self>, db: &Arc<Database>, deadline: Instant) -> usize {
        self.stop_retry_worker();
        if self.pending_bytes.load(Ordering::Relaxed) == 0 {
            return 0;
        }
        let (sent, received) = std::sync::mpsc::sync_channel(1);
        let store = self.clone();
        let db = db.clone();
        let _ = thread::Builder::new()
            .name("output-shutdown-drain".into())
            .spawn(move || {
                for _ in 0..2 {
                    for (id, _) in store.snapshot() {
                        if Instant::now() >= deadline {
                            break;
                        }
                        let _ = store.flush_pending(&db, &id);
                    }
                    if store.pending_bytes.load(Ordering::Relaxed) == 0 {
                        break;
                    }
                }
                let _ = sent.send(());
            });
        let _ = received.recv_timeout(deadline.saturating_duration_since(Instant::now()));
        let pending = self.pending_bytes.load(Ordering::Relaxed);
        eprintln!("Terminal output shutdown drain: {pending} bytes still uncommitted");
        pending
    }

    /// The caller waits at most 125 ms; filesystem fallback never waits on SQLite.
    pub fn record_shutdown_loss(&self, db: &Arc<Database>) {
        let records: Vec<_> = self.losses.lock().unwrap().values().cloned().collect();
        if records.is_empty() { return; }
        let (sent, received) = std::sync::mpsc::channel();
        let database = db.clone();
        let sidecars = self.sidecars(db).clone();
        let pending = records.clone();
        let _ = thread::Builder::new().name("output-loss-shutdown".into()).spawn(move || {
            for record in pending {
                if database.mark_terminal_output_lost(&record).is_ok() {
                    sidecars.remove(&record.session_id);
                    let _ = sent.send(record.session_id);
                }
            }
        });
        let deadline = Instant::now() + Duration::from_millis(100);
        let mut remaining: HashMap<_, _> = records.into_iter()
            .map(|record| (record.session_id.clone(), record)).collect();
        while !remaining.is_empty() {
            match received.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(id) => { remaining.remove(&id); }
                Err(_) => break,
            }
        }
        if !remaining.is_empty() {
            self.sidecars(db).write_all(remaining.into_values().collect());
        }
    }

    #[cfg(test)]
    pub(crate) fn pending_byte_count(&self) -> usize {
        self.pending_bytes.load(Ordering::Relaxed)
    }

    pub fn notified(&self) -> impl std::future::Future<Output = ()> + '_ {
        self.notify.notified()
    }
    pub fn cursor(&self, session_id: &str) -> i64 {
        self.stream(session_id)
            .lock()
            .expect("stream lock poisoned")
            .cursor
    }
    /// Moves a session's in-memory write cursor to the persisted end before a
    /// resume relaunches its process. Without this the first chunk after a
    /// daemon restart would reuse cursor 0 and collide with the retained
    /// `output_chunks` primary key, silently ending output recording.
    pub fn seed(&self, session_id: &str, cursor: i64) {
        let stream = self.stream(session_id);
        let mut stream = stream.lock().expect("stream lock poisoned");
        stream.seeded = true;
        if cursor > stream.cursor {
            stream.cursor = cursor;
        }
    }

    #[cfg(test)]
    pub(crate) fn stream_count(&self) -> usize {
        self.streams.lock().expect("output lock poisoned").len()
    }
}
impl Default for OutputStore {
    fn default() -> Self {
        Self {
            streams: Mutex::new(HashMap::new()),
            commit_gate: Mutex::new(()),
            notify: Notify::new(),
            retry: Arc::new((Mutex::new(RetryState::default()), Condvar::new())),
            pending_bytes: AtomicUsize::new(0),
            losses: Mutex::new(HashMap::new()),
            sidecars: OnceLock::new(),
        }
    }
}

impl Drop for OutputStore {
    fn drop(&mut self) {
        self.stop_retry_worker();
    }
}

/// Test hook: every durable output INSERT fails, the same shape as a full disk.
/// An entry now learns its own cursor from the database, so a taken cursor is no
/// longer a way to refuse a write.
#[cfg(test)]
pub(crate) fn refuse_output_writes(db: &Database) {
    db.transaction(|tx| {
        tx.execute(
            "CREATE TEMP TRIGGER reject_terminal_output BEFORE INSERT ON output_chunks BEGIN SELECT RAISE(ABORT, 'storage refused'); END",
            [],
        )?;
        Ok(())
    })
    .unwrap();
}

/// Test hook: storage accepts durable output again.
#[cfg(test)]
pub(crate) fn accept_output_writes(db: &Database) {
    db.transaction(|tx| {
        tx.execute("DROP TRIGGER reject_terminal_output", [])?;
        Ok(())
    })
    .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{CreateSession, Database};

    #[test]
    fn seeded_cursor_continues_the_persisted_stream_after_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("runtime.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "codex",
                mode: "terminal",
                native_id: None,
                operation_id: "seed-session",
            })
            .unwrap();
        db.append_output(&session.id, 0, b"old-run").unwrap();

        // A fresh OutputStore models a daemon restart: the in-memory cursor
        // restarts at zero while persisted chunks keep their byte offsets.
        let store = OutputStore::default();
        store.seed(&session.id, db.output_end(&session.id).unwrap());
        store.append(&db, &session.id, b"+resumed").unwrap();

        let chunks = db.output_from(&session.id, 0, 1024).unwrap();
        let bytes: Vec<u8> = chunks.iter().flat_map(|(_, data)| data.clone()).collect();
        assert_eq!(bytes, b"old-run+resumed");
        assert_eq!(chunks[1].0, 7, "the resumed chunk must follow the old end");
    }

    #[test]
    fn seed_never_rewinds_a_live_stream() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("runtime.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "seed-live",
            })
            .unwrap();
        let store = OutputStore::default();
        store.append(&db, &session.id, b"0123456789").unwrap();
        store.seed(&session.id, 4);
        store.append(&db, &session.id, b"x").unwrap();
        let chunks = db.output_from(&session.id, 0, 1024).unwrap();
        assert_eq!(chunks[1].0, 10);
    }

    /// F23: the durable cursor must never move before the database accepted the
    /// bytes, and the refused bytes are retried instead of being lost.
    #[test]
    fn a_refused_append_keeps_the_durable_cursor_and_retries_the_pending_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("runtime.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "storage-failure",
            })
            .unwrap();
        // A TEMP trigger makes every output INSERT fail (the same shape as a full
        // disk or a locked database file).
        refuse_output_writes(&db);
        let store = OutputStore::default();
        assert!(store.append(&db, &session.id, b"first").is_err());
        assert_eq!(
            store.cursor(&session.id),
            0,
            "a refused append advanced the durable cursor"
        );
        let marker = db
            .terminal_storage_degraded(&session.id)
            .unwrap()
            .expect("the terminal must be marked storage-degraded");
        assert_eq!(marker["reason"], crate::db::TERMINAL_STORAGE_FAILED);
        assert_eq!(marker["cursor"], 0);
        let events = |db: &Database| {
            db.events_after(0)
                .unwrap()
                .into_iter()
                .filter(|(_, event, _)| event == "terminal.storage")
                .map(|(_, _, data)| data)
                .collect::<Vec<_>>()
        };
        let reported = events(&db);
        assert_eq!(reported.len(), 1);
        assert_eq!(reported[0]["degraded"], true);
        assert_eq!(reported[0]["sessionId"], session.id.as_str());
        // Storage recovers: the pending bytes and the next chunk land together at
        // the unchanged cursor, then the degraded state clears.
        accept_output_writes(&db);
        assert_eq!(store.append(&db, &session.id, b"second").unwrap(), 0);
        let bytes: Vec<u8> = db
            .output_from(&session.id, 0, 1024)
            .unwrap()
            .into_iter()
            .flat_map(|(_, data)| data)
            .collect();
        assert_eq!(bytes, b"firstsecond");
        assert_eq!(store.cursor(&session.id), 11);
        assert!(db.terminal_storage_degraded(&session.id).unwrap().is_none());
        let reported = events(&db);
        assert_eq!(reported.len(), 2);
        assert_eq!(reported[1]["degraded"], false);
    }

    /// The memory bound cannot silently discard output: dropped bytes become a
    /// durable gap the output transport reports to the client.
    #[test]
    fn an_overflowing_pending_buffer_leaves_a_visible_gap_not_a_silent_skip() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("runtime.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "storage-overflow",
            })
            .unwrap();
        refuse_output_writes(&db);
        let store = OutputStore::default();
        assert!(store.append(&db, &session.id, b"first").is_err());
        accept_output_writes(&db);
        // Simulate the bound being exceeded without allocating 4 MiB of test data.
        {
            store
                .stream(&session.id)
                .lock()
                .unwrap()
                .pending
                .resize(MAX_PENDING_BYTES, b'.');
            store
                .pending_bytes
                .store(MAX_PENDING_BYTES, Ordering::Relaxed);
        }
        // Five oldest bytes are dropped to make room, so the durable write starts
        // at byte 5 instead of 0.
        assert_eq!(store.append(&db, &session.id, b"later").unwrap(), 5);
        // The cursor moved past the discarded bytes and the stream now has a hole:
        // a reader that expects continuity is told, it does not skip quietly.
        let gap = db
            .output_from(&session.id, 0, 1024)
            .unwrap_err()
            .to_string();
        assert!(gap.contains("terminal_history_gap"), "{gap}");
    }

    /// Item 7: the runtime keeps no per-session output buffer. Finished sessions
    /// are dropped, so memory does not grow with the number of closed terminals.
    #[test]
    fn exited_sessions_leave_no_output_entry_after_about_half_a_megabyte_each() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("runtime.sqlite")).unwrap();
        let store = OutputStore::default();
        let chunk = vec![b'x'; 64 * 1024];
        let mut ids = Vec::new();
        for index in 0..50 {
            let session = db
                .create_session(CreateSession {
                    project_id: None,
                    title: None,
                    provider: "shell",
                    mode: "terminal",
                    native_id: None,
                    operation_id: &format!("many-terminals-{index}"),
                })
                .unwrap();
            for _ in 0..10 {
                store.append(&db, &session.id, &chunk).unwrap();
            }
            ids.push(session.id);
        }
        assert_eq!(db.output_end(&ids[0]).unwrap(), 10 * 64 * 1024);
        assert_eq!(store.stream_count(), 50);
        for id in &ids {
            store.forget(id);
        }
        assert_eq!(store.stream_count(), 0, "an exited session kept its entry");
    }

    /// Item 7: a forgotten session continues the persisted stream without an
    /// explicit `seed`, so a relaunch never reuses a taken offset.
    #[test]
    fn a_forgotten_session_relaunches_at_the_persisted_end() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("runtime.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "forget-then-relaunch",
            })
            .unwrap();
        let store = OutputStore::default();
        store.append(&db, &session.id, b"first-run").unwrap();
        store.forget(&session.id);
        assert_eq!(store.stream_count(), 0);

        // The relaunch path appends without calling `seed` first.
        store.append(&db, &session.id, b"+relaunch").unwrap();
        let chunks = db.output_from(&session.id, 0, 1024).unwrap();
        let bytes: Vec<u8> = chunks.iter().flat_map(|(_, data)| data.clone()).collect();
        assert_eq!(bytes, b"first-run+relaunch");
        assert_eq!(chunks[1].0, 9, "the relaunched chunk must follow the old end");
    }

    /// Item 7: the retry worker still owns a stream with pending bytes.
    #[test]
    fn a_pending_stream_is_not_forgotten_until_the_bytes_are_durable() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("runtime.sqlite")).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "forget-degraded",
            })
            .unwrap();
        refuse_output_writes(&db);
        let store = OutputStore::default();
        assert!(store.append(&db, &session.id, b"pending").is_err());
        store.forget(&session.id);
        assert_eq!(store.stream_count(), 1, "a degraded stream was forgotten");
        assert_eq!(store.cursor(&session.id), 0);

        accept_output_writes(&db);
        assert_eq!(
            store.flush_pending(&db, &session.id).unwrap(),
            FlushOutcome::Clean { durable_end: 7 }
        );
        store.forget(&session.id);
        assert_eq!(store.stream_count(), 0);
    }
}
