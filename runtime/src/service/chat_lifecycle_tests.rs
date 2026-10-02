use super::*;
use crate::providers::{
    ChatSession, ProviderAdapter, ProviderCapability, ProviderError, TerminalCommand,
};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering as AtomicOrdering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    time::Duration,
};

struct OpenGate {
    started: SyncSender<()>,
    release: Mutex<Receiver<()>>,
}

struct FixtureAdapter {
    gate: Option<OpenGate>,
    failure: Mutex<Option<ProviderError>>,
    status_before_return: Option<(Arc<Database>, &'static str)>,
    opens: Arc<AtomicUsize>,
    stops: Arc<AtomicUsize>,
    alive: Arc<Mutex<Arc<std::sync::atomic::AtomicBool>>>,
    worker_tokens: Arc<Mutex<Vec<String>>>,
    initial_liveness: bool,
}

impl ProviderAdapter for FixtureAdapter {
    fn preflight_terminal_resume(&self, cwd: &str, native_id: &str) -> Result<(), ProviderError> {
        assert!(std::path::Path::new(cwd).is_dir());
        if native_id == "missing-history" {
            Err(ProviderError::new(
                "session_has_no_native_history",
                "No persisted native history",
            ))
        } else {
            Ok(())
        }
    }

    fn scopes_chat_events(&self) -> bool {
        true
    }

    fn open_chat_scoped(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
        worker_token: &str,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        self.worker_tokens
            .lock()
            .unwrap()
            .push(worker_token.to_owned());
        self.open_chat(session_id, cwd, native_id)
    }

    fn id(&self) -> &'static str {
        "grok"
    }

    fn capability(&self) -> ProviderCapability {
        ProviderCapability {
            id: "grok".into(),
            name: "Lifecycle fixture".into(),
            installed: true,
            version: Some("fixture".into()),
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
        Err(ProviderError::new(
            "fixture_terminal_unsupported",
            "fixture only supports Chat",
        ))
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
        self.opens.fetch_add(1, AtomicOrdering::SeqCst);
        if let Some(gate) = &self.gate {
            gate.started
                .send(())
                .map_err(|error| ProviderError::new("fixture_failed", error.to_string()))?;
            gate.release
                .lock()
                .map_err(|_| ProviderError::new("fixture_failed", "release lock poisoned"))?
                .recv()
                .map_err(|error| ProviderError::new("fixture_failed", error.to_string()))?;
        }
        if let Some(error) = self
            .failure
            .lock()
            .map_err(|_| ProviderError::new("fixture_failed", "failure lock poisoned"))?
            .take()
        {
            return Err(error);
        }
        if let Some((db, status)) = &self.status_before_return {
            db.set_session_status(_session_id, status, None)
                .map_err(|error| ProviderError::new("fixture_failed", error.to_string()))?;
        }
        Ok(Box::new(FixtureChat {
            stops: Arc::clone(&self.stops),
            alive: {
                let flag = Arc::new(std::sync::atomic::AtomicBool::new(self.initial_liveness));
                *self.alive.lock().unwrap() = Arc::clone(&flag);
                flag
            },
        }))
    }
}

struct FixtureChat {
    stops: Arc<AtomicUsize>,
    alive: Arc<std::sync::atomic::AtomicBool>,
}

impl ChatSession for FixtureChat {
    fn native_id(&self) -> Option<String> {
        Some("fixture-native".into())
    }

    fn is_alive(&self) -> bool {
        self.alive.load(AtomicOrdering::SeqCst)
    }

    fn send(&mut self, _text: &str, _operation_id: &str) -> Result<Value, ProviderError> {
        Ok(json!({"turnId":"fixture-turn"}))
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
        self.stops.fetch_add(1, AtomicOrdering::SeqCst);
        Ok(())
    }
}

struct Fixture {
    root: tempfile::TempDir,
    service: Arc<RuntimeService>,
    db: Arc<Database>,
    opens: Arc<AtomicUsize>,
    stops: Arc<AtomicUsize>,
    alive: Arc<Mutex<Arc<std::sync::atomic::AtomicBool>>>,
    worker_tokens: Arc<Mutex<Vec<String>>>,
    started: Option<Receiver<()>>,
    release: Option<SyncSender<()>>,
}

impl Fixture {
    fn new(slow: bool, failure: Option<ProviderError>) -> Self {
        Self::with_status_before_return(slow, failure, None)
    }

    fn with_status_before_return(
        slow: bool,
        failure: Option<ProviderError>,
        status_before_return: Option<&'static str>,
    ) -> Self {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        crate::retry_scheduler::initialize(&db).unwrap();
        let opens = Arc::new(AtomicUsize::new(0));
        let stops = Arc::new(AtomicUsize::new(0));
        let worker_tokens = Arc::new(Mutex::new(Vec::new()));
        let alive = Arc::new(Mutex::new(Arc::new(std::sync::atomic::AtomicBool::new(
            true,
        ))));
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let adapter = Arc::new(FixtureAdapter {
            gate: slow.then_some(OpenGate {
                started: started_tx,
                release: Mutex::new(release_rx),
            }),
            failure: Mutex::new(failure),
            status_before_return: status_before_return.map(|status| (Arc::clone(&db), status)),
            opens: Arc::clone(&opens),
            stops: Arc::clone(&stops),
            alive: Arc::clone(&alive),
            worker_tokens: Arc::clone(&worker_tokens),
            initial_liveness: true,
        });
        let output = Arc::new(OutputStore::default());
        let service = Arc::new(RuntimeService {
            config: RuntimeConfig {
                data_dir: root.path().to_owned(),
                database_path: root.path().join("runtime.sqlite"),
                credential_path: root.path().join("credential"),
                pipe_base: r"\\.\pipe\threadterm-v3-chat-lifecycle-test".into(),
            },
            db: Arc::clone(&db),
            leases: LeaseManager::default(),
            pty: Arc::new(PtyManager::new(Arc::clone(&output))),
            deferred_launch: Arc::new(Mutex::new(DeferredLaunchGate::default())),
            output,
            providers: Arc::new(Providers::for_test(vec![adapter])),
            shutdown_requested: AtomicBool::new(false),
            shutdown_pending: AtomicBool::new(false),
            relocation_gate: RwLock::new(()),
            retry_gate: Mutex::new(()),
            settings_apply_gate: Mutex::new(()),
            remote: OnceLock::new(),
        });
        Self {
            root,
            service,
            db,
            opens,
            stops,
            alive,
            worker_tokens,
            started: slow.then_some(started_rx),
            release: slow.then_some(release_tx),
        }
    }

    fn create(&self, operation_id: &str) -> Value {
        self.service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: format!("request-{operation_id}"),
                    method: "session.create".into(),
                    params: json!({
                        "cwd": self.root.path(),
                        "provider": "grok",
                        "mode": "chat",
                        "operationId": operation_id
                    }),
                },
            )
            .unwrap()
    }

    fn claim(&self, session_id: &str) -> i64 {
        self.service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: 1,
                    id: "claim".into(),
                    method: "session.claim".into(),
                    params: json!({"sessionId":session_id}),
                },
            )
            .unwrap()["leaseEpoch"]
            .as_i64()
            .unwrap()
    }

    fn connect_request(session_id: &str, lease_epoch: i64, operation_id: &str) -> RpcRequest {
        RpcRequest {
            v: 1,
            id: format!("request-{operation_id}"),
            method: "chat.connect".into(),
            params: json!({
                "sessionId":session_id,
                "leaseEpoch":lease_epoch,
                "operationId":operation_id
            }),
        }
    }
}

#[test]
fn terminal_resume_preflight_failure_preserves_identity_status_output_and_operation() {
    let fixture = Fixture::new(false, None);
    let session = fixture
        .db
        .create_session(crate::db::CreateSession {
            project_id: None,
            title: Some("Missing native history"),
            provider: "grok",
            mode: "terminal",
            native_id: Some("missing-history"),
            operation_id: "preflight-create",
        })
        .unwrap();
    fixture
        .db
        .set_session_status(&session.id, "exited", Some(0))
        .unwrap();
    fixture
        .db
        .append_output(&session.id, 0, b"retained original bytes")
        .unwrap();
    let before =
        serde_json::to_value(fixture.db.session_by_id(&session.id).unwrap().unwrap()).unwrap();
    let end = fixture.db.output_end(&session.id).unwrap();
    for _ in 0..2 {
        let error = fixture.service.dispatch("desktop", RpcRequest {
            v: 1,
            id: "resume-check".into(),
            method: "session.resume".into(),
            params: json!({"sessionId":session.id,"cwd":fixture.root.path(),"operationId":"preflight-resume"}),
        }).unwrap_err();
        assert_eq!(error.code, "session_has_no_native_history");
        assert_eq!(
            serde_json::to_value(fixture.db.session_by_id(&session.id).unwrap().unwrap()).unwrap(),
            before
        );
        assert_eq!(fixture.db.output_end(&session.id).unwrap(), end);
        assert!(fixture.db.operation("preflight-resume").unwrap().is_none());
        assert_eq!(fixture.opens.load(AtomicOrdering::SeqCst), 0);
    }
}

#[test]
fn chat_create_returns_starting_before_slow_connect_then_becomes_ready() {
    let fixture = Fixture::new(true, None);
    let created = fixture.create("create-slow");
    let session_id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(created["status"], "starting");
    assert_eq!(fixture.opens.load(AtomicOrdering::SeqCst), 0);

    // Replaying session.create returns the same current durable row without
    // starting a provider behind the caller's back.
    let replay = fixture.create("create-slow");
    assert_eq!(replay["id"], session_id);
    assert_eq!(replay["status"], "starting");
    assert_eq!(fixture.opens.load(AtomicOrdering::SeqCst), 0);

    let lease_epoch = fixture.claim(&session_id);
    let service = Arc::clone(&fixture.service);
    let connect_session = session_id.clone();
    let handle = std::thread::spawn(move || {
        service.dispatch(
            "desktop",
            Fixture::connect_request(&connect_session, lease_epoch, "connect-slow"),
        )
    });
    fixture
        .started
        .as_ref()
        .unwrap()
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    let connecting = fixture
        .service
        .dispatch(
            "viewer",
            RpcRequest {
                v: 1,
                id: "connection-while-slow".into(),
                method: "chat.connection".into(),
                params: json!({"sessionId":session_id}),
            },
        )
        .unwrap();
    assert_eq!(connecting["phase"], "connecting");

    fixture.release.as_ref().unwrap().send(()).unwrap();
    let ready = handle.join().unwrap().unwrap();
    assert_eq!(ready["phase"], "ready");
    assert_eq!(ready["nativeId"], "fixture-native");
    let session = fixture.db.session_by_id(&session_id).unwrap().unwrap();
    assert_eq!(session.status, "idle");
    assert_eq!(session.native_id.as_deref(), Some("fixture-native"));
    let replay_after_ready = fixture.create("create-slow");
    assert_eq!(replay_after_ready["id"], session_id);
    assert_eq!(replay_after_ready["status"], "idle");
    assert_eq!(replay_after_ready["nativeId"], "fixture-native");
    assert_eq!(fixture.opens.load(AtomicOrdering::SeqCst), 1);
}

#[test]
fn failed_first_connect_is_visible_and_durable() {
    let fixture = Fixture::new(
        false,
        Some(ProviderError::new(
            "fixture_connect_failed",
            "fixture handshake failed",
        )),
    );
    let created = fixture.create("create-failure");
    let session_id = created["id"].as_str().unwrap();
    let lease_epoch = fixture.claim(session_id);
    let failure = fixture
        .service
        .dispatch(
            "desktop",
            Fixture::connect_request(session_id, lease_epoch, "connect-failure"),
        )
        .unwrap_err();
    assert_eq!(failure.code, "fixture_connect_failed");
    assert_eq!(
        fixture
            .db
            .session_by_id(session_id)
            .unwrap()
            .unwrap()
            .status,
        "error"
    );
    let connection = fixture
        .service
        .dispatch(
            "viewer",
            RpcRequest {
                v: 1,
                id: "connection-after-failure".into(),
                method: "chat.connection".into(),
                params: json!({"sessionId":session_id}),
            },
        )
        .unwrap();
    assert_eq!(connection["phase"], "failed");
    assert_eq!(connection["error"]["code"], "fixture_connect_failed");
}

#[test]
fn failed_first_connect_can_retry_and_publish_ready() {
    let fixture = Fixture::new(
        false,
        Some(ProviderError::new(
            "fixture_connect_failed",
            "fixture failed once",
        )),
    );
    let created = fixture.create("create-retry-after-failure");
    let session_id = created["id"].as_str().unwrap().to_owned();
    let lease_epoch = fixture.claim(&session_id);

    fixture
        .service
        .dispatch(
            "desktop",
            Fixture::connect_request(&session_id, lease_epoch, "connect-fails-once"),
        )
        .unwrap_err();
    assert_eq!(
        fixture
            .db
            .session_by_id(&session_id)
            .unwrap()
            .unwrap()
            .status,
        "error"
    );

    let connected = fixture
        .service
        .dispatch(
            "desktop",
            Fixture::connect_request(&session_id, lease_epoch, "connect-retry-success"),
        )
        .unwrap();

    assert_eq!(connected["phase"], "ready");
    assert_eq!(fixture.opens.load(AtomicOrdering::SeqCst), 2);
    let session = fixture.db.session_by_id(&session_id).unwrap().unwrap();
    assert_eq!(session.status, "idle");
    assert_eq!(session.native_id.as_deref(), Some("fixture-native"));
}

#[test]
fn interrupted_session_can_reconnect_and_publish_ready() {
    let fixture = Fixture::new(false, None);
    let created = fixture.create("create-interrupted-reconnect");
    let session_id = created["id"].as_str().unwrap().to_owned();
    fixture
        .db
        .set_session_status(&session_id, "interrupted", None)
        .unwrap();
    let lease_epoch = fixture.claim(&session_id);

    let connected = fixture
        .service
        .dispatch(
            "desktop",
            Fixture::connect_request(&session_id, lease_epoch, "connect-interrupted"),
        )
        .unwrap();

    assert_eq!(connected["phase"], "ready");
    let session = fixture.db.session_by_id(&session_id).unwrap().unwrap();
    assert_eq!(session.status, "idle");
    assert_eq!(session.native_id.as_deref(), Some("fixture-native"));
}

#[test]
fn stop_before_connect_and_stop_during_connect_cannot_publish_ready() {
    let before = Fixture::new(true, None);
    let created = before.create("create-stop-before");
    let session_id = created["id"].as_str().unwrap();
    before
        .service
        .dispatch(
            "desktop",
            RpcRequest {
                v: 1,
                id: "stop-before".into(),
                method: "session.stop".into(),
                params: json!({"sessionId":session_id,"operationId":"stop-before"}),
            },
        )
        .unwrap();
    assert_eq!(
        before.db.session_by_id(session_id).unwrap().unwrap().status,
        "exited"
    );
    assert_eq!(before.opens.load(AtomicOrdering::SeqCst), 0);

    let during = Fixture::new(true, None);
    let created = during.create("create-stop-during");
    let session_id = created["id"].as_str().unwrap().to_owned();
    let lease_epoch = during.claim(&session_id);
    let service = Arc::clone(&during.service);
    let connect_session = session_id.clone();
    let handle = std::thread::spawn(move || {
        service.dispatch(
            "desktop",
            Fixture::connect_request(&connect_session, lease_epoch, "connect-stop-during"),
        )
    });
    during
        .started
        .as_ref()
        .unwrap()
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    during
        .service
        .dispatch(
            "desktop",
            RpcRequest {
                v: 1,
                id: "stop-during".into(),
                method: "session.stop".into(),
                params: json!({"sessionId":session_id,"operationId":"stop-during"}),
            },
        )
        .unwrap();
    during.release.as_ref().unwrap().send(()).unwrap();
    let failure = handle.join().unwrap().unwrap_err();
    assert_eq!(failure.code, "chat_connect_superseded");
    assert_eq!(
        during
            .db
            .session_by_id(&session_id)
            .unwrap()
            .unwrap()
            .status,
        "exited"
    );
    let connection = during
        .service
        .dispatch(
            "viewer",
            RpcRequest {
                v: 1,
                id: "connection-after-stop".into(),
                method: "chat.connection".into(),
                params: json!({"sessionId":session_id}),
            },
        )
        .unwrap();
    assert_ne!(connection["phase"], "ready");
    assert_eq!(during.stops.load(AtomicOrdering::SeqCst), 1);
}

#[test]
fn terminal_status_winning_the_connection_handoff_closes_the_late_worker() {
    let fixture = Fixture::with_status_before_return(false, None, Some("exited"));
    let created = fixture.create("create-stop-at-handoff");
    let session_id = created["id"].as_str().unwrap().to_owned();
    let lease_epoch = fixture.claim(&session_id);

    let failure = fixture
        .service
        .dispatch(
            "desktop",
            Fixture::connect_request(&session_id, lease_epoch, "connect-stop-at-handoff"),
        )
        .unwrap_err();

    assert_eq!(failure.code, "invalid_request");
    assert!(failure.message.contains("chat_connect_superseded"));
    let session = fixture.db.session_by_id(&session_id).unwrap().unwrap();
    assert_eq!(session.status, "exited");
    assert_eq!(session.native_id, None);
    assert_eq!(fixture.stops.load(AtomicOrdering::SeqCst), 1);
    assert_ne!(
        fixture.service.connection_state(&session_id).unwrap()["phase"],
        "ready"
    );
}

#[test]
fn connection_handoff_preserves_an_early_running_state() {
    let fixture = Fixture::with_status_before_return(false, None, Some("running"));
    let created = fixture.create("create-running-at-handoff");
    let session_id = created["id"].as_str().unwrap().to_owned();
    let lease_epoch = fixture.claim(&session_id);

    let connected = fixture
        .service
        .dispatch(
            "desktop",
            Fixture::connect_request(&session_id, lease_epoch, "connect-running-at-handoff"),
        )
        .unwrap();

    assert_eq!(connected["phase"], "ready");
    let session = fixture.db.session_by_id(&session_id).unwrap().unwrap();
    assert_eq!(session.status, "running");
    assert_eq!(session.native_id.as_deref(), Some("fixture-native"));
    assert_eq!(fixture.stops.load(AtomicOrdering::SeqCst), 0);
}

#[test]
fn internal_worker_death_disconnects_and_explicit_reconnect_replaces_the_generation() {
    let fixture = Fixture::new(false, None);
    let created = fixture.create("create-internal-death");
    let session_id = created["id"].as_str().unwrap().to_owned();
    let lease_epoch = fixture.claim(&session_id);
    let connected = fixture
        .service
        .dispatch(
            "desktop",
            Fixture::connect_request(&session_id, lease_epoch, "connect-before-death"),
        )
        .unwrap();
    assert_eq!(connected["phase"], "ready");
    let generation = connected["connectionGeneration"].as_u64().unwrap();

    // A close notice for a healthy worker is a no-op (late or stale signal).
    fixture.service.providers.note_session_closed(&session_id);
    let state = fixture.service.connection_state(&session_id).unwrap();
    assert_eq!(state["phase"], "ready");

    // The worker dies internally while its host would still look alive.
    fixture
        .alive
        .lock()
        .unwrap()
        .store(false, AtomicOrdering::SeqCst);
    fixture.service.providers.note_session_closed(&session_id);
    let state = fixture.service.connection_state(&session_id).unwrap();
    assert_eq!(state["phase"], "disconnected");
    assert!(state["connectionGeneration"].as_u64().unwrap() > generation);

    // An explicit reconnect replaces the dead worker and keeps the identity.
    let reconnected = fixture
        .service
        .dispatch(
            "desktop",
            Fixture::connect_request(&session_id, lease_epoch, "connect-after-death"),
        )
        .unwrap();
    assert_eq!(reconnected["phase"], "ready");
    assert_eq!(reconnected["nativeId"], "fixture-native");
    assert_eq!(fixture.opens.load(AtomicOrdering::SeqCst), 2);
    assert!(
        reconnected["connectionGeneration"].as_u64().unwrap()
            > state["connectionGeneration"].as_u64().unwrap()
    );
}

fn scoped_event(session_id: &str, token: Option<&str>, kind: &str, data: Value) -> ProviderEvent {
    ProviderEvent {
        provider: "grok".into(),
        session_id: session_id.into(),
        native_id: Some("fixture-native".into()),
        turn_id: Some("fixture-turn".into()),
        kind: kind.into(),
        data,
        worker_token: token.map(ToOwned::to_owned),
    }
}

#[test]
fn queued_old_worker_events_cannot_change_a_reconnected_session() {
    let fixture = Fixture::new(false, None);
    let created = fixture.create("create-scope");
    let id = created["id"].as_str().unwrap();
    let providers = &fixture.service.providers;
    providers.chat_open(id, "grok", "fixture", None).unwrap();
    let old_token = fixture.worker_tokens.lock().unwrap()[0].clone();
    providers.chat_stop(id).unwrap();
    let old_connection = providers.chat_connection(id);
    providers
        .chat_open(id, "grok", "fixture", Some("fixture-native"))
        .unwrap();
    let new_token = fixture.worker_tokens.lock().unwrap()[1].clone();
    project_provider_event(
        &fixture.db,
        providers,
        &scoped_event(id, Some(&new_token), "chat.turn.completed", json!({})),
    );
    for token in [Some(old_token.as_str()), None] {
        project_provider_event(
            &fixture.db,
            providers,
            &scoped_event(id, token, "chat.error", json!({"message":"stale worker"})),
        );
        assert_eq!(
            fixture.db.session_by_id(id).unwrap().unwrap().status,
            "idle"
        );
    }
    let approval = scoped_event(
        id,
        Some(&new_token),
        "chat.approval",
        json!({"approvalId":"current-approval","message":"current permission"}),
    );
    project_provider_event(&fixture.db, providers, &approval);
    project_provider_event(
        &fixture.db,
        providers,
        &ProviderEvent {
            provider: "runtime".into(),
            session_id: id.into(),
            native_id: None,
            turn_id: None,
            kind: "chat.connection".into(),
            data: old_connection,
            worker_token: None,
        },
    );
    let items = fixture.db.chat_items(id).unwrap();
    assert!(
        items
            .iter()
            .flat_map(|item| &item.parts)
            .any(|part| part.get("status").and_then(Value::as_str) == Some("pending")),
        "old disconnect must not expire a new permission: {items:?}"
    );
    let mut conflict = scoped_event(
        id,
        Some(&new_token),
        "chat.error",
        json!({"message":"identity conflict"}),
    );
    conflict.native_id = Some("wrong-native".into());
    project_provider_event(&fixture.db, providers, &conflict);
    assert_eq!(
        fixture.db.session_by_id(id).unwrap().unwrap().status,
        "waiting"
    );
    assert_eq!(
        fixture
            .db
            .session_by_id(id)
            .unwrap()
            .unwrap()
            .native_id
            .as_deref(),
        Some("fixture-native")
    );
}

#[test]
fn final_worker_error_survives_liveness_poll_but_not_explicit_stop() {
    let fixture = Fixture::new(false, None);
    let created = fixture.create("create-final-event");
    let id = created["id"].as_str().unwrap();
    let providers = &fixture.service.providers;
    providers.chat_open(id, "grok", "fixture", None).unwrap();
    let token = fixture.worker_tokens.lock().unwrap()[0].clone();
    fixture
        .alive
        .lock()
        .unwrap()
        .store(false, AtomicOrdering::SeqCst);
    assert_eq!(providers.chat_connection(id)["phase"], "disconnected");
    project_provider_event(
        &fixture.db,
        providers,
        &scoped_event(
            id,
            Some(&token),
            "chat.error",
            json!({"message":"final error"}),
        ),
    );
    assert_eq!(
        fixture.db.session_by_id(id).unwrap().unwrap().status,
        "error"
    );
    providers.chat_stop(id).unwrap();
    project_provider_event(
        &fixture.db,
        providers,
        &scoped_event(id, Some(&token), "chat.turn.started", json!({})),
    );
    assert_eq!(
        fixture.db.session_by_id(id).unwrap().unwrap().status,
        "error"
    );
}

#[test]
fn provider_handoff_does_not_publish_an_already_dead_worker() {
    let adapter = FixtureAdapter {
        gate: None,
        failure: Mutex::new(None),
        status_before_return: None,
        opens: Arc::new(AtomicUsize::new(0)),
        stops: Arc::new(AtomicUsize::new(0)),
        alive: Arc::new(Mutex::new(Arc::new(std::sync::atomic::AtomicBool::new(
            false,
        )))),
        worker_tokens: Arc::new(Mutex::new(Vec::new())),
        initial_liveness: false,
    };
    let providers = Providers::for_test(vec![Arc::new(adapter)]);
    assert_eq!(
        providers
            .chat_open("s", "grok", "fixture", None)
            .unwrap_err()
            .code,
        "provider_disconnected"
    );
    assert_eq!(providers.chat_connection("s")["phase"], "failed");
    assert!(!providers.chat_is_open("s"));
}

#[test]
fn connecting_events_accept_current_worker_and_stop_fences_early_notifications() {
    let fixture = Fixture::new(true, None);
    let created = fixture.create("create-early-scoped");
    let id = created["id"].as_str().unwrap().to_owned();
    let providers = fixture.service.providers.clone();
    let opening_id = id.clone();
    let opening =
        std::thread::spawn(move || providers.chat_open(&opening_id, "grok", "fixture", None));
    fixture
        .started
        .as_ref()
        .unwrap()
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    let token = fixture.worker_tokens.lock().unwrap()[0].clone();
    let providers = &fixture.service.providers;
    let event = scoped_event(&id, Some(&token), "chat.turn.started", json!({}));
    project_provider_event(&fixture.db, providers, &event);
    assert_eq!(
        fixture.db.session_by_id(&id).unwrap().unwrap().status,
        "running"
    );
    assert!(serde_json::to_value(&event)
        .unwrap()
        .get("workerToken")
        .is_none());
    providers.chat_stop(&id).unwrap();
    project_provider_event(
        &fixture.db,
        providers,
        &scoped_event(&id, Some(&token), "chat.error", json!({"message":"late"})),
    );
    assert_eq!(
        fixture.db.session_by_id(&id).unwrap().unwrap().status,
        "running"
    );
    fixture.release.as_ref().unwrap().send(()).unwrap();
    assert_eq!(
        opening.join().unwrap().unwrap_err().code,
        "chat_connect_superseded"
    );
}

#[test]
fn replacement_connecting_expires_old_cards_before_new_worker_cards_arrive() {
    let fixture = Fixture::new(false, None);
    let created = fixture.create("create-reconnect-permission");
    let id = created["id"].as_str().unwrap();
    let providers = &fixture.service.providers;
    providers.chat_open(id, "grok", "fixture", None).unwrap();
    let old_token = fixture.worker_tokens.lock().unwrap()[0].clone();
    project_provider_event(
        &fixture.db,
        providers,
        &scoped_event(
            id,
            Some(&old_token),
            "chat.approval",
            json!({"approvalId":"old"}),
        ),
    );
    fixture
        .alive
        .lock()
        .unwrap()
        .store(false, AtomicOrdering::SeqCst);
    let mut events = providers.subscribe();
    providers
        .chat_open(id, "grok", "fixture", Some("fixture-native"))
        .unwrap();
    while let Ok(event) = events.try_recv() {
        project_provider_event(&fixture.db, providers, &event);
    }
    let token = fixture.worker_tokens.lock().unwrap()[1].clone();
    project_provider_event(
        &fixture.db,
        providers,
        &scoped_event(
            id,
            Some(&token),
            "chat.approval",
            json!({"approvalId":"new"}),
        ),
    );
    project_provider_event(
        &fixture.db,
        providers,
        &scoped_event(
            id,
            Some(&old_token),
            "chat.error",
            json!({"message":"EOF queued before reconnect"}),
        ),
    );
    let items = fixture.db.chat_items(id).unwrap();
    let part_for = |approval_id| {
        items
            .iter()
            .flat_map(|item| &item.parts)
            .find(|part| part["approvalId"] == approval_id)
            .unwrap()
    };
    assert_eq!(part_for("old")["status"], "expired");
    assert_eq!(part_for("new")["status"], "pending");
    assert_eq!(
        fixture.db.session_by_id(id).unwrap().unwrap().status,
        "waiting"
    );
}
