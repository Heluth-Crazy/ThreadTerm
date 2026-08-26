use std::sync::{Arc, Mutex};

use crate::managed_state::ManagedStateStore;
use crate::terminal_startup_effect_store::TerminalStartupEffectStore;

use super::effect_ledger::{LedgerClaim, StartupEffectLedger, StartupSideEffectKey};
use super::{validate_generation, AgentSessionProvider, PtyStartupSideEffectPlan};

pub(crate) const DISCOVERY_ATTEMPTS: usize = 12;
pub(crate) const DISCOVERY_INTERVAL_MS: u64 = 1_500;
pub(crate) const DISCOVERY_LOOKBACK_MS: u64 = 5_000;

#[derive(Clone)]
pub struct StartupSideEffectRequest {
    pub pty_id: String,
    pub generation: String,
    pub provider: AgentSessionProvider,
    pub card_id: String,
    pub project_path: String,
    pub sent_at_ms: u64,
    pub side_effect_plan: PtyStartupSideEffectPlan,
}

impl StartupSideEffectRequest {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.pty_id.is_empty() {
            return Err("startup_effect_pty_id_required".into());
        }
        validate_generation(&self.generation)
            .map_err(|_| "startup_effect_generation_invalid".to_string())?;
        if self.card_id.is_empty() {
            return Err("startup_effect_card_id_required".into());
        }
        if self.project_path.is_empty() {
            return Err("startup_effect_project_path_required".into());
        }
        if let PtyStartupSideEffectPlan::Bind {
            provider_session_id,
        } = &self.side_effect_plan
        {
            if provider_session_id.is_empty() {
                return Err("startup_effect_provider_session_id_required".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct StartupSideEffectDispatcher {
    pub(crate) store: TerminalStartupEffectStore,
    pub(crate) ledger: Arc<Mutex<StartupEffectLedger>>,
}

impl StartupSideEffectDispatcher {
    pub(crate) fn new(managed_state: ManagedStateStore) -> Self {
        Self {
            store: TerminalStartupEffectStore::new(managed_state),
            ledger: Arc::new(Mutex::new(StartupEffectLedger::new())),
        }
    }

    pub(super) fn claim(&self, key: StartupSideEffectKey) -> Result<Option<String>, String> {
        let mut ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match ledger.claim(key) {
            Ok(LedgerClaim::Start(token)) => Ok(Some(token)),
            Ok(LedgerClaim::Skip) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub(super) fn retryable(&self, key: &StartupSideEffectKey, token: &str) {
        let mut ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ledger.mark_retryable(key, token);
    }

    pub(super) fn terminal(&self, key: &StartupSideEffectKey, token: &str) {
        let mut ledger = self
            .ledger
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ledger.mark_terminal(key, token);
    }
}

pub(crate) fn discovery_since(sent_at_ms: u64) -> Option<u64> {
    Some(sent_at_ms.saturating_sub(DISCOVERY_LOOKBACK_MS))
}

pub(super) async fn wait_between_attempts(attempt: usize) {
    if attempt + 1 < DISCOVERY_ATTEMPTS {
        tokio::time::sleep(std::time::Duration::from_millis(DISCOVERY_INTERVAL_MS)).await;
    }
}
