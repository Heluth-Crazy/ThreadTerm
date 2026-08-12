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

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OpenFlags};

use crate::db::get_db;
use crate::provider_sessions::jsonl_files_recent_first;
use crate::stats::gemini;
use crate::stats::grok;
use crate::stats::opencode::{self, OpenCodeUsage};
use crate::stats::parse;
use crate::stats::parse::{CodexParentResolution, CodexTokenUsageSignature};
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

fn session_log_candidates(root: &Path) -> Vec<PathBuf> {
    jsonl_files_recent_first(root, None)
        .into_iter()
        .map(|candidate| candidate.path)
        .collect()
}

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
/// after adding Claude Fable/Mythos 5 pricing; 8 = attribute OpenCode usage to
/// the session project directory; 9 = strip replayed Codex parent history and
/// add Gemini/Grok Build session-log ingestion; 10 = prefer Codex exact
/// last-token usage and refresh cc-switch-aligned fallback pricing.
const STATS_PARSER_VERSION: i64 = 10;

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
    let _ = conn.execute_batch(
        "DELETE FROM usage_records;
         DELETE FROM usage_daily_rollups;
         DELETE FROM session_log_sync;",
    );
    let _ = conn.execute(
        "INSERT OR REPLACE INTO stats_meta (key, value) VALUES ('parser_version', ?1)",
        params![STATS_PARSER_VERSION.to_string()],
    );
    tracing::info!(
        "[STATS-SYNC] parser version {stored} -> {STATS_PARSER_VERSION}: rebuilt usage_records"
    );
    true
}

/// Force a full rebuild: drop ingested rows + sync cursors so the next
/// `stats_compute` re-ingests every file from scratch with the current parser.
pub fn rebuild_now() -> Result<(), String> {
    let conn = get_db()?;
    conn.execute_batch(
        "DELETE FROM usage_records;
         DELETE FROM usage_daily_rollups;
         DELETE FROM session_log_sync;
         DELETE FROM stats_meta WHERE key = 'parser_version';",
    )
    .map_err(|e| e.to_string())
}

/// Sync all providers' session logs into `usage_records`. Candidate discovery
/// is intentionally independent of the dashboard time range: a file's mtime
/// is not the timestamp of every usage record it contains. Per-file cursors
/// still skip unchanged contents after candidates are discovered.
pub fn sync_all<F: FnMut(usize, usize)>(mut on_progress: F) -> SyncResult {
    // One-time rebuild if the parser version changed since rows were ingested.
    let _ = get_db()
        .map(|conn| rebuild_if_parser_changed(&conn))
        .unwrap_or(false);

    // Collect candidates up front so `total` is known before the scan loop.
    // Codex always builds a complete rollout index: a recent child may fork
    // from an older parent, and filtering the parent by the selected UI range
    // would make replay stripping impossible. Per-file mtime gates still avoid
    // reparsing unchanged rollout contents.
    let mut claude_files = Vec::new();
    if let Some(root) = super::claude_root() {
        claude_files.extend(session_log_candidates(&root));
    }
    let mut codex_files = Vec::new();
    if let Some(root) = super::codex_root() {
        codex_files.extend(session_log_candidates(&root));
        if let Some(config_root) = root.parent() {
            let archived_root = config_root.join("archived_sessions");
            codex_files.extend(session_log_candidates(&archived_root));
        }
    }
    codex_files.sort();
    let total = claude_files.len().saturating_add(codex_files.len());
    let mut result = SyncResult::default();
    let mut scanned = 0usize;

    for path in &claude_files {
        scanned = scanned.saturating_add(1);
        if scanned == 1 || scanned % PROGRESS_EVERY == 0 {
            on_progress(scanned, total);
        }
        result.merge(&sync_claude_file(path));
    }

    let mut codex_replay = CodexReplayResolver::new(&codex_files);
    for path in &codex_files {
        scanned = scanned.saturating_add(1);
        if scanned == 1 || scanned % PROGRESS_EVERY == 0 {
            on_progress(scanned, total);
        }
        result.merge(&sync_codex_file(path, &mut codex_replay));
    }
    on_progress(total, total);

    result.merge(&sync_opencode());
    result.merge(&gemini::sync_gemini());
    result.merge(&grok::sync_grok());

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
pub(crate) fn mtime_nanos(path: &Path) -> i64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// Read (last_modified, last_line_offset) for a file; (0, 0) when unseen.
pub(crate) fn get_sync_state(conn: &rusqlite::Connection, file_path: &str) -> (i64, i64) {
    conn.query_row(
        "SELECT last_modified, last_line_offset FROM session_log_sync WHERE file_path = ?1",
        params![file_path],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )
    .unwrap_or((0, 0))
}

/// Persist sync progress for a file.
pub(crate) fn update_sync_state(
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

pub(crate) struct SessionUsageUpsert<'a> {
    pub request_id: &'a str,
    pub provider: &'a str,
    pub model: &'a str,
    pub usage: &'a crate::stats::types::UsageSummary,
    pub cost: pricing::CostBreakdown,
    pub session_id: &'a str,
    pub project_path: &'a str,
    pub created_at: i64,
    pub data_source: &'a str,
}

/// Upsert a provider session-log row whose token values may still change while
/// the native session is active (Gemini JSON and Grok updates are rewritten or
/// appended in place). The stable request id keeps rescans idempotent while the
/// `DO UPDATE` branch refreshes partial rows instead of freezing stale values.
pub(crate) fn upsert_session_record(
    conn: &rusqlite::Connection,
    row: SessionUsageUpsert<'_>,
) -> bool {
    conn.execute(
        "INSERT INTO usage_records
            (request_id, provider, model,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
             input_cost_usd, output_cost_usd, cache_read_cost_usd, cache_creation_cost_usd,
             total_cost_usd, session_id, project_path, created_at, data_source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(request_id) DO UPDATE SET
             provider = excluded.provider,
             model = excluded.model,
             input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens,
             cache_read_tokens = excluded.cache_read_tokens,
             cache_creation_tokens = excluded.cache_creation_tokens,
             input_cost_usd = excluded.input_cost_usd,
             output_cost_usd = excluded.output_cost_usd,
             cache_read_cost_usd = excluded.cache_read_cost_usd,
             cache_creation_cost_usd = excluded.cache_creation_cost_usd,
             total_cost_usd = excluded.total_cost_usd,
             session_id = excluded.session_id,
             project_path = excluded.project_path,
             created_at = excluded.created_at,
             data_source = excluded.data_source
         WHERE provider != excluded.provider
            OR model != excluded.model
            OR input_tokens != excluded.input_tokens
            OR output_tokens != excluded.output_tokens
            OR cache_read_tokens != excluded.cache_read_tokens
            OR cache_creation_tokens != excluded.cache_creation_tokens
            OR input_cost_usd != excluded.input_cost_usd
            OR output_cost_usd != excluded.output_cost_usd
            OR cache_read_cost_usd != excluded.cache_read_cost_usd
            OR cache_creation_cost_usd != excluded.cache_creation_cost_usd
            OR total_cost_usd != excluded.total_cost_usd
            OR COALESCE(session_id, '') != excluded.session_id
            OR COALESCE(project_path, '') != excluded.project_path
            OR created_at != excluded.created_at
            OR data_source != excluded.data_source",
        params![
            row.request_id,
            row.provider,
            row.model,
            row.usage.input,
            row.usage.output,
            row.usage.cache_read,
            row.usage.cache_creation,
            row.cost.input,
            row.cost.output,
            row.cost.cache_read,
            row.cost.cache_write,
            row.cost.total,
            row.session_id,
            row.project_path,
            row.created_at,
            row.data_source,
        ],
    )
    .map(|changed| changed > 0)
    .unwrap_or(false)
}

fn insert_opencode_record(
    conn: &rusqlite::Connection,
    request_id: &str,
    usage: &OpenCodeUsage,
    session_id: &str,
    project_path: &str,
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
            project_path,
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

pub(crate) fn now_secs() -> i64 {
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

    for session in sessions {
        let session_id = &session.id;
        let session_key = format!("{file_path}:{session_id}");
        let (last_session_modified, _last_offset) = get_sync_state(&conn, &session_key);
        if session.watermark <= last_session_modified {
            continue;
        }

        let (messages, has_incomplete_usage) =
            match opencode::query_assistant_messages(&opencode_conn, session_id) {
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
            if insert_opencode_record(
                &conn,
                &request_id,
                &usage,
                session_id,
                &session.project_path,
                created_at,
            ) {
                result.imported += 1;
            } else {
                result.skipped += 1;
            }
        }

        if !has_incomplete_usage {
            update_sync_state(&conn, &session_key, session.watermark, 0);
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

#[derive(Clone, Debug)]
struct CodexParentTimeline {
    signatures: Vec<(u64, CodexTokenUsageSignature)>,
    max_timestamp_ms: Option<u64>,
    has_missing_timestamp: bool,
}

impl CodexParentTimeline {
    fn signatures_before(
        &self,
        parent_path: &Path,
        cutoff_ms: u64,
    ) -> Result<Vec<CodexTokenUsageSignature>, String> {
        if self.has_missing_timestamp {
            return Err(format!(
                "parent rollout {} contains token_count without a timestamp",
                parent_path.display()
            ));
        }
        if self
            .max_timestamp_ms
            .map_or(true, |timestamp| timestamp < cutoff_ms)
        {
            return Err(format!(
                "parent rollout {} has not reached the child fork timestamp",
                parent_path.display()
            ));
        }
        Ok(self
            .signatures
            .iter()
            .filter(|(timestamp, _)| *timestamp <= cutoff_ms)
            .map(|(_, signature)| signature.clone())
            .collect())
    }
}

struct CodexReplayResolver {
    rollout_index: HashMap<String, Vec<PathBuf>>,
    timelines: HashMap<PathBuf, Result<CodexParentTimeline, String>>,
}

impl CodexReplayResolver {
    fn new(files: &[PathBuf]) -> Self {
        let mut rollout_index: HashMap<String, Vec<PathBuf>> = HashMap::new();
        for path in files {
            if let Some(thread_id) = parse::codex_thread_id_from_filename(path) {
                rollout_index
                    .entry(thread_id)
                    .or_default()
                    .push(path.clone());
            }
        }
        Self {
            rollout_index,
            timelines: HashMap::new(),
        }
    }

    fn timeline(&mut self, path: &Path) -> Result<CodexParentTimeline, String> {
        if let Some(cached) = self.timelines.get(path) {
            return cached.clone();
        }
        let parsed = parse::parse_codex_rollout(path)
            .ok_or_else(|| format!("could not parse parent rollout {}", path.display()));
        let timeline = parsed.map(|parsed| {
            let mut signatures = Vec::new();
            let max_timestamp_ms = parsed.max_timestamp_ms;
            let mut has_missing_timestamp = false;
            for event in parsed.token_events {
                match event.timestamp_ms {
                    Some(timestamp) => {
                        signatures.push((timestamp, event.signature));
                    }
                    None => has_missing_timestamp = true,
                }
            }
            CodexParentTimeline {
                signatures,
                max_timestamp_ms,
                has_missing_timestamp,
            }
        });
        self.timelines.insert(path.to_path_buf(), timeline.clone());
        timeline
    }

    fn parent_signatures(
        &mut self,
        parent_id: &str,
        cutoff_ms: u64,
    ) -> Result<Vec<CodexTokenUsageSignature>, String> {
        let Some(paths) = self.rollout_index.get(parent_id).cloned() else {
            return Err(format!("parent rollout {parent_id} was not found"));
        };
        let mut snapshots = Vec::with_capacity(paths.len());
        for path in paths {
            let timeline = self.timeline(&path)?;
            snapshots.push(timeline.signatures_before(&path, cutoff_ms)?);
        }
        let Some(first) = snapshots.first().cloned() else {
            return Err(format!("parent rollout {parent_id} was not found"));
        };
        if snapshots.iter().skip(1).any(|snapshot| snapshot != &first) {
            return Err(format!(
                "parent rollout {parent_id} resolves to multiple inconsistent files"
            ));
        }
        Ok(first)
    }
}

fn matching_replay_prefix(
    child: &[parse::CodexTokenEvent],
    parent: &[CodexTokenUsageSignature],
) -> usize {
    let mut parent_offset = 0usize;
    let mut matched = 0usize;
    for event in child {
        let Some(relative_match) = parent[parent_offset..]
            .iter()
            .position(|signature| signature == &event.signature)
        else {
            break;
        };
        parent_offset = parent_offset.saturating_add(relative_match + 1);
        matched = matched.saturating_add(1);
    }
    matched
}

/// Sync one Codex rollout after stripping any replayed parent token prefix.
fn sync_codex_file(path: &Path, replay: &mut CodexReplayResolver) -> SyncResult {
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

    let Some(parsed) = parse::parse_codex_rollout(path) else {
        result
            .errors
            .push(format!("Could not parse Codex rollout {}", path.display()));
        return result;
    };
    if parsed.token_events.iter().all(|event| event.call.is_none()) {
        update_sync_state(&conn, &file_path, modified, line_count(path));
        return result;
    }
    let Some(sid) = parsed.root_thread_id.clone() else {
        result.errors.push(format!(
            "Deferred Codex rollout {}: missing root thread id",
            path.display()
        ));
        return result;
    };
    if !parsed.root_meta_seen {
        result.errors.push(format!(
            "Deferred Codex rollout {}: billable events appeared before session_meta",
            path.display()
        ));
        return result;
    }

    let replay_prefix = match &parsed.parent {
        CodexParentResolution::None => 0,
        CodexParentResolution::Deferred(reason) => {
            result.errors.push(format!(
                "Deferred Codex rollout {}: {reason}",
                path.display()
            ));
            return result;
        }
        CodexParentResolution::Parent(parent_id) => {
            if parent_id == &sid {
                result.errors.push(format!(
                    "Deferred Codex rollout {}: parent equals root thread id",
                    path.display()
                ));
                return result;
            }
            let Some(cutoff_ms) = parsed.root_timestamp_ms else {
                result.errors.push(format!(
                    "Deferred Codex rollout {}: child session_meta has no valid timestamp",
                    path.display()
                ));
                return result;
            };
            let parent_signatures = match replay.parent_signatures(parent_id, cutoff_ms) {
                Ok(signatures) => signatures,
                Err(reason) => {
                    result.errors.push(format!(
                        "Deferred Codex rollout {}: {reason}",
                        path.display()
                    ));
                    return result;
                }
            };
            matching_replay_prefix(&parsed.token_events, &parent_signatures)
        }
    };
    let file_mtime_secs = (modified / 1_000_000_000).max(0);

    for (token_offset, event) in parsed.token_events.iter().enumerate() {
        if token_offset < replay_prefix {
            continue;
        }
        let (Some(call), Some(event_index)) = (&event.call, event.event_index) else {
            continue;
        };
        let request_id = format!("codex_session:{sid}:{event_index}");
        let created_at = call
            .timestamp_ms
            .map(|ms| (ms / 1000) as i64)
            .unwrap_or(file_mtime_secs);

        if insert_record(&conn, &request_id, "codex", call, &parsed.cwd, created_at) {
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
             CREATE TABLE usage_daily_rollups (
                period_start INTEGER NOT NULL, provider TEXT NOT NULL,
                model TEXT NOT NULL, request_count INTEGER NOT NULL DEFAULT 0,
                success_count INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                total_cost_usd REAL NOT NULL DEFAULT 0,
                PRIMARY KEY (period_start, provider, model));
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
            (cost - 5.0).abs() < 1e-6,
            "1M input Claude Opus 4.8 = $5, got {cost}"
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
            "/projects/demo",
            1_609_459_200,
        ));
        let row: (String, i64, i64, f64, f64, String, String) = conn
            .query_row(
                "SELECT provider, output_tokens, cache_creation_tokens,
                        total_cost_usd, input_cost_usd, data_source, project_path
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
                        row.get(6)?,
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
        assert_eq!(row.6, "/projects/demo");
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
            "/projects/demo",
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
        assert!((total_cost - 5.0).abs() < 1e-6);
        assert!((input_cost - 5.0).abs() < 1e-6);
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
    fn upsert_session_record_refreshes_active_turn_values() {
        let conn = mem_conn();
        let first_usage = UsageSummary {
            input: 10,
            output: 2,
            cache_read: 3,
            cache_creation: 0,
        };
        let second_usage = UsageSummary {
            output: 9,
            ..first_usage
        };
        let first_cost = pricing::cost_breakdown("gemini-2.5-pro", &first_usage);
        let second_cost = pricing::cost_breakdown("gemini-2.5-pro", &second_usage);

        assert!(upsert_session_record(
            &conn,
            SessionUsageUpsert {
                request_id: "gemini_session:s1:m1",
                provider: "gemini",
                model: "gemini-2.5-pro",
                usage: &first_usage,
                cost: first_cost,
                session_id: "s1",
                project_path: "/repo",
                created_at: 100,
                data_source: "gemini_session",
            },
        ));
        assert!(!upsert_session_record(
            &conn,
            SessionUsageUpsert {
                request_id: "gemini_session:s1:m1",
                provider: "gemini",
                model: "gemini-2.5-pro",
                usage: &first_usage,
                cost: first_cost,
                session_id: "s1",
                project_path: "/repo",
                created_at: 100,
                data_source: "gemini_session",
            },
        ));
        assert!(upsert_session_record(
            &conn,
            SessionUsageUpsert {
                request_id: "gemini_session:s1:m1",
                provider: "gemini",
                model: "gemini-2.5-pro",
                usage: &second_usage,
                cost: second_cost,
                session_id: "s1",
                project_path: "/repo",
                created_at: 100,
                data_source: "gemini_session",
            },
        ));

        let output: i64 = conn
            .query_row(
                "SELECT output_tokens FROM usage_records WHERE request_id = 'gemini_session:s1:m1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(output, 9);
    }

    fn write_codex_rollout(label: &str, thread_id: &str, content: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "threadterm-stats-sync-{label}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("rollout-{thread_id}.jsonl"));
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn codex_replay_alignment_strips_parent_prefix_and_keeps_live_usage() {
        const PARENT: &str = "11111111-1111-1111-1111-111111111111";
        const CHILD: &str = "22222222-2222-2222-2222-222222222222";
        let parent = write_codex_rollout(
            "replay-parent",
            PARENT,
            &format!(
                r#"{{"type":"session_meta","timestamp":"2021-01-01T00:00:00Z","payload":{{"id":"{PARENT}"}}}}
{{"type":"event_msg","timestamp":"2021-01-01T00:00:01Z","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":100,"cached_input_tokens":50,"output_tokens":10}}}}}}}}
{{"type":"turn_context","timestamp":"2021-01-01T00:00:10Z","payload":{{"model":"gpt-5-codex"}}}}"#
            ),
        );
        let child = write_codex_rollout(
            "replay-child",
            CHILD,
            &format!(
                r#"{{"type":"session_meta","timestamp":"2021-01-01T00:00:05Z","payload":{{"id":"{CHILD}","source":{{"subagent":{{"thread_spawn":{{"parent_thread_id":"{PARENT}"}}}}}}}}}}
{{"type":"event_msg","timestamp":"2021-01-01T00:00:06Z","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":100,"cached_input_tokens":50,"output_tokens":10}}}}}}}}
{{"type":"event_msg","timestamp":"2021-01-01T00:00:07Z","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":160,"cached_input_tokens":70,"output_tokens":20}}}}}}}}"#
            ),
        );
        let parsed_child = parse::parse_codex_rollout(&child).expect("child rollout");
        let mut resolver = CodexReplayResolver::new(&[parent.clone(), child.clone()]);
        let signatures = resolver
            .parent_signatures(PARENT, parsed_child.root_timestamp_ms.unwrap())
            .expect("parent timeline reached child fork");

        assert_eq!(signatures.len(), 1);
        assert_eq!(
            matching_replay_prefix(&parsed_child.token_events, &signatures),
            1
        );
        let live = parsed_child.token_events[1]
            .call
            .as_ref()
            .expect("live delta");
        assert_eq!(live.usage.input, 40);
        assert_eq!(live.usage.cache_read, 20);
        assert_eq!(live.usage.output, 10);
        let _ = std::fs::remove_file(parent);
        let _ = std::fs::remove_file(child);
    }

    #[test]
    fn codex_parent_future_signature_cannot_extend_replay_prefix() {
        const PARENT: &str = "33333333-3333-3333-3333-333333333333";
        const CHILD: &str = "44444444-4444-4444-4444-444444444444";
        let parent = write_codex_rollout(
            "future-parent",
            PARENT,
            &format!(
                r#"{{"type":"session_meta","timestamp":"2021-01-01T00:00:00Z","payload":{{"id":"{PARENT}"}}}}
{{"type":"event_msg","timestamp":"2021-01-01T00:00:01Z","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":100,"cached_input_tokens":50,"output_tokens":10}}}}}}}}
{{"type":"event_msg","timestamp":"2021-01-01T00:00:06Z","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":200,"cached_input_tokens":100,"output_tokens":20}}}}}}}}"#
            ),
        );
        let child = write_codex_rollout(
            "future-child",
            CHILD,
            &format!(
                r#"{{"type":"session_meta","timestamp":"2021-01-01T00:00:05Z","payload":{{"id":"{CHILD}","forked_from_id":"{PARENT}"}}}}
{{"type":"event_msg","timestamp":"2021-01-01T00:00:07Z","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":200,"cached_input_tokens":100,"output_tokens":20}}}}}}}}"#
            ),
        );
        let parsed_child = parse::parse_codex_rollout(&child).expect("child rollout");
        let mut resolver = CodexReplayResolver::new(&[parent.clone(), child.clone()]);
        let signatures = resolver
            .parent_signatures(PARENT, parsed_child.root_timestamp_ms.unwrap())
            .expect("parent file advanced beyond fork");

        assert_eq!(signatures.len(), 1);
        assert_eq!(
            matching_replay_prefix(&parsed_child.token_events, &signatures),
            0
        );
        let _ = std::fs::remove_file(parent);
        let _ = std::fs::remove_file(child);
    }

    #[test]
    fn codex_replay_alignment_allows_filtered_parent_subsequence() {
        const PARENT: &str = "66666666-6666-6666-6666-666666666666";
        const CHILD: &str = "77777777-7777-7777-7777-777777777777";
        let parent = write_codex_rollout(
            "subsequence-parent",
            PARENT,
            &format!(
                r#"{{"type":"session_meta","timestamp":"2021-01-01T00:00:00Z","payload":{{"id":"{PARENT}"}}}}
{{"type":"event_msg","timestamp":"2021-01-01T00:00:01Z","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":100,"cached_input_tokens":50,"output_tokens":10}}}}}}}}
{{"type":"event_msg","timestamp":"2021-01-01T00:00:02Z","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":200,"cached_input_tokens":100,"output_tokens":20}}}}}}}}
{{"type":"event_msg","timestamp":"2021-01-01T00:00:03Z","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":300,"cached_input_tokens":150,"output_tokens":30}}}}}}}}
{{"type":"turn_context","timestamp":"2021-01-01T00:00:10Z","payload":{{"model":"gpt-5-codex"}}}}"#
            ),
        );
        let child = write_codex_rollout(
            "subsequence-child",
            CHILD,
            &format!(
                r#"{{"type":"session_meta","timestamp":"2021-01-01T00:00:05Z","payload":{{"id":"{CHILD}","forked_from_id":"{PARENT}"}}}}
{{"type":"event_msg","timestamp":"2021-01-01T00:00:06Z","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":100,"cached_input_tokens":50,"output_tokens":10}}}}}}}}
{{"type":"event_msg","timestamp":"2021-01-01T00:00:07Z","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":300,"cached_input_tokens":150,"output_tokens":30}}}}}}}}
{{"type":"event_msg","timestamp":"2021-01-01T00:00:08Z","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":450,"cached_input_tokens":220,"output_tokens":45}}}}}}}}"#
            ),
        );
        let parsed_child = parse::parse_codex_rollout(&child).expect("child rollout");
        let mut resolver = CodexReplayResolver::new(&[parent.clone(), child.clone()]);
        let signatures = resolver
            .parent_signatures(PARENT, parsed_child.root_timestamp_ms.unwrap())
            .expect("parent timeline");

        assert_eq!(signatures.len(), 3);
        assert_eq!(
            matching_replay_prefix(&parsed_child.token_events, &signatures),
            2
        );
        assert!(parsed_child.token_events[2].call.is_some());
        let _ = std::fs::remove_file(parent);
        let _ = std::fs::remove_file(child);
    }

    #[test]
    fn codex_missing_parent_resolution_is_retryable() {
        let mut resolver = CodexReplayResolver::new(&[]);
        let error = resolver
            .parent_signatures("55555555-5555-5555-5555-555555555555", 1)
            .unwrap_err();
        assert!(error.contains("was not found"));
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
        let parser_version: String = conn
            .query_row(
                "SELECT value FROM stats_meta WHERE key = 'parser_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(parser_version, "10");

        // Second call: version now matches → no-op (no needless wipe each sync).
        assert!(
            !rebuild_if_parser_changed(&conn),
            "matching version must not rebuild"
        );
    }

    #[test]
    fn session_log_ingestion_has_no_dashboard_time_lower_bound() {
        let directory = std::env::temp_dir().join(format!(
            "threadterm-stats-range-independent-ingest-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("old-mtime-recent-record.jsonl");
        std::fs::write(&path, "{\"timestamp\":\"2026-08-12T00:00:00Z\"}\n").unwrap();
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_times(
            std::fs::FileTimes::new()
                .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(86_400)),
        )
        .unwrap();

        let candidates = session_log_candidates(&directory);

        assert_eq!(candidates, vec![path]);
        let _ = std::fs::remove_dir_all(directory);
    }
}
