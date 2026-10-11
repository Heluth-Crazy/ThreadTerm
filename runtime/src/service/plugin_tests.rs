use super::*;
use crate::providers::common::find_executable;
use std::{
    fs,
    time::{Duration, Instant},
};

fn test_service(root: &std::path::Path, db: Arc<Database>) -> RuntimeService {
    crate::session_configs::initialize(&db).unwrap();
    crate::retry_scheduler::initialize(&db).unwrap();
    crate::review::initialize(&db).unwrap();
    RuntimeService::new(
        RuntimeConfig {
            data_dir: root.to_owned(),
            database_path: root.join("runtime.sqlite"),
            credential_path: root.join("credential"),
            pipe_base: "plugin-tests".into(),
        },
        db,
    )
}

fn request(
    service: &RuntimeService,
    method: &str,
    params: Value,
) -> std::result::Result<Value, RpcError> {
    service.dispatch(
        "desktop",
        RpcRequest {
            v: 1,
            id: "plugins-test".into(),
            method: method.into(),
            params,
        },
    )
}

fn echo_fixture(root: &std::path::Path) -> std::path::PathBuf {
    let plugin = root.join("plugins/echo-acp");
    fs::create_dir_all(&plugin).unwrap();
    fs::write(
        plugin.join("threadterm-plugin.json"),
        include_str!("../../../examples/plugins/echo-acp/threadterm-plugin.json"),
    )
    .unwrap();
    fs::write(
        plugin.join("icon.svg"),
        include_str!("../../../examples/plugins/echo-acp/icon.svg"),
    )
    .unwrap();
    let script = include_str!("../../../examples/plugins/echo-acp/agent.mjs").replace(
        "join(tmpdir(), 'threadterm-echo-acp'",
        "join(pluginRoot, 'threadterm-echo-acp'",
    );
    fs::write(plugin.join("agent.mjs"), script).unwrap();
    plugin
}

fn attach_test_capability_notifier(providers: &Providers, db: &Arc<Database>) {
    let capability_db = Arc::downgrade(db);
    providers.set_capability_listener(Arc::new(move || {
        let Some(db) = capability_db.upgrade() else { return };
        if let Err(error) = db.transaction(|tx| {
            tx.execute(
                "INSERT INTO outbox(event,data,created_at) VALUES ('state.changed',?,?)",
                rusqlite::params![json!({"kind":"providers"}).to_string(), chrono::Utc::now().to_rfc3339()],
            )?;
            Ok(())
        }) {
            eprintln!("test provider capability notification failed: {error}");
        }
    }));
}

fn provider_capability_notifications(db: &Database) -> i64 {
    db.transaction(|tx| {
        Ok(tx.query_row(
            "SELECT COUNT(*) FROM outbox WHERE event='state.changed' AND json_extract(data,'$.kind')='providers'",
            [],
            |row| row.get(0),
        )?)
    })
    .unwrap()
}

fn wait_for_provider_capability_notification(db: &Database, after: i64) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while provider_capability_notifications(db) <= after {
        assert!(
            Instant::now() < deadline,
            "provider capability discovery did not publish state.changed(kind=providers)"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn failed_provider_discovery_keeps_runtime_snapshot_and_existing_sessions_available() {
    use crate::providers::{ChatSession, ProviderAdapter, ProviderCapability, ProviderError, TerminalCommand};
    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};

    struct BrokenProbe(Arc<AtomicUsize>);
    impl ProviderAdapter for BrokenProbe {
        fn id(&self) -> &'static str { "codex" }
        fn capability(&self) -> ProviderCapability {
            self.0.fetch_add(1, SeqCst);
            panic!("isolated provider discovery failure");
        }
        fn terminal_command(&self, _: Option<&str>, _: Option<&str>) -> std::result::Result<TerminalCommand, ProviderError> {
            Err(ProviderError::new("unsupported", "failure fixture"))
        }
        fn history_list(&self, _: Option<&str>, _: u32, _: Option<&str>) -> std::result::Result<Value, ProviderError> { Ok(json!({})) }
        fn history_read(&self, _: &str) -> std::result::Result<Value, ProviderError> { Ok(json!([])) }
        fn open_chat(&self, _: &str, _: &str, _: Option<&str>) -> std::result::Result<Box<dyn ChatSession>, ProviderError> {
            Err(ProviderError::new("unsupported", "failure fixture"))
        }
    }

    let root = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
    let mut service = test_service(root.path(), Arc::clone(&db));
    let existing = db.create_session(CreateSession {
        project_id: None, title: Some("Existing session"), provider: "shell", mode: "terminal",
        native_id: None, operation_id: "existing-session",
    }).unwrap();
    let probes = Arc::new(AtomicUsize::new(0));
    service.providers = Arc::new(Providers::for_test(vec![Arc::new(BrokenProbe(Arc::clone(&probes)))]));
    attach_test_capability_notifier(&service.providers, &db);
    let before = provider_capability_notifications(&db);
    assert!(request(&service, "runtime.snapshot", json!({})).unwrap()["providers"].as_array().unwrap().is_empty());
    wait_for_provider_capability_notification(&db, before);
    for _ in 0..8 {
        let snapshot = request(&service, "runtime.snapshot", json!({})).unwrap();
        assert_eq!(snapshot["sessions"][0]["id"], existing.id);
        assert!(snapshot["providers"].as_array().unwrap().is_empty());
        let error = request(&service, "provider.list", json!({})).unwrap_err();
        assert_eq!(error.code, "provider_detection_failed");
        assert!(request(&service, "runtime.health", json!({})).is_ok());
    }
    assert_eq!(probes.load(SeqCst), 1, "failure completion/reads must not cause a retry loop");
}

#[test]
fn plugin_dispatch_enable_reload_metadata_delegation_and_live_chat() {
    if find_executable("node").is_none() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let plugin = echo_fixture(root.path());
    let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
    let mut service = test_service(root.path(), Arc::clone(&db));
    // Probes in this test may execute only the temporary example script.
    service.providers = Arc::new(Providers::for_test(vec![]));
    attach_test_capability_notifier(&service.providers, &db);
    service
        .providers
        .rebuild_plugins(crate::plugins::PluginRegistry::discover_with_roots(
            root.path(),
            &json!({}),
            &[],
        ));
    let list = request(&service, "plugin.list", json!({})).unwrap();
    let echo = list["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plugin| plugin["id"] == "echo-acp")
        .unwrap();
    assert_eq!(echo["source"], "user");
    assert_eq!(echo["enabled"], false);
    assert!(echo["issues"].as_array().unwrap().is_empty());
    assert!(echo["agents"][0]["commands"]
        .as_array()
        .unwrap()
        .iter()
        .any(|line| line.as_str().unwrap().contains("--acp")));
    let failure = request(
        &service,
        "session.create",
        json!({"cwd":root.path(),"provider":"echo","mode":"chat","operationId":"disabled-create"}),
    )
    .unwrap_err();
    assert_eq!(failure.code, "unsupported_provider");
    assert!(failure.message.contains("echo-acp"));
    request(
        &service,
        "plugin.setEnabled",
        json!({"pluginId":"gemini","enabled":false,"operationId":"gemini-off"}),
    )
    .unwrap();
    let enabled = request(
        &service,
        "plugin.setEnabled",
        json!({"pluginId":"echo-acp","enabled":true,"operationId":"echo-on"}),
    )
    .unwrap();
    assert_eq!(
        request(
            &service,
            "plugin.setEnabled",
            json!({"pluginId":"echo-acp","enabled":true,"operationId":"echo-on"})
        )
        .unwrap(),
        enabled
    );
    assert_eq!(
        db.settings_value().unwrap()["plugins"]["echo-acp"]["enabled"],
        true
    );
    let capability_notifications_before_probe = provider_capability_notifications(&db);
    let pending_capabilities = request(&service, "provider.list", json!({})).unwrap();
    assert_eq!(pending_capabilities.as_array().unwrap().len(), 0, "cold provider discovery should return pending empty capabilities");
    wait_for_provider_capability_notification(&db, capability_notifications_before_probe);
    let capabilities = request(&service, "provider.list", json!({})).unwrap();
    let capability = capabilities
        .as_array()
        .unwrap()
        .iter()
        .find(|value| value["id"] == "echo")
        .unwrap();
    for key in ["installed", "terminal", "chat", "history", "resume"] {
        assert_eq!(capability[key], true, "{key}: {capability}");
    }
    assert_eq!(capability["source"], "plugin");
    assert_eq!(capability["pluginId"], "echo-acp");
    assert_eq!(capability["terminalResumeCapture"], "none");
    assert!(capability["icon"]
        .as_str()
        .unwrap()
        .starts_with("data:image/svg+xml;base64,"));
    assert!(capability["signIn"]["executable"]
        .as_str()
        .unwrap()
        .contains("node"));
    assert_eq!(capability["signIn"]["args"][1], "login");
    assert_eq!(
        crate::delegation::available_agents(&service.providers),
        vec!["echo"]
    );
    let parent = db
        .create_session(CreateSession {
            project_id: None,
            title: None,
            provider: "codex",
            mode: "chat",
            native_id: None,
            operation_id: "parent",
        })
        .unwrap();
    let delegation: crate::delegation::StartRequest = serde_json::from_value(json!({"callerSessionId":parent.id,"callerToken":"fixture","agent":"echo","prompt":"hello","operationId":"delegate"})).unwrap();
    crate::delegation::validate_start(&db, &service.providers, &parent, &delegation).unwrap();
    let opened = service
        .providers
        .chat_open("live-echo", "echo", root.path().to_str().unwrap(), None)
        .unwrap();
    let native = opened["nativeId"].as_str().unwrap().to_owned();
    let mut events = service.providers.subscribe();
    service
        .providers
        .chat_send("live-echo", "first", "turn-one")
        .unwrap();
    let wait_for_answer =
        |events: &mut tokio::sync::broadcast::Receiver<crate::providers::ProviderEvent>,
         expected: &str| {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Ok(event) = events.try_recv() {
                    if event.kind == "chat.delta" && event.data["part"]["text"] == expected {
                        break;
                    }
                }
                assert!(Instant::now() < deadline, "missing echo answer {expected}");
                std::thread::sleep(Duration::from_millis(10));
            }
        };
    wait_for_answer(&mut events, "Echo: first");
    let history = service
        .providers
        .history_list("echo", None, 50, None)
        .unwrap();
    assert!(history["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["nativeId"] == native));
    let transcript = service.providers.history_read("echo", &native).unwrap();
    assert!(transcript
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["parts"][0]["text"] == "Echo: first"));
    // Reload changes data-driven descriptors and invalidates capability probes.
    let manifest_path = plugin.join("threadterm-plugin.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["contributes"]["agents"][0]["name"] = json!("Echo Reloaded");
    fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let capability_notifications_before_reload = provider_capability_notifications(&db);
    request(&service, "plugin.reload", json!({"operationId":"reload"})).unwrap();
    let reloaded_capabilities = request(&service, "provider.list", json!({})).unwrap();
    if !reloaded_capabilities
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["name"] == "Echo Reloaded"))
    {
        wait_for_provider_capability_notification(&db, capability_notifications_before_reload);
    }
    let capabilities = request(&service, "provider.list", json!({})).unwrap();
    assert_eq!(capabilities[0]["name"], "Echo Reloaded");
    request(
        &service,
        "plugin.setEnabled",
        json!({"pluginId":"echo-acp","enabled":false,"operationId":"echo-off"}),
    )
    .unwrap();
    assert!(!service.providers.contains("echo"));
    assert!(service.providers.chat_is_open("live-echo"));
    service
        .providers
        .chat_send("live-echo", "second", "turn-two")
        .unwrap();
    wait_for_answer(&mut events, "Echo: second");
    let failure = service
        .providers
        .chat_open("new-echo", "echo", root.path().to_str().unwrap(), None)
        .unwrap_err();
    assert!(failure.message.contains("echo-acp"));
    service.providers.chat_stop("live-echo").unwrap();
    db.transaction(|tx| {
        let count:i64 = tx.query_row("SELECT COUNT(*) FROM outbox WHERE event='state.changed' AND json_extract(data,'$.kind')='plugins'", [], |row| row.get(0))?;
        assert_eq!(count, 4);
        Ok(())
    }).unwrap();
}

#[test]
fn plugin_settings_are_private_and_list_is_pure() {
    let root = tempfile::tempdir().unwrap();
    echo_fixture(root.path());
    let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
    let service = test_service(root.path(), Arc::clone(&db));
    assert!(request(&service, "settings.update", json!({"patch":{"plugins":{"echo-acp":{"enabled":true}}},"expectedRevision":0,"operationId":"settings-bypass"})).is_err());
    assert!(db.settings_value().unwrap().get("plugins").is_none());
    request(
        &service,
        "plugin.setEnabled",
        json!({"pluginId":"echo-acp","enabled":true,"operationId":"enable"}),
    )
    .unwrap();
    let export = request(&service, "settings.export", json!({})).unwrap();
    assert!(!export.to_string().contains("plugins"));
    let bundle = json!({"marker":"threadterm-v3-settings","version":1,"settings":{"theme":"dark","plugins":{"echo-acp":{"enabled":false}}}}).to_string();
    let preview = request(
        &service,
        "settings.import.preview",
        json!({"bundle":bundle}),
    )
    .unwrap();
    assert_eq!(preview["valid"], true);
    assert!(preview["changes"]
        .as_array()
        .unwrap()
        .iter()
        .all(|change| change["key"] != "plugins"));
    let current_revision = db.snapshot().unwrap().settings.revision;
    assert!(request(&service, "settings.import.apply", json!({"bundle":bundle,"selected":["plugins"],"expectedRevision":current_revision,"operationId":"import-plugins"})).is_err());
    request(&service, "settings.import.apply", json!({"bundle":bundle,"selected":["theme"],"expectedRevision":current_revision,"operationId":"import-theme"})).unwrap();
    assert_eq!(
        db.settings_value().unwrap()["plugins"]["echo-acp"]["enabled"],
        true
    );
    let revision = db.snapshot().unwrap().revision;
    request(&service, "plugin.list", json!({})).unwrap();
    assert_eq!(db.snapshot().unwrap().revision, revision);
    assert!(request(&service, "plugin.list", json!({"operationId":"list-write"})).is_err());
    assert!(db.operation("list-write").unwrap().is_none());
    for (method, value) in [
        ("plugin.reload", json!({"operationId":""})),
        (
            "plugin.setEnabled",
            json!({"pluginId":"echo-acp","enabled":"true","operationId":"bad"}),
        ),
        (
            "plugin.setEnabled",
            json!({"pluginId":"missing","enabled":true,"operationId":"missing"}),
        ),
    ] {
        assert!(request(&service, method, value).is_err());
    }
}

#[test]
fn plugin_agents_support_session_creation_and_saved_launches() {
    let root = tempfile::tempdir().unwrap();
    echo_fixture(root.path());
    let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
    let mut service = test_service(root.path(), Arc::clone(&db));
    service.providers = Arc::new(Providers::for_test(vec![]));
    request(
        &service,
        "plugin.setEnabled",
        json!({"pluginId":"echo-acp","enabled":true,"operationId":"session-enable"}),
    )
    .unwrap();
    // Chat creation persists a launch without starting any provider process.
    let created = request(
        &service,
        "session.create",
        json!({"cwd":root.path(),"provider":"echo","mode":"chat","operationId":"plugin-create"}),
    )
    .unwrap();
    let id = created["id"].as_str().unwrap();
    let config = request(&service, "session.config.read", json!({"sessionId":id})).unwrap();
    assert_eq!(config["provider"], "echo");
    assert_eq!(config["mode"], "chat");
    let saved = request(&service, "session.config.save", json!({"sessionId":id,"provider":"echo","mode":"terminal","cwd":root.path(),"expectedRevision":1,"operationId":"plugin-save"})).unwrap();
    assert_eq!(saved["mode"], "terminal");
    assert_eq!(saved["revision"], 2);
    request(
        &service,
        "plugin.setEnabled",
        json!({"pluginId":"echo-acp","enabled":false,"operationId":"session-disable"}),
    )
    .unwrap();
    for (provider, operation) in [("echo", "disabled-save"), ("unknown-agent", "unknown-save")] {
        let failure = request(&service, "session.config.save", json!({"sessionId":id,"provider":provider,"mode":"terminal","cwd":root.path(),"expectedRevision":2,"operationId":operation})).unwrap_err();
        assert_eq!(failure.code, "unsupported_provider");
        if provider == "echo" {
            assert!(failure.message.contains("echo-acp"));
        }
    }
    assert_eq!(
        crate::session_configs::read(&db, id)
            .unwrap()
            .unwrap()
            .revision,
        2
    );
}

#[test]
fn enabled_plugin_terminal_session_launches_the_temporary_echo_script() {
    if find_executable("node").is_none() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    echo_fixture(root.path());
    let db = Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
    let mut service = test_service(root.path(), Arc::clone(&db));
    service.providers = Arc::new(Providers::for_test(vec![]));
    request(
        &service,
        "plugin.setEnabled",
        json!({"pluginId":"echo-acp","enabled":true,"operationId":"terminal-enable"}),
    )
    .unwrap();
    let created = request(&service, "session.create", json!({"cwd":root.path(),"provider":"echo","mode":"terminal","operationId":"plugin-terminal"})).unwrap();
    let id = created["id"].as_str().unwrap();
    assert_eq!(created["provider"], "echo");
    assert_eq!(
        crate::session_configs::read(&db, id)
            .unwrap()
            .unwrap()
            .launch
            .provider,
        "echo"
    );
    request(
        &service,
        "session.stop",
        json!({"sessionId":id,"operationId":"terminal-stop"}),
    )
    .unwrap();
}
