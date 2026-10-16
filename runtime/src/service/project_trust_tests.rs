use super::*;
use crate::providers::{
    ChatSession, ProviderAdapter, ProviderCapability, ProviderError, TerminalCommand,
};
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicUsize, Ordering as AtomicOrdering},
        Arc, Mutex,
    },
};

#[derive(Default)]
struct TrustLog {
    opens: Vec<(String, Option<String>)>,
    stops: Vec<String>,
    busy: HashSet<String>,
    fail_next_open: HashSet<String>,
}

struct TrustAdapter {
    log: Arc<Mutex<TrustLog>>,
    opens: Arc<AtomicUsize>,
}

impl ProviderAdapter for TrustAdapter {
    fn id(&self) -> &str { "pi" }

    fn capability(&self) -> ProviderCapability {
        ProviderCapability {
            source: "test", plugin_id: None, icon: None, sign_in: None, homepage: None,
            id: "pi".into(), name: "Pi trust fixture".into(), installed: true,
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
        self.open(session_id, None)
    }

    fn open_chat_with_project_trust(
        &self,
        session_id: &str,
        _: &str,
        _: Option<&str>,
        _: &str,
        _: Option<&crate::providers::ChatToolServer>,
        decision: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        self.open(session_id, decision.map(str::to_owned))
    }
}

impl TrustAdapter {
    fn open(&self, session_id: &str, decision: Option<String>) -> Result<Box<dyn ChatSession>, ProviderError> {
        let mut log = self.log.lock().unwrap();
        log.opens.push((session_id.to_owned(), decision));
        self.opens.fetch_add(1, AtomicOrdering::SeqCst);
        if log.fail_next_open.remove(session_id) {
            return Err(ProviderError::new("fixture_reconnect_failed", "fixture reconnect failed"));
        }
        Ok(Box::new(TrustChat {
            session_id: session_id.to_owned(),
            log: Arc::clone(&self.log),
            retired: Arc::new(AtomicBool::new(false)),
        }))
    }
}

struct TrustChat {
    session_id: String,
    log: Arc<Mutex<TrustLog>>,
    retired: Arc<AtomicBool>,
}

impl ChatSession for TrustChat {
    fn native_id(&self) -> Option<String> { Some(format!("pi-fixture-{}", self.session_id)) }
    fn send(&mut self, _: &str, _: &str) -> Result<Value, ProviderError> {
        if self.retired.load(AtomicOrdering::SeqCst) {
            return Err(ProviderError::new("provider_disconnected", "fixture worker was retired"));
        }
        Ok(json!({"turnId":"fixture-turn"}))
    }
    fn cancel(&mut self, _: &str) -> Result<(), ProviderError> { Ok(()) }
    fn approve(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ProviderError> { Ok(()) }

    fn validate_restart(&self) -> Result<(), ProviderError> {
        if self.log.lock().unwrap().busy.contains(&self.session_id) {
            return Err(ProviderError::new("turn_in_progress", "fixture turn is active"));
        }
        Ok(())
    }

    fn stop(&mut self) -> Result<(), ProviderError> {
        self.retired.store(true, AtomicOrdering::SeqCst);
        self.log.lock().unwrap().stops.push(self.session_id.clone());
        Ok(())
    }
}

struct Fixture {
    root: tempfile::TempDir,
    db: Arc<Database>,
    log: Arc<Mutex<TrustLog>>,
    opens: Arc<AtomicUsize>,
    service: RuntimeService,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        crate::retry_scheduler::initialize(&db).unwrap();
        crate::chat_queue::initialize(&db).unwrap();
        let log = Arc::new(Mutex::new(TrustLog::default()));
        let opens = Arc::new(AtomicUsize::new(0));
        let service = Self::service(root.path(), Arc::clone(&db), Arc::clone(&log), Arc::clone(&opens));
        Self { root, db, log, opens, service }
    }

    fn service(root: &std::path::Path, db: Arc<Database>, log: Arc<Mutex<TrustLog>>, opens: Arc<AtomicUsize>) -> RuntimeService {
        let providers = Arc::new(Providers::for_test(vec![Arc::new(TrustAdapter { log, opens })]));
        let trust_db = Arc::downgrade(&db);
        providers.set_project_trust_resolver(Arc::new(move |session_id, provider| {
            if provider != "pi" { return Ok(None); }
            let db = trust_db.upgrade().ok_or_else(|| ProviderError::new("runtime_stopped", "Runtime stopped"))?;
            let session = db.session_by_id(session_id)
                .map_err(|error| ProviderError::new("chat_persistence", error.to_string()))?
                .ok_or_else(|| ProviderError::new("session_not_found", "Session not found"))?;
            session.project_id.as_deref().map(|project_id| crate::pi_project_trust::read(&db, project_id))
                .transpose().map(Option::flatten)
                .map_err(|error| ProviderError::new("chat_persistence", error.to_string()))
        }));
        let output = Arc::new(OutputStore::default());
        RuntimeService {
            previews: Arc::new(crate::preview::Previews::new(Arc::clone(&db)).unwrap()),
            browser_tools: RuntimeService::browser_test_tools(&db),
            shutdown_changed: tokio::sync::Notify::new(),
            config: RuntimeConfig { data_dir: root.to_owned(), database_path: root.join("runtime.sqlite"), credential_path: root.join("credential"), pipe_base: r"\\.\pipe\threadterm-v3-project-trust-test".into() },
            db, leases: LeaseManager::default(), output: Arc::clone(&output), providers,
            pty: Arc::new(PtyManager::new(output)), deferred_launch: Arc::new(Mutex::new(DeferredLaunchGate::default())),
            shutdown_requested: AtomicBool::new(false), shutdown_pending: AtomicBool::new(false),
            relocation_gate: RwLock::new(()), retry_gate: Mutex::new(()), settings_apply_gate: Mutex::new(()), plugin_gate: Mutex::new(()),
            remote: OnceLock::new(), delegations: Arc::new(crate::delegation::Delegations::default()), chat_queues: Arc::new(crate::chat_queue::ChatQueues::default()),
        }
    }

    fn project(&self, operation: &str) -> String {
        let path = self.root.path().join(operation);
        std::fs::create_dir_all(&path).unwrap();
        self.db.add_project(path.to_str().unwrap(), None, operation).unwrap().id
    }

    fn chat(&self, project_id: &str, operation: &str) -> (String, i64) {
        let session = self.db.create_session(CreateSession { project_id: Some(project_id), title: None, provider: "pi", mode: "chat", native_id: None, operation_id: operation }).unwrap();
        self.db.bind_session(&session.id, Some(self.root.path().to_str().unwrap()), None).unwrap();
        crate::session_configs::save_new(&self.db, &session.id, &crate::session_configs::LaunchSpec { provider: "pi".into(), mode: "chat".into(), cwd: self.root.path().to_str().unwrap().into(), project_id: Some(project_id.into()), title: None, executable: None, args: Vec::new() }, None).unwrap();
        connect_chat_session(&self.db, &self.service.providers, &session.id).unwrap();
        let lease = self.service.leases.claim(&self.db, &session.id, "desktop").unwrap();
        (session.id, lease)
    }

    fn set(&self, session_id: &str, lease: i64, decision: &str, operation: &str) -> anyhow::Result<Value> {
        self.service.set_pi_project_trust("desktop", &json!({"sessionId":session_id,"decision":decision,"leaseEpoch":lease,"operationId":operation}))
    }
}

#[test]
fn project_revoke_refuses_a_busy_peer_without_changing_durable_trust_or_stopping_workers() {
    let fixture = Fixture::new();
    let project = fixture.project("project-busy");
    let (selected, lease) = fixture.chat(&project, "selected-busy");
    let (peer, _) = fixture.chat(&project, "peer-busy");
    crate::pi_project_trust::set(&fixture.db, &project, "trusted").unwrap();
    fixture.log.lock().unwrap().busy.insert(peer);

    let error = fixture.set(&selected, lease, "none", "revoke-busy").unwrap_err();
    assert_eq!(error.downcast_ref::<ProviderError>().unwrap().code, "turn_in_progress");
    assert_eq!(crate::pi_project_trust::read(&fixture.db, &project).unwrap().as_deref(), Some("trusted"));
    assert!(fixture.log.lock().unwrap().stops.is_empty());
}

#[test]
fn idle_revoke_restarts_every_project_peer_but_grant_restarts_only_the_selected_chat() {
    let fixture = Fixture::new();
    let project = fixture.project("project-idle");
    let other_project = fixture.project("project-unrelated");
    let (selected, lease) = fixture.chat(&project, "selected-idle");
    let (peer, _) = fixture.chat(&project, "peer-idle");
    let (unrelated, _) = fixture.chat(&other_project, "unrelated-idle");
    crate::pi_project_trust::set(&fixture.db, &project, "trusted").unwrap();
    let opens_before_revoke = fixture.log.lock().unwrap().opens.len();

    fixture.set(&selected, lease, "none", "revoke-idle").unwrap();
    let log = fixture.log.lock().unwrap();
    assert_eq!(log.stops.len(), 2);
    assert!(log.stops.contains(&selected));
    assert!(log.stops.contains(&peer));
    assert!(!log.stops.contains(&unrelated));
    assert_eq!(crate::pi_project_trust::read(&fixture.db, &project).unwrap(), None);
    let revoke_opens = &log.opens[opens_before_revoke..];
    assert_eq!(revoke_opens.len(), 2);
    assert!(revoke_opens.iter().all(|(id, decision)| (id == &selected || id == &peer) && decision.is_none()));
    drop(log);

    let opens_before_grant = fixture.log.lock().unwrap().opens.len();
    fixture.set(&selected, lease, "trusted", "grant-selected").unwrap();
    let log = fixture.log.lock().unwrap();
    assert_eq!(log.stops.iter().filter(|id| *id == &selected).count(), 2);
    assert_eq!(log.stops.iter().filter(|id| *id == &peer).count(), 1);
    assert_eq!(crate::pi_project_trust::read(&fixture.db, &project).unwrap().as_deref(), Some("trusted"));
    assert_eq!(&log.opens[opens_before_grant..], &[(selected.clone(), Some("trusted".into()))]);
}

#[test]
fn failed_reconnect_retries_from_the_saved_route_after_runtime_recreation_and_keeps_lease_fencing() {
    let fixture = Fixture::new();
    let project = fixture.project("project-retry");
    let (selected, lease) = fixture.chat(&project, "selected-retry");
    let (peer, _) = fixture.chat(&project, "peer-retry");
    fixture.log.lock().unwrap().fail_next_open.insert(selected.clone());

    let first = fixture.set(&selected, lease, "declined", "reconnect-retry").unwrap_err();
    assert_eq!(first.downcast_ref::<ProviderError>().unwrap().code, "native_resume_failed");
    assert!(first.to_string().contains("fixture reconnect failed"));
    assert_eq!(crate::pi_project_trust::read(&fixture.db, &project).unwrap().as_deref(), Some("declined"));

    let recreated = Fixture::service(fixture.root.path(), Arc::clone(&fixture.db), Arc::clone(&fixture.log), Arc::clone(&fixture.opens));
    let recovered = recreated.set_pi_project_trust("desktop", &json!({"sessionId":selected,"decision":"declined","leaseEpoch":lease,"operationId":"reconnect-retry"})).unwrap();
    assert_eq!(recovered["loadState"], "empty");
    assert_eq!(recreated.providers.chat_connection(&selected)["phase"], "ready");
    assert_eq!(recreated.providers.chat_connection(&peer)["phase"], "ready");
    assert!(fixture.db.operation("reconnect-retry").unwrap().is_some());
    let log = fixture.log.lock().unwrap();
    assert!(log.opens.iter().any(|(id, decision)| id == &selected && decision.as_deref() == Some("declined")));
    assert!(log.opens.iter().any(|(id, decision)| id == &peer && decision.as_deref() == Some("declined")));
    drop(log);
    let stale = recreated.set_pi_project_trust("desktop", &json!({"sessionId":selected,"decision":"declined","leaseEpoch":lease + 1,"operationId":"reconnect-retry"})).unwrap_err();
    assert!(stale.to_string().contains("stale_lease"));
}
