//! Grok Build structured Chat over `grok agent stdio` (ACP JSON-RPC).
use super::{
    approval::{
        acp_choices, acp_title, approval_payload, drain_inactive_approvals, find_choice,
        validate_turn, write_failed_not_sent, ApprovalChoice, PendingApprovalState,
    },
    common::{
        encode_approval_id, history_page, insert_optional, validate_native_id, version_probe,
        CommandSpec, EnvelopeStyle, JsonLineProcess, JsonLineResponder,
    },
    acp_mcp_servers, approve_threadterm_tool, emit_bound as emit, ChatSession, ChatToolServer,
    ProviderAdapter, ProviderCapability, ProviderError, ScopedProviderEvents,
    TerminalCommand,
};
use chrono::Utc;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};
#[cfg(test)]
use super::ProviderEvent;
#[cfg(test)]
use tokio::sync::broadcast;

const GROK_SLASH_COMMANDS: &[(&str, &str)] = &[
    ("compact", "Compact the conversation context"),
    ("model", "Switch model"),
    ("thinking", "Switch reasoning effort"),
    ("mode", "Switch permission mode"),
    ("plan", "Switch to plan mode"),
    ("always-approve", "Skip permission prompts"),
    ("help", "Show slash command help"),
    ("status", "Show session status"),
    ("usage", "Show account limits and session usage"),
];

// Grok Build CLI `--permission-mode` values; ACP exposes them as session/set_mode modeId.
const GROK_PERMISSION_MODES: &[(&str, &str)] = &[
    ("default", "Default"),
    ("acceptEdits", "Accept edits"),
    ("auto", "Auto"),
    ("dontAsk", "Don't ask"),
    ("bypassPermissions", "Bypass permissions"),
    ("plan", "Plan"),
];

pub struct GrokAdapter {
    events: crate::provider_events::Sender,
    network: super::network::NetworkSettings,
}

impl GrokAdapter {
    pub fn new(
        events: crate::provider_events::Sender,
        network: super::network::NetworkSettings,
    ) -> Self {
        Self { events, network }
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn(
        &self,
        session_id: &str,
        native: Arc<Mutex<Option<String>>>,
        active_turn: Arc<Mutex<Option<String>>>,
        permissions: Arc<Mutex<HashMap<String, PermissionRequest>>>,
        ui: Arc<Mutex<GrokUiState>>,
        capture: Option<Arc<Mutex<Vec<Value>>>>,
        events: ScopedProviderEvents,
        project_events: bool,
        delegation_tools: bool,
    ) -> Result<(JsonLineProcess, Value), ProviderError> {
        // `--no-leader` is an `grok agent` flag, not `grok agent stdio`.
        // Putting it after `stdio` makes the process exit immediately with
        // "unexpected argument" and Chat surfaces "grok-acp closed its output stream".
        let spec = CommandSpec::provider("grok", &["agent", "--no-leader", "stdio"])?;
        let owned_session = session_id.to_owned();
        let responder = Arc::new(Mutex::new(None));
        let on_message = {
            let responder = Arc::clone(&responder);
            Arc::new(move |raw: Value| {
                if let Some(capture) = &capture {
                    if let Ok(mut values) = capture.lock() {
                        values.push(raw.clone());
                    }
                }
                // The parent's calls to ThreadTerm's own delegation tools are
                // approved here (Grok names them `threadterm__<tool>`).
                if delegation_tools && approve_threadterm_tool(&responder, &raw) {
                    return;
                }
                if project_events {
                    emit_grok_message(
                        &events,
                        &owned_session,
                        &native,
                        &active_turn,
                        &permissions,
                        &ui,
                        &responder,
                        raw,
                    );
                }
            })
        };
        let environment = self.network.grok_env()?;
        let environment: Vec<_> = environment
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        let process = JsonLineProcess::spawn(
            "grok-acp",
            &spec,
            None,
            &environment,
            EnvelopeStyle::JsonRpc2,
            on_message,
        )?;
        if let Ok(mut slot) = responder.lock() {
            *slot = Some(process.responder());
        }
        let initialized = process.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},
                "clientInfo": {"name":"threadterm","title":"ThreadTerm","version":env!("CARGO_PKG_VERSION")}
            }),
        )?;
        process.notification("initialized", json!({}))?;
        Ok((process, initialized))
    }

    fn temporary(
        &self,
        capture: Option<Arc<Mutex<Vec<Value>>>>,
    ) -> Result<(JsonLineProcess, Value), ProviderError> {
        self.spawn(
            "history",
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(GrokUiState::default())),
            capture,
            ScopedProviderEvents::new(self.events.clone(), "history"),
            false,
            false,
        )
    }
}

impl ProviderAdapter for GrokAdapter {
    fn id(&self) -> &'static str {
        "grok"
    }

    fn capability(&self) -> ProviderCapability {
        let (installed, version, probe_error) = version_probe("grok");
        let protocol = if installed {
            self.temporary(None)
                .map(|(_, initialized)| initialized)
                .map_err(|error| error.message)
        } else {
            Err("Grok CLI is not installed".to_owned())
        };
        let (chat, history, resume) = protocol
            .as_ref()
            .map(|initialized| {
                (
                    true,
                    has_capability(initialized, "list") && has_capability(initialized, "load"),
                    has_capability(initialized, "load") || has_capability(initialized, "resume"),
                )
            })
            .unwrap_or((false, false, false));
        ProviderCapability {
            source: "builtin",
            plugin_id: None,
            icon: None,
            sign_in: super::builtin_sign_in("grok"),
            homepage: None,
            id: "grok".to_owned(),
            name: super::builtin_name("grok").to_owned(),
            installed,
            version,
            terminal: installed,
            chat,
            history,
            resume,
            terminal_resume_capture: self.terminal_capture().as_str(),
            reason: probe_error.or_else(|| protocol.err()),
            auth: grok_auth_state(),
        }
    }

    fn terminal_command(
        &self,
        resume_id: Option<&str>,
        assign_id: Option<&str>,
    ) -> Result<TerminalCommand, ProviderError> {
        let args = if let Some(id) = resume_id {
            validate_native_id(id)?;
            vec!["--resume".to_owned(), id.to_owned()]
        } else if let Some(id) = assign_id {
            // `grok --session-id <uuid>` names a NEW conversation, so the native
            // identity is known before the PTY starts.
            validate_native_id(id)?;
            if !super::common::is_uuid(id) {
                return Err(ProviderError::new(
                    "invalid_native_id",
                    "Grok --session-id requires a UUID",
                ));
            }
            vec!["--session-id".to_owned(), id.to_owned()]
        } else {
            Vec::new()
        };
        let path = super::common::find_executable("grok").ok_or_else(|| {
            ProviderError::unavailable("grok", "grok executable was not found on PATH")
        })?;
        let spec = CommandSpec::from_path(path, args)?;
        Ok(TerminalCommand {
            program: spec.program,
            args: spec.args,
            display: spec.display,
        })
    }

    fn terminal_capture(&self) -> super::TerminalCapture {
        super::TerminalCapture::PreAssigned
    }

    fn history_list(
        &self,
        cursor: Option<&str>,
        limit: u32,
        cwd: Option<&str>,
    ) -> Result<Value, ProviderError> {
        let (process, initialized) = self.temporary(None)?;
        ensure_capability(&initialized, "list", "session/list")?;
        let result = process.request("session/list", list_params(cwd, cursor))?;
        let sessions = result
            .get("sessions")
            .or_else(|| result.get("data"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let items = sessions
            .into_iter()
            .take(limit as usize)
            .filter_map(|row| grok_history_item(&row))
            .collect::<Vec<_>>();
        let next_cursor = result
            .get("nextCursor")
            .or_else(|| result.get("cursor"))
            .and_then(Value::as_str)
            .map(|value| Value::String(value.to_owned()));
        Ok(history_page(items, next_cursor))
    }

    fn history_read(&self, native_id: &str) -> Result<Value, ProviderError> {
        validate_native_id(native_id)?;
        let captured = Arc::new(Mutex::new(Vec::new()));
        let (process, initialized) = self.temporary(Some(Arc::clone(&captured)))?;
        ensure_capability(&initialized, "load", "session/load")?;
        let cwd = if has_capability(&initialized, "list") {
            find_session_cwd(&process, native_id)?
        } else {
            None
        }
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|path| path.to_string_lossy().into_owned())
        });
        process.request(
            "session/load",
            json!({"sessionId":native_id,"cwd":cwd,"mcpServers":[]}),
        )?;
        let raw = captured.lock().map(|v| v.clone()).unwrap_or_default();
        Ok(Value::Array(grok_transcript(&raw)))
    }

    fn open_chat(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        self.open_chat_scoped(
            session_id,
            cwd,
            native_id,
            &uuid::Uuid::new_v4().to_string(),
        )
    }

    fn scopes_chat_events(&self) -> bool {
        true
    }

    fn open_chat_scoped(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
        worker_token: &str,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        self.open_chat_with_tools(session_id, cwd, native_id, worker_token, None)
    }

    fn open_chat_with_tools(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
        worker_token: &str,
        tools: Option<&ChatToolServer>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        let events = ScopedProviderEvents::new(self.events.clone(), worker_token);
        let native = Arc::new(Mutex::new(None));
        let active_turn = Arc::new(Mutex::new(None));
        let permissions = Arc::new(Mutex::new(HashMap::new()));
        let ui = Arc::new(Mutex::new(GrokUiState::default()));
        // Passed on new and on load (verified with Grok 1.0.41).
        let mcp_servers = acp_mcp_servers(tools);
        let (process, initialized) = self.spawn(
            session_id,
            Arc::clone(&native),
            Arc::clone(&active_turn),
            Arc::clone(&permissions),
            Arc::clone(&ui),
            None,
            events.clone(),
            true,
            tools.is_some(),
        )?;
        let response = if let Some(id) = native_id {
            validate_native_id(id)?;
            if has_capability(&initialized, "load") {
                process.request(
                    "session/load",
                    json!({"sessionId":id,"cwd":cwd,"mcpServers":mcp_servers}),
                )?
            } else if has_capability(&initialized, "resume") {
                process.request("session/resume", json!({"sessionId":id,"cwd":cwd}))?
            } else {
                return Err(ProviderError::new(
                    "resume_unsupported",
                    "Grok ACP agent does not advertise session resume",
                ));
            }
        } else {
            process.request("session/new", json!({"cwd":cwd,"mcpServers":mcp_servers}))?
        };
        let bound_id = response
            .get("sessionId")
            .and_then(Value::as_str)
            .or(native_id)
            .ok_or_else(|| {
                ProviderError::new("provider_protocol", "Grok ACP agent returned no session id")
            })?
            .to_owned();
        if let Ok(mut value) = native.lock() {
            *value = Some(bound_id.clone());
        }
        if let Ok(mut state) = ui.lock() {
            merge_grok_ui(&mut state, &initialized);
            merge_grok_ui(&mut state, &response);
            merge_models_update(&mut state, &response);
        }
        emit_chat_ui(&events, session_id, Some(&bound_id), &ui);
        emit(
            &events,
            "grok",
            session_id,
            Some(&bound_id),
            None,
            "session.ready",
            json!({"nativeId":bound_id}),
        );
        Ok(Box::new(GrokChat {
            process,
            session_id: session_id.to_owned(),
            native_id: bound_id,
            events,
            active_turn,
            permissions,
            ui,
            turn_started: Arc::new(Mutex::new(None)),
            usage_reply: None,
        }))
    }
}

#[derive(Clone)]
struct PermissionRequest {
    rpc_id: Value,
    turn_id: Option<String>,
    choices: Vec<ApprovalChoice>,
    state: PendingApprovalState,
}

#[derive(Clone, Default)]
struct GrokUiState {
    options: Vec<Value>,
    commands: Vec<Value>,
    retry: Option<Value>,
    subagents: GrokSubagents,
}

#[derive(Clone, Default)]
struct GrokSubagents {
    calls: HashMap<String, GrokSubagentCall>,
    pending_spawns: VecDeque<String>,
    children: HashMap<String, GrokSubagentChild>,
    sessions: HashMap<String, String>,
    pending_frames: HashMap<String, VecDeque<Value>>,
}

#[derive(Clone)]
struct GrokSubagentCall {
    info: Value,
    turn_id: Option<String>,
}

#[derive(Clone)]
struct GrokSubagentChild {
    key: String,
    next_message: u64,
    parts: Vec<Value>,
    tools: HashMap<String, Value>,
}

struct GrokSubagentEvents<'a> {
    events: &'a ScopedProviderEvents,
    session_id: &'a str,
    native_id: Option<&'a str>,
}

impl GrokSubagentEvents<'_> {
    fn emit(&self, turn: Option<&str>, kind: &str, data: Value) {
        emit(
            self.events,
            "grok",
            self.session_id,
            self.native_id,
            turn,
            kind,
            data,
        );
    }
}

fn grok_spawn_update(
    state: &mut GrokSubagents,
    update: &Value,
    turn: Option<&str>,
) -> Option<String> {
    let key = update.get("toolCallId")?.as_str()?;
    if !state.calls.contains_key(key) {
        if update
            .pointer("/_meta/x.ai~1tool/name")
            .and_then(Value::as_str)
            != Some("spawn_subagent")
        {
            return None;
        }
        state.pending_spawns.push_back(key.into());
        state.calls.insert(
            key.into(),
            GrokSubagentCall {
                info: json!({"status":"running","transcript":"live"}),
                turn_id: turn.map(str::to_owned),
            },
        );
    }
    let info = &mut state.calls.get_mut(key)?.info;
    let input = update.get("rawInput").unwrap_or(&Value::Null);
    for (field, value) in [
        ("description", input.get("description")),
        ("prompt", input.get("prompt")),
        ("agentType", input.get("subagent_type")),
    ] {
        insert_optional(info, field, value.filter(|v| !v.is_null()).cloned());
    }
    if input.get("background").is_some() || input.get("run_in_background").is_some() {
        info["background"] = json!(
            input.get("background").and_then(Value::as_bool) == Some(true)
                || input.get("run_in_background").and_then(Value::as_bool) == Some(true)
        );
    }
    let output = update.get("rawOutput").unwrap_or(&Value::Null);
    if output.get("type").and_then(Value::as_str) == Some("SubagentCompleted") {
        info["status"] = json!("completed");
        insert_optional(info, "summary", output.get("output").cloned());
        insert_optional(info, "agentType", output.get("subagent_type").cloned());
        grok_subagent_usage(info, output);
    }
    if let Some(id) = output.get("subagent_id").and_then(Value::as_str) {
        info["native"] = json!({"kind":"grok-subagent","id":id});
    }
    if matches!(
        update.get("status").and_then(Value::as_str),
        Some("failed" | "error")
    ) {
        info["status"] = json!("failed");
    }
    // A completed spawn tool can merely acknowledge a background task's ID.
    // Only SubagentCompleted or subagent_finished settles that task.
    crate::db::bound_json(info);
    Some(key.into())
}

fn grok_subagent_usage(info: &mut Value, update: &Value) {
    let mut usage = info.get("usage").cloned().unwrap_or_else(|| json!({}));
    for (field, value) in [
        ("totalTokens", update.get("tokens_used")),
        (
            "toolUses",
            update
                .get("tool_call_count")
                .or_else(|| update.get("tool_calls")),
        ),
        ("durationMs", update.get("duration_ms")),
    ] {
        insert_optional(&mut usage, field, value.filter(|v| v.is_u64()).cloned());
    }
    if usage.as_object().is_some_and(|usage| !usage.is_empty()) {
        info["usage"] = usage;
    }
}

impl GrokSubagents {
    fn emit_card(&self, sink: &GrokSubagentEvents<'_>, key: &str) {
        if let Some(call) = self.calls.get(key) {
            sink.emit(
                call.turn_id.as_deref(),
                "chat.subagent",
                json!({"key":key,"info":call.info}),
            );
        }
    }

    fn notification(
        &mut self,
        sink: &GrokSubagentEvents<'_>,
        kind: &str,
        update: &Value,
        turn: Option<&str>,
    ) {
        let id = update.get("subagent_id").and_then(Value::as_str);
        let child = update
            .get("child_session_id")
            .and_then(Value::as_str)
            .or(id);
        let Some(child) = child else { return };
        if kind == "subagent_spawned" {
            let existing = self
                .sessions
                .get(child)
                .and_then(|session| self.children.get(session))
                .map(|child| child.key.clone());
            let key = existing.unwrap_or_else(|| {
                let matching = self.pending_spawns.iter().position(|key| {
                    self.calls
                        .get(key)
                        .and_then(|call| call.info.get("description"))
                        .and_then(Value::as_str)
                        == update.get("description").and_then(Value::as_str)
                });
                matching
                    .and_then(|index| self.pending_spawns.remove(index))
                    .or_else(|| self.pending_spawns.pop_front())
                    .unwrap_or_else(|| id.unwrap_or(child).to_owned())
            });
            let call = self
                .calls
                .entry(key.clone())
                .or_insert_with(|| GrokSubagentCall {
                    info: json!({"status":"running","transcript":"live"}),
                    turn_id: turn.map(str::to_owned),
                });
            for (field, value) in [
                ("description", update.get("description")),
                ("agentType", update.get("subagent_type")),
                ("model", update.get("model")),
            ] {
                insert_optional(
                    &mut call.info,
                    field,
                    value.filter(|v| !v.is_null()).cloned(),
                );
            }
            call.info["native"] = json!({"kind":"grok-subagent","id":id.unwrap_or(child)});
            self.children
                .entry(child.into())
                .or_insert_with(|| GrokSubagentChild {
                    key: key.clone(),
                    next_message: 0,
                    parts: Vec::new(),
                    tools: HashMap::new(),
                });
            self.sessions.insert(child.into(), child.into());
            if let Some(id) = id {
                self.sessions.insert(id.into(), child.into());
            }
            self.emit_card(sink, &key);
            if let Some(frames) = self.pending_frames.remove(child) {
                for frame in frames {
                    self.child_frame(sink, child, frame);
                }
            }
            return;
        }
        let Some(session) = self
            .sessions
            .get(child)
            .or_else(|| id.and_then(|id| self.sessions.get(id)))
            .cloned()
        else {
            return;
        };
        let Some(key) = self.children.get(&session).map(|child| child.key.clone()) else {
            return;
        };
        if kind == "subagent_finished" {
            self.flush_child(sink, &session);
        }
        if let Some(call) = self.calls.get_mut(&key) {
            grok_subagent_usage(&mut call.info, update);
            if kind == "subagent_finished" {
                call.info["status"] = json!(match update.get("status").and_then(Value::as_str) {
                    Some("completed") => "completed",
                    Some("failed") => "failed",
                    Some("cancelled") => "cancelled",
                    _ => "unknown",
                });
                insert_optional(&mut call.info, "summary", update.get("output").cloned());
            }
            crate::db::bound_json(&mut call.info);
        }
        self.emit_card(sink, &key);
    }

    fn flush_child(&mut self, sink: &GrokSubagentEvents<'_>, session: &str) {
        let Some(child) = self.children.get_mut(session) else {
            return;
        };
        if child.parts.is_empty() {
            return;
        }
        let parts = std::mem::take(&mut child.parts);
        let item_id = format!("{session}:m{}", child.next_message);
        child.next_message += 1;
        let turn = self
            .calls
            .get(&child.key)
            .and_then(|call| call.turn_id.as_deref());
        sink.emit(
            turn,
            "chat.subagent.item",
            json!({"key":child.key,
            "item":{"id":item_id,"role":"assistant","parts":parts}}),
        );
    }

    fn child_frame(&mut self, sink: &GrokSubagentEvents<'_>, session: &str, raw: Value) {
        let Some(bound) = self.sessions.get(session).cloned() else {
            let frames = self.pending_frames.entry(session.into()).or_default();
            if frames.len() >= 200 {
                frames.pop_front();
            }
            frames.push_back(raw);
            return;
        };
        let method = raw
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(update) = raw.pointer("/params/update") else {
            return;
        };
        let kind = update
            .get("sessionUpdate")
            .or_else(|| update.get("type"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if (method == "session/update" && kind == "tool_call")
            || (method == "_x.ai/session_notification"
                && matches!(
                    kind,
                    "response_completed" | "turn_completed" | "subagent_finished"
                ))
        {
            self.flush_child(sink, &bound);
        }
        if method != "session/update" {
            return;
        }
        let Some(child) = self.children.get_mut(&bound) else {
            return;
        };
        match kind {
            "agent_message_chunk" | "agent_thought_chunk" => {
                if let Some(text) = grok_update_text(update) {
                    let part_type = grok_part_type(kind).unwrap_or("text");
                    if let Some(part) = child
                        .parts
                        .last_mut()
                        .filter(|part| part["type"] == part_type)
                    {
                        if let Some(prior) = part["text"].as_str() {
                            part["text"] = json!(format!("{prior}{text}"));
                        }
                    } else {
                        child.parts.push(json!({"type":part_type,"text":text}));
                    }
                }
            }
            "user_message_chunk" => {
                if let Some(text) = grok_update_text(update) {
                    let item_id = format!("{bound}:m{}", child.next_message);
                    child.next_message += 1;
                    let turn = self
                        .calls
                        .get(&child.key)
                        .and_then(|call| call.turn_id.as_deref());
                    sink.emit(
                        turn,
                        "chat.subagent.item",
                        json!({"key":child.key,
                        "item":{"id":item_id,"role":"user","parts":[{"type":"text","text":text}]}}),
                    );
                }
            }
            "tool_call" | "tool_call_update" => {
                let Some(id) = update.get("toolCallId").and_then(Value::as_str) else {
                    return;
                };
                let prior = child.tools.get(id);
                let status = update
                    .get("status")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        prior
                            .and_then(|prior| prior.get("status"))
                            .and_then(Value::as_str)
                    })
                    .unwrap_or("running");
                let prior_status = prior
                    .and_then(|prior| prior.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or("running");
                if prior.is_some()
                    && status == prior_status
                    && !matches!(
                        status,
                        "completed" | "complete" | "success" | "failed" | "error"
                    )
                {
                    return;
                }
                let mut tool = prior.cloned().unwrap_or_else(|| json!({}));
                if let Some(fields) = update.as_object() {
                    for (field, value) in fields {
                        tool[field] = value.clone();
                    }
                }
                if let Some(output) = tool
                    .pointer_mut("/rawOutput/output")
                    .filter(|v| v.is_array())
                {
                    *output = json!([]);
                }
                crate::db::bound_json(&mut tool);
                if prior == Some(&tool) {
                    return;
                }
                let part = grok_tool_part(&tool, "running");
                child.tools.insert(id.into(), tool);
                let turn = self
                    .calls
                    .get(&child.key)
                    .and_then(|call| call.turn_id.as_deref());
                sink.emit(
                    turn,
                    "chat.subagent.item",
                    json!({"key":child.key,"merge":true,
                    "item":{"id":format!("{bound}:{id}"),"role":"tool","parts":[part]}}),
                );
            }
            _ => {}
        }
    }
}

struct GrokChat {
    process: JsonLineProcess,
    session_id: String,
    native_id: String,
    events: ScopedProviderEvents,
    active_turn: Arc<Mutex<Option<String>>>,
    permissions: Arc<Mutex<HashMap<String, PermissionRequest>>>,
    ui: Arc<Mutex<GrokUiState>>,
    turn_started: Arc<Mutex<Option<Instant>>>,
    usage_reply: Option<Arc<GrokUsageReply>>,
}

#[derive(Default)]
struct GrokUsageResults {
    session: Option<Result<Value, ProviderError>>,
    billing: Option<Result<Value, ProviderError>>,
}

/// Join independent account and session queries into one terminal reply.
/// Native callbacks and cancellation share the active-turn fence, so a late
/// account response cannot append a card to a cancelled or newer turn.
struct GrokUsageReply {
    events: ScopedProviderEvents,
    session_id: String,
    native_id: String,
    turn_id: String,
    active_turn: Arc<Mutex<Option<String>>>,
    started: Instant,
    results: Mutex<GrokUsageResults>,
    done: Mutex<bool>,
    wake: Condvar,
}

impl GrokUsageReply {
    fn mark_done(&self) {
        if let Ok(mut done) = self.done.lock() {
            *done = true;
            self.wake.notify_one();
        }
    }

    fn wait_timeout(&self, duration: Duration) {
        let expired = match self.done.lock() {
            Ok(done) => self
                .wake
                .wait_timeout_while(done, duration, |done| !*done)
                .map(|(done, _)| !*done)
                .unwrap_or(false),
            Err(_) => false,
        };
        // The condition-variable guard is dropped before the active-turn
        // fence is taken; completion/cancel take active-turn before done.
        if expired {
            self.timeout();
        }
    }

    fn record(&self, billing: bool, result: Result<Value, ProviderError>) {
        if let Ok(mut results) = self.results.lock() {
            let slot = if billing {
                &mut results.billing
            } else {
                &mut results.session
            };
            if slot.is_none() {
                *slot = Some(result);
            }
        }
        self.finish();
    }

    fn finish(&self) {
        let Ok(mut active) = self.active_turn.lock() else {
            return;
        };
        if active.as_deref() != Some(self.turn_id.as_str()) {
            return;
        }
        let Ok(results) = self.results.lock() else {
            return;
        };
        let (Some(session), Some(billing)) = (&results.session, &results.billing) else {
            return;
        };
        emit(
            &self.events,
            "grok",
            &self.session_id,
            Some(&self.native_id),
            Some(&self.turn_id),
            "chat.item",
            json!({"parts":grok_usage_parts(session, billing)}),
        );
        emit(
            &self.events,
            "grok",
            &self.session_id,
            Some(&self.native_id),
            Some(&self.turn_id),
            "chat.turn.completed",
            json!({"elapsedMs":self.started.elapsed().as_millis() as u64}),
        );
        *active = None;
        self.mark_done();
    }

    fn timeout(&self) {
        if let Ok(mut results) = self.results.lock() {
            let error = ProviderError::new("provider_timeout", "Grok usage query timed out");
            results.session.get_or_insert_with(|| Err(error.clone()));
            results.billing.get_or_insert(Err(error));
        }
        self.finish();
    }

    fn cancel(&self) -> bool {
        let Ok(mut active) = self.active_turn.lock() else {
            return false;
        };
        if active.as_deref() != Some(self.turn_id.as_str()) {
            return false;
        }
        emit(
            &self.events,
            "grok",
            &self.session_id,
            Some(&self.native_id),
            Some(&self.turn_id),
            "chat.turn.completed",
            json!({"cancelled":true,"elapsedMs":self.started.elapsed().as_millis() as u64}),
        );
        *active = None;
        self.mark_done();
        true
    }
}

impl GrokChat {
    fn start_usage(&mut self, operation_id: &str) -> Result<Value, ProviderError> {
        {
            let mut active = self
                .active_turn
                .lock()
                .map_err(|_| ProviderError::new("provider_internal", "Grok turn lock poisoned"))?;
            if active.is_some() {
                return Err(ProviderError::new(
                    "turn_in_progress",
                    "Grok session already has an active turn",
                ));
            }
            *active = Some(operation_id.to_owned());
        }
        let reply = Arc::new(GrokUsageReply {
            events: self.events.clone(),
            session_id: self.session_id.clone(),
            native_id: self.native_id.clone(),
            turn_id: operation_id.to_owned(),
            active_turn: Arc::clone(&self.active_turn),
            started: Instant::now(),
            results: Mutex::new(GrokUsageResults::default()),
            done: Mutex::new(false),
            wake: Condvar::new(),
        });
        self.usage_reply = Some(Arc::clone(&reply));
        emit(
            &self.events,
            "grok",
            &self.session_id,
            Some(&self.native_id),
            Some(operation_id),
            "chat.turn.started",
            json!({}),
        );
        for (billing, method, params) in [
            (
                false,
                "_x.ai/session/usage",
                json!({"sessionId":self.native_id}),
            ),
            (true, "_x.ai/billing", json!({})),
        ] {
            let callback = Arc::downgrade(&reply);
            if let Err(error) = self.process.request_async(method, params, move |result| {
                if let Some(reply) = callback.upgrade() {
                    reply.record(billing, result);
                }
            }) {
                reply.record(billing, Err(error));
            }
        }
        std::thread::spawn(move || reply.wait_timeout(Duration::from_secs(30)));
        Ok(json!({"turnId":operation_id}))
    }

    fn reply_command(&mut self, operation_id: &str, text: &str) {
        emit(
            &self.events,
            "grok",
            &self.session_id,
            Some(&self.native_id),
            Some(operation_id),
            "chat.item",
            json!({"parts":[{"type":"text","text":text,"status":"complete"}]}),
        );
    }

    fn option_command(
        &mut self,
        name: &str,
        args: &str,
        operation_id: &str,
    ) -> Result<Value, ProviderError> {
        let option_id = match name {
            "model" => "model",
            "mode" | "permission" => "mode",
            _ => "thinking",
        };
        let option = self.ui.lock().ok().and_then(|state| {
            state
                .options
                .iter()
                .find(|option| option.get("id").and_then(Value::as_str) == Some(option_id))
                .cloned()
        });
        let Some(option) = option else {
            self.reply_command(
                operation_id,
                &format!("/{name} is not available in this session."),
            );
            return Ok(json!({"turnId":operation_id}));
        };
        let choices = option
            .get("choices")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if args.is_empty() {
            let listing = choices
                .iter()
                .filter_map(|choice| {
                    Some(format!(
                        "- {} ({})",
                        choice.get("name").and_then(Value::as_str)?,
                        choice.get("value").and_then(Value::as_str)?
                    ))
                })
                .collect::<Vec<_>>()
                .join("\n");
            self.reply_command(operation_id, &format!("/{name} <value>\n{listing}"));
            return Ok(json!({"turnId":operation_id}));
        }
        let matched = choices.iter().find(|choice| {
            choice.get("value").and_then(Value::as_str) == Some(args)
                || choice
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.eq_ignore_ascii_case(args))
        });
        let Some(matched) = matched else {
            self.reply_command(operation_id, &format!("Unknown {name} \"{args}\"."));
            return Ok(json!({"turnId":operation_id}));
        };
        let value = matched
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or(args)
            .to_owned();
        let label = matched
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&value)
            .to_owned();
        match self.set_option(option_id, &value) {
            Ok(_) => self.reply_command(operation_id, &format!("{name}: {label}")),
            Err(error) => self.reply_command(
                operation_id,
                &format!("Failed to switch {name}: {}", error.message),
            ),
        }
        Ok(json!({"turnId":operation_id}))
    }

    fn dispatch_slash(
        &mut self,
        text: &str,
        operation_id: &str,
    ) -> Result<Option<Value>, ProviderError> {
        let Some((name, args)) = parse_slash(text) else {
            return Ok(None);
        };
        match name.to_ascii_lowercase().as_str() {
            "model" | "thinking" | "mode" | "permission" => self
                .option_command(&name.to_ascii_lowercase(), args, operation_id)
                .map(Some),
            "plan" => {
                let mode = match args {
                    "" | "on" | "true" | "1" => "plan",
                    "off" | "false" | "0" => "default",
                    _ => {
                        self.reply_command(operation_id, "Usage: /plan [on|off]");
                        return Ok(Some(json!({"turnId":operation_id})));
                    }
                };
                self.option_command("mode", mode, operation_id).map(Some)
            }
            "always-approve" | "yolo" => {
                let mode = match args {
                    "" | "on" | "true" | "1" => "bypassPermissions",
                    "off" | "false" | "0" => "default",
                    _ => {
                        self.reply_command(operation_id, "Usage: /always-approve [on|off]");
                        return Ok(Some(json!({"turnId":operation_id})));
                    }
                };
                self.option_command("mode", mode, operation_id).map(Some)
            }
            "help" => {
                let commands = GROK_SLASH_COMMANDS
                    .iter()
                    .map(|(name, description)| format!("- /{name} — {description}"))
                    .collect::<Vec<_>>()
                    .join("\n");
                self.reply_command(operation_id, &format!("Grok Chat commands\n\n{commands}\n\nAliases: /cost → /usage; /info, /session-info, /context → /status; /permission → /mode; /yolo → /always-approve.\n\nOther Grok terminal commands and skills are not executed as model messages here."));
                Ok(Some(json!({"turnId":operation_id})))
            }
            "compact" => {
                if !args.is_empty() {
                    self.reply_command(operation_id, "Usage: /compact. Additional instructions are not supported by this interface.");
                    return Ok(Some(json!({"turnId":operation_id})));
                }
                self.start_turn(
                    "_x.ai/compact_conversation",
                    json!({"sessionId":self.native_id}),
                    operation_id,
                )
                .map(Some)
            }
            "usage" | "cost" => {
                if !matches!(args, "" | "show") {
                    self.reply_command(
                        operation_id,
                        "Usage: /usage [show]. Manage billing in the Grok terminal.",
                    );
                    return Ok(Some(json!({"turnId":operation_id})));
                }
                self.start_usage(operation_id).map(Some)
            }
            "status" | "info" | "session-info" | "context" => {
                if !args.is_empty() {
                    self.reply_command(
                        operation_id,
                        &format!("/{name} does not accept arguments."),
                    );
                    return Ok(Some(json!({"turnId":operation_id})));
                }
                let reply = match self.process.request("_x.ai/session/info", json!({"sessionId":self.native_id})) {
                    Ok(value) => grok_info_text(&value)
                        .unwrap_or_else(|| format!("Grok did not return usable data for /{name}. No usage or status values have been inferred.")),
                    Err(error) => format!("Could not run /{name}: {}\nThis command was not sent to the model.", error.message),
                };
                self.reply_command(operation_id, &reply);
                Ok(Some(json!({"turnId":operation_id})))
            }
            _ => {
                self.reply_command(operation_id, &format!("/{name} is not supported in Grok Chat. Use /help for available commands, or run this command in the Grok terminal. It was not sent to the model."));
                Ok(Some(json!({"turnId":operation_id})))
            }
        }
    }

    fn start_prompt(&mut self, text: &str, operation_id: &str) -> Result<Value, ProviderError> {
        self.start_turn(
            "session/prompt",
            json!({"sessionId":self.native_id,"prompt":[{"type":"text","text":text}]}),
            operation_id,
        )
    }

    fn start_turn(
        &mut self,
        method: &str,
        params: Value,
        operation_id: &str,
    ) -> Result<Value, ProviderError> {
        let compact = method == "_x.ai/compact_conversation";
        {
            let mut active = self
                .active_turn
                .lock()
                .map_err(|_| ProviderError::new("provider_internal", "Grok turn lock poisoned"))?;
            if active.is_some() {
                return Err(ProviderError::new(
                    "turn_in_progress",
                    "Grok session already has an active turn",
                ));
            }
            *active = Some(operation_id.to_owned());
        }
        if let Ok(mut started) = self.turn_started.lock() {
            *started = Some(Instant::now());
        }
        let events = self.events.clone();
        let session_id = self.session_id.clone();
        let native_id = self.native_id.clone();
        let turn_id = operation_id.to_owned();
        let active = Arc::clone(&self.active_turn);
        let permissions = Arc::clone(&self.permissions);
        let started = Arc::clone(&self.turn_started);
        let retry_ui = Arc::clone(&self.ui);
        if let Ok(mut ui) = self.ui.lock() {
            ui.retry = None;
        }
        // The reader can finish a fast native request before request_async
        // returns. Publish start before handing the frame to that reader.
        emit(
            &self.events,
            "grok",
            &self.session_id,
            Some(&self.native_id),
            Some(operation_id),
            "chat.turn.started",
            json!({}),
        );
        let request = self.process.request_async(
            method,
            params,
            move |result| {
                if let Ok(mut pending) = permissions.lock() {
                    drain_inactive_approvals(&mut pending, |item| item.turn_id.as_deref(), None);
                }
                let duration_ms = started
                    .lock()
                    .ok()
                    .and_then(|value| *value)
                    .map(|instant| instant.elapsed().as_millis() as u64)
                    .unwrap_or(0);
                if let Ok(mut ui) = retry_ui.lock() {
                    if let Some(mut retry) = ui.retry.take() {
                        let failed = result.is_err()
                            || retry.get("state").and_then(Value::as_str) == Some("failed")
                            || result.as_ref().ok().and_then(|value| value.get("stopReason")).and_then(Value::as_str) == Some("error");
                        let cancelled = result.as_ref().ok().and_then(|value| value.get("stopReason")).and_then(Value::as_str) == Some("cancelled");
                        retry["state"] = json!(if failed { "failed" } else if cancelled { "stopped" } else { "complete" });
                        emit_grok_retry(&events, &session_id, Some(&native_id), &turn_id, retry);
                    }
                }
                let mut active = active.lock().ok();
                if compact && result.is_ok() {
                    emit(
                        &events,
                        "grok",
                        &session_id,
                        Some(&native_id),
                        Some(&turn_id),
                        "chat.item",
                        json!({"parts":[{"type":"text","text":"Grok completed conversation compaction.","status":"complete"}]}),
                    );
                }
                match result {
                    Ok(value) => emit(
                        &events,
                        "grok",
                        &session_id,
                        Some(&native_id),
                        Some(&turn_id),
                        "chat.turn.completed",
                        json!({"result":value,"elapsedMs":duration_ms}),
                    ),
                    Err(error) => emit(
                        &events,
                        "grok",
                        &session_id,
                        Some(&native_id),
                        Some(&turn_id),
                        "chat.error",
                        json!({"code":error.code,"message":error.message,"details":error.details,"elapsedMs":duration_ms}),
                    ),
                }
                if let Some(active) = active.as_mut() {
                    if active.as_deref() == Some(turn_id.as_str()) {
                        **active = None;
                    }
                }
            },
        );
        if let Err(error) = request {
            if let Ok(mut active) = self.active_turn.lock() {
                *active = None;
            }
            if let Ok(mut pending) = self.permissions.lock() {
                drain_inactive_approvals(&mut pending, |item| item.turn_id.as_deref(), None);
            }
            emit(
                &self.events,
                "grok",
                &self.session_id,
                Some(&self.native_id),
                Some(operation_id),
                "chat.error",
                json!({"code":error.code,"message":error.message}),
            );
            return Err(error);
        }
        Ok(json!({"turnId":operation_id}))
    }
}

impl ChatSession for GrokChat {
    fn native_id(&self) -> Option<String> {
        Some(self.native_id.clone())
    }

    fn is_alive(&self) -> bool {
        self.process.is_alive()
    }

    fn send(&mut self, text: &str, operation_id: &str) -> Result<Value, ProviderError> {
        validate_native_id(operation_id)?;
        if let Some(result) = self.dispatch_slash(text, operation_id)? {
            return Ok(result);
        }
        self.start_prompt(text, operation_id)
    }

    fn cancel(&mut self, turn_id: &str) -> Result<(), ProviderError> {
        if let Some(reply) = self
            .usage_reply
            .as_ref()
            .filter(|reply| reply.turn_id == turn_id)
        {
            if reply.cancel() {
                return Ok(());
            }
        }
        let matches = self
            .active_turn
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "Grok turn lock poisoned"))?
            .as_deref()
            == Some(turn_id);
        if !matches {
            return Err(ProviderError::new(
                "turn_not_active",
                "the requested Grok turn is not active",
            ));
        }
        self.process
            .notification("session/cancel", json!({"sessionId":self.native_id}))
    }

    fn approve(
        &mut self,
        turn_id: &str,
        approval_id: &str,
        choice_id: &str,
        operation_id: &str,
    ) -> Result<(), ProviderError> {
        let mut permissions = self.permissions.lock().map_err(|_| {
            ProviderError::new("provider_internal", "Grok permission lock poisoned")
        })?;
        let pending = permissions.get_mut(approval_id).ok_or_else(|| {
            ProviderError::new(
                "approval_not_pending",
                "Grok approval is unknown or already resolved",
            )
        })?;
        let active_turn = self.active_turn.lock().ok().and_then(|value| value.clone());
        validate_turn(pending.turn_id.as_deref(), active_turn.as_deref(), turn_id)?;
        find_choice(&pending.choices, choice_id)?;
        match pending.state.begin_submit(operation_id) {
            Ok(()) => {}
            Err(error) if error.code == "approval_duplicate" => return Ok(()),
            Err(error) => return Err(error),
        }
        let rpc_id = pending.rpc_id.clone();
        drop(permissions);
        let still_active = self
            .active_turn
            .lock()
            .ok()
            .and_then(|value| value.clone())
            .as_deref()
            == Some(turn_id);
        if !still_active {
            return Err(ProviderError::new(
                "approval_stale",
                "approval is not bound to a live turn",
            ));
        }
        let outcome = json!({"outcome":{"outcome":"selected","optionId":choice_id}});
        let result = self.process.respond(rpc_id, outcome);
        let mut permissions = self.permissions.lock().map_err(|_| {
            ProviderError::new("provider_internal", "Grok permission lock poisoned")
        })?;
        match result {
            Ok(()) => {
                permissions.remove(approval_id);
                emit(
                    &self.events,
                    "grok",
                    &self.session_id,
                    Some(&self.native_id),
                    Some(turn_id),
                    "chat.approval.resolved",
                    json!({"approvalId":approval_id,"outcome":"submitted"}),
                );
                Ok(())
            }
            Err(error) if write_failed_not_sent(&error) => {
                if let Some(pending) = permissions.get_mut(approval_id) {
                    pending.state.clear_submit();
                }
                Err(error)
            }
            Err(error) => {
                if let Some(pending) = permissions.get_mut(approval_id) {
                    pending.state.mark_unknown();
                }
                emit(
                    &self.events,
                    "grok",
                    &self.session_id,
                    Some(&self.native_id),
                    Some(turn_id),
                    "chat.approval.resolved",
                    json!({"approvalId":approval_id,"status":"outcomeUnknown","outcome":"unknown"}),
                );
                Err(ProviderError::new(
                    "approval_outcome_unknown",
                    error.message,
                ))
            }
        }
    }

    fn stop(&mut self) -> Result<(), ProviderError> {
        if self
            .usage_reply
            .as_ref()
            .is_some_and(|reply| reply.cancel())
        {
            return Ok(());
        }
        if self
            .active_turn
            .lock()
            .ok()
            .and_then(|value| value.clone())
            .is_some()
        {
            let _ = self
                .process
                .notification("session/cancel", json!({"sessionId":self.native_id}));
        }
        Ok(())
    }

    fn ui_state(&self) -> Value {
        self.ui
            .lock()
            .ok()
            .map(|state| json!({"options":state.options.clone(),"commands":state.commands.clone()}))
            .unwrap_or_else(|| json!({"options":[],"commands":[]}))
    }

    fn set_option(&mut self, option_id: &str, value: &str) -> Result<Value, ProviderError> {
        if option_id == "mode" {
            self.process.request(
                "session/set_mode",
                json!({"sessionId":self.native_id,"modeId":value}),
            )?;
            if let Ok(mut state) = self.ui.lock() {
                ensure_permission_mode(&mut state);
                if let Some(option) = state
                    .options
                    .iter_mut()
                    .find(|option| option.get("id").and_then(Value::as_str) == Some("mode"))
                {
                    option["value"] = json!(value);
                }
            }
            emit_chat_ui(
                &self.events,
                &self.session_id,
                Some(&self.native_id),
                &self.ui,
            );
            return Ok(self.ui_state());
        }
        let config_id = match option_id {
            "thinking" => "reasoning_effort",
            other => other,
        };
        let result = self.process.request(
            "session/set_config_option",
            json!({"sessionId":self.native_id,"configId":config_id,"value":value}),
        );
        let result = match result {
            Ok(value) => value,
            Err(_) if option_id == "model" => self.process.request(
                "session/set_model",
                json!({"sessionId":self.native_id,"modelId":value}),
            )?,
            Err(error) => return Err(error),
        };
        if let Ok(mut state) = self.ui.lock() {
            merge_grok_ui(&mut state, &result);
            if let Some(option) = state
                .options
                .iter_mut()
                .find(|option| option.get("id").and_then(Value::as_str) == Some(option_id))
            {
                option["value"] = json!(value);
            }
        }
        emit_chat_ui(
            &self.events,
            &self.session_id,
            Some(&self.native_id),
            &self.ui,
        );
        Ok(self.ui_state())
    }
}

fn grok_auth_state() -> String {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    let Some(home) = home else {
        return "unknown".to_owned();
    };
    if std::path::Path::new(&home)
        .join(".grok")
        .join("auth.json")
        .is_file()
    {
        "authenticated".to_owned()
    } else {
        "unknown".to_owned()
    }
}

fn has_capability(initialized: &Value, name: &str) -> bool {
    let caps = initialized.get("agentCapabilities").unwrap_or(initialized);
    let legacy = match name {
        "load" => "loadSession",
        "resume" => "resumeSession",
        "list" => "listSessions",
        other => other,
    };
    let supported = |value: Option<&Value>| {
        value.is_some_and(|value| value.as_bool().unwrap_or_else(|| value.is_object()))
    };
    supported(caps.get(legacy))
        || supported(
            caps.get("sessionCapabilities")
                .and_then(|value| value.get(name)),
        )
}

fn ensure_capability(
    initialized: &Value,
    name: &str,
    operation: &str,
) -> Result<(), ProviderError> {
    if has_capability(initialized, name) {
        Ok(())
    } else {
        Err(ProviderError::new(
            "history_unsupported",
            format!("Grok ACP agent does not advertise {operation}"),
        ))
    }
}

fn list_params(cwd: Option<&str>, cursor: Option<&str>) -> Value {
    let mut params = serde_json::Map::new();
    if let Some(cwd) = cwd {
        params.insert("cwd".to_owned(), Value::String(cwd.to_owned()));
    }
    if let Some(cursor) = cursor {
        params.insert("cursor".to_owned(), Value::String(cursor.to_owned()));
    }
    Value::Object(params)
}

fn find_session_cwd(
    process: &JsonLineProcess,
    native_id: &str,
) -> Result<Option<String>, ProviderError> {
    let mut cursor = None::<String>;
    for _ in 0..100 {
        let result = process.request("session/list", list_params(None, cursor.as_deref()))?;
        if let Some(row) = result
            .get("sessions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|row| {
                row.get("sessionId")
                    .or_else(|| row.get("id"))
                    .and_then(Value::as_str)
                    == Some(native_id)
            })
        {
            return Ok(row
                .get("cwd")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned));
        }
        cursor = result
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    Ok(None)
}

#[allow(clippy::too_many_arguments)]
fn grok_reverse_rpc(raw: &Value) -> Option<(Value, String)> {
    let id = raw.get("id").cloned()?;
    let method = raw.get("method").and_then(Value::as_str)?.to_owned();
    if raw.get("result").is_some() || raw.get("error").is_some() {
        return None;
    }
    Some((id, method))
}

fn reject_unknown_grok_rpc(responder: &Mutex<Option<JsonLineResponder>>, raw: &Value) -> bool {
    let Some((id, method)) = grok_reverse_rpc(raw) else {
        return false;
    };
    if method == "session/request_permission" {
        return false;
    }
    if let Ok(slot) = responder.lock() {
        if let Some(responder) = slot.as_ref() {
            let _ = responder.reject(id, -32601, "Method not found");
        }
    }
    true
}

#[allow(clippy::too_many_arguments)]
fn emit_grok_message(
    events: &ScopedProviderEvents,
    session_id: &str,
    native: &Mutex<Option<String>>,
    active_turn: &Mutex<Option<String>>,
    permissions: &Mutex<HashMap<String, PermissionRequest>>,
    ui: &Mutex<GrokUiState>,
    responder: &Mutex<Option<JsonLineResponder>>,
    raw: Value,
) {
    let method = raw
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("provider.event");
    let update_session_id = raw
        .get("params")
        .and_then(|params| params.get("sessionId"))
        .and_then(Value::as_str);
    let parent_native_id = native.lock().ok().and_then(|value| value.clone());
    if grok_reverse_rpc(&raw).is_none() && update_session_id.is_some_and(|update_id| {
            parent_native_id
                .as_deref()
                .is_some_and(|parent| parent != update_id)
        })
    {
        if let Ok(mut state) = ui.lock() {
            let child_session = update_session_id.unwrap_or_default().to_owned();
            state.subagents.child_frame(&GrokSubagentEvents {
                events, session_id, native_id: parent_native_id.as_deref(),
            }, &child_session, raw);
        }
        return;
    }
    // Reverse RPCs from a bound child belong to the parent Chat lifecycle.
    // In particular, a child's turn/session ID must not rebind the parent
    // session or make its approval impossible to submit.
    let child_request = update_session_id.and_then(|id| {
        ui.lock().ok().and_then(|state| {
            let child = state.subagents.children.get(id)?;
            let call = state.subagents.calls.get(&child.key)?;
            Some((child.key.clone(), call.info.clone(), call.turn_id.clone()))
        })
    });
    if reject_unknown_grok_rpc(responder, &raw) {
        return;
    }
    let native_id = if child_request.is_some() {
        parent_native_id.clone()
    } else {
        raw.get("params")
            .and_then(|params| params.get("sessionId"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or(parent_native_id)
    };
    let params = raw.get("params").cloned().unwrap_or_else(|| raw.clone());
    let turn_id = if let Some((_, _, turn)) = &child_request {
        turn.clone()
            .or_else(|| active_turn.lock().ok().and_then(|value| value.clone()))
    } else {
        params
            .get("turnId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| active_turn.lock().ok().and_then(|value| value.clone()))
    };
    if method == "session/request_permission" && raw.get("id").is_some() {
        let rpc_id = raw.get("id").cloned().unwrap_or(Value::Null);
        let approval_id = encode_approval_id(&rpc_id);
        let options = params
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let choices = acp_choices(&options);
        if let Ok(mut values) = permissions.lock() {
            values.insert(
                approval_id.clone(),
                PermissionRequest {
                    rpc_id,
                    turn_id: turn_id.clone(),
                    choices: choices.clone(),
                    state: PendingApprovalState::default(),
                },
            );
        }
        let mut payload = approval_payload(
            &approval_id,
            "grok",
            "session/request_permission",
            &acp_title(&params),
            &params,
            &choices,
            turn_id.as_deref(),
            !choices.is_empty(),
        );
        if let Some((key, info, _)) = &child_request {
            let label = info
                .get("description")
                .and_then(Value::as_str)
                .filter(|label| !label.is_empty())
                .or_else(|| info.get("agentType").and_then(Value::as_str))
                .unwrap_or("Subagent");
            payload["subagent"] = json!({"key":key,"label":label});
        }
        emit(
            events,
            "grok",
            session_id,
            native_id.as_deref(),
            turn_id.as_deref(),
            "chat.approval",
            json!({
                "approvalId":approval_id,
                "request":params,
                "choices":choices,
                "part":{"type":"approval","approvalId":approval_id,"status":"pending","data":payload}
            }),
        );
        return;
    }
    if method == "_x.ai/models/update" {
        if let Ok(mut state) = ui.lock() {
            merge_models_update(&mut state, &params);
        }
        emit_chat_ui(events, session_id, native_id.as_deref(), ui);
        return;
    }
    let update = params.get("update").unwrap_or(&params);
    let kind = update
        .get("sessionUpdate")
        .or_else(|| update.get("type"))
        .and_then(Value::as_str)
        .unwrap_or(method);
    if method == "_x.ai/session_notification"
        && matches!(kind, "subagent_spawned" | "subagent_progress" | "subagent_finished")
    {
        if let Ok(mut state) = ui.lock() {
            state.subagents.notification(&GrokSubagentEvents {
                events, session_id, native_id: native_id.as_deref(),
            }, kind, update, turn_id.as_deref());
        }
        return;
    }
    if kind == "retry_state" {
        if let Some(turn_id) = turn_id.as_deref() {
            let retry = json!({
                "kind":"providerRetry",
                "state":update.get("type").and_then(Value::as_str).unwrap_or("retrying"),
                "attempt":update.get("attempt").and_then(Value::as_u64),
                "maxRetries":update.get("max_retries").and_then(Value::as_u64),
                "errorType":update.get("error_type").and_then(Value::as_str).unwrap_or("network")
            });
            if let Ok(mut state) = ui.lock() {
                state.retry = Some(retry.clone());
            }
            emit_grok_retry(events, session_id, native_id.as_deref(), turn_id, retry);
        }
        return;
    }
    if kind == "available_commands_update" || kind.contains("config") || kind.contains("Config") {
        if let Ok(mut state) = ui.lock() {
            merge_grok_ui(&mut state, update);
            merge_grok_ui(&mut state, &params);
        }
        emit_chat_ui(events, session_id, native_id.as_deref(), ui);
        return;
    }
    if kind == "tool_call" || kind == "tool_call_update" || kind.contains("toolCall") {
        if let Ok(mut state) = ui.lock() {
            if let Some(key) = grok_spawn_update(&mut state.subagents, update, turn_id.as_deref()) {
                state.subagents.emit_card(&GrokSubagentEvents {
                    events, session_id, native_id: native_id.as_deref(),
                }, &key);
                return;
            }
        }
        emit(
            events,
            "grok",
            session_id,
            native_id.as_deref(),
            turn_id.as_deref(),
            "chat.item",
            json!({"merge":true,"part":grok_tool_part(update, if kind == "tool_call" { "running" } else { "complete" })}),
        );
        return;
    }
    if let Some(text) = grok_update_text(update) {
        if let Some(part_type) = grok_part_type(kind) {
            emit(
                events,
                "grok",
                session_id,
                native_id.as_deref(),
                turn_id.as_deref(),
                "chat.delta",
                json!({"part":{"type":part_type,"text":text,"status":"streaming"},"raw":raw}),
            );
        }
    }
}

fn emit_grok_retry(
    events: &ScopedProviderEvents,
    session_id: &str,
    native_id: Option<&str>,
    turn_id: &str,
    retry: Value,
) {
    emit(
        events,
        "grok",
        session_id,
        native_id,
        Some(turn_id),
        "chat.item",
        json!({
            "item":{"id":format!("{turn_id}:network-retry")},
            "part":{"type":"status","data":retry}
        }),
    );
}

fn grok_part_type(kind: &str) -> Option<&'static str> {
    match kind {
        "agent_thought_chunk" | "agentThoughtChunk" => Some("thinking"),
        "agent_message_chunk" | "agentMessageChunk" | "message" => Some("text"),
        _ => None,
    }
}

fn grok_update_text(update: &Value) -> Option<String> {
    if let Some(text) = update
        .get("content")
        .and_then(|content| content.get("text"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        return Some(text.to_owned());
    }
    if let Some(text) = update
        .get("text")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        return Some(text.to_owned());
    }
    let chunks = update.get("content").and_then(Value::as_array)?;
    let text = chunks
        .iter()
        .filter_map(|chunk| chunk.get("text").and_then(Value::as_str))
        .collect::<String>();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn grok_tool_part(update: &Value, fallback_status: &str) -> Value {
    let tool_id = update
        .get("toolCallId")
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let meta = update
        .get("_meta")
        .and_then(|meta| meta.get("x.ai/tool"))
        .unwrap_or(update);
    let name = meta
        .get("label")
        .or_else(|| update.get("title"))
        .or_else(|| meta.get("name"))
        .and_then(Value::as_str)
        .unwrap_or(tool_id);
    let status = match update.get("status").and_then(Value::as_str) {
        Some("completed" | "complete" | "success") => "complete",
        Some("failed" | "error") => "failed",
        Some("pending" | "in_progress" | "running") => "running",
        Some(other) => other,
        None => fallback_status,
    };
    let output = update
        .pointer("/rawOutput/Content/content")
        .or_else(|| update.pointer("/rawOutput/content"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            update
                .get("title")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        });
    let mut part = json!({
        "type":"tool",
        "toolName":name,
        "toolId":tool_id,
        "status":status,
        "data":update
    });
    if let Some(output) = output {
        part["text"] = json!(output);
    }
    crate::file_references::enrich_tool_part(&mut part, None);
    part
}

fn emit_chat_ui(
    events: &ScopedProviderEvents,
    session_id: &str,
    native_id: Option<&str>,
    ui: &Mutex<GrokUiState>,
) {
    let data = ui
        .lock()
        .ok()
        .map(|state| {
            json!({"sessionId":session_id,"options":state.options.clone(),"commands":state.commands.clone()})
        })
        .unwrap_or_else(|| json!({"sessionId":session_id,"options":[],"commands":[]}));
    emit(events, "grok", session_id, native_id, None, "chat.ui", data);
}

fn merge_grok_ui(state: &mut GrokUiState, value: &Value) {
    if let Some(options) = value
        .get("configOptions")
        .or_else(|| value.get("availableConfigOptions"))
        .and_then(Value::as_array)
    {
        let parsed: Vec<Value> = options.iter().filter_map(parse_grok_option).collect();
        if !parsed.is_empty() {
            state.options = parsed;
        }
    }
    if let Some(option) = value.get("configOption").or_else(|| value.get("option")) {
        if let Some(parsed) = parse_grok_option(option) {
            upsert_option(state, parsed);
        }
    }
    if let Some(commands) = value
        .get("availableCommands")
        .or_else(|| value.get("commands"))
        .and_then(Value::as_array)
    {
        let parsed: Vec<Value> = commands.iter().filter_map(parse_grok_command).collect();
        if !parsed.is_empty() {
            state.commands = parsed;
        }
    }
    merge_local_commands(state);
}

fn merge_models_update(state: &mut GrokUiState, value: &Value) {
    let models = value
        .get("models")
        .cloned()
        .unwrap_or_else(|| value.clone());
    let current = models
        .get("currentModelId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let available = models
        .get("availableModels")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if available.is_empty() {
        merge_grok_ui(state, value);
        merge_local_commands(state);
        return;
    }
    let model_choices: Vec<Value> = available
        .iter()
        .filter_map(|model| {
            let id = model
                .get("modelId")
                .or_else(|| model.get("id"))
                .and_then(Value::as_str)?;
            let name = model.get("name").and_then(Value::as_str).unwrap_or(id);
            Some(json!({"value":id,"name":name}))
        })
        .collect();
    if !model_choices.is_empty() {
        upsert_option(
            state,
            json!({"id":"model","name":"Model","value":current,"choices":model_choices}),
        );
    }
    let current_model = available.iter().find(|model| {
        model
            .get("modelId")
            .or_else(|| model.get("id"))
            .and_then(Value::as_str)
            == Some(current)
    });
    if let Some(model) = current_model {
        let meta = model.get("_meta").unwrap_or(model);
        let effort = meta
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let efforts = meta
            .get("reasoningEfforts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|choice| {
                let value = choice
                    .get("value")
                    .or_else(|| choice.get("id"))
                    .and_then(Value::as_str)?;
                let name = choice
                    .get("label")
                    .or_else(|| choice.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or(value);
                Some(json!({"value":value,"name":name}))
            })
            .collect::<Vec<_>>();
        if !efforts.is_empty() {
            upsert_option(
                state,
                json!({"id":"thinking","name":"Thinking","value":effort,"choices":efforts}),
            );
        }
    }
    merge_grok_ui(state, value);
    merge_local_commands(state);
}

fn upsert_option(state: &mut GrokUiState, parsed: Value) {
    let id = parsed
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if let Some(existing) = state
        .options
        .iter_mut()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
    {
        *existing = parsed;
    } else {
        state.options.push(parsed);
    }
}

fn parse_grok_option(value: &Value) -> Option<Value> {
    let raw_id = value
        .get("configId")
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)?;
    let (id, name) = match raw_id {
        "reasoning_effort" | "reasoningEffort" => ("thinking", "Thinking"),
        "permission_mode" | "permissionMode" => ("mode", "Mode"),
        other => (
            other,
            value
                .get("name")
                .or_else(|| value.get("title"))
                .and_then(Value::as_str)
                .unwrap_or(other),
        ),
    };
    let current = value
        .get("currentValue")
        .or_else(|| value.get("value"))
        .and_then(|item| {
            item.as_str()
                .map(ToOwned::to_owned)
                .or_else(|| Some(item.to_string()))
        })
        .unwrap_or_default();
    let choices = value
        .get("options")
        .or_else(|| value.get("choices"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|choice| {
            let option_value = choice
                .get("value")
                .or_else(|| choice.get("optionId"))
                .or_else(|| choice.get("id"))
                .and_then(Value::as_str)?;
            let option_name = choice
                .get("name")
                .or_else(|| choice.get("label"))
                .and_then(Value::as_str)
                .unwrap_or(option_value);
            Some(json!({"value":option_value,"name":option_name}))
        })
        .collect::<Vec<_>>();
    Some(json!({"id":id,"name":name,"value":current,"choices":choices}))
}

fn parse_grok_command(value: &Value) -> Option<Value> {
    let name = value
        .get("name")
        .or_else(|| value.get("command"))
        .and_then(Value::as_str)?;
    if !GROK_SLASH_COMMANDS
        .iter()
        .any(|(known, _)| *known == name.trim_start_matches('/'))
    {
        return None;
    }
    let description = value.get("description").and_then(Value::as_str);
    let mut command = json!({"name":name.trim_start_matches('/')});
    if let Some(description) = description {
        command["description"] = json!(description);
    }
    Some(command)
}

fn grok_permission_mode_option(current: &str) -> Value {
    json!({
        "id":"mode",
        "name":"Mode",
        "value":current,
        "choices": GROK_PERMISSION_MODES.iter().map(|(value, name)| json!({"value":value,"name":name})).collect::<Vec<_>>()
    })
}

fn ensure_permission_mode(state: &mut GrokUiState) {
    if state
        .options
        .iter()
        .any(|option| option.get("id").and_then(Value::as_str) == Some("mode"))
    {
        return;
    }
    state.options.push(grok_permission_mode_option("default"));
}

fn merge_local_commands(state: &mut GrokUiState) {
    ensure_permission_mode(state);
    for (name, description) in GROK_SLASH_COMMANDS {
        if !state
            .commands
            .iter()
            .any(|command| command.get("name").and_then(Value::as_str) == Some(name))
        {
            state
                .commands
                .push(json!({"name":name,"description":description}));
        }
    }
}

fn grok_history_item(row: &Value) -> Option<Value> {
    let id = row
        .get("sessionId")
        .or_else(|| row.get("id"))
        .and_then(Value::as_str)?;
    let updated_at = row
        .get("updatedAt")
        .or_else(|| row.get("updated_at"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let mut item = json!({
        "provider":"grok","nativeId":id,
        "title":row.get("title").or_else(|| row.get("name")).and_then(Value::as_str).unwrap_or("Grok session"),
        "updatedAt":updated_at,
        "resumable":true
    });
    insert_optional(
        &mut item,
        "cwd",
        row.get("cwd")
            .and_then(Value::as_str)
            .map(|value| json!(value)),
    );
    Some(item)
}

fn grok_transcript(raw: &[Value]) -> Vec<Value> {
    let parent = raw.iter().find_map(|message| message.pointer("/result/sessionId").and_then(Value::as_str))
        .or_else(|| raw.iter().find_map(|message| {
            (message.pointer("/params/update/_meta/x.ai~1tool/name").and_then(Value::as_str)
                == Some("spawn_subagent"))
                .then(|| message.pointer("/params/sessionId").and_then(Value::as_str)).flatten()
        }));
    let mut subagents = GrokSubagents::default();
    let entries: Vec<Value> = raw.iter()
        .enumerate()
        .filter_map(|(index, message)| {
            if parent.is_some_and(|parent| message.pointer("/params/sessionId")
                .and_then(Value::as_str).is_some_and(|session| session != parent)) {
                return None;
            }
            let update = message.get("params")?.get("update")?;
            let kind = update
                .get("sessionUpdate")
                .or_else(|| update.get("type"))?
                .as_str()?;
            if kind == "tool_call" || kind == "tool_call_update" || kind.contains("toolCall") {
                if let Some(key) = grok_spawn_update(&mut subagents, update, None) {
                    let mut info = subagents.calls.get(&key)?.info.clone();
                    info["key"] = json!(key);
                    info["provider"] = json!("grok");
                    info["transcript"] = json!("none");
                    return Some(json!({"id":format!("grok-subagent-{key}"),"role":"assistant",
                        "parts":[{"type":"subagent","toolId":key,"status":info["status"],"data":info}],
                        "createdAt":Utc::now().to_rfc3339()}));
                }
                let tool_id = update.get("toolCallId").and_then(Value::as_str)?;
                return Some(json!({
                    "id":format!("grok-tool-{tool_id}"),
                    "role":"tool",
                    "parts":[grok_tool_part(update, if kind == "tool_call" { "running" } else { "complete" })],
                    "createdAt":Utc::now().to_rfc3339()
                }));
            }
            let content = update.get("content").unwrap_or(update);
            let text = content.get("text").and_then(Value::as_str)?;
            let part_type = grok_part_type(kind).unwrap_or("text");
            let role = if kind.contains("user") {
                "user"
            } else if kind.contains("thought")
                || kind.contains("Thought")
                || kind.contains("agent")
                || kind.contains("assistant")
            {
                "assistant"
            } else {
                return None;
            };
            Some(json!({"id":format!("grok-{index}"),"role":role,"parts":[{"type":part_type,"text":text}],"createdAt":Utc::now().to_rfc3339()}))
        })
        .collect();
    let mut transcript = Vec::with_capacity(entries.len());
    for entry in entries {
        if entry.pointer("/parts/0/type").and_then(Value::as_str) == Some("subagent") {
            if let Some(item) = transcript.iter_mut().find(|item: &&mut Value| item["id"] == entry["id"]) {
                item["parts"] = entry["parts"].clone();
            } else {
                transcript.push(entry);
            }
        } else if entry.get("role").and_then(Value::as_str) == Some("tool") {
            crate::file_references::upsert_history_tool(&mut transcript, entry);
        } else {
            transcript.push(entry);
        }
    }
    transcript
}

fn grok_billing_part(value: &Value) -> Option<Value> {
    let config = value.get("config")?.as_object()?;
    let percent = config.get("creditUsagePercent")?.as_f64()?;
    if !percent.is_finite() || percent < 0.0 {
        return None;
    }
    let period = config.get("currentPeriod");
    let label = match period.and_then(|v| v.get("type")).and_then(Value::as_str) {
        Some("USAGE_PERIOD_TYPE_WEEKLY") => "Weekly limit",
        Some("USAGE_PERIOD_TYPE_MONTHLY") => "Monthly limit",
        Some("USAGE_PERIOD_TYPE_DAILY") => "Daily limit",
        _ => "Usage limit",
    };
    let reset_at = period
        .and_then(|v| v.get("end"))
        .and_then(Value::as_str)
        .or_else(|| config.get("billingPeriodEnd").and_then(Value::as_str))
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok());
    let reset = reset_at
        .map(|time| {
            format!(
                "Resets: {}",
                time.with_timezone(&chrono::Local).format("%B %d, %H:%M")
            )
        })
        .unwrap_or_else(|| "Reset time unavailable".to_owned());
    let percent = percent.clamp(0.0, 100.0).round() as u64;
    Some(json!({
        "type":"text","status":"complete",
        "text":format!("{label}: {percent}% used\n{reset}"),
        "data":{"kind":"plan","rows":[{"label":label,"percent":percent,"reset":reset,
            "resetAt":reset_at.map(|time| time.to_rfc3339())}]}
    }))
}

fn grok_usage_parts(
    session: &Result<Value, ProviderError>,
    billing: &Result<Value, ProviderError>,
) -> Vec<Value> {
    let plan = billing
        .as_ref()
        .ok()
        .and_then(|value| value.get("subscription_tier"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let mut parts = vec![
        json!({"type":"text","status":"complete","text":plan.map(|plan|format!("Grok usage — {plan}")).unwrap_or_else(||"Grok usage".to_owned())}),
    ];
    if let Some(part) = billing.as_ref().ok().and_then(grok_billing_part) {
        parts.push(part);
    } else {
        // Account limits are independent of session token totals; an error
        // or absent billing config must never appear as 0% used.
        parts.push(json!({"type":"text","status":"complete","text":"Account usage limits are currently unavailable from Grok. Session statistics are shown separately below."}));
    }
    let text = session
        .as_ref()
        .ok()
        .and_then(grok_usage_text)
        .unwrap_or_else(|| {
            "Grok session usage is unavailable. No token counts or costs have been inferred."
                .to_owned()
        });
    parts.push(json!({"type":"text","status":"complete","text":text}));
    parts
}

fn grok_usage_text(value: &Value) -> Option<String> {
    let usage = value.get("usage")?.as_object()?;
    let heading = "Grok session usage (since start or last resume)";
    if usage.get("modelCalls").and_then(Value::as_u64) == Some(0)
        && ["inputTokens", "outputTokens", "totalTokens"]
            .iter()
            .all(|key| {
                usage
                    .get(*key)
                    .and_then(Value::as_u64)
                    .is_none_or(|value| value == 0)
            })
    {
        return Some(format!("{heading}\n\nNo model calls yet in this session."));
    }
    let mut lines = Vec::new();
    for (key, label) in [
        ("inputTokens", "Input tokens"),
        ("outputTokens", "Output tokens"),
        ("totalTokens", "Total tokens"),
        ("cachedReadTokens", "Cache read tokens"),
        ("cacheCreationTokens", "Cache creation tokens"),
        ("reasoningTokens", "Reasoning tokens"),
        ("modelCalls", "Model calls"),
        ("numTurns", "Turns"),
    ] {
        if let Some(number) = usage.get(key).and_then(Value::as_u64) {
            lines.push(format!("- {label}: {number}"));
        }
    }
    if let Some(duration) = usage.get("apiDurationMs").and_then(Value::as_u64) {
        lines.push(format!("- API time: {:.2} s", duration as f64 / 1000.0));
    }
    if let Some(ticks) = usage.get("costUsdTicks").and_then(Value::as_u64) {
        // Native Grok user guide, 17-sessions: 10^10 ticks per USD.
        lines.push(format!(
            "- Cost (USD): ${:.6}",
            ticks as f64 / 10_000_000_000.0
        ));
    }
    if lines.is_empty() {
        return None;
    }
    if !["inputTokens", "outputTokens", "totalTokens"]
        .iter()
        .any(|key| usage.get(*key).and_then(Value::as_u64).is_some())
    {
        lines.push("- Token counts: not reported by Grok yet".to_owned());
    }
    Some(format!("{heading}\n\n{}", lines.join("\n")))
}

fn grok_info_text(value: &Value) -> Option<String> {
    let info = value.get("result")?.as_object()?;
    let mut lines = Vec::new();
    if let Some(model) = info
        .get("modelDisplayName")
        .or_else(|| info.get("model"))
        .and_then(Value::as_str)
    {
        lines.push(format!("- Model: {model}"));
    }
    if let Some(backend) = info.get("apiBackend").and_then(Value::as_str) {
        lines.push(format!("- Backend: {backend}"));
    }
    if let Some(turns) = info.get("turns").and_then(Value::as_u64) {
        lines.push(format!("- Turns: {turns}"));
    }
    if let Some(context) = info.get("context").and_then(Value::as_object) {
        for (key, label) in [
            ("used", "Context tokens used"),
            ("total", "Context token limit"),
            ("compactionCount", "Compactions"),
            ("messageCount", "Messages"),
            ("toolCallCount", "Tool calls"),
        ] {
            if let Some(number) = context.get(key).and_then(Value::as_u64) {
                lines.push(format!("- {label}: {number}"));
            }
        }
    }
    if lines.is_empty() {
        None
    } else {
        Some(format!("Grok session status\n\n{}", lines.join("\n")))
    }
}

fn parse_slash(text: &str) -> Option<(&str, &str)> {
    let rest = text.trim().strip_prefix('/')?;
    if rest.is_empty() {
        return Some(("help", ""));
    }
    if rest.starts_with('/') {
        return None;
    }
    match rest.split_once(char::is_whitespace) {
        Some((name, args)) => Some((name, args.trim())),
        None => Some((rest, "")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grok_history_merges_native_tool_updates_and_failed_paths() {
        let history = grok_transcript(&[
            json!({"params":{"update":{"sessionUpdate":"tool_call","toolCallId":"tc-1","title":"Read","rawInput":{"path":"src/one.rs"}}}}),
            json!({"params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"tc-1","status":"failed","rawOutput":{"filePath":"src/two.rs"}}}}),
        ]);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["parts"][0]["status"], "failed");
        assert_eq!(
            history[0]["parts"][0]["fileReferences"],
            json!([
                {"path":"src/one.rs"},{"path":"src/two.rs"}
            ])
        );
    }

    #[test]
    fn preassigned_identity_does_not_parse_exit_output() {
        let adapter = GrokAdapter::new(
            crate::provider_events::tap_channel(1).0,
            crate::providers::network::NetworkSettings::default(),
        );
        assert_eq!(
            adapter.terminal_capture(),
            super::super::TerminalCapture::PreAssigned
        );
    }

    #[test]
    fn native_usage_preserves_units_and_absent_metrics() {
        let text = grok_usage_text(&json!({"usage":{
            "inputTokens":123,"outputTokens":45,"totalTokens":168,
            "cachedReadTokens":20,"reasoningTokens":8,
            "modelCalls":2,"apiDurationMs":1250,"costUsdTicks":1234560000
        }}))
        .unwrap();
        assert!(text.contains("Input tokens: 123"));
        assert!(text.contains("Total tokens: 168"));
        assert!(text.contains("Cache read tokens: 20"));
        assert!(text.contains("API time: 1.25 s"));
        assert!(text.contains("Cost (USD): $0.123456"));
        assert!(!text.contains("Cache creation tokens:"));
        let empty = grok_usage_text(&json!({"usage":{"modelCalls":2,"numTurns":1}})).unwrap();
        assert!(empty.contains("Token counts: not reported"));
        assert!(!empty.contains("Input tokens:"));
        assert!(!empty.contains("Cost (USD):"));
        assert!(grok_usage_text(&json!({"usage":{}})).is_none());
        assert!(grok_usage_text(&json!({"usage":{"totalTokens":"unknown"}})).is_none());
        assert!(grok_usage_text(&json!({})).is_none());
    }

    fn billing_fixture() -> Value {
        json!({"subscription_tier":"SuperGrok","config":{
            "creditUsagePercent":60,
            "currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","end":"2026-09-22T10:08:47.894426+00:00"}
        }})
    }

    #[test]
    fn billing_card_uses_native_plan_percent_and_reset_time() {
        let billing = billing_fixture();
        let card = grok_billing_part(&billing).unwrap();
        assert_eq!(card["data"]["kind"], "plan");
        assert_eq!(card["data"]["rows"][0]["label"], "Weekly limit");
        assert_eq!(card["data"]["rows"][0]["percent"], 60);
        assert_eq!(
            card["data"]["rows"][0]["resetAt"],
            "2026-09-22T10:08:47.894426+00:00"
        );
        assert!(card["text"].as_str().unwrap().contains("September"));
        assert!(grok_billing_part(&json!({"config":{}})).is_none());
        assert!(grok_billing_part(&json!({"config":null})).is_none());
        assert!(grok_billing_part(&json!({"config":{"creditUsagePercent":-1}})).is_none());
        let invalid_reset = grok_billing_part(
            &json!({"config":{"creditUsagePercent":0,"currentPeriod":{"end":"invalid"}}}),
        )
        .unwrap();
        assert_eq!(
            invalid_reset["data"]["rows"][0]["reset"],
            "Reset time unavailable"
        );
    }

    #[test]
    fn resumed_usage_matches_cli_no_calls_state_and_keeps_account_limits() {
        let session = Ok(
            json!({"usage":{"inputTokens":0,"outputTokens":0,"totalTokens":0,"modelCalls":0,"numTurns":0}}),
        );
        let parts = grok_usage_parts(&session, &Ok(billing_fixture()));
        assert!(parts[0]["text"].as_str().unwrap().contains("SuperGrok"));
        assert_eq!(parts[1]["data"]["rows"][0]["percent"], 60);
        let text = parts[2]["text"].as_str().unwrap();
        assert!(text.contains("since start or last resume"));
        assert!(text.contains("No model calls yet"));
        assert!(!text.contains("Input tokens: 0"));
        assert!(!text.contains("Cost (USD):"));
    }

    fn usage_reply_fixture() -> (GrokUsageReply, broadcast::Receiver<ProviderEvent>) {
        let (events, receiver) = crate::provider_events::tap_channel(16);
        let events = ScopedProviderEvents::new(events, "test-worker");
        (
            GrokUsageReply {
                events,
                session_id: "s".into(),
                native_id: "n".into(),
                turn_id: "usage".into(),
                active_turn: Arc::new(Mutex::new(Some("usage".into()))),
                started: Instant::now(),
                results: Mutex::new(GrokUsageResults::default()),
                done: Mutex::new(false),
                wake: Condvar::new(),
            },
            receiver,
        )
    }

    #[test]
    fn usage_notifications_keep_the_originating_worker_token() {
        let (reply, mut receiver) = usage_reply_fixture();
        reply.record(false, Ok(json!({"usage":{}})));
        reply.record(true, Ok(billing_fixture()));
        for expected_kind in ["chat.item", "chat.turn.completed"] {
            let event = receiver.try_recv().unwrap();
            assert_eq!(event.kind, expected_kind);
            assert_eq!(event.worker_token.as_deref(), Some("test-worker"));
        }
        let (reply, mut receiver) = usage_reply_fixture();
        assert!(reply.cancel());
        assert_eq!(
            receiver.try_recv().unwrap().worker_token.as_deref(),
            Some("test-worker")
        );
    }

    const GROK_PROBE_PARENT: &str = "01a116d7-5d4a-7051-a77a-012ab1f9e5bd";
    const GROK_PROBE_CHILD: &str = "01a116d7-a2bc-7cd2-9b24-6460dc1f32df";
    const GROK_PROBE_SPAWN: &str = "call-3656ca5d-0fff-4f26-918c-7d2207728185-0";

    fn grok_probe_frames() -> Vec<Value> {
        include_str!("../../tests/fixtures/grok-subagent-frames.jsonl")
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|row| row["direction"] == "in")
            .map(|row| row["frame"].clone())
            .collect()
    }

    struct GrokSubagentReplay {
        events: ScopedProviderEvents,
        received: broadcast::Receiver<ProviderEvent>,
        native: Mutex<Option<String>>,
        active: Mutex<Option<String>>,
        permissions: Mutex<HashMap<String, PermissionRequest>>,
        ui: Mutex<GrokUiState>,
    }

    impl GrokSubagentReplay {
        fn new() -> Self {
            let (sender, received) = crate::provider_events::tap_channel(512);
            Self {
                events: ScopedProviderEvents::new(sender, "subagent-worker"),
                received,
                native: Mutex::new(Some(GROK_PROBE_PARENT.into())),
                active: Mutex::new(Some("parent-turn".into())),
                permissions: Mutex::new(HashMap::new()),
                ui: Mutex::new(GrokUiState::default()),
            }
        }

        fn raw(&self, raw: Value) {
            emit_grok_message(
                &self.events,
                "grok-chat",
                &self.native,
                &self.active,
                &self.permissions,
                &self.ui,
                &Mutex::new(None),
                raw,
            );
        }

        fn update(&self, session: &str, update: Value) {
            self.raw(
                json!({"method":"session/update","params":{"sessionId":session,"update":update}}),
            );
        }

        fn notification(&self, update: Value) {
            self.raw(json!({"method":"_x.ai/session_notification","params":{
                "sessionId":GROK_PROBE_PARENT,"update":update}}));
        }

        fn spawn(&self, key: &str, description: &str) {
            self.update(GROK_PROBE_PARENT, json!({"sessionUpdate":"tool_call","toolCallId":key,
                "_meta":{"x.ai/tool":{"name":"spawn_subagent"}},
                "rawInput":{"description":description,"prompt":"Inspect files","subagent_type":"explore"}}));
        }

        fn bind(&self, child: &str, description: &str) {
            self.notification(json!({"sessionUpdate":"subagent_spawned","subagent_id":child,
                "child_session_id":child,"description":description,"subagent_type":"explore","model":"grok-4.6"}));
        }

        fn drain(&mut self) -> Vec<ProviderEvent> {
            std::iter::from_fn(|| self.received.try_recv().ok()).collect()
        }
    }

    #[test]
    fn grok_child_permission_uses_normal_request_path_with_subagent_label() {
        let mut replay = GrokSubagentReplay::new();
        replay.spawn("spawn", "Count files");
        replay.bind("child", "Count files");
        replay.drain();
        replay.raw(json!({"id":42,"method":"session/request_permission","params":{
            "sessionId":"child","toolCall":{"title":"Read files"},
            "options":[{"optionId":"allow","kind":"allow_once","name":"Allow"}]}}));
        let events = replay.drain();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "chat.approval");
        assert_eq!(events[0].native_id.as_deref(), Some(GROK_PROBE_PARENT));
        assert_eq!(events[0].turn_id.as_deref(), Some("parent-turn"));
        assert_eq!(events[0].data["part"]["data"]["subagent"],
            json!({"key":"spawn","label":"Count files"}));
        let permissions = replay.permissions.lock().unwrap();
        let pending = permissions.values().next().unwrap();
        assert_eq!(pending.rpc_id, json!(42));
        assert_eq!(pending.choices[0].choice_id, "allow");
        drop(permissions);
        assert!(replay.ui.lock().unwrap().subagents.pending_frames.is_empty());
        replay.update("child", json!({"sessionUpdate":"user_message_chunk","content":{"text":"child prompt"}}));
        let notifications = replay.drain();
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].kind, "chat.subagent.item");
        assert_eq!(notifications[0].data["key"], "spawn");
        replay.raw(json!({"id":43,"method":"_x.ai/ask_user_question","params":{"sessionId":"child"}}));
        assert!(replay.ui.lock().unwrap().subagents.pending_frames.is_empty());
        assert!(replay.drain().is_empty());
        assert_eq!(replay.active.lock().unwrap().as_deref(), Some("parent-turn"));
        assert_eq!(replay.native.lock().unwrap().as_deref(), Some(GROK_PROBE_PARENT));
    }

    #[cfg(windows)]
    #[test]
    fn grok_child_permission_approve_writes_selected_rpc_response() {
        let output_dir = tempfile::tempdir().unwrap();
        let output = output_dir.path().join("responses.jsonl");
        let output_path = output.to_string_lossy().replace('\'', "''");
        let script = format!(
            "$ErrorActionPreference='Stop'; Get-ChildItem Env: | Where-Object {{ $_.Name -ieq 'PATH' }} | Remove-Item; if (Get-ChildItem Env: | Where-Object {{ $_.Name -ieq 'PATH' }}) {{ exit 3 }}; $start=[Console]::In.ReadLine(); if ($null -eq $start) {{ exit 2 }}; [Console]::Out.WriteLine('{{\"jsonrpc\":\"2.0\",\"id\":42,\"method\":\"session/request_permission\",\"params\":{{\"sessionId\":\"child\",\"turnId\":\"child-turn\",\"toolCall\":{{\"title\":\"Read files\"}},\"options\":[{{\"optionId\":\"allow\",\"kind\":\"allow_once\",\"name\":\"Allow\"}}]}}}}'); [Console]::Out.Flush(); $permission=[Console]::In.ReadLine(); [Console]::Out.WriteLine('{{\"jsonrpc\":\"2.0\",\"id\":43,\"method\":\"_x.ai/ask_user_question\",\"params\":{{\"sessionId\":\"child\"}}}}'); [Console]::Out.Flush(); $question=[Console]::In.ReadLine(); [System.IO.File]::WriteAllText('{}', ($permission + \"`n\" + $question))",
            output_path
        );
        let spec = CommandSpec::from_path(
            std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
            vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), script],
        )
        .unwrap();
        let (sender, mut received) = crate::provider_events::tap_channel(16);
        let events = ScopedProviderEvents::new(sender, "grok-approval-test");
        let native = Arc::new(Mutex::new(Some(GROK_PROBE_PARENT.into())));
        let active_turn = Arc::new(Mutex::new(Some("parent-turn".into())));
        let permissions = Arc::new(Mutex::new(HashMap::new()));
        let ui = Arc::new(Mutex::new(GrokUiState::default()));
        let responder = Arc::new(Mutex::new(None));
        emit_grok_message(
            &events,
            "grok-chat",
            &native,
            &active_turn,
            &permissions,
            &ui,
            &responder,
            json!({"method":"session/update","params":{"sessionId":GROK_PROBE_PARENT,"update":{"sessionUpdate":"tool_call","toolCallId":"spawn","_meta":{"x.ai/tool":{"name":"spawn_subagent"}},"rawInput":{"description":"Count files","prompt":"Inspect files","subagent_type":"explore"}}}}),
        );
        emit_grok_message(
            &events,
            "grok-chat",
            &native,
            &active_turn,
            &permissions,
            &ui,
            &responder,
            json!({"method":"_x.ai/session_notification","params":{"sessionId":GROK_PROBE_PARENT,"update":{"sessionUpdate":"subagent_spawned","subagent_id":"child","child_session_id":"child","description":"Count files"}}}),
        );
        while received.try_recv().is_ok() {}
        let callback_events = events.clone();
        let callback_native = Arc::clone(&native);
        let callback_turn = Arc::clone(&active_turn);
        let callback_permissions = Arc::clone(&permissions);
        let callback_ui = Arc::clone(&ui);
        let callback_responder = Arc::clone(&responder);
        let process = JsonLineProcess::spawn(
            "fake-grok-child-permission",
            &spec,
            None,
            &[],
            EnvelopeStyle::JsonRpc2,
            Arc::new(move |raw| {
                emit_grok_message(
                    &callback_events,
                    "grok-chat",
                    &callback_native,
                    &callback_turn,
                    &callback_permissions,
                    &callback_ui,
                    &callback_responder,
                    raw,
                );
            }),
        )
        .unwrap();
        *responder.lock().unwrap() = Some(process.responder());
        let mut chat = GrokChat {
            process,
            session_id: "grok-chat".into(),
            native_id: GROK_PROBE_PARENT.into(),
            events,
            active_turn,
            permissions,
            ui,
            turn_started: Arc::new(Mutex::new(None)),
            usage_reply: None,
        };
        chat.process.notification("qa/start", json!({})).unwrap();
        let approval = (0..250)
            .find_map(|_| match received.try_recv() {
                Ok(event) if event.kind == "chat.approval" => Some(event),
                Ok(_) | Err(broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(20));
                    None
                }
                Err(error) => panic!("fake provider event stream failed: {error}"),
            })
            .expect("child permission reached normal request handling");
        assert_eq!(approval.kind, "chat.approval");
        assert_eq!(approval.native_id.as_deref(), Some(GROK_PROBE_PARENT));
        assert_eq!(approval.turn_id.as_deref(), Some("parent-turn"));
        assert_eq!(
            approval.data["part"]["data"]["subagent"],
            json!({"key":"spawn","label":"Count files"})
        );
        let approval_id = encode_approval_id(&json!(42));
        chat.approve("parent-turn", &approval_id, "allow", "approve-child")
            .unwrap();
        let mut responses = None;
        for _ in 0..50 {
            let text = std::fs::read_to_string(&output).unwrap_or_default();
            if !text.is_empty() {
                responses = Some(
                    text.lines()
                        .map(|line| serde_json::from_str::<Value>(line).unwrap())
                        .collect::<Vec<_>>(),
                );
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            responses.as_ref().unwrap()[0],
            json!({"jsonrpc":"2.0","id":42,"result":{"outcome":{"outcome":"selected","optionId":"allow"}}})
        );
        assert_eq!(
            responses.unwrap()[1],
            json!({"jsonrpc":"2.0","id":43,"error":{"code":-32601,"message":"Method not found"}})
        );
    }

    #[test]
    fn grok_subagent_probe_replay_keeps_parent_turn_and_projects_child_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(&dir.path().join("runtime.sqlite")).unwrap();
        db.transaction(|tx| {
            tx.execute("INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at) VALUES ('grok-chat','test','grok','chat','running','now','now')", [])?;
            Ok(())
        }).unwrap();
        let mut replay = GrokSubagentReplay::new();
        let mut observed = Vec::new();
        for raw in grok_probe_frames() {
            let child =
                raw.pointer("/params/sessionId").and_then(Value::as_str) == Some(GROK_PROBE_CHILD);
            replay.raw(raw);
            assert_eq!(
                replay.active.lock().unwrap().as_deref(),
                Some("parent-turn")
            );
            assert_eq!(
                replay.native.lock().unwrap().as_deref(),
                Some(GROK_PROBE_PARENT)
            );
            let events = replay.drain();
            if child {
                assert!(events
                    .iter()
                    .all(|event| event.kind == "chat.subagent.item"));
            }
            for event in events {
                assert_eq!(event.native_id.as_deref(), Some(GROK_PROBE_PARENT));
                assert_eq!(event.worker_token.as_deref(), Some("subagent-worker"));
                assert_eq!(
                    event.turn_id.as_deref(),
                    if event.kind == "chat.ui" {
                        None
                    } else {
                        Some("parent-turn")
                    }
                );
                if event.kind == "chat.subagent.item" {
                    let tool = event.data["item"]["role"] == "tool";
                    assert_eq!(
                        event.data.get("merge").and_then(Value::as_bool),
                        tool.then_some(true)
                    );
                }
                db.record_provider_event(
                    "grok-chat",
                    event.turn_id.as_deref(),
                    &event.kind,
                    &event.data,
                )
                .unwrap();
                observed.push(event);
            }
        }
        let cards: Vec<_> = observed
            .iter()
            .filter(|event| event.kind == "chat.subagent")
            .collect();
        assert_eq!(cards.first().unwrap().data["info"]["status"], "running");
        assert_eq!(cards.first().unwrap().data["info"]["background"], false);
        assert!(cards
            .iter()
            .all(|event| event.data["key"] == GROK_PROBE_SPAWN));
        let info = &cards.last().unwrap().data["info"];
        assert_eq!(info["status"], "completed");
        assert_eq!(info["description"], "Count files");
        assert_eq!(info["agentType"], "general-purpose");
        assert_eq!(
            info["native"],
            json!({"kind":"grok-subagent","id":GROK_PROBE_CHILD})
        );
        assert!(info["summary"].as_str().unwrap().contains("**3 items**"));
        assert_eq!(
            info["usage"],
            json!({"totalTokens":10548,"toolUses":2,"durationMs":20161})
        );
        let (items, _, truncated) = db
            .subagent_items_after("grok-chat", GROK_PROBE_SPAWN, 0)
            .unwrap();
        assert!(!truncated);
        assert_eq!(items.iter().filter(|item| item.role == "user").count(), 1);
        assert!((1..=2).contains(
            &items
                .iter()
                .filter(|item| item.role == "assistant"
                    && item.parts.iter().any(|part| part["type"] == "text"))
                .count()
        ));
        let tools: Vec<_> = items
            .iter()
            .flat_map(|item| item.parts.iter())
            .filter(|part| part["type"] == "tool")
            .collect();
        assert_eq!(tools.len(), 2);
        assert!(tools.iter().all(|part| part["status"] == "complete"));
        for name in ["list_dir", "run_terminal_command"] {
            assert!(tools
                .iter()
                .any(|part| part.pointer("/data/_meta/x.ai~1tool/name") == Some(&json!(name))));
        }
        assert_eq!(
            tools
                .iter()
                .find(|part| part.pointer("/data/rawOutput/type") == Some(&json!("Bash")))
                .unwrap()
                .pointer("/data/rawOutput/output"),
            Some(&json!([]))
        );
        let parent = db.chat_items("grok-chat").unwrap();
        assert_eq!(
            parent
                .iter()
                .flat_map(|item| &item.parts)
                .filter(|part| part["type"] == "subagent")
                .count(),
            1
        );
        assert!(parent
            .iter()
            .flat_map(|item| &item.parts)
            .all(|part| part["type"] != "tool"));
        assert_eq!(
            parent
                .iter()
                .flat_map(|item| &item.parts)
                .filter_map(|part| part["text"].as_str())
                .collect::<String>(),
            "3"
        );
        assert!(!observed
            .iter()
            .any(|event| event.kind.starts_with("chat.turn.")));
    }

    #[test]
    fn grok_subagent_buffers_probe_child_frames_until_binding() {
        let frames = grok_probe_frames();
        let mut replay = GrokSubagentReplay::new();
        replay.spawn(GROK_PROBE_SPAWN, "Count files");
        replay.drain();
        for frame in frames
            .iter()
            .filter(|frame| frame.pointer("/params/sessionId") == Some(&json!(GROK_PROBE_CHILD)))
        {
            replay.raw(frame.clone());
        }
        assert!(replay.drain().is_empty());
        replay.bind(GROK_PROBE_CHILD, "Count files");
        let events = replay.drain();
        assert_eq!(events[0].kind, "chat.subagent");
        assert!(events.iter().skip(1).all(
            |event| event.kind == "chat.subagent.item" && event.data["key"] == GROK_PROBE_SPAWN
        ));
        assert_eq!(
            events
                .iter()
                .filter(|event| event.data["item"]["role"] == "user")
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.data["item"]["role"] == "tool"
                    && event.data["item"]["parts"][0]["status"] == "complete")
                .count(),
            2
        );
        assert!(replay
            .ui
            .lock()
            .unwrap()
            .subagents
            .pending_frames
            .is_empty());
    }

    #[test]
    fn grok_foreign_frames_never_reach_parent_and_buffer_drops_oldest() {
        let mut replay = GrokSubagentReplay::new();
        for index in 0..205 {
            replay.update(
                "unknown",
                json!({"sessionUpdate":"user_message_chunk","content":{"text":index.to_string()}}),
            );
        }
        for method in [
            "_x.ai/session_notification",
            "_x.ai/queue/changed",
            "_x.ai/mcp_initialized",
            "_x.ai/models/update",
            "session/request_permission",
        ] {
            replay.raw(
                json!({"method":method,"params":{"sessionId":"foreign",
                "turnId":"child-turn","update":{"sessionUpdate":"turn_completed"},"options":[]}}),
            );
        }
        assert!(replay.drain().is_empty());
        assert_eq!(
            replay.active.lock().unwrap().as_deref(),
            Some("parent-turn")
        );
        assert_eq!(
            replay.native.lock().unwrap().as_deref(),
            Some(GROK_PROBE_PARENT)
        );
        assert!(replay.permissions.lock().unwrap().is_empty());
        assert!(replay.ui.lock().unwrap().options.is_empty());
        let ui = replay.ui.lock().unwrap();
        let buffered = &ui.subagents.pending_frames["unknown"];
        assert_eq!(buffered.len(), 200);
        assert_eq!(
            buffered.front().unwrap()["params"]["update"]["content"]["text"],
            "5"
        );
        drop(ui);
        replay.bind("unknown", "No matching spawn");
        let events = replay.drain();
        assert_eq!(events.len(), 201);
        assert_eq!(events[0].data["key"], "unknown");
        assert_eq!(events[1].data["item"]["parts"][0]["text"], "5");
    }

    #[test]
    fn grok_subagent_binding_matches_description_then_spawn_order() {
        let replay = GrokSubagentReplay::new();
        for (key, description) in [("a", "Same"), ("b", "Other"), ("c", "Same")] {
            replay.spawn(key, description);
        }
        for (child, description) in [
            ("child-b", "Other"),
            ("child-a", "Same"),
            ("child-c", "Unmatched"),
            ("orphan", "New"),
        ] {
            replay.bind(child, description);
        }
        replay.bind("child-b", "Other");
        let ui = replay.ui.lock().unwrap();
        for (child, key) in [
            ("child-b", "b"),
            ("child-a", "a"),
            ("child-c", "c"),
            ("orphan", "orphan"),
        ] {
            assert_eq!(ui.subagents.children[child].key, key);
        }
        assert!(ui.subagents.pending_spawns.is_empty());
    }

    #[test]
    fn grok_subagent_chunks_flush_as_full_items_at_each_boundary() {
        for boundary in [
            "tool_call",
            "response_completed",
            "turn_completed",
            "subagent_finished",
        ] {
            let mut replay = GrokSubagentReplay::new();
            replay.spawn("spawn", "Inspect");
            replay.bind("child", "Inspect");
            replay.drain();
            for (kind, text) in [
                ("agent_thought_chunk", "Think"),
                ("agent_message_chunk", "Hello "),
                ("agent_message_chunk", "world"),
            ] {
                replay.update(
                    "child",
                    json!({"sessionUpdate":kind,"content":{"text":text}}),
                );
            }
            assert!(replay.drain().is_empty());
            if boundary == "tool_call" {
                replay.update(
                    "child",
                    json!({"sessionUpdate":boundary,"toolCallId":"tool"}),
                );
            } else if boundary == "subagent_finished" {
                replay.notification(json!({"sessionUpdate":boundary,"child_session_id":"child","status":"completed"}));
            } else {
                replay.raw(json!({"method":"_x.ai/session_notification","params":{"sessionId":"child","update":{"sessionUpdate":boundary}}}));
            }
            let events = replay.drain();
            assert_eq!(events[0].kind, "chat.subagent.item");
            assert!(events[0].data.get("merge").is_none());
            assert_eq!(events[0].data["item"]["id"], "child:m0");
            assert_eq!(
                events[0].data["item"]["parts"],
                json!([
                {"type":"thinking","text":"Think"},{"type":"text","text":"Hello world"}])
            );
        }
    }

    #[test]
    fn grok_subagent_tool_status_filter_strips_bytes_and_preserves_input() {
        let mut replay = GrokSubagentReplay::new();
        replay.spawn("spawn", "Inspect");
        replay.bind("child", "Inspect");
        replay.drain();
        replay.update("child", json!({"sessionUpdate":"tool_call","toolCallId":"tool",
            "_meta":{"x.ai/tool":{"name":"run_terminal_command","label":"Run Command"}},"rawInput":{"command":"echo test"}}));
        for status in ["in_progress", "in_progress", "in_progress", "failed", "failed"] {
            replay.update(
                "child",
                json!({"sessionUpdate":"tool_call_update","toolCallId":"tool","status":status,
                "rawOutput":{"type":"Bash","output":[1,2,3],"output_for_prompt":"test"}}),
            );
        }
        let events = replay.drain();
        assert_eq!(events.len(), 3);
        assert!(events.iter().all(|event| event.data["merge"] == true));
        let tool = &events.last().unwrap().data["item"]["parts"][0];
        assert_eq!(tool["status"], "failed");
        assert_eq!(tool["toolName"], "Run Command");
        assert_eq!(tool["data"]["rawInput"]["command"], "echo test");
        assert_eq!(tool["data"]["rawOutput"]["output"], json!([]));
        assert_eq!(tool["data"]["rawOutput"]["output_for_prompt"], "test");
        replay.update("child", json!({"sessionUpdate":"tool_call_update","toolCallId":"tool","status":"failed",
            "rawOutput":{"type":"Bash","output":[4,5,6],"output_for_prompt":"final error"}}));
        let enriched = replay.drain();
        assert_eq!(enriched.len(), 1);
        assert_eq!(enriched[0].data["item"]["parts"][0]["data"]["rawOutput"]["output_for_prompt"], "final error");
    }

    #[test]
    fn grok_background_spawn_waits_for_finished_and_keeps_original_turn() {
        let mut replay = GrokSubagentReplay::new();
        replay.spawn("spawn", "Inspect");
        replay.update(GROK_PROBE_PARENT, json!({"sessionUpdate":"tool_call_update","toolCallId":"spawn",
            "rawInput":{"run_in_background":true},"status":"completed","rawOutput":{"subagent_id":"child"}}));
        replay.bind("child", "Inspect");
        assert!(replay.drain().iter().all(
            |event| event.kind == "chat.subagent" && event.data["info"]["status"] == "running"
        ));
        *replay.active.lock().unwrap() = Some("new-turn".into());
        replay.notification(
            json!({"sessionUpdate":"subagent_progress","subagent_id":"child",
            "tokens_used":12,"tool_call_count":2,"duration_ms":34}),
        );
        replay.notification(
            json!({"sessionUpdate":"subagent_finished","subagent_id":"child",
            "status":"completed","output":"Done","tool_calls":2,"duration_ms":45}),
        );
        let events = replay.drain();
        assert!(events
            .iter()
            .all(|event| event.turn_id.as_deref() == Some("parent-turn")));
        assert_eq!(events.last().unwrap().data["info"]["status"], "completed");
        assert_eq!(events.last().unwrap().data["info"]["background"], true);
        assert_eq!(
            events.last().unwrap().data["info"]["usage"],
            json!({"totalTokens":12,"toolUses":2,"durationMs":45})
        );
        assert_eq!(replay.active.lock().unwrap().as_deref(), Some("new-turn"));
    }

    #[test]
    fn grok_subagent_finished_maps_terminal_and_unknown_statuses() {
        for (status, expected) in [
            ("completed", "completed"),
            ("failed", "failed"),
            ("cancelled", "cancelled"),
            ("other", "unknown"),
        ] {
            let mut replay = GrokSubagentReplay::new();
            replay.bind("child", "Inspect");
            replay.drain();
            replay.notification(json!({"sessionUpdate":"subagent_finished","subagent_id":"child","status":status,"output":"Result"}));
            let events = replay.drain();
            assert_eq!(events[0].data["info"]["status"], expected);
            assert_eq!(events[0].data["info"]["summary"], "Result");
        }
        let mut replay = GrokSubagentReplay::new();
        replay.spawn("failed", "Inspect");
        replay.update(
            GROK_PROBE_PARENT,
            json!({"sessionUpdate":"tool_call_update","toolCallId":"failed","status":"failed"}),
        );
        assert_eq!(
            replay.drain().last().unwrap().data["info"]["status"],
            "failed"
        );
    }

    #[test]
    fn grok_subagent_history_replaces_spawn_tool_with_static_card() {
        let transcript = grok_transcript(&grok_probe_frames());
        let cards: Vec<_> = transcript
            .iter()
            .filter(|item| item["parts"][0]["type"] == "subagent")
            .collect();
        assert_eq!(cards.len(), 1);
        let info = &cards[0]["parts"][0]["data"];
        assert_eq!(info["key"], GROK_PROBE_SPAWN);
        assert_eq!(info["provider"], "grok");
        assert_eq!(info["status"], "completed");
        assert_eq!(info["transcript"], "none");
        assert!(info["summary"].as_str().unwrap().contains("**3 items**"));
        assert!(transcript.iter().all(|item| item["role"] != "tool"));
        assert_eq!(
            transcript
                .iter()
                .flat_map(|item| item["parts"].as_array().unwrap())
                .filter_map(|part| part["text"].as_str())
                .collect::<String>(),
            "3"
        );
    }

    #[test]
    fn grok_native_notification_paths_keep_the_worker_token() {
        let (sender, mut receiver) = crate::provider_events::tap_channel(32);
        let events = ScopedProviderEvents::new(sender, "old-worker");
        let native = Mutex::new(Some("native".to_owned()));
        let active = Mutex::new(Some("turn".to_owned()));
        let permissions = Mutex::new(HashMap::new());
        let ui = Mutex::new(GrokUiState::default());
        for raw in [
            json!({"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"answer"}}}}),
            json!({"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"agent_thought_chunk","content":{"text":"reasoning"}}}}),
            json!({"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"config_option_update","configOptions":[]}}}),
            json!({"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"retry_state","attempt":1}}}),
            json!({"id":1,"method":"session/request_permission","params":{"sessionId":"native","options":[{"optionId":"deny","kind":"reject_once","name":"Deny"}]}}),
            json!({"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"tool_call","toolCallId":"tool"}}}),
        ] {
            emit_grok_message(
                &events,
                "session",
                &native,
                &active,
                &permissions,
                &ui,
                &Mutex::new(None),
                raw,
            );
            let mut count = 0;
            while let Ok(event) = receiver.try_recv() {
                count += 1;
                assert_eq!(event.worker_token.as_deref(), Some("old-worker"));
                assert_eq!(event.native_id.as_deref(), Some("native"));
            }
            assert!(count > 0);
        }
    }

    #[test]
    fn grok_session_update_rejects_foreign_and_accepts_matching_or_missing_session_id() {
        let (sender, mut receiver) = crate::provider_events::tap_channel(4);
        let events = ScopedProviderEvents::new(sender, "test-worker");
        let native = Mutex::new(Some("parent".to_owned()));
        let active = Mutex::new(Some("turn".to_owned()));
        let permissions = Mutex::new(HashMap::new());
        let ui = Mutex::new(GrokUiState::default());
        for raw in [
            json!({"method":"session/update","params":{"sessionId":"parent","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"matching"}}}}),
            json!({"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"missing"}}}}),
        ] {
            emit_grok_message(
                &events,
                "session",
                &native,
                &active,
                &permissions,
                &ui,
                &Mutex::new(None),
                raw,
            );
            let event = receiver.try_recv().unwrap();
            assert_eq!(event.kind, "chat.delta");
            assert_eq!(event.native_id.as_deref(), Some("parent"));
        }
        emit_grok_message(
            &events,
            "session",
            &native,
            &active,
            &permissions,
            &ui,
            &Mutex::new(None),
            json!({"method":"session/update","params":{"sessionId":"child","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"foreign"}}}}),
        );
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn usage_waits_for_both_queries_then_emits_one_card_before_completion() {
        for billing_first in [true, false] {
            let (reply, mut receiver) = usage_reply_fixture();
            let session = json!({"usage":{"totalTokens":123,"modelCalls":1}});
            reply.record(
                billing_first,
                Ok(if billing_first {
                    billing_fixture()
                } else {
                    session.clone()
                }),
            );
            assert!(receiver.try_recv().is_err());
            assert_eq!(reply.active_turn.lock().unwrap().as_deref(), Some("usage"));
            reply.record(
                !billing_first,
                Ok(if billing_first {
                    session
                } else {
                    billing_fixture()
                }),
            );
            let card = receiver.try_recv().unwrap();
            assert_eq!(card.kind, "chat.item");
            assert_eq!(card.data["parts"][1]["data"]["rows"][0]["percent"], 60);
            assert_eq!(receiver.try_recv().unwrap().kind, "chat.turn.completed");
            assert!(reply.active_turn.lock().unwrap().is_none());
            reply.timeout();
            assert!(receiver.try_recv().is_err());
        }
    }

    #[test]
    fn usage_partial_failure_and_timeout_never_fabricate_account_limits() {
        let (reply, mut receiver) = usage_reply_fixture();
        reply.record(
            false,
            Ok(json!({"usage":{"totalTokens":123,"modelCalls":1}})),
        );
        reply.timeout();
        let card = receiver.try_recv().unwrap();
        let parts = card.data["parts"].as_array().unwrap();
        assert!(parts[1]["text"].as_str().unwrap().contains("unavailable"));
        assert!(parts[2]["text"].as_str().unwrap().contains("123"));
        assert!(!parts
            .iter()
            .any(|part| part.pointer("/data/kind") == Some(&json!("plan"))));
        assert_eq!(receiver.try_recv().unwrap().kind, "chat.turn.completed");
        reply.record(true, Ok(billing_fixture()));
        assert!(receiver.try_recv().is_err());
        let parts = grok_usage_parts(
            &Err(ProviderError::new("failed", "native failure")),
            &Ok(billing_fixture()),
        );
        assert_eq!(parts[1]["data"]["rows"][0]["percent"], 60);
        assert!(parts[2]["text"].as_str().unwrap().contains("unavailable"));
    }

    #[test]
    fn cancelled_usage_discards_late_card_without_touching_newer_turn() {
        let (reply, mut receiver) = usage_reply_fixture();
        reply.record(false, Ok(json!({"usage":{"modelCalls":0}})));
        assert!(reply.cancel());
        let cancelled = receiver.try_recv().unwrap();
        assert_eq!(cancelled.kind, "chat.turn.completed");
        assert_eq!(cancelled.data["cancelled"], true);
        *reply.active_turn.lock().unwrap() = Some("newer".into());
        reply.record(true, Ok(billing_fixture()));
        reply.timeout();
        assert!(!reply.cancel());
        assert!(receiver.try_recv().is_err());
        assert_eq!(reply.active_turn.lock().unwrap().as_deref(), Some("newer"));
    }

    #[test]
    fn usage_completion_and_cancellation_release_timeout_workers_immediately() {
        for cancel in [false, true] {
            let (reply, _receiver) = usage_reply_fixture();
            let reply = Arc::new(reply);
            let pending = Arc::clone(&reply);
            let (done, observed) = std::sync::mpsc::channel();
            let timer = std::thread::spawn(move || {
                pending.wait_timeout(Duration::from_secs(30));
                done.send(()).unwrap();
            });
            if cancel {
                assert!(reply.cancel());
            } else {
                reply.record(false, Ok(json!({"usage":{"modelCalls":0}})));
                reply.record(true, Ok(billing_fixture()));
            }
            observed
                .recv_timeout(Duration::from_secs(1))
                .expect("terminal usage must release timer immediately");
            timer.join().unwrap();
        }
    }

    #[test]
    fn native_status_uses_reported_context_without_inventing_counts() {
        let text = grok_info_text(&json!({"result":{
            "model":"grok-4.6","modelDisplayName":"Grok 4.6","turns":2,
            "context":{"used":1234,"total":200000,"compactionCount":1}
        }}))
        .unwrap();
        assert!(text.contains("Model: Grok 4.6"));
        assert!(text.contains("Context tokens used: 1234"));
        assert!(text.contains("Context token limit: 200000"));
        assert!(!text.contains("Tool calls:"));
        assert!(grok_info_text(&json!({"result":{}})).is_none());
    }

    #[test]
    fn grok_command_catalog_filters_unimplemented_native_commands() {
        let mut state = GrokUiState::default();
        merge_grok_ui(
            &mut state,
            &json!({"availableCommands":[
                {"name":"dashboard","description":"Native TUI dashboard"},
                {"name":"learn","description":"Native skill"},
                {"name":"usage","description":"Usage"}
            ]}),
        );
        let names = state
            .commands
            .iter()
            .filter_map(|row| row["name"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(names.len(), GROK_SLASH_COMMANDS.len());
        assert!(!names.contains(&"dashboard"));
        assert!(!names.contains(&"learn"));
        assert_eq!(names.iter().filter(|name| **name == "usage").count(), 1);
        assert_eq!(parse_slash(" /usage "), Some(("usage", "")));
        assert_eq!(parse_slash("/plan off"), Some(("plan", "off")));
        assert_eq!(parse_slash("/"), Some(("help", "")));
        assert_eq!(parse_slash("//example"), None);
        assert_eq!(parse_slash("ordinary text"), None);
    }

    #[test]
    fn maps_grok_config_options_to_model_and_thinking() {
        let mut state = GrokUiState::default();
        merge_grok_ui(
            &mut state,
            &json!({
                "configOptions":[
                    {"id":"model","name":"Model","currentValue":"grok-4.6","options":[{"value":"grok-4.6","name":"Grok 4.6"}]},
                    {"id":"reasoning_effort","name":"Reasoning Effort","currentValue":"high","options":[{"value":"high","name":"High Effort"}]}
                ]
            }),
        );
        assert_eq!(state.options[0]["id"], "model");
        assert_eq!(state.options[0]["value"], "grok-4.6");
        assert_eq!(state.options[1]["id"], "thinking");
        assert_eq!(state.options[1]["value"], "high");
        assert!(state
            .commands
            .iter()
            .any(|command| command["name"] == "compact"));
        let mode = state
            .options
            .iter()
            .find(|option| option["id"] == "mode")
            .expect("permission mode");
        assert_eq!(mode["value"], "default");
        assert_eq!(mode["choices"].as_array().unwrap().len(), 6);
    }

    #[test]
    fn models_update_refreshes_thinking_choices() {
        let mut state = GrokUiState::default();
        merge_models_update(
            &mut state,
            &json!({
                "currentModelId":"grok-4.6",
                "availableModels":[{
                    "modelId":"grok-4.6","name":"Grok 4.6",
                    "_meta":{"reasoningEffort":"xhigh","reasoningEfforts":[
                        {"id":"xhigh","value":"xhigh","label":"Extra High Effort"},
                        {"id":"low","value":"low","label":"Low Effort"}
                    ]}
                }]
            }),
        );
        assert_eq!(state.options[0]["value"], "grok-4.6");
        assert_eq!(state.options[1]["id"], "thinking");
        assert_eq!(state.options[1]["value"], "xhigh");
        assert_eq!(state.options[1]["choices"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn history_item_uses_session_id() {
        let item = grok_history_item(&json!({"sessionId":"abc","title":"Work","cwd":"D:\\\\repo"}))
            .unwrap();
        assert_eq!(item["nativeId"], "abc");
        assert_eq!(item["provider"], "grok");
        assert_eq!(item["resumable"], true);
    }

    #[test]
    fn streams_thought_and_message_chunks() {
        assert_eq!(grok_part_type("agent_thought_chunk"), Some("thinking"));
        assert_eq!(grok_part_type("agent_message_chunk"), Some("text"));
        assert_eq!(
            grok_update_text(&json!({"content":{"type":"text","text":"OK"}})).as_deref(),
            Some("OK")
        );
        let part = grok_tool_part(
            &json!({"toolCallId":"t1","title":"list_dir","status":"completed","_meta":{"x.ai/tool":{"label":"List Files"}}}),
            "running",
        );
        assert_eq!(part["type"], "tool");
        assert_eq!(part["toolName"], "List Files");
        assert_eq!(part["toolId"], "t1");
        assert_eq!(part["status"], "complete");
    }

    #[test]
    fn reverse_rpc_rejects_unknown_client_methods_but_keeps_permissions() {
        assert_eq!(
            grok_reverse_rpc(&json!({"jsonrpc":"2.0","id":7,"method":"_x.ai/ask_user_question"})),
            Some((json!(7), "_x.ai/ask_user_question".to_owned()))
        );
        assert_eq!(
            grok_reverse_rpc(&json!({"method":"session/update","params":{}})),
            None
        );
        let responder = Mutex::new(None);
        assert!(reject_unknown_grok_rpc(
            &responder,
            &json!({"id":1,"method":"fs/read_text_file"})
        ));
        assert!(!reject_unknown_grok_rpc(
            &responder,
            &json!({"id":2,"method":"session/request_permission"})
        ));
    }

    #[test]
    fn nested_load_session_capability_is_recognized() {
        assert!(has_capability(
            &json!({"agentCapabilities":{"loadSession":true,"sessionCapabilities":{"list":{},"resume":{}}}}),
            "load"
        ));
        assert!(has_capability(
            &json!({"agentCapabilities":{"sessionCapabilities":{"list":{}}}}),
            "list"
        ));
    }
}
