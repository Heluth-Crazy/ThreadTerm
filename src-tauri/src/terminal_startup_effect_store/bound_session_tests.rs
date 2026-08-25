use super::*;
use crate::managed_state::{ManagedStateStore, TERMINAL_STORE_KEY};
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

const MALFORMED_TERMINAL_STORE: &str = "terminal store is malformed";

struct Fixture {
    path: PathBuf,
    store: TerminalStartupEffectStore,
}

impl Fixture {
    fn from_raw(raw: Option<&str>) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "threadterm-bound-session-test-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("test state directory");
        let managed = ManagedStateStore::new(path.clone());
        if let Some(raw) = raw {
            managed
                .set(TERMINAL_STORE_KEY, raw.to_string())
                .expect("seed terminal state");
        }
        Self {
            path,
            store: TerminalStartupEffectStore::new(managed),
        }
    }

    fn raw(&self) -> Option<String> {
        ManagedStateStore::new(self.path.clone())
            .get(TERMINAL_STORE_KEY)
            .expect("read terminal state")
            .value
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn envelope(cards: Value, archived_cards: Option<Value>) -> String {
    let mut state = json!({"cards": cards});
    if let Some(archived_cards) = archived_cards {
        state["archivedCards"] = archived_cards;
    }
    serde_json::to_string(&json!({"state": state, "version": 22})).expect("encode envelope")
}

#[test]
fn collects_active_and_archived_bound_ids_sorted_and_exactly() {
    let raw = envelope(
        json!([
            {"id": "a", "terminalType": "claude", "providerSessionState": "bound", "providerSessionId": "z"},
            {"id": "b", "terminalType": "claude", "providerSessionState": "bound", "providerSessionId": "a"},
            {"id": "c", "terminalType": "claude", "providerSessionState": "unbound", "providerSessionId": "ignore"},
            {"id": "d", "terminalType": "claude", "providerSessionState": "bound", "providerSessionId": ""},
            {"id": "e", "terminalType": "Claude", "providerSessionState": "bound", "providerSessionId": "case"}
        ]),
        Some(json!([
            {"id": "f", "terminalType": "claude", "providerSessionState": "bound", "providerSessionId": "a"},
            {"id": "g", "terminalType": "codex", "providerSessionState": "bound", "providerSessionId": "other"},
            {"id": "h", "terminalType": "claude", "providerSessionState": "bound", "providerSessionId": "archived"}
        ])),
    );
    let fixture = Fixture::from_raw(Some(&raw));

    assert_eq!(
        fixture
            .store
            .bound_provider_session_ids("claude")
            .expect("bound ids"),
        vec!["a", "archived", "z"]
    );
    assert_eq!(
        fixture
            .store
            .bound_provider_session_ids("Claude")
            .expect("case-sensitive ids"),
        vec!["case"]
    );
    assert!(fixture
        .store
        .bound_provider_session_ids("CLAUDE")
        .expect("case-sensitive miss")
        .is_empty());
    assert_eq!(fixture.raw(), Some(raw));
}

#[test]
fn missing_blank_legacy_fields_and_empty_provider_are_empty() {
    assert!(Fixture::from_raw(None)
        .store
        .bound_provider_session_ids("claude")
        .expect("missing store")
        .is_empty());
    assert!(Fixture::from_raw(Some(" \n\t"))
        .store
        .bound_provider_session_ids("claude")
        .expect("blank store")
        .is_empty());

    let legacy = envelope(json!([{"id": "legacy", "terminalType": "shell"}]), None);
    let fixture = Fixture::from_raw(Some(&legacy));
    assert!(fixture
        .store
        .bound_provider_session_ids("claude")
        .expect("legacy card")
        .is_empty());
    let malformed = Fixture::from_raw(Some("null"));
    assert!(malformed
        .store
        .bound_provider_session_ids("")
        .expect("empty provider short-circuit")
        .is_empty());
}

#[test]
fn malformed_envelope_or_card_fails_closed_with_safe_error() {
    for raw in [
        "null",
        r#"{"state":{"cards":{}}}"#,
        r#"{"state":{"cards":[null]}}"#,
        r#"{"state":{"cards":[{"id":7}]}}"#,
        r#"{"state":{"cards":[],"archivedCards":{}}}"#,
    ] {
        let fixture = Fixture::from_raw(Some(raw));
        let error = fixture
            .store
            .bound_provider_session_ids("claude")
            .expect_err("malformed terminal state");
        assert_eq!(error, MALFORMED_TERMINAL_STORE);
        assert!(!error.contains("command"));
        assert!(!error.contains("cwd"));
        assert!(!error.contains("card"));
    }
}
