//! Cross-provider parser contracts.  These fixtures intentionally use only
//! synthetic native coordinates; scanner/store tests cover physical files.

use serde_json::json;

use super::{claude, codex, grok, kimi, opencode, pi};
use crate::usage_ledger::facts::ReaderState;

#[test]
fn provider_records_normalize_to_disjoint_expected_totals() {
    let mut claude_state = ReaderState::default();
    let claude_fact = claude::parse(
        &json!({
            "sessionId":"claude-session", "requestId":"claude-request", "timestamp":"2026-01-02T03:04:05Z",
            "message":{"id":"claude-message", "usage":{
                "input_tokens":2, "cache_read_input_tokens":3, "output_tokens":7,
                "cache_creation":{"ephemeral_5m_input_tokens":5,"ephemeral_1h_input_tokens":1}
            }}
        }),
        0,
        "claude-fixture",
        &mut claude_state,
    )
    .facts
    .pop()
    .unwrap();
    assert_eq!(claude_fact.buckets.total(), 18);

    let mut codex_state = ReaderState::default();
    codex::parse(
        &json!({"type":"session_meta","payload":{"id":"codex-thread"}}),
        0,
        "codex-fixture",
        &mut codex_state,
    );
    let codex_fact = codex::parse(
        &json!({
            "timestamp":"2026-01-02T03:04:05Z", "type":"token_usage_record", "payload":{
                "thread_id":"codex-thread", "turn_id":"turn-a", "response_id":"response-a",
                "usage":{"input_tokens":10,"cached_input_tokens":6,"cache_write_input_tokens":2,"output_tokens":3}
            }
        }),
        1,
        "codex-fixture",
        &mut codex_state,
    )
    .facts
    .pop()
    .unwrap();
    assert_eq!(codex_fact.buckets.total(), 15);
    assert_eq!(codex_fact.buckets.cache_write_unknown, Some(2));

    let mut pi_state = ReaderState::default();
    pi::parse(
        &json!({"type":"session","id":"pi-session"}),
        0,
        "pi-fixture",
        &mut pi_state,
    );
    let pi_fact = pi::parse(
        &json!({
            "id":"pi-entry", "timestamp":"2026-01-02T03:04:05Z",
            "message":{"role":"assistant","usage":{"input":1,"cacheRead":2,"cacheWrite":3,"output":4}}
        }),
        1,
        "pi-fixture",
        &mut pi_state,
    )
    .facts
    .pop()
    .unwrap();
    assert_eq!(pi_fact.buckets.total(), 10);
    assert_eq!(pi_fact.buckets.cache_write_unknown, Some(3));

    let mut kimi_state = ReaderState {
        session_id: "kimi-session".into(),
        ..Default::default()
    };
    let kimi_fact = kimi::parse(
        &json!({"type":"usage.record","time":1,"usage":{"inputOther":1,"inputCacheRead":2,"inputCacheCreation":3,"output":4}}),
        0,
        "kimi-fixture",
        &mut kimi_state,
    )
    .facts
    .pop()
    .unwrap();
    assert_eq!(kimi_fact.buckets.total(), 10);

    let mut grok_state = ReaderState::default();
    let grok_fact = grok::parse(
        &json!({
            "timestamp":1, "params":{"sessionId":"grok-session","update":{
                "sessionUpdate":"turn_completed", "prompt_id":"prompt-a",
                "usage":{"inputTokens":10,"cachedReadTokens":8,"cacheCreationTokens":3,"outputTokens":2,"reasoningTokens":1}
            }}
        }),
        0,
        "grok-fixture",
        &mut grok_state,
    )
    .facts
    .pop()
    .unwrap();
    assert_eq!(grok_fact.buckets.total(), 15);

    let mut opencode_state = ReaderState::default();
    let opencode_fact = opencode::parse(
        &json!({
            "id":"opencode-message", "sessionID":"opencode-session", "time":{"completed":1},
            "role":"assistant", "tokens":{"input":1,"output":2,"reasoning":3,"cache":{"read":4,"write":5}}
        }),
        0,
        "opencode-fixture",
        &mut opencode_state,
    )
    .facts
    .pop()
    .unwrap();
    assert_eq!(opencode_fact.buckets.total(), 15);
}

#[test]
fn repeated_claude_snapshots_merge_by_max_without_double_counting() {
    let mut state = ReaderState::default();
    let first = claude::parse(
        &json!({
            "sessionId":"session-a", "requestId":"request-a", "timestamp":"2026-01-02T03:04:05Z",
            "message":{"id":"message-a","usage":{"input_tokens":1,"output_tokens":2}}
        }),
        0,
        "fixture",
        &mut state,
    )
    .facts
    .pop()
    .unwrap();
    let second = claude::parse(
        &json!({
            "sessionId":"session-a", "requestId":"request-a", "timestamp":"2026-01-02T03:04:06Z",
            "message":{"id":"message-a","usage":{"input_tokens":3,"output_tokens":5}}
        }),
        1,
        "fixture",
        &mut state,
    )
    .facts
    .pop()
    .unwrap();
    assert_eq!(first.key, second.key);
    let mut merged = first.buckets;
    merged.merge_max(&second.buckets);
    assert_eq!(merged.total(), 8);
}

#[test]
fn unsupported_or_incomplete_versions_report_problems_without_fabricating_facts() {
    let mut state = ReaderState::default();
    let missing_identity = codex::parse(
        &json!({
            "timestamp":"2026-01-02T03:04:05Z", "type":"token_usage_record",
            "payload":{"thread_id":"thread-a","usage":{"input_tokens":1}}
        }),
        0,
        "fixture",
        &mut state,
    );
    assert!(missing_identity.facts.is_empty());
    assert_eq!(missing_identity.problems.len(), 1);

    let unsupported = super::parse(
        "unknown-provider",
        &json!({"usage": {}}),
        0,
        "fixture",
        &mut state,
    );
    assert!(unsupported.facts.is_empty());
    assert_eq!(unsupported.problems, vec!["not_supported_yet"]);
}

#[test]
fn copied_typed_codex_prefix_keeps_original_thread_identity() {
    let typed = json!({
        "timestamp":"2026-01-02T03:04:05Z", "type":"token_usage_record", "payload":{
            "thread_id":"original-thread", "turn_id":"turn-a", "response_id":"response-a",
            "usage":{"input_tokens":2,"output_tokens":1}
        }
    });
    let mut parent = ReaderState::default();
    codex::parse(
        &json!({"type":"session_meta","payload":{"id":"original-thread"}}),
        0,
        "parent",
        &mut parent,
    );
    let original = codex::parse(&typed, 1, "parent", &mut parent)
        .facts
        .pop()
        .unwrap();

    let mut child = ReaderState::default();
    codex::parse(
        &json!({"type":"session_meta","payload":{"id":"child-thread","forked_from_id":"original-thread"}}),
        0,
        "child",
        &mut child,
    );
    let copied = codex::parse(&typed, 1, "child", &mut child)
        .facts
        .pop()
        .unwrap();
    assert_eq!(original.key, copied.key);
    assert_eq!(copied.native_session_id, "original-thread");
}
