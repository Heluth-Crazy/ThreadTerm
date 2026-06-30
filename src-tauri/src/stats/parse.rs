//! JSONL parsers for Claude and Codex sessions.
//!
//! ## Claude
//! Every `type:"assistant"` line is one billable event. A single `message.id`
//! can appear multiple times in a streamed session (the `message_start` snapshot
//! with `output=1` and the final chunk with the real `output`/`stop_reason`).
//! We dedup by `message.id` keeping the entry that has a `stop_reason`, else
//! the one with the largest `output_tokens` — this fixes the previous
//! undercount where the first-seen snapshot row won.
//!
//! ## Codex
//! Each `token_count` event carries **cumulative** `total_token_usage`. Summing
//! every event would double-count; taking only the last (the old behaviour)
//! collapses the whole session to one record and destroys per-call time/model
//! attribution. Instead we compute the **delta** between consecutive cumulative
//! readings — each non-zero delta is one independent API call. When
//! `total_token_usage` is absent we fall back to `last_token_usage` (already an
//! incremental value). `input_tokens` includes cached input, so the cached
//! portion is split off to bill at the cache_read rate and avoid double billing.
//!
//! ## Model name normalization
//! `normalize_model` strips vendor prefixes, `@pin` suffixes, and ISO / compact
//! date suffixes so `openai/gpt-5.4-2026-03-05` → `gpt-5.4`, matching the
//! canonical form the pricing table keys on.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde_json::Value;

use crate::stats::types::{CallRecord, UsageSummary};

/// Normalize a raw model name for pricing lookup.
///
/// Applied in order: lowercase → drop `@pin` → drop last `vendor/` segment →
/// drop ISO date `-YYYY-MM-DD` → drop compact date `-YYYYMMDD`.
pub fn normalize_model(raw: &str) -> String {
    let mut m = raw.trim().to_lowercase();

    if let Some(pos) = m.find('@') {
        m.truncate(pos);
    }

    if let Some(pos) = m.rfind('/') {
        m = m[pos + 1..].to_string();
    }

    if m.len() > 11 && m.is_char_boundary(m.len() - 11) {
        let s = &m[m.len() - 11..];
        let b = s.as_bytes();
        if b[0] == b'-'
            && s[1..5].chars().all(|c| c.is_ascii_digit())
            && b[5] == b'-'
            && s[6..8].chars().all(|c| c.is_ascii_digit())
            && b[8] == b'-'
            && s[9..11].chars().all(|c| c.is_ascii_digit())
        {
            m.truncate(m.len() - 11);
        }
    }

    if m.len() > 9 {
        let parts: Vec<&str> = m.rsplitn(2, '-').collect();
        if parts.len() == 2 {
            if let Some(suffix) = parts.first() {
                if suffix.len() == 8 && suffix.chars().all(|c| c.is_ascii_digit()) {
                    m = parts[1].to_string();
                }
            }
        }
    }

    m
}

/// Parsed Claude assistant usage, before message-id dedup selection.
#[derive(Debug)]
struct ClaudeAssistant {
    message_id: String,
    model: String,
    usage: UsageSummary,
    stop_reason: Option<String>,
    timestamp_ms: Option<u64>,
}

/// Parse a Claude session jsonl → (project cwd, assistant calls).
///
/// The returned calls are already deduped by `message.id` (best row kept — see
/// module docs). Zero-token placeholder rows are dropped.
pub fn parse_claude_file(path: &Path) -> (String, Vec<CallRecord>) {
    let Ok(file) = fs::File::open(path) else {
        return (String::new(), Vec::new());
    };
    let reader = BufReader::new(file);
    let mut cwd = String::new();
    let mut session_id: Option<String> = None;
    let mut by_id: HashMap<String, ClaudeAssistant> = HashMap::new();

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        if cwd.is_empty() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                cwd = c.to_string();
            }
        }
        if session_id.is_none() {
            if let Some(sid) = v.get("sessionId").and_then(|s| s.as_str()) {
                session_id = Some(sid.to_string());
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
        let Some(msg_id) = msg.get("id").and_then(|m| m.as_str()) else {
            continue;
        };

        let parsed = ClaudeAssistant {
            message_id: msg_id.to_string(),
            model: msg
                .get("model")
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .to_string(),
            usage: UsageSummary {
                input: usage
                    .get("input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                output: usage
                    .get("output_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                cache_creation: usage
                    .get("cache_creation_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                cache_read: usage
                    .get("cache_read_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            },
            stop_reason: msg
                .get("stop_reason")
                .and_then(|s| s.as_str())
                .map(str::to_string),
            timestamp_ms: v
                .get("timestamp")
                .and_then(|t| t.as_str())
                .and_then(parse_iso8601_ms),
        };

        // Keep the best row for this message.id: prefer one with a stop_reason,
        // otherwise the one with the largest output_tokens. The streaming
        // `message_start` snapshot (output=1, no stop_reason) loses to the final
        // chunk; two final chunks keep the larger output.
        let should_replace = match by_id.get(&parsed.message_id) {
            None => true,
            Some(existing) => {
                if parsed.stop_reason.is_some() && existing.stop_reason.is_none() {
                    true
                } else if parsed.stop_reason.is_some() == existing.stop_reason.is_some() {
                    parsed.usage.output > existing.usage.output
                } else {
                    false
                }
            }
        };
        if should_replace {
            by_id.insert(parsed.message_id.clone(), parsed);
        }
    }

    let mut calls = Vec::with_capacity(by_id.len());
    for a in by_id.into_values() {
        if a.usage.is_empty() {
            continue;
        }
        calls.push(CallRecord {
            model: a.model,
            message_id: Some(a.message_id),
            usage: a.usage,
            timestamp_ms: a.timestamp_ms,
            stop_reason: a.stop_reason,
            session_id: session_id.clone(),
        });
    }
    (cwd, calls)
}

/// Cumulative token snapshot tracked across a Codex session to compute deltas.
#[derive(Debug, Clone, Default)]
struct CumulativeTokens {
    input: u64,
    cached_input: u64,
    output: u64,
}

/// One Codex API call = the delta between two cumulative readings.
#[derive(Debug, Clone)]
struct DeltaTokens {
    input: u64,
    cached_input: u64,
    output: u64,
}

impl DeltaTokens {
    fn is_zero(&self) -> bool {
        self.input == 0 && self.cached_input == 0 && self.output == 0
    }
}

/// State carried while scanning a single Codex jsonl file.
struct CodexFileState {
    session_id: Option<String>,
    cwd: String,
    model: String,
    prev_total: Option<CumulativeTokens>,
    event_index: u32,
}

/// Parse a Codex session jsonl → (session id, project cwd, per-call deltas).
///
/// Each non-zero delta becomes one `CallRecord`. `message_id` is `None` (Codex
/// has no per-message id); dedup is by the `session_id:event_index` composite
/// key at insert time, not here.
pub fn parse_codex_file(path: &Path) -> Option<(String, String, Vec<CallRecord>)> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut state = CodexFileState {
        session_id: None,
        cwd: String::new(),
        model: String::new(),
        prev_total: None,
        event_index: 0,
    };
    let mut calls = Vec::new();

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }

        // Cheap pre-filter before JSON decode: only lines that could carry
        // session_meta / turn_context / token_count matter.
        let has_event_msg = line.contains("\"event_msg\"");
        let has_turn_context = line.contains("\"turn_context\"");
        let has_session_meta = line.contains("\"session_meta\"");
        if !has_event_msg && !has_turn_context && !has_session_meta {
            continue;
        }
        if has_event_msg && !line.contains("\"token_count\"") {
            continue;
        }

        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let typ = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let payload = v.get("payload");
        match typ {
            "session_meta" => {
                if let Some(p) = payload {
                    if let Some(c) = p.get("cwd").and_then(|c| c.as_str()) {
                        state.cwd = c.to_string();
                    }
                    if let Some(id) = p
                        .get("id")
                        .or_else(|| p.get("session_id"))
                        .or_else(|| p.get("sessionId"))
                        .and_then(|i| i.as_str())
                    {
                        state.session_id = Some(id.to_string());
                    }
                }
            }
            "turn_context" => {
                if let Some(m) = payload
                    .and_then(|p| {
                        p.get("model")
                            .or_else(|| p.get("info").and_then(|i| i.get("model")))
                    })
                    .and_then(|m| m.as_str())
                {
                    state.model = normalize_model(m);
                }
            }
            "event_msg" => {
                let Some(p) = payload else { continue };
                if p.get("type").and_then(|t| t.as_str()) != Some("token_count") {
                    continue;
                }
                let Some(info) = p.get("info") else { continue };
                if info.is_null() {
                    continue;
                }

                // token_count may also carry the model for this turn.
                if let Some(m) = info
                    .get("model")
                    .or_else(|| info.get("model_name"))
                    .or_else(|| p.get("model"))
                    .and_then(|m| m.as_str())
                {
                    state.model = normalize_model(m);
                }

                // Prefer cumulative `total_token_usage`; fall back to
                // `last_token_usage` which is already an incremental value.
                let (cumulative, is_total) = if let Some(total) = info.get("total_token_usage") {
                    (parse_cumulative(total), true)
                } else if let Some(last) = info.get("last_token_usage") {
                    (parse_cumulative(last), false)
                } else {
                    continue;
                };
                let Some(cur) = cumulative else { continue };

                let delta = if is_total {
                    let d = compute_delta(&state.prev_total, &cur);
                    state.prev_total = Some(cur);
                    d
                } else {
                    DeltaTokens {
                        input: cur.input,
                        cached_input: cur.cached_input,
                        output: cur.output,
                    }
                };

                // Clamp cached to input (defensive against malformed logs).
                let delta = DeltaTokens {
                    cached_input: delta.cached_input.min(delta.input),
                    ..delta
                };

                if delta.is_zero() {
                    continue; // task-boundary zero-delta events
                }

                state.event_index += 1;
                let timestamp_ms = v
                    .get("timestamp")
                    .and_then(|t| t.as_str())
                    .and_then(parse_iso8601_ms);

                // `input_tokens` already includes cached; split so cached bills
                // at the cache_read rate and isn't double-counted.
                calls.push(CallRecord {
                    model: state.model.clone(),
                    message_id: None,
                    usage: UsageSummary {
                        input: delta.input.saturating_sub(delta.cached_input),
                        output: delta.output,
                        cache_creation: 0,
                        cache_read: delta.cached_input,
                    },
                    timestamp_ms,
                    stop_reason: None,
                    session_id: state.session_id.clone(),
                });
            }
            _ => {}
        }
    }

    if calls.is_empty() {
        return None;
    }
    Some((state.session_id.unwrap_or_default(), state.cwd, calls))
}

/// Extract cumulative token fields, tolerating `cached_input_tokens` vs
/// `cache_read_input_tokens` naming across Codex versions.
fn parse_cumulative(v: &Value) -> Option<CumulativeTokens> {
    if v.is_null() || !v.is_object() {
        return None;
    }
    Some(CumulativeTokens {
        input: v.get("input_tokens").and_then(Value::as_u64).unwrap_or(0),
        cached_input: v
            .get("cached_input_tokens")
            .or_else(|| v.get("cache_read_input_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output: v.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// Delta between two cumulative readings. First reading (prev=None) is taken
/// verbatim. Saturating subtract guards against log anomalies.
fn compute_delta(prev: &Option<CumulativeTokens>, cur: &CumulativeTokens) -> DeltaTokens {
    match prev {
        None => DeltaTokens {
            input: cur.input,
            cached_input: cur.cached_input,
            output: cur.output,
        },
        Some(p) => DeltaTokens {
            input: cur.input.saturating_sub(p.input),
            cached_input: cur.cached_input.saturating_sub(p.cached_input),
            output: cur.output.saturating_sub(p.output),
        },
    }
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

    fn write_temp_jsonl(name: &str, content: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("stats-parse-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

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

    // ── model normalization ──

    #[test]
    fn normalize_strips_vendor_and_pin() {
        assert_eq!(
            normalize_model("anthropic/claude-opus-4-8@20260101"),
            "claude-opus-4-8"
        );
        assert_eq!(normalize_model("Claude-Sonnet-4-5"), "claude-sonnet-4-5");
        assert_eq!(normalize_model("openai/gpt-5.4"), "gpt-5.4");
    }

    #[test]
    fn normalize_strips_iso_date() {
        assert_eq!(normalize_model("gpt-5.4-2026-03-05"), "gpt-5.4");
        assert_eq!(normalize_model("openai/gpt-5.4-2026-03-05"), "gpt-5.4");
    }

    #[test]
    fn normalize_strips_compact_date() {
        assert_eq!(normalize_model("gpt-5.4-20260305"), "gpt-5.4");
        assert_eq!(
            normalize_model("claude-opus-4-6-20260206"),
            "claude-opus-4-6"
        );
    }

    // ── Claude parsing + dedup ──

    #[test]
    fn claude_assistant_line_parsed() {
        let line = r#"{"type":"assistant","timestamp":"2021-01-01T00:00:00Z","sessionId":"s1","cwd":"/proj","message":{"id":"msg_1","model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":5,"cache_read_input_tokens":100}}}"#;
        let path = write_temp_jsonl("claude_basic.jsonl", line);
        let (cwd, calls) = parse_claude_file(&path);
        assert_eq!(cwd, "/proj");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].model, "claude-opus-4-8");
        assert_eq!(calls[0].message_id.as_deref(), Some("msg_1"));
        assert_eq!(calls[0].usage.input, 10);
        assert_eq!(calls[0].usage.cache_read, 100);
        assert_eq!(calls[0].session_id.as_deref(), Some("s1"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn claude_dedup_prefers_stop_reason_over_snapshot() {
        // Same message.id: first a message_start snapshot (output=1, no
        // stop_reason), then the final chunk (output=1349, end_turn). The final
        // chunk must win — previously the snapshot was kept and output was
        // undercounted by ~99%.
        let snapshot = r#"{"type":"assistant","timestamp":"2021-01-01T00:00:00Z","message":{"id":"msg_x","model":"claude-opus-4-8","usage":{"input_tokens":3,"output_tokens":1,"cache_read_input_tokens":5000,"cache_creation_input_tokens":0}}}"#;
        let final_chunk = r#"{"type":"assistant","timestamp":"2021-01-01T00:00:01Z","message":{"id":"msg_x","model":"claude-opus-4-8","usage":{"input_tokens":3,"output_tokens":1349,"cache_read_input_tokens":5000,"cache_creation_input_tokens":0},"stop_reason":"end_turn"}}"#;
        let path = write_temp_jsonl("claude_stream.jsonl", &format!("{snapshot}\n{final_chunk}"));
        let (_, calls) = parse_claude_file(&path);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].usage.output, 1349, "final chunk output must win");
        assert_eq!(calls[0].stop_reason.as_deref(), Some("end_turn"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn claude_drops_zero_token_placeholder() {
        let line = r#"{"type":"assistant","message":{"id":"msg_z","model":"claude-opus-4-8","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#;
        let path = write_temp_jsonl("claude_zero.jsonl", line);
        let (_, calls) = parse_claude_file(&path);
        assert!(calls.is_empty(), "all-zero placeholder must be dropped");
        let _ = std::fs::remove_file(&path);
    }

    // ── Codex delta parsing ──

    #[test]
    fn codex_delta_first_event_is_verbatim() {
        // First token_count with cumulative usage → delta = the full reading.
        let jsonl = r#"{"type":"session_meta","payload":{"id":"sess-1","cwd":"/repo"}}
{"type":"turn_context","payload":{"model":"gpt-5.4"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":17934,"cached_input_tokens":9600,"output_tokens":454}}},"timestamp":"2021-01-01T00:00:00Z"}"#;
        let path = write_temp_jsonl("codex_first.jsonl", jsonl);
        let (sid, cwd, calls) = parse_codex_file(&path).unwrap();
        assert_eq!(sid, "sess-1");
        assert_eq!(cwd, "/repo");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].model, "gpt-5.4");
        // input excludes cached; cached goes to cache_read.
        assert_eq!(calls[0].usage.input, 17934 - 9600);
        assert_eq!(calls[0].usage.cache_read, 9600);
        assert_eq!(calls[0].usage.output, 454);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn codex_delta_subsequent_event_is_difference() {
        // Two token_count events: second delta = second cumulative − first.
        let jsonl = r#"{"type":"turn_context","payload":{"model":"gpt-5.4"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":17934,"cached_input_tokens":9600,"output_tokens":454}}},"timestamp":"2021-01-01T00:00:00Z"}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":36722,"cached_input_tokens":27904,"output_tokens":804}}},"timestamp":"2021-01-01T00:00:01Z"}"#;
        let path = write_temp_jsonl("codex_delta.jsonl", jsonl);
        let (_, _, calls) = parse_codex_file(&path).unwrap();
        assert_eq!(calls.len(), 2, "two events → two calls");
        // First call: verbatim.
        assert_eq!(calls[0].usage.input, 17934 - 9600);
        assert_eq!(calls[0].usage.cache_read, 9600);
        assert_eq!(calls[0].usage.output, 454);
        // Second call: delta.
        let d_input = 36722 - 17934;
        let d_cached = 27904 - 9600;
        let d_output = 804 - 454;
        assert_eq!(calls[1].usage.input, d_input - d_cached);
        assert_eq!(calls[1].usage.cache_read, d_cached);
        assert_eq!(calls[1].usage.output, d_output);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn codex_skips_zero_delta_at_task_boundary() {
        // The first cumulative reading is the baseline (taken verbatim → one
        // call). A second *identical* reading is a zero delta and must be
        // dropped, so exactly one call survives — not two.
        let jsonl = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":58346,"cached_input_tokens":46976,"output_tokens":1045}}}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":58346,"cached_input_tokens":46976,"output_tokens":1045}}}}"#;
        let path = write_temp_jsonl("codex_zero_delta.jsonl", jsonl);
        let (_, _, calls) = parse_codex_file(&path).expect("baseline reading is one call");
        assert_eq!(
            calls.len(),
            1,
            "zero-delta second event dropped, baseline kept"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn codex_falls_back_to_last_token_usage() {
        // No total_token_usage; last_token_usage is already incremental.
        let jsonl = r#"{"type":"turn_context","payload":{"model":"o3"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000,"cached_input_tokens":200,"output_tokens":50}}},"timestamp":"2021-01-01T00:00:00Z"}"#;
        let path = write_temp_jsonl("codex_last.jsonl", jsonl);
        let (_, _, calls) = parse_codex_file(&path).unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].model, "o3");
        assert_eq!(calls[0].usage.input, 800);
        assert_eq!(calls[0].usage.cache_read, 200);
        assert_eq!(calls[0].usage.output, 50);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn codex_model_change_at_turn_boundary() {
        // Model switches mid-session; each call keeps its own model.
        let jsonl = r#"{"type":"turn_context","payload":{"model":"gpt-5.4"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}},"timestamp":"2021-01-01T00:00:00Z"}
{"type":"turn_context","payload":{"model":"o3"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":200,"cached_input_tokens":0,"output_tokens":25}}},"timestamp":"2021-01-01T00:00:01Z"}"#;
        let path = write_temp_jsonl("codex_model_switch.jsonl", jsonl);
        let (_, _, calls) = parse_codex_file(&path).unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].model, "gpt-5.4");
        assert_eq!(calls[1].model, "o3");
        let _ = std::fs::remove_file(&path);
    }
}
