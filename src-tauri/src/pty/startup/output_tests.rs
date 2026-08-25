use super::{
    AgentSessionProvider, PtyStartupAction, PtyStartupCoordinator, PtyStartupIntent,
    PtyStartupSideEffectPlan, PtyStartupTrigger, SessionStartup, StartupOutputConfig,
};

const GENERATION: &str = "0123456789abcdef0123456789abcdef";
const NONCE: &str = "0123456789abcdef0123456789abcdef";
const PREFIX: &[u8] = b"\x1b]777;threadterm;ready;";

fn startup() -> SessionStartup {
    SessionStartup::new(
        PtyStartupCoordinator::explicit(
            "pty",
            GENERATION,
            PtyStartupIntent::Provider {
                provider: AgentSessionProvider::Codex,
                command: "codex".to_owned(),
                card_id: "card".to_owned(),
                action: PtyStartupAction::Start,
                side_effect_plan: PtyStartupSideEffectPlan::Discover,
            },
        )
        .unwrap(),
    )
}

fn marker(st: &[u8]) -> Vec<u8> {
    let mut bytes = PREFIX.to_vec();
    bytes.extend_from_slice(NONCE.as_bytes());
    bytes.extend_from_slice(st);
    bytes
}

#[test]
fn passthrough_is_byte_exact_and_does_not_transition() {
    let startup = startup();
    startup.configure_output_passthrough().unwrap();
    let input = "\x1b]777;not-owned\x07中文🙂".as_bytes();
    let output = startup.observe_output(input, |_| panic!("passthrough is not ready"));
    let output = output.unwrap();
    assert_eq!(output.visible, input);
    assert_eq!(output.matched, 0);
    assert_eq!(output.buffered_len, 0);
    assert!(!output.became_ready);
}

#[test]
fn invalid_output_nonce_uses_fixed_error_without_echoing_input() {
    let startup = startup();
    let supplied = "not-a-safe-nonce-with-sensitive-text";
    let error = startup
        .configure_output_marker(supplied, true)
        .expect_err("invalid nonce");
    assert_eq!(error, super::STARTUP_MARKER_INVALID);
    assert!(!error.contains(supplied));
}

#[test]
fn split_marker_is_filtered_and_publishes_one_ready_revision() {
    let startup = startup();
    startup
        .configure_output(StartupOutputConfig::Marker {
            nonce: NONCE.to_owned(),
            triggers_ready: true,
        })
        .unwrap();
    let mut revisions = Vec::new();
    let mut evidence = Vec::new();
    for byte in marker(b"\x07") {
        let output = startup
            .observe_output(std::slice::from_ref(&byte), |snapshot| {
                revisions.push(snapshot.revision)
            })
            .unwrap();
        evidence.push(output.marker_matched);
        assert!(output.visible.is_empty());
    }
    assert_eq!(revisions, vec![1]);
    assert_eq!(evidence.iter().filter(|matched| **matched).count(), 1);
    assert_eq!(
        startup.snapshot().unwrap().trigger,
        Some(PtyStartupTrigger::Marker)
    );
}

#[test]
fn late_and_repeated_markers_stay_hidden_without_redispatch() {
    let startup = startup();
    startup.configure_output_marker(NONCE, true).unwrap();
    let mut events = 0;
    let first = startup
        .observe_output(&marker(b"\x07"), |_| events += 1)
        .unwrap();
    let second = startup
        .observe_output(&marker(b"\x1b\\"), |_| events += 1)
        .unwrap();
    assert_eq!(first.matched, 1);
    assert_eq!(second.matched, 1);
    assert!(first.marker_matched);
    assert!(!second.marker_matched);
    assert!(first.became_ready);
    assert!(!second.became_ready);
    assert_eq!(events, 1);
    assert_eq!(startup.snapshot().unwrap().revision, 1);
}

#[test]
fn first_output_requires_nonempty_ordinary_bytes() {
    let startup = startup();
    startup.configure_output_first_output().unwrap();
    let empty = startup
        .observe_output(&[], |_| panic!("empty is not ready"))
        .unwrap();
    assert!(!empty.became_ready);
    let query = startup
        .observe_output(b"", |_| panic!("DA1 is removed before observation"))
        .unwrap();
    assert!(!query.became_ready);
    let ordinary = startup.observe_output("中文🙂".as_bytes(), |_| {}).unwrap();
    assert!(ordinary.became_ready);
    assert_eq!(
        startup.snapshot().unwrap().trigger,
        Some(PtyStartupTrigger::FirstOutput)
    );
}

#[test]
fn first_output_evidence_is_reported_only_once() {
    let startup = startup();
    startup.configure_output_first_output().unwrap();
    let mut dispatches = 0;
    let first = startup
        .observe_output(b"first", |_| dispatches += 1)
        .unwrap();
    let second = startup
        .observe_output(b"second", |_| dispatches += 1)
        .unwrap();

    assert!(first.first_output_observed);
    assert!(!second.first_output_observed);
    assert_eq!(dispatches, 1);
}

#[test]
fn suppressed_first_output_is_observed_without_dispatch() {
    let startup = startup();
    startup
        .configure_output(StartupOutputConfig::FirstOutput {
            triggers_ready: false,
        })
        .unwrap();
    let mut dispatches = 0;
    let observation = startup
        .observe_output(b"cmd output", |_| dispatches += 1)
        .unwrap();

    assert!(observation.first_output_observed);
    assert!(!observation.became_ready);
    assert_eq!(dispatches, 0);
    assert_eq!(startup.snapshot().unwrap().revision, 0);
}

#[test]
fn suppressed_marker_observer_records_evidence_without_dispatch() {
    let startup = startup();
    startup.configure_output_marker(NONCE, false).unwrap();
    let mut dispatches = 0;
    let observation = startup
        .observe_output(&marker(b"\x07"), |_| dispatches += 1)
        .unwrap();

    assert!(observation.marker_matched);
    assert!(!observation.became_ready);
    assert_eq!(dispatches, 0);
    assert_eq!(startup.snapshot().unwrap().revision, 0);
}

#[test]
fn eof_preserves_wrong_and_incomplete_marker_bytes() {
    let startup = startup();
    startup.configure_output_marker(NONCE, true).unwrap();
    let mut wrong = PREFIX.to_vec();
    wrong.extend_from_slice(b"ffffffffffffffffffffffffffffffff\x07");
    let visible = startup
        .observe_output(&wrong, |_| panic!("wrong marker is visible"))
        .unwrap();
    assert_eq!(visible.visible, wrong);

    let incomplete = marker(b"\x07");
    let prefix = &incomplete[..incomplete.len() - 1];
    assert!(startup
        .observe_output(prefix, |_| panic!("incomplete marker"))
        .unwrap()
        .visible
        .is_empty());
    let tail = startup
        .finish_output(|_| panic!("incomplete marker is not ready"))
        .unwrap();
    assert_eq!(tail.visible, prefix);
    assert_eq!(tail.buffered_len, 0);
}

#[test]
fn protocol_discard_clears_private_marker_tail() {
    let startup = startup();
    startup.configure_output_marker(NONCE, true).unwrap();
    let input = marker(b"\x07");
    startup
        .observe_output(&input[..input.len() - 1], |_| {})
        .unwrap();
    startup.discard_output().unwrap();
    assert!(startup.finish_output(|_| {}).unwrap().visible.is_empty());
}
