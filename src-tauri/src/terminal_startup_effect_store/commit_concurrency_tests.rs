use super::commit_test_support::{card, envelope, token, Fixture};
use super::{StartupEffectCommit, StartupEffectCommitOutcome};
use serde_json::json;
use std::{
    sync::{Arc, Barrier},
    thread,
};

fn submit(n: u8) -> StartupEffectCommit {
    StartupEffectCommit::RecordUserSubmit {
        token: token(n),
        card_id: "card".into(),
        pty_id: "pty".into(),
        at_ms: u64::from(n),
    }
}

#[test]
fn concurrent_same_token_applies_once() {
    let fixture = Fixture::new("commit-concurrency");
    fixture.seed(envelope(
        vec![card("card", Some("pty"), 0, json!([]))],
        vec![],
    ));
    let barrier = Arc::new(Barrier::new(3));
    let store = fixture.store();
    let mut workers = Vec::new();
    for _ in 0..2 {
        let barrier = barrier.clone();
        let store = store.clone();
        workers.push(thread::spawn(move || {
            barrier.wait();
            store.commit(submit(6)).unwrap()
        }));
    }
    barrier.wait();
    let outcomes: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| **outcome == StartupEffectCommitOutcome::Applied)
            .count(),
        1
    );
    assert_eq!(fixture.read()["state"]["cards"][0]["messageCount"], 1);
}

#[test]
fn concurrent_different_tokens_preserve_both_submits() {
    let fixture = Fixture::new("commit-concurrency");
    fixture.seed(envelope(
        vec![card("card", Some("pty"), 0, json!([]))],
        vec![],
    ));
    let barrier = Arc::new(Barrier::new(3));
    let store = fixture.store();
    let mut workers = Vec::new();
    for number in [7, 8] {
        let barrier = barrier.clone();
        let store = store.clone();
        workers.push(thread::spawn(move || {
            barrier.wait();
            store.commit(submit(number)).unwrap()
        }));
    }
    barrier.wait();
    let outcomes: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert!(outcomes
        .iter()
        .all(|outcome| *outcome == StartupEffectCommitOutcome::Applied));
    let card = &fixture.read()["state"]["cards"][0];
    assert_eq!(card["messageCount"], 2);
    assert_eq!(
        card["startupSideEffects"]["applied"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn same_token_different_kind_is_conflict_without_content_change() {
    let fixture = Fixture::new("commit-concurrency");
    fixture.seed(envelope(
        vec![card("card", Some("pty"), 0, json!([]))],
        vec![],
    ));
    let store = fixture.store();
    assert_eq!(
        store.commit(submit(9)).unwrap(),
        StartupEffectCommitOutcome::Applied
    );
    let before = fixture.raw();
    let binding = StartupEffectCommit::BindProviderSession {
        token: token(9),
        card_id: "card".into(),
        pty_id: "pty".into(),
        provider: "codex".into(),
        provider_session_id: "session".into(),
        at_ms: 10,
    };
    assert_eq!(
        store.commit(binding).unwrap(),
        StartupEffectCommitOutcome::Conflict
    );
    assert_eq!(fixture.raw(), before);
}
