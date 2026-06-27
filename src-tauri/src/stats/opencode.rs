//! OpenCode usage ingestion helpers.
//!
//! OpenCode stores assistant usage in a SQLite database (`opencode.db`) instead
//! of provider jsonl session logs. This module stays free of ThreadTerm's own
//! database schema so it can be tested with an in-memory OpenCode-shaped DB.

use std::path::{Path, PathBuf};

use rusqlite::params;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub struct OpenCodeUsage {
    pub input: u64,
    pub output: u64,
    pub reasoning: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost: f64,
    pub model_id: String,
    pub timestamp_ms: i64,
}

pub fn opencode_db_path() -> PathBuf {
    if let Some(raw) = std::env::var_os("OPENCODE_DB") {
        if !raw.is_empty() {
            let path = PathBuf::from(raw);
            return if path.is_absolute() {
                path
            } else {
                opencode_data_dir().join(path)
            };
        }
    }

    opencode_data_dir().join("opencode.db")
}

fn opencode_data_dir() -> PathBuf {
    if let Some(raw) = std::env::var_os("XDG_DATA_HOME") {
        if !raw.is_empty() {
            return PathBuf::from(raw).join("opencode");
        }
    }

    dirs::home_dir()
        .unwrap_or_else(|| Path::new(".").to_path_buf())
        .join(".local")
        .join("share")
        .join("opencode")
}

pub fn parse_opencode_message_data(value: &Value) -> Option<OpenCodeUsage> {
    let input = value
        .pointer("/tokens/input")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = value
        .pointer("/tokens/output")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let reasoning = value
        .pointer("/tokens/reasoning")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_read = value
        .pointer("/tokens/cache/read")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_write = value
        .pointer("/tokens/cache/write")
        .and_then(Value::as_u64)
        .unwrap_or(0);

    if input == 0 && output == 0 && reasoning == 0 && cache_read == 0 && cache_write == 0 {
        return None;
    }

    let cost = value.get("cost").and_then(Value::as_f64).unwrap_or(0.0);
    let model_id = value
        .get("modelID")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown")
        .to_string();
    let timestamp_ms = value
        .pointer("/time/created")
        .and_then(Value::as_i64)
        .unwrap_or(0);

    Some(OpenCodeUsage {
        input,
        output,
        reasoning,
        cache_read,
        cache_write,
        cost,
        model_id,
        timestamp_ms,
    })
}

pub fn query_sessions(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT s.id,
                MAX(s.time_updated, COALESCE(MAX(m.time_updated), s.time_updated)) AS watermark
         FROM session s
         LEFT JOIN message m ON m.session_id = s.id
         GROUP BY s.id
         ORDER BY watermark",
    )?;
    let sessions = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect();
    sessions
}

pub fn query_assistant_messages(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> rusqlite::Result<(Vec<(String, OpenCodeUsage)>, bool)> {
    let mut stmt = conn.prepare(
        "SELECT id, data
         FROM message
         WHERE session_id = ?1
         ORDER BY time_created",
    )?;
    let mut rows = stmt.query(params![session_id])?;
    let mut usages = Vec::new();
    let mut has_incomplete_usage = false;

    while let Some(row) = rows.next()? {
        let message_id: String = row.get(0)?;
        let data: String = row.get(1)?;
        let Ok(value) = serde_json::from_str::<Value>(&data) else {
            continue;
        };

        if value.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if value.get("tokens").is_none() {
            continue;
        }
        let completed_at = value.pointer("/time/completed");
        if completed_at.is_none() || completed_at == Some(&Value::Null) {
            has_incomplete_usage = true;
            continue;
        }

        if let Some(usage) = parse_opencode_message_data(&value) {
            usages.push((message_id, usage));
        }
    }

    Ok((usages, has_incomplete_usage))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mem_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY,
                time_updated INTEGER NOT NULL
             );
             CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
             );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn parses_completed_assistant_usage() {
        let value = json!({
            "role": "assistant",
            "cost": 0.0023113,
            "tokens": {
                "input": 3272,
                "output": 383,
                "reasoning": 419,
                "cache": { "write": 0, "read": 52480 }
            },
            "modelID": "deepseek-v4-pro",
            "time": {
                "created": 1779755333700i64,
                "completed": 1779755350639i64
            }
        });

        let usage = parse_opencode_message_data(&value).unwrap();
        assert_eq!(usage.input, 3272);
        assert_eq!(usage.output, 383);
        assert_eq!(usage.reasoning, 419);
        assert_eq!(usage.cache_read, 52480);
        assert_eq!(usage.cache_write, 0);
        assert_eq!(usage.model_id, "deepseek-v4-pro");
        assert_eq!(usage.timestamp_ms, 1779755333700);
        assert!((usage.cost - 0.0023113).abs() < f64::EPSILON);
    }

    #[test]
    fn returns_none_for_zero_token_usage() {
        let value = json!({
            "tokens": {
                "input": 0,
                "output": 0,
                "reasoning": 0,
                "cache": { "write": 0, "read": 0 }
            }
        });
        assert_eq!(parse_opencode_message_data(&value), None);
    }

    #[test]
    fn query_sessions_uses_latest_session_or_message_watermark() {
        let conn = mem_conn();
        conn.execute(
            "INSERT INTO session (id, time_updated) VALUES ('s1', 10), ('s2', 50)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data)
             VALUES ('m1', 's1', 10, 30, '{}')",
            [],
        )
        .unwrap();

        let sessions = query_sessions(&conn).unwrap();
        assert_eq!(
            sessions,
            vec![("s1".to_string(), 30), ("s2".to_string(), 50)]
        );
    }

    #[test]
    fn query_assistant_messages_skips_incomplete_usage() {
        let conn = mem_conn();
        conn.execute(
            "INSERT INTO session (id, time_updated) VALUES ('s1', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data)
             VALUES
             ('u1', 's1', 1, 1, '{\"role\":\"user\",\"tokens\":{\"input\":1}}'),
             ('a1', 's1', 2, 2, '{\"role\":\"assistant\",\"tokens\":{\"input\":1},\"time\":{\"created\":2000}}'),
             ('a2', 's1', 3, 3, '{\"role\":\"assistant\",\"cost\":0.5,\"tokens\":{\"input\":2,\"output\":3,\"reasoning\":4,\"cache\":{\"read\":5,\"write\":6}},\"modelID\":\"m\",\"time\":{\"created\":3000,\"completed\":4000}}')",
            [],
        )
        .unwrap();

        let (messages, has_incomplete) = query_assistant_messages(&conn, "s1").unwrap();
        assert!(has_incomplete);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].0, "a2");
        assert_eq!(messages[0].1.output, 3);
        assert_eq!(messages[0].1.reasoning, 4);
    }
}
