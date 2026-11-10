//! Item 8 of the session-release Phase 2 plan (run 7): every approval, answer,
//! delegation and turn-completion path reads only the rows it needs. These tests
//! pin two things on one transcript fixture:
//!
//! - each bounded query answers exactly what the whole-transcript scan it replaced
//!   answered (the "old scan" helpers below are that scan, kept deliberately);
//! - no path loads a whole transcript (`Database::chat_snapshot` counts them per
//!   thread).

use crate::db::{CreateSession, Database};
use crate::domain::ChatItem;
use rusqlite::params;
use serde_json::{json, Value};

struct Fixture {
    _dir: tempfile::TempDir,
    db: Database,
    session: String,
}

fn approval_part(id: &str, status: &str, data: Value) -> Value {
    json!({"type":"approval","approvalId":id,"status":status,"data":data})
}

fn put(db: &Database, session: &str, item: ChatItem) {
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES (?,?,?,?,?,?)",
            params![
                item.id,
                session,
                item.turn_id,
                "message",
                serde_json::to_string(&item)?,
                item.created_at
            ],
        )?;
        Ok(())
    })
    .unwrap();
}

fn item(id: &str, role: &str, turn: Option<&str>, created_at: &str, parts: Vec<Value>) -> ChatItem {
    ChatItem {
        id: id.into(),
        role: role.into(),
        parts,
        created_at: created_at.into(),
        turn_id: turn.map(str::to_owned),
        elapsed_ms: None,
        turn_status: None,
        turn_origin: None,
        fork_anchor: None,
        turn_model: None,
        turn_usage: None,
        turn_review: None,
    }
}

/// One chat with every approval shape the bounded reads must agree on: pending,
/// submitting, resolved, another turn's, a browser eval, a widening card, a
/// parent-routed and a user-routed request, and an `ask_user` card.
///
/// It also holds the two shapes that used to break or mislead the lookups
/// (decisions Y and X): a non-approval part ahead of the real cards that carries
/// their `approvalId`, a pending `ask_user` card without an `approvalId`, and one
/// on an item without a turn.
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("runtime.sqlite")).unwrap();
    let session = db
        .create_session(CreateSession {
            project_id: None,
            title: None,
            provider: "codex",
            mode: "chat",
            native_id: None,
            operation_id: "bounded-reads",
        })
        .unwrap()
        .id;
    // Ahead of the real cards, like a tool part that reused an id (Y).
    put(
        &db,
        &session,
        item(
            "decoy",
            "assistant",
            Some("t0"),
            "2026-11-08T23:59:59Z",
            vec![
                json!({"type":"tool","approvalId":"ask-parent","data":{"tool":"run"}}),
                json!({"type":"tool","approvalId":"widen","data":{"tool":"run"}}),
                json!({"type":"tool","approvalId":"tool-only","data":{"tool":"run"}}),
            ],
        ),
    );
    put(
        &db,
        &session,
        item("u1", "user", Some("t1"), "2026-11-09T00:00:00Z", vec![json!({"type":"text","text":"first words"})]),
    );
    put(
        &db,
        &session,
        item(
            "a1",
            "assistant",
            Some("t1"),
            "2026-11-09T00:00:01Z",
            vec![
                json!({"type":"text","text":"working on it"}),
                approval_part(
                    "ask-parent",
                    "pending",
                    json!({"interaction":"permission","title":"Run tests","delegation":{"route":"parent"},"choices":[
                        {"choiceId":"allow","scope":"once"},
                        {"choiceId":"always","scope":"persistent"}
                    ]}),
                ),
                approval_part("ask-resolved", "resolved", json!({"interaction":"permission"})),
                approval_part(
                    "browser-eval",
                    "pending",
                    json!({"interaction":"permission","runtimeOwned":true,"requestType":"threadterm.browser_eval"}),
                ),
                approval_part(
                    "widen",
                    "pending",
                    json!({"interaction":"permission","requestType":"threadterm.delegation.authority"}),
                ),
                approval_part(
                    "ask-user",
                    "pending",
                    json!({"interaction":"question","threadtermTool":"ask_user"}),
                ),
                // X: a pending ask_user card without an approval id.
                json!({"type":"approval","status":"pending","data":{"interaction":"question","threadtermTool":"ask_user"}}),
            ],
        ),
    );
    // X: a pending ask_user card on an item without a turn.
    put(
        &db,
        &session,
        item(
            "a1-no-turn",
            "assistant",
            None,
            "2026-11-09T00:00:01.5Z",
            vec![approval_part(
                "ask-user-no-turn",
                "pending",
                json!({"interaction":"question","threadtermTool":"ask_user"}),
            )],
        ),
    );
    put(
        &db,
        &session,
        item(
            "u2",
            "user",
            Some("t2"),
            "2026-11-09T00:00:02Z",
            vec![json!({"type":"text","text":"second words"})],
        ),
    );
    put(
        &db,
        &session,
        item(
            "a2",
            "assistant",
            Some("t2"),
            "2026-11-09T00:00:03Z",
            vec![
                json!({"type":"text","text":"done"}),
                approval_part("ask-other-turn", "pending", json!({"interaction":"permission"})),
                approval_part(
                    "ask-user-route",
                    "submitting",
                    json!({"interaction":"permission","delegation":{"route":"user"}}),
                ),
            ],
        ),
    );
    Fixture { _dir: dir, db, session }
}

/// The scan the bounded lookups replaced: every item, every part, in order.
fn scan_parts(db: &Database, session: &str) -> Vec<(Option<String>, Value)> {
    db.chat_items(session)
        .unwrap()
        .into_iter()
        .flat_map(|item| item.parts.into_iter().map(move |part| (item.turn_id.clone(), part)))
        .collect()
}

fn scan_route(db: &Database, session: &str) -> Option<&'static str> {
    let mut route = None;
    for (_, part) in scan_parts(db, session) {
        if part.get("type").and_then(Value::as_str) != Some("approval")
            || !matches!(
                part.get("status").and_then(Value::as_str),
                Some("pending" | "submitting")
            )
        {
            continue;
        }
        if part.pointer("/data/delegation/route").and_then(Value::as_str) == Some("parent") {
            route.get_or_insert("parent");
        } else {
            return Some("user");
        }
    }
    route
}

fn scan_has_pending_attention(db: &Database, session: &str) -> bool {
    scan_parts(db, session).iter().any(|(_, part)| {
        part.get("type").and_then(Value::as_str) == Some("approval")
            && matches!(
                part.get("status").and_then(Value::as_str),
                Some("pending" | "submitting")
            )
    })
}

#[test]
fn the_approval_lookup_matches_the_whole_transcript_scan() {
    let fixture = fixture();
    let scanned = scan_parts(&fixture.db, &fixture.session);
    // The scans the lookup replaced looked for approval parts only (Y).
    let expected_part = |id: &str| {
        scanned
            .iter()
            .find(|(_, part)| {
                part.get("type").and_then(Value::as_str) == Some("approval")
                    && part.get("approvalId").and_then(Value::as_str) == Some(id)
            })
    };
    for id in [
        "ask-parent",
        "ask-resolved",
        "browser-eval",
        "widen",
        "ask-user",
        "ask-other-turn",
        "ask-user-route",
        "tool-only",
        "missing",
    ] {
        let found = fixture.db.chat_approval_part(&fixture.session, id).unwrap();
        let expected = expected_part(id);
        match (found, expected) {
            (None, None) => {}
            (Some((turn, part)), Some((expected_turn, expected_part))) => {
                assert_eq!(&part, expected_part, "{id}");
                assert_eq!(&turn, expected_turn, "{id}");
            }
            (found, expected) => panic!("{id}: lookup {found:?} vs scan {expected:?}"),
        }
    }
}

/// Decision Y: a non-approval part that carries an approval's id must not hide the
/// card, and an id only a non-approval part carries resolves to nothing.
#[test]
fn a_non_approval_part_cannot_shadow_an_approval_card() {
    let fixture = fixture();
    let (turn, part) = fixture
        .db
        .chat_approval_part(&fixture.session, "ask-parent")
        .unwrap()
        .expect("the approval card must still be found behind the decoy part");
    assert_eq!(part["type"], "approval");
    assert_eq!(part["data"]["title"], "Run tests");
    assert_eq!(turn.as_deref(), Some("t1"));
    let widening = crate::delegation::widening_part(&fixture.db, &fixture.session, "widen")
        .unwrap()
        .expect("the widening card must still be found behind the decoy part");
    assert_eq!(widening["data"]["requestType"], "threadterm.delegation.authority");
    assert_eq!(
        fixture.db.chat_approval_part(&fixture.session, "tool-only").unwrap(),
        None,
        "a non-approval part must not answer for an approval"
    );
    // `respond` applies the same type filter to this lookup.
    let respond_part = fixture
        .db
        .chat_approval_part(&fixture.session, "ask-parent")
        .unwrap()
        .map(|(_, part)| part)
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("approval"));
    assert!(respond_part.is_some());
}

/// Decision X: a malformed `ask_user` card must be skipped, not fail the query.
#[test]
fn malformed_ask_user_cards_are_skipped() {
    let fixture = fixture();
    let asks = crate::chat_tools::pending_ask_user_parts(&fixture.db).unwrap();
    assert_eq!(
        asks,
        vec![(fixture.session.clone(), "t1".to_owned(), "ask-user".to_owned())],
        "only the card with an approval id and a turn may be expired"
    );
    // The runtime start path (ChatTools::new -> expire_orphaned_asks) succeeds.
    let path = fixture.db.path().to_path_buf();
    let tools = crate::chat_tools::shared(&path, std::sync::Arc::new(Database::open(&path).unwrap()))
        .expect("runtime start must survive a malformed ask_user card");
    assert!(std::sync::Arc::strong_count(&tools) >= 1);
}

#[test]
fn the_bounded_queries_match_the_whole_transcript_scan() {
    let fixture = fixture();
    // Approve/answer routes: who waits for the pending requests.
    let scanned_route = scan_route(&fixture.db, &fixture.session);
    let bounded_route = fixture
        .db
        .transaction(|tx| crate::chat_projection::pending_approval_route(tx, &fixture.session))
        .unwrap();
    assert_eq!(bounded_route, scanned_route);

    // A pending request means the session wants attention.
    let scanned_pending = scan_has_pending_attention(&fixture.db, &fixture.session);
    let bounded_pending = fixture
        .db
        .transaction(|tx| crate::db::has_pending_attention_approval_tx(tx, &fixture.session))
        .unwrap();
    assert_eq!(bounded_pending, scanned_pending);

    // Delegation status: the requests routed to the parent, minus "always allow".
    let bounded_requests = crate::delegation::pending_requests(&fixture.db, &fixture.session).unwrap();
    let scanned_requests: Vec<Value> = scan_parts(&fixture.db, &fixture.session)
        .into_iter()
        .map(|(_, part)| part)
        .filter(|part| {
            part.get("type").and_then(Value::as_str) == Some("approval")
                && part.get("status").and_then(Value::as_str) == Some("pending")
                && part.pointer("/data/delegation/route").and_then(Value::as_str) == Some("parent")
        })
        .map(|part| {
            let data = part.get("data").cloned().unwrap_or(Value::Null);
            let choices = data
                .get("choices")
                .and_then(Value::as_array)
                .map(|choices| {
                    choices
                        .iter()
                        .filter(|choice| choice.get("scope").and_then(Value::as_str) != Some("persistent"))
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            json!({
                "requestId": part.get("approvalId").cloned().unwrap_or(Value::Null),
                "interaction": data.get("interaction").cloned().unwrap_or(json!("permission")),
                "title": data.get("title").cloned().unwrap_or(Value::Null),
                "details": data.get("details").cloned().unwrap_or(Value::Null),
                "choices": choices,
            })
        })
        .collect();
    assert_eq!(bounded_requests, scanned_requests);
    assert_eq!(bounded_requests.len(), 1);

    // Runtime start: the pending app-hosted questions of every session.
    let bounded_asks = crate::chat_tools::pending_ask_user_parts(&fixture.db).unwrap();
    assert_eq!(
        bounded_asks,
        vec![(fixture.session.clone(), "t1".to_owned(), "ask-user".to_owned())]
    );
}

#[test]
fn the_parent_words_query_reads_only_the_newest_user_items() {
    let fixture = fixture();
    let all = fixture.db.chat_items(&fixture.session).unwrap();
    for count in 0..5 {
        assert_eq!(
            crate::delegation::user_words_from_chat(&fixture.db, &fixture.session, count).unwrap(),
            crate::delegation::user_words(&all, count),
            "count {count}"
        );
    }
    assert_eq!(
        crate::delegation::user_words_from_chat(&fixture.db, &fixture.session, 1).unwrap().0,
        vec!["second words".to_owned()]
    );
}

#[test]
fn a_bound_turn_answer_matches_the_unbound_scan_for_a_single_turn_child() {
    let fixture = fixture();
    let bound = fixture
        .db
        .transaction(|tx| crate::delegation::final_answer_for_turn(tx, &fixture.session, Some("t2")))
        .unwrap();
    assert_eq!(bound, "done");
    let unbound = fixture
        .db
        .transaction(|tx| crate::delegation::final_answer_for_turn(tx, &fixture.session, None))
        .unwrap();
    assert_eq!(unbound, "working on it\n\ndone");
}

#[test]
fn no_bounded_read_loads_a_whole_transcript() {
    let fixture = fixture();
    let session = fixture.session.clone();
    crate::db::reset_whole_transcript_reads();
    fixture.db.chat_approval_part(&session, "ask-parent").unwrap();
    crate::delegation::pending_requests(&fixture.db, &session).unwrap();
    fixture
        .db
        .transaction(|tx| crate::chat_projection::pending_approval_route(tx, &session))
        .unwrap();
    fixture
        .db
        .transaction(|tx| crate::db::has_pending_attention_approval_tx(tx, &session))
        .unwrap();
    crate::delegation::user_words_from_chat(&fixture.db, &session, 3).unwrap();
    fixture
        .db
        .transaction(|tx| crate::delegation::final_answer_for_turn(tx, &session, Some("t1")))
        .unwrap();
    crate::chat_tools::pending_ask_user_parts(&fixture.db).unwrap();
    fixture.db.chat_items_tail(&session, 2).unwrap();
    assert_eq!(
        crate::db::whole_transcript_read_count(),
        0,
        "a bounded read fell back to the whole transcript"
    );
}
