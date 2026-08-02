//! Additive SQLite schema for workspace authority.

use rusqlite::Connection;

pub const WORKSPACE_SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS workspaces (
    id              TEXT PRIMARY KEY,
    canonical_root  TEXT NOT NULL,
    comparison_key  TEXT NOT NULL UNIQUE,
    display_path    TEXT NOT NULL,
    availability    TEXT NOT NULL DEFAULT 'available',
    created_at_ms   INTEGER NOT NULL,
    updated_at_ms   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_tabs (
    workspace_id    TEXT NOT NULL,
    tab_id          TEXT NOT NULL,
    kind            TEXT NOT NULL,
    title           TEXT NOT NULL,
    card_id         TEXT,
    relative_path   TEXT,
    shared_order    INTEGER NOT NULL,
    created_at_ms   INTEGER NOT NULL,
    updated_at_ms   INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, tab_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_tabs_order
    ON workspace_tabs(workspace_id, shared_order);

CREATE TABLE IF NOT EXISTS workspace_drafts (
    workspace_id            TEXT NOT NULL,
    tab_id                  TEXT NOT NULL,
    contents                TEXT NOT NULL,
    base_modified_unix_ms   INTEGER,
    base_hash               TEXT,
    revision                INTEGER NOT NULL DEFAULT 1,
    dirty                   INTEGER NOT NULL DEFAULT 0,
    conflict                TEXT NOT NULL DEFAULT 'none',
    updated_at_ms           INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, tab_id),
    FOREIGN KEY (workspace_id, tab_id)
        REFERENCES workspace_tabs(workspace_id, tab_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_view_state (
    workspace_id        TEXT NOT NULL,
    surface_id          TEXT NOT NULL,
    active_tab_id       TEXT NOT NULL,
    last_seen_at_ms     INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, surface_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
";

pub fn ensure_workspace_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(WORKSPACE_SCHEMA_SQL)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn creates_additive_tables_idempotently() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_workspace_schema(&conn).unwrap();
        ensure_workspace_schema(&conn).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN (
                    'workspaces','workspace_tabs','workspace_drafts','workspace_view_state'
                )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 4);

        conn.execute(
            "INSERT INTO workspaces (id, canonical_root, comparison_key, display_path, availability, created_at_ms, updated_at_ms)
             VALUES ('ws1', '/tmp/a', 'key-a', '/tmp/a', 'available', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspace_tabs (workspace_id, tab_id, kind, title, card_id, relative_path, shared_order, created_at_ms, updated_at_ms)
             VALUES ('ws1', 'file:src/a.ts', 'file', 'a.ts', NULL, 'src/a.ts', 1, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspace_drafts (workspace_id, tab_id, contents, base_modified_unix_ms, base_hash, revision, dirty, conflict, updated_at_ms)
             VALUES ('ws1', 'file:src/a.ts', 'hello', 10, 'h', 1, 1, 'none', 2)",
            [],
        )
        .unwrap();
        let contents: String = conn
            .query_row(
                "SELECT contents FROM workspace_drafts WHERE workspace_id='ws1' AND tab_id='file:src/a.ts'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(contents, "hello");
    }
}
