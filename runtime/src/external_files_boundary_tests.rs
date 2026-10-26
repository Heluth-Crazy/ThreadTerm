use crate::{
    config::RuntimeConfig,
    data_backup,
    db::{CreateSession, Database},
    domain::RpcRequest,
    service::RuntimeService,
    session_configs::{self, LaunchSpec},
    workspace_services,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{fs, path::Path, sync::Arc};

struct Fixture {
    config: RuntimeConfig,
    db: Arc<Database>,
    service: RuntimeService,
    temp: tempfile::TempDir,
}

#[test]
fn agent_chat_and_browser_dispatch_cannot_forward_external_files() {
    let fixture = Fixture::new();
    let chat_tools =
        crate::chat_tools::shared(&fixture.config.database_path, Arc::clone(&fixture.db)).unwrap();
    let providers = crate::providers::Providers::for_test(Vec::new());
    let catalog = crate::browser_tools::tool_catalogue();
    for method in [
        "filesystem.external.open",
        "filesystem.external.read",
        "filesystem.external.image",
        "filesystem.external.list",
        "filesystem.external.forget",
    ] {
        assert_eq!(
            chat_tools
                .dispatch(&providers, method, &json!({}))
                .unwrap_err()
                .to_string(),
            "unknown_method"
        );
        assert_eq!(
            chat_tools
                .dispatch(&providers, &format!("chat.tool.{method}"), &json!({}))
                .unwrap_err()
                .to_string(),
            "unknown_method"
        );
        assert!(crate::browser_tools::public_args(method, &json!({})).is_err());
        assert!(!catalog.iter().any(|tool| tool["name"] == method));
    }
    assert!(
        fixture.rpc("filesystem.external.list", json!({})).unwrap()["files"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn malformed_external_reads_cannot_write_operation_receipts() {
    let fixture = Fixture::new();
    let before = fixture
        .db
        .transaction(|tx| Ok(tx.query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))?))
        .unwrap();
    for (method, params) in [
        (
            "filesystem.external.open",
            json!({"path":"relative.txt","source":"dialog","operationId":"open-extra"}),
        ),
        (
            "filesystem.external.read",
            json!({"id":"unknown","operationId":"read-extra"}),
        ),
        (
            "filesystem.external.image",
            json!({"id":"unknown","operationId":"image-extra"}),
        ),
        (
            "filesystem.external.list",
            json!({"operationId":"list-extra"}),
        ),
    ] {
        assert_eq!(
            fixture.rpc(method, params).unwrap_err().code,
            "invalid_request"
        );
    }
    let after = fixture
        .db
        .transaction(|tx| Ok(tx.query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))?))
        .unwrap();
    assert_eq!(before, after);
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("data");
        fs::create_dir(&data_dir).unwrap();
        let config = RuntimeConfig {
            database_path: data_dir.join("runtime.sqlite"),
            credential_path: data_dir.join("runtime.credential"),
            data_dir,
            pipe_base: r"\\.\pipe\threadterm-v3-external-boundary-test".into(),
        };
        let db = Arc::new(Database::open(&config.database_path).unwrap());
        workspace_services::initialize(&db).unwrap();
        session_configs::initialize(&db).unwrap();
        let service = RuntimeService::new(config.clone(), Arc::clone(&db));
        Self {
            temp,
            config,
            db,
            service,
        }
    }

    fn rpc(&self, method: &str, params: Value) -> Result<Value, crate::domain::RpcError> {
        self.service.dispatch(
            "external-boundary-test",
            RpcRequest {
                v: 1,
                id: format!("boundary-{method}"),
                method: method.into(),
                params,
            },
        )
    }

    fn outside_file(&self, name: &str, contents: &[u8]) -> std::path::PathBuf {
        let path = self.temp.path().join(name);
        fs::write(&path, contents).unwrap();
        path
    }
}

#[test]
fn service_rpc_keeps_external_documents_readonly_and_maps_external_errors() {
    let fixture = Fixture::new();
    let outside = fixture.outside_file("outside.md", b"external evidence");
    let opened = fixture
        .rpc(
            "filesystem.external.open",
            json!({"path":outside,"source":"dialog"}),
        )
        .unwrap();
    let id = opened["file"]["id"].as_str().unwrap();
    let document = fixture
        .rpc("filesystem.external.read", json!({"id":id}))
        .unwrap();
    assert_eq!(document["content"], "external evidence");
    assert_eq!(document["readonly"], true);
    assert_eq!(document["path"], opened["file"]["path"]);

    for (method, params, code) in [
        (
            "filesystem.external.read",
            json!({"id":"unknown"}),
            "external_file_unknown",
        ),
        (
            "filesystem.external.open",
            json!({"path":"relative.md","source":"dialog"}),
            "invalid_path",
        ),
        (
            "filesystem.external.open",
            json!({"path":fixture.temp.path(),"source":"dialog"}),
            "external_file_not_file",
        ),
        (
            "filesystem.external.open",
            json!({"path":fixture.temp.path().join("missing.md"),"source":"dialog"}),
            "external_file_not_found",
        ),
    ] {
        assert_eq!(
            fixture.rpc(method, params).unwrap_err().code,
            code,
            "{method}"
        );
    }
}

#[test]
fn registration_does_not_change_the_session_launch_or_workspace_binding() {
    let fixture = Fixture::new();
    let workspace = fixture.temp.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let project = fixture
        .db
        .add_project(workspace.to_str().unwrap(), None, "project")
        .unwrap();
    let session = fixture
        .db
        .create_session(CreateSession {
            project_id: Some(&project.id),
            title: None,
            provider: "codex",
            mode: "chat",
            native_id: None,
            operation_id: "boundary-session",
        })
        .unwrap();
    fixture
        .db
        .bind_session(&session.id, Some(workspace.to_str().unwrap()), None)
        .unwrap();
    session_configs::save_new(
        &fixture.db,
        &session.id,
        &LaunchSpec {
            provider: "codex".into(),
            mode: "chat".into(),
            cwd: workspace.to_string_lossy().into_owned(),
            project_id: Some(project.id),
            title: Some("Bound session".into()),
            executable: Some("codex".into()),
            args: vec!["--sandbox".into(), "workspace-write".into()],
        },
        None,
    )
    .unwrap();
    let launch_before = session_configs::read(&fixture.db, &session.id).unwrap();
    let session_before = fixture.db.session_by_id(&session.id).unwrap();
    let outside = fixture.outside_file("registered-outside.md", b"external");

    let result = fixture
        .rpc(
            "filesystem.external.open",
            json!({
                "path":outside, "source":"link", "sessionId":session.id,
            }),
        )
        .unwrap();
    assert!(result["file"]["id"].is_string());
    assert_eq!(
        session_configs::read(&fixture.db, &session.id).unwrap(),
        launch_before
    );
    assert_eq!(
        fixture.db.session_by_id(&session.id).unwrap(),
        session_before
    );
}

#[test]
fn backup_verification_preserves_the_external_file_registration_table() {
    let fixture = Fixture::new();
    let outside = fixture.outside_file("backup-outside.md", b"external");
    let opened = fixture
        .rpc(
            "filesystem.external.open",
            json!({"path":outside,"source":"recent"}),
        )
        .unwrap();
    let id = opened["file"]["id"].as_str().unwrap().to_owned();
    let profile = fixture.temp.path().join("profile");
    fs::create_dir(&profile).unwrap();
    let archive = fixture.temp.path().join("backup.sqlite3");
    assert_eq!(
        data_backup::create(&fixture.config, &fixture.db, &archive, &profile).unwrap()
            ["verification"]["verified"],
        true
    );
    assert_eq!(data_backup::verify(&archive).unwrap()["verified"], true);

    let source = Connection::open_with_flags(&archive, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let bytes = source
        .prepare(
            "SELECT data FROM backup_chunks WHERE path='runtime/runtime.sqlite' ORDER BY sequence",
        )
        .unwrap()
        .query_map([], |row| row.get::<_, Vec<u8>>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let copied = fixture.temp.path().join("restored-runtime.sqlite");
    fs::write(&copied, bytes).unwrap();
    let restored = Connection::open_with_flags(&copied, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let path: String = restored
        .query_row("SELECT path FROM external_files WHERE id=?", [&id], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        path,
        Path::new(opened["file"]["path"].as_str().unwrap())
            .canonicalize()
            .unwrap()
            .to_string_lossy()
    );
}
