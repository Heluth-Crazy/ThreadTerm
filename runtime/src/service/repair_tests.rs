use super::*;
use crate::{
    db::CreateSession,
    domain::ChatItem,
    providers::{ChatSession, ProviderAdapter, ProviderCapability, ProviderError, TerminalCommand},
};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const PRINCIPAL: &str = "desktop";

struct ReadGate {
    entered: SyncSender<()>,
    release: Mutex<Receiver<()>>,
}

struct RepairAdapter {
    history: Mutex<Result<Value, ProviderError>>,
    gate: Option<ReadGate>,
    reads: Arc<AtomicUsize>,
    forbidden: Arc<AtomicUsize>,
}

impl ProviderAdapter for RepairAdapter {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn capability(&self) -> ProviderCapability {
        ProviderCapability {
            source: "test",
            plugin_id: None,
            icon: None,
            sign_in: None,
            homepage: None,
            id: "codex".into(),
            name: "Repair fixture".into(),
            installed: true,
            version: None,
            terminal: false,
            chat: true,
            history: true,
            resume: false,
            terminal_resume_capture: "none",
            reason: None,
            auth: "authenticated".into(),
        }
    }

    fn terminal_command(
        &self,
        _: Option<&str>,
        _: Option<&str>,
    ) -> Result<TerminalCommand, ProviderError> {
        Err(ProviderError::new(
            "unsupported",
            "repair fixture is chat-only",
        ))
    }

    fn history_list(
        &self,
        _: Option<&str>,
        _: u32,
        _: Option<&str>,
    ) -> Result<Value, ProviderError> {
        Ok(json!({"items":[]}))
    }

    fn history_read(&self, _: &str) -> Result<Value, ProviderError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.gate {
            gate.entered.send(()).unwrap();
            gate.release.lock().unwrap().recv().unwrap();
        }
        self.history.lock().unwrap().clone()
    }

    fn open_chat(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        self.forbidden.fetch_add(1, Ordering::SeqCst);
        panic!("repair must not open a Chat worker")
    }
}

struct Fixture {
    _root: tempfile::TempDir,
    service: Arc<RuntimeService>,
    db: Arc<Database>,
    reads: Arc<AtomicUsize>,
    forbidden: Arc<AtomicUsize>,
    entered: Option<Receiver<()>>,
    release: Option<SyncSender<()>>,
}

impl Fixture {
    fn new(history: Result<Value, ProviderError>, slow: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("repair.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        crate::retry_scheduler::initialize(&db).unwrap();
        crate::chat_queue::initialize(&db).unwrap();
        let reads = Arc::new(AtomicUsize::new(0));
        let forbidden = Arc::new(AtomicUsize::new(0));
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let adapter = Arc::new(RepairAdapter {
            history: Mutex::new(history),
            gate: slow.then_some(ReadGate {
                entered: entered_tx,
                release: Mutex::new(release_rx),
            }),
            reads: Arc::clone(&reads),
            forbidden: Arc::clone(&forbidden),
        });
        let output = Arc::new(OutputStore::default());
        let service = Arc::new(RuntimeService {
            previews: Arc::new(crate::preview::Previews::new(Arc::clone(&db)).unwrap()),
            config: RuntimeConfig {
                data_dir: root.path().to_owned(),
                database_path: root.path().join("repair.sqlite"),
                credential_path: root.path().join("credential"),
                pipe_base: r"\\.\pipe\threadterm-v3-repair-test".into(),
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
            _root: root,
            service,
            db,
            reads,
            forbidden,
            entered: slow.then_some(entered_rx),
            release: slow.then_some(release_tx),
        }
    }

    fn session(&self) -> (String, i64) {
        let session = self
            .db
            .create_session(CreateSession {
                project_id: None,
                title: Some("repair"),
                provider: "codex",
                mode: "chat",
                native_id: Some("native-thread"),
                operation_id: "repair-create",
            })
            .unwrap();
        self.db
            .transaction(|tx| {
                tx.execute(
                    "UPDATE sessions SET status='error' WHERE id=?",
                    [&session.id],
                )?;
                tx.execute(
                    "INSERT INTO leases(session_id,client_id,epoch,expires_at) VALUES (?, ?, 1, ?)",
                    rusqlite::params![
                        session.id,
                        PRINCIPAL,
                        (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339()
                    ],
                )?;
                Ok(())
            })
            .unwrap();
        self.db
            .mark_chat_degraded(Some(&session.id), "fixture projection failed")
            .unwrap();
        (session.id, 1)
    }

    fn repair(&self, session_id: &str, lease_epoch: i64, operation_id: &str) -> Result<Value> {
        self.service.repair_chat_history(
            PRINCIPAL,
            &ChatRepair {
                session_id: session_id.into(),
                lease_epoch,
                operation_id: operation_id.into(),
            },
        )
    }
}

fn item(id: &str, role: &str, text: &str) -> Value {
    json!({"id":id,"role":role,"parts":[{"type":"text","text":text}],"createdAt":"2026-10-08T00:00:00Z"})
}

#[test]
fn repair_reads_native_history_once_and_replays_the_completed_receipt() {
    let fixture = Fixture::new(
        Ok(json!([
            item("u1", "user", "repeat"),
            item("a1", "assistant", "answer")
        ])),
        false,
    );
    let (session, epoch) = fixture.session();
    let first = fixture.repair(&session, epoch, "repair-once").unwrap();
    let replay = fixture.repair(&session, epoch, "repair-once").unwrap();
    assert_eq!(first, replay);
    assert_eq!(fixture.reads.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture.forbidden.load(Ordering::SeqCst),
        0,
        "repair only calls history_read"
    );
    assert_eq!(first["mode"], "rebuild");
    assert_eq!(first["total"], 2);
    let snapshot = fixture.db.chat_items(&session).unwrap();
    assert_eq!(
        snapshot
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        [
            format!("{session}:history:u1"),
            format!("{session}:history:a1")
        ]
    );
}

#[test]
fn repair_rejects_operation_identity_conflicts_before_native_read() {
    let fixture = Fixture::new(Ok(json!([item("a1", "assistant", "answer")])), false);
    let (session, epoch) = fixture.session();
    fixture
        .db
        .bind_operation("conflict", "chat.repair", &json!({"sessionId":"another"}))
        .unwrap();
    let error = fixture.repair(&session, epoch, "conflict").unwrap_err();
    assert!(error.to_string().contains("operation_conflict"));
    assert_eq!(fixture.reads.load(Ordering::SeqCst), 0);
}

#[test]
fn failed_history_read_can_retry_with_the_same_operation() {
    let fixture = Fixture::new(
        Err(ProviderError::new("fixture_read_failed", "read failed")),
        false,
    );
    let (session, epoch) = fixture.session();
    assert!(fixture.repair(&session, epoch, "retry").is_err());
    assert!(fixture.db.operation("retry").unwrap().is_none());
    assert_eq!(fixture.reads.load(Ordering::SeqCst), 1);
    assert!(fixture.repair(&session, epoch, "retry").is_err());
    assert_eq!(fixture.reads.load(Ordering::SeqCst), 2);
}

#[test]
fn concurrent_same_operation_waits_for_one_native_read_then_replays_the_receipt() {
    let fixture = Fixture::new(Ok(json!([item("a1", "assistant", "answer")])), true);
    let (session, epoch) = fixture.session();
    let first_service = Arc::clone(&fixture.service);
    let first_session = session.clone();
    let first = thread::spawn(move || {
        first_service.repair_chat_history(
            PRINCIPAL,
            &ChatRepair {
                session_id: first_session,
                lease_epoch: epoch,
                operation_id: "same-operation".into(),
            },
        )
    });
    fixture
        .entered
        .as_ref()
        .unwrap()
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    let flight =
        repair_operation_lock(&fixture.service.config.database_path, "same-operation").unwrap();
    assert_eq!(
        Arc::strong_count(&flight),
        2,
        "reader and test observer own the flight"
    );
    let second_service = Arc::clone(&fixture.service);
    let second_session = session.clone();
    let second = thread::spawn(move || {
        second_service.repair_chat_history(
            PRINCIPAL,
            &ChatRepair {
                session_id: second_session,
                lease_epoch: epoch,
                operation_id: "same-operation".into(),
            },
        )
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    while Arc::strong_count(&flight) < 3 {
        assert!(
            Instant::now() < deadline,
            "second repair never joined the operation flight"
        );
        thread::yield_now();
    }
    drop(flight);
    fixture.release.as_ref().unwrap().send(()).unwrap();
    let first = first.join().unwrap().unwrap();
    let second = second.join().unwrap().unwrap();
    assert_eq!(first, second);
    assert_eq!(fixture.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn waiting_same_operation_rechecks_a_taken_over_lease_without_a_second_native_read() {
    let fixture = Fixture::new(Ok(json!([item("a1", "assistant", "answer")])), true);
    let (session, epoch) = fixture.session();
    let first_service = Arc::clone(&fixture.service);
    let first_session = session.clone();
    let first = thread::spawn(move || {
        first_service.repair_chat_history(
            PRINCIPAL,
            &ChatRepair {
                session_id: first_session,
                lease_epoch: epoch,
                operation_id: "waiting-takeover".into(),
            },
        )
    });
    fixture
        .entered
        .as_ref()
        .unwrap()
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    let flight =
        repair_operation_lock(&fixture.service.config.database_path, "waiting-takeover").unwrap();
    let second_service = Arc::clone(&fixture.service);
    let second_session = session.clone();
    let second = thread::spawn(move || {
        second_service.repair_chat_history(
            PRINCIPAL,
            &ChatRepair {
                session_id: second_session,
                lease_epoch: epoch,
                operation_id: "waiting-takeover".into(),
            },
        )
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    while Arc::strong_count(&flight) < 3 {
        assert!(
            Instant::now() < deadline,
            "second repair never joined the operation flight"
        );
        thread::yield_now();
    }
    fixture
        .db
        .transaction(|tx| {
            tx.execute(
                "UPDATE leases SET client_id='other',epoch=2 WHERE session_id=?",
                [&session],
            )?;
            Ok(())
        })
        .unwrap();
    drop(flight);
    fixture.release.as_ref().unwrap().send(()).unwrap();
    assert!(first
        .join()
        .unwrap()
        .unwrap_err()
        .to_string()
        .contains("chat_repair_superseded"));
    let waiting = second.join().unwrap().unwrap_err();
    assert!(
        waiting.to_string().contains("stale_lease") || waiting.to_string().contains("lease_held")
    );
    assert_eq!(fixture.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn slow_history_read_does_not_hold_the_database_and_a_racing_transcript_supersedes_repair() {
    let fixture = Fixture::new(Ok(json!([item("a1", "assistant", "answer")])), true);
    let (session, epoch) = fixture.session();
    let service = Arc::clone(&fixture.service);
    let race_session = session.clone();
    let repair = thread::spawn(move || {
        service.repair_chat_history(
            PRINCIPAL,
            &ChatRepair {
                session_id: race_session,
                lease_epoch: epoch,
                operation_id: "race".into(),
            },
        )
    });
    fixture
        .entered
        .as_ref()
        .unwrap()
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    fixture.db.transaction(|tx| {
        let live: ChatItem = serde_json::from_value(item("live", "user", "concurrent")).unwrap();
        tx.execute("INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES (?, ?, NULL, 'message', ?, ?)", rusqlite::params![format!("{session}:user:live"), session, serde_json::to_string(&live)?, chrono::Utc::now().to_rfc3339()])?;
        Ok(())
    }).unwrap();
    fixture.release.as_ref().unwrap().send(()).unwrap();
    let error = repair.join().unwrap().unwrap_err();
    assert!(error.to_string().contains("chat_repair_superseded"));
    assert_eq!(fixture.db.chat_items(&session).unwrap().len(), 1);
}

#[test]
fn lease_takeover_during_native_read_supersedes_without_replacing_the_transcript() {
    let fixture = Fixture::new(Ok(json!([item("a1", "assistant", "answer")])), true);
    let (session, epoch) = fixture.session();
    let service = Arc::clone(&fixture.service);
    let repair_session = session.clone();
    let repair = thread::spawn(move || {
        service.repair_chat_history(
            PRINCIPAL,
            &ChatRepair {
                session_id: repair_session,
                lease_epoch: epoch,
                operation_id: "takeover".into(),
            },
        )
    });
    fixture
        .entered
        .as_ref()
        .unwrap()
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    fixture
        .db
        .transaction(|tx| {
            tx.execute(
                "UPDATE leases SET client_id='other',epoch=2 WHERE session_id=?",
                [&session],
            )?;
            Ok(())
        })
        .unwrap();
    fixture.release.as_ref().unwrap().send(()).unwrap();
    let error = repair.join().unwrap().unwrap_err();
    assert!(error.to_string().contains("chat_repair_superseded"));
    assert!(fixture.db.chat_items(&session).unwrap().is_empty());
    assert_eq!(fixture.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn snapshot_advertises_repair_without_probing_the_native_provider() {
    let mut fixture = Fixture::new(Ok(json!([])), false);
    let (session, _) = fixture.session();
    let snapshot = fixture
        .service
        .dispatch(
            PRINCIPAL,
            RpcRequest {
                v: 1,
                id: "snapshot".into(),
                method: "chat.snapshot".into(),
                params: json!({"sessionId":session}),
            },
        )
        .unwrap();
    assert_eq!(snapshot["repair"]["offered"], true);
    assert_eq!(snapshot["repair"]["mode"], "rebuild");
    assert_eq!(fixture.reads.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.forbidden.load(Ordering::SeqCst), 0);
    fixture.service.chat_queues.projection_failed(&fixture.db);
    let snapshot = fixture.service.dispatch(PRINCIPAL, RpcRequest {
        v: 1, id: "snapshot-fenced".into(), method: "chat.snapshot".into(), params: json!({"sessionId":session}),
    }).unwrap();
    assert_eq!(snapshot["repair"]["ingressFailed"], true, "a reopened view sees the current runtime fence");
    Arc::get_mut(&mut fixture.service).unwrap().chat_queues = Arc::new(crate::chat_queue::ChatQueues::default());
    let restarted = fixture.service.dispatch(PRINCIPAL, RpcRequest {
        v: 1, id: "snapshot-restarted".into(), method: "chat.snapshot".into(), params: json!({"sessionId":session}),
    }).unwrap();
    assert_eq!(restarted["repair"]["degraded"], true, "integrity survives restart independently");
    assert!(restarted["repair"].get("ingressFailed").is_none(), "a restarted runtime has no permanent fence");
    assert_eq!(fixture.reads.load(Ordering::SeqCst), 0);
}
