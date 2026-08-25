use super::effects::{
    discovery_since, StartupSideEffectRequest, DISCOVERY_ATTEMPTS, DISCOVERY_INTERVAL_MS,
    DISCOVERY_LOOKBACK_MS,
};
use super::effects_dispatch::should_emit;
use super::{AgentSessionProvider, PtyStartupSideEffectPlan};
use crate::terminal_startup_effect_store::StartupEffectCommitOutcome;

fn request(plan: PtyStartupSideEffectPlan) -> StartupSideEffectRequest {
    StartupSideEffectRequest {
        pty_id: "pty".into(),
        generation: "0123456789abcdef0123456789abcdef".into(),
        provider: AgentSessionProvider::Codex,
        card_id: "card".into(),
        project_path: "project".into(),
        sent_at_ms: 10_000,
        side_effect_plan: plan,
    }
}

#[test]
fn request_validation_rejects_empty_and_invalid_identity_fields() {
    assert!(request(PtyStartupSideEffectPlan::Discover)
        .validate()
        .is_ok());
    let mut invalid = request(PtyStartupSideEffectPlan::Discover);
    invalid.pty_id.clear();
    assert_eq!(
        invalid.validate().unwrap_err(),
        "startup_effect_pty_id_required"
    );
    let mut invalid = request(PtyStartupSideEffectPlan::Discover);
    invalid.generation = "not-a-generation".into();
    assert_eq!(
        invalid.validate().unwrap_err(),
        "startup_effect_generation_invalid"
    );
    let whitespace = request(PtyStartupSideEffectPlan::Bind {
        provider_session_id: " ".into(),
    });
    assert!(whitespace.validate().is_ok());
    let mut invalid = whitespace;
    invalid.side_effect_plan = PtyStartupSideEffectPlan::Bind {
        provider_session_id: String::new(),
    };
    assert_eq!(
        invalid.validate().unwrap_err(),
        "startup_effect_provider_session_id_required"
    );
    let mut whitespace = request(PtyStartupSideEffectPlan::Discover);
    whitespace.pty_id = " ".into();
    whitespace.card_id = " ".into();
    whitespace.project_path = " ".into();
    assert!(whitespace.validate().is_ok());
    invalid = whitespace;
    invalid.project_path.clear();
    assert_eq!(
        invalid.validate().unwrap_err(),
        "startup_effect_project_path_required"
    );
}

#[test]
fn discovery_budget_and_since_are_stable_and_saturating() {
    assert_eq!(DISCOVERY_ATTEMPTS, 12);
    assert_eq!(DISCOVERY_INTERVAL_MS, 1_500);
    assert_eq!(DISCOVERY_LOOKBACK_MS, 5_000);
    assert_eq!(discovery_since(10_000), Some(5_000));
    assert_eq!(discovery_since(4_000), Some(0));
}

#[test]
fn only_applied_commit_emits_managed_state_change() {
    assert!(should_emit(StartupEffectCommitOutcome::Applied));
    for outcome in [
        StartupEffectCommitOutcome::AlreadyApplied,
        StartupEffectCommitOutcome::Obsolete,
        StartupEffectCommitOutcome::Conflict,
    ] {
        assert!(!should_emit(outcome));
    }
}
