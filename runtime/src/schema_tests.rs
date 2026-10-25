use super::Database;
use rusqlite::Connection;
use serde_json::Value;
use std::path::{Path, PathBuf};

fn old_fixture(root: &Path) -> PathBuf {
    let fixture = root.join("fixture.sqlite");
    let conn = Connection::open(&fixture).unwrap();
    conn.execute_batch(include_str!("../tests/fixtures/schema-v0.sql"))
        .unwrap();
    drop(conn);
    let path = root.join("copy.sqlite");
    std::fs::copy(fixture, &path).unwrap();
    path
}

fn backups(root: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(root.join("backups"))
        .into_iter()
        .flatten()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "sqlite"))
        .collect()
}

fn value(conn: &Connection, key: &str) -> String {
    conn.query_row("SELECT value FROM metadata WHERE key=?", [key], |row| {
        row.get(0)
    })
    .unwrap()
}

#[test]
fn schema_empty_first_creation_has_no_upgrade_data_to_back_up() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("fresh.sqlite");
    drop(Database::open(&path).unwrap());
    assert!(backups(root.path()).is_empty());
    let conn = Connection::open(path).unwrap();
    assert_eq!(value(&conn, "schema.version"), "1");
    let history: Value = serde_json::from_str(&value(&conn, "schema.history")).unwrap();
    assert!(history[0]["backupFile"].is_null());
}

#[test]
fn schema_old_copy_is_backed_up_verified_and_migrated_only_once() {
    let root = tempfile::tempdir().unwrap();
    let path = old_fixture(root.path());
    drop(Database::open(&path).unwrap());
    let files = backups(root.path());
    assert_eq!(files.len(), 1, "destructive upgrade must leave a backup");
    let backup = Connection::open(&files[0]).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        backup
            .query_row("SELECT name FROM presets", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "Daily"
    );
    let conn = Connection::open(&path).unwrap();
    assert_eq!(value(&conn, "schema.version"), "1");
    assert_eq!(value(&conn, "schema.minReader"), "1");
    let history: Value = serde_json::from_str(&value(&conn, "schema.history")).unwrap();
    assert_eq!(history.as_array().unwrap().len(), 1);
    assert_eq!(history[0]["version"], 1);
    assert!(history[0]["appliedAt"].as_str().is_some());
    assert_eq!(history[0]["appVersion"], crate::RUNTIME_VERSION);
    assert_eq!(
        Path::new(history[0]["backupFile"].as_str().unwrap()),
        files[0]
    );
    assert!(conn.prepare("SELECT * FROM presets").is_err());
    conn.execute_batch("CREATE TABLE presets(id INTEGER); INSERT INTO presets VALUES(7);")
        .unwrap();
    drop(Database::open(&path).unwrap());
    assert_eq!(
        conn.query_row("SELECT id FROM presets", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        7
    );
    assert_eq!(backups(root.path()), files);
    assert_eq!(
        serde_json::from_str::<Value>(&value(&conn, "schema.history")).unwrap(),
        history
    );
}

/// Most installed databases already lost `presets` on an earlier open; the
/// upgrade then retires only rebuildable usage tables and must not copy a
/// large database on the startup path.
#[test]
fn schema_unversioned_database_without_presets_upgrades_without_a_backup() {
    let root = tempfile::tempdir().unwrap();
    let path = old_fixture(root.path());
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "DROP TABLE presets;
             CREATE TABLE usage_facts(fact TEXT); INSERT INTO usage_facts VALUES('legacy usage');",
        )
        .unwrap();
    }
    drop(Database::open(&path).unwrap());
    assert!(backups(root.path()).is_empty(), "nothing unrecoverable to back up");
    let conn = Connection::open(&path).unwrap();
    assert_eq!(value(&conn, "schema.version"), "1");
    let history: Value = serde_json::from_str(&value(&conn, "schema.history")).unwrap();
    assert!(history[0]["backupFile"].is_null());
    assert!(conn.prepare("SELECT * FROM usage_facts").is_err());
    let ledger = crate::usage_ledger::ledger_db::test_connection(&path).unwrap();
    assert_eq!(
        ledger
            .query_row(
                "SELECT value FROM usage_ledger_state WHERE key='ledger-rescan-required'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "1"
    );
}

#[test]
fn schema_backup_failure_keeps_legacy_rows_and_version_zero() {
    let root = tempfile::tempdir().unwrap();
    let path = old_fixture(root.path());
    // A file in place of the directory fails consistently even with admin rights.
    std::fs::write(root.path().join("backups"), "blocked").unwrap();
    let error = Database::open(&path)
        .err()
        .expect("backup failure must stop startup");
    assert!(format!("{error:#}").contains("schema_backup_failed"));
    let conn = Connection::open(path).unwrap();
    assert_eq!(
        conn.query_row("SELECT name FROM presets", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "Daily"
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM metadata WHERE key LIKE 'schema.%'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn schema_future_reader_is_rejected_before_any_writes() {
    let root = tempfile::tempdir().unwrap();
    let path = old_fixture(root.path());
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("INSERT INTO metadata VALUES('schema.version','999'); INSERT INTO metadata VALUES('schema.minReader','999');").unwrap();
    let before = std::fs::read(&path).unwrap();
    let error = Database::open(&path)
        .err()
        .expect("future reader must refuse startup");
    assert!(format!("{error:#}").contains("schema_too_new"));
    assert_eq!(std::fs::read(path).unwrap(), before);
    assert!(backups(root.path()).is_empty());
}

#[test]
fn schema_pre_upgrade_retention_keeps_three_including_new_backup() {
    let root = tempfile::tempdir().unwrap();
    let path = old_fixture(root.path());
    std::fs::create_dir(root.path().join("backups")).unwrap();
    for day in 1..=4 {
        std::fs::write(
            root.path().join(format!(
                "backups/pre-upgrade-v0-to-v1-2000010{day}T000000000000000Z.sqlite"
            )),
            "old",
        )
        .unwrap();
    }
    let manual = root.path().join("backups/manual.sqlite");
    std::fs::write(&manual, "keep").unwrap();
    drop(Database::open(&path).unwrap());
    let files = backups(root.path());
    assert_eq!(
        files.len(),
        4,
        "three pre-upgrade backups plus the manual backup"
    );
    assert!(manual.is_file());
    let current = files
        .iter()
        .find(|p| !p.file_name().unwrap().to_string_lossy().contains("200001") && **p != manual)
        .unwrap();
    let conn = Connection::open(current).unwrap();
    assert_eq!(
        conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}

#[test]
fn schema_usage_ledger_stamps_and_rejects_future_writer_and_reader() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("main.sqlite");
    drop(Database::open(&path).unwrap());
    let conn = crate::usage_ledger::ledger_db::test_connection(&path).unwrap();
    assert_eq!(value(&conn, "schema.version"), "1");
    assert_eq!(value(&conn, "schema.minReader"), "1");
    conn.execute(
        "UPDATE metadata SET value='999' WHERE key='schema.minReader'",
        [],
    )
    .unwrap();
    assert!(format!(
        "{:#}",
        crate::usage_ledger::ledger_db::test_connection(&path).unwrap_err()
    )
    .contains("schema_too_new"));
    assert!(format!(
        "{:#}",
        crate::usage_ledger::ledger_db::reader(&path).unwrap_err()
    )
    .contains("schema_too_new"));
}

#[test]
fn schema_online_backup_includes_uncheckpointed_wal_and_legacy_usage() {
    let root = tempfile::tempdir().unwrap();
    let path = old_fixture(root.path());
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        UPDATE presets SET name='In WAL';
        CREATE TABLE usage_facts(fact TEXT); INSERT INTO usage_facts VALUES('legacy usage');",
    )
    .unwrap();
    assert!(path.with_extension("sqlite-wal").is_file());
    drop(Database::open(&path).unwrap());
    let files = backups(root.path());
    let backup = Connection::open(&files[0]).unwrap();
    assert_eq!(
        backup
            .query_row("SELECT name FROM presets", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "In WAL"
    );
    assert_eq!(
        backup
            .query_row("SELECT fact FROM usage_facts", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "legacy usage"
    );
    assert!(conn
        .query_row("SELECT COUNT(*) FROM usage_facts", [], |r| r
            .get::<_, i64>(0))
        .is_err());
    let ledger = crate::usage_ledger::ledger_db::test_connection(&path).unwrap();
    assert_eq!(
        ledger
            .query_row(
                "SELECT value FROM usage_ledger_state WHERE key='ledger-rescan-required'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "1"
    );
}

#[test]
fn schema_failed_migration_rolls_back_data_and_version_together() {
    let root = tempfile::tempdir().unwrap();
    let path = old_fixture(root.path());
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE preset_references(id TEXT REFERENCES presets(id) ON DELETE RESTRICT);
        INSERT INTO preset_references VALUES('legacy');",
    )
    .unwrap();
    assert!(Database::open(&path).is_err());
    assert_eq!(
        conn.query_row("SELECT name FROM presets", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "Daily"
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM metadata WHERE key LIKE 'schema.%'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let files = backups(root.path());
    assert_eq!(files.len(), 1);
    assert_eq!(
        Connection::open(&files[0])
            .unwrap()
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}

#[test]
fn schema_external_write_after_backup_blocks_destructive_migration() {
    let root = tempfile::tempdir().unwrap();
    let path = old_fixture(root.path());
    let mut conn = Connection::open(&path).unwrap();
    let backup = super::schema::prepare_main(&conn, &path).unwrap();
    let writer = Connection::open(&path).unwrap();
    writer
        .execute("UPDATE presets SET name='Written after backup'", [])
        .unwrap();
    let error = super::schema::migrate_main(&mut conn, backup).unwrap_err();
    assert!(format!("{error:#}").contains("schema_backup_failed"));
    assert_eq!(
        conn.query_row("SELECT name FROM presets", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "Written after backup"
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM metadata WHERE key='schema.version'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn schema_failed_main_migration_does_not_clear_existing_ledger_facts() {
    let root = tempfile::tempdir().unwrap();
    let path = old_fixture(root.path());
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE usage_facts(fact TEXT); INSERT INTO usage_facts VALUES('old main usage');
        CREATE TABLE preset_references(id TEXT REFERENCES presets(id) ON DELETE RESTRICT);
        INSERT INTO preset_references VALUES('legacy');",
    )
    .unwrap();
    let ledger = crate::usage_ledger::ledger_db::test_connection(&path).unwrap();
    ledger.execute_batch("INSERT INTO usage_facts(fact_key,provider,occurred_at,local_day,native_session_id,subagent,quality,source,parser_version)
        VALUES('survives','codex','2026-01-01T00:00:00Z','2026-01-01','fixture',0,'exact','native:fixture',1);").unwrap();
    assert!(Database::open(&path).is_err());
    let worker = crate::usage_ledger::ledger_db::open_worker(&path).unwrap();
    assert_eq!(
        worker
            .query_row("SELECT fact_key FROM usage_facts", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "survives"
    );
    assert_eq!(
        conn.query_row("SELECT fact FROM usage_facts", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "old main usage"
    );
}

#[test]
fn schema_committed_rescan_handoff_retries_on_reopen() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("main.sqlite");
    drop(Database::open(&path).unwrap());
    let conn = Connection::open(&path).unwrap();
    conn.execute(
        "INSERT INTO metadata VALUES('schema.usageRescanRequired','1')",
        [],
    )
    .unwrap();
    let before = backups(root.path());
    drop(Database::open(&path).unwrap());
    assert_eq!(backups(root.path()), before);
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM metadata WHERE key='schema.usageRescanRequired'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let ledger = crate::usage_ledger::ledger_db::test_connection(&path).unwrap();
    assert_eq!(
        ledger
            .query_row(
                "SELECT value FROM usage_ledger_state WHERE key='ledger-rescan-required'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "1"
    );
}

#[test]
fn schema_first_reader_stamps_an_existing_unversioned_ledger() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("main.sqlite");
    drop(Database::open(&path).unwrap());
    let legacy = Connection::open(crate::usage_ledger::ledger_db::path_for(&path)).unwrap();
    legacy
        .execute_batch("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('keep');")
        .unwrap();
    let reader = crate::usage_ledger::ledger_db::reader(&path).unwrap();
    let reader = reader.lock().unwrap();
    assert_eq!(value(&reader, "schema.version"), "1");
    assert_eq!(value(&reader, "schema.minReader"), "1");
    assert_eq!(
        reader
            .query_row("SELECT value FROM retained", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "keep"
    );
}
