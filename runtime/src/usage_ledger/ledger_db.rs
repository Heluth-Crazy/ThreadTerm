//! Storage location for the rebuildable usage ledger.
//!
//! The ledger keeps its bulk native data (facts, observations, cursors and the
//! materialized query projections) in its own SQLite file next to the main
//! runtime database. Ledger commits therefore never share a WAL, a checkpoint
//! or a write lock with Chat, terminals or the rest of ThreadTerm.
//!
//! ThreadTerm-owned rows stay in the main database and are only *read* here:
//! `sessions`, `projects` and `usage_records` are exposed to the ledger
//! connection as temporary views over a read-only `ATTACH`. The single
//! exception is the append-only live-usage event log, which the Chat projection
//! writes inside its own transaction; the ledger copies those events into its
//! facts table and can rebuild the copy at any time.

use super::{live, scanner, store};
use anyhow::{anyhow, Result};
use rusqlite::{Connection, OpenFlags};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

pub const LEDGER_FILE: &str = "usage-ledger.sqlite";
const MAIN_SCHEMA: &str = "tt";
/// ThreadTerm tables the ledger reads through a temporary view.
const MAIN_TABLES: [&str; 4] = ["sessions", "projects", "usage_records", "usage_live_events"];
const LEGACY_STATE_KEY: &str = "ledger-rescan-required";

/// Tables UA1 created inside the main database before the ledger moved to its
/// own file. Their contents are rebuildable from provider history.
const LEGACY_TABLES: [&str; 24] = [
    "usage_activity_daily",
    "usage_activity_dirty",
    "usage_daily_cube",
    "usage_daily_rollups",
    "usage_dimension_masks",
    "usage_fact_observations",
    "usage_facts",
    "usage_intervals",
    "usage_ledger_sessions",
    "usage_ledger_state",
    "usage_live_intervals",
    "usage_live_rollups",
    "usage_live_turns",
    "usage_native_coverage",
    "usage_query_sessions",
    "usage_scan_providers",
    "usage_session_day_sets",
    "usage_session_default_sort_ranges_packed",
    "usage_session_keys",
    "usage_session_prefix",
    "usage_session_slices",
    "usage_session_sort_ranges",
    "usage_sources",
    "usage_superseded_facts",
];

/// The ledger file lives next to the main database, or in the current
/// directory when the main database has no parent path.
pub fn path_for(main: &Path) -> PathBuf {
    match main.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        Some(dir) => dir.join(LEDGER_FILE),
        None => PathBuf::from(LEDGER_FILE),
    }
}

/// One-time main-database migration for installations that still keep UA1's
/// ledger tables there. The native ledger is rebuildable, so the tables are
/// dropped and a full rescan is requested instead of moving megabytes of pages.
pub fn migrate_legacy_main_tables(conn: &Connection) -> Result<()> {
    let present: Vec<&str> = LEGACY_TABLES
        .into_iter()
        .filter(|table| table_exists(conn, table).unwrap_or(false))
        .collect();
    if present.is_empty() {
        return Ok(());
    }
    // UA1 added these indexes on main tables for its import queries; the ledger
    // no longer owns indexes there.
    conn.execute_batch(
        "DROP INDEX IF EXISTS usage_sessions_native_lookup;
         DROP INDEX IF EXISTS usage_records_ledger_import;",
    )?;
    for table in present {
        conn.execute_batch(&format!("DROP TABLE IF EXISTS {table}"))?;
    }
    if let Some(main) = conn.path() {
        // A fresh file already implies a full scan; the marker also forces one
        // when a previous attempt created the file before the drop finished.
        let _ = mark_rescan_required(Path::new(main));
    }
    Ok(())
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            [table],
            |row| row.get::<_, i64>(0),
        )
        .is_ok())
}

fn mark_rescan_required(main: &Path) -> Result<()> {
    let conn = worker_connection(main)?;
    conn.execute(
        "INSERT INTO usage_ledger_state(key,value) VALUES(?, '1')
         ON CONFLICT(key) DO UPDATE SET value='1'",
        [LEGACY_STATE_KEY],
    )?;
    Ok(())
}

/// Returns `true` when the ledger must drop everything before it is used.
fn take_rescan_marker(conn: &Connection) -> Result<bool> {
    let marked = conn
        .query_row(
            "SELECT value FROM usage_ledger_state WHERE key=?",
            [LEGACY_STATE_KEY],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .is_some_and(|value| value == "1");
    if !marked {
        return Ok(false);
    }
    for table in LEGACY_TABLES {
        if table == "usage_ledger_state" {
            continue;
        }
        let _ = conn.execute_batch(&format!("DELETE FROM {table}"));
    }
    conn.execute(
        "DELETE FROM usage_ledger_state WHERE key<>?",
        [LEGACY_STATE_KEY],
    )?;
    conn.execute(
        "DELETE FROM usage_ledger_state WHERE key=?",
        [LEGACY_STATE_KEY],
    )?;
    Ok(true)
}

/// Long-lived worker connection: WAL, short write batches and ledger-local
/// checkpoint cadence. This connection never writes to the main database.
pub fn worker_connection(main: &Path) -> Result<Connection> {
    let conn = open_file(main, true)?;
    conn.execute_batch(
        "PRAGMA main.journal_mode=WAL;
         PRAGMA main.synchronous=NORMAL;
         PRAGMA main.wal_autocheckpoint=0;
         PRAGMA temp_store=MEMORY;",
    )?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))?;
    conn.set_prepared_statement_cache_capacity(128);
    // Every worker write may reach the checkpoint cadence, including the live-log
    // import that runs before the query cache configures this connection.
    super::write_priority::initialize_checkpoint_cadence(&conn)?;
    Ok(conn)
}

/// Opens the ledger for the history worker and applies a pending rescan.
pub fn open_worker(main: &Path) -> Result<Connection> {
    let conn = worker_connection(main)?;
    take_rescan_marker(&conn)?;
    Ok(conn)
}

/// Cached read connection used by the `usage.ledger.*` query RPCs.
pub fn reader(main: &Path) -> Result<Arc<Mutex<Connection>>> {
    cached(&READERS, main, || {
        let conn = open_file(main, false)?;
        conn.busy_timeout(std::time::Duration::from_millis(1000))?;
        conn.set_prepared_statement_cache_capacity(64);
        conn.execute_batch("PRAGMA query_only=1")?;
        Ok(conn)
    })
}

/// Cached connection for the live per-request accounting copy written from the
/// Chat projection. A short timeout keeps chat latency bounded; events that
/// arrive while the history worker holds the file stay in the main-database log
/// and are copied by the next scan.
pub fn live_connection(main: &Path) -> Result<Arc<Mutex<Connection>>> {
    cached(&LIVE, main, || {
        let conn = open_file(main, true)?;
        conn.execute_batch("PRAGMA main.synchronous=NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_millis(150))?;
        conn.set_prepared_statement_cache_capacity(64);
        Ok(conn)
    })
}

/// Ledger connection for tests and diagnostics: opens the file without any
/// cached state.
#[cfg(test)]
pub fn test_connection(main: &Path) -> Result<Connection> {
    open_file(main, true)
}

fn cached(
    registry: &'static OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<Connection>>>>>,
    main: &Path,
    open: impl FnOnce() -> Result<Connection>,
) -> Result<Arc<Mutex<Connection>>> {
    let key = absolute(main);
    let mut guard = registry
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| anyhow!("usage_ledger_connection_lock"))?;
    if let Some(conn) = guard.get(&key) {
        return Ok(Arc::clone(conn));
    }
    let conn = Arc::new(Mutex::new(open()?));
    // Test fixtures create many short-lived runtime databases; keep the cache
    // from growing without bound.
    if guard.len() >= 16 {
        guard.clear();
    }
    guard.insert(key, Arc::clone(&conn));
    Ok(conn)
}

fn absolute(main: &Path) -> PathBuf {
    if main.is_absolute() {
        main.to_owned()
    } else {
        std::env::current_dir()
            .map(|dir| dir.join(main))
            .unwrap_or_else(|_| main.to_owned())
    }
}

fn open_file(main: &Path, create: bool) -> Result<Connection> {
    let path = path_for(main);
    let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI;
    if create {
        flags |= OpenFlags::SQLITE_OPEN_CREATE;
    } else if !path.is_file() {
        // Read RPCs may arrive before the first scan; create the empty schema
        // once and continue read-only afterwards.
        drop(open_file(main, true)?);
    }
    let conn = Connection::open_with_flags(&path, flags)?;
    #[cfg(test)]
    if let Ok(mut paths) = MAIN_PATHS.get_or_init(Default::default).lock() {
        paths.insert(path.clone(), absolute(main));
    }
    if create {
        initialize(&conn)?;
    }
    // Bounded 64 MiB page cache: a sessions page hydrates slices, ranges and
    // ThreadTerm rows, which now live in two files.
    conn.pragma_update(None, "cache_size", -65536)?;
    attach_main(&conn, main)?;
    guard_main_read_only(&conn);
    Ok(conn)
}

/// Ledger schema, owned entirely by the ledger file.
pub fn initialize(conn: &Connection) -> Result<()> {
    scanner::initialize(conn)?;
    store::initialize(conn)?;
    live::initialize(conn)?;
    Ok(())
}

fn attach_main(conn: &Connection, main: &Path) -> Result<()> {
    // `mode=ro` is the guarantee, not a convention: SQLite refuses every write
    // that would reach ThreadTerm's file, including a checkpoint. `immutable=1`
    // would be wrong here, the database is live and written by Chat.
    let uri = main_uri(main, true);
    conn.execute(&format!("ATTACH DATABASE ?1 AS {MAIN_SCHEMA}"), [uri])?;
    // Temporary views shadow the attached schema for the ledger's SQL. They are
    // per connection and never modify the main database. A fixture main database
    // may not carry every table yet, so missing sources are skipped.
    for table in MAIN_TABLES {
        let present = conn
            .query_row(
                &format!(
                    "SELECT 1 FROM {MAIN_SCHEMA}.sqlite_master WHERE type='table' AND name=?1"
                ),
                [table],
                |row| row.get::<_, i64>(0),
            )
            .is_ok();
        if !present {
            continue;
        }
        conn.execute_batch(&format!(
            "CREATE TEMP VIEW IF NOT EXISTS {table} AS SELECT * FROM {MAIN_SCHEMA}.{table}"
        ))?;
    }
    Ok(())
}

/// Test fixtures own the main database and seed `sessions`, `projects` and
/// `usage_records` there. Production code has no equivalent: the ledger attach
/// is read-only.
#[cfg(test)]
pub fn fixture_main(conn: &Connection) -> Connection {
    let path = conn
        .path()
        .and_then(|path| {
            MAIN_PATHS
                .get_or_init(Default::default)
                .lock()
                .ok()
                .and_then(|paths| paths.get(Path::new(path)).cloned())
        })
        .expect("usage_ledger_fixture_main_path");
    Connection::open(path).expect("usage_ledger_fixture_main_connection")
}

fn main_uri(path: &Path, read_only: bool) -> String {
    let mut uri = String::from("file:");
    for ch in path.to_string_lossy().chars() {
        match ch {
            '\\' => uri.push('/'),
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' | '/' | ':' => uri.push(ch),
            other => {
                let mut buffer = [0_u8; 4];
                for byte in other.encode_utf8(&mut buffer).as_bytes() {
                    uri.push_str(&format!("%{byte:02X}"));
                }
            }
        }
    }
    if read_only {
        uri.push_str("?mode=ro");
    }
    uri
}

/// Second line of defence on top of the read-only attach: every statement the
/// ledger prepares may only read the attached schema. A write that slipped past
/// the attach mode would fail loudly here instead of silently reaching
/// ThreadTerm's file.
unsafe extern "C" fn authorize_ledger_reads(
    _user_data: *mut std::ffi::c_void,
    action: std::ffi::c_int,
    _arg1: *const std::ffi::c_char,
    _arg2: *const std::ffi::c_char,
    database: *const std::ffi::c_char,
    _accessor: *const std::ffi::c_char,
) -> std::ffi::c_int {
    use rusqlite::ffi;
    if action == ffi::SQLITE_ATTACH || action == ffi::SQLITE_DETACH {
        return ffi::SQLITE_DENY;
    }
    let main_schema = !database.is_null()
        && std::ffi::CStr::from_ptr(database).to_bytes() == MAIN_SCHEMA.as_bytes();
    if main_schema && action != ffi::SQLITE_READ && action != ffi::SQLITE_SELECT {
        return ffi::SQLITE_DENY;
    }
    ffi::SQLITE_OK
}

fn guard_main_read_only(conn: &Connection) {
    // SAFETY: the callback captures nothing and outlives the connection; these
    // connections never install a different authorizer.
    unsafe {
        rusqlite::ffi::sqlite3_set_authorizer(
            conn.handle(),
            Some(authorize_ledger_reads),
            std::ptr::null_mut(),
        );
    }
}

static READERS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<Connection>>>>> = OnceLock::new();
static LIVE: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<Connection>>>>> = OnceLock::new();
#[cfg(test)]
static MAIN_PATHS: OnceLock<Mutex<HashMap<PathBuf, PathBuf>>> = OnceLock::new();

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_ledger::{discovery, queries};
    use rusqlite::ErrorCode;
    use serde_json::json;
    use std::{fs, sync::atomic::AtomicBool, time::SystemTime};

    /// Creates a real runtime database with one project, one session and one
    /// legacy usage record, and keeps a connection open so the main file stays
    /// in WAL mode exactly like the running runtime.
    fn seeded_main(dir: &Path) -> (PathBuf, Connection) {
        let main = dir.join("runtime.sqlite");
        drop(crate::db::Database::open(&main).unwrap());
        let probe = Connection::open(&main).unwrap();
        let project_root = dir.join("workspace").to_string_lossy().replace('\\', "/");
        probe
            .execute_batch(&format!(
                "INSERT INTO projects(id,name,path,created_at)
                   VALUES('project','Project','{project_root}','2026-01-01T00:00:00Z');
                 INSERT INTO sessions(id,project_id,worktree_path,title,provider,mode,status,created_at,updated_at,native_id,followed,read_only)
                   VALUES('session','project','{project_root}','Session','claude','chat','exited','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','synthetic-session',0,0);
                 INSERT INTO usage_records(id,session_id,provider,recorded_at,input_tokens,output_tokens,model)
                   VALUES('record','session','claude','2026-01-04T15:00:00Z',5,3,'fixture-unpriced-model');"
            ))
            .unwrap();
        (main, probe)
    }

    fn claude_line(request: &str, input: i64) -> String {
        format!(
            "{}\n",
            json!({"type":"assistant","sessionId":"synthetic-session","timestamp":"2026-01-04T15:00:00Z","cwd":std::env::temp_dir(),"requestId":request,"message":{"id":request,"model":"fixture-unpriced-model","usage":{"input_tokens":input,"output_tokens":7,"cache_read_input_tokens":13}}})
        )
    }

    fn fingerprint(path: &Path) -> (u64, Option<SystemTime>) {
        let meta = fs::metadata(path).unwrap();
        (meta.len(), meta.modified().ok())
    }

    fn data_version(conn: &Connection) -> i64 {
        conn.pragma_query_value(None, "data_version", |row| row.get(0))
            .unwrap()
    }

    /// A live request logged while the ledger was busy is imported first on the
    /// next scan, before the query cache configures the worker connection. That
    /// import must not fail (it once aborted every scan with `no such table:
    /// temp.usage_checkpoint_cadence`, leaving the page at live usage only).
    #[test]
    fn a_pending_live_log_row_imports_on_a_fresh_worker_connection() {
        let dir = tempfile::tempdir().unwrap();
        let (main, probe) = seeded_main(dir.path());
        let mut fact = crate::usage_ledger::facts::Fact::new(
            "codex",
            "synthetic-session",
            "synthetic-session:live-1",
            "2026-01-04T15:00:00Z",
        );
        fact.threadterm_session_id = Some("session".into());
        fact.turn_id = Some("turn".into());
        fact.buckets.input = Some(23_950);
        fact.buckets.output = Some(39);
        fact.source = "live:session:turn:usage:0:0".into();
        probe
            .execute(
                "INSERT INTO usage_live_events(fact_key,threadterm_session_id,turn_id,created_at,fact)
                 VALUES(?1,'session','turn','2026-01-04T15:00:00Z',?2)",
                rusqlite::params![fact.key, serde_json::to_string(&fact).unwrap()],
            )
            .unwrap();
        let conn = open_worker(&main).unwrap();
        crate::usage_ledger::live::import_log(&conn, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM usage_facts", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    /// The attach itself is the guarantee: SQLite refuses writes that reach the
    /// ThreadTerm file, so a missing `mode=ro` cannot go unnoticed.
    #[test]
    fn the_attached_main_database_is_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let (main, probe) = seeded_main(dir.path());
        let version = data_version(&probe);

        // An unguarded connection: the read-only attach alone refuses the write.
        let raw = Connection::open(dir.path().join("raw.sqlite")).unwrap();
        raw.execute("ATTACH DATABASE ?1 AS tt", [main_uri(&main, true)])
            .unwrap();
        let error = raw
            .execute(
                "INSERT INTO tt.projects(id,name,path,created_at)
                 VALUES('extra','Extra',?1,'2026-01-01T00:00:00Z')",
                [dir.path().join("extra").to_string_lossy().to_string()],
            )
            .unwrap_err();
        eprintln!("write through a read-only attach: {error:?}");
        assert!(
            matches!(error, rusqlite::Error::SqliteFailure(detail, _) if detail.code == ErrorCode::ReadOnly),
            "a write through the read-only attachment must be refused by SQLite: {error:?}"
        );

        // The production connection is additionally guarded by the authorizer.
        let conn = test_connection(&main).unwrap();
        let guarded = conn
            .execute(
                "INSERT INTO tt.projects(id,name,path,created_at)
                 VALUES('extra','Extra',?1,'2026-01-01T00:00:00Z')",
                [dir.path().join("extra").to_string_lossy().to_string()],
            )
            .unwrap_err();
        assert!(
            matches!(guarded, rusqlite::Error::SqliteFailure(detail, _) if detail.code == ErrorCode::AuthorizationForStatementDenied),
            "the authorizer must refuse the write before SQLite runs it: {guarded:?}"
        );
        // Reading through the temporary views still works.
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM sessions", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM usage_records", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(data_version(&probe), version);
    }

    /// The authorizer is the enforced guard on top of the attach mode: even a
    /// connection that opened the main file read-write cannot write through it.
    #[test]
    fn the_authorizer_denies_writes_through_the_attachment() {
        let dir = tempfile::tempdir().unwrap();
        let (main, probe) = seeded_main(dir.path());
        let conn = Connection::open(dir.path().join("guard.sqlite")).unwrap();
        conn.execute("ATTACH DATABASE ?1 AS tt", [main_uri(&main, false)])
            .unwrap();
        guard_main_read_only(&conn);
        let version = data_version(&probe);

        for statement in [
            "INSERT INTO tt.projects(id,name,path,created_at) VALUES('x','x','x','2026-01-01T00:00:00Z')",
            "UPDATE tt.sessions SET title='x'",
            "DELETE FROM tt.usage_records",
            "CREATE TABLE tt.extra(n INTEGER)",
            "DROP TABLE tt.usage_records",
        ] {
            let error = conn.execute_batch(statement).unwrap_err();
            assert!(
                matches!(error, rusqlite::Error::SqliteFailure(detail, _) if detail.code == ErrorCode::AuthorizationForStatementDenied),
                "{statement} must be denied by the authorizer: {error:?}"
            );
        }
        // Reads and ledger-file writes stay allowed.
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM tt.sessions", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS local(n INTEGER); INSERT INTO local VALUES(1);",
        )
        .unwrap();
        assert_eq!(data_version(&probe), version);
    }

    /// Why the worker needs `mode=ro` *and* a schema-qualified checkpoint: an
    /// unqualified `PRAGMA wal_checkpoint` walks every attached database
    /// (sqlite3Checkpoint with iDb==SQLITE_MAX_DB) and reaches the ThreadTerm
    /// file, which is exactly the "disk I/O error" UA1s saw inside
    /// `rebuild_query_cache`.
    #[test]
    fn an_unqualified_wal_checkpoint_reaches_every_attached_database() {
        let dir = tempfile::tempdir().unwrap();
        let (main, probe) = seeded_main(dir.path());
        // Un-checkpointed frames in the main database's WAL.
        probe
            .execute(
                "INSERT INTO metadata(key,value) VALUES('probe','1')
                 ON CONFLICT(key) DO UPDATE SET value='1'",
                [],
            )
            .unwrap();
        let conn = test_connection(&main).unwrap();
        // Frames in the ledger's own WAL as well, so its checkpoint is a real one.
        conn.execute(
            "INSERT INTO usage_ledger_state(key,value) VALUES('probe','1')
             ON CONFLICT(key) DO UPDATE SET value='1'",
            [],
        )
        .unwrap();

        let unscoped = conn.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(()));
        eprintln!("unscoped wal_checkpoint: {unscoped:?}");
        assert!(
            unscoped.is_err(),
            "an unscoped checkpoint must not silently succeed against a read-only attach: {unscoped:?}"
        );
        conn.query_row("PRAGMA main.wal_checkpoint(PASSIVE)", [], |_| Ok(()))
            .expect("a schema-qualified checkpoint only touches the ledger file");
    }

    /// End to end: import, scan, rebuild, price and query the ledger the way the
    /// history worker and the read RPCs do, then compare the main database with
    /// the state before the run. Any write from a ledger connection would bump
    /// the data version or the file's size/mtime.
    #[test]
    fn a_full_scan_and_rebuild_leaves_the_main_database_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let (main, probe) = seeded_main(dir.path());
        let history = dir.path().join("synthetic-history");
        fs::create_dir_all(&history).unwrap();
        fs::write(history.join("session.jsonl"), claude_line("request-1", 11)).unwrap();

        let version = data_version(&probe);
        let before = fingerprint(&main);

        let conn = test_connection(&main).unwrap();
        let cancel = AtomicBool::new(false);
        live::import_log(&conn, &cancel).unwrap();
        assert!(store::rebuild_query_cache(&conn, &cancel).unwrap());
        store::import_legacy_cancellable(&conn, &cancel).unwrap();
        let root = discovery::Root {
            provider: "claude".into(),
            path: history.clone(),
            trees: vec![history.clone()],
        };
        scanner::scan(&root, &conn, &cancel, &mut |_, _| {}).unwrap();
        store::refresh_attributions(&conn, &cancel).unwrap();
        live::import_log(&conn, &cancel).unwrap();
        store::rebuild_dirty_activity(&conn, &cancel).unwrap();
        store::reprice_all(&conn, &json!({}), &cancel).unwrap();
        assert!(store::rebuild_query_cache(&conn, &cancel).unwrap());
        assert!(
            conn.query_row("SELECT COUNT(*) FROM usage_facts", [], |row| row
                .get::<_, i64>(0))
                .unwrap()
                > 0
        );

        {
            let reader = reader(&main).unwrap();
            let guard = reader.lock().unwrap();
            for (method, params) in [
                ("usage.ledger.summary", json!({})),
                (
                    "usage.ledger.series",
                    json!({"filters":{"from":"2026-01-01","to":"2026-01-10"},"granularity":"day"}),
                ),
                ("usage.ledger.breakdown", json!({"dimension":"model"})),
                (
                    "usage.ledger.sessions",
                    json!({"sort":"activeTime","limit":10}),
                ),
            ] {
                let value = queries::query(&guard, method, &params)
                    .unwrap_or_else(|error| panic!("{method} failed: {error:?}"));
                assert!(value.is_object(), "{method} must return an object");
            }
        }

        assert_eq!(
            data_version(&probe),
            version,
            "a ledger connection committed to the main database"
        );
        assert_eq!(
            fingerprint(&main),
            before,
            "a ledger connection wrote the main database file"
        );
    }

    /// The delete-the-ledger-file recovery path also has to stay inside the
    /// read-only attachment.
    #[test]
    fn rebuilding_after_deleting_the_ledger_file_does_not_touch_the_main_database() {
        let dir = tempfile::tempdir().unwrap();
        let (main, probe) = seeded_main(dir.path());
        let ledger_file = path_for(&main);
        {
            let conn = test_connection(&main).unwrap();
            let cancel = AtomicBool::new(false);
            store::import_legacy_cancellable(&conn, &cancel).unwrap();
            assert!(store::rebuild_query_cache(&conn, &cancel).unwrap());
        }
        fs::remove_file(&ledger_file).unwrap();
        let version = data_version(&probe);
        let before = fingerprint(&main);
        let conn = test_connection(&main).unwrap();
        let cancel = AtomicBool::new(false);
        live::import_log(&conn, &cancel).unwrap();
        assert!(store::rebuild_query_cache(&conn, &cancel).unwrap());
        store::import_legacy_cancellable(&conn, &cancel).unwrap();
        store::reprice_all(&conn, &json!({}), &cancel).unwrap();
        assert_eq!(data_version(&probe), version);
        assert_eq!(fingerprint(&main), before);
    }
}
