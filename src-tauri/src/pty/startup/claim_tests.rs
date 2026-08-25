use super::{
    AgentSessionProvider, PtyDescriptorDisposition, PtyShellFamily, PtyStartupAction,
    PtyStartupCoordinator, PtyStartupIntent, PtyStartupSideEffectPlan, PtyStartupState,
    PtyStartupTrigger, STARTUP_DESCRIPTOR_CONFLICT,
};
use crate::pty::PtyLaunchDescriptor;

const GENERATION: &str = "0123456789abcdef0123456789abcdef";

fn provider(command: &str, card_id: &str, session_id: &str) -> PtyStartupIntent {
    PtyStartupIntent::Provider {
        provider: AgentSessionProvider::Codex,
        command: command.to_owned(),
        card_id: card_id.to_owned(),
        action: PtyStartupAction::Start,
        side_effect_plan: PtyStartupSideEffectPlan::Bind {
            provider_session_id: session_id.to_owned(),
        },
    }
}

fn one_shot(command: &str) -> PtyStartupIntent {
    PtyStartupIntent::OneShot {
        descriptor: PtyLaunchDescriptor {
            execution_mode: Some("oneShot".to_owned()),
            command: Some(command.to_owned()),
        },
    }
}

#[test]
fn all_registration_seeds_start_at_revision_zero() {
    let legacy = PtyStartupCoordinator::legacy_interactive("pty", GENERATION).unwrap();
    assert_eq!(legacy.snapshot().state, PtyStartupState::NotRequired);
    assert_eq!(legacy.snapshot().revision, 0);

    for intent in [PtyStartupIntent::None, one_shot("run")].into_iter() {
        let explicit = PtyStartupCoordinator::explicit("pty", GENERATION, intent).unwrap();
        assert_eq!(explicit.snapshot().state, PtyStartupState::NotRequired);
    }
    let provider_state =
        PtyStartupCoordinator::explicit("pty", GENERATION, provider("run", "card", "sid")).unwrap();
    assert_eq!(provider_state.snapshot().state, PtyStartupState::Waiting);
}
#[test]
fn legacy_claim_matrix_and_attach_are_first_writer_safe() {
    let mut legacy = PtyStartupCoordinator::legacy_interactive("pty", GENERATION).unwrap();
    assert_eq!(
        legacy.observe_legacy_attach(),
        PtyDescriptorDisposition::NotApplicable
    );
    assert_eq!(
        legacy.claim(provider("run", "card", "sid")).unwrap(),
        PtyDescriptorDisposition::LegacyClaimed
    );
    assert_eq!(legacy.snapshot().state, PtyStartupState::Ready);
    assert_eq!(
        legacy.snapshot().trigger,
        Some(PtyStartupTrigger::Immediate)
    );
    assert_eq!(legacy.snapshot().revision, 1);

    let mut none = PtyStartupCoordinator::legacy_interactive("pty", GENERATION).unwrap();
    assert_eq!(
        none.claim(PtyStartupIntent::None).unwrap(),
        PtyDescriptorDisposition::LegacyClaimed
    );
    assert_eq!(none.snapshot().state, PtyStartupState::NotRequired);
    assert_eq!(none.snapshot().revision, 0);
    assert_eq!(
        none.claim(provider("run", "card", "sid")).unwrap_err(),
        STARTUP_DESCRIPTOR_CONFLICT
    );

    let mut interactive = PtyStartupCoordinator::legacy_interactive("pty", GENERATION).unwrap();
    assert_eq!(
        interactive.claim(one_shot("run")).unwrap_err(),
        STARTUP_DESCRIPTOR_CONFLICT
    );
    let mut legacy_one_shot = PtyStartupCoordinator::legacy_one_shot("pty", GENERATION).unwrap();
    assert_eq!(
        legacy_one_shot.claim(PtyStartupIntent::None).unwrap_err(),
        STARTUP_DESCRIPTOR_CONFLICT
    );
}
#[test]
fn explicit_claims_match_only_byte_exact_intents() {
    let base = provider("run  ", "Card", "session");
    let mut coordinator = PtyStartupCoordinator::explicit("pty", GENERATION, base.clone()).unwrap();
    assert_eq!(
        coordinator.claim(base).unwrap(),
        PtyDescriptorDisposition::Matched
    );
    assert_eq!(coordinator.snapshot().revision, 0);

    let variants = [
        provider("run", "Card", "session"),
        provider("run  ", "card", "session"),
        provider("run  ", "Card", "Session"),
        PtyStartupIntent::Provider {
            provider: AgentSessionProvider::Claude,
            command: "run  ".to_owned(),
            card_id: "Card".to_owned(),
            action: PtyStartupAction::Start,
            side_effect_plan: PtyStartupSideEffectPlan::Bind {
                provider_session_id: "session".to_owned(),
            },
        },
        PtyStartupIntent::Provider {
            provider: AgentSessionProvider::Codex,
            command: "run  ".to_owned(),
            card_id: "Card".to_owned(),
            action: PtyStartupAction::Resume,
            side_effect_plan: PtyStartupSideEffectPlan::Bind {
                provider_session_id: "session".to_owned(),
            },
        },
        PtyStartupIntent::Provider {
            provider: AgentSessionProvider::Codex,
            command: "run  ".to_owned(),
            card_id: "Card".to_owned(),
            action: PtyStartupAction::Start,
            side_effect_plan: PtyStartupSideEffectPlan::Discover,
        },
    ];
    for variant in variants {
        assert_eq!(
            coordinator.claim(variant).unwrap_err(),
            STARTUP_DESCRIPTOR_CONFLICT
        );
        assert_eq!(coordinator.snapshot().revision, 0);
    }
}
#[test]
fn intent_validation_rejects_empty_sensitive_fields_without_normalizing() {
    assert!(provider("", "card", "sid").validate().is_err());
    assert!(provider("run", "", "sid").validate().is_err());
    assert!(provider("run", "card", "").validate().is_err());
    assert!(provider(" ", " card ", " sid ").validate().is_ok());
    let invalid = PtyStartupCoordinator::explicit(
        "pty",
        "ABCDEF0123456789ABCDEF0123456789",
        PtyStartupIntent::None,
    );
    assert!(invalid.is_err());
}
#[test]
fn serde_wire_names_match_the_additive_contract() {
    assert_eq!(
        serde_json::to_string(&PtyShellFamily::WindowsPowerShell).unwrap(),
        "\"windowsPowerShell\""
    );
    let provider: PtyStartupIntent = serde_json::from_str(
        r#"{"kind":"provider","provider":"opencode","command":"run","cardId":"card","action":"discover","sideEffectPlan":{"kind":"bind","providerSessionId":"sid"}}"#,
    )
    .unwrap();
    assert!(matches!(
        provider,
        PtyStartupIntent::Provider {
            provider: AgentSessionProvider::Opencode,
            ..
        }
    ));
    let one_shot: PtyStartupIntent = serde_json::from_str(
        r#"{"kind":"oneShot","descriptor":{"executionMode":"oneShot","command":"run"}}"#,
    )
    .unwrap();
    assert!(matches!(one_shot, PtyStartupIntent::OneShot { .. }));
}
