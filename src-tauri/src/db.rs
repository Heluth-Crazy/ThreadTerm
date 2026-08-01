use anyhow::{Context, Result};
use once_cell::sync::{Lazy, OnceCell};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender, TryRecvError, TrySendError},
        Arc,
    },
    time::{Duration, Instant},
};

const AUDIT_QUEUE_CAPACITY: usize = 2048;
const AUDIT_BATCH_SIZE: usize = 64;

#[derive(Clone)]
struct AuditLogEntry {
    device_id: String,
    action: String,
    card_id: Option<String>,
    summary: String,
}

enum AuditCommand {
    Write(AuditLogEntry),
    Shutdown(SyncSender<()>),
}

#[derive(Default)]
struct AuditCounters {
    enqueued: AtomicU64,
    written: AtomicU64,
    dropped: AtomicU64,
    failed: AtomicU64,
    pending: AtomicUsize,
    shutdown_timeouts: AtomicU64,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AuditWriterDiagnostics {
    pub enqueued: u64,
    pub written: u64,
    pub dropped: u64,
    pub failed: u64,
    pub pending: usize,
    pub shutdown_timeouts: u64,
}

type AuditSink = Box<dyn FnMut(&[AuditLogEntry]) -> Result<()> + Send + 'static>;

struct AuditLogWriter {
    sender: SyncSender<AuditCommand>,
    counters: Arc<AuditCounters>,
}

impl AuditLogWriter {
    fn new(capacity: usize, sink: AuditSink) -> Self {
        let (sender, receiver) = sync_channel(capacity);
        let counters = Arc::new(AuditCounters::default());
        let worker_counters = counters.clone();
        std::thread::Builder::new()
            .name("threadterm-audit-writer".to_string())
            .spawn(move || audit_writer_loop(receiver, worker_counters, sink))
            .expect("Failed to start audit writer");
        Self { sender, counters }
    }

    fn enqueue(&self, entry: AuditLogEntry) -> bool {
        self.counters.pending.fetch_add(1, Ordering::SeqCst);
        match self.sender.try_send(AuditCommand::Write(entry)) {
            Ok(()) => {
                self.counters.enqueued.fetch_add(1, Ordering::Relaxed);
                true
            }
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {
                self.counters.pending.fetch_sub(1, Ordering::SeqCst);
                let dropped = self.counters.dropped.fetch_add(1, Ordering::Relaxed) + 1;
                if dropped == 1 || dropped.is_power_of_two() {
                    tracing::warn!(
                        dropped,
                        "Audit queue is unavailable or full; operation metadata was not recorded"
                    );
                }
                false
            }
        }
    }

    fn diagnostics(&self) -> AuditWriterDiagnostics {
        AuditWriterDiagnostics {
            enqueued: self.counters.enqueued.load(Ordering::Relaxed),
            written: self.counters.written.load(Ordering::Relaxed),
            dropped: self.counters.dropped.load(Ordering::Relaxed),
            failed: self.counters.failed.load(Ordering::Relaxed),
            pending: self.counters.pending.load(Ordering::SeqCst),
            shutdown_timeouts: self.counters.shutdown_timeouts.load(Ordering::Relaxed),
        }
    }

    fn shutdown(&self, timeout: Duration) -> AuditWriterDiagnostics {
        let deadline = Instant::now() + timeout;
        let (ack_sender, ack_receiver) = sync_channel(1);
        let mut command = AuditCommand::Shutdown(ack_sender);
        loop {
            match self.sender.try_send(command) {
                Ok(()) => break,
                Err(TrySendError::Full(returned)) => {
                    if Instant::now() >= deadline {
                        self.counters
                            .shutdown_timeouts
                            .fetch_add(1, Ordering::Relaxed);
                        tracing::warn!(
                            pending = self.counters.pending.load(Ordering::SeqCst),
                            "Audit writer did not accept shutdown before the deadline"
                        );
                        return self.diagnostics();
                    }
                    command = returned;
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(TrySendError::Disconnected(_)) => return self.diagnostics(),
            }
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        if ack_receiver.recv_timeout(remaining).is_err() {
            self.counters
                .shutdown_timeouts
                .fetch_add(1, Ordering::Relaxed);
            tracing::warn!(
                pending = self.counters.pending.load(Ordering::SeqCst),
                "Audit writer did not flush before the shutdown deadline"
            );
        }
        self.diagnostics()
    }
}

static AUDIT_WRITER: Lazy<AuditLogWriter> =
    Lazy::new(|| AuditLogWriter::new(AUDIT_QUEUE_CAPACITY, Box::new(write_audit_batch)));

struct DatabaseRuntime {
    pool: Pool<SqliteConnectionManager>,
    path: PathBuf,
}

static DATABASE: OnceCell<DatabaseRuntime> = OnceCell::new();

fn build_database_runtime(path: &Path) -> Result<DatabaseRuntime> {
    let dir = path
        .parent()
        .context("ThreadTerm database path has no parent directory")?;
    std::fs::create_dir_all(dir)
        .with_context(|| format!("Failed to create database directory {}", dir.display()))?;

    {
        let conn = rusqlite::Connection::open(path)
            .with_context(|| format!("Failed to open database {}", path.display()))?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")
            .context("Failed to enable WAL mode")?;
    }

    let manager = SqliteConnectionManager::file(path).with_init(|conn| {
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")?;
        Ok(())
    });
    let pool = Pool::builder()
        .max_size(4)
        .build(manager)
        .context("Failed to build DB pool")?;
    Ok(DatabaseRuntime {
        pool,
        path: path.to_path_buf(),
    })
}

pub fn get_db() -> Result<r2d2::PooledConnection<SqliteConnectionManager>, String> {
    DATABASE
        .get()
        .ok_or_else(|| "ThreadTerm database has not been initialized.".to_string())?
        .pool
        .get()
        .map_err(|e| format!("DB connection unavailable: {e}"))
}

pub fn init_database(path: &Path) -> Result<()> {
    if let Some(active) = DATABASE.get() {
        if active.path == path {
            return Ok(());
        }
        anyhow::bail!(
            "ThreadTerm database is already initialized at {}; refusing to switch live to {}",
            active.path.display(),
            path.display()
        );
    }

    let runtime = build_database_runtime(path)?;
    let conn = runtime
        .pool
        .get()
        .context("Database connection unavailable during initialization")?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS paired_devices (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            token_hash  TEXT NOT NULL UNIQUE,
            permission  TEXT NOT NULL DEFAULT 'read_only',
            created_at  INTEGER NOT NULL,
            last_seen_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS audit_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id   TEXT NOT NULL,
            action      TEXT NOT NULL,
            card_id     TEXT,
            summary     TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );

        -- Token usage records ingested from Claude/Codex session logs.
        -- Each row is one billable API call. Dedup is by request_id (INSERT OR
        -- IGNORE) plus a composite token-shape key (see DedupKey) to catch the
        -- same call recorded by both a proxy and the session log.
        CREATE TABLE IF NOT EXISTS usage_records (
            request_id              TEXT PRIMARY KEY,
            provider                TEXT NOT NULL,
            model                   TEXT NOT NULL,
            input_tokens            INTEGER NOT NULL DEFAULT 0,
            output_tokens           INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
            cache_creation_tokens   INTEGER NOT NULL DEFAULT 0,
            input_cost_usd          REAL NOT NULL DEFAULT 0,
            output_cost_usd         REAL NOT NULL DEFAULT 0,
            cache_read_cost_usd     REAL NOT NULL DEFAULT 0,
            cache_creation_cost_usd REAL NOT NULL DEFAULT 0,
            total_cost_usd          REAL NOT NULL DEFAULT 0,
            session_id              TEXT,
            project_path            TEXT,
            created_at              INTEGER NOT NULL,
            data_source             TEXT NOT NULL DEFAULT 'session_log'
        );

        CREATE INDEX IF NOT EXISTS idx_usage_records_created_at
            ON usage_records(created_at);
        CREATE INDEX IF NOT EXISTS idx_usage_records_session
            ON usage_records(session_id);
        CREATE INDEX IF NOT EXISTS idx_usage_records_provider_created
            ON usage_records(provider, created_at);

        -- Incremental sync progress per session-log file. last_modified is the
        -- file mtime in nanoseconds; last_line_offset is the number of lines
        -- already consumed. A file whose mtime hasn't bumped is skipped whole;
        -- otherwise we resume from last_line_offset + 1.
        CREATE TABLE IF NOT EXISTS session_log_sync (
            file_path        TEXT PRIMARY KEY,
            last_modified    INTEGER NOT NULL,
            last_line_offset INTEGER NOT NULL,
            last_synced_at   INTEGER NOT NULL
        );

        -- Stats bookkeeping (e.g. the parser-logic version that produced the
        -- rows currently in usage_records). When the parser improves, bumping
        -- the version triggers a one-time rebuild so old rows can't go stale.
        CREATE TABLE IF NOT EXISTS stats_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        ",
    )
    .context("Failed to create database tables")?;

    drop(conn);
    DATABASE
        .set(runtime)
        .map_err(|_| anyhow::anyhow!("ThreadTerm database was initialized concurrently"))?;
    tracing::info!(path = %path.display(), "Database initialized");
    Ok(())
}

pub fn enqueue_audit_log(
    device_id: &str,
    action: &str,
    card_id: Option<&str>,
    summary: &str,
) -> bool {
    AUDIT_WRITER.enqueue(AuditLogEntry {
        device_id: device_id.to_string(),
        action: action.to_string(),
        card_id: card_id.map(str::to_string),
        summary: summary.to_string(),
    })
}

pub fn shutdown_audit_writer(timeout: Duration) -> AuditWriterDiagnostics {
    Lazy::get(&AUDIT_WRITER)
        .map(|writer| writer.shutdown(timeout))
        .unwrap_or_default()
}

fn write_audit_batch(entries: &[AuditLogEntry]) -> Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let mut conn = get_db().map_err(|e| anyhow::anyhow!("{e}"))?;
    let transaction = conn.transaction()?;
    {
        let mut statement = transaction.prepare_cached(
            "INSERT INTO audit_log (device_id, action, card_id, summary, created_at)
             VALUES (?1, ?2, ?3, ?4, strftime('%s', 'now'))",
        )?;
        for entry in entries {
            statement.execute(rusqlite::params![
                &entry.device_id,
                &entry.action,
                &entry.card_id,
                &entry.summary
            ])?;
        }
    }
    transaction.commit()?;
    Ok(())
}

fn audit_writer_loop(
    receiver: Receiver<AuditCommand>,
    counters: Arc<AuditCounters>,
    mut sink: AuditSink,
) {
    while let Ok(command) = receiver.recv() {
        match command {
            AuditCommand::Write(entry) => {
                let mut batch = vec![entry];
                let mut shutdown_ack = None;
                while batch.len() < AUDIT_BATCH_SIZE {
                    match receiver.try_recv() {
                        Ok(AuditCommand::Write(entry)) => batch.push(entry),
                        Ok(AuditCommand::Shutdown(ack)) => {
                            shutdown_ack = Some(ack);
                            break;
                        }
                        Err(TryRecvError::Empty) => break,
                        Err(TryRecvError::Disconnected) => break,
                    }
                }

                if let Err(error) = sink(&batch) {
                    counters
                        .failed
                        .fetch_add(batch.len() as u64, Ordering::Relaxed);
                    tracing::warn!(
                        %error,
                        batch_size = batch.len(),
                        "Failed to persist audit metadata batch"
                    );
                } else {
                    counters
                        .written
                        .fetch_add(batch.len() as u64, Ordering::Relaxed);
                }
                counters.pending.fetch_sub(batch.len(), Ordering::SeqCst);

                if let Some(ack) = shutdown_ack {
                    let _ = ack.send(());
                    return;
                }
            }
            AuditCommand::Shutdown(ack) => {
                let _ = ack.send(());
                return;
            }
        }
    }
}

pub fn get_setting(key: &str) -> Result<Option<String>> {
    let conn = get_db().map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let result = stmt.query_row([key], |row| row.get(0)).ok();
    Ok(result)
}

pub fn set_setting(key: &str, value: &str) -> Result<()> {
    let conn = get_db().map_err(|e| anyhow::anyhow!("{e}"))?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn audit_entry(index: usize) -> AuditLogEntry {
        AuditLogEntry {
            device_id: "device-1".to_string(),
            action: "input".to_string(),
            card_id: Some("card-1".to_string()),
            summary: format!("sequence-{index}"),
        }
    }

    #[test]
    fn database_runtime_uses_the_explicit_database_path_and_wal() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "threadterm-explicit-db-{}-{nonce}",
            std::process::id()
        ));
        let database = directory.join("nested").join("threadterm.db");

        let runtime = build_database_runtime(&database).expect("build database runtime");
        assert_eq!(runtime.path, database);
        assert!(runtime.path.exists());
        let connection = runtime.pool.get().expect("pooled connection");
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal mode");
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        drop(connection);
        drop(runtime);

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn blocked_audit_sink_does_not_delay_or_reorder_input_metadata() {
        let records = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink_records = records.clone();
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let mut block_first_batch = true;
        let writer = AuditLogWriter::new(
            2048,
            Box::new(move |entries| {
                if block_first_batch {
                    block_first_batch = false;
                    let _ = started_tx.send(());
                    let _ = release_rx.recv();
                }
                sink_records
                    .lock()
                    .expect("records lock")
                    .extend(entries.iter().map(|entry| entry.summary.clone()));
                Ok(())
            }),
        );

        assert!(writer.enqueue(audit_entry(0)));
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("audit sink should start");

        let enqueue_started = Instant::now();
        for index in 1..=1000 {
            assert!(writer.enqueue(audit_entry(index)));
        }
        assert!(
            enqueue_started.elapsed() < Duration::from_millis(100),
            "audit enqueue must not wait for a blocked database sink"
        );

        release_tx.send(()).expect("release audit sink");
        let diagnostics = writer.shutdown(Duration::from_secs(2));
        assert_eq!(diagnostics.written, 1001);
        assert_eq!(diagnostics.pending, 0);
        let records = records.lock().expect("records lock");
        assert_eq!(records.len(), 1001);
        for (index, summary) in records.iter().enumerate() {
            assert_eq!(summary, &format!("sequence-{index}"));
        }
    }

    #[test]
    fn full_audit_queue_drops_metadata_without_blocking() {
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let mut block_first_batch = true;
        let writer = AuditLogWriter::new(
            1,
            Box::new(move |_| {
                if block_first_batch {
                    block_first_batch = false;
                    let _ = started_tx.send(());
                    let _ = release_rx.recv();
                }
                Ok(())
            }),
        );

        assert!(writer.enqueue(audit_entry(0)));
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("audit sink should start");
        assert!(writer.enqueue(audit_entry(1)));
        assert!(!writer.enqueue(audit_entry(2)));

        release_tx.send(()).expect("release audit sink");
        let diagnostics = writer.shutdown(Duration::from_secs(2));
        assert_eq!(diagnostics.written, 2);
        assert_eq!(diagnostics.dropped, 1);
        assert_eq!(diagnostics.pending, 0);
    }

    #[test]
    fn audit_sink_failures_are_counted_without_stalling_shutdown() {
        let writer = AuditLogWriter::new(
            8,
            Box::new(|_| Err(anyhow::anyhow!("synthetic audit sink failure"))),
        );
        assert!(writer.enqueue(audit_entry(0)));
        assert!(writer.enqueue(audit_entry(1)));

        let diagnostics = writer.shutdown(Duration::from_secs(2));
        assert_eq!(diagnostics.failed, 2);
        assert_eq!(diagnostics.pending, 0);
        assert_eq!(diagnostics.shutdown_timeouts, 0);
    }
}
