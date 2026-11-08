//! P4 history/fork contracts for OpenCode 2.x. Every v2 case feeds the *decoded*
//! native payload (`ResponseShape` already stripped the envelope), and the
//! negative case pins that a 2.x CLI can never be asked for the legacy
//! `session list` / `export` reads.
use super::*;
use serde_json::json;

fn session_row(id: &str, directory: &str, updated: i64) -> Value {
    json!({
        "id": id,
        "projectID": "prj_1",
        "title": format!("Session {id}"),
        "time": {"created": updated - 1000, "updated": updated},
        "location": {"directory": directory},
        "cost": 0,
        "tokens": {}
    })
}

#[test]
fn v2_history_reads_the_native_api_and_never_the_legacy_cli() {
    // The 2.x branch is selected by the version probe alone, and it returns the
    // native reader before any CLI command is built. This is the negative
    // assertion: `session list ... --pure` and `export <id> --pure` are
    // unreachable for 2.x.
    assert!(opencode_history_uses_native_api(true, Some("2.2.5")));
    assert!(opencode_history_uses_native_api(true, Some("3.0.0")));
    assert!(!opencode_history_uses_native_api(true, Some("1.18.35")));
    assert!(!opencode_history_uses_native_api(false, Some("2.2.5")));
    assert!(!opencode_history_uses_native_api(true, None));
    assert_eq!(opencode_version_major("2.2.5"), Some(2));
    assert_eq!(opencode_version_major("1.18.35"), Some(1));
    // 2.x prints `opencode v2.2.5`; a bare leading-token parse would have missed
    // it and fallen back to the forbidden legacy CLI (found live in run 9).
    assert_eq!(opencode_version_major("opencode v2.2.5"), Some(2));
    assert_eq!(opencode_version_major("v2.2.5"), Some(2));
    assert_eq!(opencode_version_major("opencode"), None);
    assert!(opencode_history_uses_native_api(true, Some("opencode v2.2.5")));
}

#[test]
fn v2_history_page_normalizes_decoded_rows_with_scope_and_cursor() {
    let payload = json!({
        "data": [
            session_row("ses_one", "D:/project/one", 1_700_000_000_000i64),
            {"id":"ses_child","parentID":"ses_one","projectID":"prj_1","title":"Child","time":{"created":1_700_000_100_000i64,"updated":1_700_000_100_000i64},"location":{"directory":"D:/project/one"}},
            session_row("ses_two", "D:/project/two", 1_700_000_200_000i64)
        ],
        "cursor": {"next": "cursor-opaque-2"}
    });
    let page = v2_history_page(&payload).unwrap();
    let items = page["items"].as_array().unwrap();
    // A child session is never a root history entry, even though the native
    // listing filter asked for roots only.
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["nativeId"], "ses_one");
    assert_eq!(items[1]["nativeId"], "ses_two");
    assert_eq!(items[0]["provider"], "opencode");
    assert_eq!(items[0]["title"], "Session ses_one");
    // The nested 2.x location keeps the same project scope as 1.x `directory`.
    assert_eq!(items[0]["cwd"], "D:/project/one");
    assert_eq!(items[0]["resumable"], true);
    assert!(items[0]["updatedAt"].as_str().unwrap().starts_with("2023-11-1"));
    assert_eq!(page["nextCursor"], "cursor-opaque-2");

    // A read error is never an empty history.
    for malformed in [json!({}), json!({"data": {}}), json!({"items": []})] {
        let error = v2_history_page(&malformed).unwrap_err();
        assert_eq!(error.code, "provider_protocol");
    }
    // No cursor means the native list is complete.
    let last = v2_history_page(&json!({"data": [session_row("ses_one", "D:/one", 1)], "cursor": {}})).unwrap();
    assert!(last.get("nextCursor").is_none());
}

#[test]
fn v2_history_collect_walks_bounded_native_pages() {
    let pages = vec![
        json!({"data": [{"id": "msg_1"}, {"id": "msg_2"}], "cursor": {"next": "c2"}}),
        json!({"data": [{"id": "msg_3"}], "cursor": {"next": "c3"}}),
        json!({"data": [{"id": "msg_4"}], "cursor": {}}),
    ];
    let mut seen: Vec<Option<String>> = Vec::new();
    let rows = v2_history_collect(|cursor| {
        seen.push(cursor.map(str::to_owned));
        let index = seen.len() - 1;
        Ok(pages[index].clone())
    })
    .unwrap();
    assert_eq!(rows.len(), 4);
    assert_eq!(seen, vec![None, Some("c2".to_owned()), Some("c3".to_owned())]);

    // A cursor that does not advance ends the walk instead of looping.
    let mut calls = 0;
    let rows = v2_history_collect(|_| {
        calls += 1;
        Ok(json!({"data": [{"id": "msg_1"}], "cursor": {"next": "same"}}))
    })
    .unwrap();
    // The first page is served with no cursor, then the repeated cursor ends it.
    assert_eq!(rows.len(), 2);
    assert_eq!(calls, 2);

    // Exceeding the bound is an explicit error, not a truncated transcript.
    let mut body = String::from("{\"data\":[");
    body.push_str(&vec!["{\"id\":\"msg_x\"}"; V2_HISTORY_MAX_MESSAGES + 1].join(","));
    body.push_str("],\"cursor\":{}}");
    let oversized: Value = serde_json::from_str(&body).unwrap();
    let error = v2_history_collect(|_| Ok(oversized.clone())).unwrap_err();
    assert_eq!(error.code, "provider_protocol");

    // Malformed pages never read as an empty transcript.
    let error = v2_history_collect(|_| Ok(json!({"data": "not-a-list"}))).unwrap_err();
    assert_eq!(error.code, "provider_protocol");
}

#[test]
fn v2_history_transcript_uses_the_live_canonical_conversion() {
    let rows = json!([
        {
            "id": "msg_user",
            "type": "user",
            "time": {"created": 1_700_000_000_000i64},
            "text": "read the sentinel",
            "files": [{"type": "file", "mime": "image/png", "uri": "data:image/png;base64,aGVsbG8="}]
        },
        {"id": "msg_switched", "type": "model-switched", "time": {"created": 1_700_000_001_000i64}, "model": {}},
        {
            "id": "msg_reply",
            "type": "assistant",
            "time": {"created": 1_700_000_002_000i64},
            "finish": "stop",
            "content": [
                {"type": "reasoning", "text": "let me look"},
                {"type": "text", "text": "the content is tt-tool-sentinel-42"},
                {
                    "type": "tool",
                    "id": "tool_1",
                    "name": "read",
                    "state": {"status": "completed", "input": {"filePath": "sentinel.txt"}, "content": "tt-tool-sentinel-42"}
                }
            ]
        },
        {"id": "msg_later", "type": "assistant", "time": {"created": 1_700_000_003_000i64}, "content": [{"type": "text", "text": "after"}]},
        {"id": "msg_idle", "type": "idle", "time": {"created": 1_700_000_004_000i64}}
    ]);
    let items = v2::history_transcript("ses_source", rows.as_array().unwrap()).unwrap();
    assert_eq!(items.len(), 3, "switched and idle rows are not transcript items");

    assert_eq!(items[0]["role"], "user");
    assert_eq!(items[0]["turnOrigin"], "history");
    assert_eq!(items[0]["parts"][0]["text"], "read the sentinel");
    assert_eq!(items[0]["parts"][0]["data"]["images"][0], "data:image/png;base64,aGVsbG8=");

    assert_eq!(items[1]["role"], "assistant");
    assert_eq!(items[1]["parts"][0]["type"], "thinking");
    assert_eq!(items[1]["parts"][0]["text"], "let me look");
    assert_eq!(items[1]["parts"][1]["type"], "text");
    assert_eq!(items[1]["parts"][2]["type"], "tool");
    assert_eq!(items[1]["parts"][2]["toolName"], "read");
    assert_eq!(items[1]["parts"][2]["status"], "completed");
    assert_eq!(items[1]["parts"][2]["data"]["result"]["content"], "tt-tool-sentinel-42");
    assert_eq!(items[1]["turnOrigin"], "history");
    assert_eq!(items[1]["forkAnchor"], json!({"nativeId": "ses_source", "messageId": "msg_reply"}));
    assert_eq!(items[1]["turnStatus"], "completed");
    // The last reply is settled by the trailing idle row, not by a guess.
    assert_eq!(items[2]["turnStatus"], "completed");

    // Malformed history is an error, never an empty transcript.
    for rows in [
        json!([{"id": "msg_1", "type": "assistant"}]),
        json!([{"id": "msg_1", "type": "unknown-type"}]),
        json!([{"type": "user", "text": "no id"}]),
    ] {
        let error = v2::history_transcript("ses_source", rows.as_array().unwrap()).unwrap_err();
        assert_eq!(error.code, "provider_protocol");
    }
}

#[test]
fn v2_fork_uses_the_exclusive_next_row_as_before() {
    let rows = json!([
        {"id": "msg_user", "type": "user"},
        {"id": "msg_selected", "type": "assistant"},
        {"id": "msg_later", "type": "assistant"},
        {"id": "msg_latest", "type": "assistant"}
    ]);
    let rows = rows.as_array().unwrap();
    // The selected reply is included because `before` is the row after it; later
    // content is excluded.
    assert_eq!(v2_fork_before("msg_selected", rows).unwrap(), Some("msg_later".to_owned()));
    assert_eq!(v2_fork_before("msg_user", rows).unwrap(), Some("msg_selected".to_owned()));
    // A selected last reply needs no cutoff: the full history ends with it.
    assert_eq!(v2_fork_before("msg_latest", rows).unwrap(), None);
    // An anchor that is no longer in history is uncertain: no fork is attempted
    // and the caller must not fall through to copy/repost.
    let error = v2_fork_before("msg_gone", rows).unwrap_err();
    assert_eq!(error.code, "operation_outcome_unknown");
}

#[test]
fn v2_fork_never_reports_an_uncertain_outcome_as_unsupported() {
    // Only the legacy path may answer "this provider cannot fork" (Ok(None) is
    // the copy fallback). Every 2.x native failure is uncertain, so the v2 fork
    // errors never carry a copy-fallback code.
    for code in ["operation_outcome_unknown", "provider_protocol"] {
        assert!(!matches!(
            code,
            "unsupported"
                | "native_fork_unsupported"
                | "invalid_fork_anchor"
                | "invalid_fork_request"
                | "invalid_native_id"
        ));
    }
    assert_eq!(
        v2_fork_before("msg_gone", &[]).unwrap_err().code,
        "operation_outcome_unknown"
    );
}

#[test]
fn v2_terminal_resume_refuses_a_missing_exact_id_and_never_picks_latest() {
    // 2.2.5 documents `--session` as "Session ID to continue, or to create if
    // it does not exist", so a naive resume of an unknown ID would create a new
    // conversation that looks like a resume. Only a native 404 proves the exact
    // ID is gone, and the refusal must name that ID.
    let missing = v2_missing_session_error("ses_known_missing");
    assert_eq!(missing.code, "session_has_no_native_history");
    assert!(missing.message.contains("ses_known_missing"), "the exact ID is reported");
    assert!(!missing.message.contains("latest"), "no latest-session wording");
    assert!(v2_session_is_missing(
        &ProviderError::new("provider_error", "OpenCode returned 404 Not Found")
            .with_details(json!({"httpStatus":404}))
    ));
    for other in [
        ProviderError::new("provider_error", "server error").with_details(json!({"httpStatus":500})),
        ProviderError::new("provider_error", "unauthorized").with_details(json!({"httpStatus":401})),
        ProviderError::new("provider_disconnected", "timed out"),
        ProviderError::new("provider_protocol", "malformed"),
    ] {
        assert!(!v2_session_is_missing(&other), "only a 404 is a missing session");
    }
    // The resume command stays exact-ID only: no `--continue`, no bare launch,
    // and 2.x always asks for a private server so no background service is
    // started or adopted by an owned terminal.
    let exact = opencode_terminal_args(Some("ses_exact"), true);
    assert_eq!(exact, vec!["--session", "ses_exact", "--standalone"]);
    let prepared = opencode_terminal_args(Some("ses_prepared"), true);
    assert!(prepared.iter().any(|arg| arg == "ses_prepared"));
    for args in [&exact, &prepared] {
        assert!(!args.iter().any(|arg| arg == "--continue" || arg == "-c"));
        assert!(args.iter().any(|arg| arg == "--standalone"), "2.x owns its server");
    }
    // 1.18.35 has no `--standalone` flag; its launch stays byte-for-byte.
    assert_eq!(
        opencode_terminal_args(Some("ses_exact"), false),
        vec!["--session", "ses_exact"]
    );
    assert!(opencode_terminal_args(None, false).is_empty());
}

#[test]
fn legacy_empty_session_list_is_an_empty_page_not_a_protocol_error() {
    // 1.18.35 exits 0 with empty stdout on an empty store (verified live in
    // run 9/10). Whitespace-only output is the same empty page.
    assert!(opencode_legacy_history_json("").unwrap().is_none());
    assert!(opencode_legacy_history_json("  \r\n").unwrap().is_none());
    let rows = opencode_legacy_history_json("[{\"id\":\"ses_one\"}]").unwrap().unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 1);
    // Malformed output stays an explicit error: never an empty history.
    assert_eq!(
        opencode_legacy_history_json("{not json").unwrap_err().code,
        "provider_protocol"
    );
}
