use super::card_merge_tests::{card, projection, startup_event, submit, token};
use super::envelope_merge::merge_snapshot;
use serde_json::{json, Value};

fn envelope(cards: Vec<Value>, archived: Vec<Value>) -> String {
    serde_json::to_string(
        &json!({"state": {"cards": cards, "archivedCards": archived}, "version": 22}),
    )
    .unwrap()
}

#[test]
fn legacy_envelope_is_returned_byte_equivalently() {
    let raw = " { \"state\": { \"cards\": [{\"id\":\"a\",\"ptyId\":\"p\"}] } } ";
    let out = merge_snapshot(None, raw).unwrap();
    assert_eq!(out.value, raw);
    assert!(!out.reconciled);
    let current = merge_snapshot(Some(raw), raw).unwrap();
    assert_eq!(current.value, raw);
}

#[test]
fn protected_current_is_restored_and_incoming_archive_is_supported() {
    let current = card(
        "a",
        "p",
        json!(1),
        json!([startup_event(1, 1, "old")]),
        Some(projection(&token(9), None, vec![submit(1, 1, "present")])),
    );
    let incoming = card(
        "a",
        "p",
        json!(2),
        json!([startup_event(1, 9, "stale")]),
        Some(projection(&token(9), None, vec![submit(1, 1, "present")])),
    );
    let out = merge_snapshot(
        Some(&envelope(vec![current.clone()], vec![])),
        &envelope(vec![], vec![incoming]),
    )
    .unwrap();
    let value: Value = serde_json::from_str(&out.value).unwrap();
    assert_eq!(value["state"]["cards"], json!([]));
    assert_eq!(
        value["state"]["archivedCards"][0]["events"][0]["kind"],
        "user-input"
    );
    assert!(out.reconciled);
}

#[test]
fn incoming_deletion_is_not_restored() {
    let current = card(
        "a",
        "p",
        json!(1),
        json!([]),
        Some(projection(&token(9), None, vec![])),
    );
    let raw = envelope(vec![], vec![]);
    let out = merge_snapshot(Some(&envelope(vec![current], vec![])), &raw).unwrap();
    assert_eq!(out.value, raw);
    assert!(!out.reconciled);
}

#[test]
fn version_and_unknown_root_state_are_preserved() {
    let raw = serde_json::to_string(&json!({"version":22,"unknown":true,"state":{"cards":[card("a","p",json!(2),json!([startup_event(2,1,"x")]),Some(projection(&token(3),None,vec![submit(2,1,"present")])) )],"extra":"x"}})).unwrap();
    let out = merge_snapshot(None, &raw).unwrap();
    let value: Value = serde_json::from_str(&out.value).unwrap();
    assert!(out.reconciled);
    assert_eq!(value["version"], 22);
    assert_eq!(value["unknown"], true);
    assert_eq!(value["state"]["extra"], "x");
}

#[test]
fn canonicalization_is_idempotent() {
    let raw = envelope(
        vec![card(
            "a",
            "p",
            json!(2),
            json!([startup_event(2, 1, "x"), startup_event(2, 2, "y")]),
            Some(projection(&token(3), None, vec![submit(2, 2, "present")])),
        )],
        vec![],
    );
    let first = merge_snapshot(None, &raw).unwrap();
    assert!(first.reconciled);
    let second = merge_snapshot(None, &first.value).unwrap();
    assert_eq!(second.value, first.value);
    assert!(!second.reconciled);
}

#[test]
fn malformed_json_state_cards_archived_projection_and_duplicate_ids_fail() {
    let cases = vec!["{".to_string(), "{}".to_string(), r#"{"state":{"cards":{}}}"#.to_string(), r#"{"state":{"cards":[],"archivedCards":{}}}"#.to_string(),
        serde_json::to_string(&json!({"state":{"cards":[card("a","p",json!(0),json!([]),Some(json!({"schema":2})))]}})).unwrap()];
    for raw in cases {
        assert!(merge_snapshot(None, &raw).is_err(), "{raw}");
    }
    let bad = serde_json::to_string(
        &json!({"state":{"cards":[card("a","p",json!("bad"),json!([]),Some(projection(&token(1), None, vec![])))]}}),
    )
    .unwrap();
    assert!(merge_snapshot(None, &bad).is_err());
    assert!(merge_snapshot(
        None,
        &envelope(vec![json!({"id":"a"})], vec![json!({"id":"a"})])
    )
    .is_err());
    let current = envelope(vec![json!({"id":"a"})], vec![json!({"id":"a"})]);
    assert!(merge_snapshot(Some(&current), &envelope(vec![json!({"id":"b"})], vec![])).is_err());
}
