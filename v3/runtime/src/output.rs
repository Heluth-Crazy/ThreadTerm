use crate::db::Database;
use anyhow::Result;
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
};
use tokio::sync::Notify;

const RETAINED_MEMORY_BYTES: usize = 512 * 1024;
pub struct OutputStore {
    streams: Mutex<HashMap<String, Stream>>,
    notify: Notify,
}
struct Stream {
    cursor: i64,
    chunks: VecDeque<(i64, Vec<u8>)>,
    bytes: usize,
}
impl OutputStore {
    pub fn append(&self, db: &Database, session_id: &str, data: &[u8]) -> Result<i64> {
        let mut streams = self.streams.lock().expect("output lock poisoned");
        let stream = streams
            .entry(session_id.to_owned())
            .or_insert_with(|| Stream {
                cursor: 0,
                chunks: VecDeque::new(),
                bytes: 0,
            });
        let start = stream.cursor;
        stream.cursor += data.len() as i64;
        stream.bytes += data.len();
        stream.chunks.push_back((start, data.to_vec()));
        while stream.bytes > RETAINED_MEMORY_BYTES {
            if let Some((_, chunk)) = stream.chunks.pop_front() {
                stream.bytes -= chunk.len()
            }
        }
        drop(streams);
        db.append_output(session_id, start, data)?;
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
            .or_insert_with(|| Stream {
                cursor: 0,
                chunks: VecDeque::new(),
                bytes: 0,
            });
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
}
