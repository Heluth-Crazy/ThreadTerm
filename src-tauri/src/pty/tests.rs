use std::{
    io::{self, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use portable_pty::{Child, ChildKiller, ExitStatus};

use super::events::{ANSI_STRIP, ERROR_PATTERNS, WAITING_PATTERNS};
use super::session::{should_idle_after_quiet, PtyInputRequest, SessionState, OUTPUT_IDLE_GRACE};
use super::{run_pty_input_writer, terminate_child_process};

struct SharedWriter {
    bytes: Arc<Mutex<Vec<u8>>>,
}

impl Write for SharedWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.bytes
            .lock()
            .expect("shared writer lock")
            .extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Clone, Debug)]
struct TestChild {
    killed: Arc<AtomicBool>,
}

impl ChildKiller for TestChild {
    fn kill(&mut self) -> std::io::Result<()> {
        self.killed.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(self.clone())
    }
}

impl Child for TestChild {
    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        Ok(None)
    }

    fn wait(&mut self) -> std::io::Result<ExitStatus> {
        Ok(ExitStatus::with_exit_code(0))
    }

    fn process_id(&self) -> Option<u32> {
        None
    }

    #[cfg(windows)]
    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        None
    }
}

#[tokio::test]
async fn pty_input_writer_preserves_one_thousand_writes_in_order() {
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let written_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let callback_count = written_count.clone();
    let (sender, receiver) = tokio::sync::mpsc::channel(32);
    let writer_bytes = bytes.clone();
    let worker = std::thread::spawn(move || {
        run_pty_input_writer(
            Box::new(SharedWriter {
                bytes: writer_bytes,
            }),
            receiver,
            move || {
                callback_count.fetch_add(1, Ordering::SeqCst);
            },
        );
    });

    let mut completions = Vec::new();
    let mut expected = Vec::new();
    for index in 0..1000 {
        let data = format!("{index:04}\n").into_bytes();
        expected.extend_from_slice(&data);
        let (completion, completed) = tokio::sync::oneshot::channel();
        sender
            .send(PtyInputRequest { data, completion })
            .await
            .expect("queue PTY input");
        completions.push(completed);
    }
    drop(sender);

    for completed in completions {
        completed
            .await
            .expect("writer completion channel")
            .expect("write succeeds");
    }
    worker.join().expect("input writer thread");

    assert_eq!(*bytes.lock().expect("shared writer lock"), expected);
    assert_eq!(written_count.load(Ordering::SeqCst), 1000);
}

#[test]
fn terminate_child_process_always_calls_portable_pty_kill() {
    let killed = Arc::new(AtomicBool::new(false));
    let mut child = TestChild {
        killed: killed.clone(),
    };

    terminate_child_process(&mut child);

    assert!(killed.load(Ordering::SeqCst));
}

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
