use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::path::PathBuf;

static DB_POOL: Lazy<Pool<SqliteConnectionManager>> = Lazy::new(|| {
    let dir = db_dir();
    std::fs::create_dir_all(&dir).expect("Failed to create db dir");

    {
        let conn = rusqlite::Connection::open(db_path()).expect("Failed to open DB for WAL init");
        conn.execute_batch("PRAGMA journal_mode=WAL;")
            .expect("Failed to enable WAL mode");
    }

    let manager = SqliteConnectionManager::file(db_path()).with_init(|conn| {
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")?;
        Ok(())
    });
    Pool::builder()
        .max_size(4)
        .build(manager)
        .expect("Failed to build DB pool")
});

fn db_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".threadterm")
}

fn db_path() -> PathBuf {
    db_dir().join("threadterm.db")
}

pub fn get_db() -> Result<r2d2::PooledConnection<SqliteConnectionManager>, String> {
    DB_POOL
        .get()
        .map_err(|e| format!("DB connection unavailable: {e}"))
}

pub fn init_database() -> Result<()> {
    let conn = get_db().map_err(|e| anyhow::anyhow!("{e}"))?;

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
        ",
    )
    .context("Failed to create database tables")?;

    tracing::info!(path = %db_path().display(), "Database initialized");
    Ok(())
}

pub fn insert_audit_log(
    device_id: &str,
    action: &str,
    card_id: Option<&str>,
    summary: &str,
) -> Result<()> {
    let conn = get_db().map_err(|e| anyhow::anyhow!("{e}"))?;
    conn.execute(
        "INSERT INTO audit_log (device_id, action, card_id, summary, created_at)
         VALUES (?1, ?2, ?3, ?4, strftime('%s', 'now'))",
        rusqlite::params![device_id, action, card_id, summary],
    )?;
    Ok(())
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
