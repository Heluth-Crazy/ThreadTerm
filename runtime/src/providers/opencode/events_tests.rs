use super::*;

fn frame(dialect: ApiDialect, text: &str) -> Option<NativeFrame> {
    let mut decoder = FrameDecoder::new(dialect);
    let mut frame = None;
    for line in text.split_inclusive('\n') {
        frame = decoder.push_line(line).unwrap().or(frame);
    }
    frame
}

#[test]
fn only_the_exact_complete_v2_heartbeat_frame_is_live() {
    for heartbeat in [": heartbeat\n\n", ": heartbeat\r\n\r\n"] {
        assert!(matches!(
            frame(ApiDialect::V2, heartbeat),
            Some(NativeFrame::Heartbeat)
        ));
        assert!(frame(ApiDialect::Legacy, heartbeat).is_none());
    }
    for invalid in [
        ": heartbeat\n",
        ":heartbeat\n\n",
        ": heartbeat \n\n",
        ": other\n\n",
        ": heartbeat\n: other\n\n",
        ": heartbeat\n: heartbeat\n\n",
        "id:1\n: heartbeat\n\n",
        "data: {}\n\n",
        "data: nope\n\n",
    ] {
        assert!(frame(ApiDialect::V2, invalid).is_none(), "{invalid:?}");
    }
    assert!(
        FrameDecoder::new(ApiDialect::V2)
            .push_line(": heartbeat")
            .is_err(),
        "EOF cannot complete a comment"
    );
}

#[test]
fn native_json_envelopes_are_dialect_specific_and_complete() {
    assert!(matches!(
        frame(
            ApiDialect::Legacy,
            "data: {\"type\":\"server.heartbeat\",\"properties\":{}}\n\n"
        ),
        Some(NativeFrame::Event(_))
    ));
    assert!(frame(
        ApiDialect::V2,
        "data: {\"type\":\"server.heartbeat\",\"properties\":{}}\n\n"
    )
    .is_none());
    let event = "data: {\"id\":\"evt_1\",\"type\":\"server.connected\",\"data\":{}}\n\n";
    assert!(
        matches!(frame(ApiDialect::V2, event), Some(NativeFrame::Event(value)) if value["id"] == "evt_1")
    );
    assert!(frame(ApiDialect::Legacy, event).is_none());
    for invalid in [
        "data: {\"type\":\"server.connected\",\"data\":{}}\n\n",
        "data: {\"id\":\"\",\"type\":\"x\",\"data\":{}}\n\n",
        "data: {\"id\":\"e\",\"type\":\"x\",\"data\":[]}\n\n",
    ] {
        assert!(frame(ApiDialect::V2, invalid).is_none());
    }
    assert!(frame(ApiDialect::V2, event.strip_suffix('\n').unwrap()).is_none());
}

#[test]
fn authentic_225_idle_frames_use_the_same_decoder() {
    for row in crate::providers::conformance::fixture("opencode-v2-native-events.jsonl") {
        let text = row["frame"].as_str().unwrap();
        match row["case"].as_str().unwrap() {
            "heartbeat" => assert!(matches!(
                frame(ApiDialect::V2, text),
                Some(NativeFrame::Heartbeat)
            )),
            "server_connected" => assert!(matches!(
                frame(ApiDialect::V2, text),
                Some(NativeFrame::Event(_))
            )),
            other => panic!("unexpected recorded frame case {other}"),
        }
        assert!(
            frame(ApiDialect::Legacy, text).is_none(),
            "v2 proof never loosens the legacy heartbeat contract"
        );
    }
}

#[test]
fn frame_assembly_is_bounded_and_resets_after_invalid_complete_frames() {
    let mut decoder = FrameDecoder::new(ApiDialect::V2);
    assert!(decoder.push_line("data: nope\n").unwrap().is_none());
    assert!(decoder.push_line("\n").unwrap().is_none());
    assert!(decoder.push_line(": heartbeat\n").unwrap().is_none());
    assert!(matches!(
        decoder.push_line("\n").unwrap(),
        Some(NativeFrame::Heartbeat)
    ));
    let oversized = format!(": {}\n", "x".repeat(super::super::MAX_SSE_LINE_BYTES));
    assert!(decoder.push_line(&oversized).is_err());
}

#[test]
fn v2_deadline_is_separate_from_the_legacy_heartbeat_contract() {
    assert_eq!(
        silence_limit(ApiDialect::Legacy),
        std::time::Duration::from_secs(35)
    );
    assert_eq!(
        silence_limit(ApiDialect::V2),
        std::time::Duration::from_secs(50)
    );
}
