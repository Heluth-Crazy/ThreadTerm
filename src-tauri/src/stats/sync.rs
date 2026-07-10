//! Incremental sync of Claude/Codex session logs into the `usage_records` table.
//!
//! ## Data flow
//! ```text
//! jsonl_files_recent_first → per-file mtime check → parse → INSERT OR IGNORE → usage_records
//!                                            ↓
//!                                     session_log_sync (mtime + line offset)
//! ```
//!
//! ## Incremental strategy
//! - **mtime gate**: a file whose mtime hasn't bumped since the last sync is
//!   skipped whole (no read, no parse).
//! - **INSERT OR IGNORE**: for files that did change, we re-parse the whole
//!   file (Claude/Codex dedup is already handled inside the parser) and rely on
//!   the `request_id` primary key to skip rows already imported. Codex deltas
//!   depend on cumulative state that can't be cheaply resumed mid-file, so
//!   whole-file reparse is the correct-if-less-incremental choice; the mtime
//!   gate ensures only actively-appended files pay this cost.
//! - **DedupKey cross-check**: a second guard that catches the same billable
//!   event recorded with different request_ids (e.g. proxy + session log).

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OpenFlags};

use crate::db::get_db;
use crate::provider_sessions::jsonl_files_recent_first;
use crate::stats::opencode::{self, OpenCodeUsage};
use crate::stats::parse;
use crate::stats::pricing;
use crate::stats::types::CallRecord;

/// Aggregate result of one sync pass.
#[derive(Debug, Clone, Default)]
pub struct SyncResult {
    pub imported: u32,
    pub skipped: u32,
    pub files_scanned: u32,
    pub errors: Vec<String>,
}

impl SyncResult {
    fn merge(&mut self, other: &SyncResult) {
        self.imported += other.imported;
        self.skipped += other.skipped;
        self.files_scanned += other.files_scanned;
        self.errors.extend(other.errors.iter().cloned());
    }
}

const PROGRESS_EVERY: usize = 16;

/// Bump when parser logic changes in a way that alters stored token/cost
/// numbers. On the next sync a DB whose recorded version differs is wiped and
/// fully re-ingested — `INSERT OR IGNORE` + the mtime gate otherwise freeze old
/// rows forever, so this is the only way an accuracy fix reaches data that an
/// earlier parser already ingested.
///
/// History: 1 = original parser; 2 = Claude snapshot-dedup + Codex per-call
/// delta fixes (the "对齐 cc-switch" rework); 3 = dropped the shape+timestamp
/// dedup that was under-counting Codex (no proxy → request_id dedup suffices);
/// 4 = added opencode.db ingestion; 5 = refresh Codex rows after token-shape
/// fields and legacy session parsing fixes; 6 = parser rebuild scans all source
/// logs instead of inheriting the caller's time window; 7 = refresh stored costs
/// after adding Claude Fable/Mythos 5 pricing.
const STATS_PARSER_VERSION: i64 = 7;

/// Wipe `usage_records` + `session_log_sync` when the stored parser version
/// doesn't match the current one, then stamp the new version. Returns true when
/// a rebuild happened. Best-effort; schema is guaranteed by `db::init_database`.
fn rebuild_if_parser_changed(conn: &rusqlite::Connection) -> bool {
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS stats_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );
    let stored: i64 = conn
        .query_row(
            "SELECT value FROM stats_meta WHERE key = 'parser_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if stored == STATS_PARSER_VERSION {
        return false;
    }
    let _ = conn.execute_batch("DELETE FROM usage_records; DELETE FROM session_log_sync;");
    let _ = conn.execute(
        "INSERT OR REPLACE INTO stats_meta (key, value) VALUES ('parser_version', ?1)",
        params![STATS_PARSER_VERSION.to_string()],
    );
    tracing::info!(
        "[STATS-SYNC] parser version {stored} -> {STATS_PARSER_VERSION}: rebuilt usage_records"
    );
    true
}

fn scan_lower_bound_after_rebuild(rebuilt: bool, lo_ms: Option<u64>) -> Option<u64> {
    if rebuilt {
        None
    } else {
        lo_ms
    }
}

/// Force a full rebuild: drop ingested rows + sync cursors so the next
/// `stats_compute` re-ingests every file from scratch with the current parser.
pub fn rebuild_now() -> Result<(), String> {
    let conn = get_db()?;
    conn.execute_batch(
        "DELETE FROM usage_records;
         DELETE FROM session_log_sync;
         DELETE FROM stats_meta WHERE key = 'parser_version';",
    )
    .map_err(|e| e.to_string())
}

/// Sync all providers' session logs into `usage_records`. Scans only files
/// newer than `lo_ms` (coarse mtime pre-filter); the mtime gate then skips
/// unchanged files entirely. `on_progress(scanned, total)` is called
/// periodically so the caller can stream progress to the UI.
pub fn sync_all<F: FnMut(usize, usize)>(lo_ms: Option<u64>, mut on_progress: F) -> SyncResult {
    // One-time rebuild if the parser version changed since rows were ingested.
    let rebuilt = get_db()
        .map(|conn| rebuild_if_parser_changed(&conn))
        .unwrap_or(false);
    let scan_lo_ms = scan_lower_bound_after_rebuild(rebuilt, lo_ms);

    // Collect candidates from both providers up front so `total` is known
    // before the scan loop starts — the UI progress bar needs a denominator.
    let mut files: Vec<(PathBuf, &'static str)> = Vec::new();
    if let Some(root) = super::claude_root() {
        for f in jsonl_files_recent_first(&root, scan_lo_ms) {
            files.push((f.path, "claude"));
        }
    }
    if let Some(root) = super::codex_root() {
        for f in jsonl_files_recent_first(&root, scan_lo_ms) {
            files.push((f.path, "codex"));
        }
    }
    let total = files.len();
    let mut result = SyncResult::default();

    for (i, (path, provider)) in files.iter().enumerate() {
        if i % PROGRESS_EVERY == 0 {
            on_progress(i + 1, total);
        }
        let r = match *provider {
            "claude" => sync_claude_file(path),
            "codex" => sync_codex_file(path),
            _ => continue,
        };
        result.merge(&r);
    }
    on_progress(total, total);

    result.merge(&sync_opencode());

    if result.imported > 0 {
        tracing::info!(
            "[STATS-SYNC] imported {} skipped {} files {} errors {}",
            result.imported,
            result.skipped,
            result.files_scanned,
            result.errors.len()
        );
    }

    result
}

/// File mtime as nanoseconds since epoch. Stored in `session_log_sync` so a
/// nanosecond-precision change is detected even on filesystems with sub-second
/// mtime resolution.
fn mtime_nanos(path: &Path) -> i64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// Read (last_modified, last_line_offset) for a file; (0, 0) when unseen.
fn get_sync_state(conn: &rusqlite::Connection, file_path: &str) -> (i64, i64) {
    conn.query_row(
        "SELECT last_modified, last_line_offset FROM session_log_sync WHERE file_path = ?1",
        params![file_path],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )
    .unwrap_or((0, 0))
}

/// Persist sync progress for a file.
fn update_sync_state(
    conn: &rusqlite::Connection,
    file_path: &str,
    last_modified: i64,
    last_offset: i64,
) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let _ = conn.execute(
        "INSERT OR REPLACE INTO session_log_sync
            (file_path, last_modified, last_line_offset, last_synced_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![file_path, last_modified, last_offset, now],
    );
}

/// Count lines in a file (for the line-offset cursor). Best-effort: on read
/// error falls back to 0, which just means the next sync re-evaluates the file.
fn line_count(path: &Path) -> i64 {
    fs::File::open(path)
        .ok()
        .map(|f| BufReader::new(f).lines().count() as i64)
        .unwrap_or(0)
}

/// Insert one call into `usage_records`. Returns true if a new row was written.
///
/// Dedup is by the `request_id` primary key alone (`session:{msg_id}` for
/// Claude, `codex_session:{sid}:{idx}` for Codex) — both are stable across
/// re-syncs, so `INSERT OR IGNORE` is exact. We deliberately do NOT also dedup
/// by token shape + timestamp: ThreadTerm has no proxy writing `usage_records`
/// (the only writer is this module), so there is no cross-source duplicate to
/// catch — a shape match only ever means two *distinct* API calls that happen
/// to look alike, and dropping the second under-counts usage (Codex deltas are
/// small, uniform integers at second resolution, so they collide easily).
fn insert_record(
    conn: &rusqlite::Connection,
    request_id: &str,
    provider: &str,
    record: &CallRecord,
    project_path: &str,
    created_at: i64,
) -> bool {
    let cb = pricing::cost_breakdown(&record.model, &record.usage);
    conn.execute(
        "INSERT OR IGNORE INTO usage_records
            (request_id, provider, model,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
             input_cost_usd, output_cost_usd, cache_read_cost_usd, cache_creation_cost_usd,
             total_cost_usd, session_id, project_path, created_at, data_source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            request_id,
            provider,
            record.model,
            record.usage.input,
            record.usage.output,
            record.usage.cache_read,
            record.usage.cache_creation,
            cb.input,
            cb.output,
            cb.cache_read,
            cb.cache_write,
            cb.total,
            record.session_id,
            project_path,
            created_at,
            "session_log",
        ],
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

fn insert_opencode_record(
    conn: &rusqlite::Connection,
    request_id: &str,
    usage: &OpenCodeUsage,
    session_id: &str,
    created_at: i64,
) -> bool {
    let output_with_reasoning = usage.output.saturating_add(usage.reasoning);
    let summary = crate::stats::types::UsageSummary {
        input: usage.input,
        output: output_with_reasoning,
        cache_read: usage.cache_read,
        cache_creation: usage.cache_write,
    };
    let cost = if usage.cost > 0.0 {
        pricing::CostBreakdown {
            total: usage.cost,
            ..Default::default()
        }
    } else {
        pricing::cost_breakdown(&usage.model_id, &summary)
    };

    conn.execute(
        "INSERT OR IGNORE INTO usage_records
            (request_id, provider, model,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
             input_cost_usd, output_cost_usd, cache_read_cost_usd, cache_creation_cost_usd,
             total_cost_usd, session_id, project_path, created_at, data_source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            request_id,
            "opencode",
            usage.model_id,
            summary.input,
            summary.output,
            summary.cache_read,
            summary.cache_creation,
            cost.input,
            cost.output,
            cost.cache_read,
            cost.cache_write,
            cost.total,
            session_id,
            "",
            created_at,
            "opencode_session",
        ],
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

fn opencode_modified(path: &Path) -> i64 {
    let wal_path = path.with_extension("db-wal");
    mtime_nanos(path).max(mtime_nanos(&wal_path))
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn sync_opencode() -> SyncResult {
    let mut result = SyncResult::default();
    let path = opencode::opencode_db_path();
    if !path.exists() {
        return result;
    }
    result.files_scanned = 1;

    let Ok(conn) = get_db() else {
        result.errors.push("DB unavailable".into());
        return result;
    };

    let file_path = path.to_string_lossy().to_string();
    let modified = opencode_modified(&path);
    let (last_modified, _last_offset) = get_sync_state(&conn, &file_path);
    if modified <= last_modified {
        return result;
    }

    let file_mtime_secs = (modified / 1_000_000_000).max(0);
    let fallback_created_at = if file_mtime_secs > 0 {
        file_mtime_secs
    } else {
        now_secs()
    };

    let opencode_conn = match rusqlite::Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(conn) => conn,
        Err(err) => {
            result
                .errors
                .push(format!("OpenCode DB unavailable: {err}"));
            return result;
        }
    };

    let sessions = match opencode::query_sessions(&opencode_conn) {
        Ok(sessions) => sessions,
        Err(err) => {
            result
                .errors
                .push(format!("OpenCode session query failed: {err}"));
            return result;
        }
    };

    for (session_id, watermark) in sessions {
        let session_key = format!("{file_path}:{session_id}");
        let (last_session_modified, _last_offset) = get_sync_state(&conn, &session_key);
        if watermark <= last_session_modified {
            continue;
        }

        let (messages, has_incomplete_usage) =
            match opencode::query_assistant_messages(&opencode_conn, &session_id) {
                Ok(messages) => messages,
                Err(err) => {
                    result.errors.push(format!(
                        "OpenCode message query failed for session {session_id}: {err}"
                    ));
                    continue;
                }
            };

        for (message_id, usage) in messages {
            let request_id = format!("opencode_session:{session_id}:{message_id}");
            let created_at = if usage.timestamp_ms > 0 {
                usage.timestamp_ms / 1000
            } else {
                fallback_created_at
            };
            if insert_opencode_record(&conn, &request_id, &usage, &session_id, created_at) {
                result.imported += 1;
            } else {
                result.skipped += 1;
            }
        }

        if !has_incomplete_usage {
            update_sync_state(&conn, &session_key, watermark, 0);
        }
    }

    if result.errors.is_empty() {
        update_sync_state(&conn, &file_path, modified, 0);
    }

    result
}

/// Sync one Claude session jsonl.
fn sync_claude_file(path: &Path) -> SyncResult {
    let mut result = SyncResult {
        files_scanned: 1,
        ..SyncResult::default()
    };

    let Ok(conn) = get_db() else {
        result.errors.push("DB unavailable".into());
        return result;
    };
    let file_path = path.to_string_lossy().to_string();
    let modified = mtime_nanos(path);

    let (last_modified, _last_offset) = get_sync_state(&conn, &file_path);
    if modified <= last_modified {
        return result; // unchanged
    }

    let (cwd, calls) = parse::parse_claude_file(path);
    let file_mtime_secs = (modified / 1_000_000_000).max(0);

    for call in &calls {
        // Claude dedup key: the Anthropic message id is globally unique.
        let Some(msg_id) = call.message_id.as_deref() else {
            result.skipped += 1;
            continue;
        };
        let request_id = format!("session:{msg_id}");
        let created_at = call
            .timestamp_ms
            .map(|ms| (ms / 1000) as i64)
            .unwrap_or(file_mtime_secs);

        if insert_record(&conn, &request_id, "claude", call, &cwd, created_at) {
            result.imported += 1;
        } else {
            result.skipped += 1;
        }
    }

    update_sync_state(&conn, &file_path, modified, line_count(path));
    result
}

/// Sync one Codex session jsonl.
fn sync_codex_file(path: &Path) -> SyncResult {
    let mut result = SyncResult {
        files_scanned: 1,
        ..SyncResult::default()
    };

    let Ok(conn) = get_db() else {
        result.errors.push("DB unavailable".into());
        return result;
    };
    let file_path = path.to_string_lossy().to_string();
    let modified = mtime_nanos(path);

    let (last_modified, _last_offset) = get_sync_state(&conn, &file_path);
    if modified <= last_modified {
        return result;
    }

    let Some((sid, cwd, calls)) = parse::parse_codex_file(path) else {
        // No billable events; still record sync state so we don't re-read it.
        update_sync_state(&conn, &file_path, modified, line_count(path));
        return result;
    };
    let file_mtime_secs = (modified / 1_000_000_000).max(0);

    // Codex calls are indexed by their non-zero-delta order; the parser
    // produces a stable sequence so `i+1` is a stable event id across syncs.
    for (i, call) in calls.iter().enumerate() {
        let request_id = format!("codex_session:{sid}:{}", i + 1);
        let created_at = call
            .timestamp_ms
            .map(|ms| (ms / 1000) as i64)
            .unwrap_or(file_mtime_secs);

        if insert_record(&conn, &request_id, "codex", call, &cwd, created_at) {
            result.imported += 1;
        } else {
            result.skipped += 1;
        }
    }

    update_sync_state(&conn, &file_path, modified, line_count(path));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats::types::UsageSummary;

    fn mem_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_records (
                request_id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                input_cost_usd REAL NOT NULL DEFAULT 0,
                output_cost_usd REAL NOT NULL DEFAULT 0,
                cache_read_cost_usd REAL NOT NULL DEFAULT 0,
                cache_creation_cost_usd REAL NOT NULL DEFAULT 0,
                total_cost_usd REAL NOT NULL DEFAULT 0,
                session_id TEXT, project_path TEXT,
                created_at INTEGER NOT NULL, data_source TEXT NOT NULL DEFAULT 'session_log');
             CREATE TABLE session_log_sync (
                file_path TEXT PRIMARY KEY, last_modified INTEGER NOT NULL,
                last_line_offset INTEGER NOT NULL, last_synced_at INTEGER NOT NULL);
             CREATE TABLE stats_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    fn record(model: &str, input: u64, output: u64, ts_ms: Option<u64>) -> CallRecord {
        CallRecord {
            model: model.to_string(),
            message_id: Some("msg_1".to_string()),
            usage: UsageSummary {
                input,
                output,
                cache_creation: 0,
                cache_read: 0,
            },
            timestamp_ms: ts_ms,
            stop_reason: None,
            session_id: Some("s1".to_string()),
        }
    }

    #[test]
    fn insert_record_writes_row_and_costs() {
        let conn = mem_conn();
        let r = record("claude-opus-4-8", 1_000_000, 0, Some(1_609_459_200_000));
        assert!(insert_record(
            &conn,
            "session:msg_1",
            "claude",
            &r,
            "/p",
            1_609_459_200
        ));
        let (cost, input): (f64, i64) = conn
            .query_row(
                "SELECT total_cost_usd, input_tokens FROM usage_records WHERE request_id='session:msg_1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(input, 1_000_000);
        assert!(
            (cost - 15.0).abs() < 1e-6,
            "1M input opus = $15, got {cost}"
        );
    }

    #[test]
    fn insert_record_skips_duplicate_request_id() {
        let conn = mem_conn();
        let r = record("claude-opus-4-8", 100, 10, Some(1_609_459_200_000));
        assert!(insert_record(
            &conn,
            "session:msg_1",
            "claude",
            &r,
            "/p",
            1_609_459_200
        ));
        // Same request_id → INSERT OR IGNORE skips.
        assert!(!insert_record(
            &conn,
            "session:msg_1",
            "claude",
            &r,
            "/p",
            1_609_459_200
        ));
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM usage_records", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn insert_opencode_record_uses_reported_cost_when_present() {
        let conn = mem_conn();
        let usage = OpenCodeUsage {
            input: 100,
            output: 20,
            reasoning: 5,
            cache_read: 30,
            cache_write: 40,
            cost: 0.123,
            model_id: "deepseek-v4-pro".to_string(),
            timestamp_ms: 1_609_459_200_000,
        };

        assert!(insert_opencode_record(
            &conn,
            "opencode_session:s1:m1",
            &usage,
            "s1",
            1_609_459_200,
        ));
        let row: (String, i64, i64, f64, f64, String) = conn
            .query_row(
                "SELECT provider, output_tokens, cache_creation_tokens,
                        total_cost_usd, input_cost_usd, data_source
                 FROM usage_records
                 WHERE request_id='opencode_session:s1:m1'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row.0, "opencode");
        assert_eq!(row.1, 25, "reasoning tokens are counted as output");
        assert_eq!(row.2, 40);
        assert!((row.3 - 0.123).abs() < f64::EPSILON);
        assert_eq!(row.4, 0.0, "reported aggregate cost cannot be split");
        assert_eq!(row.5, "opencode_session");
    }

    #[test]
    fn insert_opencode_record_falls_back_to_pricing_when_cost_is_zero() {
        let conn = mem_conn();
        let usage = OpenCodeUsage {
            input: 1_000_000,
            output: 0,
            reasoning: 0,
            cache_read: 0,
            cache_write: 0,
            cost: 0.0,
            model_id: "claude-opus-4-8".to_string(),
            timestamp_ms: 1_609_459_200_000,
        };

        assert!(insert_opencode_record(
            &conn,
            "opencode_session:s1:m2",
            &usage,
            "s1",
            1_609_459_200,
        ));
        let (total_cost, input_cost): (f64, f64) = conn
            .query_row(
                "SELECT total_cost_usd, input_cost_usd
                 FROM usage_records
                 WHERE request_id='opencode_session:s1:m2'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!((total_cost - 15.0).abs() < 1e-6);
        assert!((input_cost - 15.0).abs() < 1e-6);
    }

    #[test]
    fn distinct_request_ids_with_same_shape_both_count() {
        // Two distinct calls that happen to share model + token shape + second
        // must BOTH be recorded — they are different API calls. Only a repeated
        // request_id is a true duplicate (covered above). This is the Codex
        // under-count fix: small uniform deltas at second resolution collide on
        // shape, and the old shape-dedup wrongly dropped the second one.
        let conn = mem_conn();
        let r = record("claude-opus-4-8", 100, 10, Some(1_609_459_200_000));
        assert!(insert_record(
            &conn,
            "session:msg_1",
            "claude",
            &r,
            "/p",
            1_609_459_200
        ));
        assert!(insert_record(
            &conn,
            "session:msg_other",
            "claude",
            &r,
            "/p",
            1_609_459_200
        ));
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM usage_records", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2, "distinct request_ids are distinct calls");
    }

    #[test]
    fn sync_state_round_trips() {
        let conn = mem_conn();
        assert_eq!(get_sync_state(&conn, "/x.jsonl"), (0, 0));
        update_sync_state(&conn, "/x.jsonl", 1_700_000_000_000, 42);
        assert_eq!(get_sync_state(&conn, "/x.jsonl"), (1_700_000_000_000, 42));
    }

    #[test]
    fn rebuild_wipes_rows_when_version_missing_then_is_idempotent() {
        let conn = mem_conn();
        // Simulate stale rows ingested by an older parser (no version stamped).
        let r = record("claude-opus-4-8", 100, 10, Some(1_609_459_200_000));
        assert!(insert_record(
            &conn,
            "session:msg_1",
            "claude",
            &r,
            "/p",
            1_609_459_200
        ));
        update_sync_state(&conn, "/old.jsonl", 1_700_000_000_000, 5);

        // First sync after the version bump: rows + cursors wiped, version stamped.
        assert!(rebuild_if_parser_changed(&conn), "stale DB must rebuild");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM usage_records", [], |row| row.get(0))
            .unwrap();
        let cursors: i64 = conn
            .query_row("SELECT COUNT(*) FROM session_log_sync", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rows, 0, "stale usage rows cleared");
        assert_eq!(cursors, 0, "sync cursors cleared so files re-parse");

        // Second call: version now matches → no-op (no needless wipe each sync).
        assert!(
            !rebuild_if_parser_changed(&conn),
            "matching version must not rebuild"
        );
    }

    #[test]
    fn rebuild_scan_ignores_caller_time_window() {
        assert_eq!(scan_lower_bound_after_rebuild(true, Some(123)), None);
        assert_eq!(scan_lower_bound_after_rebuild(false, Some(123)), Some(123));
        assert_eq!(scan_lower_bound_after_rebuild(false, None), None);
    }
}
