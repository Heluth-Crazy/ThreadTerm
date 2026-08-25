use super::card_merge_tests::{card, projection, startup_event, submit, token};
use super::TerminalStartupEffectStore;
use crate::managed_state::{ManagedStateStore, TERMINAL_STORE_KEY};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Barrier},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

struct Fixture {
    path: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "threadterm-store-test-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }
    fn store(&self) -> TerminalStartupEffectStore {
        TerminalStartupEffectStore::new(ManagedStateStore::new(self.path.clone()))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn envelope(card: Value) -> String {
    serde_json::to_string(&json!({"state":{"cards":[card]},"version":22})).unwrap()
}
fn projected(n: u8, count: u64) -> Value {
    card(
        "card",
        "pty",
        json!(count),
        json!([startup_event(n, n as u64, "event")]),
        Some(projection(
            &token(1),
            None,
            vec![submit(n, n as u64, "present")],
        )),
    )
}

#[test]
fn raw_legacy_snapshot_is_written_byte_exactly() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let raw = " { \"state\": { \"cards\": [{\"id\":\"legacy\",\"ptyId\":\"p\"}] } } ";
    let outcome = store.merge_webview_snapshot(raw.to_string()).unwrap();
    assert!(!outcome.reconciled);
    assert_eq!(
        ManagedStateStore::new(fixture.path.clone())
            .get(TERMINAL_STORE_KEY)
            .unwrap()
            .value,
        Some(raw.to_string()),
    );
}

#[test]
fn invalid_projected_incoming_does_not_change_stored_value() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let before = envelope(projected(2, 1));
    ManagedStateStore::new(fixture.path.clone())
        .set(TERMINAL_STORE_KEY, before.clone())
        .unwrap();
    assert!(store
        .merge_webview_snapshot(envelope(card(
            "card",
            "pty",
            json!("bad"),
            json!([]),
            Some(projection(&token(1), None, vec![]))
        )))
        .is_err());
    assert_eq!(
        ManagedStateStore::new(fixture.path.clone())
            .get(TERMINAL_STORE_KEY)
            .unwrap()
            .value,
        Some(before),
    );
}

#[test]
fn concurrent_stale_snapshots_preserve_all_effects() {
    let fixture = Fixture::new();
    let managed = ManagedStateStore::new(fixture.path.clone());
    let seed = envelope(projected(2, 1));
    managed.set(TERMINAL_STORE_KEY, seed.clone()).unwrap();
    let store = fixture.store();
    let barrier = Arc::new(Barrier::new(2));
    let a = store.clone();
    let b = store.clone();
    let stale = |n: u8| {
        let event = |number: u8, at: u64| {
            json!({
                "at": at,
                "kind": "user-input",
                "summary": "Sent input",
                "summaryKey": "terminal:view.sentInput",
                "startupEffectToken": token(number),
            })
        };
        envelope(card(
            "card",
            "pty",
            json!(2),
            json!([event(2, 2), event(n, n as u64)]),
            Some(projection(
                &token(1),
                None,
                vec![submit(2, 2, "present"), submit(n, n as u64, "present")],
            )),
        ))
    };
    let x = stale(3);
    let y = stale(4);
    let h1 = thread::spawn({
        let barrier = barrier.clone();
        move || {
            barrier.wait();
            a.merge_webview_snapshot(x)
        }
    });
    let h2 = thread::spawn({
        move || {
            barrier.wait();
            b.merge_webview_snapshot(y)
        }
    });
    let outcomes = [h1.join().unwrap().unwrap(), h2.join().unwrap().unwrap()];
    assert_eq!(outcomes.iter().filter(|o| o.reconciled).count(), 1);
    let value: Value = serde_json::from_str(
        managed
            .get(TERMINAL_STORE_KEY)
            .unwrap()
            .value
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    let card = &value["state"]["cards"][0];
    assert_eq!(card["messageCount"], 3);
    let text = card.to_string();
    for n in 2..=4 {
        assert!(text.contains(&token(n)));
    }
    assert_eq!(card["events"].as_array().unwrap().len(), 3);
}

#[test]
fn initialized_tombstone_allows_first_projected_snapshot() {
    let fixture = Fixture::new();
    let managed = ManagedStateStore::new(fixture.path.clone());
    managed.set(TERMINAL_STORE_KEY, String::new()).unwrap();
    managed.remove(TERMINAL_STORE_KEY).unwrap();
    let outcome = fixture
        .store()
        .merge_webview_snapshot(envelope(projected(2, 1)))
        .unwrap();
    assert!(outcome.reconciled);
    assert!(managed
        .get(TERMINAL_STORE_KEY)
        .unwrap()
        .value
        .as_ref()
        .unwrap()
        .contains(&token(2)));
}
