//! Assertions shared by adapter-local recorded-frame replay harnesses.
use super::ProviderEvent;
use super::ProviderError;
use serde_json::Value;

pub(super) fn fixture(name: &str) -> Vec<Value> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures").join(name);
    std::fs::read_to_string(path).expect("recorded fixture")
        .lines().filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("fixture JSONL frame")).collect()
}

/// Child cards/transcripts and labelled interactions may be parent-visible,
/// but child text/tools and terminal signals must never enter its transcript.
pub(super) fn assert_no_parent_effect(events: &[ProviderEvent], parent_session: &str) {
    for event in events.iter().filter(|event| event.session_id == parent_session) {
        assert_ne!(event.kind, "chat.delta", "child delta: {event:?}");
        assert!(!event.kind.starts_with("chat.turn."), "child terminal: {event:?}");
        if event.kind == "chat.item" {
            if let Some(part) = event.data.get("part") {
                assert!(!matches!(part["type"].as_str(), Some("text" | "thinking" | "tool")),
                    "child parent part: {event:?}");
            }
            let parts = event.data.get("parts")
                .or_else(|| event.data.pointer("/item/parts"))
                .and_then(Value::as_array);
            assert!(!parts.into_iter().flatten().any(|part|
                matches!(part["type"].as_str(), Some("text" | "thinking" | "tool"))),
                "child parent item: {event:?}");
        }
    }
}

/// Count real outbound JSON-RPC envelopes captured by a fake process.
pub(super) fn assert_exactly_once(responses: &[Value], request_ids: &[Value]) {
    for id in request_ids {
        let replies: Vec<_> = responses.iter().filter(|frame|
            frame.get("id") == Some(id) && frame.get("method").is_none()
                && (frame.get("result").is_some() || frame.get("error").is_some())).collect();
        assert_eq!(replies.len(), 1, "request {id}: {replies:?}");
        assert_ne!(replies[0].get("result").is_some(), replies[0].get("error").is_some());
    }
}

/// The one adapter cancellation contract (see `ChatSession::cancel`): a Stop of
/// a turn that already ended succeeds without effect, and a Stop of any other
/// turn while one is live is refused with `turn_not_active` without touching
/// the live turn. Adapter tests add their own "live -> interrupted" case,
/// because what an interruption looks like is provider-specific.
pub(super) fn assert_stop_of_finished_turn_succeeds(result: Result<(), ProviderError>) {
    assert!(
        result.is_ok(),
        "a Stop of an already finished turn must succeed: {result:?}"
    );
}

pub(super) fn assert_stop_refuses_a_turn_that_is_not_live(result: Result<(), ProviderError>) {
    let error = result.expect_err("a Stop of another turn while one is live must be refused");
    assert_eq!(error.code, "turn_not_active", "{error:?}");
    // The renderer keeps its Stop error bar by this marker: the IPC hop drops
    // the error code.
    assert_eq!(error.message, super::STOP_TURN_NOT_ACTIVE, "{error:?}");
}

/// A fake JSON-RPC peer that appends every inbound frame to the returned log
/// and answers every request with an empty result, so a Stop that waits for an
/// answer returns. `None` when Node is unavailable on this machine.
pub(super) fn stop_recording_process(
    style: super::common::EnvelopeStyle,
    name: &str,
    dir: &std::path::Path,
) -> Option<(super::common::JsonLineProcess, std::path::PathBuf)> {
    super::common::find_executable("node")?;
    let log = dir.join(format!("{name}-frames.jsonl"));
    std::fs::write(&log, "").unwrap();
    let script = dir.join(format!("{name}.cjs"));
    std::fs::write(
        &script,
        format!(
            r#"
const log = process.argv[2];
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
require('node:readline').createInterface({{input:process.stdin}}).on('line', line => {{
  const frame = JSON.parse(line);
  require('node:fs').appendFileSync(log, JSON.stringify(frame) + '\n');
  if (!frame.method) return;
  out(frame.jsonrpc ? {{jsonrpc:'2.0',id:frame.id,result:{{}}}} : {{id:frame.id,result:{{}}}});
}});
"#
        ),
    )
    .unwrap();
    let spec = super::common::CommandSpec::provider("node", &[script.to_str().unwrap(), log.to_str().unwrap()])
        .unwrap();
    let process = super::common::JsonLineProcess::spawn(name, &spec, None, &[], style, std::sync::Arc::new(|_| {}))
        .unwrap();
    Some((process, log))
}

/// Reads the frames the fake peer received, waiting briefly for the write.
pub(super) fn recorded_frames(log: &std::path::Path, methods: &[&str]) -> Vec<Value> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let frames: Vec<Value> = std::fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        if methods.iter().all(|method| frames.iter().any(|frame| frame["method"] == *method))
            || std::time::Instant::now() >= deadline
        {
            return frames;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
