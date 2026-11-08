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
