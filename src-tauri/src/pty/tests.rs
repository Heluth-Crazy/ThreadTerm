use std::time::{Duration, Instant};

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
