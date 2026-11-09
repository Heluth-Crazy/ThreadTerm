use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc,
};

// P3a interaction suite: one card, one owner, one native write. The peer below
// is a real TCP listener, so every assertion is about the request that would
// have reached 2.2.5, not about an adapter-side intention.

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

/// One HTTP response, then the peer closes. The complete request text (headers
/// and body) is reported so a test can assert the exact native path and payload.
struct Peer {
    address: String,
    requests: mpsc::Receiver<String>,
    handle: thread::JoinHandle<()>,
}

fn peer(status: u16, body: &'static str) -> Peer {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let (sender, requests) = mpsc::channel();
    let handle = thread::spawn(move || {
        let started = Instant::now();
        let (mut stream, _) = loop {
            match listener.accept() {
                Ok(peer) => break peer,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock && started.elapsed() < Duration::from_secs(5) => {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(error) => panic!("test peer did not receive a request: {error}"),
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
        let (reason, body) = match status {
            204 => ("No Content", String::new()),
            _ => ("Error", body.to_owned()),
        };
        write!(
            stream,
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
    });
    Peer { address, requests, handle }
}

fn body(request: &str) -> Value {
    let start = request.find("\r\n\r\n").map(|index| index + 4).unwrap_or(0);
    serde_json::from_str(&request[start..]).unwrap()
}

fn start(request: &str) -> &str {
    request.lines().next().unwrap()
}

fn event(id: &str, kind: &str, data: Value) -> Value {
    json!({"id":id,"created":1,"type":kind,"data":data})
}

/// Apply one native event and publish the change, never holding two guards.
fn push(target: &EventTarget, raw: &Value) -> bool {
    let change = target
        .v2
        .lock()
        .unwrap()
        .apply(&target.native_id, raw)
        .unwrap();
    let pending = matches!(change, Change::Pending { .. });
    publish(target, &mut target.v2.lock().unwrap(), change);
    pending
}

fn form( id: &str, session: &str, fields: Value) -> Value {
    json!({"form":{"id":id,"sessionID":session,"title":"QA","fields":fields}})
}

fn pending_form(target: &EventTarget, id: &str, session: &str) {
    assert!(push(
        target,
        &event(
            "evt-form-created",
            "form.created",
            form(
                id,
                session,
                json!([{"key":"name","type":"string","title":"Name","required":true,"minLength":3,"maxLength":8}]),
            ),
        ),
    ));
}

fn drain(receiver: &mut tokio::sync::broadcast::Receiver<crate::providers::ProviderEvent>) -> Vec<crate::providers::ProviderEvent> {
    std::iter::from_fn(|| receiver.try_recv().ok()).collect()
}

fn captured(case: &str) -> Value {
    crate::providers::conformance::fixture("opencode-v2-native-forms.jsonl")
        .into_iter()
        .find(|row| row["case"] == case)
        .unwrap()["value"]["data"]
        .clone()
}

#[test]
fn pending_form_emits_the_stored_canonical_card_without_native_identity() {
    let (target, mut events) = target("");
    let mut info = captured("list_pending")[0].clone();
    // The captured session id is not this adapter's root; the card logic only
    // needs the request to be owned, so keep its own identity shape.
    info["sessionID"] = json!("ses-root");
    let session = info["sessionID"].as_str().unwrap().to_owned();
    let id = info["id"].as_str().unwrap().to_owned();
    push(&target, &event("evt-created", "form.created", json!({"form":info})));
    let emitted = drain(&mut events);
    let card = emitted.iter().find(|one| one.kind == "chat.approval").unwrap();
    assert_eq!(card.data["approvalId"], id);
    assert_eq!(card.data["part"]["status"], "pending");
    assert_eq!(card.turn_id.as_deref(), Some("turn-1"));
    let payload = &card.data["part"]["data"];
    assert_eq!(payload["interaction"], "question");
    assert_eq!(payload["answerable"], true);
    assert_eq!(payload["form"]["validation"], json!({"semantics":"opencode-v2","patternAndFormat":"native"}));
    assert!(payload["form"].get("native").is_none(), "native identity stays in adapter state");
    assert!(!payload.to_string().contains(&id), "the form id is not repeated in card data");
    assert!(!payload.to_string().contains(&session), "the owning session is not in card data");
    // The emitted payload is the stored schema: the shared validator and summary
    // accept the captured native-valid answer without a second mapping step.
    let answer = json!({"name":"ABC","count":2,"enabled":false,"mode":["red"],"external":true});
    crate::chat_questions::validate_response(payload, &json!({"action":"submit","values":answer})).unwrap();
    let summary = crate::chat_questions::answer_summary(payload, &json!({"action":"submit","values":answer}));
    assert_eq!(summary["name"], "ABC");
    assert_eq!(summary["enabled"], "false");
    // Native identities live beside the approval id, not in the card.
    let state = target.v2.lock().unwrap();
    assert_eq!(state.interactions[&id].session, session);
    assert_eq!(state.interactions[&id].kind, "form.created");
    assert_eq!(state.interactions[&id].turn.as_deref(), Some("turn-1"));
    drop(state);
    assert_eq!(validate_send(&target).unwrap_err().code, "provider_recovery_required");
}

#[test]
fn unrepresentable_form_keeps_only_a_diagnostic_and_stays_unanswerable() {
    let (target, mut events) = target("");
    push(
        &target,
        &event(
            "evt-future",
            "form.created",
            form("frm_future", "ses-root", json!([{"key":"k","type":"string","futureConstraint":true}])),
        ),
    );
    let emitted = drain(&mut events);
    assert!(emitted.iter().all(|one| one.kind != "chat.approval"));
    let diagnostic = emitted.iter().find(|one| one.kind == "provider.event").unwrap();
    assert_eq!(diagnostic.data["requestID"], "frm_future");
    assert_eq!(diagnostic.data["requestType"], "form.created");
    assert!(target.v2.lock().unwrap().interactions.is_empty());
    // Still a recovery barrier: no prompt may pass an unresolved native request.
    assert_eq!(validate_send(&target).unwrap_err().code, "provider_recovery_required");
    assert_eq!(answer(&target, "turn-1", "frm_future", &json!({"action":"dismiss"})).unwrap_err().code, "approval_not_pending");
}

#[test]
fn pending_permission_emits_an_allow_deny_card_bound_to_its_owner() {
    let (target, mut events) = target("");
    let request = json!({"id":"per_qa","sessionID":"ses-root","action":"p0.ask","resources":["p0://ask"]});
    push(&target, &event("evt-permission", "permission.asked", request.clone()));
    let emitted = drain(&mut events);
    let card = emitted.iter().find(|one| one.kind == "chat.approval").unwrap();
    let payload = &card.data["part"]["data"];
    assert_eq!(payload["interaction"], "permission");
    assert_eq!(payload["requestType"], "permission.asked");
    assert_eq!(payload["title"], "p0.ask");
    assert_eq!(payload["submittable"], true);
    assert_eq!(payload["details"], request);
    let choices = payload["choices"].as_array().unwrap();
    assert_eq!(choices.len(), 2);
    assert_eq!(choices[0]["choiceId"], "allow");
    assert_eq!(choices[1]["choiceId"], "deny");
    assert_eq!(card.data["approvalId"], "per_qa");
    assert_eq!(target.v2.lock().unwrap().interactions["per_qa"].session, "ses-root");
}

#[test]
fn native_answer_receipt_settles_the_card_once_and_a_stale_snapshot_cannot_revive_it() {
    let (target, mut events) = target("");
    pending_form(&target, "frm_receipt", "ses-root");
    let _ = drain(&mut events);
    push(
        &target,
        &event(
            "evt-replied",
            "form.replied",
            json!({"id":"frm_receipt","sessionID":"ses-root","answer":{"name":"ABC"}}),
        ),
    );
    let emitted = drain(&mut events);
    let resolved = emitted.iter().find(|one| one.kind == "chat.approval.resolved").unwrap();
    assert_eq!(resolved.data["status"], "answered");
    assert_eq!(resolved.data["outcome"], "native");
    assert_eq!(resolved.data["answerSummary"]["name"], "ABC");
    assert!(target.v2.lock().unwrap().interactions.is_empty());
    // A late list/snapshot naming the same request is a receipt, never a card.
    let stale = event(
        "evt-stale-created",
        "form.created",
        form("frm_receipt", "ses-root", json!([{"key":"name","type":"string"}])),
    );
    assert!(matches!(target.v2.lock().unwrap().apply(&target.native_id, &stale).unwrap(), Change::None));
    assert!(drain(&mut events).iter().all(|one| one.kind != "chat.approval"));
    // The answer that already settled natively can never be written again.
    assert_eq!(answer(&target, "turn-1", "frm_receipt", &json!({"action":"submit","values":{"name":"ABC"}})).unwrap_err().code, "approval_not_pending");
}

#[test]
fn submit_reaches_the_owning_child_session_once_with_typed_values() {
    let peer = peer(204, "");
    let (target, mut events) = target(&peer.address);
    target.v2.lock().unwrap().children.insert("ses-child".into(), "call-1".into());
    let created = event(
        "evt-child-form",
        "form.created",
        form(
            "frm_child",
            "ses-child",
            json!([{"key":"mode","type":"multiselect","required":true,"options":[{"value":"red","label":"Red"}]}]),
        ),
    );
    push(&target, &created);
    let card = drain(&mut events).into_iter().find(|one| one.kind == "chat.approval").unwrap();
    assert_eq!(card.data["part"]["data"]["subagent"]["key"], "call-1");
    answer(&target, "turn-1", "frm_child", &json!({"action":"submit","values":{"mode":["red"]}})).unwrap();
    let request = peer.requests.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(start(&request), "POST /api/session/ses-child/form/frm_child/reply HTTP/1.1");
    assert_eq!(body(&request), json!({"answer":{"mode":["red"]}}));
    peer.handle.join().unwrap();
    assert!(target.v2.lock().unwrap().interactions.is_empty());
    // The service owns the answer receipt; the adapter must not claim one.
    assert!(drain(&mut events).iter().all(|one| one.kind != "chat.approval.resolved"));
    // A duplicate submit is refused without a second native write.
    assert_eq!(answer(&target, "turn-1", "frm_child", &json!({"action":"submit","values":{"mode":["red"]}})).unwrap_err().code, "approval_not_pending");
    assert!(peer.requests.try_recv().is_err(), "settled answers are never resent");
}

#[test]
fn dismiss_cancels_the_native_form_on_its_owner() {
    let peer = peer(204, "");
    let (target, _events) = target(&peer.address);
    pending_form(&target, "frm_cancel", "ses-root");
    answer(&target, "turn-1", "frm_cancel", &json!({"action":"dismiss"})).unwrap();
    let request = peer.requests.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(start(&request), "DELETE /api/session/ses-root/form/frm_cancel HTTP/1.1");
    peer.handle.join().unwrap();
    let state = target.v2.lock().unwrap();
    assert!(state.interactions.is_empty());
    assert!(!state.interaction_barrier);
}

#[test]
fn definite_native_invalid_answer_keeps_the_card_editable() {
    let peer = peer(400, r#"{"_tag":"FormInvalidAnswerError","id":"frm_invalid","message":"Form field is too short: name"}"#);
    let (target, mut events) = target(&peer.address);
    pending_form(&target, "frm_invalid", "ses-root");
    let _ = drain(&mut events);
    let error = answer(&target, "turn-1", "frm_invalid", &json!({"action":"submit","values":{"name":"x"}})).unwrap_err();
    assert_eq!(error.code, "answer_invalid");
    peer.handle.join().unwrap();
    // The native form is still pending, so nothing is retired or resolved.
    let state = target.v2.lock().unwrap();
    assert!(state.interactions.contains_key("frm_invalid"));
    assert!(state.interaction_barrier);
    drop(state);
    assert!(drain(&mut events).iter().all(|one| one.kind != "chat.approval.resolved"));
    // The stream is not fenced: a corrected answer is a new, permitted attempt.
    assert!(target.liveness.load(Ordering::SeqCst));
}

#[test]
fn already_settled_native_form_retires_the_card_without_claiming_an_answer() {
    let peer = peer(409, r#"{"_tag":"FormAlreadySettledError","id":"frm_race","message":"Form already settled"}"#);
    let (target, mut events) = target(&peer.address);
    pending_form(&target, "frm_race", "ses-root");
    let _ = drain(&mut events);
    let error = answer(&target, "turn-1", "frm_race", &json!({"action":"submit","values":{"name":"ABC"}})).unwrap_err();
    assert_eq!(error.code, "approval_not_pending");
    peer.handle.join().unwrap();
    let resolved = drain(&mut events).into_iter().find(|one| one.kind == "chat.approval.resolved").unwrap();
    assert_eq!(resolved.data["status"], "expired", "a settled race never claims the answer was ours");
    assert_eq!(resolved.data["outcome"], "native");
    assert!(target.v2.lock().unwrap().interactions.is_empty());
    assert!(target.liveness.load(Ordering::SeqCst), "a known settlement is not stream loss");
}

#[test]
fn uncertain_delivery_is_fenced_and_never_resent() {
    let peer = peer(500, r#"{"_tag":"InternalError"}"#);
    let (target, mut events) = target(&peer.address);
    pending_form(&target, "frm_unknown", "ses-root");
    let _ = drain(&mut events);
    let error = answer(&target, "turn-1", "frm_unknown", &json!({"action":"submit","values":{"name":"ABC"}})).unwrap_err();
    assert_eq!(error.code, "approval_outcome_unknown");
    peer.handle.join().unwrap();
    // Exactly the one attempt reached the native side.
    assert!(peer.requests.recv_timeout(Duration::from_secs(5)).is_ok());
    assert!(peer.requests.try_recv().is_err(), "the uncertain attempt is the only write");
    let resolved = drain(&mut events).into_iter().find(|one| one.kind == "chat.approval.resolved").unwrap();
    assert_eq!(resolved.data["status"], "outcomeUnknown");
    assert!(!target.liveness.load(Ordering::SeqCst), "the stream is fenced for reconciliation");
    assert_eq!(answer(&target, "turn-1", "frm_unknown", &json!({"action":"submit","values":{"name":"ABC"}})).unwrap_err().code, "provider_disconnected");
    assert!(peer.requests.try_recv().is_err(), "an uncertain answer is never resent");}

#[test]
fn permission_once_and_reject_reach_the_original_owner_once() {
    for (choice, decision) in [("allow", "once"), ("deny", "reject")] {
        let peer = peer(204, "");
        let (target, mut events) = target(&peer.address);
        let asked = event(
            "evt-permission",
            "permission.asked",
            json!({"id":"per_qa","sessionID":"ses-root","action":"p0.ask","resources":["p0://ask"]}),
        );
        push(&target, &asked);
        let _ = drain(&mut events);
        approve(&target, "turn-1", "per_qa", choice).unwrap();
        let request = peer.requests.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(start(&request), "POST /api/session/ses-root/permission/per_qa/reply HTTP/1.1");
        assert_eq!(body(&request), json!({"decision":decision}));
        peer.handle.join().unwrap();
        let resolved = drain(&mut events).into_iter().find(|one| one.kind == "chat.approval.resolved").unwrap();
        assert_eq!(resolved.data["status"], "resolved");
        assert_eq!(resolved.data["outcome"], decision);
        assert_eq!(approve(&target, "turn-1", "per_qa", choice).unwrap_err().code, "approval_not_pending");
        assert!(peer.requests.try_recv().is_err(), "a settled permission is never answered twice");
    }
}

#[test]
fn a_permission_id_without_an_underscore_still_uses_the_permission_route() {
    // 2.2.5 only requires the `per` prefix for permission ids.
    let peer = peer(204, "");
    let (target, mut events) = target(&peer.address);
    push(
        &target,
        &event(
            "evt-permission",
            "permission.asked",
            json!({"id":"perQA","sessionID":"ses-root","action":"p0.ask","resources":["p0://ask"]}),
        ),
    );
    let _ = drain(&mut events);
    approve(&target, "turn-1", "perQA", "allow").unwrap();
    let request = peer.requests.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(start(&request), "POST /api/session/ses-root/permission/perQA/reply HTTP/1.1");
    peer.handle.join().unwrap();
}

#[test]
fn a_receipt_naming_another_session_leaves_the_card_pending() {
    let (target, mut events) = target("");
    pending_form(&target, "frm_owner", "ses-root");
    let _ = drain(&mut events);
    publish(
        &target,
        &mut target.v2.lock().unwrap(),
        Change::Receipt {
            session: "ses-other".into(),
            id: "frm_owner".into(),
            kind: "form.replied".into(),
            data: json!({"answer":{"name":"ABC"}}),
        },
    );
    assert!(drain(&mut events).iter().all(|one| one.kind != "chat.approval.resolved"));
    assert_eq!(target.v2.lock().unwrap().interactions["frm_owner"].session, "ses-root");
}

#[test]
fn a_foreign_or_stale_turn_can_never_reply_to_a_pending_card() {
    let (target, _events) = target("");
    pending_form(&target, "frm_turn", "ses-root");
    assert_eq!(answer(&target, "turn-2", "frm_turn", &json!({"action":"submit","values":{"name":"ABC"}})).unwrap_err().code, "approval_not_pending");
    let asked = event(
        "evt-permission",
        "permission.asked",
        json!({"id":"per_qa","sessionID":"ses-root","action":"ask","resources":[]}),
    );
    push(&target, &asked);
    assert_eq!(approve(&target, "turn-2", "per_qa", "allow").unwrap_err().code, "approval_not_pending");
    assert_eq!(approve(&target, "turn-1", "per_qa", "always").unwrap_err().code, "approval_choice_invalid");
    assert!(target.v2.lock().unwrap().interactions.contains_key("per_qa"));
}

#[test]
fn terminal_and_stop_do_not_drop_a_pending_request() {
    let peer = peer(204, "");
    let (target, mut events) = target(&peer.address);
    push(
        &target,
        &json!({"id":"evt-start","created":1,"type":"session.execution.started","durable":{"aggregateID":"ses-root","seq":1,"version":1},"data":{"sessionID":"ses-root"}}),
    );
    pending_form(&target, "frm_after_terminal", "ses-root");
    push(
        &target,
        &json!({"id":"evt-done","created":2,"type":"session.execution.succeeded","durable":{"aggregateID":"ses-root","seq":2,"version":1},"data":{"sessionID":"ses-root"}}),
    );
    // A native terminal does not settle the request; only its own receipt does.
    assert!(target.v2.lock().unwrap().interactions.contains_key("frm_after_terminal"));
    assert!(drain(&mut events).iter().all(|one| one.kind != "chat.approval.resolved"));
    answer(&target, "turn-1", "frm_after_terminal", &json!({"action":"submit","values":{"name":"ABC"}})).unwrap();
    let request = peer.requests.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(start(&request), "POST /api/session/ses-root/form/frm_after_terminal/reply HTTP/1.1");
    peer.handle.join().unwrap();
}

// Run 14, from the captured 2.2.5 reject rows: a denied tool aborts the step and
// 2.2.5 announces it as `session.execution.interrupted {reason:"shutdown"}` while
// its server keeps answering. That settles the turn, never the Chat.
fn durable(id: &str, kind: &str, session: &str, seq: u64, data: Value) -> Value {
    json!({"id":id,"created":1,"type":kind,"durable":{"aggregateID":session,"seq":seq,"version":1},"data":data})
}

#[test]
fn an_aborted_step_shutdown_settles_the_turn_while_the_owned_server_answers() {
    let peer = peer(200, r#"{"data":{"version":"2.2.5"}}"#);
    let (target, mut events) = target(&peer.address);
    process_event(
        &target,
        durable("evt-start", "session.execution.started", "ses-root", 1, json!({"sessionID":"ses-root"})),
        false,
    );
    assert!(push(
        &target,
        &event("evt-permission", "permission.asked", json!({"id":"per_reject","sessionID":"ses-root","action":"read","resources":[".env.local"]})),
    ));
    // The native reject settles the card exactly once (native receipt).
    push(
        &target,
        &event("evt-replied", "permission.replied", json!({"requestID":"per_reject","sessionID":"ses-root","reply":"reject"})),
    );
    let _ = drain(&mut events);
    process_event(
        &target,
        durable("evt-shutdown", "session.execution.interrupted", "ses-root", 2, json!({"sessionID":"ses-root","reason":"shutdown"})),
        false,
    );
    // The evidence is the live server, not the event's wording.
    let request = peer.requests.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(start(&request), "GET /api/info HTTP/1.1");
    peer.handle.join().unwrap();
    assert!(target.liveness.load(Ordering::SeqCst), "an aborted step is not stream loss");
    let emitted = drain(&mut events);
    assert!(emitted.iter().all(|one| one.kind != "session.closed"), "the Chat stays connected");
    let completed = emitted.iter().find(|one| one.kind == "chat.turn.completed").unwrap();
    assert_eq!(completed.data["status"], "interrupted");
    assert_eq!(completed.turn_id.as_deref(), Some("turn-1"));
    assert!(target.active.lock().unwrap().is_none(), "the rejected turn is settled");
    // A repeated reply to the settled card is refused, and the Chat is still open.
    assert_eq!(approve(&target, "turn-1", "per_reject", "deny").unwrap_err().code, "approval_not_pending");
    assert!(validate_send(&target).is_ok(), "the next prompt in this Chat is admitted");
}

#[test]
fn a_real_native_shutdown_still_closes_the_chat() {
    // The peer accepts nothing: the stream's owner is gone, so no evidence can
    // keep the Chat open.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let (target, mut events) = target(&address);
    process_event(
        &target,
        durable("evt-start", "session.execution.started", "ses-root", 1, json!({"sessionID":"ses-root"})),
        false,
    );
    let _ = drain(&mut events);
    process_event(
        &target,
        durable("evt-shutdown", "session.execution.interrupted", "ses-root", 2, json!({"sessionID":"ses-root","reason":"shutdown"})),
        false,
    );
    assert!(!target.liveness.load(Ordering::SeqCst), "a dead native owner fences the stream");
    let emitted = drain(&mut events);
    let closed = emitted.iter().find(|one| one.kind == "session.closed").unwrap();
    assert_eq!(closed.data["reason"], "provider_disconnected");
    assert_eq!(approve(&target, "turn-1", "per_any", "deny").unwrap_err().code, "provider_disconnected");
}
