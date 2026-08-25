use std::collections::HashMap;

use super::mint_generation;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum StartupSideEffectKind {
    RecordUserSubmit,
    BindProviderSession,
    DiscoverProviderSession,
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct StartupSideEffectKey {
    pub(crate) pty_id: String,
    pub(crate) generation: String,
    pub(crate) kind: StartupSideEffectKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LedgerState {
    Running,
    Retryable,
    Terminal,
}

struct LedgerEntry {
    token: String,
    state: LedgerState,
}

pub(crate) enum LedgerClaim {
    Start(String),
    Skip,
}

pub(crate) struct StartupEffectLedger {
    entries: HashMap<StartupSideEffectKey, LedgerEntry>,
}

impl StartupEffectLedger {
    pub(crate) fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    pub(crate) fn claim(&mut self, key: StartupSideEffectKey) -> Result<LedgerClaim, String> {
        if let Some(entry) = self.entries.get_mut(&key) {
            return match entry.state {
                LedgerState::Running | LedgerState::Terminal => Ok(LedgerClaim::Skip),
                LedgerState::Retryable => {
                    entry.state = LedgerState::Running;
                    Ok(LedgerClaim::Start(entry.token.clone()))
                }
            };
        }

        let token = mint_generation()?;
        self.entries.insert(
            key,
            LedgerEntry {
                token: token.clone(),
                state: LedgerState::Running,
            },
        );
        Ok(LedgerClaim::Start(token))
    }

    pub(crate) fn mark_retryable(&mut self, key: &StartupSideEffectKey, token: &str) {
        if let Some(entry) = self.entries.get_mut(key) {
            if entry.token == token && entry.state == LedgerState::Running {
                entry.state = LedgerState::Retryable;
            }
        }
    }

    pub(crate) fn mark_terminal(&mut self, key: &StartupSideEffectKey, token: &str) {
        if let Some(entry) = self.entries.get_mut(key) {
            if entry.token == token && entry.state == LedgerState::Running {
                entry.state = LedgerState::Terminal;
            }
        }
    }
}
