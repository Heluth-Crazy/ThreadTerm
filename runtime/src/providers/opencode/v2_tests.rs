use super::*;

// These rows use the v2.2.5 public event envelope: id/type/data and durable
// {aggregateID,seq,version} only for durable events.
fn durable(id: &str, kind: &str, session: &str, seq: u64, data: Value) -> Value {
    json!({
        "id": id,
        "created": 1,
        "type": kind,
        "durable": {"aggregateID": session, "seq": seq, "version": 1},
        "data": data,
    })
}

fn ephemeral(id: &str, kind: &str, data: Value) -> Value {
    json!({"id":id,"created":1,"type":kind,"data":data})
}

fn state() -> State {
    State::default()
}

#[test]
fn text_and_reasoning_ordinals_are_independent_identities() {
    let mut state = state();
    let root = "ses-root";
    let text = durable(
        "evt-text",
        "session.text.ended",
        root,
        1,
        json!({
            "sessionID":root,"assistantMessageID":"msg-answer","ordinal":0,"text":"answer"
        }),
    );
    let reasoning = durable(
        "evt-reasoning",
        "session.reasoning.ended",
        root,
        2,
        json!({
            "sessionID":root,"assistantMessageID":"msg-answer","ordinal":0,"text":"thought"
        }),
    );
    assert!(
        matches!(state.apply(root, &text).unwrap(), Change::Message { parts, .. } if parts.len() == 1)
    );
    assert!(
        matches!(state.apply(root, &reasoning).unwrap(), Change::Message { parts, .. } if parts.len() == 2)
    );
    let message = state
        .messages
        .get(&(root.into(), "msg-answer".into()))
        .unwrap();
    assert_eq!(message.ordinals.len(), 2);
}

#[test]
fn ended_text_replaces_prior_deltas_and_duplicate_or_late_deltas_do_not_append() {
    let mut state = state();
    let root = "ses-root";
    for (id, kind, payload) in [
        (
            "evt-start",
            "session.text.started",
            json!({"sessionID":root,"assistantMessageID":"msg-a","ordinal":0}),
        ),
        (
            "evt-delta",
            "session.text.delta",
            json!({"sessionID":root,"assistantMessageID":"msg-a","ordinal":0,"delta":"draft"}),
        ),
        (
            "evt-end",
            "session.text.ended",
            json!({"sessionID":root,"assistantMessageID":"msg-a","ordinal":0,"text":"authoritative"}),
        ),
        (
            "evt-late",
            "session.text.delta",
            json!({"sessionID":root,"assistantMessageID":"msg-a","ordinal":0,"delta":" stale"}),
        ),
    ] {
        let raw = match kind {
            "session.text.started" => durable(id, kind, root, 1, payload),
            "session.text.ended" => durable(id, kind, root, 2, payload),
            _ => ephemeral(id, kind, payload),
        };
        state.apply(root, &raw).unwrap();
    }
    let message = state.messages.get(&(root.into(), "msg-a".into())).unwrap();
    let index = message.ordinals[&("text".into(), 0)];
    assert_eq!(message.content[&index]["text"], "authoritative");
    assert_eq!(message.content[&index]["status"], "completed");
    assert!(matches!(
        state
            .apply(
                root,
                &durable(
                    "evt-end",
                    "session.text.ended",
                    root,
                    2,
                    json!({"sessionID":root,"assistantMessageID":"msg-a","ordinal":0,"text":"bad"})
                )
            )
            .unwrap(),
        Change::None
    ));
}

#[test]
fn assistant_snapshot_is_authoritative_and_later_live_event_requests_refresh() {
    let mut state = state();
    let root = "ses-root";
    let row = json!({"id":"msg-a","type":"assistant","time":{"created":1},"content":[
        {"type":"reasoning","text":"think"},
        {"type":"tool","id":"call-1","name":"shell","state":{"status":"completed","input":{},"content":[{"type":"text","text":"ok"}]}},
        {"type":"text","text":"answer"}
    ]});
    let seeded = state.seed_message(root, &row).unwrap().unwrap();
    assert!(matches!(seeded, Change::Message { parts, .. } if parts.len() == 3));
    let event = ephemeral(
        "evt-next",
        "session.text.delta",
        json!({"sessionID":root,"assistantMessageID":"msg-a","ordinal":0,"delta":"ignored"}),
    );
    assert!(
        matches!(state.apply(root, &event).unwrap(), Change::Refresh { session, message } if session == root && message == "msg-a")
    );
}

#[test]
fn step_end_does_not_settle_execution_but_durable_execution_does() {
    let mut state = state();
    let root = "ses-root";
    let started = durable(
        "evt-exec-start",
        "session.execution.started",
        root,
        10,
        json!({"sessionID":root}),
    );
    assert!(matches!(
        state.apply(root, &started).unwrap(),
        Change::Started { .. }
    ));
    let step = durable(
        "evt-step",
        "session.step.ended",
        root,
        11,
        json!({"sessionID":root,"assistantMessageID":"msg-a","finish":"stop","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}),
    );
    // Usage is reported, but a step end never settles the execution.
    assert!(matches!(
        state.apply(root, &step).unwrap(),
        Change::Usage { step: true, .. }
    ));
    assert!(state.executions[root].running);
    let terminal = durable(
        "evt-exec-done",
        "session.execution.succeeded",
        root,
        12,
        json!({"sessionID":root}),
    );
    assert!(matches!(
        state.apply(root, &terminal).unwrap(),
        Change::Terminal {
            status: "completed",
            ..
        }
    ));
}

#[test]
fn shutdown_interruption_keeps_execution_unsettled_for_recovery() {
    let mut state = state();
    let root = "ses-root";
    state
        .apply(
            root,
            &durable(
                "evt-start",
                "session.execution.started",
                root,
                1,
                json!({"sessionID":root}),
            ),
        )
        .unwrap();
    let shutdown = durable(
        "evt-shutdown",
        "session.execution.interrupted",
        root,
        2,
        json!({"sessionID":root,"reason":"shutdown"}),
    );
    assert_eq!(
        state.apply(root, &shutdown).unwrap_err().code,
        "provider_disconnected"
    );
    assert!(state.executions[root].running);
}

#[test]
fn foreign_and_unproven_child_events_do_not_project() {
    let mut state = state();
    let root = "ses-root";
    let foreign = ephemeral(
        "evt-foreign",
        "session.execution.started",
        json!({"sessionID":"ses-foreign"}),
    );
    assert!(matches!(state.apply(root, &foreign).unwrap(), Change::None));
    assert!(!state.seen.contains("evt-foreign"));
}

#[test]
fn v2_form_and_permission_envelopes_preserve_receipt_before_pending_order() {
    let mut state = state();
    let root = "ses-root";
    let receipt = ephemeral(
        "evt-form-replied",
        "form.replied",
        json!({"id":"form-1","sessionID":root,"answer":{"name":"value"}}),
    );
    assert!(
        matches!(state.apply(root, &receipt).unwrap(), Change::Receipt { id, kind, .. } if id == "form-1" && kind == "form.replied")
    );
    let created = ephemeral(
        "evt-form-created",
        "form.created",
        json!({"form":{"id":"form-1","sessionID":root,"title":"Test","fields":[]}}),
    );
    assert!(matches!(state.apply(root, &created).unwrap(), Change::None));
    let fresh = ephemeral(
        "evt-form-created-fresh",
        "form.created",
        json!({"form":{"id":"form-2","sessionID":root,"title":"Test","fields":[]}}),
    );
    assert!(
        matches!(state.apply(root, &fresh).unwrap(), Change::Pending { id, kind, .. } if id == "form-2" && kind == "form.created")
    );
    let permission = ephemeral(
        "evt-permission-replied",
        "permission.replied",
        json!({"requestID":"req-1","sessionID":root,"reply":"once"}),
    );
    assert!(
        matches!(state.apply(root, &permission).unwrap(), Change::Receipt { id, kind, .. } if id == "req-1" && kind == "permission.replied")
    );
}

#[test]
fn event_id_dedup_is_bounded_and_evicted_ids_are_admitted_again() {
    let mut state = state();
    for index in 0..=MAX_EVENT_IDS {
        assert!(state.remember(&format!("evt-{index}")));
    }
    assert_eq!(state.seen.len(), MAX_EVENT_IDS);
    assert!(!state.seen.contains("evt-0"));
    assert!(state.remember("evt-0"));
    assert!(!state.remember("evt-0"));
}

#[test]
fn duplicate_old_terminal_cannot_settle_a_newer_execution() {
    let mut state = state();
    let root = "ses-root";
    state
        .apply(
            root,
            &durable(
                "evt-start-1",
                "session.execution.started",
                root,
                1,
                json!({"sessionID":root}),
            ),
        )
        .unwrap();
    assert!(matches!(
        state
            .apply(
                root,
                &durable(
                    "evt-done-1",
                    "session.execution.succeeded",
                    root,
                    2,
                    json!({"sessionID":root})
                )
            )
            .unwrap(),
        Change::Terminal { .. }
    ));
    state
        .apply(
            root,
            &durable(
                "evt-start-2",
                "session.execution.started",
                root,
                3,
                json!({"sessionID":root}),
            ),
        )
        .unwrap();
    assert!(matches!(
        state
            .apply(
                root,
                &durable(
                    "evt-done-1-replay",
                    "session.execution.succeeded",
                    root,
                    2,
                    json!({"sessionID":root})
                )
            )
            .unwrap(),
        Change::None
    ));
    assert!(state.executions[root].running);
}

#[test]
fn tool_identity_tracks_input_progress_and_terminal_result() {
    let mut state = state();
    let root = "ses-root";
    let message = "msg-answer";
    let tool = "call-shell";
    state
        .apply(
            root,
            &durable(
                "evt-tool-start",
                "session.tool.input.started",
                root,
                1,
                json!({"sessionID":root,"assistantMessageID":message,"id":tool,"name":"shell"}),
            ),
        )
        .unwrap();
    state.apply(root, &ephemeral("evt-tool-delta", "session.tool.input.delta", json!({"sessionID":root,"assistantMessageID":message,"id":tool,"delta":"{\"command\":\"dir"}))).unwrap();
    state.apply(root, &durable("evt-tool-called", "session.tool.called", root, 2, json!({"sessionID":root,"assistantMessageID":message,"id":tool,"input":{"command":"dir"},"executed":true}))).unwrap();
    state.apply(root, &ephemeral("evt-tool-progress", "session.tool.progress", json!({"sessionID":root,"assistantMessageID":message,"id":tool,"metadata":{"phase":"run"}}))).unwrap();
    state.apply(root, &durable("evt-tool-success", "session.tool.success", root, 3, json!({"sessionID":root,"assistantMessageID":message,"id":tool,"content":[{"type":"text","text":"ok"}],"executed":true}))).unwrap();
    let stored = state.messages.get(&(root.into(), message.into())).unwrap();
    let index = stored.tools[tool];
    assert_eq!(
        stored.content[&index]
            .pointer("/state/status")
            .and_then(Value::as_str),
        Some("completed")
    );
    assert_eq!(
        stored.content[&index]
            .pointer("/state/content/0/text")
            .and_then(Value::as_str),
        Some("ok")
    );
}

#[test]
fn subagent_tool_metadata_and_verified_parent_link_are_both_required_for_child_ownership() {
    let mut state = state();
    let root = "ses-root";
    let child = "ses-child";
    state.parents.insert(child.into(), root.into());
    let row = json!({"id":"msg-a","type":"assistant","time":{"created":1},"content":[{
        "type":"tool","id":"call-subagent","name":"subagent",
        "state":{"status":"running","input":{},"metadata":{"sessionID":child}}
    }]});
    state.seed_message(root, &row).unwrap();
    assert!(state.children.contains_key(child));
    assert!(state.owned(child, root));
}

#[test]
fn recovery_buffer_is_bounded_and_does_not_silently_drop_a_frame() {
    let mut state = state();
    let raw = ephemeral(
        "evt-buffer",
        "session.text.delta",
        json!({"sessionID":"ses-root","assistantMessageID":"msg-a","ordinal":0,"delta":"x"}),
    );
    for _ in 0..MAX_BUFFERED_EVENTS {
        state.buffer(raw.clone()).unwrap();
    }
    assert_eq!(state.buffered.len(), MAX_BUFFERED_EVENTS);
    assert_eq!(state.buffer(raw).unwrap_err().code, "provider_protocol");
}

#[test]
fn captured_native_pending_requests_keep_types_and_server_settlement_meaning() {
    let rows = crate::providers::conformance::fixture("opencode-v2-native-forms.jsonl");
    let captured = |case| rows.iter().find(|row| row["case"] == case).unwrap();
    let pending = api::ResponseShape::Data
        .decode(captured("list_pending")["value"].clone())
        .unwrap();
    let form = &pending[0];
    let root = form["sessionID"].as_str().unwrap();
    let mut state = State::default();
    // HTTP captured natively; the ephemeral event wrapper is schema-derived.
    let event = ephemeral("evt-captured-pending", "form.created", json!({"form":form}));
    assert!(
        matches!(state.apply(root,&event).unwrap(),Change::Pending{request,..} if request["fields"][2]["default"]==false)
    );
    assert_eq!(captured("invalid_answer")["status"], 400);
    assert_eq!(
        captured("detail_after_invalid")["value"]["data"]["state"]["status"],
        "pending"
    );
    let answer = &captured("edge_detail_after_answer")["value"]["data"]["state"]["answer"];
    assert_eq!(answer["zero"], 0);
    assert_eq!(answer["empty"], "");
    assert_eq!(
        captured("unicode_omitted_required_default")["status"],
        400,
        "defaults are not inserted by the server"
    );
    let statuses = captured("reply_cancel_race")["value"]["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["status"].as_u64().unwrap())
        .collect::<HashSet<_>>();
    assert_eq!(statuses, HashSet::from([204, 409]));
    assert_eq!(captured("reply_asked_permission_once")["status"], 204);
    assert_eq!(
        captured("get_asked_permission_after_reply")["status"],
        404,
        "missing after a known reply is not itself an outcome receipt"
    );
}

#[test]
fn captured_missing_native_id_never_becomes_an_empty_history_or_new_identity() {
    for row in crate::providers::conformance::fixture("opencode-v2-native-negative.jsonl") {
        assert_eq!(row["status"], 404);
        assert_eq!(row["value"]["_tag"], "SessionNotFoundError");
    }
}

#[test]
fn finalized_native_metadata_has_a_byte_bound_even_when_display_text_is_tiny() {
    let mut state = State::default();
    let event = durable(
        "evt-large-native",
        "session.text.ended",
        "ses-root",
        1,
        json!({"sessionID":"ses-root","assistantMessageID":"msg-answer","ordinal":0,"text":"ok","native":{"opaque":"x".repeat(MAX_ASSEMBLED_PAYLOAD_BYTES)}}),
    );
    assert_eq!(
        state.apply("ses-root", &event).unwrap_err().code,
        "provider_protocol"
    );
}

#[test]
fn equal_recovered_idle_and_new_start_timestamps_cannot_guess_execution_ownership() {
    let mut state = State::default();
    state.executions.insert(
        "ses-root".into(),
        Execution {
            snapshot_busy: Some(9.0),
            snapshot_idle: Some(10.0),
            ..Default::default()
        },
    );
    let mut event = durable(
        "evt-ambiguous",
        "session.execution.started",
        "ses-root",
        22,
        json!({"sessionID":"ses-root"}),
    );
    event["created"] = json!(10);
    assert_eq!(
        state.apply("ses-root", &event).unwrap_err().code,
        "provider_recovery_required"
    );
    assert!(!state.executions["ses-root"].running);
}
