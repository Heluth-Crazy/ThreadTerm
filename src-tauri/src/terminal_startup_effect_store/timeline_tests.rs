use super::timeline::project_timeline;
use super::{parse_startup_side_effects, StartupEffectRecord, StartupTimelineState};
use serde_json::{json, Value};

fn token(number: u8) -> String {
    format!("{number:032x}")
}

fn records(value: Value) -> Vec<StartupEffectRecord> {
    parse_startup_side_effects(&json!({
        "schema": 1,
        "projectionEpoch": token(1),
        "applied": value,
    }))
    .expect("valid records")
    .applied
}

fn submit(number: u8, at: u64, status: &str) -> Value {
    json!({
        "token": token(number),
        "kind": "recordUserSubmit",
        "at": at,
        "timeline": status,
    })
}

fn startup_event(token: &str, at: u64, summary: &str) -> Value {
    json!({
        "at": at,
        "kind": "wrong",
        "summary": summary,
        "summaryKey": "untrusted",
        "startupEffectToken": token,
    })
}

#[test]
fn missing_present_event_is_restored_canonically() {
    let mut records = records(json!([submit(2, 20, "present")]));
    let events = project_timeline(&mut records, &[]).expect("restore");
    assert_eq!(
        events,
        vec![json!({
            "at": 20,
            "kind": "user-input",
            "summary": "Sent input",
            "summaryKey": "terminal:view.sentInput",
            "startupEffectToken": token(2),
        })]
    );
}

#[test]
fn unknown_retired_binding_and_duplicate_startup_events_are_dropped() {
    let mut records = records(json!([
        submit(2, 20, "present"),
        submit(3, 30, "retired"),
        {
            "token": token(4),
            "kind": "bindProviderSession",
            "at": 40,
            "binding": "active"
        }
    ]));
    let events = project_timeline(
        &mut records,
        &[
            startup_event(&token(2), 999, "untrusted"),
            startup_event(&token(2), 1000, "duplicate"),
            startup_event(&token(3), 30, "retired"),
            startup_event(&token(4), 40, "binding"),
            startup_event(&token(9), 90, "unknown"),
        ],
    )
    .expect("drop untrusted startup events");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["startupEffectToken"], token(2));
    assert_eq!(events[0]["at"], 20);
    assert_eq!(events[0]["summary"], "Sent input");
}

#[test]
fn ordinary_event_is_preserved_and_equal_times_have_fixed_order() {
    let mut records = records(json!([submit(2, 10, "present")]));
    let ordinary = json!({
        "at": 10,
        "kind": "output",
        "summary": "keep",
        "extra": {"preserve": true}
    });
    let events = project_timeline(
        &mut records,
        &[startup_event(&token(2), 10, "ignored"), ordinary.clone()],
    )
    .expect("sort events");
    assert_eq!(events[0], ordinary);
    assert_eq!(events[1]["startupEffectToken"], token(2));
}

#[test]
fn cap_retires_oldest_startup_and_second_merge_cannot_resurrect_it() {
    let mut input_records = Vec::new();
    let mut incoming_events = Vec::new();
    for number in 0..21 {
        input_records.push(submit(number, u64::from(number), "present"));
        incoming_events.push(startup_event(&token(number), u64::from(number), "ignored"));
    }
    let mut records = records(Value::Array(input_records));
    let first = project_timeline(&mut records, &incoming_events).expect("cap timeline");
    assert_eq!(first.len(), 20);
    assert_eq!(records[0].timeline, Some(StartupTimelineState::Retired));
    let second = project_timeline(&mut records, &incoming_events).expect("retry timeline");
    assert_eq!(second, first);
    assert!(!second
        .iter()
        .any(|event| event["startupEffectToken"] == token(0)));
}

#[test]
fn malformed_event_shapes_fail_closed() {
    let cases = [
        Value::Null,
        json!({"kind": "output", "summary": "missing at"}),
        json!({"at": -1, "kind": "output", "summary": "negative"}),
        json!({"at": "1", "kind": "output", "summary": "string"}),
        json!({"at": 1, "startupEffectToken": null}),
        json!({"at": 1, "startupEffectToken": 7}),
    ];
    for event in cases {
        let mut records = Vec::new();
        assert!(project_timeline(&mut records, &[event]).is_err());
    }
}
