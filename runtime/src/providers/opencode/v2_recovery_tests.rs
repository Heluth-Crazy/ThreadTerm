use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc,
};

fn target(
    active: Option<&str>,
) -> (
    EventTarget,
    tokio::sync::broadcast::Receiver<crate::providers::ProviderEvent>,
) {
    let (events, receiver) = crate::provider_events::tap_channel(32);
    (
        EventTarget {
            dialect: ApiDialect::V2,
            threadterm_session: "chat-v2".into(),
            native_id: "ses-root".into(),
            worker_token: "worker-v2".into(),
            events,
            active: Arc::new(Mutex::new(active.map(str::to_owned))),
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

fn full_message(text: &str) -> String {
    json!({"data":{"id":"msg-answer","type":"assistant","time":{"created":1},"content":[{"type":"text","text":text}]}}).to_string()
}

fn peer(
    body: String,
    wait: bool,
) -> (
    String,
    mpsc::Receiver<String>,
    Option<mpsc::Sender<()>>,
    thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let (request_tx, request_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let handle = thread::spawn(move || {
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
                Err(error) => panic!("test peer did not receive a request: {error}"),
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0; 1024];
        loop {
            let read = stream.read(&mut chunk).unwrap();
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..read]);
            if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        request_tx.send(String::from_utf8(bytes).unwrap()).unwrap();
        if wait {
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    (address, request_rx, wait.then_some(release_tx), handle)
}

#[test]
fn seeded_delta_uses_exact_v2_message_read_and_replaces_from_data_envelope() {
    let (mut target, mut events) = target(Some("turn-1"));
    let (base, requests, _, handle) = peer(full_message("native full value"), false);
    target.base_url = base;
    target.v2.lock().unwrap().seed_message("ses-root", &json!({
        "id":"msg-answer","type":"assistant","time":{"created":1},"content":[{"type":"text","text":"seed"}]
    })).unwrap();
    let delta = json!({"id":"evt-delta","created":2,"type":"session.text.delta","data":{
        "sessionID":"ses-root","assistantMessageID":"msg-answer","ordinal":0,"delta":" live"
    }});
    process_event(&target, delta, false);
    let request = requests.recv_timeout(Duration::from_secs(5)).unwrap();
    handle.join().unwrap();
    assert!(request.starts_with("GET /api/session/ses-root/message/msg-answer HTTP/1.1"));
    assert!(request.lines().any(|line| line
        .split_once(':')
        .is_some_and(|(name, value)| name.eq_ignore_ascii_case("authorization")
            && value.trim() == "Basic b3BlbmNvZGU6cHc=")));
    assert!(!request.starts_with("GET /session/"));
    let event = events.try_recv().unwrap();
    assert_eq!(event.kind, "chat.item");
    assert_eq!(event.data["parts"][0]["text"], "native full value");
}

#[test]
fn delayed_message_snapshot_after_stream_expiry_cannot_publish() {
    let (mut target, mut events) = target(Some("turn-1"));
    let (base, requests, release, handle) = peer(full_message("too late"), true);
    target.base_url = base;
    target.v2.lock().unwrap().seed_message("ses-root", &json!({
        "id":"msg-answer","type":"assistant","time":{"created":1},"content":[{"type":"text","text":"seed"}]
    })).unwrap();
    let target = Arc::new(target);
    let refresh_target = Arc::clone(&target);
    let reader = thread::spawn(move || refresh_message(&refresh_target, "ses-root", "msg-answer"));
    assert!(requests
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .starts_with("GET /api/session/ses-root/message/msg-answer"));
    expire_stream(&target, "test_expired", "expired before v2 snapshot");
    release.unwrap().send(()).unwrap();
    handle.join().unwrap();
    reader.join().unwrap().unwrap();
    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    assert!(emitted.iter().all(|event| event.kind != "chat.item"));
    assert_eq!(
        emitted
            .iter()
            .filter(|event| event.kind == "session.closed")
            .count(),
        1
    );
}

#[test]
fn recovery_buffer_receipt_wins_over_later_pending_snapshot_and_blocks_send() {
    let (target, mut events) = target(None);
    let receipt = json!({"id":"evt-receipt","created":1,"type":"form.replied","data":{
        "id":"form-1","sessionID":"ses-root","answer":{"name":"ok"}
    }});
    {
        let mut state = target.v2.lock().unwrap();
        state.recovering = true;
        state.buffer(receipt).unwrap();
        state.recovering = false;
        for raw in std::mem::take(&mut state.buffered) {
            let change = state.apply("ses-root", &raw).unwrap();
            publish(&target, &state, change);
        }
        let pending = json!({"id":"evt-pending","created":2,"type":"form.created","data":{"form":{
            "id":"form-1","sessionID":"ses-root","title":"later snapshot","fields":[]
        }}});
        assert!(matches!(
            state.apply("ses-root", &pending).unwrap(),
            Change::None
        ));
    }
    target.v2.lock().unwrap().interaction_barrier = true;
    assert_eq!(
        validate_send(&target).unwrap_err().code,
        "provider_recovery_required"
    );
    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    assert_eq!(
        emitted
            .iter()
            .filter(|event| event.data["requestID"] == "form-1")
            .count(),
        1
    );
}

#[test]
fn early_native_terminal_fences_a_late_failed_prompt_response() {
    let (target, mut events) = target(Some("turn-1"));
    reserve_prompt(&target, "turn-1").unwrap();
    let started = json!({"id":"evt-start","created":1,"type":"session.execution.started","durable":{"aggregateID":"ses-root","seq":1,"version":1},"data":{"sessionID":"ses-root"}});
    let finished = json!({"id":"evt-end","created":2,"type":"session.execution.succeeded","durable":{"aggregateID":"ses-root","seq":2,"version":1},"data":{"sessionID":"ses-root"}});
    process_event(&target, started, false);
    process_event(&target, finished, false);
    let late = ProviderError::new("provider_error", "late response")
        .with_details(json!({"httpStatus":503}));
    assert_eq!(
        finish_prompt(&target, "turn-1", Err(late))
            .unwrap_err()
            .code,
        "provider_error"
    );
    assert!(target.liveness.load(Ordering::SeqCst));
    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    assert_eq!(
        emitted
            .iter()
            .filter(|event| event.kind == "chat.turn.completed")
            .count(),
        1
    );
    assert_eq!(
        emitted
            .iter()
            .filter(|event| event.kind == "session.closed")
            .count(),
        0
    );
}

#[test]
fn proven_child_terminal_never_settles_the_root_turn() {
    let (target, mut events) = target(Some("root-operation"));
    {
        let mut state = target.v2.lock().unwrap();
        state
            .children
            .insert("ses-child".into(), "task-call".into());
        state
            .executions
            .entry("ses-child".into())
            .or_default()
            .running = true;
    }
    process_event(
        &target,
        json!({"id":"evt-child-terminal","created":4,"type":"session.execution.failed",
        "durable":{"aggregateID":"ses-child","seq":10,"version":1},"data":{"sessionID":"ses-child","error":{"name":"UnknownError","message":"child failed"}}}),
        false,
    );
    assert_eq!(
        target.active.lock().unwrap().as_deref(),
        Some("root-operation")
    );
    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    crate::providers::conformance::assert_no_parent_effect(&emitted, "chat-v2");
    assert_eq!(emitted.len(), 1);
    assert_eq!(emitted[0].kind, "chat.subagent");
    assert_eq!(emitted[0].worker_token.as_deref(), Some("worker-v2"));
}

#[test]
fn failure_after_native_activity_expires_once_without_prompt_replay() {
    let (target, mut events) = target(Some("turn-1"));
    reserve_prompt(&target, "turn-1").unwrap();
    process_event(
        &target,
        json!({"id":"evt-approval","created":1,"type":"permission.asked",
        "data":{"sessionID":"ses-root","id":"per_early","action":"write","resources":["scratch"]}}),
        false,
    );
    let rejected = ProviderError::new("provider_error", "native rejected response")
        .with_details(json!({"httpStatus":400}));
    assert!(finish_prompt(&target, "turn-1", Err(rejected)).is_err());
    expire_stream(&target, "second_failure", "must not duplicate");
    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    assert_eq!(emitted.iter().filter(|e| e.kind == "chat.error").count(), 1);
    assert_eq!(
        emitted
            .iter()
            .filter(|e| e.kind == "session.closed")
            .count(),
        1
    );
    assert!(emitted.iter().all(|e| e.kind != "chat.turn.completed"));
}

#[test]
fn an_old_http_result_cannot_expire_a_newer_local_turn() {
    let (target, mut events) = target(Some("turn-new"));
    reserve_prompt(&target, "turn-new").unwrap();
    let error = ProviderError::new("provider_disconnected", "old response lost");
    assert!(finish_prompt(&target, "turn-old", Err(error)).is_err());
    assert!(current(&target));
    assert_eq!(target.active.lock().unwrap().as_deref(), Some("turn-new"));
    assert!(events.try_recv().is_err());
}

#[test]
fn overflow_eof_and_late_old_worker_events_share_one_terminal_fence() {
    let (target, mut events) = target(Some("turn-1"));
    target.v2.lock().unwrap().recovering = true;
    for index in 0..=MAX_BUFFERED_EVENTS {
        emit_event(
            &target,
            json!({"id":format!("evt-{index}"),"created":1,"type":"server.connected","data":{}}),
        );
    }
    assert!(!current(&target));
    expire_stream(&target, "event_stream_disconnected", "EOF");
    target.stopped.store(true, Ordering::SeqCst);
    emit_event(
        &target,
        json!({"id":"evt-too-late","created":2,"type":"session.execution.started","durable":{"aggregateID":"ses-root","seq":20,"version":1},"data":{"sessionID":"ses-root"}}),
    );
    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    assert_eq!(emitted.iter().filter(|e| e.kind == "chat.error").count(), 1);
    assert_eq!(
        emitted
            .iter()
            .filter(|e| e.kind == "session.closed")
            .count(),
        1
    );
    assert!(emitted.iter().all(|e| e.kind != "chat.turn.started"));
}

#[test]
fn recovery_requires_persisted_execution_and_inbox_evidence_not_just_active_map() {
    let make = |time, messages, inbox| Recovery {
        session: json!({"id":"ses-root","time":time}),
        messages,
        active: json!({}),
        inbox,
        permissions: json!([]),
        forms: json!([]),
    };
    assert!(busy(
        &make(json!({"busy":20,"idle":10}), vec![], json!([])),
        "ses-root"
    )
    .unwrap());
    assert!(!busy(
        &make(json!({"busy":20,"idle":30}), vec![], json!([])),
        "ses-root"
    )
    .unwrap());
    assert!(!busy(
        &make(
            json!({"busy":20,"idle":30}),
            vec![],
            json!([{"id":"queued"}])
        ),
        "ses-root"
    )
    .unwrap());
    assert!(busy(
        &make(json!({}), vec![json!({"type":"assistant"})], json!([])),
        "ses-root"
    )
    .is_err());
    assert!(busy(
        &make(json!({"busy":"invalid"}), vec![], json!([])),
        "ses-root"
    )
    .is_err());
}

#[test]
fn durable_final_values_survive_a_lagging_projected_snapshot() {
    let mut state = State::default();
    let row = json!({"id":"msg-answer","type":"assistant","time":{"created":1},"content":[
        {"type":"text","text":"draft"},
        {"type":"tool","id":"tool-1","name":"shell","state":{"status":"running","input":{},"metadata":{}}}
    ]});
    state.seed_message("ses-root", &row).unwrap();
    let ended = json!({"id":"evt-final","created":2,"type":"session.text.ended","durable":{"aggregateID":"ses-root","seq":3,"version":1},
        "data":{"sessionID":"ses-root","assistantMessageID":"msg-answer","ordinal":0,"text":"final answer"}});
    assert!(
        matches!(state.apply("ses-root",&ended).unwrap(),Change::Message {parts,..} if parts[0]["text"]=="final answer")
    );
    let tool = json!({"id":"evt-tool-final","created":3,"type":"session.tool.success","durable":{"aggregateID":"ses-root","seq":4,"version":2},
        "data":{"sessionID":"ses-root","assistantMessageID":"msg-answer","id":"tool-1","executed":true,"content":[{"type":"text","text":"final output"}]}});
    state.apply("ses-root", &tool).unwrap();
    let Change::Message { parts, .. } = state.seed_message("ses-root", &row).unwrap().unwrap()
    else {
        panic!("message expected")
    };
    assert_eq!(parts[0]["text"], "final answer");
    assert_eq!(parts[1]["status"], "completed");
    assert_eq!(
        parts[1]["data"]["state"]["content"][0]["text"],
        "final output"
    );
}

#[test]
fn matching_receipts_and_inbox_delivery_release_their_own_send_barriers() {
    let (target, _events) = target(None);
    process_event(
        &target,
        json!({"id":"evt-ask","created":1,"type":"permission.asked","data":{"id":"per_1","sessionID":"ses-root","action":"write","resources":["scratch"]}}),
        false,
    );
    assert!(validate_send(&target).is_err());
    process_event(
        &target,
        json!({"id":"evt-other-receipt","created":2,"type":"permission.replied","data":{"requestID":"per_other","sessionID":"ses-root","reply":"once"}}),
        false,
    );
    assert!(validate_send(&target).is_err());
    process_event(
        &target,
        json!({"id":"evt-right-receipt","created":3,"type":"permission.replied","data":{"requestID":"per_1","sessionID":"ses-root","reply":"once"}}),
        false,
    );
    assert!(validate_send(&target).is_ok());
    process_event(
        &target,
        json!({"id":"evt-enqueued","created":4,"type":"session.inbox.enqueued","durable":{"aggregateID":"ses-root","seq":1,"version":1},"data":{"sessionID":"ses-root","inboxID":"msg_queued","item":{}}}),
        false,
    );
    assert!(validate_send(&target).is_err());
    process_event(
        &target,
        json!({"id":"evt-delivered","created":5,"type":"session.inbox.delivered","durable":{"aggregateID":"ses-root","seq":2,"version":1},"data":{"sessionID":"ses-root","inboxID":"msg_queued"}}),
        false,
    );
    assert!(validate_send(&target).is_ok());
}

#[test]
fn full_valid_event_queue_reserves_eof_without_discarding_accepted_frames() {
    let (mut target, mut events) = target(Some("turn-1"));
    let (base, requests, release, peer) = peer(full_message("snapshot"), true);
    target.base_url = base;
    target.v2.lock().unwrap().seed_message("ses-root",&json!({"id":"msg-answer","type":"assistant","time":{"created":1},"content":[{"type":"text","text":"seed"}]})).unwrap();
    let target = Arc::new(target);
    let queue = EventQueue::start(Arc::clone(&target)).unwrap();
    queue.push(json!({"id":"evt-first","created":1,"type":"session.text.delta","data":{"sessionID":"ses-root","assistantMessageID":"msg-answer","ordinal":0,"delta":"native"}}));
    requests.recv_timeout(Duration::from_secs(5)).unwrap();
    for index in 0..MAX_BUFFERED_EVENTS {
        queue.push(json!({"id":format!("evt-global-{index}"),"created":2,"type":"server.connected","data":{}}));
    }
    queue.eof();
    assert!(
        current(&target),
        "EOF must fit behind all accepted data frames"
    );
    release.unwrap().send(()).unwrap();
    peer.join().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while current(&target) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(!current(&target));
    assert_eq!(queue.count.load(Ordering::SeqCst), 0);
    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    assert_eq!(
        emitted
            .iter()
            .filter(|event| event.kind == "chat.item")
            .count(),
        1
    );
    assert_eq!(
        emitted
            .iter()
            .filter(|event| event.kind == "session.closed")
            .count(),
        1
    );
    assert_eq!(
        emitted
            .iter()
            .find(|event| event.kind == "session.closed")
            .unwrap()
            .data["reason"],
        "event_stream_disconnected"
    );
}

#[test]
fn natural_completion_before_noop_stop_response_keeps_the_stream_usable() {
    let (target, mut events) = target(Some("turn-1"));
    *target.abort_pending.lock().unwrap() = Some(OpenCodeAbort {
        turn: "turn-1".into(),
        confirmed: false,
        idle_observed: false,
    });
    process_event(
        &target,
        json!({"id":"evt-start","created":1,"type":"session.execution.started","durable":{"aggregateID":"ses-root","seq":1,"version":1},"data":{"sessionID":"ses-root"}}),
        false,
    );
    process_event(
        &target,
        json!({"id":"evt-completed","created":2,"type":"session.execution.succeeded","durable":{"aggregateID":"ses-root","seq":2,"version":1},"data":{"sessionID":"ses-root"}}),
        false,
    );
    target
        .finish_abort(
            "turn-1",
            Err(ProviderError::new(
                "abort_result_unknown",
                "interrupted false",
            )),
        )
        .unwrap();
    assert!(current(&target));
    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    assert_eq!(
        emitted
            .iter()
            .filter(|event| event.kind == "chat.turn.completed")
            .count(),
        1
    );
    assert!(emitted.iter().all(|event| event.kind != "session.closed"));
}

#[test]
fn terminal_tool_before_native_projection_uses_bounded_reads_without_replaying_it() {
    let (mut target, mut events) = target(Some("turn-1"));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    target.base_url = format!("http://{}", listener.local_addr().unwrap());
    let gate = Arc::clone(&target.event_gate);
    let server = thread::spawn(move || {
        for stage in 0..3 {
            let deadline = Instant::now() + Duration::from_secs(5);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(peer) => break peer,
                    Err(error)
                        if error.kind() == io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("tool projection peer timed out: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = String::new();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                request.push_str(&line);
            }
            assert!(request.starts_with("GET /api/session/ses-root/message/msg-answer "));
            assert!(gate.try_lock().is_ok());
            let content = match stage {
                0 => json!([]),
                1 => {
                    json!([{"type":"tool","id":"call-shell","name":"shell","state":{"status":"streaming","input":"{"}}])
                }
                _ => {
                    json!([{"type":"tool","id":"call-shell","name":"shell","state":{"status":"running","input":{"command":"dir"},"metadata":{}}}])
                }
            };
            let body=json!({"data":{"id":"msg-answer","type":"assistant","time":{"created":1},"content":content}}).to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        }
    });
    process_event(
        &target,
        json!({"id":"evt-tool-final","created":2,"type":"session.tool.success","durable":{"aggregateID":"ses-root","seq":4,"version":2},
        "data":{"sessionID":"ses-root","assistantMessageID":"msg-answer","id":"call-shell","executed":true,"content":[{"type":"text","text":"native final output"}]}}),
        false,
    );
    server.join().unwrap();
    assert!(current(&target));
    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    assert_eq!(emitted.len(), 1);
    assert_eq!(emitted[0].kind, "chat.item");
    assert_eq!(emitted[0].data["parts"][0]["status"], "completed");
    assert_eq!(
        emitted[0].data["parts"][0]["data"]["result"]["content"][0]["text"],
        "native final output"
    );
}

#[test]
fn failed_execution_keeps_error_details_with_one_terminal_settlement() {
    let (target, mut events) = target(Some("turn-1"));
    process_event(
        &target,
        json!({"id":"evt-start","created":1,"type":"session.execution.started","durable":{"aggregateID":"ses-root","seq":1,"version":1},"data":{"sessionID":"ses-root"}}),
        false,
    );
    let failed = json!({"id":"evt-failed","created":2,"type":"session.execution.failed","durable":{"aggregateID":"ses-root","seq":2,"version":1},"data":{"sessionID":"ses-root","error":{"type":"provider","message":"native failure detail"}}});
    process_event(&target, failed.clone(), false);
    process_event(&target, failed, false);
    let emitted = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    assert_eq!(
        emitted
            .iter()
            .filter(|event| event.kind == "chat.turn.completed")
            .count(),
        1
    );
    let error = emitted
        .iter()
        .find(|event| event.kind == "chat.item")
        .unwrap();
    assert_eq!(
        error.data["parts"][0]["data"]["error"]["message"],
        "native failure detail"
    );
    assert!(target.active.lock().unwrap().is_none());
}

#[test]
fn seeded_tool_full_input_and_called_arguments_survive_lagging_snapshots_until_result() {
    let mut state = State::default();
    let stale = json!({"id":"msg-answer","type":"assistant","time":{"created":1},"content":[
        {"type":"tool","id":"call-shell","name":"shell","state":{"status":"streaming","input":"{"}}
    ]});
    state.seed_message("ses-root", &stale).unwrap();
    let ended = json!({"id":"evt-input-ended","created":2,"type":"session.tool.input.ended","durable":{"aggregateID":"ses-root","seq":2,"version":1},
        "data":{"sessionID":"ses-root","assistantMessageID":"msg-answer","id":"call-shell","text":"{\"command\":\"dir\"}"}});
    assert!(
        matches!(state.apply("ses-root",&ended).unwrap(),Change::Message {parts,..} if parts[0]["data"]["state"]["input"]=="{\"command\":\"dir\"}")
    );
    let called = json!({"id":"evt-called","created":3,"type":"session.tool.called","durable":{"aggregateID":"ses-root","seq":3,"version":1},
        "data":{"sessionID":"ses-root","assistantMessageID":"msg-answer","id":"call-shell","input":{"command":"dir"},"executed":true}});
    state.apply("ses-root", &called).unwrap();
    state.apply("ses-root",&json!({"id":"evt-progress","created":3,"type":"session.tool.progress",
        "data":{"sessionID":"ses-root","assistantMessageID":"msg-answer","id":"call-shell","metadata":{"phase":"running"}}})).unwrap();
    state.seed_message("ses-root", &stale).unwrap();
    let current = &state.messages[&("ses-root".into(), "msg-answer".into())];
    assert_eq!(
        current.content[&current.tools["call-shell"]]["state"]["input"],
        json!({"command":"dir"})
    );
    assert_eq!(
        current.content[&current.tools["call-shell"]]["state"]["metadata"]["phase"],
        "running"
    );
    let finished = json!({"id":"evt-tool-finished","created":4,"type":"session.tool.success","durable":{"aggregateID":"ses-root","seq":4,"version":2},
        "data":{"sessionID":"ses-root","assistantMessageID":"msg-answer","id":"call-shell","executed":true,"content":[{"type":"text","text":"output"}]}});
    state.apply("ses-root", &finished).unwrap();
    let Change::Message { parts, .. } = state.seed_message("ses-root", &stale).unwrap().unwrap()
    else {
        panic!("message expected")
    };
    assert_eq!(parts[0]["data"]["state"]["input"], json!({"command":"dir"}));
    assert_eq!(parts[0]["status"], "completed");
    assert_eq!(parts[0]["data"]["result"]["content"][0]["text"], "output");
}
