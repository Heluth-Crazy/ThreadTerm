//! Integration test: replay a real-shaped asciinema cast through the
//! Stage 3 block parser and assert the recognised command boundaries.
//!
//! The fixture (`fixtures/zsh-5-commands.cast`) follows the asciinema v2
//! schema: a JSON header on the first line, then `[time, "o", payload]`
//! events. We concatenate every output payload and feed the result into
//! `BlockParser::ingest` exactly the way the live PTY reader does.
//!
//! The 5 logical commands the cast represents:
//!   1. `echo hello`         → exit 0
//!   2. `cat /missing`       → exit 1
//!   3. `grep total | wc -l` → exit 0 (pipe)
//!   4. `vim README.md`      → exit 0 (interactive TUI; OSC C/D bracket
//!                                     the redraw stream)
//!   5. `false`              → exit 1

use app_lib::pty::blocks::{BlockEvent, BlockParser};

const CAST: &str = include_str!("fixtures/zsh-5-commands.cast");

fn extract_payloads(cast: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (idx, line) in cast.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || idx == 0 {
            // Skip the JSON header on line 0.
            continue;
        }
        let value: serde_json::Value =
            serde_json::from_str(trimmed).unwrap_or_else(|err| panic!("bad cast line: {err}"));
        let arr = value
            .as_array()
            .unwrap_or_else(|| panic!("cast line is not an array: {trimmed}"));
        if arr.len() < 3 {
            continue;
        }
        if arr[1].as_str() != Some("o") {
            continue;
        }
        if let Some(payload) = arr[2].as_str() {
            out.push(payload.to_string());
        }
    }
    out
}

#[test]
fn block_parser_replays_zsh_cast_with_five_commands() {
    let payloads = extract_payloads(CAST);
    let mut parser = BlockParser::new("pty-replay".to_string());
    let mut events = Vec::new();
    for payload in &payloads {
        events.extend(parser.ingest(payload));
    }

    let started: Vec<&BlockEvent> = events
        .iter()
        .filter(|event| matches!(event, BlockEvent::Started(_)))
        .collect();
    let finished: Vec<&BlockEvent> = events
        .iter()
        .filter(|event| matches!(event, BlockEvent::Finished(_)))
        .collect();

    assert_eq!(
        started.len(),
        5,
        "expected 5 Started events, got {}",
        started.len()
    );
    assert_eq!(
        finished.len(),
        5,
        "expected 5 Finished events, got {}",
        finished.len()
    );

    let exit_codes: Vec<Option<i32>> = finished
        .iter()
        .map(|event| match event {
            BlockEvent::Finished(p) => p.exit_code,
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(
        exit_codes,
        vec![Some(0), Some(1), Some(0), Some(0), Some(1)],
        "exit-code sequence must match the cast"
    );

    // Block 4 is the interactive `vim` lifecycle: even though the cast
    // contains a screen-clear and TUI redraw between OSC C and OSC D, the
    // parser must still emit a clean Started/Finished pair for it.
    if let BlockEvent::Started(p) = started[3] {
        assert_eq!(p.block_id, "cmd-4");
        assert!(
            p.command.contains("vim"),
            "block 4 command was {:?}",
            p.command
        );
        assert_eq!(p.cwd, "/tmp/repo", "cwd must be base64-decoded");
    }
}
