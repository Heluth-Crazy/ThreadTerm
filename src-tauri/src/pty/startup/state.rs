use super::types::{
    validate_generation, PtyDescriptorDisposition, PtyStartupIntent, PtyStartupSnapshot,
    PtyStartupState, PtyStartupTrigger, STARTUP_DESCRIPTOR_CONFLICT,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StartupRegistrationKind {
    LegacyUnclaimed,
    LegacyOneShot,
    Explicit,
}

pub struct PtyStartupCoordinator {
    registration: StartupRegistrationKind,
    pub(super) intent: Option<PtyStartupIntent>,
    snapshot: PtyStartupSnapshot,
}

impl PtyStartupCoordinator {
    pub fn legacy_interactive(
        pty_id: impl Into<String>,
        generation: impl Into<String>,
    ) -> Result<Self, String> {
        Self::new(
            pty_id,
            generation,
            StartupRegistrationKind::LegacyUnclaimed,
            None,
        )
    }

    pub fn legacy_one_shot(
        pty_id: impl Into<String>,
        generation: impl Into<String>,
    ) -> Result<Self, String> {
        Self::new(
            pty_id,
            generation,
            StartupRegistrationKind::LegacyOneShot,
            None,
        )
    }

    pub fn explicit(
        pty_id: impl Into<String>,
        generation: impl Into<String>,
        intent: PtyStartupIntent,
    ) -> Result<Self, String> {
        intent.validate().map_err(str::to_owned)?;
        Self::new(
            pty_id,
            generation,
            StartupRegistrationKind::Explicit,
            Some(intent),
        )
    }

    fn new(
        pty_id: impl Into<String>,
        generation: impl Into<String>,
        registration: StartupRegistrationKind,
        intent: Option<PtyStartupIntent>,
    ) -> Result<Self, String> {
        let generation = generation.into();
        validate_generation(&generation).map_err(str::to_owned)?;
        let state = match &intent {
            Some(PtyStartupIntent::Provider { .. }) => PtyStartupState::Waiting,
            _ => PtyStartupState::NotRequired,
        };
        Ok(Self {
            registration,
            intent,
            snapshot: PtyStartupSnapshot {
                pty_id: pty_id.into(),
                generation,
                revision: 0,
                state,
                trigger: None,
            },
        })
    }

    pub fn snapshot(&self) -> PtyStartupSnapshot {
        self.snapshot.clone()
    }

    pub fn observe_legacy_attach(&self) -> PtyDescriptorDisposition {
        PtyDescriptorDisposition::NotApplicable
    }

    pub fn claim(&mut self, intent: PtyStartupIntent) -> Result<PtyDescriptorDisposition, String> {
        intent.validate().map_err(str::to_owned)?;
        match self.registration {
            StartupRegistrationKind::LegacyUnclaimed => {
                if matches!(&intent, PtyStartupIntent::OneShot { .. }) {
                    return Err(STARTUP_DESCRIPTOR_CONFLICT.to_owned());
                }
                let provider = matches!(&intent, PtyStartupIntent::Provider { .. });
                self.intent = Some(intent);
                self.registration = StartupRegistrationKind::Explicit;
                if provider {
                    self.transition(PtyStartupState::Ready, Some(PtyStartupTrigger::Immediate));
                }
                Ok(PtyDescriptorDisposition::LegacyClaimed)
            }
            StartupRegistrationKind::LegacyOneShot => Err(STARTUP_DESCRIPTOR_CONFLICT.to_owned()),
            StartupRegistrationKind::Explicit => {
                if self
                    .intent
                    .as_ref()
                    .is_some_and(|existing| existing == &intent)
                {
                    Ok(PtyDescriptorDisposition::Matched)
                } else {
                    Err(STARTUP_DESCRIPTOR_CONFLICT.to_owned())
                }
            }
        }
    }

    pub fn mark_ready(&mut self, trigger: PtyStartupTrigger) -> bool {
        if !matches!(
            trigger,
            PtyStartupTrigger::Marker
                | PtyStartupTrigger::FirstOutput
                | PtyStartupTrigger::Immediate
        ) || self.snapshot.state != PtyStartupState::Waiting
        {
            return false;
        }
        self.transition(PtyStartupState::Ready, Some(trigger));
        true
    }

    pub fn deadline(&mut self) -> bool {
        if self.snapshot.state != PtyStartupState::Waiting {
            return false;
        }
        self.transition(PtyStartupState::TimedOut, Some(PtyStartupTrigger::Timeout));
        true
    }

    pub fn take_dispatch_lease(&mut self) -> bool {
        if !matches!(
            self.snapshot.state,
            PtyStartupState::Ready | PtyStartupState::TimedOut
        ) {
            return false;
        }
        self.transition(PtyStartupState::Dispatching, None);
        true
    }

    pub fn complete_dispatch(&mut self, success: bool) -> bool {
        if self.snapshot.state != PtyStartupState::Dispatching {
            return false;
        }
        let state = if success {
            PtyStartupState::Sent
        } else {
            PtyStartupState::Failed
        };
        self.transition(state, None);
        true
    }

    pub fn cancel(&mut self, trigger: PtyStartupTrigger) -> bool {
        let valid_trigger = matches!(
            trigger,
            PtyStartupTrigger::PtyExit | PtyStartupTrigger::Killed
        );
        let valid_state = matches!(
            self.snapshot.state,
            PtyStartupState::Waiting | PtyStartupState::Ready | PtyStartupState::TimedOut
        );
        if !valid_trigger || !valid_state {
            return false;
        }
        self.transition(PtyStartupState::Cancelled, Some(trigger));
        true
    }

    fn transition(&mut self, state: PtyStartupState, trigger: Option<PtyStartupTrigger>) {
        self.snapshot.state = state;
        self.snapshot.trigger = trigger.or(self.snapshot.trigger);
        self.snapshot.revision = self.snapshot.revision.saturating_add(1);
    }
}
