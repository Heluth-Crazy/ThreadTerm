use super::effect_ledger::{
    LedgerClaim, StartupEffectLedger, StartupSideEffectKey, StartupSideEffectKind,
};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;

fn key(kind: StartupSideEffectKind) -> StartupSideEffectKey {
    StartupSideEffectKey {
        pty_id: "pty".into(),
        generation: "0123456789abcdef0123456789abcdef".into(),
        kind,
    }
}

#[test]
fn concurrent_claim_has_one_winner() {
    let ledger = Arc::new(Mutex::new(StartupEffectLedger::new()));
    let barrier = Arc::new(Barrier::new(8));
    let mut handles = Vec::new();
    for _ in 0..8 {
        let ledger = Arc::clone(&ledger);
        let barrier = Arc::clone(&barrier);
        handles.push(thread::spawn(move || {
            barrier.wait();
            let mut ledger = ledger.lock().expect("ledger");
            ledger.claim(key(StartupSideEffectKind::RecordUserSubmit))
        }));
    }
    let claims = handles
        .into_iter()
        .map(|handle| handle.join().expect("claim thread").expect("token"))
        .collect::<Vec<_>>();
    assert_eq!(
        claims
            .iter()
            .filter(|claim| matches!(claim, LedgerClaim::Start(_)))
            .count(),
        1
    );
    assert_eq!(
        claims
            .iter()
            .filter(|claim| matches!(claim, LedgerClaim::Skip))
            .count(),
        7
    );
}

#[test]
fn terminal_state_deduplicates_future_claims() {
    let mut ledger = StartupEffectLedger::new();
    let effect_key = key(StartupSideEffectKind::RecordUserSubmit);
    let LedgerClaim::Start(token) = ledger.claim(effect_key.clone()).expect("first claim") else {
        panic!("first claim must win")
    };
    ledger.mark_terminal(&effect_key, &token);
    assert!(matches!(
        ledger.claim(effect_key).expect("terminal claim"),
        LedgerClaim::Skip
    ));
}

#[test]
fn failed_commit_retries_with_the_same_token() {
    let mut ledger = StartupEffectLedger::new();
    let effect_key = key(StartupSideEffectKind::BindProviderSession);
    let LedgerClaim::Start(first) = ledger.claim(effect_key.clone()).expect("first claim") else {
        panic!("first claim must win")
    };
    ledger.mark_retryable(&effect_key, &first);
    let LedgerClaim::Start(retry) = ledger.claim(effect_key).expect("retry claim") else {
        panic!("failed effects remain retryable")
    };
    assert_eq!(first, retry);
}

#[test]
fn effect_kinds_have_independent_keys() {
    let mut ledger = StartupEffectLedger::new();
    let submit = ledger
        .claim(key(StartupSideEffectKind::RecordUserSubmit))
        .expect("submit claim");
    let binding = ledger
        .claim(key(StartupSideEffectKind::BindProviderSession))
        .expect("binding claim");
    assert!(matches!(submit, LedgerClaim::Start(_)));
    assert!(matches!(binding, LedgerClaim::Start(_)));
}
