use std::sync::{Arc, Barrier, Mutex};
use std::thread;

use super::{
    AgentSessionProvider, PtyDescriptorDisposition, PtyStartupAction, PtyStartupCoordinator,
    PtyStartupIntent, PtyStartupSideEffectPlan, PtyStartupState, PtyStartupTrigger, SessionStartup,
};

const GENERATION: &str = "0123456789abcdef0123456789abcdef";

fn provider(command: &str) -> PtyStartupIntent {
    PtyStartupIntent::Provider {
        provider: AgentSessionProvider::Codex,
        command: command.to_owned(),
        card_id: "card".to_owned(),
        action: PtyStartupAction::Resume,
        side_effect_plan: PtyStartupSideEffectPlan::Discover,
    }
}

fn startup(command: &str) -> SessionStartup {
    SessionStartup::new(
        PtyStartupCoordinator::explicit("pty", GENERATION, provider(command)).unwrap(),
    )
}

fn revisions() -> Arc<Mutex<Vec<u64>>> {
    Arc::new(Mutex::new(Vec::new()))
}

#[test]
fn legacy_claim_publishes_immediate_revision_once_and_noops_are_silent() {
    let legacy_startup =
        SessionStartup::new(PtyStartupCoordinator::legacy_interactive("pty", GENERATION).unwrap());
    let seen = revisions();
    let result = legacy_startup.claim(provider("run"), |snapshot| {
        seen.lock().unwrap().push(snapshot.revision)
    });
    assert_eq!(result.unwrap(), PtyDescriptorDisposition::LegacyClaimed);
    assert_eq!(*seen.lock().unwrap(), vec![1]);

    let explicit = startup("run");
    let matched = explicit.claim(provider("run"), |_| panic!("matched claim published"));
    assert_eq!(matched.unwrap(), PtyDescriptorDisposition::Matched);
    assert!(!explicit
        .mark_ready(PtyStartupTrigger::Timeout, |_| panic!("no-op published"))
        .unwrap());
}

#[test]
fn marker_timeout_race_has_one_lease_and_global_revisions() {
    let startup = Arc::new(startup("codex  "));
    let seen = revisions();
    let barrier = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();
    for trigger in [PtyStartupTrigger::Marker, PtyStartupTrigger::Timeout] {
        let startup = Arc::clone(&startup);
        let seen = Arc::clone(&seen);
        let barrier = Arc::clone(&barrier);
        workers.push(thread::spawn(move || {
            barrier.wait();
            if trigger == PtyStartupTrigger::Timeout {
                startup
                    .deadline(|snapshot| seen.lock().unwrap().push(snapshot.revision))
                    .unwrap()
            } else {
                startup
                    .mark_ready(trigger, |snapshot| {
                        seen.lock().unwrap().push(snapshot.revision)
                    })
                    .unwrap()
            }
        }));
    }
    barrier.wait();
    for worker in workers {
        worker.join().unwrap();
    }
    let dispatches = (0..2)
        .filter_map(|_| {
            let seen = Arc::clone(&seen);
            startup
                .take_dispatch(|snapshot| seen.lock().unwrap().push(snapshot.revision))
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(dispatches.len(), 1);
    assert_eq!(dispatches[0].command_bytes(), b"codex  \r");
    assert_eq!(*seen.lock().unwrap(), vec![1, 2]);
}

#[test]
fn dispatch_keeps_raw_command_and_carries_typed_effect() {
    let startup = startup("  raw\t\n");
    startup
        .mark_ready(PtyStartupTrigger::Immediate, |_| {})
        .unwrap();
    let dispatch = startup.take_dispatch(|_| {}).unwrap().unwrap();
    assert_eq!(dispatch.command_bytes(), b"  raw\t\n\r");
    let effect = dispatch.effect();
    assert_eq!(effect.provider(), AgentSessionProvider::Codex);
    assert_eq!(effect.card_id(), "card");
    assert!(matches!(effect.action(), PtyStartupAction::Resume));
    assert!(matches!(
        effect.side_effect_plan(),
        PtyStartupSideEffectPlan::Discover
    ));
}

#[test]
fn sent_failed_and_cancelled_transitions_publish_in_order() {
    let sent = startup("sent");
    let seen = revisions();
    sent.mark_ready(PtyStartupTrigger::Immediate, |s| {
        seen.lock().unwrap().push(s.revision)
    })
    .unwrap();
    sent.take_dispatch(|s| seen.lock().unwrap().push(s.revision))
        .unwrap();
    sent.complete_dispatch(true, |s| seen.lock().unwrap().push(s.revision))
        .unwrap();
    assert_eq!(sent.snapshot().unwrap().state, PtyStartupState::Sent);
    assert_eq!(*seen.lock().unwrap(), vec![1, 2, 3]);

    let failed = startup("failed");
    failed.deadline(|_| {}).unwrap();
    failed.take_dispatch(|_| {}).unwrap();
    failed.complete_dispatch(false, |_| {}).unwrap();
    assert_eq!(failed.snapshot().unwrap().state, PtyStartupState::Failed);

    let cancelled = startup("cancelled");
    assert!(cancelled.cancel(PtyStartupTrigger::Killed, |_| {}).unwrap());
    assert_eq!(
        cancelled.snapshot().unwrap().state,
        PtyStartupState::Cancelled
    );
}

#[test]
fn sent_effect_keeps_typed_identity_and_stable_timestamp() {
    let sent = startup("secret command");
    sent.mark_ready(PtyStartupTrigger::Immediate, |_| {})
        .unwrap();
    sent.take_dispatch(|_| {}).unwrap().unwrap();
    sent.record_sent_at_ms(1234).unwrap();
    sent.record_sent_at_ms(5678).unwrap();
    sent.complete_dispatch(true, |_| {}).unwrap();

    assert_eq!(sent.sent_at_ms().unwrap(), Some(1234));
    let effect = sent.sent_effect().unwrap().expect("sent provider effect");
    assert_eq!(effect.provider(), AgentSessionProvider::Codex);
    assert_eq!(effect.card_id(), "card");
    assert!(matches!(effect.action(), PtyStartupAction::Resume));
    assert!(matches!(
        effect.side_effect_plan(),
        PtyStartupSideEffectPlan::Discover
    ));
}

#[test]
fn timestamp_can_be_recorded_before_the_dispatch_commit() {
    let startup = startup("run");
    startup
        .mark_ready(PtyStartupTrigger::Immediate, |_| {})
        .unwrap();
    startup.take_dispatch(|_| {}).unwrap().unwrap();
    assert_eq!(
        startup.snapshot().unwrap().state,
        PtyStartupState::Dispatching
    );
    assert_eq!(startup.record_sent_at_ms(42).unwrap(), 42);
    assert_eq!(startup.sent_at_ms().unwrap(), Some(42));
    assert!(startup.complete_dispatch(false, |_| {}).unwrap());
    assert_eq!(startup.snapshot().unwrap().state, PtyStartupState::Failed);
}

#[test]
fn publisher_snapshot_has_no_sensitive_fields() {
    let startup = startup("secret command");
    startup
        .mark_ready(PtyStartupTrigger::Marker, |snapshot| {
            let value = serde_json::to_value(snapshot).unwrap();
            let object = value.as_object().unwrap();
            for forbidden in ["command", "provider", "providerSessionId", "cardId"] {
                assert!(!object.contains_key(forbidden), "leaked {forbidden}");
            }
        })
        .unwrap();
}
