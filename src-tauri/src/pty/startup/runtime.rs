use std::sync::{Mutex, MutexGuard};

use super::output::{StartupOutputConfig, StartupOutputObservation, StartupOutputObserver};
use super::state::PtyStartupCoordinator;
#[cfg(test)]
use super::types::PtyStartupAction;
use super::types::{
    AgentSessionProvider, PtyDescriptorDisposition, PtyStartupIntent, PtyStartupSideEffectPlan,
    PtyStartupSnapshot, PtyStartupState, PtyStartupTrigger,
};

pub(crate) const STARTUP_STATE_UNAVAILABLE: &str = "startup_state_unavailable";

pub(crate) struct SessionStartup {
    coordinator: Mutex<PtyStartupCoordinator>,
    output_observer: Mutex<StartupOutputObserver>,
    sent_at_ms: Mutex<Option<u64>>,
}
pub(crate) struct StartupDispatch {
    command: Vec<u8>,
    effect: StartupEffectDescriptor,
}
pub(crate) struct StartupEffectDescriptor {
    provider: AgentSessionProvider,
    card_id: String,
    #[cfg(test)]
    action: PtyStartupAction,
    side_effect_plan: PtyStartupSideEffectPlan,
}
impl SessionStartup {
    pub(crate) fn new(coordinator: PtyStartupCoordinator) -> Self {
        Self {
            coordinator: Mutex::new(coordinator),
            output_observer: Mutex::new(StartupOutputObserver::new()),
            sent_at_ms: Mutex::new(None),
        }
    }

    pub(crate) fn configure_output(&self, config: StartupOutputConfig) -> Result<(), String> {
        self.output_observer
            .lock()
            .map_err(|_| STARTUP_STATE_UNAVAILABLE.to_owned())?
            .configure(config)
    }

    #[cfg(test)]
    pub(crate) fn configure_output_passthrough(&self) -> Result<(), String> {
        self.configure_output(StartupOutputConfig::Passthrough)
    }

    #[cfg(test)]
    pub(crate) fn configure_output_marker(
        &self,
        nonce: &str,
        triggers_ready: bool,
    ) -> Result<(), String> {
        self.configure_output(StartupOutputConfig::Marker {
            nonce: nonce.to_owned(),
            triggers_ready,
        })
    }

    #[cfg(test)]
    pub(crate) fn configure_output_first_output(&self) -> Result<(), String> {
        self.configure_output(StartupOutputConfig::FirstOutput {
            triggers_ready: true,
        })
    }

    pub(crate) fn observe_output<F>(
        &self,
        bytes: &[u8],
        publish: F,
    ) -> Result<StartupOutputObservation, String>
    where
        F: FnOnce(&PtyStartupSnapshot),
    {
        let (mut observation, trigger) = {
            let mut observer = self
                .output_observer
                .lock()
                .map_err(|_| STARTUP_STATE_UNAVAILABLE.to_owned())?;
            let observation = observer.observe(bytes);
            let trigger = if observation.matched > 0 && observer.marker_triggers_ready() {
                Some(PtyStartupTrigger::Marker)
            } else if observer.first_output_triggers_ready(&observation.visible) {
                Some(PtyStartupTrigger::FirstOutput)
            } else {
                None
            };
            (observation, trigger)
        };
        observation.became_ready = trigger
            .map(|trigger| self.mark_ready(trigger, publish))
            .transpose()?
            .unwrap_or(false);
        Ok(observation)
    }

    pub(crate) fn finish_output<F>(&self, publish: F) -> Result<StartupOutputObservation, String>
    where
        F: FnOnce(&PtyStartupSnapshot),
    {
        let (mut observation, trigger) = {
            let mut observer = self
                .output_observer
                .lock()
                .map_err(|_| STARTUP_STATE_UNAVAILABLE.to_owned())?;
            let observation = observer.finish();
            let trigger = observer
                .first_output_triggers_ready(&observation.visible)
                .then_some(PtyStartupTrigger::FirstOutput);
            (observation, trigger)
        };
        observation.became_ready = trigger
            .map(|trigger| self.mark_ready(trigger, publish))
            .transpose()?
            .unwrap_or(false);
        Ok(observation)
    }

    pub(crate) fn discard_output(&self) -> Result<(), String> {
        self.output_observer
            .lock()
            .map_err(|_| STARTUP_STATE_UNAVAILABLE.to_owned())?
            .discard();
        Ok(())
    }
    pub(crate) fn snapshot(&self) -> Result<PtyStartupSnapshot, String> {
        Ok(self.lock()?.snapshot())
    }
    pub(crate) fn claim<F>(
        &self,
        intent: PtyStartupIntent,
        publish: F,
    ) -> Result<PtyDescriptorDisposition, String>
    where
        F: FnOnce(&PtyStartupSnapshot),
    {
        let (result, snapshot) = {
            let mut coordinator = self.lock()?;
            let revision = coordinator.snapshot().revision;
            let result = coordinator.claim(intent);
            let snapshot = result
                .as_ref()
                .ok()
                .and_then(|_| changed_snapshot(&coordinator, revision));
            (result, snapshot)
        };
        if let Some(snapshot) = snapshot {
            publish(&snapshot);
        }
        result
    }
    pub(crate) fn mark_ready<F>(
        &self,
        trigger: PtyStartupTrigger,
        publish: F,
    ) -> Result<bool, String>
    where
        F: FnOnce(&PtyStartupSnapshot),
    {
        let (changed, snapshot) = {
            let mut coordinator = self.lock()?;
            let revision = coordinator.snapshot().revision;
            let changed = coordinator.mark_ready(trigger);
            let snapshot = changed
                .then(|| changed_snapshot(&coordinator, revision))
                .flatten();
            (changed, snapshot)
        };
        if let Some(snapshot) = snapshot {
            publish(&snapshot);
        }
        Ok(changed)
    }
    pub(crate) fn deadline<F>(&self, publish: F) -> Result<bool, String>
    where
        F: FnOnce(&PtyStartupSnapshot),
    {
        let (changed, snapshot) = {
            let mut coordinator = self.lock()?;
            let revision = coordinator.snapshot().revision;
            let changed = coordinator.deadline();
            let snapshot = changed
                .then(|| changed_snapshot(&coordinator, revision))
                .flatten();
            (changed, snapshot)
        };
        if let Some(snapshot) = snapshot {
            publish(&snapshot);
        }
        Ok(changed)
    }
    pub(crate) fn take_dispatch<F>(&self, publish: F) -> Result<Option<StartupDispatch>, String>
    where
        F: FnOnce(&PtyStartupSnapshot),
    {
        let (dispatch, snapshot) = {
            let mut coordinator = self.lock()?;
            if !matches!(
                coordinator.snapshot().state,
                PtyStartupState::Ready | PtyStartupState::TimedOut
            ) {
                return Ok(None);
            }
            let (provider, command, card_id, _action, side_effect_plan) =
                match coordinator.intent.as_ref() {
                    Some(PtyStartupIntent::Provider {
                        provider,
                        command,
                        card_id,
                        action,
                        side_effect_plan,
                    }) => (
                        *provider,
                        command.clone(),
                        card_id.clone(),
                        *action,
                        side_effect_plan.clone(),
                    ),
                    _ => return Ok(None),
                };
            let revision = coordinator.snapshot().revision;
            if !coordinator.take_dispatch_lease() {
                return Ok(None);
            }
            let mut command_bytes = command.into_bytes();
            command_bytes.push(b'\r');
            let dispatch = StartupDispatch {
                command: command_bytes,
                effect: StartupEffectDescriptor {
                    provider,
                    card_id,
                    #[cfg(test)]
                    action: _action,
                    side_effect_plan,
                },
            };
            (Some(dispatch), changed_snapshot(&coordinator, revision))
        };
        if let Some(snapshot) = snapshot {
            publish(&snapshot);
        }
        Ok(dispatch)
    }
    pub(crate) fn complete_dispatch<F>(&self, success: bool, publish: F) -> Result<bool, String>
    where
        F: FnOnce(&PtyStartupSnapshot),
    {
        let (changed, snapshot) = {
            let mut coordinator = self.lock()?;
            let revision = coordinator.snapshot().revision;
            let changed = coordinator.complete_dispatch(success);
            let snapshot = changed
                .then(|| changed_snapshot(&coordinator, revision))
                .flatten();
            (changed, snapshot)
        };
        if let Some(snapshot) = snapshot {
            publish(&snapshot);
        }
        Ok(changed)
    }

    /// The timestamp is recorded only after the startup bytes fully commit.
    /// It is deliberately separate from the privacy-safe startup snapshot so
    /// retrying a process-owned product effect keeps one stable discovery key.
    pub(crate) fn record_sent_at_ms(&self, sent_at_ms: u64) -> Result<u64, String> {
        let mut recorded = self
            .sent_at_ms
            .lock()
            .map_err(|_| STARTUP_STATE_UNAVAILABLE.to_owned())?;
        Ok(*recorded.get_or_insert(sent_at_ms))
    }

    pub(crate) fn sent_at_ms(&self) -> Result<Option<u64>, String> {
        self.sent_at_ms
            .lock()
            .map(|recorded| *recorded)
            .map_err(|_| STARTUP_STATE_UNAVAILABLE.to_owned())
    }

    pub(crate) fn sent_effect(&self) -> Result<Option<StartupEffectDescriptor>, String> {
        let coordinator = self.lock()?;
        if coordinator.snapshot().state != PtyStartupState::Sent {
            return Ok(None);
        }
        Ok(effect_from_coordinator(&coordinator))
    }
    pub(crate) fn cancel<F>(&self, trigger: PtyStartupTrigger, publish: F) -> Result<bool, String>
    where
        F: FnOnce(&PtyStartupSnapshot),
    {
        let (changed, snapshot) = {
            let mut coordinator = self.lock()?;
            let revision = coordinator.snapshot().revision;
            let changed = coordinator.cancel(trigger);
            let snapshot = changed
                .then(|| changed_snapshot(&coordinator, revision))
                .flatten();
            (changed, snapshot)
        };
        if let Some(snapshot) = snapshot {
            publish(&snapshot);
        }
        Ok(changed)
    }

    fn lock(&self) -> Result<MutexGuard<'_, PtyStartupCoordinator>, String> {
        self.coordinator
            .lock()
            .map_err(|_| STARTUP_STATE_UNAVAILABLE.to_owned())
    }
}

fn effect_from_coordinator(coordinator: &PtyStartupCoordinator) -> Option<StartupEffectDescriptor> {
    match coordinator.intent.as_ref()? {
        PtyStartupIntent::Provider {
            provider,
            card_id,
            action: _action,
            side_effect_plan,
            ..
        } => Some(StartupEffectDescriptor {
            provider: *provider,
            card_id: card_id.clone(),
            #[cfg(test)]
            action: *_action,
            side_effect_plan: side_effect_plan.clone(),
        }),
        _ => None,
    }
}
fn changed_snapshot(
    coordinator: &PtyStartupCoordinator,
    previous_revision: u64,
) -> Option<PtyStartupSnapshot> {
    let snapshot = coordinator.snapshot();
    (snapshot.revision != previous_revision).then_some(snapshot)
}
impl StartupDispatch {
    pub(crate) fn command_bytes(&self) -> &[u8] {
        &self.command
    }

    pub(crate) fn effect(&self) -> &StartupEffectDescriptor {
        &self.effect
    }
}

impl StartupEffectDescriptor {
    pub(crate) fn provider(&self) -> AgentSessionProvider {
        self.provider
    }

    pub(crate) fn card_id(&self) -> &str {
        &self.card_id
    }

    #[cfg(test)]
    pub(crate) fn action(&self) -> PtyStartupAction {
        self.action
    }

    pub(crate) fn side_effect_plan(&self) -> &PtyStartupSideEffectPlan {
        &self.side_effect_plan
    }
}
