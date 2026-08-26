use crate::provider_sessions;
use crate::terminal_startup_effect_store::{StartupEffectCommit, StartupEffectCommitOutcome};

use super::effect_ledger::{StartupSideEffectKey, StartupSideEffectKind};
use super::effects::{
    discovery_since, wait_between_attempts, StartupSideEffectDispatcher, StartupSideEffectRequest,
    DISCOVERY_ATTEMPTS,
};
use super::PtyStartupSideEffectPlan;

impl StartupSideEffectDispatcher {
    pub(crate) async fn process<F>(&self, request: StartupSideEffectRequest, notify: &F)
    where
        F: Fn() -> Result<(), String> + Send + Sync,
    {
        let provider = request.provider.as_str().to_owned();
        let key = StartupSideEffectKey {
            pty_id: request.pty_id.clone(),
            generation: request.generation.clone(),
            kind: StartupSideEffectKind::RecordUserSubmit,
        };
        let card_id = request.card_id.clone();
        let pty_id = request.pty_id.clone();
        let at_ms = request.sent_at_ms;
        let _ = self
            .commit_one(
                key,
                move |token| StartupEffectCommit::RecordUserSubmit {
                    token,
                    card_id,
                    pty_id,
                    at_ms,
                },
                notify,
            )
            .await;

        match request.side_effect_plan.clone() {
            PtyStartupSideEffectPlan::Bind {
                provider_session_id,
            } => {
                let key = StartupSideEffectKey {
                    pty_id: request.pty_id.clone(),
                    generation: request.generation.clone(),
                    kind: StartupSideEffectKind::BindProviderSession,
                };
                let card_id = request.card_id.clone();
                let pty_id = request.pty_id.clone();
                let provider = provider.clone();
                let at_ms = request.sent_at_ms;
                self.commit_one(
                    key,
                    move |token| StartupEffectCommit::BindProviderSession {
                        token,
                        card_id,
                        pty_id,
                        provider,
                        provider_session_id,
                        at_ms,
                    },
                    notify,
                )
                .await;
            }
            PtyStartupSideEffectPlan::Discover => {
                self.discover(request, provider, notify).await;
            }
        }
    }

    async fn discover<F>(&self, request: StartupSideEffectRequest, provider: String, notify: &F)
    where
        F: Fn() -> Result<(), String> + Send + Sync,
    {
        let key = StartupSideEffectKey {
            pty_id: request.pty_id.clone(),
            generation: request.generation.clone(),
            kind: StartupSideEffectKind::DiscoverProviderSession,
        };
        let token = match self.claim(key.clone()) {
            Ok(Some(token)) => token,
            Ok(None) => return,
            Err(_) => {
                tracing::warn!("terminal startup effect ledger claim failed");
                return;
            }
        };
        let since_ms = discovery_since(request.sent_at_ms);
        for attempt in 0..DISCOVERY_ATTEMPTS {
            let excluded = match self.bound_ids(provider.clone()).await {
                Ok(ids) => ids,
                Err(_) => {
                    wait_between_attempts(attempt).await;
                    continue;
                }
            };
            let found = provider_sessions::discovery::find_recent_session(
                &provider,
                &request.project_path,
                since_ms,
                &excluded,
            )
            .await
            .ok()
            .flatten();
            if let Some(session) = found.filter(|session| !session.id.is_empty()) {
                let card_id = request.card_id.clone();
                let pty_id = request.pty_id.clone();
                let provider_for_commit = provider.clone();
                let at_ms = request.sent_at_ms;
                self.commit_with_token(
                    key,
                    token,
                    move |token| StartupEffectCommit::DiscoverProviderSession {
                        token,
                        card_id,
                        pty_id,
                        provider: provider_for_commit,
                        provider_session_id: session.id,
                        at_ms,
                    },
                    notify,
                )
                .await;
                return;
            }
            wait_between_attempts(attempt).await;
        }
        self.terminal(&key, &token);
    }

    async fn commit_one<F>(
        &self,
        key: StartupSideEffectKey,
        build: F,
        notify: &(impl Fn() -> Result<(), String> + Send + Sync),
    ) -> bool
    where
        F: FnOnce(String) -> StartupEffectCommit + Send + 'static,
    {
        let token = match self.claim(key.clone()) {
            Ok(Some(token)) => token,
            Ok(None) => return true,
            Err(_) => {
                tracing::warn!("terminal startup effect ledger claim failed");
                return false;
            }
        };
        self.commit_with_token(key, token, build, notify).await
    }

    async fn commit_with_token<F>(
        &self,
        key: StartupSideEffectKey,
        token: String,
        build: F,
        notify: &(impl Fn() -> Result<(), String> + Send + Sync),
    ) -> bool
    where
        F: FnOnce(String) -> StartupEffectCommit + Send + 'static,
    {
        let effect = build(token.clone());
        let store = self.store.clone();
        let result = tokio::task::spawn_blocking(move || store.commit(effect)).await;
        match result {
            Ok(Ok(outcome)) => {
                self.terminal(&key, &token);
                if should_emit(outcome) && notify().is_err() {
                    tracing::warn!("terminal startup effect change event was not published");
                }
                true
            }
            _ => {
                self.retryable(&key, &token);
                tracing::warn!("terminal startup effect commit failed; retry remains available");
                false
            }
        }
    }

    async fn bound_ids(&self, provider: String) -> Result<Vec<String>, String> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.bound_provider_session_ids(&provider))
            .await
            .map_err(|_| "startup effect worker unavailable".to_string())?
    }
}

pub(crate) fn should_emit(outcome: StartupEffectCommitOutcome) -> bool {
    matches!(outcome, StartupEffectCommitOutcome::Applied)
}
