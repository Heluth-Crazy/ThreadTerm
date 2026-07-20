//! Token statistics — scan Claude/Codex session jsonl, aggregate usage + cost,
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
mod opencode;
pub(crate) mod parse;
mod pricing;
mod sync;
mod types;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use aggregate::aggregate_from_db;
use types::AgentStats;

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

/// Map a range token to a `(lo_ms, hi_ms)` window (UTC). `hi = None` = up to now.
fn parse_range(range: &str) -> (Option<u64>, Option<u64>) {
    let now = now_ms();
    let day = 86_400_000u64;
    match range {
        "today" => (Some(now - now % day), None),
        "7d" => (Some(now.saturating_sub(7 * day)), None),
        "30d" => (Some(now.saturating_sub(30 * day)), None),
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
