use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::path::PathBuf;

/// Connection pool (r2d2 + rusqlite).
static DB_POOL: Lazy<Pool<SqliteConnectionManager>> = Lazy::new(|| {
    let dir = db_dir();
    std::fs::create_dir_all(&dir).expect("Failed to create db dir");

    // WAL mode must be set once on a dedicated connection BEFORE the pool
    // opens multiple connections simultaneously — otherwise they race and lock.
    // WAL mode is persistent (stored in the DB file) so this is a one-time op.
    {
        let conn = rusqlite::Connection::open(db_path())
            .expect("Failed to open DB for WAL init");
        conn.execute_batch("PRAGMA journal_mode=WAL;")
            .expect("Failed to enable WAL mode");
    }

    let manager = SqliteConnectionManager::file(db_path()).with_init(|conn| {
        // WAL already set; only configure per-connection settings here.
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")?;
        Ok(())
    });
    Pool::builder()
        .max_size(4) // desktop app: 4 is plenty, reduces startup contention
        .build(manager)
        .expect("Failed to build DB pool")
});

/// Returns the database directory: `~/.openwork/`
fn db_dir() -> PathBuf {
    dirs::home_dir()
        .expect("Could not determine home directory")
        .join(".openwork")
}

/// Returns the database file path: `~/.openwork/openwork.db`
fn db_path() -> PathBuf {
    db_dir().join("openwork.db")
}

/// Acquire a pooled database connection.
pub fn get_db() -> r2d2::PooledConnection<SqliteConnectionManager> {
    DB_POOL.get().expect("Failed to get DB connection from pool")
}

/// Initialize the database schema. Call once at startup.
pub fn init_database() -> Result<()> {
    let conn = get_db();

    conn.execute_batch(
        "
        -- Users table (single-user system, matches existing Node schema)
        CREATE TABLE IF NOT EXISTS users (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login    DATETIME,
            is_active     BOOLEAN DEFAULT 1,
            git_name      TEXT,
            git_email     TEXT,
            has_completed_onboarding BOOLEAN DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_users_active   ON users(is_active);

        -- User credentials (GitHub tokens, GitLab tokens, etc.)
        CREATE TABLE IF NOT EXISTS user_credentials (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id          INTEGER NOT NULL,
            credential_name  TEXT NOT NULL,
            credential_type  TEXT NOT NULL,
            credential_value TEXT NOT NULL,
            description      TEXT,
            created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_active        BOOLEAN DEFAULT 1,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_credentials_type    ON user_credentials(credential_type);
        CREATE INDEX IF NOT EXISTS idx_user_credentials_active  ON user_credentials(is_active);

        -- App-wide key/value settings
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        );

        -- Server-side session tracking for logout / expiry
        CREATE TABLE IF NOT EXISTS sessions (
            token      TEXT PRIMARY KEY,
            user_id    INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME NOT NULL
        );
        ",
    )
    .context("Failed to create database tables")?;

    run_migrations(&conn)?;

    tracing::info!(path = %db_path().display(), "Database initialized");
    Ok(())
}

/// Run forward-only migrations (add columns that may be missing in older DBs).
fn run_migrations(conn: &rusqlite::Connection) -> Result<()> {
    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(users)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();

    if !columns.contains(&"git_name".to_string()) {
        conn.execute_batch("ALTER TABLE users ADD COLUMN git_name TEXT")?;
        tracing::info!("Migration: added git_name column");
    }
    if !columns.contains(&"git_email".to_string()) {
        conn.execute_batch("ALTER TABLE users ADD COLUMN git_email TEXT")?;
        tracing::info!("Migration: added git_email column");
    }
    if !columns.contains(&"has_completed_onboarding".to_string()) {
        conn.execute_batch("ALTER TABLE users ADD COLUMN has_completed_onboarding BOOLEAN DEFAULT 0")?;
        tracing::info!("Migration: added has_completed_onboarding column");
    }

    Ok(())
}

/// Retrieve a setting value by key.
pub fn get_setting(key: &str) -> Result<Option<String>> {
    let conn = get_db();
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let result = stmt
        .query_row([key], |row| row.get(0))
        .ok();
    Ok(result)
}

/// Insert or update a setting.
pub fn set_setting(key: &str, value: &str) -> Result<()> {
    let conn = get_db();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}
