use serde::{Deserialize, Serialize};

use super::super::PtyLaunchDescriptor;

pub use crate::agent_sessions::types::AgentSessionProvider;

pub const STARTUP_DESCRIPTOR_CONFLICT: &str = "startup_descriptor_conflict";
pub const STARTUP_INVALID_GENERATION: &str = "startup_invalid_generation";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PtyShellFamily {
    Pwsh,
    WindowsPowerShell,
    Cmd,
    Posix,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PtyStartupState {
    NotRequired,
    Waiting,
    Ready,
    TimedOut,
    Dispatching,
    Sent,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PtyStartupTrigger {
    Marker,
    FirstOutput,
    Timeout,
    Immediate,
    PtyExit,
    Killed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyStartupSnapshot {
    pub pty_id: String,
    pub generation: String,
    pub revision: u64,
    pub state: PtyStartupState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<PtyStartupTrigger>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PtyDescriptorDisposition {
    Accepted,
    Matched,
    LegacyClaimed,
    NotApplicable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PtyCreateDisposition {
    Created,
    Attached,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyCreateSessionV2Result {
    pub pty_id: String,
    pub generation: String,
    pub disposition: PtyCreateDisposition,
    pub shell_family: PtyShellFamily,
    pub descriptor_disposition: PtyDescriptorDisposition,
    pub startup: PtyStartupSnapshot,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PtyStartupAction {
    Start,
    Resume,
    Discover,
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyStartupSideEffectPlan {
    #[serde(rename_all = "camelCase")]
    Bind {
        provider_session_id: String,
    },
    Discover,
}
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyStartupIntent {
    None,
    OneShot {
        descriptor: PtyLaunchDescriptor,
    },
    #[serde(rename_all = "camelCase")]
    Provider {
        provider: AgentSessionProvider,
        command: String,
        card_id: String,
        action: PtyStartupAction,
        side_effect_plan: PtyStartupSideEffectPlan,
    },
}

impl PtyStartupIntent {
    pub fn validate(&self) -> Result<(), &'static str> {
        let Self::Provider {
            command,
            card_id,
            side_effect_plan,
            ..
        } = self
        else {
            return Ok(());
        };
        if command.is_empty() {
            return Err("startup_command_required");
        }
        if card_id.is_empty() {
            return Err("startup_card_id_required");
        }
        if let PtyStartupSideEffectPlan::Bind {
            provider_session_id,
        } = side_effect_plan
        {
            if provider_session_id.is_empty() {
                return Err("startup_session_id_required");
            }
        }
        Ok(())
    }
}

impl PartialEq for PtyStartupIntent {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::None, Self::None) => true,
            (Self::OneShot { descriptor: left }, Self::OneShot { descriptor: right }) => {
                left.execution_mode == right.execution_mode && left.command == right.command
            }
            (
                Self::Provider {
                    provider: left_provider,
                    command: left_command,
                    card_id: left_card_id,
                    action: left_action,
                    side_effect_plan: left_plan,
                },
                Self::Provider {
                    provider: right_provider,
                    command: right_command,
                    card_id: right_card_id,
                    action: right_action,
                    side_effect_plan: right_plan,
                },
            ) => {
                left_provider == right_provider
                    && left_command == right_command
                    && left_card_id == right_card_id
                    && left_action == right_action
                    && left_plan == right_plan
            }
            _ => false,
        }
    }
}

impl Eq for PtyStartupIntent {}

pub fn validate_generation(generation: &str) -> Result<(), &'static str> {
    if generation.len() == 32
        && generation
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(STARTUP_INVALID_GENERATION)
    }
}
