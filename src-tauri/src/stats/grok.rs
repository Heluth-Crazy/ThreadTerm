//! Grok Build session-log ingestion aligned with CC Switch.
//!
//! `updates.jsonl` contains independent per-prompt `turn_completed` totals.
//! They must be recorded at face value: adjacent events are not cumulative
//! snapshots and must never be differenced. `reasoningTokens` is already part
//! of `outputTokens`, and `costUsdTicks` uses 1 tick = 1e-10 USD.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::Value;

use crate::db::get_db;
use crate::stats::pricing::{self, CostBreakdown};
use crate::stats::sync::{
    get_sync_state, mtime_nanos, update_sync_state, upsert_session_record, SessionUsageUpsert,
    SyncResult,
};
use crate::stats::types::UsageSummary;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct GrokCounters {
    input: u64,
    output: u64,
    cached: u64,
    cost_ticks: u64,
    cost_partial: bool,
}

impl GrokCounters {
    fn is_zero(self) -> bool {
        self.input == 0 && self.output == 0 && self.cached == 0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct GrokUsageEvent {
    created_at: i64,
    prompt_id: String,
    cost_partial: bool,
    per_model: Vec<(String, GrokCounters)>,
}

pub(crate) fn sync_grok() -> SyncResult {
    let files = collect_grok_updates_files();
    let mut result = SyncResult {
        files_scanned: files.len() as u32,
        ..SyncResult::default()
    };
    if files.is_empty() {
        return result;
    }

    let Ok(conn) = get_db() else {
        result.errors.push("DB unavailable".into());
        return result;
    };
    for path in files {
        sync_grok_file(&conn, &path, &mut result);
    }
    result
}

fn collect_grok_updates_files() -> Vec<PathBuf> {
    let Some(root) = dirs::home_dir().map(|home| home.join(".grok")) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    // Archived first, active second: if both contain the same session id, the
    // current active copy is the final UPSERT source.
    for sessions_root in [root.join("archived_sessions"), root.join("sessions")] {
        collect_named_files(&sessions_root, "updates.jsonl", &mut files);
    }
    files
}

fn collect_named_files(root: &Path, filename: &str, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            collect_named_files(&path, filename, files);
        } else if file_type.is_file()
            && path.file_name().and_then(|name| name.to_str()) == Some(filename)
        {
            files.push(path);
        }
    }
}

fn sync_grok_file(conn: &Connection, path: &Path, result: &mut SyncResult) {
    let file_path = path.to_string_lossy().to_string();
    let modified = mtime_nanos(path);
    let (last_modified, _) = get_sync_state(conn, &file_path);
    if modified <= last_modified {
        return;
    }

    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) => {
            result.errors.push(format!(
                "Grok Build session read failed {}: {error}",
                path.display()
            ));
            return;
        }
    };
    let events = parse_grok_usage_events(&content);
    let session_id = path
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        .unwrap_or("unknown");
    let project_path = grok_project_path(path).unwrap_or_default();

    for (event_index, event) in events.iter().enumerate() {
        for (model, counters) in &event.per_model {
            if counters.is_zero() {
                continue;
            }

            // xAI inputTokens includes cached input. Persist fresh input plus
            // cache read so the aggregate's four categories are disjoint.
            let cache_read = counters.cached.min(counters.input);
            let usage = UsageSummary {
                input: counters.input.saturating_sub(cache_read),
                output: counters.output,
                cache_creation: 0,
                cache_read,
            };
            let local_cost = pricing::cost_breakdown(model, &usage);
            let cost = authoritative_grok_cost(
                local_cost,
                counters.cost_ticks,
                event.cost_partial || counters.cost_partial,
            );
            let request_id = grok_request_id(session_id, &event.prompt_id, event_index, model);
            if upsert_session_record(
                conn,
                SessionUsageUpsert {
                    request_id: &request_id,
                    provider: "grok",
                    model,
                    usage: &usage,
                    cost,
                    session_id,
                    project_path: &project_path,
                    created_at: event.created_at,
                    data_source: "grok_session",
                },
            ) {
                result.imported = result.imported.saturating_add(1);
            } else {
                result.skipped = result.skipped.saturating_add(1);
            }
        }
    }

    update_sync_state(conn, &file_path, modified, events.len() as i64);
}

fn grok_request_id(session_id: &str, prompt_id: &str, event_index: usize, model: &str) -> String {
    let turn_key = if prompt_id.is_empty() {
        format!("idx{event_index}")
    } else {
        prompt_id.to_string()
    };
    format!("grok_session:{session_id}:{turn_key}:{model}")
}

fn grok_project_path(updates_path: &Path) -> Option<String> {
    let summary_path = updates_path.parent()?.join("summary.json");
    let content = fs::read_to_string(summary_path).ok()?;
    let value: Value = serde_json::from_str(&content).ok()?;
    value
        .get("info")
        .and_then(|info| info.get("cwd"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())
        .map(ToOwned::to_owned)
}

fn parse_grok_usage_events(content: &str) -> Vec<GrokUsageEvent> {
    let mut events = Vec::new();
    for line in content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record.get("method").and_then(Value::as_str) != Some("_x.ai/session/update") {
            continue;
        }
        let Some(update) = record.get("params").and_then(|params| params.get("update")) else {
            continue;
        };
        let kind = update.get("sessionUpdate").and_then(Value::as_str);
        if kind.is_some() && kind != Some("turn_completed") {
            continue;
        }
        let Some(usage) = update.get("usage").filter(|usage| usage.is_object()) else {
            continue;
        };
        let Some(created_at) = parse_event_timestamp(record.get("timestamp")) else {
            continue;
        };
        let prompt_id = update
            .get("prompt_id")
            .or_else(|| update.get("promptId"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let cost_partial = usage
            .get("costIsPartial")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut per_model = usage
            .get("modelUsage")
            .and_then(Value::as_object)
            .map(|models| {
                models
                    .iter()
                    .map(|(model, value)| (model.clone(), parse_grok_counters(value)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if per_model.is_empty() {
            per_model.push(("unknown".to_string(), parse_grok_counters(usage)));
        }
        per_model.sort_by(|left, right| left.0.cmp(&right.0));
        events.push(GrokUsageEvent {
            created_at,
            prompt_id,
            cost_partial,
            per_model,
        });
    }
    events
}

fn parse_grok_counters(value: &Value) -> GrokCounters {
    let get = |key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    GrokCounters {
        input: get("inputTokens"),
        output: get("outputTokens"),
        cached: get("cachedReadTokens"),
        cost_ticks: get("costUsdTicks"),
        cost_partial: value
            .get("costIsPartial")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn parse_event_timestamp(value: Option<&Value>) -> Option<i64> {
    crate::agent_sessions::types::read_timestamp_ms(value)
        .and_then(|timestamp| i64::try_from(timestamp / 1000).ok())
}

fn authoritative_grok_cost(
    local: CostBreakdown,
    reported_ticks: u64,
    reported_is_partial: bool,
) -> CostBreakdown {
    let reported = (reported_ticks > 0).then_some(reported_ticks as f64 / 10_000_000_000.0);
    match reported {
        Some(reported) if !reported_is_partial => CostBreakdown {
            total: reported,
            ..local
        },
        Some(reported) if local.total <= 0.0 => CostBreakdown {
            total: reported,
            ..local
        },
        _ => local,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(prompt: &str, input: u64, output: u64, cached: u64, ticks: u64) -> String {
        serde_json::json!({
            "timestamp": 1_700_000_000u64,
            "method": "_x.ai/session/update",
            "params": {
                "update": {
                    "sessionUpdate": "turn_completed",
                    "prompt_id": prompt,
                    "usage": {
                        "modelUsage": {
                            "grok-4.5-build": {
                                "inputTokens": input,
                                "outputTokens": output,
                                "cachedReadTokens": cached,
                                "reasoningTokens": 9,
                                "costUsdTicks": ticks
                            }
                        }
                    }
                }
            }
        })
        .to_string()
    }

    #[test]
    fn parses_turn_completed_and_ignores_noise_or_snapshots() {
        let content = format!(
            "not json\n{}\n{}\n{}\n",
            r#"{"timestamp":1700000000,"method":"other","params":{"update":{"usage":{"inputTokens":999}}}}"#,
            r#"{"timestamp":1700000001,"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"usage_snapshot","usage":{"inputTokens":999}}}}"#,
            event("p1", 16_632, 104, 0, 338_880_000)
        );
        let events = parse_grok_usage_events(&content);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].prompt_id, "p1");
        assert_eq!(events[0].per_model[0].1.input, 16_632);
        assert_eq!(events[0].per_model[0].1.output, 104);
        assert_eq!(events[0].created_at, 1_700_000_000);
    }

    #[test]
    fn identical_adjacent_turns_remain_two_face_value_events() {
        let line = event("p1", 1000, 200, 100, 0);
        let second = event("p2", 1000, 200, 100, 0);
        let events = parse_grok_usage_events(&format!("{line}\n{second}\n"));
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].per_model[0].1, events[1].per_model[0].1);
        assert_eq!(
            events
                .iter()
                .map(|event| event.per_model[0].1.input)
                .sum::<u64>(),
            2000
        );
    }

    #[test]
    fn reasoning_is_not_added_to_output_and_cache_is_part_of_input() {
        let events = parse_grok_usage_events(&event("p1", 13_793, 21, 13_696, 44_288_000));
        let counters = events[0].per_model[0].1;
        let cache_read = counters.cached.min(counters.input);
        let usage = UsageSummary {
            input: counters.input - cache_read,
            output: counters.output,
            cache_creation: 0,
            cache_read,
        };
        assert_eq!(usage.input, 97);
        assert_eq!(usage.output, 21);
        assert_eq!(usage.cache_read, 13_696);
        assert_eq!(usage.total(), 13_814);
    }

    #[test]
    fn complete_reported_cost_overrides_local_total() {
        let local = CostBreakdown {
            input: 0.01,
            output: 0.02,
            cache_read: 0.003,
            cache_write: 0.0,
            total: 0.033,
        };
        let cost = authoritative_grok_cost(local, 338_880_000, false);
        assert!((cost.total - 0.033_888).abs() < 1e-12);
        assert_eq!(cost.input, local.input);
    }

    #[test]
    fn request_id_prefers_prompt_id_and_has_stable_index_fallback() {
        assert_eq!(
            grok_request_id("session-1", "prompt-1", 7, "grok-4.5-build"),
            "grok_session:session-1:prompt-1:grok-4.5-build"
        );
        assert_eq!(
            grok_request_id("session-1", "", 7, "unknown"),
            "grok_session:session-1:idx7:unknown"
        );
    }

    #[test]
    fn partial_reported_cost_uses_local_price_when_available() {
        let local = CostBreakdown {
            total: 0.04,
            ..CostBreakdown::default()
        };
        assert_eq!(
            authoritative_grok_cost(local, 100_000_000, true).total,
            0.04
        );
        assert_eq!(
            authoritative_grok_cost(CostBreakdown::default(), 100_000_000, true).total,
            0.01
        );
    }
}
