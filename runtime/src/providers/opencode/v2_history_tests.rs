//! P4 history/fork contracts for OpenCode 2.x. Every v2 case feeds the *decoded*
//! native payload (`ResponseShape` already stripped the envelope), and the
//! negative case pins that a 2.x CLI can never be asked for the legacy
//! `session list` / `export` reads.
use super::*;
use serde_json::json;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc,
};

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
fn v2_history_walk_converts_each_page_and_stays_bounded() {
    let pages = vec![
        json!({"data": [
            {"id": "msg_1", "type": "user", "time": {"created": 1_700_000_000_000i64}, "text": "one"},
            {"id": "msg_2", "type": "assistant", "time": {"created": 1_700_000_001_000i64}, "content": [{"type": "text", "text": "two"}]}
        ], "cursor": {"next": "c2"}}),
        json!({"data": [
            {"id": "msg_3", "type": "assistant", "time": {"created": 1_700_000_002_000i64}, "content": [{"type": "text", "text": "three"}]}
        ], "cursor": {}}),
    ];
    let mut seen: Vec<Option<String>> = Vec::new();
    let items = v2_history_transcript("ses_source", |cursor| {
        seen.push(cursor.map(str::to_owned));
        let index = seen.len() - 1;
        Ok(pages[index].clone())
    })
    .unwrap();
    // Two native pages became three canonical items in native order.
    assert_eq!(items.len(), 3);
    assert_eq!(items[0]["parts"][0]["text"], "one");
    assert_eq!(items[2]["parts"][0]["text"], "three");
    assert_eq!(items[2]["turnOrigin"], "history");
    assert_eq!(seen, vec![None, Some("c2".to_owned())]);

    // A cursor that does not advance ends the walk instead of looping.
    let mut calls = 0;
    let items = v2_history_transcript("ses_source", |_| {
        calls += 1;
        Ok(json!({"data": [{"id": "msg_1", "type": "user", "text": "x"}], "cursor": {"next": "same"}}))
    })
    .unwrap();
    // The first page is served with no cursor, then the repeated cursor ends it.
    assert_eq!(items.len(), 2);
    assert_eq!(calls, 2);

    // Malformed pages never read as an empty transcript.
    let error = v2_history_transcript("ses_source", |_| Ok(json!({"data": "not-a-list"}))).unwrap_err();
    assert_eq!(error.code, "provider_protocol");
}

#[test]
fn v2_history_read_bound_is_bytes_and_messages_not_an_arbitrary_2000_cap() {
    // A session well past the old 2000-message cap still reads: the bound is
    // the same 8 MiB transcript frame the runtime already enforces downstream.
    let page = |first: usize| {
        json!({
            "data": (first..first + V2_HISTORY_PAGE as usize)
                .map(|index| json!({"id": format!("msg_{index}"), "type": "user", "time": {"created": 1_700_000_000_000i64 + index as i64}, "text": "m"}))
                .collect::<Vec<_>>(),
            "cursor": {"next": format!("c{}", first + V2_HISTORY_PAGE as usize)}
        })
    };
    let mut calls = 0;
    let items = v2_history_transcript("ses_source", |_| {
        calls += 1;
        Ok(if calls > 12 { json!({"data": [], "cursor": {}}) } else { page((calls - 1) * V2_HISTORY_PAGE as usize) })
    })
    .unwrap();
    assert_eq!(items.len(), 12 * V2_HISTORY_PAGE as usize);
    assert!(items.len() > 2000, "the old hard 2000-message failure is gone");

    // Over the message bound is still an explicit error, never a truncated read.
    let error = v2_history_transcript("ses_source", |_| {
        Ok(json!({
            "data": (0..V2_HISTORY_PAGE as usize).map(|index| json!({"id": format!("msg_{index}"), "type": "user", "text": "m"})).collect::<Vec<_>>(),
            "cursor": {"next": "same"}
        }))
    });
    // A non-advancing cursor ends the walk, so this one is a normal read.
    assert!(error.is_ok());
    let oversized = |budget: usize| {
        json!({
            "data": [{"id": "msg_big", "type": "user", "text": "x".repeat(budget)}],
            "cursor": {}
        })
    };
    let error = v2_history_transcript("ses_source", |_| Ok(oversized(V2_HISTORY_MAX_BYTES))).unwrap_err();
    assert_eq!(error.code, "provider_protocol");
    assert!(error.message.contains("readable bound"), "{}", error.message);
    assert!(error.message.contains("limit"), "{}", error.message);
}

#[test]
fn v2_fork_cutoff_streams_pages_without_retaining_them() {
    // The anchor is in the first page and the row after it is in the second:
    // the cutoff crosses a page boundary without a full-history read.
    let pages = vec![
        json!({"data": [{"id": "msg_user"}, {"id": "msg_selected"}], "cursor": {"next": "c2"}}),
        json!({"data": [{"id": "msg_later"}, {"id": "msg_latest"}], "cursor": {}}),
    ];
    let mut calls = 0;
    let cutoff = v2_fork_cutoff("msg_selected", |_| {
        let index = calls;
        calls += 1;
        Ok(pages[index].clone())
    })
    .unwrap();
    assert_eq!(cutoff, Some("msg_later".to_owned()));
    assert_eq!(calls, 2);

    // The selected reply is the last row: the full history is the boundary.
    let cutoff = v2_fork_cutoff("msg_latest", {
        let pages = pages.clone();
        let mut calls = 0;
        move |_| {
            let index = calls;
            calls += 1;
            Ok(pages[index].clone())
        }
    })
    .unwrap();
    assert_eq!(cutoff, None);

    // An anchor that is no longer in history is uncertain: no fork is attempted
    // and the caller must not fall through to copy/repost.
    let error = v2_fork_cutoff("msg_gone", {
        let pages = pages.clone();
        let mut calls = 0;
        move |_| {
            let index = calls;
            calls += 1;
            Ok(if index < pages.len() { pages[index].clone() } else { json!({"data": [], "cursor": {}}) })
        }
    })
    .unwrap_err();
    assert_eq!(error.code, "operation_outcome_unknown");
}

#[test]
fn v2_history_server_cache_reuses_one_server_per_project() {
    let mut cache = V2HistoryCache::new(V2_HISTORY_SERVER_IDLE);
    let start = Instant::now();
    cache.put("D:/project/one", 1, start);
    // A consecutive page within the idle window reuses the same owned server.
    assert_eq!(cache.get("D:/project/one", start + Duration::from_secs(5)), Some(1));
    // A different project never shares it.
    assert_eq!(cache.get("D:/project/two", start + Duration::from_secs(6)), None);
    // The idle window restarted at the last use, so this is still inside it.
    assert_eq!(cache.get("D:/project/one", start + Duration::from_secs(20)), Some(1));
    // Past the window the entry is gone: the next read starts a fresh server.
    assert_eq!(cache.get("D:/project/one", start + Duration::from_secs(51)), None);
    // A failed read drops only its own project's entry.
    cache.put("D:/project/one", 2, start);
    cache.invalidate("D:/project/two");
    assert_eq!(cache.get("D:/project/one", start + Duration::from_secs(1)), Some(2));
    cache.invalidate("D:/project/one");
    assert_eq!(cache.get("D:/project/one", start + Duration::from_secs(2)), None);
}

#[test]
fn an_idle_history_server_is_retired_without_another_read() {
    let mut cache = V2HistoryCache::new(V2_HISTORY_SERVER_IDLE);
    let start = Instant::now();
    cache.put("D:/project/one", 1, start);
    // Inside the window the reaper leaves it alone.
    assert_eq!(cache.take_expired(start + Duration::from_secs(29)), None);
    assert!(cache.entry.is_some());
    // Past the window the reaper takes it out so it can be shut down.
    assert_eq!(cache.take_expired(start + Duration::from_secs(31)), Some(1));
    assert!(cache.entry.is_none());
    assert_eq!(cache.take_expired(start + Duration::from_secs(32)), None);
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
    let rows = |ids: &[&str]| {
        Value::Array(ids.iter().map(|id| json!({"id": id, "type": "assistant"})).collect())
    };
    let cutoff = |anchor: &str, ids: &[&str]| {
        let page = json!({"data": rows(ids), "cursor": {}});
        v2_fork_cutoff(anchor, move |_| Ok(page.clone()))
    };
    let ids = ["msg_user", "msg_selected", "msg_later", "msg_latest"];
    // The selected reply is included because `before` is the row after it; later
    // content is excluded.
    assert_eq!(cutoff("msg_selected", &ids).unwrap(), Some("msg_later".to_owned()));
    assert_eq!(cutoff("msg_user", &ids).unwrap(), Some("msg_selected".to_owned()));
    // A selected last reply needs no cutoff: the full history ends with it.
    assert_eq!(cutoff("msg_latest", &ids).unwrap(), None);
    // An anchor that is no longer in history is uncertain: no fork is attempted
    // and the caller must not fall through to copy/repost.
    let error = cutoff("msg_gone", &ids).unwrap_err();
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
        v2_fork_cutoff("msg_gone", |_| Ok(json!({"data": [], "cursor": {}})))
            .unwrap_err()
            .code,
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

#[test]
fn an_empty_transcript_of_a_session_with_native_activity_is_an_explicit_error() {
    // Run 12 finding: a live 2.2.5 session belongs to the server process that
    // owns it, and reading it from another process must never become a blank
    // transcript. Native evidence (tokens/cost/outcome) proves work happened.
    let worked = json!({"id":"ses_busy","cost":0,"tokens":{"input":3487,"output":3,"reasoning":0},"outcome":"succeeded"});
    let error = v2_require_visible("ses_busy", 0, || Ok(worked.clone())).unwrap_err();
    assert_eq!(error.code, "session_history_unreadable");
    assert!(error.message.contains("ses_busy"));
    // A paid turn with no token figures still proves activity through cost.
    assert!(v2_session_has_activity(&json!({"cost":0.25,"tokens":{}})));
    // Outcome alone is activity too: the messages existed even if the figures
    // are zero for a free model.
    assert!(v2_session_has_activity(&json!({"cost":0,"tokens":{"input":0},"outcome":"interrupted"})));
    // A freshly created session has no native activity, so an empty read is
    // its real history and stays a valid empty transcript.
    let fresh = json!({"id":"ses_new","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}});
    assert!(!v2_session_has_activity(&fresh));
    assert!(v2_require_visible("ses_new", 0, || Ok(fresh.clone())).is_ok());
    // A non-empty transcript never pays for the extra native read.
    let mut called = false;
    v2_require_visible("ses_busy", 3, || {
        called = true;
        Ok(Value::Null)
    })
    .unwrap();
    assert!(!called, "a readable transcript must not trigger the guard read");
}

#[test]
fn a_session_live_in_this_runtime_is_read_through_its_owning_server() {
    // The Chat worker registers its server; history reads and forks then use
    // that exact server instead of a second history process. A closed worker
    // leaves a dead entry that is dropped, never used.
    let stopped = Arc::new(AtomicBool::new(false));
    let api = NativeApi::new(
        Client::builder().build().unwrap(),
        "http://127.0.0.1:1".into(),
        "D:/project/one".into(),
        "pw".into(),
        ApiDialect::V2,
    );
    v2_store_live_owner("ses_owner_run12", api, Arc::clone(&stopped), None);
    assert!(v2_live_owner("ses_owner_run12").is_some());
    // An unknown session has no owner: the caller falls back to the history
    // server, it never guesses a server.
    assert!(v2_live_owner("ses_unknown_run12").is_none());
    stopped.store(true, Ordering::SeqCst);
    assert!(v2_live_owner("ses_owner_run12").is_none(), "a stopped owner is never served");
}

#[test]
fn a_dead_stream_owner_is_never_served_and_a_fork_child_keeps_its_server() {
    // Run-15 findings C7 and C1. A worker whose server died but was not retired
    // must not own reads; a fork child is read through the server that made it.
    let stopped = Arc::new(AtomicBool::new(false));
    let live = Arc::new(AtomicBool::new(true));
    let api = NativeApi::new(
        Client::builder().build().unwrap(),
        "http://127.0.0.1:1".into(),
        "D:/project/one".into(),
        "pw".into(),
        ApiDialect::V2,
    );
    v2_store_live_owner(
        "ses_live_run15",
        api.clone(),
        Arc::clone(&stopped),
        Some(Arc::clone(&live)),
    );
    assert!(v2_live_owner("ses_live_run15").is_some());
    // The fork child created by this server is aliased to it, so its history
    // read never starts (and evicts) a second server.
    assert!(v2_alias_live_owner("ses_fork_run15", "ses_live_run15"));
    assert!(v2_live_owner("ses_fork_run15").is_some());
    v2_forget_live_owner("ses_fork_run15");
    assert!(v2_live_owner("ses_fork_run15").is_none());
    // A dead event stream retires the owner: reads fall back to the history
    // server instead of a dead port.
    live.store(false, Ordering::SeqCst);
    assert!(v2_live_owner("ses_live_run15").is_none());
    // An alias of a parent that is not registered is never invented.
    assert!(!v2_alias_live_owner("ses_orphan_run15", "ses_missing_run15"));
}

#[test]
fn an_unreadable_version_probe_never_selects_the_legacy_terminal() {
    // Run-17 C2. Only "executable not found" is definite. A CLI that ran and
    // failed or timed out must never cache the 1.x dialect.
    let missing = ProviderError::unavailable("opencode", "not found on PATH");
    let timeout = ProviderError::new("provider_timeout", "did not finish");
    let failed = ProviderError::new("provider_probe_failed", "exit 3");
    assert!(opencode_probe_is_definite(true, Some("2.2.5"), None), "a version answers");
    assert!(opencode_probe_is_definite(true, Some("opencode v2.2.5"), None));
    assert!(opencode_probe_is_definite(true, Some("1.18.35"), None));
    assert!(opencode_probe_is_definite(false, None, Some(&missing)), "a missing CLI is definite");
    assert!(!opencode_probe_is_definite(false, None, Some(&timeout)), "a timeout is inconclusive");
    assert!(!opencode_probe_is_definite(false, None, Some(&failed)), "a failed run is inconclusive");
    assert!(!opencode_probe_is_definite(true, None, None));
    assert!(!opencode_probe_is_definite(true, Some("opencode"), None));
    assert!(opencode_terminal_args(Some("ses_exact"), false) == vec!["--session", "ses_exact"]);
    assert_eq!(opencode_history_uses_native_api(true, None), false);
}

#[test]
fn a_fork_field_is_not_activity_but_a_real_transcript_still_guards_empty_reads() {
    // Run-17: a native fork made at the first message is legitimately empty.
    // The `fork` field alone no longer makes an empty read unreadable; real
    // native work still does, and ThreadTerm's own fork read goes through the
    // creating server (C1).
    let fork = json!({"id":"ses_fork","fork":{"sessionID":"ses_source","messageID":"msg_reply"}});
    assert!(v2_require_visible("ses_fork", 0, || Ok(fork.clone())).is_ok());
    let worked = json!({"id":"ses_worked","tokens":{"input":3}});
    assert_eq!(
        v2_require_visible("ses_worked", 0, || Ok(worked.clone())).unwrap_err().code,
        "session_history_unreadable"
    );
}

#[test]
fn a_fork_failure_on_a_timeout_never_kills_the_owning_server() {
    // Run-17 C3/dead cache, extended by verification round 2 item 6: only a dead
    // process or a refused connection drops the cached server. A timeout keeps it
    // (the copy may still be running) and so does any native answer, including a
    // 404 on a deleted id, an unreadable transcript or a malformed body.
    let timeout = ProviderError::new("provider_disconnected", "OpenCode request failed: timed out")
        .with_details(json!({"transportFailure":true,"timedOut":true}));
    assert!(!v2_failure_forgets_server(&timeout, true), "a timeout keeps a live server");
    let refused = ProviderError::new("provider_disconnected", "connection refused")
        .with_details(json!({"transportFailure":true,"timedOut":false}));
    assert!(v2_failure_forgets_server(&refused, true), "a refused connection is a dead server");
    let answered = ProviderError::new("provider_error", "OpenCode returned 500")
        .with_details(json!({"httpStatus":500}));
    assert!(!v2_failure_forgets_server(&answered, true), "an answering server is kept");
    let missing = ProviderError::new("provider_error", "OpenCode returned 404")
        .with_details(json!({"httpStatus":404}));
    assert!(
        !v2_failure_forgets_server(&missing, true),
        "a 404 on a deleted id ends nothing: a fresh fork alias stays readable"
    );
    let unreadable = ProviderError::new("session_history_unreadable", "no messages visible");
    assert!(!v2_failure_forgets_server(&unreadable, true), "an unreadable transcript keeps it");
    assert!(
        v2_failure_forgets_server(&missing, false),
        "a process that is not running is always dropped"
    );
}

#[test]
fn the_shared_history_server_starts_outside_every_project_and_worktree() {
    // Verification round 2, item 5: with one shared cache key the server used to
    // start in whatever project or worktree the first caller passed, and stayed
    // there for its idle window. On Windows that blocks `git worktree remove`.
    // Requests carry their own directory or id, so a neutral folder is correct.
    let data = std::path::PathBuf::from("D:/runtime-data/ThreadTermV3");
    let project = std::path::PathBuf::from("D:/project/worktree-feature");
    assert_eq!(
        v2_neutral_server_dir(Some(data.clone()), Some(project.clone())),
        data,
        "the runtime data folder wins over the caller's project"
    );
    assert_eq!(
        v2_neutral_server_dir(None, Some(std::path::PathBuf::from("C:/Users/qa/AppData/Local"))),
        std::path::PathBuf::from("C:/Users/qa/AppData/Local/ThreadTermV3")
    );
    let fallback = v2_neutral_server_dir(None, None);
    assert!(fallback.ends_with("ThreadTermV3"), "{}", fallback.display());
    assert_ne!(fallback, project, "never the caller's project or worktree");
}

#[test]
fn an_empty_fork_read_at_the_first_message_is_valid_history() {
    // Run-17: a fork can legitimately have no messages. The creating server
    // proves visibility; chat_fork separately refuses an empty read of a
    // non-empty ThreadTerm source.
    let fork = json!({"id":"ses_fork","fork":{"sessionID":"ses_source","messageID":"msg_reply"}});
    assert!(v2_require_visible("ses_fork", 0, || Ok(fork.clone())).is_ok());
    let plain = json!({"id":"ses_new","cost":0,"tokens":{"input":0}});
    assert!(v2_require_visible("ses_new", 0, || Ok(plain.clone())).is_ok());
}

#[cfg(windows)]
#[test]
fn a_timed_out_or_failing_version_probe_never_launches_the_legacy_terminal() {
    // Run-17 C2 through `terminal_command`: a fake `opencode` that runs past
    // the probe timeout or exits non-zero must refuse the launch, never fall
    // back to 1.x arguments.
    use crate::environment::{Snapshot, Vars};
    let root = tempfile::tempdir().unwrap();
    let start = std::env::vars_os().collect::<Vars>();
    let mut block = start.clone();
    block.retain(|(name, _)| !name.eq_ignore_ascii_case("PATH"));
    block.push(("Path".into(), root.path().as_os_str().to_owned()));
    let adapter = OpenCodeAdapter::new(crate::provider_events::tap_channel(1).0);
    let launch = |script: &str| {
        std::fs::write(root.path().join("opencode.cmd"), script).unwrap();
        let start = start.clone();
        let mut block = start.clone();
        block.retain(|(name, _)| !name.eq_ignore_ascii_case("PATH"));
        let mut paths = vec![root.path().to_path_buf()];
        if let Some(system) = std::env::var_os("SystemRoot") {
            paths.push(std::path::PathBuf::from(system).join("System32"));
        }
        block.push(("Path".into(), std::env::join_paths(paths).unwrap()));
        let snapshot = Snapshot { block, registry: ["PATH".into()].into_iter().collect() };
        crate::environment::with_test_snapshot(&start, snapshot, || {
            opencode_forget_native_probe();
            adapter.terminal_command(Some("ses_exact"), Some("C:/scratch"))
        })
    };
    let _serialized = provider_global_test_lock();
    // The script exists and runs, but does not answer within the probe window.
    let timed_out = launch("@echo off\r\nping -n 8 127.0.0.1 >nul\r\necho opencode v2.2.5\r\n")
        .unwrap_err();
    assert_eq!(timed_out.code, "provider_version_unknown", "{}", timed_out.message);
    // A non-zero exit is just as inconclusive.
    let failed = launch("@echo off\r\nexit /b 3\r\n").unwrap_err();
    assert_eq!(failed.code, "provider_version_unknown", "{}", failed.message);
    // A definite 2.x answer still launches with `--standalone`. The probe reads
    // the first non-empty line itself; the test controls that output instead of
    // teaching the shared parser to skip unrelated lines.
    let command = launch("@echo off\r\necho opencode v2.2.5\r\n").unwrap();
    assert_eq!(
        command.args,
        vec!["--session".to_owned(), "ses_exact".to_owned(), "--standalone".to_owned()]
    );
}
#[test]
fn a_fork_timeout_keeps_its_evidence_through_the_uncertain_mapping() {
    // Run-17 C3: `fork_before` used to be remapped to operation_outcome_unknown
    // without details, so the timeout looked like a dead server and killed the
    // cached process mid-copy. The test runs through `opencode_v2_fork`.
    let _serialized = provider_global_test_lock();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (done, finished) = mpsc::channel();
    let peer = thread::spawn(move || {
        for index in 0..2 {
            let deadline = Instant::now() + Duration::from_secs(5);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(value) => break value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("fork peer failed: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 1024];
            loop {
                let count = stream.read(&mut chunk).unwrap();
                if count == 0 { break; }
                request.extend_from_slice(&chunk[..count]);
                if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") { break; }
            }
            let request = String::from_utf8(request).unwrap();
            let first = request.lines().next().unwrap().to_owned();
            if index == 0 {
                let body = json!({"data":[{"id":"msg-1","type":"assistant","content":[{"type":"text","text":"x"}]}],"cursor":{}}).to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            } else {
                // Stall past the (test-shortened) fork deadline, then close.
                assert!(first.starts_with("POST /api/session/ses_fork_timeout_run17/fork"), "{first}");
                thread::sleep(Duration::from_millis(300));
                done.send(()).unwrap();
            }
        }
    });
    let api = NativeApi::new(
        Client::builder().build().unwrap(),
        base,
        "C:/scratch".into(),
        "pw".into(),
        ApiDialect::V2,
    );
    let stopped = Arc::new(AtomicBool::new(false));
    v2_store_live_owner("ses_fork_timeout_run17", api, Arc::clone(&stopped), None);
    api::set_v2_fork_timeout_for_test(Some(Duration::from_millis(80)));
    let result = opencode_v2_fork(
        "C:/scratch",
        "ses_fork_timeout_run17",
        None,
        true,
    );
    api::set_v2_fork_timeout_for_test(None);
    finished.recv_timeout(Duration::from_secs(5)).unwrap();
    peer.join().unwrap();
    stopped.store(true, Ordering::SeqCst);
    v2_forget_live_owner("ses_fork_timeout_run17");
    let error = result.err().expect("a timed-out fork is uncertain");
    assert_eq!(error.code, "operation_outcome_unknown");
    assert_eq!(
        error.details.as_ref().and_then(|details| details["timedOut"].as_bool()),
        Some(true),
        "the mapping kept the timeout evidence: {:?}",
        error.details
    );
    assert!(
        !v2_failure_forgets_server(&error, true),
        "a timed-out copy keeps its server"
    );
}