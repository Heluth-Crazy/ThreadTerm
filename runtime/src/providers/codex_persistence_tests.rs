struct PersistenceFixture {
    scratch: tempfile::TempDir,
    adapter: CodexAdapter,
    events: broadcast::Receiver<super::super::ProviderEvent>,
}

impl PersistenceFixture {
    fn new(failure: &str) -> Self {
        let node =
            crate::providers::common::find_executable("node").expect("Node fixture executable");
        let scratch = tempfile::tempdir().unwrap();
        let script = scratch.path().join("persistent-thread.mjs");
        let calls = scratch.path().join("requests.jsonl");
        let stored = scratch.path().join("thread.json");
        std::fs::write(&script, format!(r#"
import {{ appendFileSync, existsSync, readFileSync, writeFileSync }} from 'node:fs';
import {{ createInterface }} from 'node:readline';
const calls = {}, stored = {}, failure = {};
const thread = {{id:'01a13d87-08fc-7300-a8a8-42abc9af43c5',source:'vscode',turns:[],preview:'',name:null}};
const timer = setTimeout(() => process.exit(124), 10000).unref();
createInterface({{input:process.stdin,crlfDelay:Infinity}}).on('line', line => {{
  const request = JSON.parse(line);
  appendFileSync(calls, JSON.stringify({{pid:process.pid,...request}}) + '\n');
  if (request.id === undefined) return;
  let result = {{}};
  let error;
  if (request.method === 'thread/start') result = {{thread}};
  if (request.method === 'thread/inject_items') {{
    if (failure === 'inject') error = {{code:-32601,message:'inject unsupported'}};
    else writeFileSync(stored, JSON.stringify(thread));
  }}
  if (request.method === 'thread/read') {{
    if (!existsSync(stored) || failure === 'verify') error = {{code:-32600,message:'thread not loaded: ' + request.params.threadId}};
    else result = {{thread:JSON.parse(readFileSync(stored,'utf8'))}};
  }}
  if (request.method === 'thread/resume') result = {{thread}};
  if (request.method === 'model/list') result = {{data:[]}};
  if (request.method === 'skills/list') result = {{data:[]}};
  process.stdout.write(JSON.stringify({{id:request.id,...(error ? {{error}} : {{result}})}}) + '\n');
}}).on('close', () => {{clearTimeout(timer);process.exit(0);}});
"#,
            serde_json::to_string(&calls.to_string_lossy()).unwrap(),
            serde_json::to_string(&stored.to_string_lossy()).unwrap(),
            serde_json::to_string(failure).unwrap(),
        )).unwrap();
        let spec =
            CommandSpec::from_path(node, vec![script.to_string_lossy().into_owned()]).unwrap();
        let (events, receiver) = crate::provider_events::tap_channel(128);
        Self {
            scratch,
            adapter: CodexAdapter::with_test_app_server_spec(events, spec),
            events: receiver,
        }
    }

    fn calls(&self) -> Vec<Value> {
        std::fs::read_to_string(self.scratch.path().join("requests.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

#[test]
fn new_chat_materializes_and_verifies_in_a_separate_process_without_a_turn() {
    let mut fixture = PersistenceFixture::new("");
    let mut chat = fixture
        .adapter
        .open_chat_with_tools("empty", "D:/repo", None, "worker", None)
        .unwrap();
    let calls = fixture.calls();
    let lifecycle: Vec<_> = calls
        .iter()
        .filter(|call| {
            matches!(
                call["method"].as_str(),
                Some("thread/start" | "thread/inject_items" | "thread/read")
            )
        })
        .collect();
    assert_eq!(
        lifecycle
            .iter()
            .map(|call| call["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["thread/start", "thread/inject_items", "thread/read"]
    );
    assert_eq!(lifecycle[0]["pid"], lifecycle[1]["pid"]);
    assert_ne!(lifecycle[0]["pid"], lifecycle[2]["pid"]);
    assert_eq!(
        lifecycle[1]["params"]["items"],
        json!([{"type":"message","role":"developer","content":[]}])
    );
    assert_eq!(lifecycle[2]["params"]["includeTurns"], true);
    assert_eq!(
        chat.native_id().as_deref(),
        Some("01a13d87-08fc-7300-a8a8-42abc9af43c5")
    );
    assert!(calls
        .iter()
        .all(|call| call["method"] != "turn/start" && call["method"] != "thread/resume"));
    // UI discovery still runs on the original, loaded Chat process.
    assert!(calls
        .iter()
        .any(|call| call["method"] == "model/list" && call["pid"] == lifecycle[0]["pid"]));
    assert_eq!(
        fixture
            .adapter
            .history_read(&chat.native_id().unwrap())
            .unwrap(),
        json!([])
    );
    let stored: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture.scratch.path().join("thread.json")).unwrap(),
    )
    .unwrap();
    assert!(codex_transcript_items(&stored).is_empty());
    assert_eq!(stored["turns"].as_array().unwrap().len(), 0);
    assert_eq!(stored["preview"], "");
    assert_eq!(
        codex_history_item(&stored).unwrap()["title"],
        "Codex session"
    );
    assert!(!chat.ui_state().to_string().contains("developer"));
    let events: Vec<_> = std::iter::from_fn(|| fixture.events.try_recv().ok()).collect();
    assert!(events.iter().any(|event| event.kind == "session.ready"));
    assert!(events.iter().all(|event| !matches!(
        event.kind.as_str(),
        "chat.item" | "chat.turn.started" | "chat.turn.completed"
    )));
    chat.stop().unwrap();
}

#[test]
fn terminal_and_chat_use_the_same_verified_materialization_sequence() {
    let fixture = PersistenceFixture::new("");
    assert!(fixture
        .adapter
        .prepare_terminal("D:/repo")
        .unwrap()
        .is_some());
    let calls = fixture.calls();
    let methods: Vec<_> = calls
        .iter()
        .filter_map(|call| call["method"].as_str())
        .filter(|method| method.starts_with("thread/"))
        .collect();
    assert_eq!(
        methods,
        ["thread/start", "thread/inject_items", "thread/read"]
    );
}

#[test]
fn new_chat_materialization_and_verification_failures_never_emit_ready() {
    for failure in ["inject", "verify"] {
        let mut fixture = PersistenceFixture::new(failure);
        let error = fixture
            .adapter
            .open_chat_with_tools("empty", "D:/repo", None, "worker", None)
            .err()
            .unwrap();
        assert!(matches!(
            error.code.as_str(),
            "provider_method_unsupported" | "provider_error"
        ));
        assert!(std::iter::from_fn(|| fixture.events.try_recv().ok())
            .all(|event| event.kind != "session.ready"));
        assert!(!fixture
            .calls()
            .iter()
            .any(|call| call["method"] == "turn/start"));
    }
}

#[test]
fn missing_chat_native_thread_is_reported_without_adapter_replacement() {
    let fixture = PersistenceFixture::new("");
    let error = fixture
        .adapter
        .open_chat_with_tools(
            "empty",
            "D:/repo",
            Some("01a13d87-0850-70f1-944f-191b90b7fb9e"),
            "worker",
            None,
        )
        .err()
        .unwrap();
    assert_eq!(error.code, "native_thread_missing");
    assert!(fixture.calls().iter().all(|call| !matches!(
        call["method"].as_str(),
        Some("thread/start" | "thread/inject_items" | "thread/resume")
    )));
}

#[test]
fn existing_chat_thread_resumes_without_materializing_again() {
    let fixture = PersistenceFixture::new("");
    let mut first = fixture
        .adapter
        .open_chat_with_tools("empty", "D:/repo", None, "worker-1", None)
        .unwrap();
    let native_id = first.native_id().unwrap();
    first.stop().unwrap();
    let mut resumed = fixture
        .adapter
        .open_chat_with_tools("empty", "D:/repo", Some(&native_id), "worker-2", None)
        .unwrap();
    assert_eq!(resumed.native_id(), Some(native_id));
    let calls = fixture.calls();
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "thread/start")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "thread/inject_items")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "thread/resume")
            .count(),
        1
    );
    resumed.stop().unwrap();
}

#[test]
fn missing_thread_classification_requires_an_exact_native_read_failure() {
    let native_id = "01a13d87-0850-70f1-944f-191b90b7fb9e";
    let message = format!("thread not loaded: {native_id}");
    let native =
        ProviderError::new("provider_error", &message).with_details(json!({"code":-32600}));
    assert_eq!(
        codex_missing_thread_error(native_id, native.clone()).code,
        "native_thread_missing"
    );
    for code in [
        "provider_timeout",
        "provider_protocol",
        "provider_unavailable",
        "auth_required",
        "cwd_missing",
        "invalid_native_id",
    ] {
        let error = ProviderError::new(code, &message).with_details(json!({"code":-32600}));
        assert_eq!(codex_missing_thread_error(native_id, error.clone()), error);
    }
    for error in [
        ProviderError::new("provider_error", "file not found").with_details(json!({"code":-32600})),
        ProviderError::new(
            "provider_error",
            format!("{message}: authentication failed"),
        )
        .with_details(json!({"code":-32600})),
        ProviderError::new("provider_error", &message).with_details(json!({"code":401})),
        ProviderError::new("provider_error", &message),
        ProviderError::new("provider_error", "thread not loaded: another-id")
            .with_details(json!({"code":-32600})),
    ] {
        assert_eq!(codex_missing_thread_error(native_id, error.clone()), error);
    }
    assert_eq!(
        codex_missing_thread_error("invalid-id", native.clone()),
        native
    );
}
