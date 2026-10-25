use serde_json::Value;

use crate::usage_ledger::facts::{number, text, timestamp, Fact, Parsed, ReaderState};

const MAX_STATE_TEXT: usize = 1024;

fn bounded(value: Option<&str>) -> Option<String> {
    value
        .filter(|value| !value.is_empty() && value.len() <= MAX_STATE_TEXT)
        .map(str::to_owned)
}

fn update_state(value: &Value, state: &mut ReaderState) {
    if let Some(session) = bounded(text(value, &["sessionId", "session_id"])) {
        state.session_id = session;
    }
    if let Some(cwd) = bounded(text(value, &["cwd"])) {
        state.cwd = Some(cwd);
    }
    if let Some(parent) = bounded(text(value, &["parentSessionId", "parent_session_id"])) {
        state.parent_session_id = Some(parent);
    }
}

/// Parses one Claude Code JSONL value.  Snapshot rows deliberately retain the
/// message/request coordinate: the store merges repeated observations with
/// `Buckets::merge_max`, rather than adding them.
pub fn parse(value: &Value, offset: u64, file_id: &str, state: &mut ReaderState) -> Parsed {
    let mut parsed = Parsed::default();
    update_state(value, state);

    let Some(message) = value.get("message") else {
        return parsed;
    };
    let Some(usage) = message.get("usage") else {
        return parsed;
    };
    let Some(message_id) = bounded(text(message, &["id"])) else {
        parsed
            .problems
            .push("Claude usage record has no message id".into());
        return parsed;
    };
    let Some(session) = bounded(text(value, &["sessionId", "session_id"]))
        .or_else(|| bounded(Some(&state.session_id)))
        .filter(|session| !session.is_empty())
    else {
        parsed
            .problems
            .push("Claude usage record has no session id".into());
        return parsed;
    };
    let Some(occurred_at) = value.get("timestamp").and_then(timestamp) else {
        parsed
            .problems
            .push("Claude usage record has an unsupported timestamp".into());
        return parsed;
    };
    let request_id = bounded(text(value, &["requestId", "request_id"]));
    let request_key = request_id.clone().unwrap_or_else(|| {
        // A Claude message id is provider-native and stable across streaming
        // snapshots and archived copies. The timestamp validates the record,
        // but does not participate in identity because snapshots can evolve.
        parsed
            .problems
            .push("claude_missing_request_id_fallback".into());
        "fallback".into()
    });
    if request_id.is_some() {
        // A later exact request coordinate supersedes every fallback snapshot.
        // The store persists this tombstone, so an older archive cannot revive it.
        parsed
            .replaced_keys
            .push(format!("claude:{message_id}:fallback"));
    }

    let mut fact = Fact::new(
        "claude",
        &session,
        &format!("{message_id}:{request_key}"),
        &occurred_at,
    );
    fact.model = bounded(text(message, &["model"]));
    fact.buckets.input = number(usage, &["input_tokens", "inputTokens"]);
    fact.buckets.cache_read = number(usage, &["cache_read_input_tokens", "cacheReadInputTokens"]);
    fact.buckets.output = number(usage, &["output_tokens", "outputTokens"]);
    let cache_creation = usage
        .get("cache_creation")
        .or_else(|| usage.get("cacheCreation"));
    fact.buckets.cache_write5m = cache_creation.and_then(|cache| {
        number(
            cache,
            &["ephemeral_5m_input_tokens", "ephemeral5mInputTokens"],
        )
    });
    fact.buckets.cache_write1h = cache_creation.and_then(|cache| {
        number(
            cache,
            &["ephemeral_1h_input_tokens", "ephemeral1hInputTokens"],
        )
    });
    if number(
        usage,
        &["cache_creation_input_tokens", "cacheCreationInputTokens"],
    )
    .is_some()
        && fact.buckets.cache_write5m.is_none()
        && fact.buckets.cache_write1h.is_none()
    {
        fact.buckets.cache_write_unknown = number(
            usage,
            &["cache_creation_input_tokens", "cacheCreationInputTokens"],
        );
        parsed.problems.push(
            "Claude cache creation lifetime is unsupported; cache write retained as unpriced coverage".into(),
        );
    }
    let synthetic = fact.model.as_deref() == Some("<synthetic>");
    let api_error = value.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true);
    if fact.buckets.total() == 0 && (synthetic || api_error) {
        return parsed;
    }
    fact.parent_native_session_id = state.parent_session_id.clone();
    fact.subagent = fact.parent_native_session_id.is_some();
    if value.get("isSidechain").and_then(Value::as_bool) == Some(true)
        || state.data["claudeAgentId"].is_string()
    {
        if let Some(agent) = bounded(
            text(value, &["agentId", "agent_id"]).or_else(|| state.data["claudeAgentId"].as_str()),
        ) {
            fact.native_session_id = format!("{session}:agent:{agent}");
            fact.parent_native_session_id = Some(session.clone());
            fact.subagent = true;
        } else {
            parsed
                .problems
                .push("subagent_identity_not_reported".into());
        }
    }
    fact.cwd = state.cwd.clone();
    fact.source = format!("native:{file_id}@{offset}");
    parsed.covered_sessions.push(fact.native_session_id.clone());
    parsed.facts.push(fact);
    parsed
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn preserves_known_cache_lifetimes_and_flags_flat_legacy_cache_creation() {
        let mut state = ReaderState::default();
        let exact = parse(
            &json!({
                "sessionId":"session-a", "requestId":"request-a", "timestamp":"2026-01-02T03:04:05Z",
                "message":{"id":"message-a", "model":"model-a", "usage":{
                    "input_tokens":1, "output_tokens":2,
                    "cache_creation":{"ephemeral_5m_input_tokens":3,"ephemeral_1h_input_tokens":4}
                }}
            }),
            0,
            "a",
            &mut state,
        );
        assert_eq!(exact.facts[0].buckets.cache_write5m, Some(3));
        assert_eq!(exact.facts[0].buckets.cache_write1h, Some(4));

        let flat = parse(
            &json!({
                "sessionId":"session-a", "requestId":"request-b", "timestamp":"2026-01-02T03:04:06Z",
                "message":{"id":"message-b", "usage":{"cache_creation_input_tokens":5}}
            }),
            1,
            "a",
            &mut state,
        );
        assert_eq!(flat.facts[0].buckets.cache_write5m, None);
        assert_eq!(flat.facts[0].buckets.cache_write1h, None);
        assert_eq!(flat.facts[0].buckets.cache_write_unknown, Some(5));
        assert_eq!(flat.facts[0].buckets.total(), 5);
        assert_eq!(flat.problems.len(), 1);
    }

    #[test]
    fn missing_request_id_snapshots_merge_and_a_real_request_supersedes_the_fallback() {
        let first_value = json!({
            "sessionId":"session-a", "timestamp":"2026-01-02T03:04:05Z",
            "message":{"id":"message-a","usage":{"input_tokens":3,"output_tokens":5}}
        });
        let second_value = json!({
            "sessionId":"session-a", "timestamp":"2026-01-02T03:04:06Z",
            "message":{"id":"message-a","usage":{"input_tokens":7,"output_tokens":9}}
        });
        let first = parse(&first_value, 0, "first-copy", &mut ReaderState::default());
        let second = parse(
            &second_value,
            999,
            "second-copy",
            &mut ReaderState::default(),
        );
        assert_eq!(first.facts[0].key, second.facts[0].key);
        let mut merged = first.facts[0].buckets.clone();
        merged.merge_max(&second.facts[0].buckets);
        assert_eq!(merged.input, Some(7));
        assert_eq!(first.problems, vec!["claude_missing_request_id_fallback"]);

        let identified = parse(
            &json!({
                "sessionId":"session-a", "requestId":"request-a", "timestamp":"2026-01-02T03:04:07Z",
                "message":{"id":"message-a","usage":{"input_tokens":9,"output_tokens":11}}
            }),
            1000,
            "later-copy",
            &mut ReaderState::default(),
        );
        assert_eq!(identified.replaced_keys, vec!["claude:message-a:fallback"]);
    }

    #[test]
    fn synthetic_zero_usage_errors_are_not_requests_but_reported_calls_are_retained() {
        let synthetic = parse(
            &json!({
                "sessionId":"session-a", "requestId":"request-a", "timestamp":"2026-01-02T03:04:05Z",
                "isApiErrorMessage":true,
                "message":{"id":"message-a", "model":"<synthetic>", "usage":{
                    "input_tokens":0, "cache_read_input_tokens":0,
                    "cache_creation_input_tokens":0, "output_tokens":0
                }}
            }),
            0,
            "a",
            &mut ReaderState::default(),
        );
        assert!(synthetic.facts.is_empty());
        assert!(synthetic.covered_sessions.is_empty());

        let known_zero = parse(
            &json!({
                "sessionId":"session-a", "requestId":"request-b", "timestamp":"2026-01-02T03:04:06Z",
                "message":{"id":"message-b", "model":"claude-known", "usage":{
                    "input_tokens":0, "cache_read_input_tokens":0,
                    "cache_creation_input_tokens":0, "output_tokens":0
                }}
            }),
            1,
            "a",
            &mut ReaderState::default(),
        );
        assert_eq!(known_zero.facts.len(), 1);
        assert_eq!(known_zero.covered_sessions, vec!["session-a"]);
        assert_eq!(known_zero.facts[0].buckets.total(), 0);

        let billable_error = parse(
            &json!({
                "sessionId":"session-a", "requestId":"request-c", "timestamp":"2026-01-02T03:04:07Z",
                "isApiErrorMessage":true,
                "message":{"id":"message-c", "model":"claude-known", "usage":{
                    "input_tokens":3, "output_tokens":5
                }}
            }),
            2,
            "a",
            &mut ReaderState::default(),
        );
        assert_eq!(billable_error.facts.len(), 1);
        assert_eq!(billable_error.covered_sessions, vec!["session-a"]);
        assert_eq!(billable_error.facts[0].buckets.total(), 8);
    }
}
