use super::card_merge::merge_card;
use super::card_merge_tests::{binding, card, discover, projection, startup_event, submit, token};
use serde_json::json;

#[test]
fn reconfigure_retires_old_records_and_uses_incoming_binding() {
    let old_epoch = token(1);
    let new_epoch = token(5);
    let current = card(
        "card",
        "old-pty",
        json!(2),
        json!([startup_event(2, 20, "old")]),
        Some(projection(
            &old_epoch,
            None,
            vec![
                submit(2, 20, "present"),
                binding(3, 30, "active"),
                discover(5, 50, "active"),
            ],
        )),
    );
    let mut incoming = card(
        "card",
        "new-pty",
        json!(1),
        json!([startup_event(2, 20, "old"), startup_event(4, 40, "new")]),
        Some(projection(
            &new_epoch,
            Some(&old_epoch),
            vec![submit(4, 40, "present")],
        )),
    );
    incoming["providerSessionId"] = json!("new-session");
    incoming["providerSessionState"] = json!("bound");
    incoming["providerSessionBoundAt"] = json!(40);
    incoming["providerSessionLastResumeAt"] = json!(41);
    let output = merge_card(Some(&current), &incoming).unwrap();
    assert_eq!(output["providerSessionId"], "new-session");
    assert_eq!(output["providerSessionState"], "bound");
    assert_eq!(output["providerSessionBoundAt"], 40);
    assert_eq!(output["providerSessionLastResumeAt"], 41);
    assert_eq!(output["startupSideEffects"]["projectionEpoch"], new_epoch);
    assert_eq!(output["events"].as_array().unwrap().len(), 1);
    assert_eq!(output["events"][0]["startupEffectToken"], token(4));
    let applied = output["startupSideEffects"]["applied"].as_array().unwrap();
    assert!(applied
        .iter()
        .any(|record| { record["token"] == token(2) && record["timeline"] == "retired" }));
    assert!(applied
        .iter()
        .any(|record| { record["token"] == token(3) && record["binding"] == "retired" }));
    assert!(applied
        .iter()
        .any(|record| { record["token"] == token(5) && record["binding"] == "retired" }));
}

#[test]
fn stale_projection_returns_current_even_with_malformed_ordinary_fields() {
    let epoch = token(1);
    let current = card(
        "card",
        "current-pty",
        json!(1),
        json!([]),
        Some(projection(&epoch, None, vec![submit(2, 20, "present")])),
    );
    let cases = [
        card(
            "card",
            "other",
            json!("bad"),
            json!({}),
            Some(projection(&token(3), None, vec![])),
        ),
        card(
            "card",
            "other",
            json!("bad"),
            json!({}),
            Some(projection(&token(3), Some(&token(4)), vec![])),
        ),
        card(
            "card",
            "current-pty",
            json!("bad"),
            json!({}),
            Some(projection(&token(3), Some(&epoch), vec![])),
        ),
    ];
    for incoming in cases {
        assert_eq!(merge_card(Some(&current), &incoming).unwrap(), current);
    }
}
