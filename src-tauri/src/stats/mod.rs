//! Token statistics — scan supported AI CLI session logs, aggregate usage + cost,
//! stream results to the frontend over `stats://` events from a background
//! thread with generation-based cancellation.
//!
//! ## Flow
//! 1. `sync::sync_all` incrementally ingests new session-log lines into the
//!    `usage_records` SQLite table (mtime-gated; unchanged files are skipped).
//! 2. `aggregate::aggregate_from_db` reads back rows within the requested time
//!    window and scope, producing the `AgentStats` snapshot.
//! 3. The snapshot is emitted as a `stats://done` event.

mod aggregate;
mod dashboard;
mod gemini;
mod grok;
mod opencode;
pub(crate) mod parse;
mod pricing;
mod sync;
mod types;

#[cfg(feature = "stats-proxy")]
pub mod proxy;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Local;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use aggregate::aggregate_from_db;
use types::{AgentStats, StatsDashboard, StatsDashboardFilters};

/// Monotonic generation. Each compute / cancel bumps it; a worker whose
/// request_id no longer matches the latest generation bails silently.
static STATS_GEN: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatsProgress {
    request_id: u64,
    scanned: usize,
    total: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatsDone {
    request_id: u64,
    stats: AgentStats,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatsErrorEvent {
    request_id: u64,
    error: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Map a range token to a `(lo_ms, hi_ms)` window. `today` starts at the
/// machine's local midnight, matching cc-switch's user-facing day boundary.
fn parse_range(range: &str) -> (Option<u64>, Option<u64>) {
    let now = now_ms();
    let day = 86_400_000u64;
    let local_today = Local::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|midnight| midnight.and_local_timezone(Local).single())
        .map(|midnight| midnight.timestamp_millis().max(0) as u64)
        .unwrap_or_else(|| now - now % day);
    match range {
        "today" => (Some(local_today), None),
        "7d" => (Some(local_today.saturating_sub(7 * day)), None),
        "30d" => (Some(local_today.saturating_sub(30 * day)), None),
        _ => (None, None),
    }
}

/// Claude session root. Honours `CLAUDE_CONFIG_DIR` (Claude Code's override),
/// else `~/.claude` — which is `%USERPROFILE%\.claude` on Windows.
pub(crate) fn claude_root() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join("projects"));
        }
    }
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Codex session root. Honours `CODEX_HOME` (Codex CLI's override), else
/// `~/.codex` — which is `%USERPROFILE%\.codex` on Windows.
pub(crate) fn codex_root() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CODEX_HOME") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join("sessions"));
        }
    }
    dirs::home_dir().map(|h| h.join(".codex").join("sessions"))
}

/// Kick off a background scan. Returns immediately; results arrive via
/// `stats://progress` / `stats://done` / `stats://error` events.
#[tauri::command]
pub fn stats_compute(app: AppHandle, scope: String, range: String, request_id: u64) {
    STATS_GEN.store(request_id, Ordering::SeqCst);
    thread::spawn(move || {
        let result = run_worker(&app, &scope, &range, request_id);
        if request_id != STATS_GEN.load(Ordering::SeqCst) {
            return; // superseded / cancelled mid-run
        }
        match result {
            Ok(stats) => {
                let _ = app.emit("stats://done", StatsDone { request_id, stats });
            }
            Err(error) => {
                let _ = app.emit("stats://error", StatsErrorEvent { request_id, error });
            }
        }
    });
}

/// Cancel any in-flight scan.
#[tauri::command]
pub fn stats_cancel() {
    STATS_GEN.fetch_add(1, Ordering::SeqCst);
}

/// Force a full rebuild: clear ingested rows + sync cursors so the next
/// `stats_compute` re-ingests every session file from scratch with the current
/// parser. Use when the on-disk numbers look stale.
#[tauri::command]
pub fn stats_rebuild() -> Result<(), String> {
    sync::rebuild_now()
}

/// Query the source-aware cc-switch-compatible dashboard. Sync is kept as a
/// separate operation so callers can retain the existing progress events and
/// avoid starting two filesystem scans when the legacy snapshot is requested.
#[tauri::command]
pub fn stats_dashboard(
    scope: String,
    range: String,
    limit: Option<u32>,
    cursor: Option<String>,
    filters: Option<StatsDashboardFilters>,
) -> Result<StatsDashboard, String> {
    let (lo, hi) = parse_range(&range);
    let conn = crate::db::get_db()?;
    let result = if let Some(filters) = filters {
        dashboard::dashboard_from_db_with_filters(
            &conn,
            &scope,
            lo,
            hi,
            limit.map(|value| value as usize),
            cursor.as_deref(),
            &filters,
        )
    } else {
        dashboard::dashboard_from_db(
            &conn,
            &scope,
            lo,
            hi,
            limit.map(|value| value as usize),
            cursor.as_deref(),
        )
    };
    result.map_err(|error| error.to_string())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsPricingEntry {
    pub model: String,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub cache_write_per_mtok: f64,
    pub cache_read_per_mtok: f64,
    pub enabled: bool,
}

#[tauri::command]
pub fn stats_pricing_list() -> Result<Vec<StatsPricingEntry>, String> {
    let conn = crate::db::get_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT model, input_per_mtok, output_per_mtok,
                    cache_write_per_mtok, cache_read_per_mtok, enabled
             FROM stats_pricing ORDER BY model COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(StatsPricingEntry {
                model: row.get(0)?,
                input_per_mtok: row.get(1)?,
                output_per_mtok: row.get(2)?,
                cache_write_per_mtok: row.get(3)?,
                cache_read_per_mtok: row.get(4)?,
                enabled: row.get::<_, i64>(5)? != 0,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn stats_pricing_upsert(entry: StatsPricingEntry) -> Result<(), String> {
    if entry.model.trim().is_empty()
        || ![
            entry.input_per_mtok,
            entry.output_per_mtok,
            entry.cache_write_per_mtok,
            entry.cache_read_per_mtok,
        ]
        .iter()
        .all(|value| value.is_finite() && *value >= 0.0)
    {
        return Err("Invalid model pricing entry".to_string());
    }
    let conn = crate::db::get_db()?;
    conn.execute(
        "INSERT INTO stats_pricing
            (model, input_per_mtok, output_per_mtok,
             cache_write_per_mtok, cache_read_per_mtok, enabled, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%s', 'now'))
         ON CONFLICT(model) DO UPDATE SET
             input_per_mtok = excluded.input_per_mtok,
             output_per_mtok = excluded.output_per_mtok,
             cache_write_per_mtok = excluded.cache_write_per_mtok,
             cache_read_per_mtok = excluded.cache_read_per_mtok,
             enabled = excluded.enabled,
             updated_at = excluded.updated_at",
        rusqlite::params![
            pricing::canonical_model(&entry.model),
            entry.input_per_mtok,
            entry.output_per_mtok,
            entry.cache_write_per_mtok,
            entry.cache_read_per_mtok,
            i64::from(entry.enabled),
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn stats_pricing_delete(model: String) -> Result<(), String> {
    let conn = crate::db::get_db()?;
    conn.execute(
        "DELETE FROM stats_pricing WHERE model = ?1",
        [pricing::canonical_model(&model)],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn run_worker(
    app: &AppHandle,
    scope: &str,
    range: &str,
    request_id: u64,
) -> Result<AgentStats, String> {
    let (lo, hi) = parse_range(range);

    // Phase 1: incremental sync. sync_all streams progress as it walks files.
    sync::sync_all(lo, |scanned, total| {
        if request_id != STATS_GEN.load(Ordering::SeqCst) {
            return;
        }
        let _ = app.emit(
            "stats://progress",
            StatsProgress {
                request_id,
                scanned,
                total,
            },
        );
    });

    if request_id != STATS_GEN.load(Ordering::SeqCst) {
        return Err("cancelled".to_string());
    }

    // Phase 2: aggregate from the persisted usage_records within the
    // requested scope + time window.
    let conn = crate::db::get_db()?;
    aggregate_from_db(&conn, scope, lo, hi).map_err(|e| e.to_string())
}
