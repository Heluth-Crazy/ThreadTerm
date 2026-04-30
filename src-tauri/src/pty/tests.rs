use std::time::{Duration, Instant};

use super::blocks::{BlockEvent, BlockParser};
use super::events::{ANSI_STRIP, ERROR_PATTERNS, WAITING_PATTERNS};
use super::session::{should_idle_after_quiet, SessionState, OUTPUT_IDLE_GRACE};

#[test]
fn test_session_state_default() {
    let state = SessionState::Running;
    assert_eq!(format!("{:?}", state), "Running");
}

#[test]
fn test_session_state_variants() {
    let states = vec![
        SessionState::Idle,
        SessionState::Running,
        SessionState::WaitingForInput,
        SessionState::Completed,
        SessionState::Failed,
    ];
    for s in states {
        let json = serde_json::to_string(&s).expect("serialize failed");
        assert!(!json.is_empty());
    }
}

#[test]
fn test_running_goes_idle_after_output_quiets() {
    let last_output_at = Instant::now() - OUTPUT_IDLE_GRACE - Duration::from_millis(1);
    assert!(should_idle_after_quiet(
        &SessionState::Running,
        Some(last_output_at),
        Instant::now()
    ));
}

#[test]
fn test_waiting_does_not_idle_after_output_quiets() {
    let last_output_at = Instant::now() - OUTPUT_IDLE_GRACE - Duration::from_millis(1);
    assert!(!should_idle_after_quiet(
        &SessionState::WaitingForInput,
        Some(last_output_at),
        Instant::now()
    ));
}

#[test]
fn test_ansi_strip_regex() {
    let input = "\x1b[32mHello\x1b[0m World";
    let cleaned = ANSI_STRIP.replace_all(input, "");
    assert_eq!(cleaned, "Hello World");
}

#[test]
fn test_waiting_patterns_match() {
    let test_cases = vec![
        ("Do you want to continue? [Y/n]", true),
        ("Press Enter to approve", true),
        ("Permission denied", true),
        ("Hello world", false),
        ("git status output", false),
    ];
    for (input, expected) in test_cases {
        assert_eq!(
            WAITING_PATTERNS.is_match(input),
            expected,
            "Failed for: {input}"
        );
    }
}

#[test]
fn test_error_patterns_match() {
    let test_cases = vec![
        // Real errors (should match)
        ("Error: file not found", true),
        ("ERROR  something bad", true),
        ("[ERROR] invalid config", true),
        ("  [Fatal] db unreachable", true),
        ("fatal error: cannot find <stdio.h>", true),
        ("command not found", true),
        ("bash: cd: permission denied", true),
        ("Segmentation fault (core dumped)", true),
        ("panic: runtime error", true),
        ("panicked at 'assertion failed'", true),
        ("Traceback (most recent call last):", true),
        ("Unhandled exception in thread", true),
        // Previously false-positive, now correctly ignored
        ("Build succeeded", false),
        ("Everything is fine", false),
        ("The --error flag is optional", false),
        ("Errors (0)", false),
        ("help: see `cli errors` for details", false),
        ("Build failed", false), // too generic without a prefix anchor
        ("No errors detected", false),
    ];
    for (input, expected) in test_cases {
        assert_eq!(
            ERROR_PATTERNS.is_match(input),
            expected,
            "Failed for: {input:?}"
        );
    }
}

#[test]
fn block_parser_detects_osc133_command_lifecycle() {
    let mut parser = BlockParser::new("pty-1".to_string());
    let mut events = Vec::new();

    events.extend(parser.ingest("\x1b]133;A\x07prompt> \x1b]133;B\x07"));
    events.extend(parser.ingest("echo hello\r\n\x1b]6973;cmd_id=cmd-1;cwd=L3RtcC9yZXBv\x07"));
    events
        .extend(parser.ingest("\x1b]133;C\x07hello\r\n\x1b]133;D;0\x07\x1b]6973;duration=42\x07"));

    assert_eq!(events.len(), 2);
    match &events[0] {
        BlockEvent::Started(payload) => {
            assert_eq!(payload.session_id, "pty-1");
            assert_eq!(payload.block_id, "cmd-1");
            assert_eq!(payload.command, "echo hello");
            assert_eq!(payload.cwd, "/tmp/repo");
            assert!(payload.started_at > 0);
        }
        other => panic!("expected started event, got {other:?}"),
    }

    match &events[1] {
        BlockEvent::Finished(payload) => {
            assert_eq!(payload.session_id, "pty-1");
            assert_eq!(payload.block_id, "cmd-1");
            assert_eq!(payload.exit_code, Some(0));
            assert_eq!(payload.duration_ms, Some(42));
            assert!(payload.finished_at > 0);
        }
        other => panic!("expected finished event, got {other:?}"),
    }
}

#[test]
fn block_parser_handles_split_osc_sequences_without_modifying_stream() {
    let mut parser = BlockParser::new("pty-1".to_string());

    assert!(parser.ingest("\x1b]133;B").is_empty());
    assert!(parser.ingest("\x07git status\r").is_empty());
    let events = parser.ingest("\x1b]133;C\x1b\\\x1b]133;D;1\x1b\\");

    assert_eq!(events.len(), 2);
    assert!(matches!(events[0], BlockEvent::Started(_)));
    match &events[1] {
        BlockEvent::Finished(payload) => assert_eq!(payload.exit_code, Some(1)),
        other => panic!("expected finished event, got {other:?}"),
    }
}

#[test]
fn block_parser_eats_duplicate_a_and_aborts_active_block() {
    // Sequence: A → B → C → A (no D!) → B → C → D
    // The first block must abort (exit_code = None → state: aborted in
    // the frontend), the second must finish successfully.
    let mut parser = BlockParser::new("pty-1".to_string());
    let mut events = Vec::new();

    events.extend(parser.ingest("\x1b]133;A\x07prompt> \x1b]133;B\x07echo first\r"));
    events.extend(parser.ingest("\x1b]133;C\x07first-output\r"));
    // p10k / Starship redraw: A re-emitted before D ever arrived.
    events.extend(parser.ingest("\x1b]133;A\x07prompt> \x1b]133;B\x07echo second\r"));
    events.extend(parser.ingest("\x1b]133;C\x07second-output\r\x1b]133;D;0\x07"));

    let started = events
        .iter()
        .filter(|event| matches!(event, BlockEvent::Started(_)))
        .count();
    let finished: Vec<&BlockEvent> = events
        .iter()
        .filter(|event| matches!(event, BlockEvent::Finished(_)))
        .collect();

    assert_eq!(started, 2, "expected two Started events, got {started}");
    assert_eq!(finished.len(), 2, "expected two Finished events");

    match finished[0] {
        BlockEvent::Finished(p) => assert_eq!(
            p.exit_code, None,
            "first block must abort with no exit code"
        ),
        _ => unreachable!(),
    }
    match finished[1] {
        BlockEvent::Finished(p) => assert_eq!(p.exit_code, Some(0)),
        _ => unreachable!(),
    }
}

#[test]
fn block_parser_fuzz_does_not_panic_on_random_byte_streams() {
    use rand::{rngs::StdRng, RngCore, SeedableRng};

    // Seeded so failures are reproducible. Feed fully-random bytes into
    // the parser; we only assert it never panics. A property-based fuzz
    // here would be heavier than the ROADMAP baseline budget allows, so
    // we use a deterministic-seeded loop with a wide enough sample size.
    let mut rng = StdRng::seed_from_u64(0xC0FFEE_u64);
    let mut parser = BlockParser::new("pty-fuzz".to_string());

    for _ in 0..1024 {
        let len = (rng.next_u32() % 1024) as usize;
        let mut buf = vec![0u8; len];
        rng.fill_bytes(&mut buf);
        let chunk = String::from_utf8_lossy(&buf);
        let _ = parser.ingest(&chunk);
    }
}
