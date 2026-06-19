//! Token statistics — scan Claude/Codex session jsonl, aggregate usage + cost,
//! stream results to the frontend over `stats://` events from a background
//! thread with generation-based cancellation.

mod aggregate;
mod parse;
mod pricing;
mod types;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::provider_sessions::jsonl_files_recent_first;
use aggregate::Aggregator;
use types::AgentStats;

/// Monotonic generation. Each compute / cancel bumps it; a worker whose
/// request_id no longer matches the latest generation bails silently.
static STATS_GEN: AtomicU64 = AtomicU64::new(0);

const PROGRESS_EVERY: usize = 16;

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
fn claude_root() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join("projects"));
        }
    }
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Codex session root. Honours `CODEX_HOME` (Codex CLI's override), else
/// `~/.codex` — which is `%USERPROFILE%\.codex` on Windows.
fn codex_root() -> Option<PathBuf> {
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

fn run_worker(
    app: &AppHandle,
    scope: &str,
    range: &str,
    request_id: u64,
) -> Result<AgentStats, String> {
    let (lo, hi) = parse_range(range);

    // Coarse pre-filter by file mtime (lo); the aggregator still does per-call
    // window judgement so resumed-today old sessions don't pollute "Today".
    let mut files: Vec<(PathBuf, &'static str, Option<u64>)> = Vec::new();
    if scope == "all" || scope == "claude" {
        if let Some(root) = claude_root() {
            for f in jsonl_files_recent_first(&root, lo) {
                files.push((f.path, "claude", f.modified_ms));
            }
        }
    }
    if scope == "all" || scope == "codex" {
        if let Some(root) = codex_root() {
            for f in jsonl_files_recent_first(&root, lo) {
                files.push((f.path, "codex", f.modified_ms));
            }
        }
    }

    let total = files.len();
    let mut agg = Aggregator::new(lo, hi);
    for (i, (path, provider, mtime)) in files.iter().enumerate() {
        if request_id != STATS_GEN.load(Ordering::SeqCst) {
            return Err("cancelled".to_string());
        }
        let file_session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        match *provider {
            "claude" => {
                let (cwd, calls) = parse::parse_claude_file(path);
                if !calls.is_empty() {
                    agg.feed_session(&file_session_id, &cwd, *mtime, &calls);
                }
            }
            "codex" => {
                if let Some((sid, cwd, call)) = parse::parse_codex_file(path) {
                    let session_id = if sid.is_empty() { file_session_id } else { sid };
                    agg.feed_session(&session_id, &cwd, *mtime, std::slice::from_ref(&call));
                }
            }
            _ => {}
        }
        if i % PROGRESS_EVERY == 0 {
            let _ = app.emit(
                "stats://progress",
                StatsProgress {
                    request_id,
                    scanned: i + 1,
                    total,
                },
            );
        }
    }

    Ok(agg.snapshot())
}
