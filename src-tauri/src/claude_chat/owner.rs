//! Single-active-owner registry for Claude sessions (design D4).
//!
//! A Claude session id may be attached to at most one live surface at a time:
//! either a chat card (SDK sidecar) or a PTY terminal. Acquiring an owned
//! session returns the current owner so callers can surface an actionable
//! conflict instead of double-attaching. This task wires the chat side; the
//! PTY side joins in the session-handover task.

use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
// The Pty variant and owner_of are wired up by the session-handover task (③);
// until then only tests construct them.
#[allow(dead_code)]
pub(crate) enum SessionOwner {
    Chat { card_id: String },
    Pty { pty_id: String },
}

static OWNERS: Lazy<Mutex<HashMap<String, SessionOwner>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Attach `owner` to `session_id`. Idempotent for the same owner; returns the
/// existing owner on conflict.
pub(crate) fn acquire(session_id: &str, owner: SessionOwner) -> Result<(), SessionOwner> {
    let mut owners = OWNERS.lock().expect("session owner registry poisoned");
    match owners.get(session_id) {
        Some(existing) if *existing != owner => Err(existing.clone()),
        _ => {
            owners.insert(session_id.to_owned(), owner);
            Ok(())
        }
    }
}

/// Detach `owner` from `session_id`. A no-op when someone else holds it, so a
/// stale release can never free a session another surface re-acquired.
pub(crate) fn release(session_id: &str, owner: &SessionOwner) {
    let mut owners = OWNERS.lock().expect("session owner registry poisoned");
    if owners.get(session_id) == Some(owner) {
        owners.remove(session_id);
    }
}

/// Session-id rotation on resume (design P0-2): move the owner's claim from
/// the pre-resume id to the id the resumed session actually reports.
pub(crate) fn rebind(
    old_session_id: Option<&str>,
    new_session_id: &str,
    owner: SessionOwner,
) -> Result<(), SessionOwner> {
    if old_session_id == Some(new_session_id) {
        return acquire(new_session_id, owner);
    }
    if let Some(old) = old_session_id {
        release(old, &owner);
    }
    acquire(new_session_id, owner)
}

#[allow(dead_code)] // consumed by the session-handover task (③); tested here
pub(crate) fn owner_of(session_id: &str) -> Option<SessionOwner> {
    OWNERS
        .lock()
        .expect("session owner registry poisoned")
        .get(session_id)
        .cloned()
}

pub(crate) fn describe(owner: &SessionOwner) -> String {
    match owner {
        SessionOwner::Chat { card_id } => format!("chat card {card_id}"),
        SessionOwner::Pty { pty_id } => format!("terminal {pty_id}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(card: &str) -> SessionOwner {
        SessionOwner::Chat {
            card_id: card.to_owned(),
        }
    }

    fn pty(id: &str) -> SessionOwner {
        SessionOwner::Pty {
            pty_id: id.to_owned(),
        }
    }

    #[test]
    fn acquire_is_idempotent_for_the_same_owner_and_rejects_conflicts() {
        let session = "owner-test-a";
        assert!(acquire(session, chat("c1")).is_ok());
        assert!(acquire(session, chat("c1")).is_ok());
        assert_eq!(acquire(session, pty("p1")), Err(chat("c1")));
        release(session, &chat("c1"));
        assert!(acquire(session, pty("p1")).is_ok());
        release(session, &pty("p1"));
    }

    #[test]
    fn release_ignores_non_owners() {
        let session = "owner-test-b";
        assert!(acquire(session, chat("c1")).is_ok());
        release(session, &pty("p9"));
        assert_eq!(owner_of(session), Some(chat("c1")));
        release(session, &chat("c1"));
        assert_eq!(owner_of(session), None);
    }

    #[test]
    fn rebind_moves_the_claim_across_rotated_ids() {
        let owner = chat("c2");
        assert!(acquire("owner-test-old", owner.clone()).is_ok());
        assert!(rebind(Some("owner-test-old"), "owner-test-new", owner.clone()).is_ok());
        assert_eq!(owner_of("owner-test-old"), None);
        assert_eq!(owner_of("owner-test-new"), Some(owner.clone()));
        assert!(rebind(Some("owner-test-new"), "owner-test-new", owner.clone()).is_ok());
        release("owner-test-new", &owner);
    }

    #[test]
    fn rebind_fails_when_the_new_id_is_taken_and_keeps_the_conflict_owner() {
        let session_new = "owner-test-taken";
        assert!(acquire(session_new, pty("p2")).is_ok());
        assert_eq!(
            rebind(Some("owner-test-any"), session_new, chat("c3")),
            Err(pty("p2"))
        );
        assert_eq!(owner_of(session_new), Some(pty("p2")));
        release(session_new, &pty("p2"));
    }
}
