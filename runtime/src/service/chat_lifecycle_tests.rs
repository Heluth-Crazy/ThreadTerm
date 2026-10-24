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
    failures: Mutex<Vec<ProviderError>>,
    status_before_return: Option<(Arc<Database>, &'static str)>,
    opens: Arc<AtomicUsize>,
    stops: Arc<AtomicUsize>,
    alive: Arc<Mutex<Arc<std::sync::atomic::AtomicBool>>>,
    worker_tokens: Arc<Mutex<Vec<String>>>,
    initial_liveness: bool,
    /// Delegation tests run several chats at once; real providers give each a
    /// distinct native id, which `accept_chat_connection` requires.
    unique_native_ids: bool,
    /// Blocks the first send until the test releases it (F09 cancel race).
    send_gate: Option<(SyncSender<()>, Arc<Mutex<Receiver<()>>>)>,
    cancels: Arc<AtomicUsize>,
    /// Cancel errors the fixture's chats return, in order (F09 refusal).
    cancel_failures: Arc<Mutex<Vec<ProviderError>>>,
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
            source: "builtin", plugin_id: None, icon: None, sign_in: None, homepage: None,
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
        let open = self.opens.fetch_add(1, AtomicOrdering::SeqCst);
        let native = if self.unique_native_ids {
            format!("fixture-native-{open}")
        } else {
            "fixture-native".into()
        };
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
        let failure = {
            let mut failures = self
                .failures
                .lock()
                .map_err(|_| ProviderError::new("fixture_failed", "failure lock poisoned"))?;
            (!failures.is_empty()).then(|| failures.remove(0))
        };
        if let Some(error) = failure {
            return Err(error);
        }
        if let Some((db, status)) = &self.status_before_return {
            db.set_session_status(_session_id, status, None)
                .map_err(|error| ProviderError::new("fixture_failed", error.to_string()))?;
        }
        Ok(Box::new(FixtureChat {
            native,
            stops: Arc::clone(&self.stops),
            alive: {
                let flag = Arc::new(std::sync::atomic::AtomicBool::new(self.initial_liveness));
                *self.alive.lock().unwrap() = Arc::clone(&flag);
                flag
            },
            send_gate: self.send_gate.clone(),
            cancels: Arc::clone(&self.cancels),
            cancel_failures: Arc::clone(&self.cancel_failures),
        }))
    }
}

struct FixtureChat {
    native: String,
    stops: Arc<AtomicUsize>,
    alive: Arc<std::sync::atomic::AtomicBool>,
    send_gate: Option<(SyncSender<()>, Arc<Mutex<Receiver<()>>>)>,
    cancels: Arc<AtomicUsize>,
    cancel_failures: Arc<Mutex<Vec<ProviderError>>>,
}

impl ChatSession for FixtureChat {
    fn native_id(&self) -> Option<String> {
        Some(self.native.clone())
    }

    fn is_alive(&self) -> bool {
        self.alive.load(AtomicOrdering::SeqCst)
    }

    fn send(&mut self, _text: &str, _operation_id: &str) -> Result<Value, ProviderError> {
        if let Some((started, release)) = &self.send_gate {
            started
                .send(())
                .map_err(|error| ProviderError::new("fixture_failed", error.to_string()))?;
            release
                .lock()
                .map_err(|_| ProviderError::new("fixture_failed", "release lock poisoned"))?
                .recv()
                .map_err(|error| ProviderError::new("fixture_failed", error.to_string()))?;
        }
        Ok(json!({"turnId":"fixture-turn"}))
    }

    fn cancel(&mut self, _turn_id: &str) -> Result<(), ProviderError> {
        self.cancels.fetch_add(1, AtomicOrdering::SeqCst);
        let failure = {
            let mut failures = self
                .cancel_failures
                .lock()
                .map_err(|_| ProviderError::new("fixture_failed", "cancel failure lock poisoned"))?;
            (!failures.is_empty()).then(|| failures.remove(0))
        };
        failure.map_or(Ok(()), Err)
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
    /// Set when the send blocks: the send is in flight until `send_release` fires.
    send_started: Option<Receiver<()>>,
    send_release: Option<SyncSender<()>>,
    cancels: Arc<AtomicUsize>,
    cancel_failures: Arc<Mutex<Vec<ProviderError>>>,
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
        Self::build(
            slow,
            failure.into_iter().collect(),
            status_before_return,
            false,
            true,
            false,
        )
    }

    fn with_failures(failures: Vec<ProviderError>) -> Self {
        Self::build(false, failures, None, false, true, false)
    }

    fn with_failures_and_liveness(
        failures: Vec<ProviderError>,
        initial_liveness: bool,
    ) -> Self {
        Self::build(false, failures, None, false, initial_liveness, false)
    }

    /// Several concurrent chats (parent and delegates) with distinct native ids.
    fn for_delegation() -> Self {
        Self::build(false, Vec::new(), None, true, true, false)
    }

    /// `for_delegation` where the first send of a delegate blocks until the
    /// test releases it: the window between the start's check and its send.
    fn for_delegation_with_blocked_send() -> Self {
        Self::build(false, Vec::new(), None, true, true, true)
    }

    fn build(
        slow: bool,
        failures: Vec<ProviderError>,
        status_before_return: Option<&'static str>,
        unique_native_ids: bool,
        initial_liveness: bool,
        blocked_send: bool,
    ) -> Self {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        crate::retry_scheduler::initialize(&db).unwrap();
        crate::chat_queue::initialize(&db).unwrap();
        let opens = Arc::new(AtomicUsize::new(0));
        let stops = Arc::new(AtomicUsize::new(0));
        let worker_tokens = Arc::new(Mutex::new(Vec::new()));
        let alive = Arc::new(Mutex::new(Arc::new(std::sync::atomic::AtomicBool::new(
            true,
        ))));
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let (send_started_tx, send_started_rx) = mpsc::sync_channel(1);
        let (send_release_tx, send_release_rx) = mpsc::sync_channel(1);
        let cancels = Arc::new(AtomicUsize::new(0));
        let cancel_failures = Arc::new(Mutex::new(Vec::new()));
        let adapter = Arc::new(FixtureAdapter {
            gate: slow.then_some(OpenGate {
                started: started_tx,
                release: Mutex::new(release_rx),
            }),
            failures: Mutex::new(failures),
            status_before_return: status_before_return.map(|status| (Arc::clone(&db), status)),
            opens: Arc::clone(&opens),
            stops: Arc::clone(&stops),
            alive: Arc::clone(&alive),
            worker_tokens: Arc::clone(&worker_tokens),
            initial_liveness,
            unique_native_ids,
            send_gate: blocked_send
                .then(|| (send_started_tx, Arc::new(Mutex::new(send_release_rx)))),
            cancels: Arc::clone(&cancels),
            cancel_failures: Arc::clone(&cancel_failures),
        });
        let output = Arc::new(OutputStore::default());
        let service = Arc::new(RuntimeService {
            previews: Arc::new(crate::preview::Previews::new(Arc::clone(&db)).unwrap()),
            browser_tools: RuntimeService::browser_test_tools(&db),
            shutdown_changed: tokio::sync::Notify::new(),
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
            plugin_gate: Mutex::new(()),
            remote: OnceLock::new(),
            delegations: Arc::new(crate::delegation::Delegations::default()),
            chat_queues: Arc::new(crate::chat_queue::ChatQueues::default()),
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
            send_started: blocked_send.then_some(send_started_rx),
            send_release: blocked_send.then_some(send_release_tx),
            cancels,
            cancel_failures,
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

    fn create_with_native(&self, operation_id: &str, native_id: &str) -> Value {
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
                        "nativeId": native_id,
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

fn missing_native_thread() -> ProviderError {
    ProviderError::new("native_thread_missing", "the native thread does not exist")
}

#[test]
fn missing_native_thread_recovers_only_an_empty_chat_and_replaces_its_identity() {
    let fixture = Fixture::new(false, Some(missing_native_thread()));
    let created = fixture.create_with_native("create-missing-empty", "missing-native");
    let session_id = created["id"].as_str().unwrap();
    let lease_epoch = fixture.claim(session_id);
    let connected = fixture
        .service
        .dispatch(
            "desktop",
            Fixture::connect_request(session_id, lease_epoch, "connect-missing-empty"),
        )
        .unwrap();

    assert_eq!(connected["phase"], "ready");
    assert_eq!(connected["nativeId"], "fixture-native");
    assert_eq!(fixture.opens.load(AtomicOrdering::SeqCst), 2);
    let tokens = fixture.worker_tokens.lock().unwrap();
    assert_eq!(tokens.len(), 2);
    assert_ne!(tokens[0], tokens[1]);
    drop(tokens);
    let stored = fixture.db.session_by_id(session_id).unwrap().unwrap();
    assert_eq!(stored.native_id.as_deref(), Some("fixture-native"));
    assert_eq!(stored.status, "idle");
}

#[test]
fn explicit_resume_recovers_a_missing_native_thread_for_an_empty_chat() {
    let fixture = Fixture::new(false, Some(missing_native_thread()));
    let created = fixture.create_with_native("create-resumable-empty", "missing-native");
    let session_id = created["id"].as_str().unwrap();
    fixture
        .db
        .set_session_status(session_id, "exited", Some(0))
        .unwrap();

    let resumed = fixture
        .service
        .dispatch(
            "desktop",
            RpcRequest {
                v: 1,
                id: "resume-missing-empty".into(),
                method: "session.resume".into(),
                params: json!({
                    "sessionId": session_id,
                    "cwd": fixture.root.path(),
                    "operationId": "resume-missing-empty"
                }),
            },
        )
        .unwrap();

    assert_eq!(resumed["nativeId"], "fixture-native");
    assert_eq!(resumed["status"], "idle");
    assert_eq!(fixture.opens.load(AtomicOrdering::SeqCst), 2);
    let stored = fixture.db.session_by_id(session_id).unwrap().unwrap();
    assert_eq!(stored.native_id.as_deref(), Some("fixture-native"));
}

#[test]
fn missing_native_thread_with_any_chat_item_keeps_the_original_failure_and_identity() {
    let fixture = Fixture::new(false, Some(missing_native_thread()));
    let created = fixture.create_with_native("create-missing-message", "missing-native");
    let session_id = created["id"].as_str().unwrap();
    fixture
        .db
        .transaction(|tx| {
            tx.execute(
                "INSERT INTO chat_items(id,session_id,kind,data,created_at) VALUES ('evidence',?,'system','{}','now')",
                [session_id],
            )?;
            Ok(())
        })
        .unwrap();
    let lease_epoch = fixture.claim(session_id);
    let error = fixture
        .service
        .dispatch(
            "desktop",
            Fixture::connect_request(session_id, lease_epoch, "connect-missing-message"),
        )
        .unwrap_err();

    assert_eq!(error.code, "native_resume_failed");
    assert_eq!(fixture.opens.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(
        fixture
            .db
            .session_by_id(session_id)
            .unwrap()
            .unwrap()
            .native_id
            .as_deref(),
        Some("missing-native")
    );
}

#[test]
fn non_missing_resume_errors_never_open_a_replacement() {
    for (case, error) in [
        (
            "auth",
            ProviderError::new("auth_required", "authentication required"),
        ),
        (
            "network",
            ProviderError::new("provider_network", "network unavailable"),
        ),
        (
            "timeout",
            ProviderError::new("provider_timeout", "provider timed out"),
        ),
        (
            "cwd",
            ProviderError::new("cwd_missing", "working directory is missing"),
        ),
        (
            "invalid-id",
            ProviderError::new("invalid_native_id", "native id is invalid"),
        ),
        (
            "protocol",
            ProviderError::new("provider_protocol", "bad response"),
        ),
    ] {
        let fixture = Fixture::new(false, Some(error));
        let created = fixture.create_with_native(&format!("create-{case}"), "missing-native");
        let session_id = created["id"].as_str().unwrap();
        let lease_epoch = fixture.claim(session_id);
        fixture
            .service
            .dispatch(
                "desktop",
                Fixture::connect_request(session_id, lease_epoch, &format!("connect-{case}")),
            )
            .unwrap_err();

        assert_eq!(
            fixture.opens.load(AtomicOrdering::SeqCst),
            1,
            "case {case}"
        );
        assert_eq!(
            fixture
                .db
                .session_by_id(session_id)
                .unwrap()
                .unwrap()
                .native_id
                .as_deref(),
            Some("missing-native"),
            "case {case}"
        );
    }
}

#[test]
fn failed_fresh_open_leaves_the_missing_native_identity_unchanged() {
    let fixture = Fixture::with_failures(vec![
        missing_native_thread(),
        ProviderError::new("provider_unavailable", "fresh provider failed"),
    ]);
    let created = fixture.create_with_native("create-fresh-failure", "missing-native");
    let session_id = created["id"].as_str().unwrap();
    let lease_epoch = fixture.claim(session_id);
    let error = fixture
        .service
        .dispatch(
            "desktop",
            Fixture::connect_request(session_id, lease_epoch, "connect-fresh-failure"),
        )
        .unwrap_err();

    assert_eq!(error.code, "provider_unavailable");
    assert_eq!(fixture.opens.load(AtomicOrdering::SeqCst), 2);
    assert_eq!(
        fixture
            .db
            .session_by_id(session_id)
            .unwrap()
            .unwrap()
            .native_id
            .as_deref(),
        Some("missing-native")
    );
}

#[test]
fn dead_fresh_worker_is_stopped_before_any_native_identity_replacement() {
    let fixture = Fixture::with_failures_and_liveness(vec![missing_native_thread()], false);
    let created = fixture.create_with_native("create-dead-fresh", "missing-native");
    let session_id = created["id"].as_str().unwrap();
    let lease_epoch = fixture.claim(session_id);
    let error = fixture
        .service
        .dispatch(
            "desktop",
            Fixture::connect_request(session_id, lease_epoch, "connect-dead-fresh"),
        )
        .unwrap_err();

    assert_eq!(error.code, "native_resume_failed");
    assert_eq!(fixture.opens.load(AtomicOrdering::SeqCst), 2);
    assert_eq!(fixture.stops.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(
        fixture
            .db
            .session_by_id(session_id)
            .unwrap()
            .unwrap()
            .native_id
            .as_deref(),
        Some("missing-native")
    );
}

#[test]
fn recovery_candidate_token_is_for_tools_only_until_identity_commit() {
    let fixture = Fixture::new(true, Some(missing_native_thread()));
    let created = fixture.create_with_native("create-token-fence", "missing-native");
    let session_id = created["id"].as_str().unwrap().to_owned();
    let lease_epoch = fixture.claim(&session_id);
    let service = Arc::clone(&fixture.service);
    let connecting_id = session_id.clone();
    let opening = std::thread::spawn(move || {
        service.dispatch(
            "desktop",
            Fixture::connect_request(&connecting_id, lease_epoch, "connect-token-fence"),
        )
    });

    fixture
        .started
        .as_ref()
        .unwrap()
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    fixture.release.as_ref().unwrap().send(()).unwrap();
    fixture
        .started
        .as_ref()
        .unwrap()
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    let tokens = fixture.worker_tokens.lock().unwrap().clone();
    assert_eq!(tokens.len(), 2);
    let old = scoped_event(&session_id, Some(&tokens[0]), "session.ready", json!({}));
    let candidate = scoped_event(&session_id, Some(&tokens[1]), "session.ready", json!({}));
    assert_eq!(
        fixture.service.providers.preview_worker_token(&session_id),
        Some(tokens[1].clone()),
        "tool grants must use the fresh candidate token"
    );
    assert!(fixture
        .service
        .providers
        .with_current_event(&old, || ())
        .is_none());
    assert!(fixture
        .service
        .providers
        .with_current_event(&candidate, || ())
        .is_none());

    fixture.release.as_ref().unwrap().send(()).unwrap();
    assert_eq!(opening.join().unwrap().unwrap()["phase"], "ready");
    assert_eq!(
        fixture
            .service
            .providers
            .with_current_event(&candidate, || "accepted"),
        Some("accepted")
    );
    assert!(fixture
        .service
        .providers
        .with_current_event(&old, || ())
        .is_none());
}

#[test]
fn stop_during_fresh_recovery_supersedes_the_same_generation_and_keeps_old_identity() {
    let fixture = Fixture::new(true, Some(missing_native_thread()));
    let created = fixture.create_with_native("create-stop-recovery", "missing-native");
    let session_id = created["id"].as_str().unwrap().to_owned();
    let lease_epoch = fixture.claim(&session_id);
    let service = Arc::clone(&fixture.service);
    let connecting_id = session_id.clone();
    let opening = std::thread::spawn(move || {
        service.dispatch(
            "desktop",
            Fixture::connect_request(&connecting_id, lease_epoch, "connect-stop-recovery"),
        )
    });
    fixture
        .started
        .as_ref()
        .unwrap()
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    fixture.release.as_ref().unwrap().send(()).unwrap();
    fixture
        .started
        .as_ref()
        .unwrap()
        .recv_timeout(Duration::from_secs(2))
        .unwrap();

    fixture
        .service
        .dispatch(
            "desktop",
            RpcRequest {
                v: 1,
                id: "stop-recovery".into(),
                method: "session.stop".into(),
                params: json!({
                    "sessionId":session_id,
                    "operationId":"stop-recovery"
                }),
            },
        )
        .unwrap();
    fixture.release.as_ref().unwrap().send(()).unwrap();
    assert_eq!(
        opening.join().unwrap().unwrap_err().code,
        "chat_connect_superseded"
    );
    let stored = fixture.db.session_by_id(&session_id).unwrap().unwrap();
    assert_eq!(stored.native_id.as_deref(), Some("missing-native"));
    assert_eq!(stored.status, "exited");
    assert_eq!(fixture.opens.load(AtomicOrdering::SeqCst), 2);
    assert_eq!(fixture.stops.load(AtomicOrdering::SeqCst), 1);
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
        failures: Mutex::new(Vec::new()),
        status_before_return: None,
        opens: Arc::new(AtomicUsize::new(0)),
        stops: Arc::new(AtomicUsize::new(0)),
        alive: Arc::new(Mutex::new(Arc::new(std::sync::atomic::AtomicBool::new(
            false,
        )))),
        worker_tokens: Arc::new(Mutex::new(Vec::new())),
        initial_liveness: false,
        unique_native_ids: false,
        send_gate: None,
        cancels: Arc::new(AtomicUsize::new(0)),
        cancel_failures: Arc::new(Mutex::new(Vec::new())),
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

// ---- agent delegation ------------------------------------------------------
// The fixture adapter is a parent-capable `grok` Chat, so these tests delegate
// grok → grok. Provider events are fed through `record_provider_event`, the
// projection entry point, instead of a live provider.

fn rpc(fixture: &Fixture, method: &str, params: Value) -> Result<Value, RpcError> {
    rpc_service(&fixture.service, method, params)
}

/// `rpc` for a thread that may only hold the service (F09 cancel races).
fn rpc_service(service: &Arc<RuntimeService>, method: &str, params: Value) -> Result<Value, RpcError> {
    service.dispatch(
        "mcp-test",
        RpcRequest {
            v: 1,
            id: format!("request-{method}"),
            method: method.into(),
            params,
        },
    )
}

fn delegation_parent(fixture: &Fixture, operation_id: &str) -> (String, String) {
    let parent = fixture.create(operation_id)["id"].as_str().unwrap().to_owned();
    let token = fixture.service.delegations.issue_token(&parent);
    (parent, token)
}

fn start_delegate(
    fixture: &Fixture,
    parent: &str,
    token: &str,
    operation_id: &str,
) -> Result<Value, RpcError> {
    rpc(
        fixture,
        "delegation.start",
        json!({"callerSessionId":parent,"callerToken":token,"agent":"grok","prompt":"Summarise the README\nthen stop","operationId":operation_id}),
    )
}

fn wait_for(mut check: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !check() {
        assert!(
            std::time::Instant::now() < deadline,
            "condition not reached in time"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn delegation_state(fixture: &Fixture, child: &str) -> String {
    fixture
        .db
        .session_by_id(child)
        .unwrap()
        .unwrap()
        .delegation
        .unwrap()
        .state
}

fn delegation_id(fixture: &Fixture, child: &str) -> String {
    fixture
        .db
        .session_by_id(child)
        .unwrap()
        .unwrap()
        .delegation
        .unwrap()
        .id
}

fn activity_state(fixture: &Fixture, session: &str) -> String {
    fixture
        .db
        .session_by_id(session)
        .unwrap()
        .unwrap()
        .activity
        .unwrap()
        .state
}

fn running_delegate(fixture: &Fixture, parent: &str, token: &str, operation_id: &str) -> String {
    let started = start_delegate(fixture, parent, token, operation_id).unwrap();
    let child = started["sessionId"].as_str().unwrap().to_owned();
    // Running starts when the prompt is recorded; the provider turn id is
    // bound right after the send returns. Later events use that turn.
    wait_for(|| {
        delegation_state(fixture, &child) == "running"
            && fixture
                .db
                .session_by_id(&child)
                .unwrap()
                .unwrap()
                .activity
                .and_then(|activity| activity.turn_id)
                .as_deref()
                == Some("fixture-turn")
    });
    child
}

fn parent_in_turn(fixture: &Fixture, parent: &str) {
    fixture
        .db
        .record_provider_event(
            parent,
            Some("parent-turn"),
            "message.user",
            &json!({"text":"Lead the work"}),
        )
        .unwrap();
}

fn child_approval(fixture: &Fixture, child: &str, approval_id: &str) {
    let payload = json!({
        "approvalId":approval_id,"provider":"grok","requestType":"session/request_permission",
        "title":"Run the tests","details":{},"turnId":"fixture-turn","interaction":"permission","submittable":true,
        "choices":[
            {"choiceId":"once","label":"Allow once","kind":"allow","scope":"once"},
            {"choiceId":"always","label":"Always allow","kind":"allow","scope":"persistent"},
            {"choiceId":"deny","label":"Deny","kind":"deny","scope":"once"}
        ]
    });
    fixture
        .db
        .record_provider_event(
            child,
            Some("fixture-turn"),
            "chat.approval",
            &json!({"approvalId":approval_id,"part":{"type":"approval","approvalId":approval_id,"data":payload}}),
        )
        .unwrap();
}

fn approval_inbox_rows(fixture: &Fixture, session: &str) -> usize {
    fixture
        .db
        .snapshot()
        .unwrap()
        .inbox
        .iter()
        .filter(|item| item["sessionId"] == session && item["kind"] == "approval")
        .count()
}

fn approval_part(fixture: &Fixture, session: &str, approval_id: &str) -> Value {
    fixture
        .db
        .chat_items(session)
        .unwrap()
        .into_iter()
        .flat_map(|item| item.parts)
        .find(|part| part["approvalId"] == approval_id)
        .unwrap()
}

fn status_of(fixture: &Fixture, parent: &str, token: &str) -> Value {
    rpc(
        fixture,
        "delegation.status",
        json!({"callerSessionId":parent,"callerToken":token}),
    )
    .unwrap()
}

#[test]
fn delegation_start_links_the_delegate_connects_it_and_auto_sends_the_prompt() {
    let fixture = Fixture::for_delegation();
    let (parent, token) = delegation_parent(&fixture, "parent-create");
    let started = start_delegate(&fixture, &parent, &token, "start-1").unwrap();
    assert_eq!(started["state"], "starting");
    assert_eq!(started["workspace"], "shared");
    let child = started["sessionId"].as_str().unwrap().to_owned();
    wait_for(|| delegation_state(&fixture, &child) == "running");

    let session = fixture.db.session_by_id(&child).unwrap().unwrap();
    assert_eq!(session.delegation.unwrap().parent_session_id, parent);
    assert_eq!(session.title, "Summarise the README");
    let items = fixture.db.chat_items(&child).unwrap();
    assert_eq!(items[0].role, "user");
    assert_eq!(items[0].parts[0]["text"], "Summarise the README\nthen stop");
    // A retried start with the same operation id is answered from the record.
    let replay = start_delegate(&fixture, &parent, &token, "start-1").unwrap();
    assert_eq!(replay["sessionId"], started["sessionId"]);
    let status = status_of(&fixture, &parent, &token);
    assert_eq!(status["delegates"].as_array().unwrap().len(), 1);
    assert_eq!(status["delegates"][0]["state"], "running");
    assert_eq!(status["availableAgents"], json!(["grok"]));
}

#[test]
fn terminal_host_reports_the_console_host_in_use() {
    // Tests never select a host, so the in-box ConPTY is what portable-pty uses here.
    let fixture = Fixture::for_delegation();
    let host = rpc(&fixture, "terminal.host", json!({})).unwrap();
    assert_eq!(host["conptyHost"], crate::conpty::active().as_str());
    assert_eq!(host["conptyHost"], "system");
    // Whether a pair sits beside the test binary depends on the build folder (tests/pty_lifecycle.rs
    // uses one there); the answer must match what the host loader would find.
    assert_eq!(host["bundledAvailable"], crate::conpty::bundled_available());
}

#[test]
fn delegation_start_attaches_the_users_latest_words_verbatim() {
    let fixture = Fixture::for_delegation();
    let (parent, token) = delegation_parent(&fixture, "parent-create");
    // The correction case: a later message changes an earlier one.
    for (turn, text) in [
        ("turn-1", "Add farewell(name) returning \"Goodbye, <name>!\"."),
        ("turn-2", "Change of plan: return \"Bye, <name>!\" instead."),
        ("turn-3", "Now hand it to a delegate."),
    ] {
        fixture
            .db
            .record_provider_event(&parent, Some(turn), "message.user", &json!({"text":text}))
            .unwrap();
    }
    let prompt = "## Assignment\n- [user] Add farewell(name).";
    let start = |operation_id: &str, count: Option<u32>| {
        let mut params = json!({"callerSessionId":parent,"callerToken":token,"agent":"grok","prompt":prompt,"operationId":operation_id});
        if let Some(count) = count {
            params["userMessages"] = json!(count);
        }
        rpc(&fixture, "delegation.start", params)
    };
    let delegate = |started: Value| {
        let child = started["sessionId"].as_str().unwrap().to_owned();
        wait_for(|| delegation_state(&fixture, &child) == "running");
        let session = fixture.db.session_by_id(&child).unwrap().unwrap();
        let first = fixture.db.chat_items(&child).unwrap()[0].parts[0]["text"]
            .as_str()
            .unwrap()
            .to_owned();
        (session, first)
    };

    let (session, first) = delegate(start("start-three", Some(3)).unwrap());
    let position = |needle: &str| first.find(needle).unwrap_or_else(|| panic!("missing {needle} in {first}"));
    assert!(position("> Add farewell(name) returning \"Goodbye, <name>!\".") < position("> Change of plan"));
    assert!(position("> Change of plan") < position("> Now hand it to a delegate."));
    assert!(position("> Now hand it to a delegate.") < position(prompt));
    assert!(!session.title.contains("User's words"), "the title comes from the agent's prompt");
    let shown = serde_json::to_value(&session).unwrap();
    assert_eq!(shown["delegation"]["userMessages"], 3);

    // By default only the message that started the parent's turn.
    let (session, first) = delegate(start("start-default", None).unwrap());
    assert!(first.contains("> Now hand it to a delegate.") && !first.contains("> Change of plan"));
    assert_eq!(session.delegation.unwrap().user_messages, 1);

    // None: the prompt as written, and nothing extra for the card.
    let (session, first) = delegate(start("start-none", Some(0)).unwrap());
    assert_eq!(first, prompt);
    let shown = serde_json::to_value(&session).unwrap();
    assert!(shown["delegation"].get("userMessages").is_none());

    let over = start("start-over", Some(crate::delegation::MAX_USER_MESSAGES + 1)).unwrap_err();
    assert_eq!(over.code, "invalid_user_messages");
}

#[test]
fn delegation_rejects_wrong_tokens_and_delegates_that_try_to_delegate() {
    let fixture = Fixture::for_delegation();
    let (parent, token) = delegation_parent(&fixture, "parent-create");
    let wrong = start_delegate(&fixture, &parent, "not-the-token", "start-wrong").unwrap_err();
    assert_eq!(wrong.code, "delegation_unauthorized");
    let child = running_delegate(&fixture, &parent, &token, "start-1");
    // Even holding a valid token for itself, a delegate cannot delegate.
    let child_token = fixture.service.delegations.issue_token(&child);
    let nested = start_delegate(&fixture, &child, &child_token, "start-nested").unwrap_err();
    assert_eq!(nested.code, "delegation_nested");
    // A reconnect rotates the token; the old one stops working.
    let rotated = fixture.service.delegations.issue_token(&parent);
    assert!(rpc(
        &fixture,
        "delegation.status",
        json!({"callerSessionId":parent,"callerToken":token})
    )
    .is_err());
    assert!(rpc(
        &fixture,
        "delegation.status",
        json!({"callerSessionId":parent,"callerToken":rotated})
    )
    .is_ok());
}

#[test]
fn delegation_caps_active_delegates_per_parent() {
    let fixture = Fixture::for_delegation();
    let (parent, token) = delegation_parent(&fixture, "parent-create");
    let mut children = Vec::new();
    for index in 0..crate::delegation::MAX_ACTIVE_DELEGATES {
        children.push(running_delegate(&fixture, &parent, &token, &format!("start-{index}")));
    }
    let over = start_delegate(&fixture, &parent, &token, "start-over").unwrap_err();
    assert_eq!(over.code, "delegation_limit_reached");
    // Cancelling asks the provider to stop; the slot is freed only once the
    // stop is observed (F09).
    let first = children[0].clone();
    let id = delegation_id(&fixture, &first);
    let cancelling = rpc(
        &fixture,
        "delegation.cancel",
        json!({"callerSessionId":parent,"callerToken":token,"id":id}),
    )
    .unwrap();
    assert_eq!(cancelling["state"], "cancelling");
    assert_eq!(
        start_delegate(&fixture, &parent, &token, "start-too-early").unwrap_err().code,
        "delegation_limit_reached",
        "a delegate that may still be working keeps its slot",
    );
    fixture
        .db
        .record_provider_event(&first, Some("fixture-turn"), "chat.turn.completed", &json!({"status":"cancelled"}))
        .unwrap();
    assert_eq!(delegation_state(&fixture, &first), "cancelled");
    assert!(start_delegate(&fixture, &parent, &token, "start-after-cancel").is_ok());
}

#[test]
fn a_restart_reconciles_live_delegates_to_interrupted_without_resending() {
    let fixture = Fixture::for_delegation();
    let (parent, token) = delegation_parent(&fixture, "parent-create");
    let mut children = Vec::new();
    for index in 0..crate::delegation::MAX_ACTIVE_DELEGATES {
        children.push(running_delegate(&fixture, &parent, &token, &format!("start-{index}")));
    }
    // The first delegate had answered part of its task before the runtime died.
    fixture
        .db
        .record_provider_event(&children[0], Some("fixture-turn"), "chat.delta", &json!({"text":"Partial: 2 of 5 files"}))
        .unwrap();
    let prompted: Vec<usize> = children.iter().map(|child| fixture.db.chat_items(child).unwrap().len()).collect();
    // Restart: the same two recovery steps the daemon runs before serving.
    fixture.db.mark_live_sessions_interrupted().unwrap();
    let reconciled = crate::delegation::reconcile_interrupted(&fixture.db).unwrap();
    assert_eq!(reconciled, crate::delegation::MAX_ACTIVE_DELEGATES as usize);
    for (index, child) in children.iter().enumerate() {
        assert_eq!(delegation_state(&fixture, child), "interrupted");
        assert_eq!(fixture.db.session_by_id(child).unwrap().unwrap().status, "interrupted");
        // Never auto-resend: the dead delegate keeps exactly what it had.
        assert_eq!(fixture.db.chat_items(child).unwrap().len(), prompted[index]);
    }
    // The partial answer, the folder and worktree info survive as the reason.
    let id = delegation_id(&fixture, &children[0]);
    let result = rpc(
        &fixture,
        "delegation.result",
        json!({"callerSessionId":parent,"callerToken":token,"id":id}),
    )
    .unwrap();
    assert_eq!(result["state"], "interrupted");
    assert!(result["finalAnswer"].as_str().unwrap().contains("Partial: 2 of 5 files"));
    assert_eq!(result["error"], crate::delegation::INTERRUPTED_REASON);
    assert!(result["workspacePath"].as_str().is_some_and(|path| !path.is_empty()));
    // Capacity is free again: new work starts, old links never settle.
    let started = start_delegate(&fixture, &parent, &token, "start-after-restart").unwrap();
    assert_eq!(started["state"], "starting");
    fixture
        .db
        .record_provider_event(&children[0], Some("fixture-turn"), "chat.turn.completed", &json!({"status":"completed"}))
        .unwrap();
    assert_eq!(delegation_state(&fixture, &children[0]), "interrupted");
}

#[test]
fn a_later_turn_in_a_delegate_cannot_settle_its_delegation() {
    let fixture = Fixture::for_delegation();
    let (parent, token) = delegation_parent(&fixture, "parent-create");
    let child = running_delegate(&fixture, &parent, &token, "start-1");
    // The user types into the delegate's Chat: a second, unrelated turn.
    fixture
        .db
        .record_provider_event(&child, Some("later-turn"), "message.user", &json!({"text":"Also do X"}))
        .unwrap();
    fixture
        .db
        .record_provider_event(&child, Some("later-turn"), "chat.turn.completed", &json!({"status":"completed"}))
        .unwrap();
    assert_eq!(delegation_state(&fixture, &child), "running", "the delegated turn is still running");
    // Its own turn still settles the link.
    fixture
        .db
        .record_provider_event(&child, Some("fixture-turn"), "chat.turn.completed", &json!({"status":"completed"}))
        .unwrap();
    assert_eq!(delegation_state(&fixture, &child), "completed");
}

#[test]
fn a_cancel_while_the_first_send_is_in_flight_stops_the_turn_before_the_link_settles() {
    let fixture = Fixture::for_delegation_with_blocked_send();
    let (parent, token) = delegation_parent(&fixture, "parent-create");
    let started = start_delegate(&fixture, &parent, &token, "start-1").unwrap();
    let child = started["sessionId"].as_str().unwrap().to_owned();
    let id = started["delegationId"].clone();
    // The prompt is recorded; the provider call has not returned yet.
    fixture
        .send_started
        .as_ref()
        .unwrap()
        .recv_timeout(Duration::from_secs(10))
        .unwrap();
    assert_eq!(delegation_state(&fixture, &child), "running");
    let service = Arc::clone(&fixture.service);
    let (caller, caller_token) = (parent.clone(), token.clone());
    let cancel = std::thread::spawn(move || {
        rpc_service(
            &service,
            "delegation.cancel",
            json!({"callerSessionId":caller,"callerToken":caller_token,"id":id}),
        )
    });
    // Let the send return: the cancel waited on the start/cancel fence.
    fixture.send_release.as_ref().unwrap().send(()).unwrap();
    let answer = cancel.join().unwrap().unwrap();
    assert_eq!(answer["state"], "cancelling", "a stop is requested, not yet observed");
    assert_eq!(fixture.cancels.load(AtomicOrdering::SeqCst), 1, "the in-flight turn was stopped");
    fixture
        .db
        .record_provider_event(&child, Some("fixture-turn"), "chat.turn.completed", &json!({"status":"cancelled"}))
        .unwrap();
    assert_eq!(delegation_state(&fixture, &child), "cancelled");
}

#[test]
fn a_refused_native_cancel_stays_visible_and_keeps_the_delegates_capacity() {
    let fixture = Fixture::for_delegation();
    let (parent, token) = delegation_parent(&fixture, "parent-create");
    let mut children = Vec::new();
    for index in 0..crate::delegation::MAX_ACTIVE_DELEGATES {
        children.push(running_delegate(&fixture, &parent, &token, &format!("start-{index}")));
    }
    fixture
        .cancel_failures
        .lock()
        .unwrap()
        .push(ProviderError::new("provider_busy", "The provider refused to stop the turn"));
    let id = delegation_id(&fixture, &children[0]);
    let refused = rpc(
        &fixture,
        "delegation.cancel",
        json!({"callerSessionId":parent,"callerToken":token,"id":id}),
    )
    .unwrap();
    assert_eq!(refused["state"], "cancel_failed");
    assert_eq!(delegation_state(&fixture, &children[0]), "cancel_failed");
    // The delegate may still be working: the slot stays taken.
    assert_eq!(
        start_delegate(&fixture, &parent, &token, "start-over").unwrap_err().code,
        "delegation_limit_reached",
    );
    let status = status_of(&fixture, &parent, &token);
    let row = status["delegates"].as_array().unwrap().iter().find(|row| row["delegationId"] == id).unwrap();
    assert_eq!(row["state"], "cancel_failed");
    assert_eq!(row["error"], "The provider refused to stop the turn");
    // When the turn really ends, the link settles.
    fixture
        .db
        .record_provider_event(&children[0], Some("fixture-turn"), "chat.turn.completed", &json!({"status":"cancelled"}))
        .unwrap();
    assert_eq!(delegation_state(&fixture, &children[0]), "cancelled");
}

#[test]
fn delegate_approvals_go_to_an_active_parent_which_answers_without_user_only_choices() {
    let fixture = Fixture::for_delegation();
    let (parent, token) = delegation_parent(&fixture, "parent-create");
    let child = running_delegate(&fixture, &parent, &token, "start-1");
    parent_in_turn(&fixture, &parent);
    child_approval(&fixture, &child, "a1");

    assert_eq!(approval_inbox_rows(&fixture, &child), 0, "the user is not interrupted");
    assert_eq!(activity_state(&fixture, &child), "awaiting_parent");
    assert_eq!(delegation_state(&fixture, &child), "awaiting_parent");
    assert_eq!(
        approval_part(&fixture, &child, "a1")["data"]["delegation"]["route"],
        "parent"
    );
    let status = status_of(&fixture, &parent, &token);
    let request = &status["delegates"][0]["pendingRequests"][0];
    assert_eq!(request["requestId"], "a1");
    let offered: Vec<_> = request["choices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|choice| choice["choiceId"].clone())
        .collect();
    assert_eq!(
        offered,
        vec![json!("once"), json!("deny")],
        "persistent choices stay with the user"
    );

    let id = status["delegates"][0]["delegationId"].clone();
    let respond = |choice: &str, operation: &str| {
        rpc(
            &fixture,
            "delegation.respond",
            json!({"callerSessionId":parent,"callerToken":token,"id":id,"requestId":"a1","choiceId":choice,"operationId":operation}),
        )
    };
    let reserved = respond("always", "respond-always").unwrap_err();
    assert_eq!(reserved.code, "choice_reserved_for_user");
    assert_eq!(respond("once", "respond-once").unwrap()["accepted"], true);
    // The provider then reports the resolution; the delegate runs on.
    fixture
        .db
        .record_provider_event(
            &child,
            Some("fixture-turn"),
            "chat.approval.resolved",
            &json!({"approvalId":"a1","status":"resolved"}),
        )
        .unwrap();
    assert_eq!(activity_state(&fixture, &child), "running");
    assert_eq!(delegation_state(&fixture, &child), "running");
}

#[test]
fn a_parent_turn_ending_escalates_its_delegates_requests_to_the_user() {
    let fixture = Fixture::for_delegation();
    let (parent, token) = delegation_parent(&fixture, "parent-create");
    let child = running_delegate(&fixture, &parent, &token, "start-1");
    parent_in_turn(&fixture, &parent);
    child_approval(&fixture, &child, "a1");
    assert_eq!(approval_inbox_rows(&fixture, &child), 0);

    fixture
        .db
        .record_provider_event(
            &parent,
            Some("parent-turn"),
            "chat.turn.completed",
            &json!({"status":"completed"}),
        )
        .unwrap();
    assert_eq!(
        approval_inbox_rows(&fixture, &child),
        1,
        "escalated as a normal approval"
    );
    assert_eq!(activity_state(&fixture, &child), "awaiting_approval");
    assert_eq!(delegation_state(&fixture, &child), "awaiting_user");
    let part = approval_part(&fixture, &child, "a1");
    assert_eq!(part["status"], "pending");
    assert_eq!(part["data"]["delegation"]["route"], "user");
    assert_eq!(part["data"]["delegation"]["escalated"], true);
    // Escalation is one-way: the parent can no longer answer.
    let id = fixture
        .db
        .session_by_id(&child)
        .unwrap()
        .unwrap()
        .delegation
        .unwrap()
        .id;
    let late = rpc(
        &fixture,
        "delegation.respond",
        json!({"callerSessionId":parent,"callerToken":token,"id":id,"requestId":"a1","choiceId":"once","operationId":"respond-late"}),
    )
    .unwrap_err();
    assert_eq!(late.code, "delegation_not_awaiting_parent");
}

#[test]
fn delegate_requests_go_straight_to_the_user_while_the_parent_is_idle() {
    let fixture = Fixture::for_delegation();
    let (parent, token) = delegation_parent(&fixture, "parent-create");
    let child = running_delegate(&fixture, &parent, &token, "start-1");
    child_approval(&fixture, &child, "a1");
    assert_eq!(approval_inbox_rows(&fixture, &child), 1);
    assert_eq!(activity_state(&fixture, &child), "awaiting_approval");
    assert_eq!(delegation_state(&fixture, &child), "awaiting_user");
}

#[test]
fn a_stopped_parent_escalates_and_a_stopped_delegate_is_cancelled() {
    let fixture = Fixture::for_delegation();
    let (parent, token) = delegation_parent(&fixture, "parent-create");
    let child = running_delegate(&fixture, &parent, &token, "start-1");
    let other = running_delegate(&fixture, &parent, &token, "start-2");
    parent_in_turn(&fixture, &parent);
    child_approval(&fixture, &child, "a1");
    rpc(
        &fixture,
        "session.stop",
        json!({"sessionId":parent,"operationId":"stop-parent"}),
    )
    .unwrap();
    assert_eq!(approval_inbox_rows(&fixture, &child), 1);
    assert_eq!(delegation_state(&fixture, &child), "awaiting_user");
    rpc(
        &fixture,
        "session.stop",
        json!({"sessionId":other,"operationId":"stop-delegate"}),
    )
    .unwrap();
    assert_eq!(delegation_state(&fixture, &other), "cancelled");
}

#[test]
fn the_delegated_turn_result_is_recorded_once_and_later_turns_do_not_change_it() {
    let fixture = Fixture::for_delegation();
    let (parent, token) = delegation_parent(&fixture, "parent-create");
    let child = running_delegate(&fixture, &parent, &token, "start-1");
    fixture
        .db
        .record_provider_event(
            &child,
            Some("fixture-turn"),
            "chat.item",
            &json!({"raw":{"params":{"item":{"id":"answer","type":"agentMessage","text":"The README explains setup."}}}}),
        )
        .unwrap();
    fixture
        .db
        .record_provider_event(
            &child,
            Some("fixture-turn"),
            "chat.turn.completed",
            &json!({"status":"completed"}),
        )
        .unwrap();
    assert_eq!(delegation_state(&fixture, &child), "completed");
    // The user keeps chatting with the delegate; the delegation stays final.
    fixture
        .db
        .record_provider_event(
            &child,
            Some("later"),
            "chat.error",
            &json!({"message":"later failure"}),
        )
        .unwrap();
    assert_eq!(delegation_state(&fixture, &child), "completed");
    let id = fixture
        .db
        .session_by_id(&child)
        .unwrap()
        .unwrap()
        .delegation
        .unwrap()
        .id;
    let result = rpc(
        &fixture,
        "delegation.result",
        json!({"callerSessionId":parent,"callerToken":token,"id":id}),
    )
    .unwrap();
    assert_eq!(result["state"], "completed");
    assert_eq!(result["finalAnswer"], "The README explains setup.");
    assert!(result["error"].is_null());
    // Another parent cannot read it.
    let (stranger, stranger_token) = delegation_parent(&fixture, "stranger-create");
    let denied = rpc(
        &fixture,
        "delegation.result",
        json!({"callerSessionId":stranger,"callerToken":stranger_token,"id":id}),
    )
    .unwrap_err();
    assert_eq!(denied.code, "delegation_not_found");
}

#[test]
fn delegated_failures_and_cancellations_are_final_states() {
    let fixture = Fixture::for_delegation();
    let (parent, token) = delegation_parent(&fixture, "parent-create");
    let failed = running_delegate(&fixture, &parent, &token, "start-1");
    fixture
        .db
        .record_provider_event(
            &failed,
            Some("fixture-turn"),
            "chat.turn.completed",
            &json!({"status":"failed","message":"model error"}),
        )
        .unwrap();
    assert_eq!(delegation_state(&fixture, &failed), "failed");
    let cancelled = running_delegate(&fixture, &parent, &token, "start-2");
    fixture
        .db
        .record_provider_event(
            &cancelled,
            Some("fixture-turn"),
            "chat.turn.completed",
            &json!({"status":"interrupted"}),
        )
        .unwrap();
    assert_eq!(delegation_state(&fixture, &cancelled), "cancelled");
}

fn git(cwd: &std::path::Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(["-c", "user.name=ThreadTerm QA", "-c", "user.email=qa@threadterm.invalid"])
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

#[test]
fn a_worktree_delegate_gets_its_own_branch_from_the_parents_commit_in_a_sibling_folder() {
    let fixture = Fixture::for_delegation();
    crate::workspace_services::initialize(&fixture.db).unwrap();
    crate::project_catalog::initialize(&fixture.db).unwrap();
    crate::review::initialize(&fixture.db).unwrap();
    let repo = fixture.root.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::write(repo.join("README.md"), "fixture\n").unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "fixture"]);
    let head = git(&repo, &["rev-parse", "HEAD"]);
    // Uncommitted parent work is not part of the delegate's branch.
    std::fs::write(repo.join("draft.txt"), "uncommitted\n").unwrap();
    let project = rpc(
        &fixture,
        "project.add",
        json!({"path":repo,"operationId":"project-add"}),
    )
    .unwrap();
    let parent = rpc(
        &fixture,
        "session.create",
        json!({"projectId":project["id"],"cwd":repo,"provider":"grok","mode":"chat","operationId":"parent-create"}),
    )
    .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let token = fixture.service.delegations.issue_token(&parent);
    let started = rpc(
        &fixture,
        "delegation.start",
        json!({"callerSessionId":parent,"callerToken":token,"agent":"grok","prompt":"Work on your own branch","workspace":"worktree","operationId":"start-worktree"}),
    )
    .unwrap();
    let path = started["workspacePath"].as_str().unwrap().to_owned();
    assert!(!path.starts_with(r"\\?\"), "git and the agent get a plain path: {path}");
    let branch = started["branch"].as_str().unwrap().to_owned();
    assert!(branch.starts_with("threadterm/delegate-grok-"), "{branch}");
    let folder = std::path::Path::new(&path);
    assert_eq!(folder.parent().unwrap().file_name().unwrap(), "repo.delegates");
    assert_eq!(git(folder, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(folder, &["branch", "--show-current"]), branch);
    assert!(!folder.join("draft.txt").exists());
    // The parent's own branch and folder are untouched.
    assert_ne!(git(&repo, &["branch", "--show-current"]), branch);
    let child = started["sessionId"].as_str().unwrap().to_owned();
    wait_for(|| delegation_state(&fixture, &child) == "running");
    let link = fixture.db.session_by_id(&child).unwrap().unwrap().delegation.unwrap();
    assert_eq!(link.workspace, "worktree");
    assert_eq!(link.branch.as_deref(), Some(branch.as_str()));
    let config = crate::session_configs::read(&fixture.db, &child).unwrap().unwrap();
    assert_eq!(config.launch.cwd, path);
}

#[test]
fn only_top_level_chats_of_verified_parents_get_the_delegation_tool_server() {
    let fixture = Fixture::for_delegation();
    let (parent, token) = delegation_parent(&fixture, "parent-create");
    let child = running_delegate(&fixture, &parent, &token, "start-1");
    let executable = fixture.root.path().join("threadterm-v3-mcp.exe");
    std::fs::write(&executable, b"").unwrap();
    let delegations = Arc::new(crate::delegation::Delegations::default());
    let resolve = crate::delegation::tool_server_resolver(
        Arc::clone(&fixture.db),
        Arc::clone(&delegations),
        fixture.service.config.clone(),
        Some(executable.clone()),
    );
    let server = resolve(&parent, "grok").expect("a top-level grok Chat gets the server");
    assert_eq!(server.name, "threadterm");
    assert_eq!(server.command, executable.to_string_lossy());
    let env: std::collections::HashMap<_, _> = server.env.iter().cloned().collect();
    assert_eq!(env["THREADTERM_MCP_PROFILE"], "delegation");
    assert_eq!(env["THREADTERM_SESSION_ID"], parent);
    assert!(delegations
        .authorize(&fixture.db, &parent, &env["THREADTERM_SESSION_TOKEN"])
        .is_ok());
    assert!(
        resolve(&child, "grok").is_none(),
        "delegates never get delegation tools"
    );
    assert!(
        resolve(&parent, "opencode").is_none(),
        "unverified agents are not parents"
    );
    let missing = crate::delegation::tool_server_resolver(
        Arc::clone(&fixture.db),
        delegations,
        fixture.service.config.clone(),
        None,
    );
    assert!(missing(&parent, "grok").is_none(), "no MCP host binary, no server");
}
