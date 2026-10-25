//! Startup-only schema contracts. Additive compatibility DDL stays at its owner.
use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use rusqlite::{
    params, Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) const MAIN_VERSION: u32 = 3;
pub(crate) const LEDGER_VERSION: u32 = 1;
const HISTORY_LIMIT: usize = 16;

pub(crate) fn check_reader(conn: &Connection, supported: u32) -> Result<u32> {
    let metadata = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    if !metadata {
        return Ok(0);
    }
    let read = |key| -> Result<u32> {
        let raw: Option<String> = conn
            .query_row("SELECT value FROM metadata WHERE key=?", [key], |row| {
                row.get(0)
            })
            .optional()?;
        raw.map(|raw| {
            raw.parse::<u32>()
                .map_err(|_| anyhow!("schema_metadata_invalid: Invalid {key}"))
        })
        .transpose()
        .map(|v| v.unwrap_or(0))
    };
    if read("schema.minReader")? > supported {
        return Err(anyhow!("schema_too_new: This database was upgraded by a newer ThreadTerm. Update the app or restore a backup."));
    }
    read("schema.version")
}

fn record(
    tx: &Transaction<'_>,
    version: u32,
    min_reader: u32,
    backup: Option<&Path>,
) -> Result<()> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT value FROM metadata WHERE key='schema.history'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let mut history: Vec<Value> = raw
        .map(|raw| serde_json::from_str(&raw))
        .transpose()?
        .unwrap_or_default();
    history.push(json!({"version":version,"appliedAt":Utc::now().to_rfc3339(),"appVersion":crate::RUNTIME_VERSION,"backupFile":backup.map(|p|p.to_string_lossy())}));
    if history.len() > HISTORY_LIMIT {
        history.drain(..history.len() - HISTORY_LIMIT);
    }
    for (key, value) in [
        ("schema.version", version.to_string()),
        ("schema.minReader", min_reader.to_string()),
        ("schema.history", serde_json::to_string(&history)?),
    ] {
        tx.execute("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value])?;
    }
    Ok(())
}

struct Migration {
    version: u32,
    min_reader: u32,
    destructive: bool,
    /// Whether this database holds data the destructive step would remove and
    /// nothing could rebuild. A large database is backed up only when it does.
    needs_backup: fn(&Connection) -> Result<bool>,
    apply: fn(&Transaction<'_>) -> Result<()>,
}

const MAIN_MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    min_reader: 1,
    destructive: true,
    // UA1's main-database usage tables are rebuilt from native history and the
    // live-event log; only saved presets are user data without another copy.
    needs_backup: |conn| {
        let presets = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='presets'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        Ok(presets && conn.query_row("SELECT EXISTS(SELECT 1 FROM presets)", [], |row| row.get::<_, bool>(0))?)
    },
    apply: |tx| {
        tx.execute_batch("DROP TABLE IF EXISTS presets;")?;
        crate::usage_ledger::ledger_db::migrate_legacy_main_tables(tx)?;
        Ok(())
    },
}, Migration {
    version: 2,
    min_reader: 2,
    destructive: false,
    needs_backup: |_| Ok(false),
    apply: |tx| {
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS retention_event_state (
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                event TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
                PRIMARY KEY(session_id,event));
             CREATE INDEX IF NOT EXISTS retention_outbox_age ON outbox(created_at,seq);
             CREATE INDEX IF NOT EXISTS retention_operations_age ON operations(created_at,id);
             CREATE INDEX IF NOT EXISTS retention_ended_sessions ON sessions(status,updated_at,id);
             CREATE INDEX IF NOT EXISTS retention_delegations_state ON delegations(state,operation_id);
             CREATE TRIGGER IF NOT EXISTS sessions_delete_retention AFTER DELETE ON sessions BEGIN
                DELETE FROM metadata WHERE key IN ('terminal.outputEnd:'||OLD.id,'retention.userTitle:'||OLD.id,'retention.nativeHistory:'||OLD.id);
             END;"
        )?;
        Ok(())
    },
}, Migration {
    version: 3,
    min_reader: 3,
    destructive: false,
    needs_backup: |_| Ok(false),
    apply: |tx| {
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS review_drafts (
                draft_id TEXT PRIMARY KEY,
                scope_project_id TEXT,
                scope_root TEXT,
                content_json TEXT NOT NULL,
                revision INTEGER NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS review_draft_assets (
                draft_id TEXT NOT NULL REFERENCES review_drafts(draft_id) ON DELETE CASCADE,
                path TEXT NOT NULL,
                PRIMARY KEY(draft_id,path)
            );
            CREATE INDEX IF NOT EXISTS review_draft_assets_path ON review_draft_assets(path);
            CREATE TABLE IF NOT EXISTS review_draft_imports (
                marker TEXT PRIMARY KEY,
                imported_at TEXT NOT NULL
            );"
        )?;
        Ok(())
    },
}];

pub(crate) struct UpgradeBackup {
    path: Option<PathBuf>,
    data_version: i64,
}

pub(crate) fn prepare_main(conn: &Connection, path: &Path) -> Result<Option<UpgradeBackup>> {
    let from = check_reader(conn, MAIN_VERSION)?;
    let destructive: Vec<_> = MAIN_MIGRATIONS
        .iter()
        .filter(|m| m.version > from && m.destructive)
        .collect();
    if !destructive.is_empty() {
        let data_version = conn.pragma_query_value(None, "data_version", |row| row.get(0))?;
        let existing = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%')", [], |row| row.get::<_, bool>(0))?;
        let mut needs_backup = false;
        if existing {
            for migration in &destructive {
                needs_backup |= (migration.needs_backup)(conn)?;
            }
        }
        if !needs_backup {
            // Initial schema creation, or nothing unrecoverable to retire. The
            // data_version guard still stops the migration if another writer
            // commits before it runs.
            return Ok(Some(UpgradeBackup {
                path: None,
                data_version,
            }));
        }
        return pre_upgrade_backup(conn, path, from, MAIN_VERSION).map(|path| Some(UpgradeBackup { path: Some(path), data_version })).map_err(|error| anyhow!("schema_backup_failed: Could not create and verify a database backup. Free disk space or allow access to the backups folder, then restart ThreadTerm. {error:#}"));
    }
    Ok(None)
}

pub(crate) fn migrate_main(conn: &mut Connection, backup: Option<UpgradeBackup>) -> Result<()> {
    let from = check_reader(conn, MAIN_VERSION)?;
    let pending: Vec<_> = MAIN_MIGRATIONS
        .iter()
        .filter(|m| m.version > from)
        .collect();
    if pending.is_empty() {
        crate::usage_ledger::ledger_db::finish_legacy_main_migration(conn)?;
        return Ok(());
    }
    if pending.iter().any(|m| m.destructive) && backup.is_none() {
        return Err(anyhow!(
            "schema_backup_failed: A verified backup is required before upgrading this database."
        ));
    }
    for migration in pending {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if check_reader(&tx, MAIN_VERSION)? < migration.version {
            // Another connection cannot commit between this check and the drop.
            // Our own additive DDL does not change PRAGMA data_version.
            if migration.destructive
                && backup.as_ref().is_some_and(|backup| {
                    tx.pragma_query_value(None, "data_version", |row| row.get::<_, i64>(0))
                        .ok()
                        != Some(backup.data_version)
                })
            {
                return Err(anyhow!("schema_backup_failed: The database changed after its upgrade backup. Close other ThreadTerm instances and try again."));
            }
            (migration.apply)(&tx)?;
            record(
                &tx,
                migration.version,
                migration.min_reader,
                backup.as_ref().and_then(|backup| backup.path.as_deref()),
            )?;
        }
        tx.commit()?;
    }
    // The durable main marker is committed first; a crash here retries this
    // cross-file handoff on the next open without rerunning destructive DDL.
    crate::usage_ledger::ledger_db::finish_legacy_main_migration(conn)?;
    if let Some(backup) = backup.and_then(|backup| backup.path) {
        // A retention failure must not turn a committed upgrade into a failed startup.
        if let Err(error) = retain_backups(&backup) {
            eprintln!("pre-upgrade backup retention: {error:#}");
        }
    }
    Ok(())
}

pub(crate) fn stamp_ledger(conn: &Connection) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    if check_reader(&tx, LEDGER_VERSION)? == 0 {
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;
        // No destructive ledger schema upgrade exists yet. Future destructive
        // versions must rebuild from native history plus the main live-event log.
        record(&tx, LEDGER_VERSION, LEDGER_VERSION, None)?;
    }
    tx.commit()?;
    Ok(())
}

fn pre_upgrade_backup(conn: &Connection, path: &Path, from: u32, to: u32) -> Result<PathBuf> {
    let root = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let dir = root.join("backups");
    fs::create_dir_all(&dir)?;
    let target = dir.join(format!(
        "pre-upgrade-v{from}-to-v{to}-{}.sqlite",
        Utc::now().format("%Y%m%dT%H%M%S%9fZ")
    ));
    let partial = target.with_extension("sqlite.partial");
    let mut reserved = false;
    let result = (|| {
        // Only a verified, closed SQLite file receives the retained backup name.
        drop(
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&partial)?,
        );
        reserved = true;
        if target.try_exists()? {
            return Err(anyhow!("backup name already exists"));
        }
        {
            let mut destination = Connection::open(&partial)?;
            let backup = rusqlite::backup::Backup::new(conn, &mut destination)?;
            // Startup waits for this copy: large steps, no pauses.
            backup.run_to_completion(65_536, std::time::Duration::ZERO, None)?;
        }
        let verified = Connection::open_with_flags(&partial, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let results = verified
            .prepare("PRAGMA integrity_check")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if results != ["ok"] {
            return Err(anyhow!(
                "backup integrity check failed: {}",
                results.join("; ")
            ));
        }
        drop(verified);
        fs::rename(&partial, &target)?;
        Ok(target)
    })();
    if result.is_err() && reserved {
        let _ = fs::remove_file(&partial);
    }
    result
}

fn retain_backups(newest: &Path) -> Result<()> {
    let dir = newest.parent().context("backup parent")?;
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(stem) = name
            .strip_prefix("pre-upgrade-v")
            .and_then(|name| name.strip_suffix(".sqlite"))
        else {
            continue;
        };
        let Some((from, rest)) = stem.split_once("-to-v") else {
            continue;
        };
        let Some((to, timestamp)) = rest.split_once('-') else {
            continue;
        };
        if from.parse::<u32>().is_err()
            || to.parse::<u32>().is_err()
            || chrono::NaiveDateTime::parse_from_str(timestamp, "%Y%m%dT%H%M%S%9fZ").is_err()
            || !entry.file_type()?.is_file()
        {
            continue;
        }
        files.push((timestamp.to_owned(), entry.path()));
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let mut kept = 1;
    for (_, path) in files {
        if path == newest {
            continue;
        }
        if kept < 3 {
            kept += 1;
        } else {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}
