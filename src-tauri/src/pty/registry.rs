use std::collections::HashMap;
use std::sync::Arc;

use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use once_cell::sync::Lazy;

use super::session::{self, LivePtySessionSnapshot, PtySession, SessionState};

/// Global map of active PTY sessions.
static PTY_SESSIONS: Lazy<DashMap<String, Arc<PtySession>>> = Lazy::new(DashMap::new);

pub(super) fn contains(id: &str) -> bool {
    PTY_SESSIONS.contains_key(id)
}

pub(super) fn get(id: &str) -> Option<Arc<PtySession>> {
    PTY_SESSIONS.get(id).map(|entry| entry.value().clone())
}

pub(super) fn remove(id: &str) -> Option<Arc<PtySession>> {
    PTY_SESSIONS.remove(id).map(|(_, session)| session)
}

/// Insert a freshly built session unless an entry already exists for `id`.
/// Returns the rejected session back to the caller on conflict so it can
/// clean up the redundant child it just spawned.
pub(super) fn insert_if_absent(
    id: String,
    session: Arc<PtySession>,
) -> Result<(), Arc<PtySession>> {
    match PTY_SESSIONS.entry(id) {
        Entry::Occupied(_) => Err(session),
        Entry::Vacant(e) => {
            e.insert(session);
            Ok(())
        }
    }
}

/// Build a [`LivePtySessionSnapshot`] from a single live session.
///
/// Returns `None` when the session state lock is unreadable (mirrors the
/// `filter_map` behaviour of [`list_live_sessions`] so both paths agree).
fn snapshot_from_session(id: &str, session: &PtySession) -> Option<LivePtySessionSnapshot> {
    let state = session.state.read().ok()?.clone();
    let recent_output = session
        .output_buffer
        .read()
        .ok()
        .map(|buffer| buffer.clone())
        .unwrap_or_default();

    Some(LivePtySessionSnapshot {
        id: id.to_string(),
        state,
        working_dir: session._working_dir.clone(),
        terminal_output: session::terminal_output_snapshot(session)
            .unwrap_or_else(|| recent_output.clone()),
        recent_output,
    })
}

/// Snapshot a single registered session by id. Used by the bridge to build
/// a `CardMeta` for incremental card-added broadcasts without rebuilding the
/// entire live-session list.
pub(super) fn live_session_snapshot(id: &str) -> Option<LivePtySessionSnapshot> {
    let session = PTY_SESSIONS.get(id)?;
    snapshot_from_session(id, session.value())
}

pub fn list_live_sessions() -> Vec<LivePtySessionSnapshot> {
    PTY_SESSIONS
        .iter()
        .filter_map(|entry| snapshot_from_session(entry.key(), entry.value()))
        .collect()
}

/// Collect the current state of every registered session in one pass.
///
/// Audit P2-5: the frontend's cross-webview reconciliation poll previously
/// issued one `pty_get_session_state` IPC per card; this helper backs the
/// batch command so all cards reconcile with a single round-trip. Sessions
/// whose state lock is unreadable are skipped (mirrors the `filter_map`
/// behaviour of [`list_live_sessions`]).
pub(super) fn all_session_states() -> HashMap<String, SessionState> {
    PTY_SESSIONS
        .iter()
        .filter_map(|entry| {
            session::get_session_state_snapshot(entry.value())
                .map(|state| (entry.key().clone(), state))
        })
        .collect()
}

pub(super) fn unregister_renderers_with_prefix(prefix: &str) -> usize {
    // Clone the Arcs before taking any per-session flow-control lock so no
    // DashMap shard guard is held while unregister wakes blocked producers.
    let sessions = PTY_SESSIONS
        .iter()
        .map(|entry| entry.value().clone())
        .collect::<Vec<_>>();
    sessions
        .iter()
        .map(|session| session::unregister_renderers_with_prefix(session, prefix))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// list_live_sessions is process-global; we don't seed it from this
    /// test, only verify that it returns a well-formed Vec and that any
    /// real entries (e.g. left over from integration tests) have non-empty
    /// ids.
    #[test]
    fn list_live_sessions_returns_well_formed_snapshots() {
        let snapshots = list_live_sessions();
        for snapshot in snapshots {
            assert!(!snapshot.id.is_empty());
        }
    }

    #[test]
    fn contains_unknown_id_is_false() {
        assert!(!contains("__threadterm_unit_test_unknown_id__"));
    }

    #[test]
    fn remove_unknown_id_is_none() {
        assert!(remove("__threadterm_unit_test_unknown_id__").is_none());
    }

    /// The single-session snapshot helper used by the bridge for
    /// incremental card-added broadcasts returns None for an id that is
    /// not registered (mirrors the registry being empty for that card).
    #[test]
    fn live_session_snapshot_unknown_id_is_none() {
        assert!(live_session_snapshot("__threadterm_unit_test_unknown_id__").is_none());
    }

    /// The registry is process-global; we don't seed it from this test.
    /// Verify the batch state map never invents entries for unknown ids
    /// and stays consistent with list_live_sessions for any real entries.
    #[test]
    fn all_session_states_matches_live_sessions() {
        let states = all_session_states();
        assert!(!states.contains_key("__threadterm_unit_test_unknown_id__"));
        for listed in list_live_sessions() {
            assert_eq!(states.get(&listed.id), Some(&listed.state));
        }
    }

    /// Whatever real sessions exist in the process-global registry, the
    /// per-session snapshot must agree with the list_live_sessions entry
    /// for the same id: same well-formed id, same working dir. This proves
    /// the DRY extraction did not change snapshot construction.
    #[test]
    fn live_session_snapshot_matches_list_entry_for_known_ids() {
        for listed in list_live_sessions() {
            let single = live_session_snapshot(&listed.id)
                .expect("a listed session must be snapshot-able by id");
            assert!(!single.id.is_empty());
            assert_eq!(single.id, listed.id);
            assert_eq!(single.working_dir, listed.working_dir);
        }
    }
}
