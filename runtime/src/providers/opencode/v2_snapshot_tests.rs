use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc,
};

fn target() -> (
    EventTarget,
    tokio::sync::broadcast::Receiver<crate::providers::ProviderEvent>,
) {
    let (events, receiver) = crate::provider_events::tap_channel(64);
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

fn response(path: &str) -> String {
    match path {
        "/api/session/ses-root" => json!({"data":{"id":"ses-root","location":{"directory":"C:/isolated"},"time":{"created":0,"updated":2,"busy":1,"idle":2}}}).to_string(),
        "/api/session/ses-root/message?limit=128&order=desc" => json!({"data":[{"id":"msg-answer","type":"assistant","time":{"created":1},"content":[{"type":"text","text":"authoritative"}]}],"cursor":{"previous":null,"next":null}}).to_string(),
        "/api/session/active" => json!({"data":{}}).to_string(),
        "/api/session/ses-root/inbox" => json!({"data":[]}).to_string(),
        "/api/session/ses-root/form" => json!({"data":[{"id":"form-stale","sessionID":"ses-root","title":"stale","fields":[]}]}).to_string(),
        "/api/session/ses-root/permission" => json!({"data":[]}).to_string(),
        "/api/session/ses-root/message/msg-answer" => json!({"data":{"id":"msg-answer","type":"assistant","time":{"created":1},"content":[{"type":"text","text":"authoritative"}]}}).to_string(),
        "/api/session/ses-child"=>json!({"data":{"id":"ses-child","parentID":"ses-root","location":{"directory":"C:/isolated"},"time":{"created":0,"updated":3,"busy":1,"idle":2},"outcome":"succeeded"}}).to_string(),
        "/api/session/ses-child/message?limit=128&order=desc"=>json!({"data":[{"id":"msg-child","type":"assistant","time":{"created":1},"content":[{"type":"text","text":"child answer"}]}],"cursor":{}}).to_string(),
        "/api/session/ses-child/form"|"/api/session/ses-child/permission"=>json!({"data":[]}).to_string(),
        _ => json!({"error":"unexpected path"}).to_string(),
    }
}

fn peer(
    count: usize,
    gate: Arc<Mutex<()>>,
    fail_at: Option<usize>,
    hold_at: Option<usize>,
) -> (
    String,
    mpsc::Receiver<Vec<String>>,
    Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
    thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (paths_tx, paths_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (held_tx, held_rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        let mut paths = Vec::new();
        for index in 0..count {
            let started = Instant::now();
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(peer) => break peer,
                    Err(error)
                        if error.kind() == io::ErrorKind::WouldBlock
                            && started.elapsed() < Duration::from_secs(5) =>
                    {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("native recovery test peer timed out: {error}"),
                }
            };
            // Accepted sockets inherit the listener's non-blocking mode on Windows.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            loop {
                let read = stream.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if request.windows(4).any(|part| part == b"\r\n\r\n") {
                    break;
                }
            }
            assert!(
                gate.try_lock().is_ok(),
                "native HTTP happened while event_gate was held"
            );
            let request = String::from_utf8(request).unwrap();
            assert!(request.lines().any(|line| line
                .split_once(':')
                .is_some_and(|(name, value)| name.eq_ignore_ascii_case("authorization")
                    && value.trim() == "Basic b3BlbmNvZGU6cHc=")));
            let first = request.lines().next().unwrap();
            let path = first.split_whitespace().nth(1).unwrap().to_owned();
            paths.push(path.clone());
            if hold_at == Some(index) {
                held_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            }
            let (status, body) = if fail_at == Some(index) {
                ("500 Internal Server Error", "{}".to_owned())
            } else {
                ("200 OK", response(&path))
            };
            write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
        paths_tx.send(paths).unwrap();
    });
    (
        base,
        paths_rx,
        hold_at.map(|_| (release_tx, held_rx)),
        handle,
    )
}

#[test]
fn recover_reads_the_native_v2_snapshot_set_outside_event_gate_and_reconciles_buffered_delta() {
    let (mut target, mut events) = target();
    let (base, paths, _, peer) = peer(7, Arc::clone(&target.event_gate), None, None);
    target.base_url = base;
    target
        .v2
        .lock()
        .unwrap()
        .buffer(
            json!({"id":"evt-receipt","created":1,"type":"form.replied","data":{
                "id":"form-stale","sessionID":"ses-root","answer":{"ok":true}
            }}),
        )
        .unwrap();
    target.v2.lock().unwrap().buffer(json!({"id":"evt-live","created":2,"type":"session.text.delta","data":{
        "sessionID":"ses-root","assistantMessageID":"msg-answer","ordinal":0,"delta":" duplicate"
    }})).unwrap();
    recover(&target).unwrap();
    peer.join().unwrap();
    let paths = paths.recv().unwrap();
    assert_eq!(
        &paths[..6],
        [
            "/api/session/ses-root",
            "/api/session/ses-root/message?limit=128&order=desc",
            "/api/session/active",
            "/api/session/ses-root/inbox",
            "/api/session/ses-root/form",
            "/api/session/ses-root/permission",
        ]
    );
    assert_eq!(paths[6], "/api/session/ses-root/message/msg-answer");
    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    let answer = emitted
        .iter()
        .filter(|event| event.kind == "chat.item")
        .last()
        .unwrap();
    assert_eq!(answer.data["parts"][0]["text"], "authoritative");
    assert!(!target.v2.lock().unwrap().recovering);
    assert!(
        !target.v2.lock().unwrap().interaction_barrier,
        "receipt before stale form must prevent a pending barrier"
    );
}

#[test]
fn failed_recovery_endpoint_keeps_state_unknown_and_does_not_admit_or_resend_prompt() {
    let (mut target, _events) = target();
    let (base, paths, _, peer) = peer(3, Arc::clone(&target.event_gate), Some(2), None);
    target.base_url = base;
    let error = recover(&target).unwrap_err();
    peer.join().unwrap();
    assert_eq!(error.code, "provider_error");
    assert_eq!(paths.recv().unwrap().len(), 3);
    assert!(target.v2.lock().unwrap().recovering);
    assert_eq!(
        validate_send(&target).unwrap_err().code,
        "provider_recovery_required"
    );
    assert!(target.active.lock().unwrap().is_none());
}

#[test]
fn delayed_recovery_after_expiry_publishes_no_snapshot_or_ready_state() {
    let (mut target, mut events) = target();
    let (base, paths, release, peer) = peer(6, Arc::clone(&target.event_gate), None, Some(5));
    target.base_url = base;
    let target = Arc::new(target);
    let recovering = Arc::clone(&target);
    let worker = thread::spawn(move || recover(&recovering));
    // The final endpoint is held after receiving its request, so no recovery
    // commit can race this expiry fence.
    let (release, held) = release.unwrap();
    held.recv_timeout(Duration::from_secs(5)).unwrap();
    expire_stream(
        &target,
        "test_recovery_expired",
        "expiry during v2 recovery",
    );
    release.send(()).unwrap();
    peer.join().unwrap();
    assert_eq!(
        worker.join().unwrap().unwrap_err().code,
        "provider_disconnected"
    );
    assert_eq!(paths.recv().unwrap().len(), 6);
    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    assert!(emitted
        .iter()
        .all(|event| event.kind != "chat.item" && event.kind != "session.ready"));
    assert_eq!(
        emitted
            .iter()
            .filter(|event| event.kind == "session.closed")
            .count(),
        1
    );
}

#[test]
fn completed_proven_child_snapshot_never_reopens_its_task_or_settles_root() {
    let (mut target, mut events) = target();
    target.v2.lock().unwrap().recovering = false;
    *target.active.lock().unwrap() = Some("root-operation".into());
    target.v2.lock().unwrap().seed_message("ses-root",&json!({"id":"msg-parent","type":"assistant","time":{"created":1},"content":[
        {"type":"tool","id":"task-call","name":"subagent","state":{"status":"completed","input":{},"content":[{"type":"text","text":"done"}],"metadata":{"sessionID":"ses-child"}}}
    ]})).unwrap();
    let (base, paths, _, peer) = peer(4, Arc::clone(&target.event_gate), None, None);
    target.base_url = base;
    recover_children(&target).unwrap();
    peer.join().unwrap();
    assert_eq!(paths.recv_timeout(Duration::from_secs(5)).unwrap().len(), 4);
    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    crate::providers::conformance::assert_no_parent_effect(&emitted, "chat-v2");
    assert!(emitted
        .iter()
        .filter(|e| e.kind == "chat.subagent")
        .all(|e| e.data["info"]["status"] == "completed"));
    assert!(emitted
        .iter()
        .any(|e| e.kind == "chat.subagent.item"
            && e.data["item"]["parts"][0]["text"] == "child answer"));
    assert_eq!(
        target.active.lock().unwrap().as_deref(),
        Some("root-operation")
    );
}
