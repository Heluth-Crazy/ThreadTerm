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
}
impl Default for OutputStore {
    fn default() -> Self {
        Self {
            streams: Mutex::new(HashMap::new()),
            notify: Notify::new(),
        }
    }
}
