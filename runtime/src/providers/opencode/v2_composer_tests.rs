use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc,
};

// P3c composer suite: catalogues, next-turn settings, images/commands/compact,
// and usage/title/retry normalization. The peer is a real TCP listener, so the
// assertions are about the requests 2.2.5 would have received.

fn target(base_url: &str) -> (EventTarget, tokio::sync::broadcast::Receiver<crate::providers::ProviderEvent>) {
    let (events, receiver) = crate::provider_events::tap_channel(64);
    (
        EventTarget {
            dialect: ApiDialect::V2,
            threadterm_session: "chat-v2".into(),
            native_id: "ses-root".into(),
            worker_token: "worker-v2".into(),
            events,
            active: Arc::new(Mutex::new(Some("turn-1".into()))),
            assembly: Default::default(),
            permissions: Default::default(),
            settled_permissions: Default::default(),
            subagents: Default::default(),
            permission_sessions: Default::default(),
            native_turn_observed: AtomicBool::new(false),
            stopped: Arc::new(AtomicBool::new(false)),
            event_gate: Arc::new(Mutex::new(())),
            liveness: Arc::new(AtomicBool::new(true)),
            snapshot_client: Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap(),
            base_url: base_url.into(),
            directory: "C:/scratch".into(),
            username: "opencode".into(),
            password: "pw".into(),
            model_limits: Default::default(),
            ui: Mutex::new(OpenCodeOptions::default()),
            abort_pending: Default::default(),
            retry_visible: AtomicBool::new(false),
            compact_pending: Default::default(),
            ui_options_refreshing: Arc::new(AtomicBool::new(false)),
            v2: Default::default(),
        },
        receiver,
    )
}

/// A scripted native peer: one response per expected request, in order.
struct Scripted {
    address: String,
    requests: mpsc::Receiver<String>,
    handle: thread::JoinHandle<()>,
}

fn scripted(responses: Vec<(u16, String)>) -> Scripted {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let (sender, requests) = mpsc::channel();
    let handle = thread::spawn(move || {
        for (status, body) in responses {
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(peer) => break peer,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("test peer failed: {error}"),
                }
            };
            // Accepted sockets inherit the listener's non-blocking mode on Windows.
            stream.set_nonblocking(false).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0; 4096];
            loop {
                let read = stream.read(&mut chunk).unwrap_or(0);
                if read == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..read]);
                if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length = head
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            sender.send(String::from_utf8_lossy(&bytes).into_owned()).unwrap();
            let reason = if status == 204 { "No Content" } else { "OK" };
            write!(
                stream,
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
    });
    Scripted { address, requests, handle }
}

impl Scripted {
    fn next(&self) -> String {
        self.requests.recv_timeout(Duration::from_secs(5)).expect("scripted request")
    }
    fn assert_exhausted(self) {
        self.handle.join().unwrap();
        assert!(self.requests.try_recv().is_err(), "no unexpected native request");
    }
}

fn body(request: &str) -> Value {
    let start = request.find("\r\n\r\n").map(|index| index + 4).unwrap_or(0);
    serde_json::from_str(&request[start..]).unwrap()
}

fn start(request: &str) -> &str {
    request.lines().next().unwrap()
}

fn fixture(case: &str) -> Value {
    crate::providers::conformance::fixture("opencode-v2-native-composer.jsonl")
        .into_iter()
        .find(|row| row["case"] == case)
        .expect("composer fixture row")["value"]
        .clone()
}

fn session_body(extra: Value) -> String {
    let mut session = json!({"data":{"id":"ses-root"}});
    for (key, value) in extra.as_object().expect("object") {
        session["data"][key] = value.clone();
    }
    session.to_string()
}

fn root_event(mut row: Value) -> Value {
    let session = row.get_mut("data").and_then(|data| data.get_mut("sessionID"));
    if let Some(session) = session { *session = json!("ses-root"); }
    if let Some(aggregate) = row.get_mut("durable").and_then(|durable| durable.get_mut("aggregateID")) { *aggregate = json!("ses-root"); }
    row
}

#[allow(dead_code)]
fn event(id: &str, kind: &str, data: Value) -> Value {
    json!({"id":id,"created":1,"type":kind,"data":data})
}

fn drain(receiver: &mut tokio::sync::broadcast::Receiver<crate::providers::ProviderEvent>) -> Vec<crate::providers::ProviderEvent> {
    std::iter::from_fn(|| receiver.try_recv().ok()).collect()
}

#[test]
fn v2_catalogues_decode_the_decoded_native_payloads() {
    // `NativeApi` returns `ResponseShape::LocationData` already unwrapped, so the
    // adapter sees the payload array, never the raw `{location,data}` envelope.
    let payload = |case: &str| fixture(case)["data"].clone();
    let providers = payload("catalogue_provider");
    let agents = payload("catalogue_agent");
    let commands = payload("catalogue_command");
    let models = crate::providers::conformance::fixture("opencode-v2-native-persistence.jsonl")
        .into_iter()
        .find(|row| row["case"] == "models")
        .expect("captured v2 model catalogue")["value"]["data"]
        .clone();
    assert!(providers.is_array() && models.is_array() && agents.is_array() && commands.is_array());
    let mut ui = OpenCodeOptions::from_catalogues_v2(Ok(providers), Ok(models), Ok(agents));
    assert!(ui.error.is_none(), "decoded payloads are a valid catalogue");
    assert!(!ui.models.is_empty(), "the decoded model payload is the live shape");
    assert!(ui.agents.iter().any(|agent| agent["value"] == json!("build")));
    ui.load_commands_v2(Ok(commands));
    assert_eq!(ui.commands.iter().map(|command| command["name"].as_str().unwrap()).collect::<Vec<_>>(), vec!["init", "review", "goal"]);
    assert_eq!(ui.wire()["options"][0]["id"], "next-model");
    // A refresh of decoded payloads keeps the commands and replaces the options.
    let payload = |case: &str| fixture(case)["data"].clone();
    ui.refresh_catalogues_v2(
        Ok(payload("catalogue_provider")),
        Ok(crate::providers::conformance::fixture("opencode-v2-native-persistence.jsonl")
            .into_iter()
            .find(|row| row["case"] == "models")
            .expect("captured v2 model catalogue")["value"]["data"]
            .clone()),
        Ok(payload("catalogue_agent")),
        Ok(payload("catalogue_command")),
    );
    assert!(ui.error.is_none());
    assert_eq!(ui.commands.len(), 3, "a decoded command payload is never discarded");
    assert_eq!(ui.wire()["options"][0]["id"], "next-model");
}

#[test]
fn v2_catalogues_decode_the_captured_provider_model_agent_and_command_shapes() {
    let providers = fixture("catalogue_provider");
    let agents = fixture("catalogue_agent");
    let commands = fixture("catalogue_command");
    let models = crate::providers::conformance::fixture("opencode-v2-native-persistence.jsonl")
        .into_iter()
        .find(|row| row["case"] == "models")
        .expect("captured v2 model catalogue")["value"]
        .clone();
    let mut ui = OpenCodeOptions::from_catalogues_v2(Ok(providers), Ok(models.clone()), Ok(agents));
    assert!(ui.error.is_none());
    // Provider display names group the flat model list; a disabled model is not offered.
    assert!(ui.models.iter().any(|model| model.name == "OpenCode \u{00b7} DeepSeek V4.1 Flash Free"));
    assert!(ui.models.iter().all(|model| model.name != "OpenCode \u{00b7} Disabled"));
    // Variants come from the variant array, images from `capabilities.input`.
    let deepseek = ui.models.iter().find(|model| model.name.ends_with("DeepSeek V4.1 Flash Free")).unwrap();
    assert_eq!(deepseek.variants, vec!["low", "high", "max"]);
    assert!(deepseek.images);
    assert_eq!(deepseek.limit, Some(200000));
    assert_eq!(deepseek.model, json!({"providerID":"opencode","id":"deepseek-v4.1-flash-free"}));
    let text_only = ui.models.iter().find(|model| model.name.ends_with("Big Pickle")).unwrap();
    assert!(!text_only.images, "a text-only model never advertises image input");
    // Agents are keyed by `id`; hidden and subagent-only entries are not selectable.
    assert_eq!(ui.agents, vec![
        json!({"value":"build","name":"Build","description":"The default agent. Executes tools based on configured permissions."}),
        json!({"value":"plan","name":"Plan","description":"Read-only agent for exploring the codebase and planning work before implementation."}),
    ]);
    ui.load_commands_v2(Ok(commands));
    assert_eq!(ui.commands.iter().map(|command| command["name"].as_str().unwrap()).collect::<Vec<_>>(), vec!["init", "review", "goal"]);
    let wire = ui.wire();
    assert_eq!(wire["inputCapabilities"]["images"], false, "no selection means no image capability");
    assert_eq!(wire["commands"][3]["name"], "compact");
    assert_eq!(wire["options"][0]["id"], "next-model");
    assert_eq!(wire["options"][1]["id"], "agent");
    // A failed refresh keeps the last usable catalogue.
    let before = ui.models.len();
    ui.refresh_catalogues_v2(Err(ProviderError::new("provider_disconnected", "gone")), Err(ProviderError::new("provider_disconnected", "gone")), Ok(json!({"data":[]})), Ok(json!({"data":[]})));
    assert_eq!(ui.models.len(), before);
    assert!(ui.error.is_none(), "a failed refresh never replaces usable options with an error state");
}

#[test]
fn v2_model_ref_carries_the_variant_and_images_use_the_files_uri_contract() {
    let (target, _events) = target("");
    let image = "data:image/png;base64,aGVsbG8=".to_owned();
    {
        let mut ui = target.ui.lock().unwrap();
        ui.models.push(OpenCodeModel {
            value: "{\"providerID\":\"qa\",\"modelID\":\"vision\"}".into(),
            model: json!({"providerID":"qa","id":"vision"}),
            name: "QA \u{00b7} Vision".into(),
            group: "QA".into(),
            variants: vec!["low".into(), "high".into()],
            images: true,
            limit: Some(200000),
        });
        ui.select("next-model", "{\"providerID\":\"qa\",\"modelID\":\"vision\"}").unwrap();
        ui.select("variant", "high").unwrap();
        assert_eq!(ui.model_ref(), Some(json!({"providerID":"qa","id":"vision","variant":"high"})));
        ui.commands = vec![json!({"name":"review","description":"review changes"})];
        // `parts`/`content` are dropped by 2.2.5; only `files` with a data-URL
        // `uri` survives, and the receipt proves it is an inline attachment.
        let (route, body) = ui.dispatch_v2("inspect", std::slice::from_ref(&image)).unwrap();
        assert_eq!(route, "prompt");
        assert_eq!(body, json!({"text":"inspect","files":[{"type":"file","mime":"image/png","uri":image}]}));
        assert!(body.get("parts").is_none());
        let (route, body) = ui.dispatch_v2("/review src/one.rs --check", &[]).unwrap();
        assert_eq!(route, "command");
        assert_eq!(body, json!({"name":"review","text":"src/one.rs --check"}), "2.2.5 takes name + text, not arguments");
        assert!(body.get("arguments").is_none());
        let (route, body) = ui.dispatch_v2(" /compact ", &[]).unwrap();
        assert_eq!(route, "compact");
        assert_eq!(body, json!({}), "compact needs a JSON object body");
        assert_eq!(ui.dispatch_v2("/compact now", &[]).unwrap_err().code, "command_arguments_invalid");
        assert_eq!(ui.dispatch_v2("/compact", &[image.clone()]).unwrap_err().code, "command_arguments_invalid");
        ui.select("next-model", "").unwrap();
        assert_eq!(ui.dispatch_v2("text", &[image.clone()]).unwrap_err().code, "images_unsupported");
    }
    let receipt = fixture("prompt_image_files");
    assert_eq!(receipt["data"]["payload"]["files"][0]["source"]["type"], "inline");
}

#[test]
fn v2_next_turn_settings_are_applied_and_confirmed_before_prompt_admission() {
    let receipt = json!({"data":{"id":"msg_user","sessionID":"ses-root","type":"user","payload":{"text":"hello"}}});
    let peer = scripted(vec![
        (204, String::new()),
        (200, session_body(json!({"model":{"id":"vision","providerID":"qa","variant":"high"}}))),
        (204, String::new()),
        (200, session_body(json!({"agent":"build"}))),
        (200, json!({"directory":"C:/scratch","project":{"id":"global"}}).to_string()),
        (200, receipt.to_string()),
    ]);
    let (target, _events) = target(&peer.address);
    {
        let mut ui = target.ui.lock().unwrap();
        ui.models.push(OpenCodeModel {
            value: "{\"providerID\":\"qa\",\"modelID\":\"vision\"}".into(),
            model: json!({"providerID":"qa","id":"vision"}),
            name: "QA \u{00b7} Vision".into(),
            group: "QA".into(),
            variants: vec!["high".into()],
            images: true,
            limit: Some(200000),
        });
        ui.select("next-model", "{\"providerID\":\"qa\",\"modelID\":\"vision\"}").unwrap();
        ui.select("variant", "high").unwrap();
        ui.agents = vec![json!({"value":"build","name":"Build"})];
        ui.select("agent", "build").unwrap();
    }
    let sent = dispatch_v2(&target, "prompt", &json!({"text":"hello"})).unwrap();
    assert_eq!(sent["type"], "user");
    let model = peer.next();
    assert_eq!(start(&model), "POST /api/session/ses-root/model HTTP/1.1");
    assert_eq!(body(&model), json!({"model":{"providerID":"qa","id":"vision","variant":"high"}}));
    let read = peer.next();
    assert_eq!(start(&read), "GET /api/session/ses-root HTTP/1.1");
    let agent = peer.next();
    assert_eq!(start(&agent), "POST /api/session/ses-root/agent HTTP/1.1");
    assert_eq!(body(&agent), json!({"agent":"build"}));
    assert_eq!(start(&peer.next()), "GET /api/session/ses-root HTTP/1.1");
    let location = peer.next();
    assert_eq!(start(&location), "GET /api/location?location%5Bdirectory%5D=C%3A%2Fscratch HTTP/1.1");
    let prompt = peer.next();
    assert_eq!(start(&prompt), "POST /api/session/ses-root/prompt HTTP/1.1");
    assert_eq!(body(&prompt), json!({"text":"hello"}), "settings live on the session, never in the prompt");
    peer.assert_exhausted();
}

#[test]
fn v2_partial_settings_success_is_reported_and_never_rolled_back_or_replayed() {
    // The model write is accepted but the session read proves a different
    // model: 2.2.5 answers 204 for an unknown model, so the read is the only
    // confirmation. Nothing is sent and nothing is replayed.
    let peer = scripted(vec![
        (204, String::new()),
        (200, session_body(json!({"model":{"id":"other","providerID":"qa","variant":"default"}}))),
    ]);
    let (target, _events) = target(&peer.address);
    {
        let mut ui = target.ui.lock().unwrap();
        ui.models.push(OpenCodeModel {
            value: "{\"providerID\":\"qa\",\"modelID\":\"vision\"}".into(),
            model: json!({"providerID":"qa","id":"vision"}),
            name: "QA \u{00b7} Vision".into(),
            group: "QA".into(),
            variants: Vec::new(),
            images: false,
            limit: None,
        });
        ui.select("next-model", "{\"providerID\":\"qa\",\"modelID\":\"vision\"}").unwrap();
    }
    let error = dispatch_v2(&target, "prompt", &json!({"text":"hello"})).unwrap_err();
    assert_eq!(error.code, "chat_option_not_applied");
    assert_eq!(error.details.as_ref().unwrap()["failed"], "model");
    assert_eq!(error.details.as_ref().unwrap()["rolledBack"], false);
    assert_eq!(target.ui.lock().unwrap().model, "{\"providerID\":\"qa\",\"modelID\":\"vision\"}", "the user's selection is preserved");
    // Exactly the two attempted writes were made: no rollback, no replay.
    assert_eq!(body(&peer.next()), json!({"model":{"providerID":"qa","id":"vision"}}));
    assert_eq!(start(&peer.next()), "GET /api/session/ses-root HTTP/1.1");
    peer.assert_exhausted();
}

#[test]
fn v2_compact_admission_is_never_reported_as_finished_work() {
    let admission = fixture("compact_admission");
    let admission = json!({"data":{"id":admission["data"]["id"].clone(),"sessionID":"ses-root","time":admission["data"]["time"].clone(),"type":"compaction","payload":{},"delivery":"steer"}});
    let peer = scripted(vec![(200, admission.to_string())]);
    let (target, mut events) = target(&peer.address);
    *target.compact_pending.lock().unwrap() = Some(OpenCodeCompact { turn: "turn-1".into(), confirmed: false, idle_observed: false });
    let receipt = dispatch_v2(&target, "compact", &json!({})).unwrap();
    assert_eq!(receipt["type"], "compaction");
    assert_eq!(start(&peer.next()), "POST /api/session/ses-root/compact HTTP/1.1");
    peer.assert_exhausted();
    drop(events.try_recv().ok());
    // Admission alone publishes nothing and completes nothing.
    target.finish_compact("turn-1", Ok(())).unwrap();
    assert!(drain(&mut events).iter().all(|one| one.kind != "chat.item"));
    assert_eq!(target.active.lock().unwrap().as_deref(), Some("turn-1"), "admission does not settle the turn");
    // A native failure is a failure, never a finished command.
    let mut state = target.v2.lock().unwrap();
    let change = state.apply(&target.native_id, &json!({"id":"evt-compact-failed","created":2,"type":"session.compaction.failed","data":{"sessionID":"ses-root","reason":"manual","inputID":"msg_compact","error":{"type":"compaction.unavailable","message":"Nothing to compact yet"}},"durable":{"aggregateID":"ses-root","seq":9,"version":1}})).unwrap();
    assert!(matches!(change, Change::Compact { phase: "failed", .. }), "unexpected change: {}", std::any::type_name_of_val(&change));
    publish(&target, &mut state, change);
    drop(state);
    let emitted = drain(&mut events);
    assert!(emitted.iter().any(|one| one.kind == "chat.error" && one.data["reason"] == "compact_failed"));
    assert!(emitted.iter().all(|one| one.kind != "chat.item"));
    assert!(emitted.iter().any(|one| one.kind == "chat.turn.completed" && one.data["status"] == "failed"));
    assert!(target.active.lock().unwrap().is_none());
}

#[test]
fn v2_compact_completion_and_receipt_before_response_emit_exactly_one_receipt() {
    let (target, mut events) = target("");
    *target.compact_pending.lock().unwrap() = Some(OpenCodeCompact { turn: "turn-1".into(), confirmed: false, idle_observed: false });
    // Terminal first, HTTP receipt second: the response completes it.
    target.compact_event("ended", Some("turn-1"), json!({}));
    assert_eq!(target.active.lock().unwrap().as_deref(), Some("turn-1"));
    assert!(drain(&mut events).is_empty());
    target.finish_compact("turn-1", Ok(())).unwrap();
    let emitted = drain(&mut events);
    assert_eq!(emitted.iter().filter(|one| one.kind == "chat.item").count(), 1);
    assert!(emitted.iter().any(|one| one.kind == "chat.item" && one.data["parts"][0]["text"] == "Conversation compacted by OpenCode."));
    assert_eq!(emitted.iter().filter(|one| one.kind == "chat.turn.completed").count(), 1);
    // A duplicate terminal writes nothing.
    target.compact_event("ended", Some("turn-1"), json!({}));
    assert!(drain(&mut events).is_empty());
}

#[test]
fn v2_automatic_compaction_inside_a_normal_turn_does_not_end_it() {
    let (target, mut events) = target("");
    // turn-1 is an ordinary prompt; nothing asked for compaction.
    target.compact_event("ended", Some("turn-1"), json!({}));
    assert_eq!(target.active.lock().unwrap().as_deref(), Some("turn-1"));
    assert!(drain(&mut events)
        .iter()
        .all(|one| one.kind != "chat.turn.completed" && one.kind != "chat.item"));
}

#[test]
fn v2_usage_title_and_retry_are_normalized_without_inventing_missing_values() {
    let (target, mut events) = target("");
    let assistant = fixture("assistant_row");
    {
        let mut state = target.v2.lock().unwrap();
        let change = state.seed_message("ses-root", &assistant["data"]).unwrap().expect("assistant snapshot");
        publish(&target, &mut state, change);
    }
    // Actual model evidence comes from the native assistant row.
    assert_eq!(target.ui.lock().unwrap().effective_model, Some(json!({"providerID":"qa-commandcode","modelID":"deepseek-v4.1-flash-fast"})));
    let step = root_event(fixture("step_ended"));
    let mut state = target.v2.lock().unwrap();
    let change = state.apply(&target.native_id, &step).unwrap();
    publish(&target, &mut state, change);
    drop(state);
    let context = drain(&mut events).into_iter().find(|one| one.kind == "chat.context").expect("usage");
    assert_eq!(context.data["usage"]["inputTokens"], 4338);
    assert_eq!(context.data["usage"]["outputTokens"], 12);
    assert_eq!(context.data["usage"]["cacheReadTokens"], 0);
    // Native output already includes reasoning tokens (v1 semantics).
    assert_eq!(context.data["usage"]["totalTokens"], 4338 + 12);
    assert_eq!(context.data["turnUsage"]["outputTokens"], 12);
    assert_eq!(context.data["model"], "qa-commandcode/deepseek-v4.1-flash-fast");
    // The session total is not turn usage, and a missing cache figure stays missing.
    let plain = root_event(fixture("usage_updated_missing_cache"));
    let mut state = target.v2.lock().unwrap();
    let change = state.apply(&target.native_id, &plain).unwrap();
    publish(&target, &mut state, change);
    drop(state);
    let context = drain(&mut events).into_iter().find(|one| one.kind == "chat.context").expect("usage");
    assert_eq!(context.data["usage"]["totalTokens"], 10);
    assert!(context.data["usage"].get("cacheReadTokens").is_none(), "missing stays missing");
    assert!(context.data.get("turnUsage").is_none(), "a session total is not this turn's usage");
    // A usage frame with no tokens at all writes nothing.
    let mut state = target.v2.lock().unwrap();
    let change = state.apply(&target.native_id, &json!({"id":"evt-empty-usage","type":"session.usage.updated","data":{"sessionID":"ses-root","cost":0}})).unwrap();
    publish(&target, &mut state, change);
    drop(state);
    assert!(drain(&mut events).iter().all(|one| one.kind != "chat.context"));
    // Title comes from the native rename event, never from the prompt.
    let mut renamed = root_event(fixture("renamed"));
    renamed["durable"]["seq"] = json!(20);
    let mut state = target.v2.lock().unwrap();
    let change = state.apply(&target.native_id, &renamed).unwrap();
    publish(&target, &mut state, change);
    drop(state);
    let title = drain(&mut events).into_iter().find(|one| one.kind == "chat.title").expect("title");
    assert_eq!(title.data["title"], "Run7 renamed");
    // Retry state is a transient status item, not a reply or a failure.
    let mut retry = root_event(fixture("retry_scheduled"));
    retry["durable"]["seq"] = json!(21);
    let mut state = target.v2.lock().unwrap();
    let change = state.apply(&target.native_id, &retry).unwrap();
    publish(&target, &mut state, change);
    drop(state);
    let retry = drain(&mut events).into_iter().find(|one| one.kind == "chat.item").expect("retry");
    assert_eq!(retry.data["parts"][0]["data"]["kind"], "providerRetry");
    assert_eq!(retry.data["parts"][0]["data"]["attempt"], 2);
    // Hidden compaction implementation messages never become replies.
    let compaction = fixture("compaction_row");
    let mut state = target.v2.lock().unwrap();
    assert!(state.seed_message("ses-root", &compaction["data"]).unwrap().is_none());
    drop(state);
    assert!(drain(&mut events).iter().all(|one| one.kind != "chat.item"), "no compaction reply");
}

#[test]
fn v2_answering_model_comes_from_the_native_step_not_from_a_selection() {
    // Run-8 gap: without an assistant snapshot (`Change::Message`) or a forced
    // refresh, `ui.effective_model` stayed empty, so a live 2.2.5 turn emitted
    // `chat.context` with usage only and `ChatItem.turnModel` stayed null.
    // `session.step.started` names the model that actually answered.
    let (target, mut events) = target("");
    let started = root_event(fixture("step_started"));
    {
        let mut state = target.v2.lock().unwrap();
        let change = state.apply(&target.native_id, &started).unwrap();
        publish(&target, &mut state, change);
    }
    assert!(drain(&mut events).is_empty(), "a step start is not a chat event on its own");
    let ended = root_event(fixture("step_ended"));
    {
        let mut state = target.v2.lock().unwrap();
        let change = state.apply(&target.native_id, &ended).unwrap();
        publish(&target, &mut state, change);
    }
    let context = drain(&mut events)
        .into_iter()
        .find(|one| one.kind == "chat.context")
        .expect("usage");
    // The projection turns this `model` into `ChatItem.turnModel` for the turn.
    assert_eq!(context.data["model"], "qa-commandcode/deepseek-v4.1-flash-fast");
    assert_eq!(context.data["model"].as_str().is_some(), true);
    assert_eq!(context.data["turnUsage"]["outputTokens"], 12);
    // A child step may name its own model, but it never becomes the root footer.
    let mut child = root_event(fixture("step_started"));
    child["id"] = json!("evt_step_started_child");
    child["data"]["sessionID"] = json!("ses-child");
    child["data"]["model"] = json!({"id":"child-model","providerID":"child-provider"});
    child["durable"]["seq"] = json!(30);
    let mut state = target.v2.lock().unwrap();
    let change = state.apply(&target.native_id, &child).unwrap();
    publish(&target, &mut state, change);
    assert_eq!(
        state.actual_model,
        Some(json!({"providerID":"qa-commandcode","modelID":"deepseek-v4.1-flash-fast"}))
    );
}

#[test]
fn v2_missing_native_model_evidence_stays_missing() {
    // No step start and no assistant row means no evidence. The footer must stay
    // empty rather than echo the next-turn selection.
    let (target, mut events) = target("");
    let mut ended = root_event(fixture("step_ended"));
    ended["data"].as_object_mut().unwrap().remove("model");
    let mut state = target.v2.lock().unwrap();
    let change = state.apply(&target.native_id, &ended).unwrap();
    publish(&target, &mut state, change);
    assert!(state.actual_model.is_none());
    assert!(target.ui.lock().unwrap().effective_model.is_none());
    drop(state);
    for event in drain(&mut events) {
        assert!(event.data.get("model").is_none(), "a missing model is not filled in");
    }
}
