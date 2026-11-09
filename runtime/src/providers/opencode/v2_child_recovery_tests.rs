use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc,
    time::{Duration, Instant},
};

fn target() -> (
    EventTarget,
    tokio::sync::broadcast::Receiver<crate::providers::ProviderEvent>,
) {
    let (events, receiver) = crate::provider_events::tap_channel(128);
    (
        EventTarget {
            dialect: ApiDialect::V2,
            threadterm_session: "chat-v2".into(),
            native_id: "ses-root".into(),
            worker_token: "worker-v2".into(),
            events,
            active: Arc::new(Mutex::new(None)),
            assembly: Default::default(),
            permissions: Default::default(),
            settled_permissions: Default::default(),
            subagents: Default::default(),
            permission_sessions: Default::default(),
            native_turn_observed: AtomicBool::new(false),
            stopped: Arc::new(AtomicBool::new(false)),
            event_gate: Arc::new(Mutex::new(())),
            liveness: Arc::new(AtomicBool::new(true)),
            // Bound a stalled loopback peer as well as the peer's own reads: recovery
            // must release the event gate and fail rather than hang a prompt forever.
            snapshot_client: Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap(),
            base_url: String::new(),
            directory: "C:/isolated".into(),
            username: "opencode".into(),
            password: "pw".into(),
            model_limits: Default::default(),
            ui: Mutex::new(OpenCodeOptions::default()),
            abort_pending: Default::default(),
            retry_visible: AtomicBool::new(false),
            compact_pending: Default::default(),
            ui_options_refreshing: Arc::new(AtomicBool::new(false)),
            v2: Mutex::new(State {
                recovering: true,
                ..Default::default()
            }),
        },
        receiver,
    )
}

// Source-derived v2.2.5 rows: session form receipts are ephemeral, while
// `subagent` tool state metadata identifies a candidate child session.
fn body(path: &str) -> String {
    let info = |id: &str, parent: Option<&str>| json!({"id":id,"parentID":parent,"location":{"directory":"C:/isolated"},"time":{"created":0,"updated":1,"busy":0,"idle":1}});
    match path {
        "/api/session/ses-root" => json!({"data":info("ses-root",None)}).to_string(),
        "/api/session/ses-root/message?limit=128&order=desc" => json!({"data":[{"id":"msg-root","type":"assistant","time":{"created":1},"content":[{"type":"tool","id":"call-root-child","name":"subagent","state":{"status":"running","input":{},"metadata":{"sessionID":"ses-child"}}}]}],"cursor":{}}).to_string(),
        "/api/session/active" => json!({"data":{}}).to_string(),
        "/api/session/ses-root/inbox" | "/api/session/ses-root/form" | "/api/session/ses-root/permission" => json!({"data":[]}).to_string(),
        "/api/session/ses-child" => json!({"data":info("ses-child",Some("ses-root"))}).to_string(),
        "/api/session/ses-child/message?limit=128&order=desc" => json!({"data":[{"id":"msg-child","type":"assistant","time":{"created":2},"content":[{"type":"tool","id":"call-child-grand","name":"subagent","state":{"status":"running","input":{},"metadata":{"sessionID":"ses-grand"}}}]}],"cursor":{}}).to_string(),
        "/api/session/ses-child/form" => json!({"data":[{"id":"form-child","sessionID":"ses-child","title":"stale child","fields":[{"key":"answer","title":"Answer","type":"string","required":true}]}]}).to_string(),
        "/api/session/ses-child/permission" => json!({"data":[]}).to_string(),
        "/api/session/ses-grand" => json!({"data":info("ses-grand",Some("ses-child"))}).to_string(),
        "/api/session/ses-grand/message?limit=128&order=desc" => json!({"data":[],"cursor":{}}).to_string(),
        "/api/session/ses-grand/form" => json!({"data":[{"id":"form-grand","sessionID":"ses-grand","title":"stale grandchild","fields":[{"key":"answer","title":"Answer","type":"string","required":true}]}]}).to_string(),
        "/api/session/ses-grand/permission" => json!({"data":[]}).to_string(),
        _ => panic!("unexpected native path {path}"),
    }
}

fn peer(gate: Arc<Mutex<()>>) -> (String, mpsc::Receiver<Vec<String>>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (done_tx, done_rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        let mut paths = Vec::new();
        for _ in 0..14 {
            let deadline = Instant::now() + Duration::from_secs(5);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(value) => break value,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        panic!("timed out waiting for native recovery read")
                    }
                    Err(error) => panic!("native recovery peer accept failed: {error}"),
                }
            };
            // Accepted sockets inherit the listener's non-blocking mode on Windows.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 1024];
            loop {
                let count = stream.read(&mut chunk).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    break;
                }
            }
            assert!(
                gate.try_lock().is_ok(),
                "recover performed network I/O under event_gate"
            );
            let request = String::from_utf8(request).unwrap();
            let first = request.lines().next().unwrap();
            assert!(
                first.starts_with("GET "),
                "recover must never mutate native state: {first}"
            );
            let authorization = request
                .lines()
                .find(|line| {
                    line.split_once(':')
                        .is_some_and(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                })
                .unwrap();
            assert_eq!(
                authorization.split_once(':').unwrap().1.trim(),
                "Basic b3BlbmNvZGU6cHc="
            );
            let path = first.split_whitespace().nth(1).unwrap().to_owned();
            let response = body(&path);
            paths.push(path);
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
        }
        done_tx.send(paths).unwrap();
    });
    (base, done_rx, handle)
}

#[test]
fn early_child_and_nested_receipts_survive_root_then_child_discovery_without_reviving_stale_forms()
{
    let (mut target, mut events) = target();
    let (base, paths, peer) = peer(Arc::clone(&target.event_gate));
    target.base_url = base;
    {
        let mut state = target.v2.lock().unwrap();
        for raw in [
            json!({"id":"evt-child-replied","created":1,"type":"form.replied","data":{"id":"form-child","sessionID":"ses-child","answer":{"answer":"ok"}}}),
            json!({"id":"evt-grand-replied","created":2,"type":"form.replied","data":{"id":"form-grand","sessionID":"ses-grand","answer":{"answer":"ok"}}}),
            json!({"id":"evt-fork-asked","created":3,"type":"permission.asked","data":{"id":"per_fork","sessionID":"ses-fork","action":"shell","resources":["*"],"metadata":{}}}),
        ] {
            state.buffer(raw).unwrap();
        }
    }
    recover(&target).unwrap();
    peer.join().unwrap();
    let paths = paths.recv().unwrap();
    assert_eq!(paths.len(), 14);
    assert!(paths.iter().all(|path| path.starts_with("/api/")));
    let state = target.v2.lock().unwrap();
    assert!(state.children.contains_key("ses-child"));
    assert_eq!(
        state.children.get("ses-child").map(String::as_str),
        Some("call-root-child")
    );
    assert_eq!(
        state.children.get("ses-grand").map(String::as_str),
        Some("call-root-child")
    );
    assert!(
        !state.interaction_barrier,
        "stale child forms with prior receipts must not block send"
    );
    drop(state);
    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    for id in ["form-child", "form-grand"] {
        assert!(
            emitted.iter().all(|event| !(event.data["requestID"] == id
                && event.data["requestType"] == "form.created")),
            "settled stale form {id} revived as pending"
        );
    }
    assert_eq!(
        emitted
            .iter()
            .filter(|event| event.data["requestID"] == "form-child"
                && event.data["requestType"] == "form.replied")
            .count(),
        1
    );
    assert_eq!(
        emitted
            .iter()
            .filter(|event| event.data["requestID"] == "form-grand"
                && event.data["requestType"] == "form.replied")
            .count(),
        1
    );
    assert!(
        emitted
            .iter()
            .all(|event| event.data["requestID"] != "per_fork"),
        "foreign permission projected"
    );
    assert!(
        emitted
            .iter()
            .all(|event| event.kind != "chat.turn.started"),
        "recovery must not replay a prompt"
    );
}

#[test]
fn concurrent_child_hydration_cannot_overwrite_a_completed_child() {
    let (mut target, mut events) = target();
    target.v2.lock().unwrap().recovering = false;
    target.v2.lock().unwrap().task_candidates.insert(
        "ses-child".into(),
        ("ses-root".into(), "call-root-child".into()),
    );
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    target.base_url = format!("http://{}", listener.local_addr().unwrap());
    let target = Arc::new(target);
    let (first_tx, first_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let gate = Arc::clone(&target.event_gate);
    let peer = thread::spawn(move || {
        let mut stalled = None;
        let mut first_channels = Some((first_tx, release_rx));
        for index in 0..8 {
            let deadline = Instant::now() + Duration::from_secs(5);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(value) => break value,
                    Err(error)
                        if error.kind() == io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("child peer accept: {error}"),
                }
            };
            // Accepted sockets inherit the listener's non-blocking mode on Windows.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                request.push_str(&line);
            }
            assert!(gate.try_lock().is_ok(), "child I/O held event_gate");
            let path = request
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap();
            assert!(request.starts_with("GET "));
            let response = match path {
                "/api/session/ses-child" => json!({"data":{"id":"ses-child","parentID":"ses-root","location":{"directory":"C:/isolated"},"time":{"busy":2,"idle":1}}}).to_string(),
                "/api/session/ses-child/message?limit=128&order=desc" => json!({"data":[],"cursor":{}}).to_string(),
                "/api/session/ses-child/form" | "/api/session/ses-child/permission" => json!({"data":[]}).to_string(),
                _ => panic!("unexpected path {path}"),
            };
            if index == 0 {
                let (first_tx, release_rx) = first_channels.take().unwrap();
                stalled = Some(thread::spawn(move || {
                    first_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).unwrap();
                }));
            } else {
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).unwrap();
            }
        }
        stalled.unwrap().join().unwrap();
    });
    let first_target = Arc::clone(&target);
    let first = thread::spawn(move || recover_children(&first_target));
    first_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    recover_children(&target).unwrap();
    process_event(
        &target,
        json!({"id":"evt-child-complete","created":3,"type":"session.execution.succeeded","durable":{"aggregateID":"ses-child","seq":2,"version":1},"data":{"sessionID":"ses-child"}}),
        false,
    );
    release_tx.send(()).unwrap();
    first.join().unwrap().unwrap();
    peer.join().unwrap();
    assert!(
        !target.v2.lock().unwrap().executions["ses-child"].running,
        "late same-worker hydration revived a completed child"
    );
    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    let statuses = emitted
        .iter()
        .filter(|event| event.kind == "chat.subagent")
        .map(|event| event.data["info"]["status"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(statuses, ["running", "completed"]);
    assert!(emitted
        .iter()
        .all(|event| event.kind != "chat.turn.completed"));
}

#[test]
fn attachment_drains_early_burst_and_eof_before_delayed_metadata_returns() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (metadata_tx, metadata_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (burst_tx, burst_rx) = mpsc::channel();
    let finished = Arc::new(AtomicBool::new(false));
    let peer_finished = Arc::clone(&finished);
    let peer = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut first_read = Some((metadata_tx, release_rx, burst_tx));
        let mut burst_rx = Some(burst_rx);
        let mut sse = None;
        while !peer_finished.load(Ordering::SeqCst) {
            let (mut stream, _) = match listener.accept() {
                Ok(value) => value,
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(error) => panic!("startup peer accept: {error}"),
            };
            // Accepted sockets inherit the listener's non-blocking mode on Windows.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                request.push_str(&line);
            }
            let path = request
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap();
            assert!(request.starts_with("GET "));
            if path == "/api/event" {
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").unwrap();
                let burst_rx = burst_rx.take().unwrap();
                sse = Some(thread::spawn(move || {
                    burst_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    for index in 0..32 {
                        writeln!(stream, "data: {{\"id\":\"evt-{index}\",\"created\":1,\"type\":\"server.connected\",\"data\":{{}}}}\n").unwrap();
                    }
                    // A complete native heartbeat and EOF arrive while the first
                    // metadata read remains blocked; both must be drained now.
                    write!(stream, ": heartbeat\n\n").unwrap();
                }));
                continue;
            }
            if let Some((metadata_tx, release_rx, burst_tx)) = first_read.take() {
                assert_eq!(path, "/api/session/ses-root");
                metadata_tx.send(()).unwrap();
                burst_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            }
            let response = match path {
                "/api/session/ses-root/message?limit=128&order=desc" => {
                    json!({"data":[],"cursor":{}}).to_string()
                }
                _ => body(path),
            };
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).unwrap();
        }
        sse.unwrap().join().unwrap();
    });
    // An inert, owned process satisfies the server handle; no native CLI or
    // production profile is discovered or launched by this regression.
    #[cfg(windows)]
    let spec = CommandSpec::from_path(
        std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        vec![
            "-NoProfile".into(),
            "-Command".into(),
            "Start-Sleep -Seconds 30".into(),
        ],
    )
    .unwrap();
    #[cfg(not(windows))]
    let spec = CommandSpec::from_path(
        std::path::PathBuf::from("/bin/sh"),
        vec!["-c".into(), "sleep 30".into()],
    )
    .unwrap();
    let (child, job) = spawn_managed_service(&spec, None, &[]).unwrap();
    let (events, mut receiver) = crate::provider_events::tap_channel(128);
    let server = OpenCodeServer {
        dialect: ApiDialect::V2,
        base_url: base.clone(),
        cwd: "C:/wrong-process-cwd".into(),
        username: "opencode".into(),
        password: "pw".into(),
        client: Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap(),
        child: Arc::new(Mutex::new(child)),
        stopped: Arc::new(AtomicBool::new(false)),
        event_gate: Arc::new(Mutex::new(())),
        active_turn: Arc::new(Mutex::new(None)),
        permissions: Default::default(),
        events,
        threadterm_session: "chat-startup".into(),
        worker_token: "worker-startup".into(),
        _job: job,
    };
    let response = Client::builder()
        .timeout(None)
        .build()
        .unwrap()
        .get(format!("{base}/api/event"))
        .send()
        .unwrap();
    let attachment = thread::spawn(move || {
        attach(
            &server,
            "ses-root",
            &json!({"id":"ses-root","location":{"directory":"C:/isolated"}}),
            response,
        )
    });
    metadata_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    let drained_before_metadata = loop {
        if let Ok(event) = receiver.try_recv() {
            if event.kind == "session.closed" {
                break true;
            }
        }
        if Instant::now() >= deadline {
            break false;
        }
        thread::sleep(Duration::from_millis(5));
    };
    release_tx.send(()).unwrap();
    let result = attachment.join().unwrap();
    finished.store(true, Ordering::SeqCst);
    peer.join().unwrap();
    assert!(
        drained_before_metadata,
        "SSE reader did not drain burst/EOF until metadata returned"
    );
    match result {
        Ok(_) => panic!("EOF during attachment must never become ready"),
        Err(error) => assert_eq!(error.code, "provider_disconnected"),
    }
}


// Run 14: the live 2.2.5 row. The child identity is only in the tool's own
// output marker; `state.metadata.sessionID` (which older builds sent) is absent.
const CAPTURED_MARKER: &str = "<subagent sessionID=\"ses-child\" state=\"completed\">\nCHILD_TOKEN=run13-child-only-sentinel\n</subagent>";
const CAPTURED_CALL: &str = "call_00_00nbmxypmo2jscbfnpf0tkyo";

/// Serves the child reads `recover_children` performs, with a caller-chosen
/// native parent link, until the test closes it.
fn child_peer(parent: &'static str) -> (String, Arc<AtomicBool>, thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let finished = Arc::new(AtomicBool::new(false));
    let stop = Arc::clone(&finished);
    let handle = thread::spawn(move || {
        let mut paths = Vec::new();
        while !stop.load(Ordering::SeqCst) {
            let deadline = Instant::now() + Duration::from_secs(5);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(value) => break value,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => return paths,
                }
            };
            // Accepted sockets inherit the listener's non-blocking mode on Windows.
            stream.set_nonblocking(false).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                request.push_str(&line);
            }
            let path = request.lines().next().unwrap().split_whitespace().nth(1).unwrap().to_owned();
            paths.push(path.clone());
            let body = match path.as_str() {
                "/api/session/ses-child" => json!({"data":{"id":"ses-child","parentID":parent,"location":{"directory":"C:/isolated"},"time":{"busy":1,"idle":2},"outcome":"succeeded"}}).to_string(),
                "/api/session/ses-child/message?limit=128&order=desc" => json!({"data":[],"cursor":{}}).to_string(),
                "/api/session/ses-child/form" | "/api/session/ses-child/permission" => json!({"data":[]}).to_string(),
                other => panic!("unexpected child path {other}"),
            };
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
        paths
    });
    (base, finished, handle)
}

fn tool_events() -> Vec<Value> {
    vec![
        json!({"id":"evt-tool-start","created":1,"type":"session.tool.input.started","data":{"sessionID":"ses-root","assistantMessageID":"msg-root","id":CAPTURED_CALL,"name":"subagent"}}),
        json!({"id":"evt-tool-called","created":1,"type":"session.tool.called","data":{"sessionID":"ses-root","assistantMessageID":"msg-root","id":CAPTURED_CALL,"input":{"agent":"general","description":"Extract the child token"}}}),
        json!({"id":"evt-tool-success","created":1,"type":"session.tool.success","data":{"sessionID":"ses-root","assistantMessageID":"msg-root","id":CAPTURED_CALL,"name":"subagent","content":[{"type":"text","text":CAPTURED_MARKER}]}}),
    ]
}

/// Apply and publish without the recovery read, so a test can call
/// `recover_children` itself and see its verdict.
fn push_event(target: &EventTarget, raw: Value) {
    let change = target
        .v2
        .lock()
        .unwrap()
        .apply(&target.native_id, &raw)
        .unwrap();
    publish(target, &mut target.v2.lock().unwrap(), change);
}

#[test]
fn a_captured_225_marker_binds_the_child_only_through_the_verified_parent_link() {
    let (base, finished, peer) = child_peer("ses-root");
    let (mut target, mut events) = target();
    target.base_url = base;
    target.v2.lock().unwrap().recovering = false;
    for raw in tool_events() {
        process_event(&target, raw, false);
    }
    finished.store(true, Ordering::SeqCst);
    let paths = peer.join().unwrap();
    assert!(paths.iter().any(|path| path == "/api/session/ses-child"), "the marker names the child: {paths:?}");
    let state = target.v2.lock().unwrap();
    // Run 15 (finding A4): a proven claim is pruned from the candidate map, so
    // repeated subagents cannot exhaust the ownership bound. Ownership itself
    // stays proven by the verified parent link below.
    assert!(!state.task_candidates.contains_key("ses-child"));
    assert_eq!(state.children["ses-child"], CAPTURED_CALL);
    assert_eq!(state.parents["ses-child"], "ses-root");
    drop(state);
    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    let cards = emitted
        .iter()
        .filter(|one| one.kind == "chat.subagent" && one.data["key"] == CAPTURED_CALL)
        .collect::<Vec<_>>();
    let card = cards
        .iter()
        .find(|one| one.data["info"].get("native").is_some())
        .expect("the child card names its native child session");
    assert_eq!(card.data["info"]["native"]["id"], "ses-child");
    assert_eq!(card.data["info"]["status"], "completed");
    // The tool card carries what the model asked for; the bound card carries the
    // native identity. The renderer merges the two by key.
    let described = cards
        .iter()
        .find(|one| one.data["info"].get("agentType").is_some())
        .expect("the tool card keeps the delegated agent");
    assert_eq!(described.data["info"]["agentType"], "general");
    assert_eq!(described.data["info"]["description"], "Extract the child token");
    assert!(emitted.iter().all(|one| one.kind != "chat.turn.completed"));
}

#[test]
fn a_marker_naming_an_unrelated_session_never_owns_it() {
    let (base, finished, peer) = child_peer("ses-other");
    let (mut target, _events) = target();
    target.base_url = base;
    target.v2.lock().unwrap().recovering = false;
    for raw in tool_events() {
        push_event(&target, raw);
    }
    // The candidate comes from the marker, but the native parent link disproves
    // it: ownership is never taken from the marker alone.
    let error = recover_children(&target).unwrap_err();
    finished.store(true, Ordering::SeqCst);
    let _ = peer.join().unwrap();
    assert_eq!(error.message, "OpenCode v2 task metadata does not prove child ownership");
    let state = target.v2.lock().unwrap();
    assert!(!state.children.contains_key("ses-child"));
    assert!(state.parents.is_empty());
}

/// A peer that answers the four reads `recover_children` performs for one proven
/// child candidate. Reused by the prune-order test through the real recovery
/// path.
fn prune_peer(
    child: &'static str,
    parent: &'static str,
) -> (String, mpsc::Receiver<Vec<String>>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (sender, paths) = mpsc::channel();
    let handle = thread::spawn(move || {
        let mut seen = Vec::new();
        for _ in 0..4 {
            let deadline = Instant::now() + Duration::from_secs(5);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(value) => break value,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("child peer accept failed: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 1024];
            loop {
                let count = stream.read(&mut chunk).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    break;
                }
            }
            let first = String::from_utf8(request).unwrap();
            let path = first.split_whitespace().nth(1).unwrap().to_owned();
            let body = if path == format!("/api/session/{child}") {
                json!({"data":{"id":child,"parentID":parent,"location":{"directory":"C:/isolated"},"time":{"created":0,"updated":1,"busy":0,"idle":1}}}).to_string()
            } else if path.contains("/message?") {
                json!({"data":[],"cursor":{}}).to_string()
            } else {
                json!({"data":[]}).to_string()
            };
            seen.push(path);
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
        sender.send(seen).unwrap();
    });
    (base, paths, handle)
}

#[test]
fn a_waiting_childs_card_keeps_its_owner_when_settled_children_are_pruned() {
    // Verification round 2, item 4: the bound pruned any settled child in map
    // order. A settled child that still owns a pending card lost its proven
    // owner (and its form route) to a sibling that owns nothing.
    let (mut target, _events) = target();
    let awaiting = "ses-awaiting";
    {
        let mut state = target.v2.lock().unwrap();
        state.children.insert(awaiting.into(), "call-awaiting".into());
        state.parents.insert(awaiting.into(), "ses-root".into());
        state.interactions.insert(
            "frm-awaiting".into(),
            Interaction {
                session: awaiting.into(),
                kind: "form.created".into(),
                turn: Some(NATIVE_BUSY_TURN.into()),
                payload: json!({"interaction":"question"}),
            },
        );
        for index in 0..MAX_SESSIONS - 1 {
            let child = format!("ses-settled-{index}");
            state.children.insert(child.clone(), "call".into());
            state.parents.insert(child.clone(), "ses-root".into());
            let execution = state.executions.entry(child).or_default();
            execution.terminal_seq = Some(index as u64 + 1);
        }
        state
            .task_candidates
            .insert("ses-new".into(), ("ses-root".into(), "call-new".into()));
        state.recovering = true;
    }
    let (base, paths, peer) = prune_peer("ses-new", "ses-root");
    target.base_url = base;
    recover_children(&target).unwrap();
    peer.join().unwrap();
    assert_eq!(paths.recv().unwrap().len(), 4);
    let state = target.v2.lock().unwrap();
    assert!(
        state.children.contains_key(awaiting),
        "the child whose card is still waiting kept its proven owner"
    );
    let pruned = (0..MAX_SESSIONS - 1)
        .filter(|index| !state.children.contains_key(&format!("ses-settled-{index}")))
        .count();
    assert_eq!(
        pruned, 1,
        "exactly one settled child without a pending card was pruned (map order is arbitrary)"
    );
    assert!(state.children.contains_key("ses-new"), "the newly proven child is kept");
    assert!(
        state.interactions.contains_key("frm-awaiting"),
        "the waiting card is untouched"
    );
    assert!(state.children.len() <= MAX_SESSIONS);
}

/// A reconnect peer that still lists one pending native form on a proven child.
fn reconnect_peer() -> (String, mpsc::Receiver<Vec<String>>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (sender, paths) = mpsc::channel();
    let handle = thread::spawn(move || {
        let info = |id: &str, parent: Option<&str>| json!({"id":id,"parentID":parent,"location":{"directory":"C:/isolated"},"time":{"created":0,"updated":1,"busy":0,"idle":1}});
        let mut seen = Vec::new();
        for _ in 0..10 {
            let deadline = Instant::now() + Duration::from_secs(5);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(value) => break value,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("reconnect peer accept failed: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 1024];
            loop {
                let count = stream.read(&mut chunk).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    break;
                }
            }
            let first = String::from_utf8(request).unwrap();
            let path = first.split_whitespace().nth(1).unwrap().to_owned();
            let response = match path.as_str() {
                "/api/session/ses-root" => json!({"data":info("ses-root",None)}).to_string(),
                "/api/session/ses-root/message?limit=128&order=desc" => json!({"data":[{"id":"msg-root","type":"assistant","time":{"created":1},"content":[{"type":"tool","id":"call-root-child","name":"subagent","state":{"status":"running","input":{},"metadata":{"sessionID":"ses-child"}}}]}],"cursor":{}}).to_string(),
                "/api/session/active" => json!({"data":{}}).to_string(),
                "/api/session/ses-root/inbox" | "/api/session/ses-root/form" | "/api/session/ses-root/permission" => json!({"data":[]}).to_string(),
                "/api/session/ses-child" => json!({"data":info("ses-child",Some("ses-root"))}).to_string(),
                "/api/session/ses-child/message?limit=128&order=desc" => json!({"data":[],"cursor":{}}).to_string(),
                "/api/session/ses-child/form" => json!({"data":[{"id":"form-child","sessionID":"ses-child","title":"still pending","fields":[{"key":"answer","title":"Answer","type":"string","required":true}]}]}).to_string(),
                "/api/session/ses-child/permission" => json!({"data":[]}).to_string(),
                other => panic!("unexpected native path {other}"),
            };
            seen.push(path);
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
        }
        sender.send(seen).unwrap();
    });
    (base, paths, handle)
}

/// Verification round 4, rule 1 and its accepted limitation: the root turn
/// terminal retires a background child's card without writing to OpenCode, so a
/// request that was still pending stays pending on the native side. The child
/// waits until the Chat reconnects; the reconnect lists the pending native
/// request and raises the card again from a fresh state (no retirement receipt).
#[test]
fn a_card_expired_with_a_pending_native_request_is_raised_again_on_reconnect() {
    let (mut target, mut events) = target();
    target
        .v2
        .lock()
        .unwrap()
        .children
        .insert("ses-child".into(), "call-child".into());
    // A root execution no ThreadTerm turn reserved: the placeholder turn.
    push_event(
        &target,
        json!({"id":"evt-root-start","created":1,"type":"session.execution.started","durable":{"aggregateID":"ses-root","seq":1,"version":1},"data":{"sessionID":"ses-root"}}),
    );
    assert_eq!(
        target.active.lock().unwrap().as_deref(),
        Some(NATIVE_BUSY_TURN),
        "the native execution takes the placeholder turn"
    );
    push_event(
        &target,
        json!({"id":"evt-child-form","created":2,"type":"form.created","data":{"form":{"id":"form-child","sessionID":"ses-child","title":"QA","fields":[{"key":"answer","title":"Answer","type":"string","required":true}]}}}),
    );
    assert!(target.v2.lock().unwrap().interactions.contains_key("form-child"));
    // The root execution ends: the child's card is retired, nothing is written.
    push_event(
        &target,
        json!({"id":"evt-root-end","created":3,"type":"session.execution.succeeded","durable":{"aggregateID":"ses-root","seq":2,"version":1},"data":{"sessionID":"ses-root"}}),
    );
    {
        let state = target.v2.lock().unwrap();
        assert!(!state.interactions.contains_key("form-child"), "the ended turn retired the card");
        assert!(
            state
                .receipts
                .contains(&("ses-child".into(), "form-child".into())),
            "the retirement is a receipt, not an answer to the native request"
        );
    }
    let retired = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    assert!(retired.iter().any(|event| {
        event.kind == "chat.approval.resolved" && event.data["approvalId"] == "form-child"
    }));
    // Reconnect: a new worker state has no receipt, and the native request is
    // still listed, so it becomes a card again.
    *target.v2.lock().unwrap() = State {
        recovering: true,
        ..Default::default()
    };
    let (base, paths, peer) = reconnect_peer();
    target.base_url = base;
    recover(&target).unwrap();
    peer.join().unwrap();
    assert_eq!(paths.recv().unwrap().len(), 10);
    {
        let state = target.v2.lock().unwrap();
        let card = state
            .interactions
            .get("form-child")
            .expect("the still-pending native request is raised again");
        assert_eq!(card.session, "ses-child");
        assert_eq!(card.kind, "form.created");
        assert_eq!(card.turn.as_deref(), Some(NATIVE_BUSY_TURN));
        assert!(
            !state
                .receipts
                .contains(&("ses-child".into(), "form-child".into())),
            "the new state carries no receipt for the request it re-raised"
        );
    }
    let reconnected = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    assert!(
        reconnected
            .iter()
            .any(|event| event.kind == "chat.approval" && event.data["approvalId"] == "form-child"),
        "the reconnect publishes the card again: {:?}",
        reconnected.iter().map(|event| &event.kind).collect::<Vec<_>>()
    );
}
