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
}

impl ProviderAdapter for FixtureAdapter {
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
            reason: None,
            auth: "authenticated".into(),
        }
    }

    fn terminal_command(&self, _native_id: Option<&str>) -> Result<TerminalCommand, ProviderError> {
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
        }))
    }
}

struct FixtureChat {
    stops: Arc<AtomicUsize>,
}

impl ChatSession for FixtureChat {
    fn native_id(&self) -> Option<String> {
        Some("fixture-native".into())
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
            pty: PtyManager::new(Arc::clone(&output)),
            output,
            providers: Providers::for_test(vec![adapter]),
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
