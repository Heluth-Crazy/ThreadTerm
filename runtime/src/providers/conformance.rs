//! Assertions shared by adapter-local recorded-frame replay harnesses.
use super::ProviderEvent;
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
