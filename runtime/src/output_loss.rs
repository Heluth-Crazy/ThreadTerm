//! Best-effort diagnostic records outside SQLite for terminal output which could not be saved.
//!
//! `SidecarWriter` deliberately owns its own small worker: callers never wait for the
//! database mutex, and a filesystem stall only delays that worker after the 25 ms caller bound.
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const WAIT: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LossRecord {
    pub session_id: String,
    pub cursor: i64,
    pub pending_bytes: usize,
    pub time: String,
}

impl LossRecord {
    pub fn new(session_id: &str, cursor: i64, pending_bytes: usize) -> Self {
        Self {
            session_id: session_id.to_owned(),
            cursor,
            pending_bytes,
            time: chrono::Utc::now().to_rfc3339(),
        }
    }
}

enum Work {
    Write(LossRecord),
    Remove(String),
}
struct Queue {
    pending: HashMap<String, (Work, Vec<mpsc::Sender<()>>)>,
    order: VecDeque<String>,
    stopped: bool,
}
struct Shared {
    directory: PathBuf,
    queue: Mutex<Queue>,
    ready: Condvar,
    owners: AtomicUsize,
    logged: Mutex<std::collections::HashSet<String>>,
}

/// One serialized sidecar worker shared by clones. Enqueueing coalesces work per session.
/// A 25 ms caller timeout is best effort only: a stalled filesystem worker can still be writing.
pub struct SidecarWriter {
    shared: Arc<Shared>,
}
impl Clone for SidecarWriter {
    fn clone(&self) -> Self {
        self.shared.owners.fetch_add(1, Ordering::Relaxed);
        Self {
            shared: self.shared.clone(),
        }
    }
}
impl Drop for SidecarWriter {
    fn drop(&mut self) {
        if self.shared.owners.fetch_sub(1, Ordering::AcqRel) == 1 {
            let mut queue = self.shared.queue.lock().unwrap_or_else(|p| p.into_inner());
            queue.stopped = true;
            self.shared.ready.notify_one();
        }
    }
}

impl SidecarWriter {
    pub fn new(db_path: &Path) -> Self {
        let directory = db_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("terminal-output-loss");
        let shared = Arc::new(Shared {
            directory,
            queue: Mutex::new(Queue {
                pending: HashMap::new(),
                order: VecDeque::new(),
                stopped: false,
            }),
            ready: Condvar::new(),
            owners: AtomicUsize::new(1),
            logged: Mutex::new(std::collections::HashSet::new()),
        });
        let worker = shared.clone();
        if let Err(error) = thread::Builder::new()
            .name("terminal-output-loss".into())
            .spawn(move || worker_loop(worker))
        {
            eprintln!("Terminal output loss sidecar worker could not start: {error}");
        }
        Self { shared }
    }
    pub fn write(&self, record: LossRecord) {
        self.enqueue(record.session_id.clone(), Work::Write(record));
    }
    pub fn write_all(&self, records: Vec<LossRecord>) {
        let deadline = std::time::Instant::now() + WAIT;
        let mut receivers = Vec::with_capacity(records.len());
        for record in records {
            receivers.push(self.enqueue_async(record.session_id.clone(), Work::Write(record)));
        }
        for receiver in receivers {
            let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) else {
                break;
            };
            let _ = receiver.recv_timeout(left);
        }
    }
    pub fn remove(&self, session_id: &str) {
        self.enqueue(session_id.to_owned(), Work::Remove(session_id.to_owned()));
    }
    fn enqueue(&self, session_id: String, work: Work) {
        let receiver = self.enqueue_async(session_id, work);
        let _ = receiver.recv_timeout(WAIT);
    }
    fn enqueue_async(&self, session_id: String, work: Work) -> mpsc::Receiver<()> {
        let (sender, receiver) = mpsc::channel();
        if !valid_session_id(&session_id) {
            return receiver;
        }
        let mut queue = self.shared.queue.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((entry, waiters)) = queue.pending.get_mut(&session_id) {
            *entry = work;
            if waiters.len() < 64 {
                waiters.push(sender);
            }
        } else {
            queue.order.push_back(session_id.clone());
            queue.pending.insert(session_id, (work, vec![sender]));
        }
        self.shared.ready.notify_one();
        receiver
    }
}
fn worker_loop(shared: Arc<Shared>) {
    loop {
        let (work, waiters) = {
            let mut queue = shared.queue.lock().unwrap_or_else(|p| p.into_inner());
            while queue.order.is_empty() && !queue.stopped {
                queue = shared.ready.wait(queue).unwrap_or_else(|p| p.into_inner());
            }
            if queue.stopped && queue.order.is_empty() {
                return;
            }
            let id = queue.order.pop_front().expect("queue is nonempty");
            queue.pending.remove(&id).expect("queued work exists")
        };
        let id = match &work {
            Work::Write(record) => record.session_id.clone(),
            Work::Remove(id) => id.clone(),
        };
        let removing = matches!(&work, Work::Remove(_));
        if let Err(error) = match work {
            Work::Write(record) => write_record(&shared.directory, &record),
            Work::Remove(id) => remove_record(&shared.directory, &id),
        } {
            if shared
                .logged
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(id.clone())
            {
                eprintln!("Terminal output loss sidecar could not be saved for {id}: {error}");
            }
        } else if removing {
            shared
                .logged
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
        }
        for waiter in waiters {
            let _ = waiter.send(());
        }
    }
}
pub fn sidecar_directory(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("terminal-output-loss")
}
pub fn sidecar_path(db_path: &Path, session_id: &str) -> Option<PathBuf> {
    valid_session_id(session_id)
        .then(|| sidecar_directory(db_path).join(format!("{session_id}.json")))
}
pub fn read_records(db_path: &Path) -> Vec<Result<LossRecord, String>> {
    let directory = sidecar_directory(db_path);
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            eprintln!(
                "Terminal output loss sidecars could not be read from {}: {error}",
                directory.display()
            );
            return Vec::new();
        }
    };
    entries
        .filter_map(|entry| {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => return Some(Err(error.to_string())),
            };
            let path = entry.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                return None;
            }
            Some(
                fs::read_to_string(&path)
                    .map_err(|e| e.to_string())
                    .and_then(|raw| {
                        serde_json::from_str::<LossRecord>(&raw).map_err(|e| e.to_string())
                    })
                    .and_then(|record| {
                        if valid_session_id(&record.session_id)
                            && sidecar_path(db_path, &record.session_id).as_deref()
                                == Some(path.as_path())
                        {
                            Ok(record)
                        } else {
                            Err("invalid sidecar session id".into())
                        }
                    }),
            )
        })
        .collect()
}
fn write_record(directory: &Path, record: &LossRecord) -> std::io::Result<()> {
    if !valid_session_id(&record.session_id) {
        return Ok(());
    }
    fs::create_dir_all(directory)?;
    let path = directory.join(format!("{}.json", record.session_id));
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = directory.join(format!(".{}.{}.tmp", record.session_id, stamp));
    let result = (|| {
        let mut file = File::create(&temporary)?;
        file.write_all(serde_json::to_string(record).unwrap_or_default().as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
fn remove_record(directory: &Path, session_id: &str) -> std::io::Result<()> {
    if !valid_session_id(session_id) {
        return Ok(());
    }
    match fs::remove_file(directory.join(format!("{session_id}.json"))) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}
fn valid_session_id(id: &str) -> bool {
    id.len() == 36 && uuid::Uuid::parse_str(id).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_overwrites_one_record_per_session() {
        let dir = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let first = LossRecord::new(&id, 4, 9);
        write_record(&dir.path().join("terminal-output-loss"), &first).unwrap();
        let second = LossRecord::new(&id, 7, 13);
        write_record(&dir.path().join("terminal-output-loss"), &second).unwrap();
        let records = read_records(&dir.path().join("state.sqlite"));
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].as_ref().unwrap().cursor, 7);
        assert_eq!(records[0].as_ref().unwrap().pending_bytes, 13);
    }

    #[test]
    fn invalid_or_unwritable_sidecars_do_not_panic() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("blocker");
        File::create(&blocker).unwrap();
        let writer = SidecarWriter::new(&blocker.join("state.sqlite"));
        writer.write(LossRecord::new(&uuid::Uuid::new_v4().to_string(), 0, 1));
        writer.write(LossRecord::new(&uuid::Uuid::new_v4().to_string(), 0, 2));
        writer.write(LossRecord::new("../../not-a-session", 0, 1));
        writer.write(LossRecord::new(
            "urn:uuid:8ed0ce10-b1ad-4e05-a9cb-387b4145ef74",
            0,
            1,
        ));
        assert!(read_records(&blocker.join("state.sqlite")).is_empty());
    }
}
