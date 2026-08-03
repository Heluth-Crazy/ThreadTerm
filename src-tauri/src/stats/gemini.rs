//! Gemini CLI session-log ingestion.
//!
//! Gemini stores one JSON document per session under
//! `~/.gemini/tmp/<project>/chats/session-*.json`. Message token counters are
//! independent per turn. Gemini's `input` includes cached input, while
//! ThreadTerm persists fresh input and cache reads separately, so the split is
//! normalized exactly once here.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::Value;

use crate::db::get_db;
use crate::stats::pricing;
use crate::stats::sync::{
    get_sync_state, mtime_nanos, now_secs, update_sync_state, upsert_session_record,
    SessionUsageUpsert, SyncResult,
};
use crate::stats::types::UsageSummary;

#[derive(Clone, Debug)]
struct GeminiUsageRecord {
    request_id: String,
    session_id: String,
    model: String,
    usage: UsageSummary,
    project_path: String,
    created_at: i64,
}

pub(crate) fn sync_gemini() -> SyncResult {
    let files = collect_gemini_session_files();
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
        sync_gemini_file(&conn, &path, &mut result);
    }
    result
}

fn collect_gemini_session_files() -> Vec<PathBuf> {
    let Some(tmp_root) = dirs::home_dir().map(|home| home.join(".gemini").join("tmp")) else {
        return Vec::new();
    };
    let Ok(projects) = fs::read_dir(tmp_root) else {
        return Vec::new();
    };

    let mut files = Vec::new();
    for project in projects.flatten() {
        let chats = project.path().join("chats");
        let Ok(entries) = fs::read_dir(chats) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_session = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("session-") && name.ends_with(".json"));
            if is_session {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

fn sync_gemini_file(conn: &Connection, path: &Path, result: &mut SyncResult) {
    let file_path = path.to_string_lossy().to_string();
    let modified = mtime_nanos(path);
    let (last_modified, _) = get_sync_state(conn, &file_path);
    if modified <= last_modified {
        return;
    }

    let value = match fs::read_to_string(path)
        .map_err(|error| error.to_string())
        .and_then(|content| serde_json::from_str::<Value>(&content).map_err(|e| e.to_string()))
    {
        Ok(value) => value,
        Err(error) => {
            result.errors.push(format!(
                "Gemini session parse failed {}: {error}",
                path.display()
            ));
            return;
        }
    };

    let fallback_session_id = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("unknown");
    let project_path = gemini_project_path(path).unwrap_or_default();
    let file_mtime_secs = (modified / 1_000_000_000).max(0);
    let fallback_created_at = if file_mtime_secs > 0 {
        file_mtime_secs
    } else {
        now_secs()
    };
    let records = parse_gemini_session(
        &value,
        fallback_session_id,
        &project_path,
        fallback_created_at,
    );

    for record in &records {
        let cost = pricing::cost_breakdown(&record.model, &record.usage);
        if upsert_session_record(
            conn,
            SessionUsageUpsert {
                request_id: &record.request_id,
                provider: "gemini",
                model: &record.model,
                usage: &record.usage,
                cost,
                session_id: &record.session_id,
                project_path: &record.project_path,
                created_at: record.created_at,
                data_source: "gemini_session",
            },
        ) {
            result.imported = result.imported.saturating_add(1);
        } else {
            result.skipped = result.skipped.saturating_add(1);
        }
    }

    update_sync_state(conn, &file_path, modified, records.len() as i64);
}

fn gemini_project_path(session_path: &Path) -> Option<String> {
    let project_dir = session_path.parent()?.parent()?;
    crate::agent_sessions::gemini::read_project_cwd(project_dir)
}

fn parse_gemini_session(
    value: &Value,
    fallback_session_id: &str,
    project_path: &str,
    fallback_created_at: i64,
) -> Vec<GeminiUsageRecord> {
    let session_id = value
        .get("sessionId")
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(fallback_session_id)
        .to_string();
    let Some(messages) = value
        .get("messages")
        .or_else(|| value.get("history"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };

    messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            let is_model_message = [message.get("type"), message.get("role")]
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(|role| {
                    role.eq_ignore_ascii_case("gemini") || role.eq_ignore_ascii_case("model")
                });
            if !is_model_message {
                return None;
            }
            let tokens = message.get("tokens")?.as_object()?;
            let raw_input = token_value(tokens.get("input"));
            let raw_output = token_value(tokens.get("output"));
            let thoughts = token_value(tokens.get("thoughts"));
            let raw_cached = token_value(tokens.get("cached"));
            if raw_input == 0 && raw_output == 0 && thoughts == 0 && raw_cached == 0 {
                return None;
            }

            // Gemini reports total input (fresh + cached). ThreadTerm stores
            // fresh input, so clamp malformed cached values and split once.
            let cache_read = raw_cached.min(raw_input);
            let usage = UsageSummary {
                input: raw_input.saturating_sub(cache_read),
                output: raw_output.saturating_add(thoughts),
                cache_creation: 0,
                cache_read,
            };
            let model = message
                .get("model")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .unwrap_or("unknown")
                .to_string();
            let turn_key = message
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("idx{index}"));
            let created_at =
                crate::agent_sessions::types::read_timestamp_ms(message.get("timestamp"))
                    .map(|timestamp| (timestamp / 1000) as i64)
                    .unwrap_or(fallback_created_at);

            Some(GeminiUsageRecord {
                request_id: format!("gemini_session:{session_id}:{turn_key}"),
                session_id: session_id.clone(),
                model,
                usage,
                project_path: project_path.to_string(),
                created_at,
            })
        })
        .collect()
}

fn token_value(value: Option<&Value>) -> u64 {
    value
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|raw| raw.parse().ok()))
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_message_tokens_with_cache_and_thought_normalization() {
        let value = json!({
            "sessionId": "gem-session",
            "messages": [
                {"type": "user", "tokens": {"input": 999}},
                {
                    "type": "gemini",
                    "id": "turn-1",
                    "model": "gemini-2.5-pro",
                    "timestamp": "2021-01-01T00:00:00Z",
                    "tokens": {"input": 8522, "output": 29, "cached": 3138, "thoughts": 405}
                }
            ]
        });

        let records = parse_gemini_session(&value, "fallback", "/repo", 7);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].request_id, "gemini_session:gem-session:turn-1");
        assert_eq!(records[0].usage.input, 5384);
        assert_eq!(records[0].usage.output, 434);
        assert_eq!(records[0].usage.cache_read, 3138);
        assert_eq!(records[0].usage.total(), 8956);
        assert_eq!(records[0].created_at, 1_609_459_200);
    }

    #[test]
    fn supports_model_role_and_stable_index_fallback() {
        let value = json!({
            "messages": [{
                "type": "assistant",
                "role": "model",
                "tokens": {"input": 12, "output": 3, "cached": 2}
            }]
        });
        let records = parse_gemini_session(&value, "session-file", "", 42);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].request_id, "gemini_session:session-file:idx0");
        assert_eq!(records[0].usage.input, 10);
        assert_eq!(records[0].usage.cache_read, 2);
        assert_eq!(records[0].created_at, 42);
    }

    #[test]
    fn skips_empty_and_non_model_messages() {
        let value = json!({
            "messages": [
                {"type": "user", "tokens": {"input": 3}},
                {"type": "gemini", "tokens": {"input": 0, "output": 0, "cached": 0, "thoughts": 0}}
            ]
        });
        assert!(parse_gemini_session(&value, "s", "", 1).is_empty());
    }
}
