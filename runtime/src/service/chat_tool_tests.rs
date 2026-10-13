use super::*;
use crate::{
    chat_tools::{self, FeedbackAdd, FeedbackDismiss},
    db::CreateSession,
};
use std::{
    sync::{Arc, Barrier},
    thread,
    time::Duration,
};

struct Fixture {
    root: tempfile::TempDir,
    db: Arc<Database>,
    providers: Arc<Providers>,
    tools: Arc<chat_tools::ChatTools>,
    session: String,
    token: String,
}

impl Fixture {
    fn new(ask: bool, session_info: bool, feedback: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("runtime.sqlite");
        let db = Arc::new(Database::open(&path).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        let session = create_chat(&db, "caller", "caller-session");
        start_turn(&db, &session, "turn-one");
        let providers = Arc::new(Providers::for_test(vec![]));
        providers.preview_test_worker(&session, Some("generation-one"));
        let tools = chat_tools::shared(&path, Arc::clone(&db)).unwrap();
        let token = tools
            .issue(
                &session,
                "generation-one".into(),
                ask,
                session_info,
                feedback,
            )
            .unwrap();
        Self {
            root,
            db,
            providers,
            tools,
            session,
            token,
        }
    }

    fn tool(&self, method: &str, body: Value) -> Result<Value> {
        let mut body = body;
        body["callerSessionId"] = json!(self.session);
        body["callerToken"] = json!(self.token);
        self.tools.dispatch(&self.providers, method, &body)
    }

    fn spawn_ask(&self) -> thread::JoinHandle<Result<Value>> {
        let tools = Arc::clone(&self.tools);
        let providers = Arc::clone(&self.providers);
        let session = self.session.clone();
        let token = self.token.clone();
        thread::spawn(move || {
            tools.dispatch(
                &providers,
                "chat.tool.ask",
                &json!({
                    "callerSessionId":session,
                    "callerToken":token,
                    "questions":[{
                        "header":"Choice",
                        "question":"Which option?",
                        "options":[{"label":"One"},{"label":"Two","description":"Second"}],
                        "multiSelect":false,
                        "allowOther":true
                    }]
                }),
            )
        })
    }

    fn pending_approval(&self) -> (String, String) {
        for _ in 0..100 {
            if let Some((turn, approval)) = self
                .db
                .chat_items(&self.session)
                .unwrap()
                .into_iter()
                .find_map(|item| {
                    let approval = item.parts.iter().find(|part| {
                        part["type"] == "approval"
                            && part["status"] == "pending"
                            && part["data"]["threadtermTool"] == "ask_user"
                    })?["approvalId"]
                        .as_str()?
                        .to_owned();
                    Some((item.turn_id?, approval))
                })
            {
                return (turn, approval);
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("ask approval did not project");
    }
}

fn create_chat(db: &Database, title: &str, operation: &str) -> String {
    db.create_session(CreateSession {
        project_id: None,
        title: Some(title),
        provider: "codex",
        mode: "chat",
        native_id: None,
        operation_id: operation,
    })
    .unwrap()
    .id
}

fn start_turn(db: &Database, session: &str, turn: &str) {
    db.set_session_status(session, "running", None).unwrap();
    db.record_provider_event(session, Some(turn), "message.user", &json!({"text":"work"}))
        .unwrap();
}

#[test]
fn ask_projects_the_shared_question_card_and_returns_answer_or_dismissal() {
    let fixture = Fixture::new(true, true, true);
    let ask = fixture.spawn_ask();
    let (turn, approval) = fixture.pending_approval();
    assert_eq!(
        answer_chat_request(
            &fixture.db,
            &fixture.providers,
            &fixture.tools,
            AnswerChatRequest {
                session_id: &fixture.session,
                turn_id: &turn,
                approval_id: &approval,
                response: &json!({"action":"submit","values":{"question-1":["Two"]}}),
                operation_id: "app-answer",
            },
        )
        .unwrap(),
        Value::Null
    );
    assert_eq!(
        fixture.db.operation("app-answer").unwrap(),
        Some(Value::Null)
    );
    assert_eq!(
        ask.join().unwrap().unwrap(),
        json!({"answers":{"Which option?":"Two"}})
    );
    let card = fixture
        .db
        .chat_items(&fixture.session)
        .unwrap()
        .into_iter()
        .flat_map(|item| item.parts)
        .find(|part| part["approvalId"] == approval)
        .unwrap();
    assert_eq!(card["status"], "answered");

    start_turn(&fixture.db, &fixture.session, "turn-two");
    let ask = fixture.spawn_ask();
    let (turn, approval) = fixture.pending_approval();
    fixture
        .tools
        .answer(
            &fixture.session,
            &turn,
            &approval,
            &json!({"action":"dismiss"}),
            None,
        )
        .unwrap();
    assert_eq!(
        ask.join().unwrap().unwrap(),
        json!({"dismissed":true,"note":"The user dismissed the question; use your own judgment."})
    );
}

#[test]
fn ask_cancel_close_and_generation_replacement_settle_once_without_pending_cards() {
    let fixture = Fixture::new(true, false, false);
    let ask = fixture.spawn_ask();
    let (turn, approval) = fixture.pending_approval();
    fixture.tools.cancel_turn(&fixture.session, &turn).unwrap();
    fixture.tools.cancel_turn(&fixture.session, &turn).unwrap();
    assert_eq!(ask.join().unwrap().unwrap(), json!({"cancelled":true}));
    let card = fixture
        .db
        .chat_items(&fixture.session)
        .unwrap()
        .into_iter()
        .flat_map(|item| item.parts)
        .find(|part| part["approvalId"] == approval)
        .unwrap();
    assert_eq!(card["status"], "expired");

    start_turn(&fixture.db, &fixture.session, "turn-two");
    let ask = fixture.spawn_ask();
    fixture.pending_approval();
    fixture
        .tools
        .issue(
            &fixture.session,
            "generation-two".into(),
            true,
            false,
            false,
        )
        .unwrap();
    fixture
        .providers
        .preview_test_worker(&fixture.session, Some("generation-two"));
    assert_eq!(ask.join().unwrap().unwrap(), json!({"cancelled":true}));
    assert_eq!(
        fixture
            .tool("chat.tool.ask", json!({"questions":[]}))
            .unwrap_err()
            .to_string(),
        "chat_tool_unauthorized"
    );
}

#[test]
fn session_close_revokes_the_grant_and_clears_asks_and_waiting_feedback() {
    let fixture = Fixture::new(true, false, true);
    fixture
        .tools
        .feedback_add(FeedbackAdd {
            session_id: fixture.session.clone(),
            turn_id: "turn-one".into(),
            text: "unread".into(),
            operation_id: "close-note".into(),
        })
        .unwrap();
    let ask = fixture.spawn_ask();
    fixture.pending_approval();
    fixture.tools.revoke_session(&fixture.session).unwrap();
    assert_eq!(ask.join().unwrap().unwrap(), json!({"cancelled":true}));
    assert!(
        fixture.tools.feedback_read(&fixture.session).unwrap()["notes"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fixture
            .tool("chat.tool.feedback", json!({}))
            .unwrap_err()
            .to_string(),
        "chat_tool_unauthorized"
    );
}

#[test]
fn tool_grants_enforce_exact_per_open_capabilities_and_generation_tokens() {
    let fixture = Fixture::new(false, true, false);
    assert_eq!(
        fixture
            .tool(
                "chat.tool.ask",
                json!({"questions":[{"question":"Q?","options":[{"label":"A"},{"label":"B"}]}]}),
            )
            .unwrap_err()
            .to_string(),
        "chat_tool_disabled"
    );
    assert_eq!(
        fixture
            .tool("chat.tool.feedback", json!({}))
            .unwrap_err()
            .to_string(),
        "chat_tool_disabled"
    );
    fixture
        .db
        .update_settings(
            &json!({"chatTools.sessionInfo":false}),
            0,
            "disable-session-info-after-open",
        )
        .unwrap();
    assert_eq!(
        fixture
            .tool("chat.tool.sessionInfo", json!({"session":fixture.session}),)
            .unwrap()["id"],
        fixture.session
    );
    fixture
        .providers
        .preview_test_worker(&fixture.session, Some("other-generation"));
    assert_eq!(
        fixture
            .tool("chat.tool.sessionInfo", json!({"session":fixture.session}))
            .unwrap_err()
            .to_string(),
        "chat_tool_stale_generation"
    );
}

#[test]
fn ask_validation_rejects_bounds_and_duplicate_question_keys_before_projection() {
    let fixture = Fixture::new(true, false, false);
    for questions in [
        json!([]),
        json!([{"question":"Q?","options":[{"label":"one"}]}]),
        json!([
            {"question":"same","options":[{"label":"one"},{"label":"two"}]},
            {"question":"same","options":[{"label":"yes"},{"label":"no"}]}
        ]),
    ] {
        assert_eq!(
            fixture
                .tool("chat.tool.ask", json!({"questions":questions}))
                .err()
                .unwrap()
                .to_string(),
            "invalid_questions"
        );
    }
    assert!(!fixture
        .db
        .chat_items(&fixture.session)
        .unwrap()
        .iter()
        .flat_map(|item| &item.parts)
        .any(|part| part["data"]["threadtermTool"] == "ask_user"));

    let waiter = fixture
        .tools
        .prepare_ask(
            &fixture.providers,
            &json!({
                "callerSessionId":fixture.session,
                "callerToken":fixture.token,
                "questions":[{
                    "header":"h".repeat(80),
                    "question":"Boundary?",
                    "options":[{"label":"a".repeat(256)},{"label":"b".repeat(256)}]
                }]
            }),
        )
        .unwrap();
    fixture
        .tools
        .cancel_turn(&fixture.session, "turn-one")
        .unwrap();
    assert_eq!(waiter.wait().unwrap(), json!({"cancelled":true}));
    for (header, label) in [
        ("h".repeat(81), "ok".into()),
        ("ok".into(), "x".repeat(257)),
    ] {
        assert_eq!(
            fixture
                .tools
                .prepare_ask(
                    &fixture.providers,
                    &json!({
                        "callerSessionId":fixture.session,
                        "callerToken":fixture.token,
                        "questions":[{
                            "header":header,
                            "question":"Too long?",
                            "options":[{"label":label},{"label":"valid"}]
                        }]
                    }),
                )
                .err()
                .unwrap()
                .to_string(),
            "invalid_questions"
        );
    }
}

#[test]
fn completed_turn_cannot_be_resurrected_by_ask_publication() {
    let fixture = Fixture::new(true, false, false);
    let reached = Arc::new(Barrier::new(2));
    let resume = Arc::new(Barrier::new(2));
    fixture
        .tools
        .pause_next_ask_publication(Arc::clone(&reached), Arc::clone(&resume));
    let tools = Arc::clone(&fixture.tools);
    let providers = Arc::clone(&fixture.providers);
    let session = fixture.session.clone();
    let token = fixture.token.clone();
    let ask = thread::spawn(move || {
        tools.prepare_ask(
            &providers,
            &json!({
                "callerSessionId":session,
                "callerToken":token,
                "questions":[{"question":"Late?","options":[{"label":"A"},{"label":"B"}]}]
            }),
        )
    });
    reached.wait();
    fixture
        .db
        .record_provider_event(
            &fixture.session,
            Some("turn-one"),
            "chat.turn.completed",
            &json!({}),
        )
        .unwrap();
    resume.wait();
    assert_eq!(
        ask.join().unwrap().err().unwrap().to_string(),
        "chat_turn_inactive"
    );
    let session = fixture.db.session_by_id(&fixture.session).unwrap().unwrap();
    assert_eq!(session.status, "idle");
    assert_eq!(session.activity.unwrap().state, "awaiting_input");
    assert!(!fixture
        .db
        .chat_items(&fixture.session)
        .unwrap()
        .iter()
        .flat_map(|item| &item.parts)
        .any(|part| part["data"]["threadtermTool"] == "ask_user"));
}

#[test]
fn reconnect_fences_a_paused_old_feedback_consumer_before_commit() {
    let fixture = Fixture::new(false, false, true);
    fixture
        .tools
        .feedback_add(FeedbackAdd {
            session_id: fixture.session.clone(),
            turn_id: "turn-one".into(),
            text: "must remain waiting".into(),
            operation_id: "fenced-note".into(),
        })
        .unwrap();
    let reached = Arc::new(Barrier::new(2));
    let resume = Arc::new(Barrier::new(2));
    fixture
        .tools
        .pause_next_authorization(Arc::clone(&reached), Arc::clone(&resume));
    let tools = Arc::clone(&fixture.tools);
    let providers = Arc::clone(&fixture.providers);
    let session = fixture.session.clone();
    let old_token = fixture.token.clone();
    let old_call = thread::spawn(move || {
        tools.dispatch(
            &providers,
            "chat.tool.feedback",
            &json!({"callerSessionId":session,"callerToken":old_token}),
        )
    });
    reached.wait();
    fixture
        .tools
        .issue(
            &fixture.session,
            "generation-two".into(),
            false,
            false,
            true,
        )
        .unwrap();
    fixture
        .providers
        .preview_test_worker(&fixture.session, Some("generation-two"));
    resume.wait();
    assert_eq!(
        old_call.join().unwrap().unwrap_err().to_string(),
        "chat_tool_stale_generation"
    );
    let notes = fixture.tools.feedback_read(&fixture.session).unwrap();
    assert_eq!(notes["notes"][0]["status"], "waiting");
}

#[test]
fn feedback_is_persisted_bounded_idempotent_and_consumed_once_only_while_running() {
    let fixture = Fixture::new(false, false, true);
    let first = fixture
        .tools
        .feedback_add(FeedbackAdd {
            session_id: fixture.session.clone(),
            turn_id: "turn-one".into(),
            text: "Please check the edge case".into(),
            operation_id: "note-one".into(),
        })
        .unwrap();
    let replay = fixture
        .tools
        .feedback_add(FeedbackAdd {
            session_id: fixture.session.clone(),
            turn_id: "turn-one".into(),
            text: "Please check the edge case".into(),
            operation_id: "note-one".into(),
        })
        .unwrap();
    assert_eq!(first, replay);
    let consumed = fixture.tool("chat.tool.feedback", json!({})).unwrap();
    assert_eq!(consumed["notes"].as_array().unwrap().len(), 1);
    assert_eq!(consumed["notes"][0]["status"], "received");
    assert_eq!(
        fixture.tool("chat.tool.feedback", json!({})).unwrap(),
        json!({"notes":[]})
    );

    fixture
        .tools
        .feedback_add(FeedbackAdd {
            session_id: fixture.session.clone(),
            turn_id: "turn-one".into(),
            text: "Unread".into(),
            operation_id: "note-two".into(),
        })
        .unwrap();
    fixture
        .db
        .record_provider_event(
            &fixture.session,
            Some("turn-one"),
            "chat.turn.completed",
            &json!({}),
        )
        .unwrap();
    assert_eq!(
        fixture.tool("chat.tool.feedback", json!({})).unwrap(),
        json!({"notes":[]})
    );
    let read = fixture.tools.feedback_read(&fixture.session).unwrap();
    assert_eq!(
        read["notes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|note| note["status"] == "waiting")
            .count(),
        1
    );
}

#[test]
fn dismiss_removes_only_waiting_notes_of_that_session_once() {
    let fixture = Fixture::new(false, false, true);
    for (operation, text) in [("dismiss-one", "first"), ("dismiss-two", "second")] {
        fixture
            .tools
            .feedback_add(FeedbackAdd {
                session_id: fixture.session.clone(),
                turn_id: "turn-one".into(),
                text: text.into(),
                operation_id: operation.into(),
            })
            .unwrap();
    }
    let notes = fixture.tools.feedback_read(&fixture.session).unwrap()["notes"]
        .as_array()
        .unwrap()
        .clone();
    let first = notes[0]["id"].as_str().unwrap().to_owned();
    // Only waiting notes are retired, and only the exact rows of this session.
    let dismissed = fixture
        .tools
        .feedback_dismiss(FeedbackDismiss {
            session_id: fixture.session.clone(),
            note_ids: vec![first.clone()],
            operation_id: "dismiss-op".into(),
        })
        .unwrap();
    assert_eq!(dismissed, json!({"removed":[first]}));
    // Replaying the same operation returns its stored result.
    assert_eq!(
        fixture
            .tools
            .feedback_dismiss(FeedbackDismiss {
                session_id: fixture.session.clone(),
                note_ids: vec![first.clone()],
                operation_id: "dismiss-op".into(),
            })
            .unwrap(),
        dismissed
    );
    // A different operation removes nothing and is not an error.
    assert_eq!(
        fixture
            .tools
            .feedback_dismiss(FeedbackDismiss {
                session_id: fixture.session.clone(),
                note_ids: vec![first],
                operation_id: "dismiss-op-two".into(),
            })
            .unwrap(),
        json!({"removed":[]})
    );
    assert_eq!(
        fixture.tools.feedback_read(&fixture.session).unwrap()["notes"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(fixture
        .tools
        .feedback_dismiss(FeedbackDismiss {
            session_id: fixture.session,
            note_ids: vec![],
            operation_id: "dismiss-op-three".into(),
        })
        .is_err());
}

#[test]
fn feedback_capacity_text_limit_two_turn_retention_and_explicit_cancel_cleanup() {
    let fixture = Fixture::new(false, false, true);
    for index in 0..20 {
        fixture
            .tools
            .feedback_add(FeedbackAdd {
                session_id: fixture.session.clone(),
                turn_id: "turn-one".into(),
                text: format!("note {index}"),
                operation_id: format!("note-{index}"),
            })
            .unwrap();
    }
    assert_eq!(
        fixture
            .tools
            .feedback_add(FeedbackAdd {
                session_id: fixture.session.clone(),
                turn_id: "turn-one".into(),
                text: "overflow".into(),
                operation_id: "overflow".into(),
            })
            .unwrap_err()
            .to_string(),
        "feedback_turn_capacity"
    );
    assert_eq!(
        fixture
            .tools
            .feedback_add(FeedbackAdd {
                session_id: fixture.session.clone(),
                turn_id: "turn-one".into(),
                text: "x".repeat(4_001),
                operation_id: "too-long".into(),
            })
            .unwrap_err()
            .to_string(),
        "invalid_feedback"
    );

    for (turn, operation) in [("turn-two", "second-turn"), ("turn-three", "third-turn")] {
        start_turn(&fixture.db, &fixture.session, turn);
        fixture
            .tools
            .feedback_add(FeedbackAdd {
                session_id: fixture.session.clone(),
                turn_id: turn.into(),
                text: turn.into(),
                operation_id: operation.into(),
            })
            .unwrap();
    }
    let read = fixture.tools.feedback_read(&fixture.session).unwrap();
    assert!(read["notes"]
        .as_array()
        .unwrap()
        .iter()
        .all(|note| note["turnId"] != "turn-one"));
    fixture
        .tools
        .clear_waiting_feedback(&fixture.session, Some("turn-three"))
        .unwrap();
    assert!(
        !fixture.tools.feedback_read(&fixture.session).unwrap()["notes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|note| note["turnId"] == "turn-three")
    );
}

#[test]
fn session_info_is_scoped_to_owned_delegates_and_caps_the_latest_transcript() {
    let fixture = Fixture::new(false, true, false);
    let target = create_chat(&fixture.db, "Target", "target-session");
    crate::session_configs::save_new(
        &fixture.db,
        &target,
        &crate::session_configs::LaunchSpec {
            provider: "codex".into(),
            mode: "chat".into(),
            cwd: fixture.root.path().to_string_lossy().into_owned(),
            project_id: None,
            title: Some("Target".into()),
            executable: None,
            args: Vec::new(),
        },
        None,
    )
    .unwrap();
    for index in 0..25 {
        fixture
            .db
            .record_provider_event(
                &target,
                Some(&format!("turn-{index}")),
                "message.user",
                &json!({"text":format!("item-{index}:{}", "z".repeat(1_200))}),
            )
            .unwrap();
    }
    fixture
        .db
        .transaction(|tx| {
            tx.execute(
                "INSERT INTO usage_records(id,session_id,provider,recorded_at,input_tokens,output_tokens) VALUES('usage',?,'codex',?,12,34)",
                rusqlite::params![target, chrono::Utc::now().to_rfc3339()],
            )?;
            Ok(())
        })
        .unwrap();
    let info = fixture
        .tool(
            "chat.tool.sessionInfo",
            json!({"session":format!("@session:{target}")}),
        )
        .unwrap();
    assert_eq!(
        info["tokenTotals"],
        json!({"input":12,"output":34,"total":46})
    );
    assert_eq!(info["truncated"], true);
    assert!(info["transcript"].as_str().unwrap().len() <= 16 * 1024);
    assert!(info["transcript"].as_str().unwrap().contains("item-24"));
    assert!(!info["transcript"].as_str().unwrap().contains("item-0"));

    let foreign_parent = create_chat(&fixture.db, "Other", "other-parent");
    let child = create_chat(&fixture.db, "Child", "child-session");
    fixture
        .db
        .transaction(|tx| {
            let now = chrono::Utc::now().to_rfc3339();
            tx.execute(
                "INSERT INTO delegations(id,parent_session_id,child_session_id,agent,workspace,workspace_path,branch,prompt,user_messages,operation_id,turn_id,state,result,error,created_at,updated_at) VALUES('delegation',?,?,'codex','shared',?,NULL,'work',0,'delegation-op',NULL,'running',NULL,NULL,?,?)",
                rusqlite::params![foreign_parent, child, fixture.root.path().to_string_lossy(), now, now],
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        fixture
            .tool("chat.tool.sessionInfo", json!({"session":child}))
            .unwrap_err()
            .to_string(),
        "session_info_scope_denied"
    );
}

#[test]
fn feedback_public_rpc_requires_lease_and_operation_payload_is_idempotent() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("runtime.sqlite");
    let db = Arc::new(Database::open(&path).unwrap());
    crate::session_configs::initialize(&db).unwrap();
    let session = create_chat(&db, "rpc", "rpc-session");
    start_turn(&db, &session, "turn");
    let service = RuntimeService::new(
        RuntimeConfig {
            data_dir: root.path().to_owned(),
            database_path: path,
            credential_path: root.path().join("credential"),
            pipe_base: "chat-tool-feedback-test".into(),
        },
        Arc::clone(&db),
    );
    let lease = service
        .dispatch(
            "desktop",
            RpcRequest {
                v: 1,
                id: "claim".into(),
                method: "session.claim".into(),
                params: json!({"sessionId":session}),
            },
        )
        .unwrap()["leaseEpoch"]
        .as_i64()
        .unwrap();
    let request = |text: &str, lease_epoch: i64| RpcRequest {
        v: 1,
        id: format!("add-{text}"),
        method: "chat.feedback.add".into(),
        params: json!({
            "sessionId":session,
            "turnId":"turn",
            "text":text,
            "operationId":"same-operation",
            "leaseEpoch":lease_epoch,
        }),
    };
    let first = service
        .dispatch("desktop", request("first", lease))
        .unwrap();
    assert_eq!(
        service
            .dispatch("desktop", request("first", lease))
            .unwrap(),
        first
    );
    service
        .dispatch(
            "desktop",
            RpcRequest {
                v: 1,
                id: "release".into(),
                method: "session.release".into(),
                params: json!({"sessionId":session,"leaseEpoch":lease}),
            },
        )
        .unwrap();
    let renewed_lease = service
        .dispatch(
            "desktop-two",
            RpcRequest {
                v: 1,
                id: "reclaim".into(),
                method: "session.claim".into(),
                params: json!({"sessionId":session}),
            },
        )
        .unwrap()["leaseEpoch"]
        .as_i64()
        .unwrap();
    assert!(renewed_lease > lease);
    assert_eq!(
        service
            .dispatch("desktop-two", request("first", renewed_lease))
            .unwrap(),
        first
    );
    assert_eq!(
        service
            .dispatch("desktop-two", request("changed", renewed_lease))
            .unwrap_err()
            .code,
        "operation_conflict"
    );
    assert_eq!(
        service
            .dispatch("desktop", request("first", lease))
            .unwrap_err()
            .code,
        "stale_lease"
    );
}

#[test]
fn feedback_dismiss_public_rpc_requires_lease_and_operation_replay_is_idempotent() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("runtime.sqlite");
    let db = Arc::new(Database::open(&path).unwrap());
    crate::session_configs::initialize(&db).unwrap();
    let session = create_chat(&db, "rpc-dismiss", "rpc-dismiss-session");
    start_turn(&db, &session, "turn");
    let service = RuntimeService::new(
        RuntimeConfig {
            data_dir: root.path().to_owned(),
            database_path: path,
            credential_path: root.path().join("credential"),
            pipe_base: "chat-tool-dismiss-test".into(),
        },
        Arc::clone(&db),
    );
    let lease = service
        .dispatch(
            "desktop",
            RpcRequest {
                v: 1,
                id: "claim".into(),
                method: "session.claim".into(),
                params: json!({"sessionId":session}),
            },
        )
        .unwrap()["leaseEpoch"]
        .as_i64()
        .unwrap();
    let note_id = service
        .dispatch(
            "desktop",
            RpcRequest {
                v: 1,
                id: "note".into(),
                method: "chat.feedback.add".into(),
                params: json!({
                    "sessionId":session,
                    "turnId":"turn",
                    "text":"prefer the narrow reading",
                    "operationId":"add-note",
                    "leaseEpoch":lease,
                }),
            },
        )
        .unwrap()["note"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let request = |note_ids: Value, lease_epoch: i64| RpcRequest {
        v: 1,
        id: "dismiss".into(),
        method: "chat.feedback.dismiss".into(),
        params: json!({
            "sessionId":session,
            "noteIds":note_ids,
            "operationId":"dismiss-operation",
            "leaseEpoch":lease_epoch,
        }),
    };
    let first = service
        .dispatch("desktop", request(json!([note_id.clone()]), lease))
        .unwrap();
    assert_eq!(first, json!({"removed":[note_id.clone()]}));
    // The same operation replays its stored result, not an empty removal.
    assert_eq!(
        service
            .dispatch("desktop", request(json!([note_id.clone()]), lease))
            .unwrap(),
        first
    );
    // A different payload under the same operation id conflicts.
    assert_eq!(
        service
            .dispatch("desktop", request(json!(["other-note"]), lease))
            .unwrap_err()
            .code,
        "operation_conflict"
    );
    // A missing lease is refused before the operation is reserved.
    assert_eq!(
        service
            .dispatch("desktop", request(json!([note_id.clone()]), 0))
            .unwrap_err()
            .code,
        "stale_lease"
    );
    // A lease from a released claim is stale too.
    service
        .dispatch(
            "desktop",
            RpcRequest {
                v: 1,
                id: "release".into(),
                method: "session.release".into(),
                params: json!({"sessionId":session,"leaseEpoch":lease}),
            },
        )
        .unwrap();
    assert_eq!(
        service
            .dispatch("desktop", request(json!([note_id]), lease))
            .unwrap_err()
            .code,
        "stale_lease"
    );
}

#[test]
fn feedback_survives_database_reopen_and_startup_expires_orphaned_app_questions() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("runtime.sqlite");
    let session;
    {
        let db = Arc::new(Database::open(&path).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        session = create_chat(&db, "persisted", "persisted-session");
        start_turn(&db, &session, "turn");
        db.record_provider_event(
            &session,
            Some("turn"),
            "chat.approval",
            &json!({
                "approvalId":"orphaned-app-ask",
                "part":{"type":"approval","approvalId":"orphaned-app-ask","data":{
                    "interaction":"question","threadtermTool":"ask_user",
                    "form":{"kind":"questions","questions":[]}
                }}
            }),
        )
        .unwrap();
        let tools = chat_tools::shared(&path, Arc::clone(&db)).unwrap();
        tools
            .feedback_add(FeedbackAdd {
                session_id: session.clone(),
                turn_id: "turn".into(),
                text: "persist me".into(),
                operation_id: "persist-note".into(),
            })
            .unwrap();
    }
    let reopened = Arc::new(Database::open(&path).unwrap());
    crate::session_configs::initialize(&reopened).unwrap();
    let tools = chat_tools::shared(&path, Arc::clone(&reopened)).unwrap();
    assert_eq!(
        tools.feedback_read(&session).unwrap()["notes"][0]["text"],
        "persist me"
    );
    let orphan = reopened
        .chat_items(&session)
        .unwrap()
        .into_iter()
        .flat_map(|item| item.parts)
        .find(|part| part["approvalId"] == "orphaned-app-ask")
        .unwrap();
    assert_eq!(orphan["status"], "expired");
}
