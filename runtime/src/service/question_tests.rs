use super::*;
use crate::providers::{
    ChatSession, ProviderAdapter, ProviderCapability, ProviderError, TerminalCommand,
};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

struct QuestionAdapter {
    sent: Arc<Mutex<Vec<Value>>>,
    calls: Arc<AtomicUsize>,
    supports_answers: bool,
    db: Arc<Database>,
}

impl ProviderAdapter for QuestionAdapter {
    fn id(&self) -> &'static str { "question-fixture" }

    fn capability(&self) -> ProviderCapability {
        ProviderCapability {
            source: "test", plugin_id: None, icon: None, sign_in: None, homepage: None,
            id: self.id().into(), name: "Question fixture".into(), installed: true,
            version: None, terminal: false, chat: true, history: false, resume: false,
            terminal_resume_capture: "none", reason: None, auth: "authenticated".into(),
        }
    }

    fn terminal_command(&self, _: Option<&str>, _: Option<&str>) -> Result<TerminalCommand, ProviderError> {
        Err(ProviderError::new("unsupported", "fixture is chat-only"))
    }

    fn history_list(&self, _: Option<&str>, _: u32, _: Option<&str>) -> Result<Value, ProviderError> {
        Ok(json!({"items":[]}))
    }

    fn history_read(&self, _: &str) -> Result<Value, ProviderError> { Ok(json!([])) }

    fn open_chat(&self, session_id: &str, _: &str, _: Option<&str>) -> Result<Box<dyn ChatSession>, ProviderError> {
        if !self.supports_answers {
            return Ok(Box::new(DefaultAnswerChat));
        }
        Ok(Box::new(QuestionChat {
            session_id: session_id.into(), sent: Arc::clone(&self.sent), calls: Arc::clone(&self.calls),
            db: Some(Arc::clone(&self.db)),
        }))
    }
}

struct QuestionChat {
    session_id: String,
    sent: Arc<Mutex<Vec<Value>>>,
    calls: Arc<AtomicUsize>,
    db: Option<Arc<Database>>,
}

impl ChatSession for QuestionChat {
    fn native_id(&self) -> Option<String> { Some("question-fixture-native".into()) }
    fn send(&mut self, _: &str, _: &str) -> Result<Value, ProviderError> { Ok(json!({"turnId":"turn"})) }
    fn cancel(&mut self, _: &str) -> Result<(), ProviderError> { Ok(()) }
    fn approve(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ProviderError> { Ok(()) }
    fn stop(&mut self) -> Result<(), ProviderError> { Ok(()) }

    fn answer(&mut self, turn_id: &str, approval_id: &str, response: &Value, operation_id: &str) -> Result<(), ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.sent.lock().unwrap().push(json!({
            "turnId":turn_id, "approvalId":approval_id, "response":response, "operationId":operation_id,
        }));
        if let Some(db) = &self.db {
            let data = db.chat_items(&self.session_id)
                .map_err(|error| ProviderError::new("fixture", error.to_string()))?
                .into_iter().flat_map(|item| item.parts).find(|part| part["approvalId"] == approval_id)
                .and_then(|part| part.get("data").cloned()).unwrap_or_default();
            crate::chat_projection::record(
                db, &self.session_id, Some(turn_id), "chat.approval.resolved",
                &json!({"approvalId":approval_id, "status": if response["action"] == "dismiss" { "dismissed" } else { "answered" }, "answerSummary":crate::chat_questions::answer_summary(&data, response)}),
            ).map_err(|error| ProviderError::new("fixture", error.to_string()))?;
        }
        Ok(())
    }
}

struct DefaultAnswerChat;

impl ChatSession for DefaultAnswerChat {
    fn native_id(&self) -> Option<String> { Some("default-answer-native".into()) }
    fn send(&mut self, _: &str, _: &str) -> Result<Value, ProviderError> { Ok(json!({"turnId":"turn"})) }
    fn cancel(&mut self, _: &str) -> Result<(), ProviderError> { Ok(()) }
    fn approve(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ProviderError> { Ok(()) }
    fn stop(&mut self) -> Result<(), ProviderError> { Ok(()) }
}

struct Fixture {
    root: tempfile::TempDir,
    service: Arc<RuntimeService>,
    db: Arc<Database>,
    sent: Arc<Mutex<Vec<Value>>>,
    calls: Arc<AtomicUsize>,
}

impl Fixture {
    fn new(supports_answers: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        crate::retry_scheduler::initialize(&db).unwrap();
        crate::chat_queue::initialize(&db).unwrap();
        let sent = Arc::new(Mutex::new(Vec::new()));
        let calls = Arc::new(AtomicUsize::new(0));
        let adapter = Arc::new(QuestionAdapter { sent: Arc::clone(&sent), calls: Arc::clone(&calls), supports_answers, db: Arc::clone(&db) });
        let output = Arc::new(OutputStore::default());
        let service = Arc::new(RuntimeService {
            previews: Arc::new(crate::preview::Previews::new(Arc::clone(&db)).unwrap()),
            config: RuntimeConfig { data_dir: root.path().to_owned(), database_path: root.path().join("runtime.sqlite"), credential_path: root.path().join("credential"), pipe_base: r"\\.\pipe\threadterm-v3-question-test".into() },
            db: Arc::clone(&db), leases: LeaseManager::default(), output: Arc::clone(&output),
            providers: Arc::new(Providers::for_test(vec![adapter])), pty: Arc::new(PtyManager::new(output)),
            deferred_launch: Arc::new(Mutex::new(DeferredLaunchGate::default())), shutdown_requested: AtomicBool::new(false), shutdown_pending: AtomicBool::new(false), relocation_gate: RwLock::new(()), retry_gate: Mutex::new(()), settings_apply_gate: Mutex::new(()), plugin_gate: Mutex::new(()), remote: OnceLock::new(), delegations: Arc::new(crate::delegation::Delegations::default()), chat_queues: Arc::new(crate::chat_queue::ChatQueues::default()),
        });
        Self { root, service, db, sent, calls }
    }

    fn create(&self) -> (String, i64) {
        let session = self.service.dispatch("desktop", RpcRequest { v: 1, id: "create".into(), method: "session.create".into(), params: json!({"cwd":self.root.path(),"provider":"question-fixture","mode":"chat","operationId":"create"}) }).unwrap();
        let id = session["id"].as_str().unwrap().to_owned();
        let lease = self.service.dispatch("desktop", RpcRequest { v: 1, id: "claim".into(), method: "session.claim".into(), params: json!({"sessionId":id}) }).unwrap()["leaseEpoch"].as_i64().unwrap();
        self.service.dispatch("desktop", RpcRequest { v: 1, id: "connect".into(), method: "chat.connect".into(), params: json!({"sessionId":id,"leaseEpoch":lease,"operationId":"connect"}) }).unwrap();
        (id, lease)
    }

    fn question(&self, session_id: &str, turn_id: &str, approval_id: &str, data: Value) {
        crate::chat_projection::record(&self.db, session_id, Some(turn_id), "chat.approval", &json!({"approvalId":approval_id,"part":{"type":"approval","approvalId":approval_id,"data":data}})).unwrap();
    }

    fn answer(&self, session_id: &str, lease: i64, turn_id: &str, approval_id: &str, response: Value, operation_id: &str) -> std::result::Result<Value, RpcError> {
        self.service.dispatch("desktop", RpcRequest { v: 1, id: operation_id.into(), method: "chat.answer".into(), params: json!({"sessionId":session_id,"turnId":turn_id,"approvalId":approval_id,"leaseEpoch":lease,"operationId":operation_id,"response":response}) })
    }
}

fn questions(secret: bool) -> Value {
    json!({"interaction":"question","answerable":true,"form":{"kind":"questions","questions":[{"id":"color","question":"Color?","options":[{"label":"Blue"}],"multiSelect":false,"allowOther":false,"secret":secret}]}})
}

fn question_with_other(allow_other: bool) -> Value {
    let mut data = questions(false);
    data["form"]["questions"][0]["allowOther"] = json!(allow_other);
    data
}

#[test]
fn question_answer_rejects_invalid_values_before_the_provider_or_operation_claim() {
    let fixture = Fixture::new(true);
    let (session, lease) = fixture.create();
    fixture.question(&session, "turn", "question", questions(false));
    for (index, response) in [
        json!({"action":"submit","values":{"missing":["Blue"]}}),
        json!({"action":"submit","values":{}}),
        json!({"action":"submit","values":{"color":["Red"]}}),
        json!({"action":"submit","values":{"color":["Blue","Red"]}}),
        json!({"action":"submit","values":{"color":"Blue"}}),
    ].into_iter().enumerate() {
        let operation_id = format!("invalid-{index}");
        let failure = fixture.answer(&session, lease, "turn", "question", response, &operation_id).unwrap_err();
        assert_eq!(failure.code, "answer_invalid");
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
        assert!(fixture.db.operation(&operation_id).unwrap().is_none());
    }
}

#[test]
fn question_validation_allows_other_only_when_offered_and_checks_required_form_types() {
    let offered = question_with_other(true);
    assert!(crate::chat_questions::validate_response(&offered, &json!({"action":"submit","values":{"color":["free text"]}})).is_ok());
    let form = json!({"answerable":true,"form":{"kind":"form","fields":[
        {"id":"title","type":"string","required":true,"minLength":2},
        {"id":"count","type":"integer","required":true,"minimum":1,"maximum":3},
        {"id":"enabled","type":"boolean","required":true}
    ]}});
    for values in [
        json!({"count":2,"enabled":true}),
        json!({"title":"ok","count":1.5,"enabled":true}),
        json!({"title":"ok","count":2,"enabled":"yes"}),
    ] { assert_eq!(crate::chat_questions::validate_response(&form, &json!({"action":"submit","values":values})).unwrap_err().code, "answer_invalid"); }
}

#[test]
fn question_answer_is_idempotent_but_a_replay_still_requires_its_lease() {
    let fixture = Fixture::new(true);
    let (session, lease) = fixture.create();
    fixture.question(&session, "turn", "question", questions(false));
    let response = json!({"action":"submit","values":{"color":["Blue"]}});
    assert_eq!(fixture.answer(&session, lease, "turn", "question", response.clone(), "answer").unwrap(), Value::Null);
    assert_eq!(fixture.answer(&session, lease, "turn", "question", response.clone(), "answer").unwrap(), Value::Null);
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.sent.lock().unwrap().as_slice(), &[json!({"turnId":"turn","approvalId":"question","response":response,"operationId":"answer"})]);
    let failure = fixture.answer(&session, lease + 1, "turn", "question", response, "answer").unwrap_err();
    assert_eq!(failure.code, "stale_lease");
}

#[test]
fn question_answer_rejects_missing_expired_and_wrong_turn_cards_without_sending() {
    let fixture = Fixture::new(true);
    let (session, lease) = fixture.create();
    for (id, turn, status) in [("wrong", "real", "pending"), ("expired", "turn", "expired")] {
        fixture.question(&session, turn, id, questions(false));
        if status == "expired" { crate::chat_projection::record(&fixture.db, &session, Some(turn), "chat.approval.resolved", &json!({"approvalId":id,"status":"expired"})).unwrap(); }
    }
    for (id, turn) in [("unknown", "turn"), ("wrong", "turn"), ("expired", "turn")] {
        let failure = fixture.answer(&session, lease, turn, id, json!({"action":"dismiss"}), &format!("{id}-operation")).unwrap_err();
        assert_eq!(failure.code, "approval_expired");
    }
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn question_cards_require_chat_answer_and_the_default_adapter_answer_is_explicitly_unsupported() {
    let fixture = Fixture::new(false);
    let (session, lease) = fixture.create();
    fixture.question(&session, "turn", "question", questions(true));
    let approval = fixture.service.dispatch("desktop", RpcRequest { v: 1, id: "approve".into(), method: "chat.approve".into(), params: json!({"sessionId":session,"turnId":"turn","approvalId":"question","choiceId":"allow_once","leaseEpoch":lease,"operationId":"approve"}) }).unwrap_err();
    assert_eq!(approval.code, "answer_required");
    let unsupported = fixture.answer(&session, lease, "turn", "question", json!({"action":"dismiss"}), "dismiss").unwrap_err();
    assert_eq!(unsupported.code, "answer_unsupported");
}

#[test]
fn answer_operation_identity_does_not_persist_secrets_but_rejects_a_changed_replay() {
    let fixture = Fixture::new(true);
    let (session, lease) = fixture.create();
    let mut secret = question_with_other(true);
    secret["form"]["questions"][0]["secret"] = json!(true);
    fixture.question(&session, "turn", "question", secret);
    let response = json!({"action":"submit","values":{"color":["hunter2"]}});
    fixture.answer(&session, lease, "turn", "question", response, "secret-answer").unwrap();
    fixture.db.transaction(|tx| {
        let raw: String = tx.query_row("SELECT params FROM operation_requests WHERE id='secret-answer'", [], |row| row.get(0))?;
        assert!(!raw.contains("hunter2"));
        assert!(!raw.contains("\"response\""));
        Ok(())
    }).unwrap();
    let changed = fixture.answer(&session, lease, "turn", "question", json!({"action":"dismiss"}), "secret-answer").unwrap_err();
    assert_eq!(changed.code, "operation_conflict");
}

#[test]
fn projection_persists_answered_and_dismissed_questions_masks_secrets_and_never_resurrects_them() {
    let fixture = Fixture::new(true);
    let (session, _) = fixture.create();
    fixture.question(&session, "turn", "secret", questions(true));
    fixture.question(&session, "turn", "sibling", questions(false));
    fixture.question(&session, "turn", "dismissed", questions(false));
    let pending_inbox = fixture.db.snapshot().unwrap().inbox;
    assert_eq!(pending_inbox.iter().find(|entry| entry["id"] == format!("{session}:approval:secret")).unwrap()["title"], "Color?");
    crate::chat_projection::record(&fixture.db, &session, Some("turn"), "chat.approval.resolved", &json!({"approvalId":"secret","status":"answered","answerSummary":{"color":"hunter2"}})).unwrap();
    let items = fixture.db.chat_items(&session).unwrap();
    let card = |id: &str| items.iter().flat_map(|item| item.parts.iter()).find(|part| part["approvalId"] == id).unwrap();
    assert_eq!(card("secret")["status"], "answered");
    assert_eq!(card("secret")["data"]["answerSummary"]["color"], "••••");
    assert_eq!(card("sibling")["status"], "pending");
    assert_eq!(fixture.db.session_by_id(&session).unwrap().unwrap().status, "waiting");
    assert!(fixture.db.events_after(0).unwrap().iter().filter(|(_, event, _)| event == "chat.item").all(|(_, _, data)| !data.to_string().contains("hunter2")));
    crate::chat_projection::record(&fixture.db, &session, Some("turn"), "chat.approval.resolved", &json!({"approvalId":"dismissed","status":"dismissed"})).unwrap();
    let dismissed = fixture.db.chat_items(&session).unwrap().into_iter().flat_map(|item| item.parts).find(|part| part["approvalId"] == "dismissed").unwrap();
    assert_eq!(dismissed["status"], "dismissed");
    let inbox = fixture.db.snapshot().unwrap().inbox;
    assert_eq!(inbox.iter().find(|entry| entry["id"] == format!("{session}:approval:dismissed")).unwrap()["read"], true);
    crate::chat_projection::record(&fixture.db, &session, Some("turn"), "chat.approval.resolved", &json!({"approvalId":"secret","status":"expired"})).unwrap();
    crate::chat_projection::record(&fixture.db, &session, Some("turn"), "chat.approval.resolved", &json!({"approvalId":"secret","status":"answered","answerSummary":{"color":"hunter2"}})).unwrap();
    let secret = fixture.db.chat_items(&session).unwrap().into_iter().flat_map(|item| item.parts).find(|part| part["approvalId"] == "secret").unwrap();
    assert_eq!(secret["status"], "expired");
}

#[test]
fn submitted_local_resolution_after_expiry_keeps_the_turn_idle_and_masks_the_receipt() {
    let fixture = Fixture::new(true);
    let (session, _) = fixture.create();
    fixture.question(&session, "turn", "secret", questions(true));
    crate::chat_projection::record(&fixture.db, &session, Some("turn"), "chat.turn.completed", &json!({"status":"cancelled"})).unwrap();
    assert_eq!(fixture.db.session_by_id(&session).unwrap().unwrap().activity.unwrap().state, "idle");
    crate::chat_projection::record(&fixture.db, &session, Some("turn"), "chat.approval.resolved", &json!({
        "approvalId":"secret", "status":"answered", "outcome":"submitted", "answerSummary":{"color":"hunter2"}
    })).unwrap();
    let card = fixture.db.chat_items(&session).unwrap().into_iter().flat_map(|item| item.parts)
        .find(|part| part["approvalId"] == "secret").unwrap();
    assert_eq!(card["status"], "answered");
    assert_eq!(card["data"]["answerSummary"]["color"], "••••");
    let current = fixture.db.session_by_id(&session).unwrap().unwrap();
    assert_eq!(current.status, "idle");
    assert_eq!(current.activity.unwrap().state, "idle");
}
