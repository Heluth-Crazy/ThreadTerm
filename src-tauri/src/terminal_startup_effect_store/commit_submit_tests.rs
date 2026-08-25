use super::commit_test_support::{card, envelope, token, Fixture};
use super::{StartupEffectCommit, StartupEffectCommitOutcome};
use serde_json::{json, Value};
fn submit(n: u8, card_id: &str, pty_id: &str) -> StartupEffectCommit {
    StartupEffectCommit::RecordUserSubmit {
        token: token(n),
        card_id: card_id.into(),
        pty_id: pty_id.into(),
        at_ms: u64::from(n),
    }
}
#[test]
fn first_submit_creates_epoch_restricted_event_and_no_sensitive_record_fields() {
    let fixture = Fixture::new("commit-submit");
    fixture.seed(envelope(
        vec![card("card", Some("pty"), 4, json!([]))],
        vec![],
    ));
    assert_eq!(
        fixture.store().commit(submit(1, "card", "pty")).unwrap(),
        StartupEffectCommitOutcome::Applied
    );
    let card = &fixture.read()["state"]["cards"][0];
    assert_eq!(card["messageCount"], 5);
    assert_eq!(card["startupSideEffects"]["projectionEpoch"], token(1));
    assert!(card["startupSideEffects"]
        .get("parentProjectionEpoch")
        .is_none());
    assert_eq!(card["events"][0]["summaryKey"], "terminal:view.sentInput");
    let record = &card["startupSideEffects"]["applied"][0];
    for field in [
        "cardId",
        "ptyId",
        "provider",
        "providerSessionId",
        "command",
        "cwd",
    ] {
        assert!(
            record.get(field).is_none(),
            "unexpected persisted field {field}"
        );
    }
}

#[test]
fn retry_is_already_applied_and_does_not_increment_or_change_bytes() {
    let fixture = Fixture::new("commit-submit");
    fixture.seed(envelope(
        vec![card("card", Some("pty"), 0, json!([]))],
        vec![],
    ));
    let store = fixture.store();
    let effect = submit(2, "card", "pty");
    assert_eq!(
        store.commit(effect.clone()).unwrap(),
        StartupEffectCommitOutcome::Applied
    );
    let before = fixture.raw();
    assert_eq!(
        store.commit(effect).unwrap(),
        StartupEffectCommitOutcome::AlreadyApplied
    );
    let after = fixture.raw();
    assert_eq!(before, after);
    assert_eq!(fixture.read()["state"]["cards"][0]["messageCount"], 1);
}

#[test]
fn missing_wrong_pty_are_obsolete_and_archived_cards_are_targets() {
    let fixture = Fixture::new("commit-submit");
    fixture.seed(envelope(
        vec![card("active", Some("pty"), 0, json!([]))],
        vec![card("archived", Some("old"), 0, json!([]))],
    ));
    let store = fixture.store();
    assert_eq!(
        store.commit(submit(3, "missing", "missing")).unwrap(),
        StartupEffectCommitOutcome::Obsolete
    );
    assert_eq!(
        store.commit(submit(4, "active", "other")).unwrap(),
        StartupEffectCommitOutcome::Obsolete
    );
    assert_eq!(
        store.commit(submit(5, "archived", "old")).unwrap(),
        StartupEffectCommitOutcome::Applied
    );
    assert_eq!(
        fixture.read()["state"]["archivedCards"][0]["messageCount"],
        1
    );
}

#[test]
fn submit_preserves_existing_epoch_parent_and_retires_capped_token() {
    let fixture = Fixture::new("commit-submit");
    let records: Vec<Value> = (0..20)
        .map(|number| json!({"token":token(number),"kind":"recordUserSubmit","at":number,"timeline":"present"}))
        .collect();
    let events: Vec<Value> = (0..20)
        .map(|number| json!({"at":number,"kind":"user-input","summary":"old","startupEffectToken":token(number)}))
        .collect();
    let mut current = card("card", Some("pty"), 20, Value::Array(events));
    current["startupSideEffects"] = json!({"schema":1,"projectionEpoch":token(30),"parentProjectionEpoch":token(29),"applied":records});
    fixture.seed(envelope(vec![current], vec![]));
    assert_eq!(
        fixture.store().commit(submit(21, "card", "pty")).unwrap(),
        StartupEffectCommitOutcome::Applied
    );
    let card = &fixture.read()["state"]["cards"][0];
    assert_eq!(card["startupSideEffects"]["projectionEpoch"], token(30));
    assert_eq!(
        card["startupSideEffects"]["parentProjectionEpoch"],
        token(29)
    );
    assert_eq!(card["messageCount"], 21);
    assert_eq!(card["events"].as_array().unwrap().len(), 20);
    assert!(!card["events"].to_string().contains(&token(0)));
    let retired = card["startupSideEffects"]["applied"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["token"] == token(0))
        .unwrap();
    assert_eq!(retired["timeline"], "retired");
}
