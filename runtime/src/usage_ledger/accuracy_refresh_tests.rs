use super::{
    discovery::Root,
    facts::{Fact, ReaderState},
    ledger_db, readers, scanner, store,
};
use serde_json::{json, Value};
use std::{fs, sync::atomic::AtomicBool};

fn usage(input: i64, cached: i64, output: i64, reasoning: i64) -> Value {
    json!({"input_tokens":input,"cached_input_tokens":cached,"output_tokens":output,"reasoning_output_tokens":reasoning})
}

fn token(total: Value, last: Value) -> Value {
    json!({"type":"event_msg","timestamp":"2026-01-02T00:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":total,"last_token_usage":last}}})
}

fn codex_state(subagent: bool) -> ReaderState {
    let mut state = ReaderState::default();
    let source = if subagent {
        json!({"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}})
    } else {
        json!("cli")
    };
    readers::parse(
        "codex",
        &json!({"type":"session_meta","payload":{"id":"child","source":source}}),
        0,
        "fixture",
        &mut state,
    );
    state
}

fn typed_mirror(at: &str) -> Value {
    json!({"type":"token_usage_record","timestamp":at,"payload":{
        "thread_id":"child","turn_id":"turn-a","response_id":"response-a",
        "usage":usage(100,60,10,3),"thread_token_usage":usage(100,60,10,3)
    }})
}

#[test]
fn codex_copied_parent_header_does_not_reassign_a_subagent_or_double_its_mirror() {
    let mut state = codex_state(true);
    readers::parse(
        "codex",
        &json!({"type":"session_meta","payload":{"id":"parent","cwd":"copied-parent-folder"}}),
        1,
        "fixture",
        &mut state,
    );
    assert_eq!(state.session_id, "child");
    assert_eq!(state.parent_session_id.as_deref(), Some("parent"));
    let typed = readers::parse(
        "codex",
        &typed_mirror("2026-01-02T00:00:00Z"),
        2,
        "fixture",
        &mut state,
    );
    assert_eq!(typed.facts[0].native_session_id, "child");
    let legacy = readers::parse(
        "codex",
        &token(usage(100, 60, 10, 3), usage(100, 60, 10, 3)),
        3,
        "fixture",
        &mut state,
    );
    assert!(
        legacy.facts.is_empty(),
        "copied metadata must not move the legacy mirror onto its parent"
    );
}

#[test]
fn codex_typed_mirror_without_legacy_turn_context_is_counted_once_in_both_orders() {
    for typed_first in [true, false] {
        let mut state = codex_state(false);
        let typed = typed_mirror("2026-01-02T00:00:00.000Z");
        let mut legacy = token(usage(100, 60, 10, 3), usage(100, 60, 10, 3));
        legacy["timestamp"] = json!("2026-01-02T00:00:00.990Z");
        let events = if typed_first {
            [typed, legacy]
        } else {
            [legacy, typed]
        };
        let mut facts = std::collections::BTreeMap::new();
        for (offset, event) in events.into_iter().enumerate() {
            let parsed = readers::parse("codex", &event, offset as u64, "fixture", &mut state);
            assert!(parsed.problems.is_empty());
            for key in parsed.replaced_keys {
                facts.remove(&key);
            }
            for fact in parsed.facts {
                facts.insert(fact.key.clone(), fact);
            }
        }
        assert_eq!(facts.len(), 1, "typed_first={typed_first}");
        assert_eq!(
            facts.values().map(|fact| fact.buckets.total()).sum::<i64>(),
            110
        );
    }
}

#[test]
fn codex_reused_cumulative_coordinate_long_after_a_typed_request_is_not_a_mirror() {
    let mut state = codex_state(false);
    readers::parse(
        "codex",
        &typed_mirror("2026-01-02T00:00:00Z"),
        1,
        "fixture",
        &mut state,
    );
    let mut legacy = token(usage(100, 60, 10, 3), usage(100, 60, 10, 3));
    legacy["timestamp"] = json!("2026-01-03T00:00:00Z");
    let parsed = readers::parse("codex", &legacy, 2, "fixture", &mut state);
    assert_eq!(parsed.facts.len(), 1);
}

#[test]
fn codex_compaction_mirror_pairs_raw_usage_once_without_merging_equal_sized_calls() {
    for typed_first in [true, false] {
        let mut state = codex_state(false);
        let typed = typed_mirror("2026-01-02T00:00:00Z");
        let mut legacy = token(usage(1000, 600, 100, 30), usage(100, 60, 10, 3));
        legacy["timestamp"] = json!("2026-01-02T00:00:00.990Z");
        let events = if typed_first {
            [typed, legacy]
        } else {
            [legacy, typed]
        };
        let mut facts = std::collections::BTreeMap::new();
        for (offset, event) in events.into_iter().enumerate() {
            let parsed = readers::parse("codex", &event, offset as u64, "fixture", &mut state);
            for key in parsed.replaced_keys {
                facts.remove(&key);
            }
            for fact in parsed.facts {
                facts.insert(fact.key.clone(), fact);
            }
        }
        assert_eq!(facts.len(), 1, "typed_first={typed_first}");
        let mut distinct = token(usage(1100, 660, 110, 33), usage(100, 60, 10, 3));
        distinct["timestamp"] = json!("2026-01-02T00:00:02Z");
        let parsed = readers::parse("codex", &distinct, 3, "fixture", &mut state);
        assert_eq!(
            parsed.facts.len(),
            1,
            "a typed mirror may pair only one cumulative coordinate"
        );
    }
}

#[test]
fn codex_spawned_agent_counts_its_first_legacy_request() {
    let mut state = codex_state(true);
    let parsed = readers::parse(
        "codex",
        &token(usage(100, 60, 10, 3), usage(100, 60, 10, 3)),
        1,
        "fixture",
        &mut state,
    );
    assert_eq!(parsed.facts.len(), 1);
    assert_eq!(parsed.facts[0].buckets.total(), 110);
    assert!(parsed.facts[0].subagent);
}

#[test]
fn codex_rate_limit_only_notification_is_not_a_broken_usage_source() {
    let mut state = codex_state(false);
    let parsed = readers::parse(
        "codex",
        &json!({
            "type":"event_msg", "timestamp":"2026-01-02T00:00:00Z",
            "payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":5}}}
        }),
        1,
        "fixture",
        &mut state,
    );
    assert!(parsed.facts.is_empty());
    assert!(parsed.problems.is_empty());
}

#[test]
fn codex_reasoning_counter_correction_uses_last_request_without_recounting_history() {
    let mut state = codex_state(false);
    readers::parse(
        "codex",
        &token(usage(1000, 800, 100, 50), usage(1000, 800, 100, 50)),
        1,
        "fixture",
        &mut state,
    );
    let parsed = readers::parse(
        "codex",
        &token(usage(1100, 850, 110, 10), usage(100, 50, 10, 10)),
        2,
        "fixture",
        &mut state,
    );
    assert_eq!(parsed.facts.len(), 1);
    assert_eq!(parsed.facts[0].buckets.input, Some(50));
    assert_eq!(parsed.facts[0].buckets.cache_read, Some(50));
    assert_eq!(parsed.facts[0].buckets.output, Some(10));
}

#[test]
fn codex_compaction_counter_reset_preserves_only_last_request() {
    let mut state = codex_state(false);
    readers::parse(
        "codex",
        &token(usage(1000, 800, 100, 50), usage(1000, 800, 100, 50)),
        1,
        "fixture",
        &mut state,
    );
    let parsed = readers::parse(
        "codex",
        &token(usage(600, 400, 50, 10), usage(100, 80, 10, 3)),
        2,
        "fixture",
        &mut state,
    );
    assert_eq!(parsed.facts.len(), 1);
    assert_eq!(parsed.facts[0].buckets.total(), 110);
    assert_eq!(parsed.facts[0].buckets.reasoning, Some(3));
}

#[test]
fn codex_reset_epochs_do_not_merge_distinct_requests_with_reused_totals() {
    let mut state = codex_state(false);
    let first = readers::parse(
        "codex",
        &token(usage(100, 60, 10, 3), usage(100, 60, 10, 3)),
        1,
        "fixture",
        &mut state,
    );
    readers::parse(
        "codex",
        &token(usage(50, 30, 5, 1), usage(50, 30, 5, 1)),
        2,
        "fixture",
        &mut state,
    );
    let third = readers::parse(
        "codex",
        &token(usage(100, 60, 10, 3), usage(50, 30, 5, 2)),
        3,
        "fixture",
        &mut state,
    );
    assert_ne!(first.facts[0].key, third.facts[0].key);
    assert_eq!(third.facts[0].buckets.total(), 55);
}

#[test]
fn codex_reset_without_last_usage_is_reported_instead_of_recounted() {
    let mut state = codex_state(false);
    readers::parse(
        "codex",
        &token(usage(1000, 800, 100, 50), Value::Null),
        1,
        "fixture",
        &mut state,
    );
    let parsed = readers::parse(
        "codex",
        &token(usage(600, 400, 50, 10), Value::Null),
        2,
        "fixture",
        &mut state,
    );
    assert!(parsed.facts.is_empty());
    assert!(parsed
        .problems
        .iter()
        .any(|problem| problem == "counter_reset_without_last_usage"));
}

#[test]
fn codex_cache_correction_without_last_usage_never_creates_negative_input() {
    let mut state = codex_state(false);
    readers::parse(
        "codex",
        &token(usage(100, 80, 10, 0), Value::Null),
        1,
        "fixture",
        &mut state,
    );
    let parsed = readers::parse(
        "codex",
        &token(usage(120, 110, 20, 0), Value::Null),
        2,
        "fixture",
        &mut state,
    );
    assert!(parsed.facts.is_empty());
    assert!(parsed
        .problems
        .iter()
        .any(|problem| problem == "cache_counter_correction_without_last_usage"));
}

#[test]
fn normal_refresh_repairs_version_two_facts_without_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let main = dir.path().join("audit.sqlite");
    drop(crate::db::Database::open(&main).unwrap());
    let conn = ledger_db::test_connection(&main).unwrap();
    let history = dir.path().join("history");
    fs::create_dir(&history).unwrap();
    let records = [
        json!({"type":"session_meta","payload":{"id":"native"}}),
        json!({"type":"turn_context","payload":{"turn_id":"turn","model":"fixture-model"}}),
        token(usage(100, 60, 10, 3), usage(100, 60, 10, 3)),
    ];
    let text = records.iter().map(|v| format!("{v}\n")).collect::<String>();
    fs::write(history.join("rollout.jsonl"), text).unwrap();
    let root = Root {
        provider: "codex".into(),
        path: history.clone(),
        trees: vec![history],
    };
    let cancelled = AtomicBool::new(false);
    scanner::scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
    let id: String = conn
        .query_row("SELECT id FROM usage_sources", [], |r| r.get(0))
        .unwrap();
    let prefix = format!("native:{id}@");
    store::remove_source(&conn, &prefix).unwrap();
    let mut stale = Fact::new(
        "codex",
        "native",
        "old-reset-coordinate",
        "2026-01-02T00:00:00Z",
    );
    stale.source = format!("{prefix}1");
    stale.buckets.input = Some(1000);
    stale.parser_version = 2;
    store::upsert_fact(&conn, &stale).unwrap();
    conn.execute(
        "UPDATE usage_sources SET cursor=json_set(cursor,'$.parser_version',2)",
        [],
    )
    .unwrap();
    let refreshed = scanner::scan(&root, &conn, &cancelled, &mut |_, _| {}).unwrap();
    assert_eq!(
        refreshed.files_read, 1,
        "normal refresh must reparse old cursors"
    );
    let total: i64 = conn.query_row("SELECT SUM(COALESCE(input_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(output_tokens,0)) FROM usage_facts", [], |r| r.get(0)).unwrap();
    assert_eq!(
        total, 110,
        "old reset coordinates must be removed, not max-merged"
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM usage_facts WHERE parser_version=2",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}
