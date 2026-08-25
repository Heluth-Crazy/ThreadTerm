use std::sync::{Arc, Barrier};
use std::thread;

use super::{
    PtyStartupAction, PtyStartupCoordinator, PtyStartupIntent, PtyStartupSideEffectPlan,
    PtyStartupState, PtyStartupTrigger, SessionStartup,
};

const GENERATION: &str = "0123456789abcdef0123456789abcdef";

fn startup() -> Arc<SessionStartup> {
    Arc::new(SessionStartup::new(
        PtyStartupCoordinator::explicit(
            "pty",
            GENERATION,
            PtyStartupIntent::Provider {
                provider: super::AgentSessionProvider::Codex,
                command: "run".to_string(),
                card_id: "card".to_string(),
                action: PtyStartupAction::Start,
                side_effect_plan: PtyStartupSideEffectPlan::Discover,
            },
        )
        .unwrap(),
    ))
}

#[test]
fn ready_timeout_race_leases_one_dispatch_without_a_timer() {
    let startup = startup();
    let barrier = Arc::new(Barrier::new(3));
    let workers = [PtyStartupTrigger::Marker, PtyStartupTrigger::Timeout]
        .into_iter()
        .map(|trigger| {
            let startup = Arc::clone(&startup);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                if trigger == PtyStartupTrigger::Timeout {
                    startup.deadline(|_| {}).unwrap();
                } else {
                    startup.mark_ready(trigger, |_| {}).unwrap();
                }
                startup.take_dispatch(|_| {}).unwrap().is_some()
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    assert_eq!(
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(|leased| *leased)
            .count(),
        1
    );
}

#[test]
fn duplicate_marker_cannot_create_a_second_dispatch_or_sent_effect() {
    let startup = startup();
    assert!(startup
        .mark_ready(PtyStartupTrigger::Marker, |_| {})
        .unwrap());
    assert!(!startup
        .mark_ready(PtyStartupTrigger::Marker, |_| {})
        .unwrap());
    assert!(startup.take_dispatch(|_| {}).unwrap().is_some());
    startup.record_sent_at_ms(9).unwrap();
    assert!(startup.complete_dispatch(true, |_| {}).unwrap());
    assert!(startup.sent_effect().unwrap().is_some());
    assert!(startup.take_dispatch(|_| {}).unwrap().is_none());
    assert_eq!(startup.snapshot().unwrap().state, PtyStartupState::Sent);
}
