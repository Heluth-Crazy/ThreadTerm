use super::*;
use crate::{
    db::CreateSession,
    domain::{ChatItem, NativeTurnStatus},
    session_configs::LaunchSpec,
};
use chrono::{Duration, Utc};

struct Fixture {
    root: tempfile::TempDir,
    db: Arc<Database>,
    service: RuntimeService,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        crate::session_configs::initialize(&db).unwrap();
        let service = RuntimeService::new(
            RuntimeConfig {
                data_dir: root.path().to_owned(),
                database_path: root.path().join("runtime.sqlite"),
                credential_path: root.path().join("credential"),
                pipe_base: r"\\.\pipe\threadterm-v3-fork-test".into(),
            },
            Arc::clone(&db),
        );
        Self { root, db, service }
    }

    fn source(&self, operation: &str) -> (String, String) {
        let session = self
            .db
            .create_session(CreateSession {
                project_id: None,
                title: Some("Source"),
                provider: "shell",
                mode: "chat",
                native_id: None,
                operation_id: operation,
            })
            .unwrap();
        crate::session_configs::save_new(
            &self.db,
            &session.id,
            &LaunchSpec {
                provider: "shell".into(),
                mode: "chat".into(),
                cwd: self.root.path().display().to_string(),
                project_id: None,
                title: Some("Source".into()),
                executable: None,
                args: vec![],
            },
            None,
        )
        .unwrap();
        self.db
            .bind_session(
                &session.id,
                Some(&self.root.path().display().to_string()),
                None,
            )
            .unwrap();
        self.db
            .set_session_status(&session.id, "idle", None)
            .unwrap();
        self.db
            .import_chat_history(
                &session.id,
                &[ChatItem {
                    id: "answer".into(),
                    role: "assistant".into(),
                    parts: vec![json!({"type":"text","text":"answer"})],
                    created_at: Utc::now().to_rfc3339(),
                    turn_id: Some("turn".into()),
                    elapsed_ms: None,
                    turn_status: Some(NativeTurnStatus::Completed),
                    turn_origin: None,
                    fork_anchor: None,
                    turn_model: None,
                    turn_usage: None,
                    turn_review: None,
                }],
            )
            .unwrap();
        let item = self.db.chat_items(&session.id).unwrap()[0].id.clone();
        (session.id, item)
    }
}

#[test]
fn fork_retry_with_new_lease_returns_one_child_and_one_event() {
    let fixture = Fixture::new();
    let (source, item) = fixture.source("source-one");
    let epoch = fixture
        .service
        .leases
        .claim(&fixture.db, &source, "first")
        .unwrap();
    let params = |lease_epoch| {
        json!({
            "sessionId":source,"itemId":item,"operationId":"fork-once","leaseEpoch":lease_epoch,
        })
    };
    let first = fixture
        .service
        .dispatch(
            "first",
            RpcRequest {
                v: 1,
                id: "fork-1".into(),
                method: "chat.fork".into(),
                params: params(epoch),
            },
        )
        .unwrap();
    fixture
        .db
        .put_lease(
            &source,
            "second",
            epoch + 1,
            &(Utc::now() + Duration::minutes(1)).to_rfc3339(),
        )
        .unwrap();
    let replay = fixture
        .service
        .dispatch(
            "second",
            RpcRequest {
                v: 1,
                id: "fork-2".into(),
                method: "chat.fork".into(),
                params: params(epoch + 1),
            },
        )
        .unwrap();
    assert_eq!(first, replay);
    assert_eq!(fixture.db.snapshot().unwrap().sessions.len(), 2);
    let events = fixture
        .db
        .events_after(0)
        .unwrap()
        .into_iter()
        .filter(|(_, event, data)| event == "chat.forked" && data["operationId"] == "fork-once")
        .count();
    assert_eq!(events, 1);
}

#[test]
fn exact_slash_fork_creates_child_without_sending_or_changing_source() {
    let fixture = Fixture::new();
    let (source, _) = fixture.source("source-slash");
    let before = fixture.db.chat_items(&source).unwrap();
    let epoch = fixture
        .service
        .leases
        .claim(&fixture.db, &source, "desktop")
        .unwrap();
    let result = fixture.service.dispatch("desktop", RpcRequest {
        v: 1, id: "slash".into(), method: "chat.send".into(),
        params: json!({"sessionId":source,"text":" /fork ","operationId":"slash-fork","leaseEpoch":epoch}),
    }).unwrap();
    assert_eq!(result["turnId"], "slash-fork");
    assert_eq!(fixture.db.chat_items(&source).unwrap(), before);
    assert_eq!(fixture.db.snapshot().unwrap().sessions.len(), 2);
    assert_eq!(
        fixture.db.operation("slash-fork").unwrap().unwrap()["mode"],
        "copy"
    );
}
