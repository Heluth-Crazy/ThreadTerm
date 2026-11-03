use crate::{
    chat_queue::{initialize, mutate, pause, read, ChatQueues},
    config::RuntimeConfig,
    db::{CreateSession, Database},
    domain::RpcRequest,
    leases::LeaseManager,
    providers::{
        ChatSession, ProviderAdapter, ProviderCapability, ProviderError, ProviderEvent, Providers,
        TerminalCommand,
    },
    service::{connect_chat_session, RuntimeService},
    session_configs::{self, LaunchSpec},
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

struct SendGate {
    started: SyncSender<()>,
    release: Mutex<Receiver<()>>,
    paused: Arc<AtomicBool>,
    sent_after_pause: Arc<AtomicBool>,
}

#[derive(Default)]
struct RecordedAdapter {
    sent: Arc<Mutex<Vec<(String, String)>>>,
    fail_send: bool,
    gate: Option<Arc<SendGate>>,
}

impl ProviderAdapter for RecordedAdapter {
    fn id(&self) -> &str {
        "queue-fixture"
    }

    fn capability(&self) -> ProviderCapability {
        ProviderCapability {
            source: "test",
            plugin_id: None,
            icon: None,
            sign_in: None,
            homepage: None,
            id: self.id().into(),
            name: "Queue fixture".into(),
            installed: true,
            version: None,
            terminal: false,
            chat: true,
            history: false,
            resume: false,
            terminal_resume_capture: "none",
            reason: None,
            auth: "authenticated".into(),
        }
    }

    fn terminal_command(
        &self,
        _resume_id: Option<&str>,
        _assign_id: Option<&str>,
    ) -> Result<TerminalCommand, ProviderError> {
        Err(ProviderError::new("unsupported", "fixture has no terminal"))
    }

    fn history_list(
        &self,
        _cursor: Option<&str>,
        _limit: u32,
        _cwd: Option<&str>,
    ) -> Result<Value, ProviderError> {
        Ok(json!({"items":[]}))
    }

    fn history_read(&self, _native_id: &str) -> Result<Value, ProviderError> {
        Ok(json!([]))
    }

    fn open_chat(
        &self,
        _session_id: &str,
        _cwd: &str,
        _native_id: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        Ok(Box::new(RecordedChat {
            sent: Arc::clone(&self.sent),
            fail_send: self.fail_send,
            gate: self.gate.clone(),
        }))
    }
}

struct RecordedChat {
    sent: Arc<Mutex<Vec<(String, String)>>>,
    fail_send: bool,
    gate: Option<Arc<SendGate>>,
}

impl ChatSession for RecordedChat {
    fn native_id(&self) -> Option<String> {
        Some("queue-fixture-native".into())
    }
    fn send(&mut self, text: &str, operation_id: &str) -> Result<Value, ProviderError> {
        if let Some(gate) = &self.gate {
            gate.started.send(()).unwrap();
            gate.release.lock().unwrap().recv().unwrap();
            if gate.paused.load(Ordering::SeqCst) {
                gate.sent_after_pause.store(true, Ordering::SeqCst);
            }
        }
        if self.fail_send {
            return Err(ProviderError::new(
                "fixture_send_failed",
                "fixture send failed",
            ));
        }
        self.sent
            .lock()
            .unwrap()
            .push((text.into(), operation_id.into()));
        Ok(json!({"turnId": format!("turn-{}", operation_id)}))
    }
    fn cancel(&mut self, _turn_id: &str) -> Result<(), ProviderError> {
        Ok(())
    }
    fn approve(
        &mut self,
        _turn_id: &str,
        _approval_id: &str,
        _choice_id: &str,
        _operation_id: &str,
    ) -> Result<(), ProviderError> {
        Ok(())
    }
    fn stop(&mut self) -> Result<(), ProviderError> {
        Ok(())
    }
}

struct Fixture {
    _root: tempfile::TempDir,
    db: Arc<Database>,
    providers: Arc<Providers>,
    queues: Arc<ChatQueues>,
    session_id: String,
    sent: Arc<Mutex<Vec<(String, String)>>>,
}

impl Fixture {
    fn new(fail_send: bool) -> Self {
        Self::build(fail_send, None)
    }

    fn build(fail_send: bool, gate: Option<Arc<SendGate>>) -> Self {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("queue.sqlite")).unwrap());
        session_configs::initialize(&db).unwrap();
        initialize(&db).unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "queue-fixture",
                mode: "chat",
                native_id: None,
                operation_id: "queue-test-session",
            })
            .unwrap();
        session_configs::save_new(
            &db,
            &session.id,
            &LaunchSpec {
                provider: "queue-fixture".into(),
                mode: "chat".into(),
                cwd: root.path().to_string_lossy().into_owned(),
                project_id: None,
                title: None,
                executable: None,
                args: vec![],
            },
            None,
        )
        .unwrap();
        let sent = Arc::new(Mutex::new(Vec::new()));
        let providers = Arc::new(Providers::for_test(vec![Arc::new(RecordedAdapter {
            sent: Arc::clone(&sent),
            fail_send,
            gate,
        })]));
        connect_chat_session(&db, &providers, &session.id).unwrap();
        Self {
            _root: root,
            db,
            providers,
            queues: Arc::new(ChatQueues::default()),
            session_id: session.id,
            sent,
        }
    }

    fn gated_send() -> (
        Self,
        Receiver<()>,
        SyncSender<()>,
        Arc<AtomicBool>,
        Arc<AtomicBool>,
    ) {
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let paused = Arc::new(AtomicBool::new(false));
        let sent_after_pause = Arc::new(AtomicBool::new(false));
        let gate = Arc::new(SendGate {
            started: started_tx,
            release: Mutex::new(release_rx),
            paused: Arc::clone(&paused),
            sent_after_pause: Arc::clone(&sent_after_pause),
        });
        (
            Self::build(false, Some(gate)),
            started_rx,
            release_tx,
            paused,
            sent_after_pause,
        )
    }

    fn add(&self, text: &str, operation_id: &str) -> Value {
        self.add_result(text, operation_id).unwrap()
    }

    fn add_result(&self, text: &str, operation_id: &str) -> anyhow::Result<Value> {
        mutate(
            &self.db,
            "chat.queue.add",
            &json!({
                "sessionId": self.session_id, "text": text, "images": [], "operationId": operation_id,
            }),
        )
    }

    fn items(&self) -> Vec<Value> {
        read(&self.db, &self.session_id).unwrap()["items"]
            .as_array()
            .unwrap()
            .clone()
    }
}

#[test]
fn queue_mutations_are_durable_idempotent_and_revision_fenced() {
    let fixture = Fixture::new(false);
    let added = fixture.add("first", "add-first");
    let item = added["items"][0].clone();
    assert_eq!(item["text"], "first");
    assert_eq!(item["revision"], 1);

    let replay = fixture.add("first", "add-first");
    assert_eq!(replay, added);
    assert_eq!(fixture.items().len(), 1);

    let updated = mutate(
        &fixture.db,
        "chat.queue.update",
        &json!({
            "sessionId": fixture.session_id, "itemId": item["id"], "text": "edited",
            "expectedRevision": 1, "operationId": "edit-first",
        }),
    )
    .unwrap();
    assert_eq!(updated["items"][0]["text"], "edited");
    assert_eq!(updated["items"][0]["revision"], 2);
    assert!(mutate(
        &fixture.db,
        "chat.queue.update",
        &json!({
            "sessionId": fixture.session_id, "itemId": item["id"], "text": "stale",
            "expectedRevision": 1, "operationId": "stale-edit",
        })
    )
    .is_err());
    assert_eq!(fixture.items()[0]["text"], "edited");
}

#[test]
fn public_queue_mutations_require_the_chat_write_lease() {
    let fixture = Fixture::new(false);
    let leases = LeaseManager::default();
    assert!(fixture
        .queues
        .dispatch(
            &fixture.db,
            &fixture.providers,
            &leases,
            "other-desktop",
            "chat.queue.add",
            &json!({"sessionId":fixture.session_id,"text":"blocked","operationId":"blocked-add"}),
        )
        .is_err());
    assert!(fixture.items().is_empty());
}

#[test]
fn fork_control_command_cannot_be_added_to_the_prompt_queue() {
    let fixture = Fixture::new(false);
    let error = fixture.add_result(" /fork ", "queue-fork-control").unwrap_err();
    assert!(error.to_string().contains("control_command_not_queueable"));
    assert!(fixture.items().is_empty());
}

#[test]
fn queue_dispatch_operation_id_cannot_be_claimed_as_chat_send() {
    let fixture = Fixture::new(false);
    let queue = fixture.add("reserved operation", "add-reserved-operation");
    let item_id = queue["items"][0]["id"].as_str().unwrap();
    assert!(fixture
        .db
        .bind_operation(
            &format!("queue:{item_id}"),
            "chat.send",
            &json!({"sessionId":fixture.session_id,"text":"impersonation"}),
        )
        .is_err());
    assert_eq!(fixture.items()[0]["text"], "reserved operation");
}

#[test]
fn projection_failure_fences_resume_and_prevents_later_send() {
    let fixture = Fixture::new(false);
    fixture.add("do not send", "add-projection-failure");
    let leases = LeaseManager::default();
    let epoch = leases
        .claim(&fixture.db, &fixture.session_id, "desktop")
        .unwrap();
    fixture.queues.projection_failed(&fixture.db);
    assert_eq!(
        read(&fixture.db, &fixture.session_id).unwrap()["pauseReason"],
        "failed"
    );
    assert!(fixture.queues.dispatch(
        &fixture.db, &fixture.providers, &leases, "desktop", "chat.queue.resume",
        &json!({"sessionId":fixture.session_id,"operationId":"resume-after-projection-failure","leaseEpoch":epoch}),
    ).is_err());
    fixture
        .queues
        .try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id)
        .unwrap();
    assert!(fixture.sent.lock().unwrap().is_empty());
}

#[test]
fn queue_enforces_item_and_attachment_bounds() {
    let fixture = Fixture::new(false);
    for index in 0..20 {
        fixture.add(&format!("item-{index}"), &format!("add-{index}"));
    }
    assert!(fixture.add_result("over-limit", "add-over-limit").is_err());
    assert_eq!(fixture.items().len(), 20);

    let other = Fixture::new(false);
    assert!(mutate(
        &other.db,
        "chat.queue.add",
        &json!({
            "sessionId": other.session_id, "text": "with too many images",
            "images": (0..9).map(|_| "data:image/png;base64,AA==").collect::<Vec<_>>(),
            "operationId": "too-many-images",
        })
    )
    .is_err());
}

#[test]
fn aggregate_queue_wire_limit_rejects_the_second_large_item_without_partial_write() {
    let fixture = Fixture::new(false);
    // Two valid image data URLs consume just under the per-message 4 MiB cap.
    // The second queue item would make chat.queue.read exceed its 8 MiB frame
    // budget, so the transaction must roll it back completely.
    let encoded = "A".repeat(2_097_128);
    let images = vec![
        format!("data:image/png;base64,{encoded}"),
        format!("data:image/png;base64,{encoded}"),
    ];
    mutate(&fixture.db, "chat.queue.add", &json!({
        "sessionId":fixture.session_id,"text":"first large","images":images.clone(),"operationId":"add-first-large",
    })).unwrap();
    let rejected = mutate(
        &fixture.db,
        "chat.queue.add",
        &json!({
            "sessionId":fixture.session_id,"text":"second large","images":images,"operationId":"add-second-large",
        }),
    );
    assert!(rejected.is_err());
    let queue = read(&fixture.db, &fixture.session_id).unwrap();
    assert_eq!(queue["items"].as_array().unwrap().len(), 1);
    assert_eq!(queue["items"][0]["text"], "first large");
    assert!(fixture.db.operation("add-second-large").unwrap().is_none());
}

#[test]
fn dispatches_one_item_in_order_per_completed_turn() {
    let fixture = Fixture::new(false);
    fixture.add("one", "add-one");
    fixture.add("two", "add-two");
    let first_id = fixture.items()[0]["id"].as_str().unwrap().to_owned();
    fixture
        .queues
        .try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id)
        .unwrap();
    {
        let sent = fixture.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, "one");
        assert_eq!(sent[0].1, format!("queue:{first_id}"));
    }
    assert!(fixture
        .db
        .operation(&format!("queue:{first_id}"))
        .unwrap()
        .is_some());
    fixture
        .db
        .record_provider_event(
            &fixture.session_id,
            Some(&format!("turn-queue:{first_id}")),
            "chat.turn.completed",
            &json!({}),
        )
        .unwrap();
    fixture
        .queues
        .try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id)
        .unwrap();
    let sent = fixture.sent.lock().unwrap();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[1].0, "two");
}

#[test]
fn stop_barrier_waits_for_an_inflight_send_before_marking_queue_paused() {
    let (fixture, started, release, paused, sent_after_pause) = Fixture::gated_send();
    fixture.add("in flight", "add-gated-send");
    let (pause_started_tx, pause_started_rx) = mpsc::sync_channel(1);
    thread::scope(|scope| {
        let dispatch = scope.spawn(|| {
            fixture
                .queues
                .try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id)
        });
        started.recv().unwrap();
        let pause = scope.spawn(|| {
            pause_started_tx.send(()).unwrap();
            fixture
                .queues
                .pause_dispatch_capturing(&fixture.db, &fixture.session_id, "stopped")
                .unwrap();
            paused.store(true, Ordering::SeqCst);
        });
        pause_started_rx.recv().unwrap();
        release.send(()).unwrap();
        dispatch.join().unwrap().unwrap();
        pause.join().unwrap();
    });
    assert_eq!(fixture.sent.lock().unwrap().len(), 1);
    assert!(!sent_after_pause.load(Ordering::SeqCst));
    let queue = read(&fixture.db, &fixture.session_id).unwrap();
    assert_eq!(queue["paused"], true);
    assert_eq!(queue["pauseReason"], "stopped");
}

#[test]
fn concurrent_dispatch_triggers_send_an_item_once() {
    let fixture = Fixture::new(false);
    fixture.add("first", "add-first");
    fixture.add("second", "add-second");
    fixture.add("third", "add-third");
    let first_id = fixture.items()[0]["id"].as_str().unwrap().to_owned();
    let first = {
        let fixture = &fixture;
        thread::scope(|scope| {
            let a = scope.spawn(|| {
                fixture
                    .queues
                    .try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id)
            });
            let b = scope.spawn(|| {
                fixture
                    .queues
                    .try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id)
            });
            (a.join().unwrap(), b.join().unwrap())
        })
    };
    first.0.unwrap();
    first.1.unwrap();
    let sent = fixture.sent.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, "first");
    assert!(sent[0].1.starts_with("queue:"));
    drop(sent);
    assert_eq!(
        fixture
            .items()
            .iter()
            .map(|item| item["text"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["second", "third"]
    );

    fixture
        .db
        .record_provider_event(
            &fixture.session_id,
            Some(&format!("turn-queue:{first_id}")),
            "chat.turn.completed",
            &json!({}),
        )
        .unwrap();
    fixture
        .queues
        .try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id)
        .unwrap();
    assert_eq!(fixture.sent.lock().unwrap().len(), 2);
    // A duplicate completion for the prior turn must not make the current
    // second turn idle and release the third queue item.
    fixture
        .db
        .record_provider_event(
            &fixture.session_id,
            Some(&format!("turn-queue:{first_id}")),
            "chat.turn.completed",
            &json!({}),
        )
        .unwrap();
    fixture
        .queues
        .try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id)
        .unwrap();
    assert_eq!(fixture.sent.lock().unwrap().len(), 2);
    assert_eq!(fixture.items()[0]["text"], "third");
}

#[test]
fn pending_approval_blocks_dispatch_until_the_turn_is_safe() {
    let fixture = Fixture::new(false);
    fixture.add("wait for approval", "add-waiting");
    fixture
        .db
        .record_provider_event(
            &fixture.session_id,
            Some("approval-turn"),
            "chat.approval",
            &json!({"approvalId":"approval-1"}),
        )
        .unwrap();
    // The persisted card is a second fence: status alone can be stale after
    // event reconciliation and must never release a queued prompt.
    fixture
        .db
        .transaction(|tx| {
            tx.execute(
                "UPDATE sessions SET status='idle' WHERE id=?",
                [&fixture.session_id],
            )?;
            Ok(())
        })
        .unwrap();

    fixture
        .queues
        .try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id)
        .unwrap();
    assert!(fixture.sent.lock().unwrap().is_empty());
    assert_eq!(fixture.items()[0]["state"], "queued");
}

#[test]
fn provider_loss_and_terminal_outcomes_pause_synchronously() {
    for (kind, data, expected) in [
        ("session.closed", json!({}), "disconnected"),
        (
            "chat.connection",
            json!({"phase":"disconnected"}),
            "disconnected",
        ),
        ("chat.turn.completed", json!({"status":"failed"}), "failed"),
        (
            "chat.turn.completed",
            json!({"status":"cancelled"}),
            "stopped",
        ),
    ] {
        let fixture = Fixture::new(false);
        fixture.add("retain", "add-retain");
        fixture.queues.provider_event(
            &fixture.db,
            &fixture.providers,
            &ProviderEvent {
                provider: "queue-fixture".into(),
                session_id: fixture.session_id.clone(),
                native_id: None,
                turn_id: None,
                kind: kind.into(),
                data,
                worker_token: None,
            },
        );
        let queue = read(&fixture.db, &fixture.session_id).unwrap();
        assert_eq!(queue["paused"], true, "{kind}");
        assert_eq!(queue["pauseReason"], expected, "{kind}");
        assert_eq!(queue["items"][0]["text"], "retain", "{kind}");
    }
}

#[test]
fn a_refused_stop_restores_the_user_pause_it_replaced() {
    // Constructing the service only registers adapters; this fixture never
    // opens a provider worker or starts a real agent CLI, so the Stop below is
    // refused (`chat_not_open`) exactly like a stale turn is refused.
    let root = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
    let service = RuntimeService::new(
        RuntimeConfig {
            data_dir: root.path().to_owned(),
            database_path: root.path().join("runtime.sqlite"),
            credential_path: root.path().join("credential"),
            pipe_base: r"\\.\pipe\threadterm-v3-queue-cancel-test".into(),
        },
        Arc::clone(&db),
    );
    let session = db
        .create_session(CreateSession {
            project_id: None,
            title: None,
            provider: "codex",
            mode: "chat",
            native_id: None,
            operation_id: "cancel-test-session",
        })
        .unwrap();
    mutate(&db, "chat.queue.add", &json!({
        "sessionId":session.id,"text":"retain after Stop","images":[],"operationId":"cancel-test-add",
    })).unwrap();
    mutate(&db, "chat.queue.pause", &json!({
        "sessionId":session.id,"operationId":"cancel-test-pause",
    })).unwrap();
    let epoch = service
        .dispatch(
            "desktop",
            RpcRequest {
                v: 1,
                id: "cancel-claim".into(),
                method: "session.claim".into(),
                params: json!({"sessionId":session.id}),
            },
        )
        .unwrap()["leaseEpoch"]
        .as_i64()
        .unwrap();
    let error = service.dispatch("desktop", RpcRequest {
        v: 1, id: "cancel".into(), method: "chat.cancel".into(),
        params: json!({"sessionId":session.id,"turnId":"missing-worker","leaseEpoch":epoch}),
    }).unwrap_err();
    assert_eq!(error.code, "chat_not_open");
    // The Stop paused dispatch for real, then the provider refused: the queue
    // is back to the pause the user had set, not left in the Stop's pause.
    let queue = read(&db, &session.id).unwrap();
    assert_eq!(queue["paused"], true);
    assert_eq!(queue["pauseReason"], "user");
    assert_eq!(queue["items"][0]["text"], "retain after Stop");
}

#[test]
fn failed_and_uncertain_sends_pause_without_retrying() {
    let failed = Fixture::new(true);
    failed.add("will fail", "add-fail");
    failed
        .queues
        .try_dispatch(&failed.db, &failed.providers, &failed.session_id)
        .unwrap();
    let queue = read(&failed.db, &failed.session_id).unwrap();
    assert_eq!(queue["paused"], true);
    assert_eq!(queue["pauseReason"], "failed");
    assert_eq!(queue["items"][0]["state"], "failed");

    let uncertain = Fixture::new(false);
    let queue = uncertain.add("possibly sent", "add-uncertain");
    let item_id = queue["items"][0]["id"].as_str().unwrap().to_owned();
    assert!(uncertain
        .db
        .claim_external_operation(&format!("queue:{item_id}"))
        .unwrap());
    // Explicit Send now is allowed to retry a failed item, but the durable
    // external operation reservation makes its outcome uncertain, never a
    // second provider send.
    mutate(
        &uncertain.db,
        "chat.queue.send",
        &json!({
            "sessionId":uncertain.session_id,"itemId":item_id,"operationId":"send-uncertain",
        }),
    )
    .unwrap();
    uncertain
        .queues
        .try_dispatch(&uncertain.db, &uncertain.providers, &uncertain.session_id)
        .unwrap();
    let queue = read(&uncertain.db, &uncertain.session_id).unwrap();
    assert_eq!(queue["paused"], true);
    assert_eq!(queue["items"][0]["state"], "failed");
    assert_eq!(uncertain.sent.lock().unwrap().len(), 0);
    mutate(
        &uncertain.db,
        "chat.queue.resume",
        &json!({
            "sessionId":uncertain.session_id,"operationId":"resume-uncertain",
        }),
    )
    .unwrap();
    uncertain
        .queues
        .try_dispatch(&uncertain.db, &uncertain.providers, &uncertain.session_id)
        .unwrap();
    assert_eq!(uncertain.sent.lock().unwrap().len(), 0);
}

#[test]
fn completed_plan_installs_approval_before_queue_dispatch_and_keeps_work_queued() {
    let fixture = Fixture::new(false);
    fixture.db.record_provider_event(&fixture.session_id, Some("plan-turn"), "message.user", &json!({"text":"Make a plan"})).unwrap();
    fixture.add("Implement only after review", "queued-after-plan");
    // Match the adapter's FIFO: synthetic approval first, completion second.
    // A completion must neither expire that plan nor clear its pending gate.
    fixture.db.record_provider_event(&fixture.session_id, Some("plan-turn"), "chat.approval", &json!({
        "approvalId":"plan:plan-turn","part":{"data":{"interaction":"plan","runtimeOwned":true,"plan":"# Plan"}}
    })).unwrap();
    fixture.db.record_provider_event(&fixture.session_id, Some("plan-turn"), "chat.turn.completed", &json!({"status":"completed"})).unwrap();
    fixture.queues.try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id).unwrap();
    assert!(fixture.sent.lock().unwrap().is_empty());
    let queue = read(&fixture.db, &fixture.session_id).unwrap();
    assert_eq!(queue["items"][0]["state"], "queued");
    let session = fixture.db.session_by_id(&fixture.session_id).unwrap().unwrap();
    assert_eq!(session.status, "waiting");
    assert_eq!(session.activity.unwrap().state, "awaiting_approval");
    let card = fixture.db.chat_items(&fixture.session_id).unwrap().into_iter().flat_map(|item|item.parts)
        .find(|part|part["approvalId"]=="plan:plan-turn").unwrap();
    assert_eq!(card["status"], "pending");
}

#[test]
fn initialize_pauses_nonempty_queues_after_restart_and_pause_is_durable() {
    let fixture = Fixture::new(false);
    fixture.add("keep me", "add-keep");
    pause(&fixture.db, &fixture.session_id, "stopped").unwrap();
    assert_eq!(
        read(&fixture.db, &fixture.session_id).unwrap()["pauseReason"],
        "stopped"
    );

    initialize(&fixture.db).unwrap();
    let queue = read(&fixture.db, &fixture.session_id).unwrap();
    assert_eq!(queue["paused"], true);
    assert_eq!(queue["pauseReason"], "restarted");
    assert_eq!(queue["items"][0]["text"], "keep me");
}

#[test]
fn initial_connection_does_not_pause_empty_queue_or_override_restart_pause() {
    let fixture = Fixture::new(false);
    let event = crate::providers::ProviderEvent {
        provider: "queue-fixture".into(),
        session_id: fixture.session_id.clone(),
        native_id: None,
        turn_id: None,
        worker_token: None,
        kind: "chat.connection".into(),
        data: json!({"phase":"connecting"}),
    };
    fixture
        .queues
        .provider_event(&fixture.db, &fixture.providers, &event);
    assert_eq!(
        read(&fixture.db, &fixture.session_id).unwrap()["paused"],
        false
    );
    fixture.add("first queued prompt", "initial-connect-add");
    fixture
        .queues
        .try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id)
        .unwrap();
    assert_eq!(fixture.sent.lock().unwrap().len(), 1);
    fixture.add("retain restart pause", "initial-connect-restart");
    pause(&fixture.db, &fixture.session_id, "restarted").unwrap();
    fixture
        .queues
        .provider_event(&fixture.db, &fixture.providers, &event);
    assert_eq!(
        read(&fixture.db, &fixture.session_id).unwrap()["pauseReason"],
        "restarted"
    );
}

#[test]
fn restart_converts_a_sending_item_to_failed_and_preserves_uncertainty() {
    let fixture = Fixture::new(false);
    let queue = fixture.add("in flight", "add-in-flight");
    let item_id = queue["items"][0]["id"].as_str().unwrap();
    fixture
        .db
        .transaction(|tx| {
            tx.execute(
                "UPDATE chat_queue_items SET state='sending' WHERE id=?",
                [item_id],
            )?;
            Ok(())
        })
        .unwrap();
    initialize(&fixture.db).unwrap();
    let queue = read(&fixture.db, &fixture.session_id).unwrap();
    assert_eq!(queue["paused"], true);
    assert_eq!(queue["pauseReason"], "restarted");
    assert_eq!(queue["items"][0]["state"], "failed");
    assert!(queue["items"][0]["error"]
        .as_str()
        .unwrap()
        .contains("May have been sent"));
}

#[test]
fn canonical_queue_turn_binding_settles_activity_and_late_completion_cannot_release_the_next_turn() {
    let fixture = Fixture::new(false);
    fixture.add("first", "canonical-first");
    fixture.add("second", "canonical-second");
    fixture.add("third", "canonical-third");
    let first_id = fixture.items()[0]["id"].as_str().unwrap().to_owned();

    fixture
        .queues
        .try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id)
        .unwrap();
    let first_turn = format!("turn-queue:{first_id}");
    let activity = fixture.db.session_by_id(&fixture.session_id).unwrap().unwrap().activity.unwrap();
    assert_eq!(activity.state, "running");
    assert_eq!(activity.turn_id.as_deref(), Some(first_turn.as_str()));

    fixture
        .db
        .record_provider_event(&fixture.session_id, Some(&first_turn), "chat.turn.completed", &json!({}))
        .unwrap();
    let second_id = fixture.items()[0]["id"].as_str().unwrap().to_owned();
    fixture
        .queues
        .try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id)
        .unwrap();
    let second_turn = format!("turn-queue:{second_id}");
    let activity = fixture.db.session_by_id(&fixture.session_id).unwrap().unwrap().activity.unwrap();
    assert_eq!(activity.state, "running");
    assert_eq!(activity.turn_id.as_deref(), Some(second_turn.as_str()));

    fixture
        .db
        .record_provider_event(&fixture.session_id, Some(&first_turn), "chat.turn.completed", &json!({}))
        .unwrap();
    fixture
        .queues
        .try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id)
        .unwrap();
    assert_eq!(fixture.sent.lock().unwrap().len(), 2);
    let activity = fixture.db.session_by_id(&fixture.session_id).unwrap().unwrap().activity.unwrap();
    assert_eq!(activity.state, "running");
    assert_eq!(activity.turn_id.as_deref(), Some(second_turn.as_str()));
}

#[test]
fn terminal_error_expires_a_pending_native_question_before_resume() {
    let fixture = Fixture::new(false);
    fixture.add("send after expired question", "add-question");
    fixture
        .db
        .record_provider_event(&fixture.session_id, Some("question-turn"), "message.user", &json!({"text":"question"}))
        .unwrap();
    fixture
        .db
        .record_provider_event(
            &fixture.session_id,
            Some("question-turn"),
            "chat.approval",
            &json!({
                "approvalId":"native-question",
                "part":{"type":"approval","approvalId":"native-question","data":{
                    "interaction":"question","answerable":true,
                    "form":{"kind":"questions","questions":[]}
                }}
            }),
        )
        .unwrap();
    fixture
        .db
        .record_provider_event(
            &fixture.session_id,
            Some("question-turn"),
            "chat.error",
            &json!({"message":"terminal failure"}),
        )
        .unwrap();

    let card = fixture.db.chat_items(&fixture.session_id).unwrap().into_iter().flat_map(|item| item.parts)
        .find(|part| part["approvalId"] == "native-question").unwrap();
    assert_eq!(card["status"], "expired");
    let event = ProviderEvent {
        provider: "queue-fixture".into(), session_id: fixture.session_id.clone(), native_id: None,
        turn_id: Some("question-turn".into()), kind: "chat.error".into(),
        data: json!({"message":"terminal failure"}), worker_token: None,
    };
    fixture.queues.provider_event(&fixture.db, &fixture.providers, &event);
    mutate(&fixture.db, "chat.queue.resume", &json!({
        "sessionId":fixture.session_id,"operationId":"resume-after-question-error",
    })).unwrap();
    fixture
        .queues
        .try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id)
        .unwrap();
    assert_eq!(fixture.sent.lock().unwrap().len(), 1);
}

#[test]
fn terminal_completion_expires_a_pending_native_question_card() {
    let fixture = Fixture::new(false);
    fixture.add("send after completed question", "add-completed-question");
    fixture.db.record_provider_event(&fixture.session_id, Some("question-turn"), "message.user", &json!({"text":"question"})).unwrap();
    fixture.db.record_provider_event(&fixture.session_id, Some("question-turn"), "chat.approval", &json!({
        "approvalId":"completed-question",
        "part":{"type":"approval","approvalId":"completed-question","data":{"interaction":"question"}}
    })).unwrap();
    fixture.db.record_provider_event(&fixture.session_id, Some("question-turn"), "chat.turn.completed", &json!({"status":"completed"})).unwrap();

    let card = fixture.db.chat_items(&fixture.session_id).unwrap().into_iter().flat_map(|item| item.parts)
        .find(|part| part["approvalId"] == "completed-question").unwrap();
    assert_eq!(card["status"], "expired");
    fixture.queues.try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id).unwrap();
    assert_eq!(fixture.sent.lock().unwrap().len(), 1);
}

#[test]
fn terminal_error_allows_explicit_send_now_to_dispatch_the_queue() {
    for method in ["chat.queue.resume", "chat.queue.send"] {
        let fixture = Fixture::new(false);
        let queued = fixture.add("send after failure", &format!("add-error-{method}"));
        let item_id = queued["items"][0]["id"].as_str().unwrap().to_owned();
        fixture.db.record_provider_event(&fixture.session_id, Some("failed-turn"), "message.user", &json!({"text":"work"})).unwrap();
        let event = ProviderEvent {
            provider: "queue-fixture".into(),
            session_id: fixture.session_id.clone(),
            native_id: None,
            turn_id: Some("failed-turn".into()),
            kind: "chat.error".into(),
            data: json!({"message":"terminal failure"}),
            worker_token: None,
        };
        fixture
            .db
            .record_provider_event(&fixture.session_id, event.turn_id.as_deref(), &event.kind, &event.data)
            .unwrap();
        fixture.queues.provider_event(&fixture.db, &fixture.providers, &event);
        assert_eq!(read(&fixture.db, &fixture.session_id).unwrap()["pauseReason"], "failed");

        let mut params = json!({
            "sessionId":fixture.session_id,"operationId":format!("{method}-after-error"),
        });
        if method == "chat.queue.send" { params["itemId"] = json!(item_id); }
        mutate(&fixture.db, method, &params).unwrap();
        fixture
            .queues
            .try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id)
            .unwrap();
        assert_eq!(fixture.sent.lock().unwrap().len(), 1);
    }
}

#[test]
fn retry_notice_delta_and_completion_auto_dispatch_a_queued_prompt() {
    let fixture = Fixture::new(false);
    fixture.add("send after retry", "add-retry");
    fixture
        .db
        .record_provider_event(&fixture.session_id, Some("retry-turn"), "message.user", &json!({"text":"work"}))
        .unwrap();
    for attempt in [1, 2] {
        fixture.db.record_provider_event(&fixture.session_id, Some("retry-turn"), "chat.item", &json!({
            "item":{"id":"reconnect:retry-turn"},
            "part":{"type":"thinking","text":format!("Reconnecting... {attempt}/5"),"status":"streaming"},
        })).unwrap();
    }
    fixture.db.record_provider_event(&fixture.session_id, Some("retry-turn"), "chat.delta", &json!({"text":"back"})).unwrap();
    let completed = ProviderEvent {
        provider: "queue-fixture".into(), session_id: fixture.session_id.clone(), native_id: None,
        turn_id: Some("retry-turn".into()), kind: "chat.turn.completed".into(),
        data: json!({"status":"completed"}), worker_token: None,
    };
    fixture.db.record_provider_event(&fixture.session_id, completed.turn_id.as_deref(), &completed.kind, &completed.data).unwrap();
    fixture.queues.provider_event(&fixture.db, &fixture.providers, &completed);

    let deadline = Instant::now() + Duration::from_secs(2);
    while fixture.sent.lock().unwrap().is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(fixture.sent.lock().unwrap().len(), 1);
}

#[test]
fn interrupted_completion_then_resume_dispatches_the_queue() {
    let fixture = Fixture::new(false);
    fixture.add("send after Stop", "add-stop");
    fixture.queues.pause_dispatch_capturing(&fixture.db, &fixture.session_id, "stopped").unwrap();
    fixture.db.record_provider_event(&fixture.session_id, Some("stopped-turn"), "message.user", &json!({"text":"work"})).unwrap();
    let event = ProviderEvent {
        provider: "queue-fixture".into(), session_id: fixture.session_id.clone(), native_id: None,
        turn_id: Some("stopped-turn".into()), kind: "chat.turn.completed".into(),
        data: json!({"status":"interrupted"}), worker_token: None,
    };
    fixture.db.record_provider_event(&fixture.session_id, event.turn_id.as_deref(), &event.kind, &event.data).unwrap();
    fixture.queues.provider_event(&fixture.db, &fixture.providers, &event);
    assert_eq!(read(&fixture.db, &fixture.session_id).unwrap()["pauseReason"], "stopped");

    mutate(&fixture.db, "chat.queue.resume", &json!({
        "sessionId":fixture.session_id,"operationId":"resume-after-stop",
    })).unwrap();
    fixture.queues.try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id).unwrap();
    assert_eq!(fixture.sent.lock().unwrap().len(), 1);
}

#[test]
fn pending_plan_card_blocks_queue_until_return_to_idle_resolution() {
    let fixture = Fixture::new(false);
    fixture.add("implement after plan", "add-plan");
    fixture.db.record_provider_event(&fixture.session_id, Some("plan-turn"), "message.user", &json!({"text":"plan"})).unwrap();
    fixture.db.record_provider_event(&fixture.session_id, Some("plan-turn"), "chat.approval", &json!({
        "approvalId":"plan:plan-turn","part":{"type":"approval","approvalId":"plan:plan-turn","status":"pending","data":{"interaction":"plan","runtimeOwned":true,"plan":"# Plan"}}
    })).unwrap();
    fixture.db.record_provider_event(&fixture.session_id, Some("plan-turn"), "chat.turn.completed", &json!({"status":"completed"})).unwrap();
    let queue = read(&fixture.db, &fixture.session_id).unwrap();
    assert_eq!(queue["blocked"], "plan");
    fixture.queues.try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id).unwrap();
    assert!(fixture.sent.lock().unwrap().is_empty());

    fixture.db.record_provider_event(&fixture.session_id, Some("plan-turn"), "chat.approval.resolved", &json!({
        "approvalId":"plan:plan-turn","status":"answered","returnToIdle":true,
    })).unwrap();
    fixture.queues.try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id).unwrap();
    assert_eq!(fixture.sent.lock().unwrap().len(), 1);
}

#[test]
fn resume_unpauses_a_pending_plan_without_dispatching_it() {
    let fixture = Fixture::new(false);
    fixture.add("wait for plan review", "add-plan-resume");
    pause(&fixture.db, &fixture.session_id, "stopped").unwrap();
    fixture.db.record_provider_event(&fixture.session_id, Some("plan-turn"), "message.user", &json!({"text":"plan"})).unwrap();
    fixture.db.record_provider_event(&fixture.session_id, Some("plan-turn"), "chat.approval", &json!({
        "approvalId":"plan:plan-turn","part":{"type":"approval","approvalId":"plan:plan-turn","data":{"interaction":"plan","runtimeOwned":true,"plan":"# Plan"}}
    })).unwrap();
    fixture.db.record_provider_event(&fixture.session_id, Some("plan-turn"), "chat.turn.completed", &json!({"status":"completed"})).unwrap();

    mutate(&fixture.db, "chat.queue.resume", &json!({
        "sessionId":fixture.session_id,"operationId":"resume-while-plan-pending",
    })).unwrap();
    let queue = read(&fixture.db, &fixture.session_id).unwrap();
    assert_eq!(queue["blocked"], "plan");
    assert_eq!(queue["paused"], false);
    assert!(queue["pauseReason"].is_null());
    fixture.queues.try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id).unwrap();
    assert!(fixture.sent.lock().unwrap().is_empty());
}

#[test]
fn resume_during_a_turn_unpauses_but_waits_for_its_completion() {
    let fixture = Fixture::new(false);
    fixture.add("send after this turn", "add-resume-running");
    pause(&fixture.db, &fixture.session_id, "stopped").unwrap();
    fixture.db.record_provider_event(&fixture.session_id, Some("running-turn"), "message.user", &json!({"text":"work"})).unwrap();

    mutate(&fixture.db, "chat.queue.resume", &json!({
        "sessionId":fixture.session_id,"operationId":"resume-running",
    })).unwrap();
    assert_eq!(read(&fixture.db, &fixture.session_id).unwrap()["paused"], false);
    fixture.queues.try_dispatch(&fixture.db, &fixture.providers, &fixture.session_id).unwrap();
    assert!(fixture.sent.lock().unwrap().is_empty());

    let event = ProviderEvent {
        provider: "queue-fixture".into(), session_id: fixture.session_id.clone(), native_id: None,
        turn_id: Some("running-turn".into()), kind: "chat.turn.completed".into(),
        data: json!({"status":"completed"}), worker_token: None,
    };
    fixture.db.record_provider_event(&fixture.session_id, event.turn_id.as_deref(), &event.kind, &event.data).unwrap();
    fixture.queues.provider_event(&fixture.db, &fixture.providers, &event);
    let deadline = Instant::now() + Duration::from_secs(2);
    while fixture.sent.lock().unwrap().is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(fixture.sent.lock().unwrap().len(), 1);
}

#[test]
fn resolved_runtime_plan_schedules_an_unpaused_queue_without_a_new_turn() {
    for status in ["answered", "dismissed"] {
        let fixture = Fixture::new(false);
        fixture.add("implement after plan", "add-resolved-plan");
        fixture.db.record_provider_event(&fixture.session_id, Some("plan-turn"), "message.user", &json!({"text":"plan"})).unwrap();
        fixture.db.record_provider_event(&fixture.session_id, Some("plan-turn"), "chat.approval", &json!({
            "approvalId":"plan:plan-turn","part":{"type":"approval","approvalId":"plan:plan-turn","status":"pending","data":{"interaction":"plan","runtimeOwned":true,"plan":"# Plan"}}
        })).unwrap();
        fixture.db.record_provider_event(&fixture.session_id, Some("plan-turn"), "chat.turn.completed", &json!({"status":"completed"})).unwrap();
        mutate(&fixture.db, "chat.queue.resume", &json!({
            "sessionId":fixture.session_id,"operationId":"resume-before-plan-answer",
        })).unwrap();

        let event = ProviderEvent {
            provider: "queue-fixture".into(), session_id: fixture.session_id.clone(), native_id: None,
            turn_id: Some("plan-turn".into()), kind: "chat.approval.resolved".into(),
            data: json!({"approvalId":"plan:plan-turn","status":status,"returnToIdle":true}), worker_token: None,
        };
        fixture.db.record_provider_event(&fixture.session_id, event.turn_id.as_deref(), &event.kind, &event.data).unwrap();
        fixture.queues.provider_event(&fixture.db, &fixture.providers, &event);
        let deadline = Instant::now() + Duration::from_secs(2);
        while fixture.sent.lock().unwrap().is_empty() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(fixture.sent.lock().unwrap().len(), 1);
    }
}

#[test]
fn resolved_runtime_plan_keeps_a_paused_queue_paused() {
    let fixture = Fixture::new(false);
    fixture.add("do not send while paused", "add-paused-plan");
    pause(&fixture.db, &fixture.session_id, "stopped").unwrap();
    fixture.db.record_provider_event(&fixture.session_id, Some("plan-turn"), "message.user", &json!({"text":"plan"})).unwrap();
    fixture.db.record_provider_event(&fixture.session_id, Some("plan-turn"), "chat.approval", &json!({
        "approvalId":"plan:plan-turn","part":{"type":"approval","approvalId":"plan:plan-turn","status":"pending","data":{"interaction":"plan","runtimeOwned":true,"plan":"# Plan"}}
    })).unwrap();
    fixture.db.record_provider_event(&fixture.session_id, Some("plan-turn"), "chat.turn.completed", &json!({"status":"completed"})).unwrap();
    let event = ProviderEvent {
        provider: "queue-fixture".into(), session_id: fixture.session_id.clone(), native_id: None,
        turn_id: Some("plan-turn".into()), kind: "chat.approval.resolved".into(),
        data: json!({"approvalId":"plan:plan-turn","status":"dismissed","returnToIdle":true}), worker_token: None,
    };
    fixture.db.record_provider_event(&fixture.session_id, event.turn_id.as_deref(), &event.kind, &event.data).unwrap();
    fixture.queues.provider_event(&fixture.db, &fixture.providers, &event);
    thread::sleep(Duration::from_millis(50));
    assert_eq!(read(&fixture.db, &fixture.session_id).unwrap()["paused"], true);
    assert!(fixture.sent.lock().unwrap().is_empty());
}

#[test]
fn resolving_one_plan_does_not_dispatch_while_another_plan_is_pending() {
    let fixture = Fixture::new(false);
    fixture.add("wait for every plan", "add-two-plans");
    fixture.db.record_provider_event(&fixture.session_id, Some("first-turn"), "message.user", &json!({"text":"first plan"})).unwrap();
    for (turn, approval) in [("first-turn", "plan:first-turn"), ("second-turn", "plan:second-turn")] {
        fixture.db.record_provider_event(&fixture.session_id, Some(turn), "chat.approval", &json!({
            "approvalId":approval,"part":{"type":"approval","approvalId":approval,"status":"pending","data":{"interaction":"plan","runtimeOwned":true,"plan":"# Plan"}}
        })).unwrap();
    }
    fixture.db.record_provider_event(&fixture.session_id, Some("first-turn"), "chat.turn.completed", &json!({"status":"completed"})).unwrap();
    mutate(&fixture.db, "chat.queue.resume", &json!({
        "sessionId":fixture.session_id,"operationId":"resume-two-plans",
    })).unwrap();
    let event = ProviderEvent {
        provider: "queue-fixture".into(), session_id: fixture.session_id.clone(), native_id: None,
        turn_id: Some("first-turn".into()), kind: "chat.approval.resolved".into(),
        data: json!({"approvalId":"plan:first-turn","status":"answered","returnToIdle":true}), worker_token: None,
    };
    fixture.db.record_provider_event(&fixture.session_id, event.turn_id.as_deref(), &event.kind, &event.data).unwrap();
    fixture.queues.provider_event(&fixture.db, &fixture.providers, &event);
    thread::sleep(Duration::from_millis(50));
    assert_eq!(read(&fixture.db, &fixture.session_id).unwrap()["blocked"], "plan");
    assert!(fixture.sent.lock().unwrap().is_empty());
}

#[test]
fn resolving_a_native_approval_does_not_schedule_plan_dispatch() {
    let fixture = Fixture::new(false);
    fixture.add("wait for native approval", "add-native-approval");
    fixture.db.record_provider_event(&fixture.session_id, Some("approval-turn"), "message.user", &json!({"text":"work"})).unwrap();
    fixture.db.record_provider_event(&fixture.session_id, Some("approval-turn"), "chat.approval", &json!({
        "approvalId":"native-approval","part":{"type":"approval","approvalId":"native-approval","status":"pending","data":{"interaction":"question","runtimeOwned":false}}
    })).unwrap();
    fixture.db.record_provider_event(&fixture.session_id, Some("approval-turn"), "chat.turn.completed", &json!({"status":"completed"})).unwrap();
    let event = ProviderEvent {
        provider: "queue-fixture".into(), session_id: fixture.session_id.clone(), native_id: None,
        turn_id: Some("approval-turn".into()), kind: "chat.approval.resolved".into(),
        data: json!({"approvalId":"native-approval","status":"answered","returnToIdle":true}), worker_token: None,
    };
    fixture.db.record_provider_event(&fixture.session_id, event.turn_id.as_deref(), &event.kind, &event.data).unwrap();
    fixture.queues.provider_event(&fixture.db, &fixture.providers, &event);
    thread::sleep(Duration::from_millis(50));
    assert!(fixture.sent.lock().unwrap().is_empty());
}

#[test]
fn pending_cards_publish_scoped_lifecycle_events_for_queue_refresh() {
    for runtime_owned in [false, true] {
        let fixture = Fixture::new(false);
        fixture.add("wait for review", "pending-card-queue");
        fixture.db.record_provider_event(&fixture.session_id, Some("turn"), "message.user", &json!({"text":"work"})).unwrap();
        fixture.db.record_provider_event(&fixture.session_id, Some("turn"), "chat.approval", &json!({
            "approvalId":"card","part":{"data":{
                "interaction":if runtime_owned {"plan"} else {"question"},
                "runtimeOwned":runtime_owned,"waitingForPrompt":runtime_owned,"plan":"# Plan",
            }},
        })).unwrap();
        let events = fixture.db.transaction(|tx| {
            Ok(tx.query_row(
                "SELECT COUNT(*) FROM outbox WHERE json_extract(data,'$.sessionId')=? AND (event='session.activity' OR (event='state.changed' AND json_extract(data,'$.kind')='chat.approval'))",
                [&fixture.session_id], |row| row.get::<_, i64>(0),
            )?)
        }).unwrap();
        assert!(events >= 2, "pending card must publish activity and state without relying on chat.item");
        assert_eq!(read(&fixture.db, &fixture.session_id).unwrap()["blocked"], if runtime_owned {"plan"} else {"approval"});
    }
}
