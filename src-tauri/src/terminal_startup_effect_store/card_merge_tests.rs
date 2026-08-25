use super::card_merge::merge_card;
use serde_json::{json, Value};

pub(super) fn token(number: u8) -> String {
    format!("{number:032x}")
}
pub(super) fn submit(number: u8, at: u64, state: &str) -> Value {
    json!({"token": token(number), "kind": "recordUserSubmit", "at": at, "timeline": state})
}
pub(super) fn binding(number: u8, at: u64, state: &str) -> Value {
    json!({"token": token(number), "kind": "bindProviderSession", "at": at, "binding": state})
}
pub(super) fn discover(number: u8, at: u64, state: &str) -> Value {
    json!({"token": token(number), "kind": "discoverProviderSession", "at": at, "binding": state})
}
pub(super) fn projection(epoch: &str, parent: Option<&str>, records: Vec<Value>) -> Value {
    let mut value = json!({"schema": 1, "projectionEpoch": epoch, "applied": records});
    if let Some(parent) = parent {
        value
            .as_object_mut()
            .unwrap()
            .insert("parentProjectionEpoch".to_string(), Value::from(parent));
    }
    value
}
pub(super) fn startup_event(number: u8, at: u64, summary: &str) -> Value {
    json!({
        "at": at,
        "kind": "not-trusted",
        "summary": summary,
        "summaryKey": "not-trusted",
        "startupEffectToken": token(number)
    })
}
pub(super) fn card(
    id: &str,
    pty_id: &str,
    count: Value,
    events: Value,
    effects: Option<Value>,
) -> Value {
    let mut value = json!({
        "id": id,
        "ptyId": pty_id,
        "messageCount": count,
        "events": events,
        "ordinaryField": {"kept": true}
    });
    if let Some(effects) = effects {
        value
            .as_object_mut()
            .unwrap()
            .insert("startupSideEffects".to_string(), effects);
    }
    value
}
#[test]
fn legacy_without_projection_is_returned_byte_equivalently() {
    let incoming = json!({"id": "card", "ptyId": "pty", "command": "keep"});
    assert_eq!(merge_card(None, &incoming).unwrap(), incoming);
}
#[test]
fn first_projection_canonicalizes_events_and_counts_once() {
    let epoch = token(1);
    let incoming = card(
        "card",
        "pty",
        json!(2),
        json!([
            startup_event(2, 900, "attacker text"),
            startup_event(2, 901, "duplicate text")
        ]),
        Some(projection(&epoch, None, vec![submit(2, 20, "present")])),
    );
    let output = merge_card(None, &incoming).unwrap();
    assert_eq!(output["messageCount"], 2);
    assert_eq!(
        output["events"],
        json!([{
            "at": 20,
            "kind": "user-input",
            "summary": "Sent input",
            "summaryKey": "terminal:view.sentInput",
            "startupEffectToken": token(2)
        }])
    );
}
#[test]
fn same_pty_uses_current_effect_and_provider_authority() {
    let epoch = token(1);
    let mut current = card(
        "card",
        "pty",
        json!(1),
        json!([startup_event(2, 20, "old")]),
        Some(projection(
            &epoch,
            None,
            vec![
                submit(2, 20, "present"),
                binding(3, 30, "active"),
                discover(5, 50, "active"),
            ],
        )),
    );
    current["providerSessionId"] = json!("current");
    current["providerSessionState"] = json!("bound");
    current["providerSessionBoundAt"] = json!(10);
    let mut incoming = card(
        "card",
        "pty",
        json!(2),
        json!([startup_event(2, 999, "stale"), startup_event(4, 40, "new")]),
        Some(projection(
            &epoch,
            Some(&token(9)),
            vec![submit(4, 40, "present")],
        )),
    );
    incoming["providerSessionId"] = json!("incoming");
    incoming["providerSessionState"] = json!("unbound");
    incoming["providerSessionBoundAt"] = json!(99);
    incoming["providerSessionLastResumeAt"] = json!(100);
    let output = merge_card(Some(&current), &incoming).unwrap();
    assert_eq!(output["ordinaryField"], json!({"kept": true}));
    assert_eq!(output["providerSessionId"], "current");
    assert_eq!(output["providerSessionState"], "bound");
    assert_eq!(output["providerSessionBoundAt"], 10);
    assert!(output.get("providerSessionLastResumeAt").is_none());
    assert_eq!(output["messageCount"], 3);
    assert_eq!(output["startupSideEffects"]["projectionEpoch"], epoch);
    assert_eq!(output["events"][0]["startupEffectToken"], token(2));
    assert_eq!(output["events"][1]["startupEffectToken"], token(4));
    assert!(output["startupSideEffects"]["applied"]
        .as_array()
        .unwrap()
        .iter()
        .any(|record| record["token"] == token(3) && record["binding"] == "active"));
}
#[test]
fn malformed_projected_cards_fail_closed() {
    let malformed = [
        card("", "pty", json!(0), json!([]), None),
        card("card", "", json!(0), json!([]), None),
        card(
            "card",
            "pty",
            json!("1"),
            json!([]),
            Some(projection(&token(1), None, vec![])),
        ),
        card(
            "card",
            "pty",
            json!(0),
            json!({}),
            Some(projection(&token(1), None, vec![])),
        ),
        card(
            "card",
            "pty",
            json!(0),
            json!([]),
            Some(json!({"schema": 2})),
        ),
    ];
    for incoming in malformed {
        assert!(merge_card(None, &incoming).is_err(), "{incoming}");
    }
}
