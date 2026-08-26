use super::{generation_matches, snapshot_for_generation};
use crate::pty::{
    AgentSessionProvider, PtyDescriptorDisposition, PtyStartupAction, PtyStartupIntent,
    PtyStartupSideEffectPlan, PtyStartupSnapshot, PtyStartupState, PtyStartupTrigger,
    STARTUP_DESCRIPTOR_CONFLICT, STARTUP_INVALID_GENERATION,
};

const GENERATION: &str = "0123456789abcdef0123456789abcdef";

#[test]
fn generation_match_and_stale_snapshot_helper_are_generation_scoped() {
    assert!(generation_matches(GENERATION, GENERATION));
    assert!(!generation_matches(GENERATION, "f".repeat(32).as_str()));

    let stale = snapshot_for_generation(GENERATION, &"f".repeat(32), || {
        panic!("stale generations must not read the runtime")
    })
    .expect("stale lookup should succeed");
    assert_eq!(stale, None);

    let snapshot = PtyStartupSnapshot {
        pty_id: "pty".to_owned(),
        generation: GENERATION.to_owned(),
        revision: 1,
        state: PtyStartupState::Cancelled,
        trigger: Some(PtyStartupTrigger::Killed),
    };
    let current = snapshot_for_generation(GENERATION, GENERATION, || Ok(snapshot.clone()))
        .expect("current lookup should succeed");
    assert_eq!(current, Some(snapshot));
}

#[test]
fn startup_snapshot_json_contains_only_allowed_wire_fields() {
    let snapshot = PtyStartupSnapshot {
        pty_id: "pty".to_owned(),
        generation: GENERATION.to_owned(),
        revision: 2,
        state: PtyStartupState::Ready,
        trigger: Some(PtyStartupTrigger::Marker),
    };
    let json = serde_json::to_value(snapshot).expect("snapshot JSON");
    let object = json.as_object().expect("snapshot object");
    let allowed = ["ptyId", "generation", "revision", "state", "trigger"];
    assert_eq!(object.len(), allowed.len());
    assert!(object.keys().all(|key| allowed.contains(&key.as_str())));
    for forbidden in ["command", "cwd", "provider", "cardId", "sessionId"] {
        assert!(!object.contains_key(forbidden), "leaked field {forbidden}");
    }
}

#[test]
fn legacy_startup_registration_selects_interactive_or_one_shot() {
    let intent = PtyStartupIntent::Provider {
        provider: AgentSessionProvider::Codex,
        command: "codex".to_owned(),
        card_id: "card".to_owned(),
        action: PtyStartupAction::Start,
        side_effect_plan: PtyStartupSideEffectPlan::Discover,
    };

    let mut interactive = crate::pty::legacy_startup_coordinator("pty", GENERATION, false)
        .expect("interactive coordinator");
    assert_eq!(
        interactive.claim(intent.clone()).expect("legacy claim"),
        PtyDescriptorDisposition::LegacyClaimed
    );

    let mut one_shot = crate::pty::legacy_startup_coordinator("pty", GENERATION, true)
        .expect("one-shot coordinator");
    assert_eq!(
        one_shot.claim(intent).expect_err("one-shot must not claim"),
        STARTUP_DESCRIPTOR_CONFLICT
    );
}

#[tokio::test]
async fn invalid_generation_uses_stable_error() {
    assert_eq!(
        crate::pty::in_process_startup_state("missing".to_owned(), "not-a-generation".to_owned())
            .await
            .expect_err("invalid generation must be rejected"),
        STARTUP_INVALID_GENERATION
    );
}
