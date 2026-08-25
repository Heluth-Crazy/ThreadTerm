use super::envelope_merge;
use super::{StartupEffectCommit, StartupEffectCommitOutcome};
use crate::managed_state::{ManagedStateStore, TERMINAL_STORE_KEY};
use serde_json::Value;
use std::collections::BTreeSet;

const MALFORMED_TERMINAL_STORE: &str = "terminal store is malformed";

#[derive(Clone)]
pub(crate) struct TerminalStartupEffectStore {
    managed_state: ManagedStateStore,
}

#[derive(Debug, Clone, Copy, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalSnapshotMergeOutcome {
    pub(crate) reconciled: bool,
}

impl TerminalStartupEffectStore {
    pub(crate) fn new(managed_state: ManagedStateStore) -> Self {
        Self { managed_state }
    }

    #[allow(dead_code)]
    pub(crate) fn commit(
        &self,
        effect: StartupEffectCommit,
    ) -> Result<StartupEffectCommitOutcome, String> {
        super::commit::commit(&self.managed_state, effect)
    }

    pub(crate) fn merge_webview_snapshot(
        &self,
        incoming: String,
    ) -> Result<TerminalSnapshotMergeOutcome, String> {
        self.managed_state
            .update_value(TERMINAL_STORE_KEY, |current| {
                let merged = envelope_merge::merge_snapshot(current, &incoming)?;
                Ok((
                    Some(merged.value),
                    TerminalSnapshotMergeOutcome {
                        reconciled: merged.reconciled,
                    },
                ))
            })
    }

    /// Return the currently bound provider-session ids without changing the
    /// managed terminal snapshot.  The envelope/card shape is validated by
    /// the existing parser, while optional provider fields remain compatible
    /// with older cards and are simply ignored when they do not match.
    #[allow(dead_code)]
    pub(crate) fn bound_provider_session_ids(&self, provider: &str) -> Result<Vec<String>, String> {
        if provider.is_empty() {
            return Ok(Vec::new());
        }

        let Some(raw) = self.managed_state.get(TERMINAL_STORE_KEY)?.value else {
            return Ok(Vec::new());
        };
        if raw.trim().is_empty() {
            return Ok(Vec::new());
        }

        let envelope = envelope_merge::parse_envelope(&raw, "terminal")
            .map_err(|_| MALFORMED_TERMINAL_STORE.to_string())?;
        let (cards, archived_cards) = super::envelope_card_arrays(&envelope)
            .map_err(|_| MALFORMED_TERMINAL_STORE.to_string())?;
        let mut ids = BTreeSet::new();

        for card in cards.iter().chain(archived_cards.iter()) {
            let object = card
                .as_object()
                .ok_or_else(|| MALFORMED_TERMINAL_STORE.to_string())?;
            if object.get("terminalType").and_then(Value::as_str) != Some(provider)
                || object.get("providerSessionState").and_then(Value::as_str) != Some("bound")
            {
                continue;
            }
            let Some(session_id) = object
                .get("providerSessionId")
                .and_then(Value::as_str)
                .filter(|session_id| !session_id.is_empty())
            else {
                continue;
            };
            ids.insert(session_id.to_owned());
        }

        Ok(ids.into_iter().collect())
    }
}
