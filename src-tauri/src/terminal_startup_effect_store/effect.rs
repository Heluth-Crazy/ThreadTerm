use super::{StartupBindingState, StartupEffectKind, StartupEffectRecord, StartupTimelineState};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StartupEffectCommit {
    RecordUserSubmit {
        token: String,
        card_id: String,
        pty_id: String,
        at_ms: u64,
    },
    BindProviderSession {
        token: String,
        card_id: String,
        pty_id: String,
        provider: String,
        provider_session_id: String,
        at_ms: u64,
    },
    DiscoverProviderSession {
        token: String,
        card_id: String,
        pty_id: String,
        provider: String,
        provider_session_id: String,
        at_ms: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum StartupEffectCommitOutcome {
    Applied,
    AlreadyApplied,
    Obsolete,
    Conflict,
}

impl StartupEffectCommit {
    pub(crate) fn token(&self) -> &str {
        match self {
            Self::RecordUserSubmit { token, .. }
            | Self::BindProviderSession { token, .. }
            | Self::DiscoverProviderSession { token, .. } => token,
        }
    }

    pub(crate) fn card_id(&self) -> &str {
        match self {
            Self::RecordUserSubmit { card_id, .. }
            | Self::BindProviderSession { card_id, .. }
            | Self::DiscoverProviderSession { card_id, .. } => card_id,
        }
    }

    pub(crate) fn pty_id(&self) -> &str {
        match self {
            Self::RecordUserSubmit { pty_id, .. }
            | Self::BindProviderSession { pty_id, .. }
            | Self::DiscoverProviderSession { pty_id, .. } => pty_id,
        }
    }

    pub(crate) fn at_ms(&self) -> u64 {
        match self {
            Self::RecordUserSubmit { at_ms, .. }
            | Self::BindProviderSession { at_ms, .. }
            | Self::DiscoverProviderSession { at_ms, .. } => *at_ms,
        }
    }

    pub(super) fn kind(&self) -> StartupEffectKind {
        match self {
            Self::RecordUserSubmit { .. } => StartupEffectKind::RecordUserSubmit,
            Self::BindProviderSession { .. } => StartupEffectKind::BindProviderSession,
            Self::DiscoverProviderSession { .. } => StartupEffectKind::DiscoverProviderSession,
        }
    }

    pub(crate) fn binding_target(&self) -> Option<(&str, &str)> {
        match self {
            Self::RecordUserSubmit { .. } => None,
            Self::BindProviderSession {
                provider,
                provider_session_id,
                ..
            }
            | Self::DiscoverProviderSession {
                provider,
                provider_session_id,
                ..
            } => Some((provider, provider_session_id)),
        }
    }

    pub(crate) fn is_discovery(&self) -> bool {
        matches!(self, Self::DiscoverProviderSession { .. })
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_token(self.token())?;
        validate_nonempty(self.card_id(), "card id")?;
        validate_nonempty(self.pty_id(), "pty id")?;
        if let Some((provider, provider_session_id)) = self.binding_target() {
            validate_nonempty(provider, "provider")?;
            validate_nonempty(provider_session_id, "provider session id")?;
        }
        Ok(())
    }

    pub(super) fn to_record(&self) -> Result<StartupEffectRecord, String> {
        self.validate()?;
        let mut record = StartupEffectRecord {
            token: self.token().to_owned(),
            kind: self.kind(),
            at: self.at_ms(),
            timeline: None,
            binding: None,
        };
        match self {
            Self::RecordUserSubmit { .. } => {
                record.timeline = Some(StartupTimelineState::Present);
            }
            Self::BindProviderSession { .. } | Self::DiscoverProviderSession { .. } => {
                record.binding = Some(StartupBindingState::Active);
            }
        }
        Ok(record)
    }
}

fn validate_token(value: &str) -> Result<(), String> {
    if value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err("token must be 32 lowercase hex characters".to_string())
    }
}

fn validate_nonempty(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{field} must not be empty"))
    } else {
        Ok(())
    }
}
