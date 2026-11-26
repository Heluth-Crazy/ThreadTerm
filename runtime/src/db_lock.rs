//! The runtime's one SQLite connection mutex, with an optional wait/hold trace for QA.
//!
//! `ConnectionMutex::lock` behaves like `Mutex::lock`. In builds with debug assertions and with
//! `THREADTERM_V3_DB_LOCK_TRACE=<file>` set, it also records per caller (`#[track_caller]`) how long the caller waited
//! for the connection and how long it held it, and rewrites `<file>` as JSON twice a second. Release builds compile
//! the trace out. The I/O measurements of 11-26 (`.trellis/tasks/11-26-io-perf`) read this file to tell foreground
//! waits on the database apart from other delays.
use rusqlite::Connection;
use std::ops::{Deref, DerefMut};
use std::sync::{LockResult, Mutex, MutexGuard, PoisonError};

pub(crate) struct ConnectionMutex {
    inner: Mutex<Connection>,
}

pub(crate) struct ConnectionGuard<'a> {
    /// Always `Some` until `Drop` takes it, so that the trace records a hold after the connection is unlocked.
    guard: Option<MutexGuard<'a, Connection>>,
    #[cfg(debug_assertions)]
    held: Option<(std::time::Instant, &'static std::panic::Location<'static>)>,
}

impl ConnectionMutex {
    pub(crate) fn new(connection: Connection) -> Self {
        Self { inner: Mutex::new(connection) }
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
                let wrap = |guard| ConnectionGuard { guard: Some(guard), held: Some((acquired, site)) };
                return match result {
                    Ok(guard) => Ok(wrap(guard)),
                    Err(poisoned) => Err(PoisonError::new(wrap(poisoned.into_inner()))),
                };
            }
        }
        let wrap = |guard| ConnectionGuard {
            guard: Some(guard),
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
        #[cfg(debug_assertions)]
        let held = self.held.take().map(|(acquired, site)| (site, acquired.elapsed()));
        drop(self.guard.take());
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
}
