//! The runtime's one SQLite connection mutex: an outbox change signal, and an optional wait/hold trace for QA.
//!
//! Outbox signal: an SQLite update hook marks any row change in `outbox`. The guard that made it takes the mark while it
//! still holds the connection, releases the connection (the transaction has committed or rolled back by then), and
//! only then bumps a `watch` generation. Control connections wait on that generation instead of polling every 100 ms,
//! so a committed event goes out at once. A rollback gives an extra wake that finds nothing; a wake is only a hint, the
//! reader drains by sequence. Another process writing the outbox is not seen here; readers keep a timer for that.
//!
//! `ConnectionMutex::lock` behaves like `Mutex::lock`. In builds with debug assertions and with
//! `THREADTERM_V3_DB_LOCK_TRACE=<file>` set, it also records per caller (`#[track_caller]`) how long the caller waited
//! for the connection and how long it held it, and rewrites `<file>` as JSON twice a second. Release builds compile
//! the trace out. The I/O measurements of 11-26 (`.trellis/tasks/11-26-io-perf`) read this file to tell foreground
//! waits on the database apart from other delays.
use rusqlite::Connection;
use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LockResult, Mutex, MutexGuard, PoisonError};

pub(crate) struct ConnectionMutex {
    inner: Mutex<Connection>,
    outbox: Arc<OutboxSignal>,
}

struct OutboxSignal {
    /// Set by the update hook, which runs only while some guard holds the connection.
    changed: AtomicBool,
    generation: tokio::sync::watch::Sender<u64>,
}

pub(crate) struct ConnectionGuard<'a> {
    /// Always `Some` until `Drop` takes it, so that the trace records a hold after the connection is unlocked.
    guard: Option<MutexGuard<'a, Connection>>,
    outbox: &'a OutboxSignal,
    #[cfg(debug_assertions)]
    held: Option<(std::time::Instant, &'static std::panic::Location<'static>)>,
}

impl ConnectionMutex {
    pub(crate) fn new(connection: Connection) -> Self {
        let outbox = Arc::new(OutboxSignal { changed: AtomicBool::new(false), generation: tokio::sync::watch::channel(0).0 });
        let mark = Arc::clone(&outbox);
        connection.update_hook(Some(move |_: rusqlite::hooks::Action, _: &str, table: &str, _: i64| {
            if table == "outbox" {
                mark.changed.store(true, Ordering::Relaxed);
            }
        }));
        Self { inner: Mutex::new(connection), outbox }
    }

    /// Changes after every release of the connection that committed (or rolled back) an outbox change. Subscribe
    /// before reading a starting cursor, so that no commit after that read goes unnoticed.
    pub(crate) fn outbox_changes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.outbox.generation.subscribe()
    }

    #[track_caller]
    pub(crate) fn lock(&self) -> LockResult<ConnectionGuard<'_>> {
        #[cfg(debug_assertions)]
        {
            if trace::enabled() {
                let site = std::panic::Location::caller();
                let asked = std::time::Instant::now();
                let result = self.inner.lock();
                let acquired = std::time::Instant::now();
                // A short map update under the trace's own lock; the file is written elsewhere, outside every lock.
                trace::waited(site, acquired - asked);
                let wrap = |guard| ConnectionGuard { guard: Some(guard), outbox: &self.outbox, held: Some((acquired, site)) };
                return match result {
                    Ok(guard) => Ok(wrap(guard)),
                    Err(poisoned) => Err(PoisonError::new(wrap(poisoned.into_inner()))),
                };
            }
        }
        let wrap = |guard| ConnectionGuard {
            guard: Some(guard),
            outbox: &self.outbox,
            #[cfg(debug_assertions)]
            held: None,
        };
        match self.inner.lock() {
            Ok(guard) => Ok(wrap(guard)),
            Err(poisoned) => Err(PoisonError::new(wrap(poisoned.into_inner()))),
        }
    }
}

impl Deref for ConnectionGuard<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.guard.as_deref().expect("the connection guard is held until drop")
    }
}

impl DerefMut for ConnectionGuard<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        self.guard.as_deref_mut().expect("the connection guard is held until drop")
    }
}

impl Drop for ConnectionGuard<'_> {
    fn drop(&mut self) {
        // Taken while the connection is still held: this holder's changes only, never another writer's open transaction.
        let outbox_changed = self.outbox.changed.swap(false, Ordering::Relaxed);
        #[cfg(debug_assertions)]
        let held = self.held.take().map(|(acquired, site)| (site, acquired.elapsed()));
        drop(self.guard.take());
        if outbox_changed {
            self.outbox.generation.send_modify(|generation| *generation = generation.wrapping_add(1));
        }
        #[cfg(debug_assertions)]
        if let Some((site, hold)) = held {
            trace::held(site, hold);
        }
    }
}

#[cfg(debug_assertions)]
mod trace {
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::panic::Location;
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    /// Upper bounds of the wait buckets, in microseconds; the last bucket is open.
    const BUCKETS_US: [u64; 10] = [10, 100, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000];

    #[derive(Default, Clone)]
    struct Site {
        locks: u64,
        wait_us: u64,
        wait_max_us: u64,
        hold_us: u64,
        hold_max_us: u64,
        buckets: [u64; BUCKETS_US.len() + 1],
    }

    struct Trace {
        file: std::path::PathBuf,
        sites: Mutex<HashMap<&'static Location<'static>, Site>>,
    }

    fn state() -> Option<&'static Trace> {
        static STATE: OnceLock<Option<Trace>> = OnceLock::new();
        STATE
            .get_or_init(|| {
                let file = std::env::var_os("THREADTERM_V3_DB_LOCK_TRACE").map(std::path::PathBuf::from)?;
                let _ = std::thread::Builder::new().name("db-lock-trace".into()).spawn(|| loop {
                    std::thread::sleep(Duration::from_millis(500));
                    write();
                });
                Some(Trace { file, sites: Mutex::new(HashMap::new()) })
            })
            .as_ref()
    }

    pub(super) fn enabled() -> bool {
        state().is_some()
    }

    fn micros(duration: Duration) -> u64 {
        u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
    }

    pub(super) fn waited(site: &'static Location<'static>, wait: Duration) {
        let Some(trace) = state() else { return };
        let wait = micros(wait);
        let bucket = BUCKETS_US.iter().position(|bound| wait <= *bound).unwrap_or(BUCKETS_US.len());
        if let Ok(mut sites) = trace.sites.lock() {
            let entry = sites.entry(site).or_default();
            entry.locks += 1;
            entry.wait_us += wait;
            entry.wait_max_us = entry.wait_max_us.max(wait);
            entry.buckets[bucket] += 1;
        }
    }

    pub(super) fn held(site: &'static Location<'static>, hold: Duration) {
        let Some(trace) = state() else { return };
        let hold = micros(hold);
        if let Ok(mut sites) = trace.sites.lock() {
            let entry = sites.entry(site).or_default();
            entry.hold_us += hold;
            entry.hold_max_us = entry.hold_max_us.max(hold);
        }
    }

    /// Cumulative counters since start; a reader diffs two snapshots. Copies the counters, then writes the file with no
    /// lock held, so a slow disk never stalls a database caller.
    fn write() {
        let Some(trace) = state() else { return };
        let snapshot: Vec<(&'static Location<'static>, Site)> = match trace.sites.lock() {
            Ok(sites) => sites.iter().map(|(site, stats)| (*site, stats.clone())).collect(),
            Err(_) => return,
        };
        let sites: Vec<Value> = snapshot
            .iter()
            .map(|(site, stats)| {
                json!({
                    "site": format!("{}:{}", site.file().replace('\\', "/"), site.line()),
                    "locks": stats.locks, "waitUs": stats.wait_us, "waitMaxUs": stats.wait_max_us,
                    "holdUs": stats.hold_us, "holdMaxUs": stats.hold_max_us, "buckets": stats.buckets.to_vec(),
                })
            })
            .collect();
        let body = json!({ "at": chrono::Utc::now().timestamp_millis(), "bucketsUs": BUCKETS_US.to_vec(), "sites": sites });
        let temporary = trace.file.with_extension("tmp");
        if std::fs::write(&temporary, body.to_string()).is_ok() {
            let _ = std::fs::rename(&temporary, &trace.file);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_guard_derefs_to_the_connection_and_a_poisoned_lock_still_yields_it() {
        let mutex = std::sync::Arc::new(ConnectionMutex::new(Connection::open_in_memory().unwrap()));
        {
            let mut guard = mutex.lock().unwrap();
            guard.execute_batch("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (7);").unwrap();
            let tx = guard.transaction().unwrap();
            tx.execute("INSERT INTO t VALUES (8)", []).unwrap();
            tx.commit().unwrap();
        }
        let poisoner = std::sync::Arc::clone(&mutex);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.lock().unwrap();
            panic!("poison the connection mutex");
        })
        .join();
        let guard = mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let sum: i64 = guard.query_row("SELECT SUM(x) FROM t", [], |row| row.get(0)).unwrap();
        assert_eq!(sum, 15);
    }

    fn outbox_mutex() -> ConnectionMutex {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE outbox(seq INTEGER PRIMARY KEY, event TEXT); CREATE TABLE other(x INTEGER);").unwrap();
        ConnectionMutex::new(connection)
    }

    #[test]
    fn an_outbox_change_bumps_the_generation_once_the_connection_is_released() {
        let mutex = outbox_mutex();
        let mut changes = mutex.outbox_changes();
        {
            let guard = mutex.lock().unwrap();
            guard.execute("INSERT INTO other VALUES (1)", []).unwrap();
        }
        assert!(!changes.has_changed().unwrap(), "other tables do not wake readers");
        {
            let mut guard = mutex.lock().unwrap();
            let tx = guard.transaction().unwrap();
            tx.execute("INSERT INTO outbox(event) VALUES ('a')", []).unwrap();
            tx.execute("INSERT INTO outbox(event) VALUES ('b')", []).unwrap();
            tx.commit().unwrap();
            assert!(!changes.has_changed().unwrap(), "no wake while the writer still holds the connection");
        }
        assert!(changes.has_changed().unwrap());
        changes.borrow_and_update();
        {
            let guard = mutex.lock().unwrap();
            guard.execute("DELETE FROM outbox WHERE event='a'", []).unwrap();
        }
        assert!(changes.has_changed().unwrap(), "pruning wakes readers too");
        changes.borrow_and_update();
        {
            let mut guard = mutex.lock().unwrap();
            let tx = guard.transaction().unwrap();
            tx.execute("INSERT INTO outbox(event) VALUES ('c')", []).unwrap();
            drop(tx);
        }
        assert!(changes.has_changed().unwrap(), "a rollback gives a harmless extra wake");
        changes.borrow_and_update();
        {
            let _guard = mutex.lock().unwrap();
        }
        assert!(!changes.has_changed().unwrap(), "the mark was consumed by the holder that made it");
    }

    /// Another holder never announces a writer's open transaction: the mark is taken while the connection is held, and
    /// the writer announces its own change after its commit.
    #[test]
    fn a_holder_never_announces_another_writers_open_transaction() {
        let mutex = Arc::new(outbox_mutex());
        let mut changes = mutex.outbox_changes();
        let inserted = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let writer = {
            let (mutex, inserted, release) = (Arc::clone(&mutex), Arc::clone(&inserted), Arc::clone(&release));
            std::thread::spawn(move || {
                let mut guard = mutex.lock().unwrap();
                let tx = guard.transaction().unwrap();
                tx.execute("INSERT INTO outbox(event) VALUES ('b')", []).unwrap();
                inserted.wait();
                release.wait();
                tx.commit().unwrap();
            })
        };
        inserted.wait();
        assert!(!changes.has_changed().unwrap(), "an uncommitted insert is not announced");
        release.wait();
        writer.join().unwrap();
        assert!(changes.has_changed().unwrap());
        let guard = mutex.lock().unwrap();
        let rows: i64 = guard.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0)).unwrap();
        assert_eq!(rows, 1);
    }
}
