// D2 lifecycle coverage lives in an included test module so it can exercise
// Codex's private native-replay and plan-decision helpers without widening the
// provider API.

struct PlanApprovalReplay {
    events: crate::provider_events::Sender,
    received: broadcast::Receiver<super::super::ProviderEvent>,
    native: Mutex<Option<String>>,
    approvals: Mutex<HashMap<String, PendingCodexApproval>>,
    active: CodexTurnState,
    ui: Mutex<CodexUiState>,
    subagents: Mutex<CodexSubagents>,
}

impl PlanApprovalReplay {
    fn new(collaboration: &str) -> Self {
        let (events, received) = crate::provider_events::tap_channel(64);
        let active = new_codex_turn_state();
        active.0.lock().unwrap().replace(ActiveCodexTurn {
            public_id: "plan-turn".into(),
            native_id: None,
            assistant_item_id: None,
            started_at: Instant::now(),
        });
        let replay = Self {
            events,
            received,
            native: Mutex::new(Some("qa-codex-plan-approval-thread".into())),
            approvals: Mutex::new(HashMap::new()),
            active,
            ui: Mutex::new(CodexUiState {
                options: vec![json!({"id":"collaboration","value":collaboration})],
                ..CodexUiState::default()
            }),
            subagents: Mutex::new(CodexSubagents::default()),
        };
        replay.emit(
            "turn/started",
            json!({"threadId":"qa-codex-plan-approval-thread","turn":{"id":"native-plan-turn"}}),
        );
        replay
    }

    fn emit(&self, method: &str, params: Value) {
        emit_codex_message(
            &self.events,
            "plan-session",
            &self.native,
            &self.approvals,
            &self.active,
            &self.ui,
            &Mutex::new(None),
            "plan-worker",
            &self.subagents,
            json!({"method":method,"params":params}),
        );
    }

    fn complete(&self, item: Value, status: &str) {
        self.emit("item/completed", json!({"threadId":"qa-codex-plan-approval-thread","turnId":"native-plan-turn","item":item}));
        self.emit("turn/completed", json!({"threadId":"qa-codex-plan-approval-thread","turn":{"id":"native-plan-turn","status":status}}));
    }

    fn drain(&mut self) -> Vec<super::super::ProviderEvent> {
        std::iter::from_fn(|| self.received.try_recv().ok()).collect()
    }
}

fn approval_events(events: &[super::super::ProviderEvent]) -> Vec<&super::super::ProviderEvent> {
    events
        .iter()
        .filter(|event| event.kind == "chat.approval")
        .collect()
}

#[test]
fn synthetic_plan_card_requires_a_completed_authoritative_item_in_plan_mode() {
    let mut replay = PlanApprovalReplay::new("plan");
    let _ = replay.drain();
    // Deltas and ordinary messages are never candidates.
    replay.emit("item/plan/delta", json!({"threadId":"qa-codex-plan-approval-thread","turnId":"native-plan-turn","delta":"# partial"}));
    replay.complete(
        json!({"id":"answer","type":"agentMessage","text":"# not a plan"}),
        "completed",
    );
    assert!(approval_events(&replay.drain()).is_empty());

    let mut replay = PlanApprovalReplay::new("plan");
    let _ = replay.drain();
    replay.complete(
        json!({"id":"plan","type":"plan","text":"# Authoritative plan\n1. Edit"}),
        "completed",
    );
    let events = replay.drain();
    assert!(
        !events.iter().any(|event| event.kind == "chat.item"),
        "the authoritative plan item must not also appear as transcript text"
    );
    let approvals = approval_events(&events);
    assert_eq!(approvals.len(), 1);
    let approval_index = events.iter().position(|event| event.kind == "chat.approval").unwrap();
    let completion_index = events.iter().position(|event| event.kind == "chat.turn.completed").unwrap();
    assert!(
        approval_index < completion_index,
        "the synthetic pending-plan gate must exist before completion can dispatch the queue"
    );
    assert_eq!(approvals[0].data["part"]["data"]["interaction"], "plan");
    assert_eq!(approvals[0].data["part"]["data"]["runtimeOwned"], true);
    assert_eq!(
        approvals[0].data["part"]["data"]["plan"],
        "# Authoritative plan\n1. Edit"
    );
    assert_eq!(approvals[0].data["part"]["data"]["waitingForPrompt"], false);
}

#[test]
fn synthetic_plan_card_supports_empty_plan_once_and_ignores_noncompleted_or_default_turns() {
    let mut empty = PlanApprovalReplay::new("plan");
    let _ = empty.drain();
    empty.complete(json!({"id":"plan","type":"plan","text":""}), "completed");
    let events = empty.drain();
    assert_eq!(approval_events(&events).len(), 1);
    assert_eq!(approval_events(&events)[0].data["part"]["data"]["plan"], "");

    let mut interrupted = PlanApprovalReplay::new("plan");
    let _ = interrupted.drain();
    interrupted.complete(
        json!({"id":"plan","type":"plan","text":"# plan"}),
        "interrupted",
    );
    assert!(approval_events(&interrupted.drain()).is_empty());

    let mut default_mode = PlanApprovalReplay::new("default");
    let _ = default_mode.drain();
    default_mode.complete(
        json!({"id":"plan","type":"plan","text":"# plan"}),
        "completed",
    );
    assert!(approval_events(&default_mode.drain()).is_empty());

    let mut duplicate = PlanApprovalReplay::new("plan");
    let _ = duplicate.drain();
    duplicate.complete(
        json!({"id":"plan","type":"plan","text":"# plan"}),
        "completed",
    );
    duplicate.emit("turn/completed", json!({"threadId":"qa-codex-plan-approval-thread","turn":{"id":"native-plan-turn","status":"completed"}}));
    assert_eq!(
        approval_events(&duplicate.drain()).len(),
        1,
        "a duplicated completed notification cannot create a second card"
    );
}

fn pending_plan_chat() -> (
    CodexChat,
    broadcast::Receiver<super::super::ProviderEvent>,
    tempfile::TempDir,
    std::path::PathBuf,
) {
    let scratch = tempfile::tempdir().unwrap();
    let log = scratch.path().join("plan-approval-requests.jsonl");
    std::fs::write(&log, "").unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../qa/fixtures/fake-codex-plan-approval.cjs");
    let spec = CommandSpec::provider("node", &[fixture.to_str().unwrap()]).unwrap();
    let (events, received) = crate::provider_events::tap_channel(128);
    let native = Arc::new(Mutex::new(Some("qa-codex-plan-approval-thread".into())));
    let approvals = Arc::new(Mutex::new(HashMap::new()));
    let active = new_codex_turn_state();
    let ui = Arc::new(Mutex::new(CodexUiState {
        options: vec![
            json!({"id":"model","value":"qa-model","choices":[{"value":"qa-model","name":"QA model"}]}),
            json!({"id":"thinking","value":"medium","choices":[{"value":"medium","name":"Medium"}]}),
            json!({"id":"collaboration","value":"plan","choices":[{"value":"default","name":"Default"},{"value":"plan","name":"Plan"}]}),
        ],
        ..CodexUiState::default()
    }));
    let responder = Arc::new(Mutex::new(None));
    let subagents = Arc::new(Mutex::new(CodexSubagents::default()));
    let callback_events = events.clone();
    let callback_native = Arc::clone(&native);
    let callback_approvals = Arc::clone(&approvals);
    let callback_active = Arc::clone(&active);
    let callback_ui = Arc::clone(&ui);
    let callback_responder = Arc::clone(&responder);
    let callback_subagents = Arc::clone(&subagents);
    let process = JsonLineProcess::spawn(
        "fake-codex-plan-approval",
        &spec,
        None,
        &[
            (
                "THREADTERM_QA_CODEX_PLAN_APPROVAL_LOG",
                log.to_str().unwrap(),
            ),
            (
                "THREADTERM_QA_CODEX_PLAN_APPROVAL_CWD",
                scratch.path().to_str().unwrap(),
            ),
        ],
        EnvelopeStyle::Codex,
        Arc::new(move |raw| {
            emit_codex_message(
                &callback_events,
                "plan-session",
                &callback_native,
                &callback_approvals,
                &callback_active,
                &callback_ui,
                &callback_responder,
                "plan-worker",
                &callback_subagents,
                raw,
            )
        }),
    )
    .unwrap();
    *responder.lock().unwrap() = Some(process.responder());
    (
        CodexChat {
            process,
            native_id: "qa-codex-plan-approval-thread".into(),
            approvals,
            active_turn: active,
            session_id: "plan-session".into(),
            cwd: scratch.path().to_string_lossy().into_owned(),
            events,
            ui,
            worker_token: "plan-worker".into(),
        },
        received,
        scratch,
        log,
    )
}

fn wait_for_plan_card(
    received: &mut broadcast::Receiver<super::super::ProviderEvent>,
) -> super::super::ProviderEvent {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match received.try_recv() {
            Ok(event)
                if event.kind == "chat.approval"
                    && event.data.pointer("/part/data/interaction") == Some(&json!("plan")) =>
            {
                return event
            }
            Ok(_) => {}
            Err(broadcast::error::TryRecvError::Empty) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5))
            }
            other => panic!("expected synthetic plan card: {other:?}"),
        }
    }
}

fn wait_for_no_active_turn(active: &CodexTurnState) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while active.0.lock().unwrap().is_some() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        active.0.lock().unwrap().is_none(),
        "fake Codex turn did not complete"
    );
}

#[test]
fn runtime_owned_plan_decisions_gate_sends_and_preserve_their_durable_outcomes() {
    let (mut chat, mut received, _scratch, log) = pending_plan_chat();
    chat.send("make a plan", "plan-turn").unwrap();
    let card = wait_for_plan_card(&mut received);
    let approval_id = card.data["approvalId"].as_str().unwrap().to_owned();
    assert_eq!(
        chat.send("ordinary prompt", "blocked").unwrap_err().code,
        "plan_decision_required"
    );
    chat.plan_response(
        "plan-turn",
        &approval_id,
        &json!({"action":"request_changes"}),
        "request",
    )
    .unwrap();
    let waiting = wait_for_plan_card(&mut received);
    assert_eq!(waiting.data["part"]["data"]["waitingForPrompt"], true);
    chat.send("Please use smaller commits.", "feedback-turn")
        .unwrap();
    let resolved = std::iter::from_fn(|| received.try_recv().ok())
        .find(|event| event.kind == "chat.approval.resolved")
        .unwrap();
    assert_eq!(resolved.data["planOutcome"], "changes_requested");
    assert_eq!(resolved.data["feedback"], "Please use smaller commits.");
    wait_for_no_active_turn(&chat.active_turn);

    // A separate pending card can be abandoned without changing plan mode.
    chat.ui.lock().unwrap().options[0]["value"] = json!("plan");
    chat.ui.lock().unwrap().pending_plan = Some(CodexPlanApproval {
        id: "plan:abandon".into(),
        turn_id: "abandon-turn".into(),
        plan: "# plan".into(),
        action: None,
    });
    chat.plan_response(
        "abandon-turn",
        "plan:abandon",
        &json!({"action":"abandon"}),
        "abandon",
    )
    .unwrap();
    assert_eq!(chat.ui.lock().unwrap().options[0]["value"], "plan");
    let abandoned = std::iter::from_fn(|| received.try_recv().ok())
        .find(|event| event.kind == "chat.approval.resolved")
        .unwrap();
    assert_eq!(abandoned.data["planOutcome"], "abandoned");

    let requests = std::fs::read_to_string(log).unwrap();
    assert!(
        !requests.contains("Implement the plan."),
        "request changes and abandon never send an implementation prompt"
    );
}

#[test]
fn approve_sends_the_exact_prompt_once_and_cancel_stop_clear_stale_plan_state() {
    let (mut chat, mut received, _scratch, log) = pending_plan_chat();
    chat.send("make a plan", "plan-turn").unwrap();
    let card = wait_for_plan_card(&mut received);
    let approval_id = card.data["approvalId"].as_str().unwrap().to_owned();
    let prompt = chat
        .plan_response(
            "plan-turn",
            &approval_id,
            &json!({"action":"approve"}),
            "approve",
        )
        .unwrap();
    assert_eq!(prompt.as_deref(), Some("Implement the plan."));
    chat.send(prompt.as_deref().unwrap(), "implement-turn")
        .unwrap();
    wait_for_no_active_turn(&chat.active_turn);
    assert_eq!(
        chat.plan_response(
            "plan-turn",
            &approval_id,
            &json!({"action":"approve"}),
            "repeat"
        )
        .unwrap_err()
        .code,
        "approval_not_pending"
    );
    let requests = std::fs::read_to_string(&log).unwrap();
    assert_eq!(requests.matches("Implement the plan.").count(), 1);
    let requests: Vec<Value> = requests
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(requests
        .iter()
        .any(|request| request["method"] == "thread/settings/update"
            && request.pointer("/params/collaborationMode/mode") == Some(&json!("default"))));

    chat.ui.lock().unwrap().pending_plan = Some(CodexPlanApproval {
        id: "plan:cancel".into(),
        turn_id: "cancel-turn".into(),
        plan: "# plan".into(),
        action: None,
    });
    chat.cancel("cancel-turn").unwrap();
    assert!(chat.ui.lock().unwrap().pending_plan.is_none());
    let expired = std::iter::from_fn(|| received.try_recv().ok())
        .find(|event| {
            event.kind == "chat.approval.resolved" && event.data["approvalId"] == "plan:cancel"
        })
        .unwrap();
    assert_eq!(expired.data["status"], "expired");
    chat.ui.lock().unwrap().pending_plan = Some(CodexPlanApproval {
        id: "plan:stale".into(),
        turn_id: "stale-turn".into(),
        plan: "# plan".into(),
        action: None,
    });
    chat.stop().unwrap();
    assert!(
        chat.ui.lock().unwrap().pending_plan.is_none(),
        "stop/reconnect cannot retain a stale plan card"
    );
}

fn plan_text_events(events: &[super::super::ProviderEvent]) -> Vec<&super::super::ProviderEvent> {
    events
        .iter()
        .filter(|event| {
            event.kind == "chat.item"
                && event.data.pointer("/item/type").and_then(Value::as_str) == Some("plan")
        })
        .collect()
}

#[test]
fn held_plan_item_falls_back_to_transcript_text_when_no_card_owns_it() {
    // Interrupted in plan mode: no card, so the plan still reaches the transcript.
    let mut interrupted = PlanApprovalReplay::new("plan");
    let _ = interrupted.drain();
    interrupted.complete(
        json!({"id":"plan","type":"plan","text":"# plan"}),
        "interrupted",
    );
    let events = interrupted.drain();
    assert!(approval_events(&events).is_empty());
    let text = plan_text_events(&events);
    assert_eq!(text.len(), 1, "an interrupted plan must not be dropped");
    assert_eq!(text[0].data["item"]["text"], "# plan");
    assert_eq!(text[0].data["item"]["id"], "plan");
    assert_eq!(text[0].turn_id.as_deref(), Some("plan-turn"));

    // Default mode completes without a plan card; the plan is shown once as text.
    let mut default_mode = PlanApprovalReplay::new("default");
    let _ = default_mode.drain();
    default_mode.complete(
        json!({"id":"plan","type":"plan","text":"# plan"}),
        "completed",
    );
    let events = default_mode.drain();
    assert!(approval_events(&events).is_empty());
    assert_eq!(plan_text_events(&events).len(), 1);

    // A failed turn flushes the held plan before the session ends.
    let mut failed = PlanApprovalReplay::new("plan");
    let _ = failed.drain();
    failed.emit(
        "item/completed",
        json!({"threadId":"qa-codex-plan-approval-thread","turnId":"native-plan-turn","item":{"id":"plan","type":"plan","text":"# plan"}}),
    );
    let _ = failed.drain();
    failed.emit(
        "error",
        json!({"threadId":"qa-codex-plan-approval-thread","turnId":"native-plan-turn","message":"boom"}),
    );
    let events = failed.drain();
    assert!(approval_events(&events).is_empty());
    assert_eq!(
        plan_text_events(&events).len(),
        1,
        "a failed plan must not be dropped"
    );

    // A plan item whose turn never becomes the active turn cannot own a card.
    let mut mismatched = PlanApprovalReplay::new("plan");
    let _ = mismatched.drain();
    mismatched.emit(
        "item/completed",
        json!({"threadId":"qa-codex-plan-approval-thread","turnId":"stale-native-turn","item":{"id":"plan","type":"plan","text":"# plan"}}),
    );
    let events = mismatched.drain();
    assert!(approval_events(&events).is_empty());
    assert_eq!(
        plan_text_events(&events).len(),
        1,
        "a non-matching turn's plan must not be dropped"
    );

    // A new turn flushes a held plan whose turn never completed.
    let mut superseded = PlanApprovalReplay::new("plan");
    let _ = superseded.drain();
    superseded.emit(
        "item/completed",
        json!({"threadId":"qa-codex-plan-approval-thread","turnId":"native-plan-turn","item":{"id":"plan","type":"plan","text":"# plan"}}),
    );
    superseded.emit(
        "turn/started",
        json!({"threadId":"qa-codex-plan-approval-thread","turn":{"id":"next-native-turn"}}),
    );
    let events = superseded.drain();
    assert!(approval_events(&events).is_empty());
    assert_eq!(
        plan_text_events(&events).len(),
        1,
        "a plan superseded by a new turn must not be dropped"
    );
}

#[test]
fn held_plan_item_is_snapshotted_for_durable_worker_retirement() {
    let (mut chat, _received, _scratch, _log) = pending_plan_chat();
    chat.ui.lock().unwrap().plan_candidate = Some(CodexPlanCandidate {
        turn_id: "retiring-turn".into(),
        item_id: Some("retiring-plan".into()),
        text: "# Retiring plan".into(),
    });
    let events = chat.retirement_events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, "chat.item");
    assert_eq!(events[0].turn_id.as_deref(), Some("retiring-turn"));
    assert_eq!(events[0].data["item"]["id"], "retiring-plan");
    assert_eq!(events[0].data["item"]["type"], "plan");
    assert_eq!(events[0].data["item"]["text"], "# Retiring plan");
    assert_eq!(events[0].worker_token.as_deref(), Some("plan-worker"));

    let failure = chat.prepare_retirement(&|_| {
        Err(ProviderError::new("chat_persistence", "injected persistence failure"))
    });
    assert_eq!(failure.unwrap_err().code, "chat_persistence");
    assert!(!chat.ui.lock().unwrap().retiring);
    assert!(chat.ui.lock().unwrap().plan_candidate.is_some());

    let persisted = Mutex::new(Vec::new());
    chat.prepare_retirement(&|event| {
        persisted.lock().unwrap().push(event.clone());
        Ok(())
    })
    .unwrap();
    assert_eq!(persisted.lock().unwrap().len(), 1);
    assert!(chat.ui.lock().unwrap().retiring);

    chat.active_turn.0.lock().unwrap().replace(ActiveCodexTurn {
        public_id: "late-public".into(),
        native_id: Some("late-native".into()),
        assistant_item_id: None,
        started_at: Instant::now(),
    });
    emit_codex_message(
        &chat.events,
        &chat.session_id,
        &Mutex::new(Some(chat.native_id.clone())),
        &chat.approvals,
        &chat.active_turn,
        &chat.ui,
        &Mutex::new(None),
        &chat.worker_token,
        &Mutex::new(CodexSubagents::default()),
        json!({"method":"item/completed","params":{
            "threadId":chat.native_id,"turnId":"late-native",
            "item":{"id":"late-plan","type":"plan","text":"# Late plan"}
        }}),
    );
    assert_eq!(
        chat.ui.lock().unwrap().plan_candidate.as_ref().unwrap().text,
        "# Retiring plan",
        "native frames after the retirement boundary cannot replace the persisted candidate"
    );
    chat.stop().unwrap();
    assert!(chat.ui.lock().unwrap().plan_candidate.is_none());
}

#[test]
fn retirement_barrier_rejects_a_late_plan_when_no_candidate_was_held() {
    let (mut chat, _received, _scratch, _log) = pending_plan_chat();
    chat.prepare_retirement(&|_| panic!("an empty retirement has nothing to persist"))
        .unwrap();
    chat.active_turn.0.lock().unwrap().replace(ActiveCodexTurn {
        public_id: "late-public".into(),
        native_id: Some("late-native".into()),
        assistant_item_id: None,
        started_at: Instant::now(),
    });
    emit_codex_message(
        &chat.events,
        &chat.session_id,
        &Mutex::new(Some(chat.native_id.clone())),
        &chat.approvals,
        &chat.active_turn,
        &chat.ui,
        &Mutex::new(None),
        &chat.worker_token,
        &Mutex::new(CodexSubagents::default()),
        json!({"method":"item/completed","params":{
            "threadId":chat.native_id,"turnId":"late-native",
            "item":{"id":"late-plan","type":"plan","text":"# Late plan"}
        }}),
    );
    assert!(chat.ui.lock().unwrap().plan_candidate.is_none());
    chat.stop().unwrap();
}

#[test]
fn plan_card_and_history_text_never_both_own_the_same_plan() {
    // The card path shows no transcript text.
    let mut card = PlanApprovalReplay::new("plan");
    let _ = card.drain();
    card.complete(
        json!({"id":"plan","type":"plan","text":"# plan"}),
        "completed",
    );
    let events = card.drain();
    assert_eq!(approval_events(&events).len(), 1);
    assert!(plan_text_events(&events).is_empty());

    // The history reload of a plan item renders it as text once, not as a tool.
    let items = codex_transcript_items(&json!({"turns":[{"id":"history-turn","items":[
        {"id":"plan","type":"plan","text":"# Plan\n1. Build"},
        {"id":"answer","type":"agentMessage","text":"done"}
    ]}]}));
    let plans = items
        .iter()
        .filter(|item| item["id"].as_str() == Some("plan"))
        .collect::<Vec<_>>();
    assert_eq!(plans.len(), 1);
    assert_eq!(plans[0]["parts"][0]["type"], "text");
    assert_eq!(plans[0]["parts"][0]["text"], "# Plan\n1. Build");
}
