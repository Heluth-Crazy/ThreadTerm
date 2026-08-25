mod dispatch;
mod effect_ledger;
mod effects;
mod effects_dispatch;
mod event;
mod marker;
mod output;
mod policy;
mod request;
mod runtime;
mod state;
mod token;
mod types;

#[cfg(not(feature = "terminal-startup-harness"))]
pub(super) use dispatch::arm_startup;
#[cfg(feature = "terminal-startup-harness")]
pub(super) use dispatch::{arm_startup_with_harness, drive_harness_case};
pub(super) use dispatch::{dispatch_if_ready, resubmit_sent_effects};
#[cfg(test)]
pub(super) use event::generation_matches;
pub(super) use event::{emit_startup_state, snapshot_for_generation};

pub(crate) use effects::{StartupSideEffectDispatcher, StartupSideEffectRequest};
#[cfg(test)]
pub(super) use marker::STARTUP_MARKER_INVALID;
pub(super) use output::{StartupOutputConfig, StartupOutputObservation};
#[cfg(test)]
pub(super) use policy::clamp_powershell_timeout_ms;
pub use policy::{
    classify_shell_family, parse_readiness_flag, provider_shell_ready_enabled,
    startup_readiness_policy, StartupReadinessPolicy,
};
pub use request::PtyCreateSessionV2Request;
pub(super) use runtime::{SessionStartup, StartupEffectDescriptor};
pub use state::PtyStartupCoordinator;
pub use token::mint_generation;
pub use types::{
    validate_generation, AgentSessionProvider, PtyCreateDisposition, PtyCreateSessionV2Result,
    PtyDescriptorDisposition, PtyShellFamily, PtyStartupAction, PtyStartupIntent,
    PtyStartupSideEffectPlan, PtyStartupSnapshot, PtyStartupState, PtyStartupTrigger,
    STARTUP_DESCRIPTOR_CONFLICT, STARTUP_INVALID_GENERATION,
};

#[cfg(test)]
mod claim_tests;
#[cfg(test)]
mod dispatch_tests;
#[cfg(test)]
mod effect_ledger_tests;
#[cfg(test)]
mod effects_tests;
#[cfg(test)]
mod event_tests;
#[cfg(test)]
mod marker_tests;
#[cfg(test)]
mod output_tests;
#[cfg(test)]
mod policy_tests;
#[cfg(test)]
mod request_tests;
#[cfg(test)]
mod runtime_tests;
#[cfg(test)]
mod token_tests;
#[cfg(test)]
mod transition_tests;
