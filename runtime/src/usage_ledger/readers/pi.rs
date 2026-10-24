use serde_json::Value;

use crate::usage_ledger::facts::{number, text, timestamp, Fact, Parsed, ReaderState};

const MAX_STATE_TEXT: usize = 1024;

fn bounded(value: Option<&str>) -> Option<String> {
    value
        .filter(|value| !value.is_empty() && value.len() <= MAX_STATE_TEXT)
        .map(str::to_owned)
}

fn header(value: &Value, state: &mut ReaderState) {
    if value.get("type").and_then(Value::as_str) != Some("session") {
        return;
    }
    if let Some(id) = bounded(text(value, &["id", "sessionId", "session_id"])) {
        state.session_id = id;
    }
    if let Some(cwd) = bounded(text(value, &["cwd"])) {
        state.cwd = Some(cwd);
    }
    if let Some(parent) = bounded(text(value, &["parentSessionId", "parent_session_id"])) {
        state.parent_session_id = Some(parent);
    }
    if let Some(path) = text(value, &["parentSession"]) {
        let filename = path.rsplit(['/', '\\']).next().unwrap_or("");
        if let Some(id) = filename
            .strip_suffix(".jsonl")
            .and_then(|s| s.rsplit('_').next())
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        {
            state.parent_session_id = Some(id.to_owned());
        }
        if !state.data.is_object() {
            state.data = serde_json::json!({});
        }
        state.data["piFork"] = Value::Bool(true);
        if let Some(at) = value
            .get("timestamp")
            .and_then(timestamp)
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
            .map(|t| t.timestamp_millis())
        {
            state.data["forkCreatedAtMs"] = Value::from(at);
        }
    }
}

fn reported_cost(usage: &Value) -> Option<f64> {
    usage.get("cost").and_then(|cost| {
        if let Some(total) = cost.get("total").and_then(Value::as_f64) {
            return (total > 0.0).then_some(total);
        }
        cost.as_f64().filter(|cost| *cost > 0.0)
    })
}

/// Parses one Pi session-tree row. Entry ids are provider-native and stay
/// global across copied fork prefixes, so the ledger's key UPSERT removes the
/// duplicate instead of treating the child file as a second request.
pub fn parse(value: &Value, offset: u64, file_id: &str, state: &mut ReaderState) -> Parsed {
    let mut parsed = Parsed::default();
    header(value, state);
    let Some(message) = value.get("message") else {
        return parsed;
    };
    if text(message, &["role"]) != Some("assistant") {
        return parsed;
    }
    let Some(usage) = message.get("usage") else {
        return parsed;
    };
    let Some(entry_id) = bounded(text(value, &["id", "entryId", "entry_id"])) else {
        parsed
            .problems
            .push("Pi assistant usage record has no entry id".into());
        return parsed;
    };
    let Some(session) = bounded(Some(&state.session_id)).filter(|session| !session.is_empty())
    else {
        parsed
            .problems
            .push("Pi assistant usage record appears before a session header".into());
        return parsed;
    };
    let Some(occurred_at) = value.get("timestamp").and_then(timestamp) else {
        parsed
            .problems
            .push("Pi assistant usage record has an unsupported timestamp".into());
        return parsed;
    };

    let mut fact = Fact::new("pi", &session, &entry_id, &occurred_at);
    if state.data["forkCreatedAtMs"]
        .as_i64()
        .is_some_and(|created| {
            chrono::DateTime::parse_from_rfc3339(&occurred_at)
                .is_ok_and(|at| at.timestamp_millis() < created)
        })
    {
        parsed.covered_sessions.push(session);
        return parsed;
    }
    fact.model = bounded(text(message, &["model"]));
    fact.buckets.input = number(usage, &["input"]);
    fact.buckets.cache_read = number(usage, &["cacheRead", "cache_read"]);
    // `cacheWrite` has no lifetime in Pi's native record. Keep its exact token
    // coverage unpriced; only explicitly partitioned values occupy TTL buckets.
    fact.buckets.cache_write5m = number(usage, &["cacheWrite5m", "cache_write_5m"]);
    fact.buckets.cache_write1h = number(usage, &["cacheWrite1h", "cache_write_1h"]);
    fact.buckets.cache_write_unknown = number(usage, &["cacheWrite", "cache_write"]).map(|total| {
        total
            .saturating_sub(fact.buckets.cache_write5m.unwrap_or(0))
            .saturating_sub(fact.buckets.cache_write1h.unwrap_or(0))
    });
    fact.buckets.output = number(usage, &["output"]);
    fact.buckets.reasoning = number(usage, &["reasoning"]);
    fact.reported_cost = reported_cost(usage);
    fact.parent_native_session_id = state.parent_session_id.clone();
    fact.subagent =
        fact.parent_native_session_id.is_some() && state.data["piFork"].as_bool() != Some(true);
    fact.cwd = state.cwd.clone();
    fact.source = format!("native:{file_id}@{offset}");
    parsed.covered_sessions.push(session);
    parsed.facts.push(fact);
    parsed
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn copied_fork_entry_retains_the_same_global_native_key() {
        let mut parent = ReaderState::default();
        parse(
            &json!({"type":"session","id":"session-parent"}),
            0,
            "parent",
            &mut parent,
        );
        let original = parse(
            &json!({
                "id":"entry-a", "timestamp":"2026-01-02T03:04:05Z",
                "message":{"role":"assistant","usage":{"input":1,"output":2}}
            }),
            1,
            "parent",
            &mut parent,
        );

        let mut child = ReaderState::default();
        parse(
            &json!({"type":"session","id":"session-child","parentSessionId":"session-parent"}),
            0,
            "child",
            &mut child,
        );
        let copied = parse(
            &json!({
                "id":"entry-a", "timestamp":"2026-01-02T03:04:05Z",
                "message":{"role":"assistant","usage":{"input":1,"output":2}}
            }),
            1,
            "child",
            &mut child,
        );
        assert_eq!(original.facts[0].key, copied.facts[0].key);
        assert!(copied.facts[0].subagent);
    }

    #[test]
    fn unqualified_cache_write_remains_exact_unpriced_coverage() {
        let mut state = ReaderState::default();
        parse(
            &json!({"type":"session","id":"session-a"}),
            0,
            "a",
            &mut state,
        );
        let parsed = parse(
            &json!({
                "id":"entry-a", "timestamp":"2026-01-02T03:04:05Z",
                "message":{"role":"assistant","usage":{"cacheWrite":7}}
            }),
            1,
            "a",
            &mut state,
        );
        assert_eq!(parsed.facts[0].buckets.cache_write_unknown, Some(7));
        assert_eq!(parsed.facts[0].buckets.cache_write5m, None);
    }

    #[test]
    fn known_one_hour_partition_is_not_counted_again_as_unknown() {
        let mut state = ReaderState::default();
        parse(
            &json!({"type":"session","id":"session-a"}),
            0,
            "a",
            &mut state,
        );
        let parsed = parse(
            &json!({
                "id":"entry-a", "timestamp":"2026-01-02T03:04:05Z",
                "message":{"role":"assistant","usage":{"cacheWrite":10,"cacheWrite1h":4}}
            }),
            1,
            "a",
            &mut state,
        );
        assert_eq!(parsed.facts[0].buckets.cache_write1h, Some(4));
        assert_eq!(parsed.facts[0].buckets.cache_write_unknown, Some(6));
        assert_eq!(parsed.facts[0].buckets.total(), 10);
    }
}
