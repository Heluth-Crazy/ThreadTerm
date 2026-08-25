use std::sync::{Arc, Barrier, Mutex};
use std::thread;

use super::{
    AgentSessionProvider, PtyStartupAction, PtyStartupCoordinator, PtyStartupIntent,
    PtyStartupSideEffectPlan, PtyStartupState, PtyStartupTrigger,
};

const GENERATION: &str = "0123456789abcdef0123456789abcdef";

fn waiting() -> PtyStartupCoordinator {
    PtyStartupCoordinator::explicit(
        "pty",
        GENERATION,
        PtyStartupIntent::Provider {
            provider: AgentSessionProvider::Codex,
            command: "codex resume session".to_owned(),
            card_id: "card".to_owned(),
            action: PtyStartupAction::Resume,
            side_effect_plan: PtyStartupSideEffectPlan::Bind {
                provider_session_id: "session".to_owned(),
            },
        },
    )
    .unwrap()
}
#[test]
fn readiness_triggers_and_deadline_are_single_revision_transitions() {
    for trigger in [
        PtyStartupTrigger::Marker,
        PtyStartupTrigger::FirstOutput,
        PtyStartupTrigger::Immediate,
    ] {
        let mut model = waiting();
        assert!(model.mark_ready(trigger));
        assert_eq!(model.snapshot().state, PtyStartupState::Ready);
        assert_eq!(model.snapshot().trigger, Some(trigger));
        assert_eq!(model.snapshot().revision, 1);
        assert!(!model.deadline());
    }
    let mut timed = waiting();
    assert!(timed.deadline());
    assert_eq!(timed.snapshot().state, PtyStartupState::TimedOut);
    assert_eq!(timed.snapshot().trigger, Some(PtyStartupTrigger::Timeout));
    assert_eq!(timed.snapshot().revision, 1);
    assert!(!timed.deadline());
}
#[test]
fn ready_and_timeout_compete_for_exactly_one_dispatch_path() {
    let mut ready_first = waiting();
    assert!(ready_first.mark_ready(PtyStartupTrigger::Marker));
    assert!(!ready_first.deadline());
    assert!(ready_first.take_dispatch_lease());
    assert_eq!(ready_first.snapshot().revision, 2);

    let mut timeout_first = waiting();
    assert!(timeout_first.deadline());
    assert!(!timeout_first.mark_ready(PtyStartupTrigger::Marker));
    assert!(timeout_first.take_dispatch_lease());
    assert_eq!(timeout_first.snapshot().revision, 2);
}
#[test]
fn dispatch_outcome_owns_sent_or_failed_and_cancellation_cannot_revoke_lease() {
    let mut sent = waiting();
    sent.mark_ready(PtyStartupTrigger::Immediate);
    sent.take_dispatch_lease();
    assert!(!sent.cancel(PtyStartupTrigger::Killed));
    assert!(sent.complete_dispatch(true));
    assert_eq!(sent.snapshot().state, PtyStartupState::Sent);
    assert!(!sent.complete_dispatch(false));
    assert_eq!(sent.snapshot().revision, 3);

    let mut failed = waiting();
    failed.deadline();
    failed.take_dispatch_lease();
    assert!(failed.complete_dispatch(false));
    assert_eq!(failed.snapshot().state, PtyStartupState::Failed);
}
#[test]
fn cancellation_is_valid_before_dispatch_at_every_stage() {
    for (advance, trigger) in [
        (0_u8, PtyStartupTrigger::Killed),
        (1, PtyStartupTrigger::PtyExit),
        (2, PtyStartupTrigger::Killed),
    ] {
        let mut model = waiting();
        if advance == 1 {
            model.mark_ready(PtyStartupTrigger::FirstOutput);
        } else if advance == 2 {
            model.deadline();
        }
        assert!(model.cancel(trigger));
        assert_eq!(model.snapshot().state, PtyStartupState::Cancelled);
        assert_eq!(model.snapshot().trigger, Some(trigger));
        assert!(!model.cancel(trigger));
    }
}
#[test]
fn terminal_and_illegal_operations_are_idempotent_without_revision_bumps() {
    let mut model = waiting();
    assert!(!model.mark_ready(PtyStartupTrigger::Timeout));
    assert!(!model.cancel(PtyStartupTrigger::Marker));
    assert_eq!(model.snapshot().revision, 0);
    model.mark_ready(PtyStartupTrigger::Marker);
    model.take_dispatch_lease();
    model.complete_dispatch(true);
    let revision = model.snapshot().revision;
    assert!(!model.mark_ready(PtyStartupTrigger::Immediate));
    assert!(!model.deadline());
    assert!(!model.take_dispatch_lease());
    assert!(!model.complete_dispatch(true));
    assert!(!model.cancel(PtyStartupTrigger::PtyExit));
    assert_eq!(model.snapshot().revision, revision);
}
#[test]
fn concurrent_mutex_access_has_one_dispatch_lease_winner() {
    let model = Arc::new(Mutex::new({
        let mut model = waiting();
        model.mark_ready(PtyStartupTrigger::Marker);
        model
    }));
    let barrier = Arc::new(Barrier::new(3));
    let mut handles = Vec::new();
    for _ in 0..2 {
        let model = Arc::clone(&model);
        let barrier = Arc::clone(&barrier);
        handles.push(thread::spawn(move || {
            barrier.wait();
            model.lock().expect("startup mutex").take_dispatch_lease()
        }));
    }
    barrier.wait();
    let wins = handles
        .into_iter()
        .map(|handle| handle.join().expect("lease worker"))
        .filter(|won| *won)
        .count();
    assert_eq!(wins, 1);
    assert_eq!(
        model.lock().unwrap().snapshot().state,
        PtyStartupState::Dispatching
    );
}
#[test]
fn snapshot_is_private_and_cloneable() {
    let mut model = waiting();
    model.mark_ready(PtyStartupTrigger::Marker);
    let snapshot = model.snapshot();
    let clone = snapshot.clone();
    assert_eq!(snapshot, clone);
    let json = serde_json::to_value(snapshot).expect("snapshot JSON");
    let object = json.as_object().expect("snapshot object");
    assert!(object.contains_key("ptyId"));
    assert!(object.contains_key("generation"));
    assert!(object.contains_key("revision"));
    assert!(object.contains_key("state"));
    assert!(object.contains_key("trigger"));
    for forbidden in [
        "command",
        "provider",
        "providerSessionId",
        "cardId",
        "descriptor",
    ] {
        assert!(!object.contains_key(forbidden), "leaked key {forbidden}");
    }
    assert_eq!(json["state"], "ready");
}
