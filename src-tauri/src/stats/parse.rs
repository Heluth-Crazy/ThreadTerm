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
//! Codex emits a cumulative `total_token_usage` snapshot and, on newer
//! versions, an exact per-turn `last_token_usage` value. We prefer the exact
//! per-turn value when present and use cumulative deltas only as a compatibility
//! fallback. Summing cumulative snapshots would double-count; each non-zero
//! delta is one independent API call. `input_tokens` includes cached input, so
//! the cached portion is split off to bill at the cache_read rate.
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
#[derive(Debug, Clone, Default, PartialEq, Eq)]
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct TokenCountersSignature {
    input: Option<u64>,
    cached_input: Option<u64>,
    output: Option<u64>,
    reasoning_output: Option<u64>,
    total: Option<u64>,
}

/// Raw token-count shape used to align a fork/subagent rollout with the
/// parent history it replayed before starting its own work.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexTokenUsageSignature {
    total: Option<TokenCountersSignature>,
    last: Option<TokenCountersSignature>,
}

#[derive(Clone, Debug)]
pub(crate) struct CodexTokenEvent {
    pub signature: CodexTokenUsageSignature,
    pub call: Option<CallRecord>,
    pub event_index: Option<u32>,
    pub timestamp_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CodexParentResolution {
    None,
    Parent(String),
    Deferred(String),
}

#[derive(Clone, Debug)]
pub(crate) struct ParsedCodexRollout {
    pub root_thread_id: Option<String>,
    pub root_meta_seen: bool,
    pub root_timestamp_ms: Option<u64>,
    pub max_timestamp_ms: Option<u64>,
    pub parent: CodexParentResolution,
    pub cwd: String,
    pub token_events: Vec<CodexTokenEvent>,
}

/// Parse a Codex session jsonl → (session id, project cwd, per-call deltas).
///
/// Each non-zero delta becomes one `CallRecord`. `message_id` is `None` (Codex
/// has no per-message id); dedup is by the `session_id:event_index` composite
/// key at insert time, not here.
#[cfg(test)]
pub fn parse_codex_file(path: &Path) -> Option<(String, String, Vec<CallRecord>)> {
    let parsed = parse_codex_rollout(path)?;
    let calls = parsed
        .token_events
        .into_iter()
        .filter_map(|event| event.call)
        .collect::<Vec<_>>();
    if calls.is_empty() {
        return None;
    }
    Some((parsed.root_thread_id.unwrap_or_default(), parsed.cwd, calls))
}

/// Parse one Codex rollout while retaining the raw token signatures and
/// explicit parent metadata needed by the sync layer to remove replayed
/// parent history safely.
pub(crate) fn parse_codex_rollout(path: &Path) -> Option<ParsedCodexRollout> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let filename_thread_id = codex_thread_id_from_filename(path);
    let mut root_thread_id = filename_thread_id.clone();
    let mut root_meta_seen = false;
    let mut root_timestamp_ms = None;
    let mut max_timestamp_ms = None;
    let mut parent = CodexParentResolution::None;
    let mut cwd = String::new();
    let mut model = "unknown".to_string();
    let mut total_high_water = None;
    let mut last_signature_by_source: HashMap<Option<String>, CodexTokenUsageSignature> =
        HashMap::new();
    let mut previous_token_signature = None;
    let mut event_index = 0u32;
    let mut token_events = Vec::new();

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
        let line_timestamp_ms = v
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso8601_ms);
        if let Some(timestamp) = line_timestamp_ms {
            max_timestamp_ms =
                Some(max_timestamp_ms.map_or(timestamp, |current: u64| current.max(timestamp)));
        }
        let typ = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let payload = v.get("payload");
        match typ {
            "session_meta" if !root_meta_seen => {
                root_meta_seen = true;
                root_timestamp_ms = line_timestamp_ms;
                if let Some(p) = payload {
                    if let Some(c) = p.get("cwd").and_then(|c| c.as_str()) {
                        cwd = c.to_string();
                    }
                    let meta_id = p
                        .get("id")
                        .or_else(|| p.get("thread_id"))
                        .or_else(|| p.get("threadId"))
                        .or_else(|| p.get("session_id"))
                        .or_else(|| p.get("sessionId"))
                        .and_then(|i| i.as_str())
                        .map(str::to_string);
                    if root_thread_id.is_none() {
                        root_thread_id = meta_id.clone();
                    } else if let (Some(filename_id), Some(meta_id)) =
                        (filename_thread_id.as_deref(), meta_id.as_deref())
                    {
                        let normalized_meta_id =
                            canonical_thread_id(meta_id).unwrap_or_else(|| meta_id.to_string());
                        if filename_id != normalized_meta_id {
                            parent = CodexParentResolution::Deferred(format!(
                                "rollout filename thread id {filename_id} conflicts with session_meta id {meta_id}"
                            ));
                        }
                    }

                    if !matches!(parent, CodexParentResolution::Deferred(_)) {
                        parent = explicit_parent_from_meta(p);
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
                    model = normalize_model(m);
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
                    model = normalize_model(m);
                }

                let Some(signature) = parse_token_signature(info) else {
                    continue;
                };

                // `last_token_usage` is authoritative in current Codex
                // rollouts. Older logs only expose cumulative
                // `total_token_usage`, so retain the high-water fallback.
                let total_snapshot = info.get("total_token_usage").and_then(parse_cumulative);
                let last_snapshot = info.get("last_token_usage").and_then(parse_cumulative);
                if total_snapshot.is_none() && last_snapshot.is_none() {
                    continue;
                }

                // Match cc-switch's source-aware duplicate handling. A rate
                // limit refresh may repeat a cumulative snapshot under a new
                // source, while an exact last-token snapshot remains a new
                // request even when the cumulative total did not move.
                let snapshot_source = token_snapshot_source(payload);
                let has_total_snapshot = total_snapshot.is_some();
                let duplicate_snapshot = has_total_snapshot
                    && (last_signature_by_source.get(&snapshot_source) == Some(&signature)
                        || previous_token_signature.as_ref() == Some(&signature));
                if has_total_snapshot {
                    last_signature_by_source.insert(snapshot_source, signature.clone());
                }
                previous_token_signature = Some(signature.clone());

                let delta = if duplicate_snapshot {
                    DeltaTokens {
                        input: 0,
                        cached_input: 0,
                        output: 0,
                    }
                } else if let Some(last) = last_snapshot {
                    // `last_token_usage` is already the exact usage of this
                    // request; never difference it against a prior request.
                    DeltaTokens {
                        input: last.input,
                        cached_input: last.cached_input,
                        output: last.output,
                    }
                } else if let Some(total) = total_snapshot.as_ref() {
                    compute_delta(&total_high_water, total)
                } else {
                    continue;
                };

                if let Some(total) = total_snapshot.as_ref() {
                    update_high_water(&mut total_high_water, total);
                }

                // Clamp cached to input (defensive against malformed logs).
                let delta = DeltaTokens {
                    cached_input: delta.cached_input.min(delta.input),
                    ..delta
                };

                let timestamp_ms = line_timestamp_ms;
                let (call, nonzero_index) = if delta.is_zero() {
                    (None, None)
                } else {
                    event_index = event_index.saturating_add(1);
                    // `input_tokens` already includes cached; split so cached
                    // bills at the cache_read rate and isn't double-counted.
                    (
                        Some(CallRecord {
                            model: model.clone(),
                            message_id: None,
                            usage: UsageSummary {
                                input: delta.input.saturating_sub(delta.cached_input),
                                output: delta.output,
                                cache_creation: 0,
                                cache_read: delta.cached_input,
                            },
                            timestamp_ms,
                            stop_reason: None,
                            session_id: None,
                        }),
                        Some(event_index),
                    )
                };
                token_events.push(CodexTokenEvent {
                    signature,
                    call,
                    event_index: nonzero_index,
                    timestamp_ms,
                });
            }
            _ => {}
        }
    }

    for event in &mut token_events {
        if let Some(call) = &mut event.call {
            call.session_id = root_thread_id.clone();
        }
    }

    Some(ParsedCodexRollout {
        root_thread_id,
        root_meta_seen,
        root_timestamp_ms,
        max_timestamp_ms,
        parent,
        cwd,
        token_events,
    })
}

pub(crate) fn codex_thread_id_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let candidate = stem.get(stem.len().checked_sub(36)?..)?;
    canonical_thread_id(candidate)
}

fn canonical_thread_id(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    if bytes.len() != 36 || [8, 13, 18, 23].iter().any(|&index| bytes[index] != b'-') {
        return None;
    }
    if bytes
        .iter()
        .enumerate()
        .any(|(index, byte)| !matches!(index, 8 | 13 | 18 | 23) && !byte.is_ascii_hexdigit())
    {
        return None;
    }
    Some(value.to_ascii_lowercase())
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn explicit_parent_from_meta(payload: &Value) -> CodexParentResolution {
    let forked_from = non_empty_string(payload.get("forked_from_id"));
    let spawned_from = payload
        .get("source")
        .and_then(|source| source.get("subagent"))
        .and_then(|subagent| subagent.get("thread_spawn"))
        .and_then(|spawn| non_empty_string(spawn.get("parent_thread_id")));
    let legacy_parent = non_empty_string(
        payload
            .get("parent_thread_id")
            .or_else(|| payload.get("parentThreadId")),
    );

    let mut candidates = [forked_from, spawned_from, legacy_parent]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.dedup();
    match candidates.as_slice() {
        [] => CodexParentResolution::None,
        [parent] => match canonical_thread_id(parent) {
            Some(parent) => CodexParentResolution::Parent(parent),
            None => CodexParentResolution::Deferred(format!(
                "parent thread id is not a valid UUID: {parent}"
            )),
        },
        parents => CodexParentResolution::Deferred(format!(
            "conflicting parent thread ids: {}",
            parents.join(", ")
        )),
    }
}

fn parse_signature_counters(value: Option<&Value>) -> Option<TokenCountersSignature> {
    let value = value?.as_object()?;
    Some(TokenCountersSignature {
        input: value.get("input_tokens").and_then(Value::as_u64),
        cached_input: value
            .get("cached_input_tokens")
            .or_else(|| value.get("cache_read_input_tokens"))
            .and_then(Value::as_u64),
        output: value.get("output_tokens").and_then(Value::as_u64),
        reasoning_output: value.get("reasoning_output_tokens").and_then(Value::as_u64),
        total: value.get("total_tokens").and_then(Value::as_u64),
    })
}

fn parse_token_signature(info: &Value) -> Option<CodexTokenUsageSignature> {
    let total = parse_signature_counters(info.get("total_token_usage"));
    let last = parse_signature_counters(info.get("last_token_usage"));
    (total.is_some() || last.is_some()).then_some(CodexTokenUsageSignature { total, last })
}

/// Extract cumulative token fields, tolerating `cached_input_tokens` vs
/// `cache_read_input_tokens` naming across Codex versions.
fn parse_cumulative(v: &Value) -> Option<CumulativeTokens> {
    let fields = v.as_object()?;
    if ![
        "input_tokens",
        "cached_input_tokens",
        "cache_read_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
        "total_tokens",
    ]
    .iter()
    .any(|field| fields.contains_key(*field))
    {
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

fn token_snapshot_source(payload: Option<&Value>) -> Option<String> {
    payload
        .and_then(|payload| payload.get("rate_limits"))
        .and_then(|limits| limits.get("limit_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn update_high_water(high_water: &mut Option<CumulativeTokens>, current: &CumulativeTokens) {
    if let Some(high_water) = high_water.as_mut() {
        high_water.input = high_water.input.max(current.input);
        high_water.cached_input = high_water.cached_input.max(current.cached_input);
        high_water.output = high_water.output.max(current.output);
    } else {
        *high_water = Some(current.clone());
    }
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
    fn codex_legacy_session_without_model_still_counts_nonzero_deltas() {
        let jsonl = r#"{"type":"session_meta","payload":{"id":"legacy-session","cwd":"/repo"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":600,"output_tokens":10},"last_token_usage":{"input_tokens":1000,"cached_input_tokens":600,"output_tokens":10}}},"timestamp":"2021-01-01T00:00:00Z"}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":600,"output_tokens":10},"last_token_usage":{"input_tokens":1000,"cached_input_tokens":600,"output_tokens":10}}},"timestamp":"2021-01-01T00:00:00Z"}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1300,"cached_input_tokens":700,"output_tokens":25},"last_token_usage":{"input_tokens":300,"cached_input_tokens":100,"output_tokens":15}}},"timestamp":"2021-01-01T00:00:01Z"}"#;
        let path = write_temp_jsonl("codex_legacy_no_model.jsonl", jsonl);
        let (sid, cwd, calls) = parse_codex_file(&path).unwrap();
        assert_eq!(sid, "legacy-session");
        assert_eq!(cwd, "/repo");
        assert_eq!(
            calls.len(),
            2,
            "duplicate cumulative snapshot must not count twice"
        );
        assert_eq!(calls[0].model, "unknown");
        assert_eq!(calls[0].usage.input, 400);
        assert_eq!(calls[0].usage.cache_read, 600);
        assert_eq!(calls[0].usage.output, 10);
        assert_eq!(calls[1].model, "unknown");
        assert_eq!(calls[1].usage.input, 200);
        assert_eq!(calls[1].usage.cache_read, 100);
        assert_eq!(calls[1].usage.output, 15);
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
    fn codex_exact_last_usage_survives_unchanged_cumulative_total() {
        let jsonl = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10},"last_token_usage":{"input_tokens":40,"cached_input_tokens":0,"output_tokens":10}}},"timestamp":"2021-01-01T00:00:00Z"}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10},"last_token_usage":{"input_tokens":50,"cached_input_tokens":0,"output_tokens":20}}},"timestamp":"2021-01-01T00:00:01Z"}"#;
        let path = write_temp_jsonl("codex_last_same_total.jsonl", jsonl);
        let (_, _, calls) = parse_codex_file(&path).expect("exact last usage");
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].usage.input, 40);
        assert_eq!(calls[0].usage.output, 10);
        assert_eq!(calls[1].usage.input, 50);
        assert_eq!(calls[1].usage.output, 20);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn codex_empty_last_usage_falls_back_to_cumulative_total() {
        let jsonl = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10},"last_token_usage":{}}},"timestamp":"2021-01-01T00:00:00Z"}"#;
        let path = write_temp_jsonl("codex_empty_last.jsonl", jsonl);
        let (_, _, calls) = parse_codex_file(&path).expect("cumulative fallback");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].usage.input, 80);
        assert_eq!(calls[0].usage.cache_read, 20);
        assert_eq!(calls[0].usage.output, 10);
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

    #[test]
    fn codex_rollout_uses_only_the_first_root_session_meta() {
        let jsonl = r#"{"type":"session_meta","timestamp":"2021-01-01T00:00:00Z","payload":{"id":"root-session","cwd":"/root"}}
{"type":"session_meta","timestamp":"2021-01-01T00:00:01Z","payload":{"id":"copied-session","cwd":"/copied","forked_from_id":"not-a-uuid"}}
{"type":"event_msg","timestamp":"2021-01-01T00:00:02Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":1}}}}"#;
        let path = write_temp_jsonl("codex_first_meta.jsonl", jsonl);
        let parsed = parse_codex_rollout(&path).expect("rollout");
        assert_eq!(parsed.root_thread_id.as_deref(), Some("root-session"));
        assert_eq!(parsed.cwd, "/root");
        assert_eq!(parsed.parent, CodexParentResolution::None);
        assert_eq!(parsed.root_timestamp_ms, Some(1_609_459_200_000));
        assert_eq!(parsed.max_timestamp_ms, Some(1_609_459_202_000));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn codex_rollout_defers_conflicting_explicit_parents() {
        let jsonl = r#"{"type":"session_meta","timestamp":"2021-01-01T00:00:00Z","payload":{"id":"child","forked_from_id":"11111111-1111-1111-1111-111111111111","source":{"subagent":{"thread_spawn":{"parent_thread_id":"22222222-2222-2222-2222-222222222222"}}}}}
{"type":"event_msg","timestamp":"2021-01-01T00:00:01Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1}}}}"#;
        let path = write_temp_jsonl("codex_parent_conflict.jsonl", jsonl);
        let parsed = parse_codex_rollout(&path).expect("rollout");
        assert!(matches!(
            parsed.parent,
            CodexParentResolution::Deferred(reason) if reason.contains("conflicting parent")
        ));
        let _ = std::fs::remove_file(&path);
    }
}
