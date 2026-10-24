use crate::db::Database;
use anyhow::Result;
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
};
use tokio::sync::Notify;

const RETAINED_MEMORY_BYTES: usize = 512 * 1024;
/// Bytes a stream may hold while the database refuses them. Dropping older
/// bytes advances the durable cursor past them, so a client reads an explicit
/// history gap instead of silently missing output.
const MAX_PENDING_BYTES: usize = 4 * 1024 * 1024;
pub struct OutputStore {
    streams: Mutex<HashMap<String, Stream>>,
    notify: Notify,
}
struct Stream {
    /// The durable cursor: only advanced after the database accepted the bytes.
    cursor: i64,
    chunks: VecDeque<(i64, Vec<u8>)>,
    bytes: usize,
    /// Drained bytes the database has not accepted yet (see `append`).
    pending: Vec<u8>,
    degraded: bool,
}
impl Stream {
    fn new() -> Self {
        Self {
            cursor: 0,
            chunks: VecDeque::new(),
            bytes: 0,
            pending: Vec::new(),
            degraded: false,
        }
    }
}
impl OutputStore {
    /// Persists one drained chunk and returns its durable start offset.
    ///
    /// Storage failure policy: the durable cursor advances only after the
    /// database accepted the bytes. A refused chunk stays in `pending`, the
    /// terminal is marked storage-degraded, and the next chunk retries the
    /// whole pending prefix in one write. The PTY reader keeps draining
    /// (pty.rs), so the child never blocks on a full console pipe; the live
    /// view resumes from the unchanged cursor once storage accepts data again.
    /// The stream lock is held across the write on purpose: two appends for one
    /// session must never compute the same start offset.
    pub fn append(&self, db: &Database, session_id: &str, data: &[u8]) -> Result<i64> {
        let mut streams = self.streams.lock().expect("output lock poisoned");
        let stream = streams
            .entry(session_id.to_owned())
            .or_insert_with(Stream::new);
        let mut batch = std::mem::take(&mut stream.pending);
        batch.extend_from_slice(data);
        if batch.is_empty() {
            return Ok(stream.cursor);
        }
        // Bounded memory: discarded bytes are skipped by advancing the durable
        // cursor, which leaves a gap the output transport reports explicitly.
        if batch.len() > MAX_PENDING_BYTES {
            let dropped = batch.len() - MAX_PENDING_BYTES;
            batch.drain(..dropped);
            stream.cursor += dropped as i64;
        }
        let start = stream.cursor;
        if let Err(error) = db.append_output(session_id, start, &batch) {
            stream.pending = batch;
            if !stream.degraded {
                stream.degraded = true;
                let _ = db.mark_terminal_storage_degraded(session_id, start);
            }
            return Err(error);
        }
        stream.cursor += batch.len() as i64;
        stream.bytes += batch.len();
        stream.chunks.push_back((start, batch));
        while stream.bytes > RETAINED_MEMORY_BYTES {
            if let Some((_, chunk)) = stream.chunks.pop_front() {
                stream.bytes -= chunk.len()
            }
        }
        if stream.degraded {
            stream.degraded = false;
            let _ = db.clear_terminal_storage_degraded(session_id);
        }
        drop(streams);
        self.notify.notify_waiters();
        Ok(start)
    }
    pub fn notified(&self) -> impl std::future::Future<Output = ()> + '_ {
        self.notify.notified()
    }
    pub fn cursor(&self, session_id: &str) -> i64 {
        self.streams
            .lock()
            .expect("output lock poisoned")
            .get(session_id)
            .map(|s| s.cursor)
            .unwrap_or(0)
    }
    /// Moves a session's in-memory write cursor to the persisted end before a
    /// resume relaunches its process. Without this the first chunk after a
    /// daemon restart would reuse cursor 0 and collide with the retained
    /// `output_chunks` primary key, silently ending output recording.
    pub fn seed(&self, session_id: &str, cursor: i64) {
        let mut streams = self.streams.lock().expect("output lock poisoned");
        let stream = streams
            .entry(session_id.to_owned())
            .or_insert_with(Stream::new);
        if cursor > stream.cursor {
            stream.cursor = cursor;
        }
    }
}
impl Default for OutputStore {
    fn default() -> Self {
        Self {
            streams: Mutex::new(HashMap::new()),
            notify: Notify::new(),
        }
    }
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
        // Cursor 0 is occupied, so the first append is refused by the primary key
        // (the same shape as a full disk or a locked database file).
        db.append_output(&session.id, 0, b"occupied").unwrap();
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
        db.transaction(|tx| {
            tx.execute(
                "DELETE FROM output_chunks WHERE session_id=?",
                [&session.id],
            )?;
            Ok(())
        })
        .unwrap();
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
        db.append_output(&session.id, 0, b"occupied").unwrap();
        let store = OutputStore::default();
        assert!(store.append(&db, &session.id, b"first").is_err());
        db.transaction(|tx| {
            tx.execute(
                "DELETE FROM output_chunks WHERE session_id=?",
                [&session.id],
            )?;
            Ok(())
        })
        .unwrap();
        // Simulate the bound being exceeded without allocating 4 MiB of test data.
        {
            let mut streams = store.streams.lock().unwrap();
            streams
                .get_mut(&session.id)
                .unwrap()
                .pending
                .resize(MAX_PENDING_BYTES, b'.');
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
}
