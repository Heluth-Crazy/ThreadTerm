use std::sync::Arc;

use dashmap::DashMap;
use dashmap::mapref::entry::Entry;
use once_cell::sync::Lazy;

use super::session::{LivePtySessionSnapshot, PtySession};

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

pub fn list_live_sessions() -> Vec<LivePtySessionSnapshot> {
    PTY_SESSIONS
        .iter()
        .filter_map(|entry| {
            let id = entry.key().clone();
            let session = entry.value();
            let state = session.state.read().ok()?.clone();
            let recent_output = session
                .output_buffer
                .read()
                .ok()
                .map(|buffer| buffer.clone())
                .unwrap_or_default();

            Some(LivePtySessionSnapshot {
                id,
                state,
                recent_output,
            })
        })
        .collect()
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
}
