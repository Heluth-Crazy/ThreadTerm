//! JSONL parsers for Claude and Codex sessions.
//!
//! Claude: every `type:"assistant"` line is one call (dedup by `message.id`).
//! Codex: the whole session collapses to one record built from the LAST
//! `token_count` event's cumulative `total_token_usage` (summing every event
//! would double-count).

use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::stats::types::{CallRecord, UsageSummary};

/// Parse a Claude session jsonl → (project cwd, assistant calls).
pub fn parse_claude_file(path: &Path) -> (String, Vec<CallRecord>) {
    let Ok(content) = fs::read_to_string(path) else {
        return (String::new(), Vec::new());
    };
    let mut cwd = String::new();
    let mut calls = Vec::new();
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if cwd.is_empty() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                cwd = c.to_string();
            }
        }
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(msg) = v.get("message") else {
            continue;
        };
        let Some(usage) = msg.get("usage") else {
            continue;
        };
        let model = msg
            .get("model")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        let message_id = msg.get("id").and_then(|m| m.as_str()).map(str::to_string);
        let u = UsageSummary {
            input: usage.get("input_tokens").and_then(Value::as_u64).unwrap_or(0),
            output: usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
            cache_creation: usage
                .get("cache_creation_input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            cache_read: usage
                .get("cache_read_input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        };
        let timestamp_ms = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .and_then(parse_iso8601_ms);
        calls.push(CallRecord {
            model,
            message_id,
            usage: u,
            timestamp_ms,
        });
    }
    (cwd, calls)
}

/// Parse a Codex session jsonl → (session id, project cwd, one cumulative call).
pub fn parse_codex_file(path: &Path) -> Option<(String, String, CallRecord)> {
    let content = fs::read_to_string(path).ok()?;
    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut model = String::new();
    let mut last_usage: Option<UsageSummary> = None;
    let mut last_ts: Option<u64> = None;

    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let typ = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let payload = v.get("payload");
        match typ {
            "session_meta" => {
                if let Some(p) = payload {
                    if let Some(c) = p.get("cwd").and_then(|c| c.as_str()) {
                        cwd = c.to_string();
                    }
                    if let Some(id) = p.get("id").and_then(|i| i.as_str()) {
                        session_id = id.to_string();
                    }
                }
            }
            "turn_context" => {
                if let Some(m) = payload.and_then(|p| p.get("model")).and_then(|m| m.as_str()) {
                    model = m.to_string();
                }
            }
            "event_msg" => {
                let is_token_count = payload
                    .and_then(|p| p.get("type"))
                    .and_then(|t| t.as_str())
                    == Some("token_count");
                if !is_token_count {
                    continue;
                }
                if let Some(tu) = payload
                    .and_then(|p| p.get("info"))
                    .and_then(|i| i.get("total_token_usage"))
                {
                    let input = tu.get("input_tokens").and_then(Value::as_u64).unwrap_or(0);
                    let cached = tu
                        .get("cached_input_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let output = tu.get("output_tokens").and_then(Value::as_u64).unwrap_or(0);
                    // `input_tokens` includes cached; split so cached bills at the
                    // cache_read rate and isn't double-counted.
                    last_usage = Some(UsageSummary {
                        input: input.saturating_sub(cached),
                        output,
                        cache_creation: 0,
                        cache_read: cached,
                    });
                }
                if let Some(ts) = v
                    .get("timestamp")
                    .and_then(|t| t.as_str())
                    .and_then(parse_iso8601_ms)
                {
                    last_ts = Some(ts);
                }
            }
            _ => {}
        }
    }

    let usage = last_usage?;
    Some((
        session_id,
        cwd,
        CallRecord {
            model,
            message_id: None,
            usage,
            timestamp_ms: last_ts,
        },
    ))
}

/// Parse `"2026-06-18T14:38:55.726Z"` (UTC ISO8601) → epoch ms. Fixed format only.
pub fn parse_iso8601_ms(s: &str) -> Option<u64> {
    if s.len() < 19 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let min: i64 = s.get(14..16)?.parse().ok()?;
    let sec: i64 = s.get(17..19)?.parse().ok()?;
    let ms: i64 = if s.len() > 20 && s.as_bytes()[19] == b'.' {
        let frac: String = s[20..]
            .chars()
            .take_while(char::is_ascii_digit)
            .take(3)
            .collect();
        format!("{frac:0<3}").parse().unwrap_or(0)
    } else {
        0
    };
    // days_from_civil (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let total_ms = (days * 86400 + hour * 3600 + min * 60 + sec) * 1000 + ms;
    u64::try_from(total_ms).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_epoch() {
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_iso8601_ms("2021-01-01T00:00:00Z"),
            Some(1_609_459_200_000)
        );
        assert_eq!(
            parse_iso8601_ms("2021-01-01T00:00:00.500Z"),
            Some(1_609_459_200_500)
        );
    }

    #[test]
    fn claude_assistant_line_parsed() {
        let line = r#"{"type":"assistant","timestamp":"2021-01-01T00:00:00Z","message":{"id":"msg_1","model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":5,"cache_read_input_tokens":100}}}"#;
        let dir = std::env::temp_dir().join(format!("stats-parse-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sess.jsonl");
        std::fs::write(&path, line).unwrap();
        let (_, calls) = parse_claude_file(&path);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].model, "claude-opus-4-8");
        assert_eq!(calls[0].message_id.as_deref(), Some("msg_1"));
        assert_eq!(calls[0].usage.input, 10);
        assert_eq!(calls[0].usage.cache_read, 100);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
