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
// `failure` selects the server shape this run models: '' is a current Codex;
// 'inject' answers thread/inject_items with method-not-found; 'verify' loses the
// thread between processes; 'metadata' omits the optional turns array.
const thread = {{id:'01a13d87-08fc-7300-a8a8-42abc9af43c5',source:'vscode',turns:[],preview:'',name:null,cliVersion:'0.100.0'}};
const timer = setTimeout(() => process.exit(124), 10000).unref();
createInterface({{input:process.stdin,crlfDelay:Infinity}}).on('line', line => {{
  const request = JSON.parse(line);
  appendFileSync(calls, JSON.stringify({{pid:process.pid,...request}}) + '\n');
  if (request.id === undefined) return;
  const event = (method, params) => process.stdout.write(JSON.stringify({{method, params}}) + '\n');
  let result = {{}};
  let error;
  if (request.method === 'initialize') result = {{userAgent:'codex_cli_rs/0.100.0 (Windows 10.0.26100; x86_64)'}};
  if (request.method === 'thread/start') result = {{thread}};
  if (request.method === 'thread/inject_items') {{
    if (failure === 'inject') error = {{code:-32601,message:'unknown method thread/inject_items'}};
    else writeFileSync(stored, JSON.stringify(thread));
  }}
  if (request.method === 'thread/read') {{
    if (!existsSync(stored) || failure === 'verify') error = {{code:-32600,message:'thread not loaded: ' + request.params.threadId}};
    else {{
      const saved = JSON.parse(readFileSync(stored,'utf8'));
      if (failure === 'metadata') delete saved.turns;
      result = {{thread:saved}};
    }}
  }}
  if (request.method === 'thread/resume') result = {{thread}};
  if (request.method === 'turn/start') {{
    const turnId = 'turn-1';
    event('turn/started', {{threadId:request.params.threadId, turn:{{id:turnId}}}});
    result = {{turn:{{id:turnId}}}};
    event('item/completed', {{threadId:request.params.threadId, turnId, item:{{id:turnId + '-answer', type:'agentMessage', phase:'final_answer', text:'fixture answer'}}}});
    event('turn/completed', {{threadId:request.params.threadId, turn:{{id:turnId, status:'completed'}}}});
  }}
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
fn new_chat_verification_failure_never_emits_ready() {
    // A thread another process cannot load is not durable: the Chat must not
    // claim a resumable identity. A CLI that cannot materialize at all now
    // degrades instead of failing; the tests below cover that.
    let mut fixture = PersistenceFixture::new("verify");
    let error = fixture
        .adapter
        .open_chat_with_tools("empty", "D:/repo", None, "worker", None)
        .err()
        .unwrap();
    assert!(matches!(
        error.code.as_str(),
        "provider_error" | "native_thread_missing"
    ));
    assert!(std::iter::from_fn(|| fixture.events.try_recv().ok())
        .all(|event| event.kind != "session.ready"));
    assert!(!fixture
        .calls()
        .iter()
        .any(|call| call["method"] == "turn/start"));
}

const THREAD_ID: &str = "01a13d87-08fc-7300-a8a8-42abc9af43c5";

fn wait_for(fixture: &mut PersistenceFixture, kind: &str) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(event) = fixture.events.try_recv() {
            if event.kind == kind {
                return true;
            }
        } else {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    false
}

/// An older Codex CLI answers `thread/inject_items` with method-not-found. The
/// Chat must connect and run a turn anyway, and say once what is off.
#[test]
fn chat_connects_and_chats_when_the_cli_lacks_inject_items() {
    let mut fixture = PersistenceFixture::new("inject");
    let mut chat = fixture
        .adapter
        .open_chat_with_tools("empty", "D:/repo", None, "worker", None)
        .unwrap();
    assert_eq!(chat.native_id().as_deref(), Some(THREAD_ID));
    // Without the materialization there is nothing to verify, so no second
    // process starts and no thread/read is attempted.
    assert!(fixture
        .calls()
        .iter()
        .all(|call| call["method"] != "thread/read"));
    let state = chat.ui_state();
    let notice = &state["notice"];
    assert_eq!(notice["code"], "codex_cli_limited");
    assert_eq!(notice["version"], "0.100.0");
    assert_eq!(notice["feature"], "thread/inject_items");
    let message = notice["message"].as_str().unwrap();
    assert!(message.contains("thread/inject_items"), "{message}");
    assert!(message.contains("npm install -g @openai/codex"), "{message}");
    // English and Chinese, as everywhere else that reports a provider limit.
    assert!(message.contains("\u{66f4}\u{65b0}"), "{message}");
    // Settings -> Tools reads the same text through the readiness reason.
    assert_eq!(
        fixture.adapter.api_notice_message().as_deref(),
        Some(message)
    );
    assert_eq!(chat.send("hello", "turn-1").unwrap()["turnId"], "turn-1");
    assert!(
        wait_for(&mut fixture, "chat.turn.completed"),
        "the degraded chat runs a turn"
    );
    assert!(fixture.calls().iter().any(|call| {
        call["method"] == "turn/start" && call["params"]["threadId"] == THREAD_ID
    }));
    chat.stop().unwrap();
}

/// An older app-server answers `thread/read` without the optional turns array.
/// The identity is still proven across processes, so the Chat opens, the
/// missing transcript is reported, and a turn still runs.
#[test]
fn chat_connects_when_thread_read_has_no_turns_and_history_says_so() {
    let mut fixture = PersistenceFixture::new("metadata");
    let mut chat = fixture
        .adapter
        .open_chat_with_tools("empty", "D:/repo", None, "worker", None)
        .unwrap();
    assert_eq!(chat.native_id().as_deref(), Some(THREAD_ID));
    let reads: Vec<_> = fixture
        .calls()
        .into_iter()
        .filter(|call| call["method"] == "thread/read")
        .collect();
    assert_eq!(
        reads
            .iter()
            .map(|call| call["params"]["includeTurns"].clone())
            .collect::<Vec<_>>(),
        vec![json!(true), json!(false)]
    );
    let state = chat.ui_state();
    assert_eq!(state["notice"]["code"], "codex_cli_limited");
    assert_eq!(state["notice"]["feature"], "thread/read includeTurns");
    assert!(state["notice"]["message"]
        .as_str()
        .unwrap()
        .contains("reading saved chat history"));
    // No native turns means no transcript: report it rather than an empty
    // history that would look like lost messages.
    let error = fixture.adapter.history_read(THREAD_ID).unwrap_err();
    assert_eq!(error.code, "provider_method_unsupported");
    assert!(error.message.contains("saved chat turns"), "{}", error.message);
    assert_eq!(chat.send("hello", "turn-1").unwrap()["turnId"], "turn-1");
    assert!(
        wait_for(&mut fixture, "chat.turn.completed"),
        "the degraded chat runs a turn"
    );
    chat.stop().unwrap();
}

/// One CLI serves every Chat: the missing method is recorded once, and later
/// connects take the fallback without probing again.
#[test]
fn a_missing_method_is_recorded_once_for_every_chat() {
    let fixture = PersistenceFixture::new("inject");
    let mut first = fixture
        .adapter
        .open_chat_with_tools("one", "D:/repo", None, "worker-1", None)
        .unwrap();
    let notice = first.ui_state()["notice"].clone();
    first.stop().unwrap();
    let mut second = fixture
        .adapter
        .open_chat_with_tools("two", "D:/repo", None, "worker-2", None)
        .unwrap();
    assert_eq!(second.ui_state()["notice"], notice);
    assert_eq!(
        fixture
            .calls()
            .iter()
            .filter(|call| call["method"] == "thread/inject_items")
            .count(),
        1
    );
    second.stop().unwrap();
}

#[test]
fn cli_version_comes_from_the_initialize_user_agent() {
    assert_eq!(
        codex_cli_version("codex_cli_rs/0.161.0 (Windows 10.0.26100; x86_64)"),
        "0.161.0"
    );
    assert_eq!(
        codex_cli_version("codex_cli_rs/0.100.0-alpha.2 (Linux 6.8.0)"),
        "0.100.0-alpha.2"
    );
    assert_eq!(codex_cli_version("codex 0.9"), "0.9");
    // An unparsable agent string is kept short instead of leaked whole.
    assert_eq!(codex_cli_version("unknown server"), "unknown server");
}

#[test]
fn a_missing_feature_notice_is_written_once_and_names_the_cli() {
    let mut api = CodexApiSupport::default();
    api.version = Some("0.100.0".to_owned());
    assert!(api.supports(CodexFeature::InjectItems));
    api.record_missing(CodexFeature::InjectItems);
    let notice = api.notice.clone().unwrap();
    assert_eq!(notice["code"], "codex_cli_limited");
    assert_eq!(notice["version"], "0.100.0");
    assert_eq!(notice["feature"], "thread/inject_items");
    assert!(!api.supports(CodexFeature::InjectItems));
    // A second missing feature keeps the first message: one old CLI, one notice.
    api.record_missing(CodexFeature::HistoryTurns);
    assert_eq!(api.notice.as_ref().unwrap(), &notice);
    assert!(!api.supports(CodexFeature::HistoryTurns));
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
