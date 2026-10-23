use super::{
    acp_mcp_servers,
    approval::{
        acp_choices, acp_title, approval_payload, find_choice,
        validate_turn, write_failed_not_sent, ApprovalChoice, PendingApprovalState,
    },
    acp_scoped_permission_option, approve_scoped_threadterm_tool, chat_tool_policy,
    common::{
        command_output, context_usage_from_update, dispatch_acp_message, flush_acp_messages, encode_approval_id, history_page, insert_optional, validate_native_id,
        version_probe, ChatTextSegments, CommandSpec, EnvelopeStyle, JsonLineProcess, JsonLineResponder,
    },
    emit_bound as emit, verify_permission_options, ChatSession, ChatToolPolicy, ChatToolServer, ProviderAdapter, ProviderCapability,
    NativeSessionRef, ProviderError, ScopedProviderEvents, TerminalCommand,
};
use crate::plugins::{AgentDescriptor, TerminalConfig};
use crate::chat_questions::answer_summary;
use chrono::Utc;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
#[cfg(test)]
use super::ProviderEvent;
#[cfg(test)]
use tokio::sync::broadcast;

pub struct AcpAdapter {
    descriptor: AgentDescriptor,
    kimi_native: bool,
    events: crate::provider_events::Sender,
}

impl AcpAdapter {
    pub fn kimi(events: crate::provider_events::Sender) -> Self {
        Self {
            descriptor: AgentDescriptor {
                id: "kimi".into(),
                name: super::builtin_name("kimi").into(),
                plugin_id: None,
                icon: None,
                homepage: None,
                command: "kimi".into(),
                args: Vec::new(),
                version_args: vec!["--version".into()],
                terminal: Some(TerminalConfig {
                    args: Vec::new(),
                    resume_args: vec!["--session".into(), "{sessionId}".into()],
                }),
                chat_args: Some(vec!["acp".into()]),
                sign_in_args: Some(vec!["login".into()]),
                plugin_dir: None,
            },
            kimi_native: true,
            events,
        }
    }

    pub fn from_descriptor(
        descriptor: AgentDescriptor,
        events: crate::provider_events::Sender,
    ) -> Self {
        Self {
            descriptor,
            kimi_native: false,
            events,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn(
        &self,
        session_id: &str,
        native: Arc<Mutex<Option<String>>>,
        active_turn: Arc<Mutex<Option<String>>>,
        permissions: Arc<Mutex<HashMap<String, PermissionRequest>>>,
        ui: Arc<Mutex<AcpUiState>>,
        capture: Option<Arc<Mutex<Vec<Value>>>>,
        replay_gate: Arc<AtomicBool>,
        events: ScopedProviderEvents,
        project_events: bool,
        tool_policy: ChatToolPolicy,
    ) -> Result<(JsonLineProcess, Value), ProviderError> {
        let spec = self
            .descriptor
            .command_spec(self.descriptor.chat_args.as_deref().unwrap_or(&[]))?;
        let provider = self.descriptor.id.clone();
        let owned_session = session_id.to_owned();
        let think_open = Arc::new(Mutex::new(false));
        let responder: Arc<Mutex<Option<JsonLineResponder>>> = Arc::new(Mutex::new(None));
        let auto_responder = Arc::clone(&responder);
        let permission_ui = Arc::clone(&ui);
        let ready_message: Arc<dyn Fn(Value) + Send + Sync> = Arc::new(move |raw: Value| {
            // Requests must settle even when transcript replay is suppressed.
            if handle_acp_message(&auto_responder, &raw, tool_policy,
                project_events && !replay_gate.load(Ordering::SeqCst)) {
                emit_acp_message(
                    &events,
                    &provider,
                    &owned_session,
                    &native,
                    &active_turn,
                    &permissions,
                    &think_open,
                    &ui,
                    raw,
                );
            }
        });
        // The reader starts before spawn returns its responder. Preserve that
        // small startup window instead of silently dropping early requests.
        let startup = Arc::new(Mutex::new(Some(Vec::<Value>::new())));
        let reader_startup = Arc::clone(&startup);
        let reader_ready = Arc::clone(&ready_message);
        let on_message = Arc::new(move |raw: Value| {
            if let Some(capture) = &capture {
                if let Ok(mut values) = capture.lock() { values.push(raw.clone()); }
            }
            dispatch_acp_message(&reader_startup, &reader_ready, raw);
        });
        let process = JsonLineProcess::spawn(
            format!("{}-acp", self.descriptor.id),
            &spec,
            None,
            &[],
            EnvelopeStyle::JsonRpc2,
            on_message,
        )?;
        if let Ok(mut slot) = responder.lock() {
            *slot = Some(process.responder());
        }
        if let Ok(mut state) = permission_ui.lock() {
            state.permission_responder = Some(process.responder());
        }
        flush_acp_messages(&startup, &ready_message);
        let initialized = process.request("initialize", json!({
            "protocolVersion": 1,
            "clientCapabilities": {"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},
            "clientInfo": {"name":"threadterm","title":"ThreadTerm","version":env!("CARGO_PKG_VERSION")}
        }))?;
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
            Arc::new(Mutex::new(AcpUiState::default())),
            capture,
            Arc::new(AtomicBool::new(false)),
            ScopedProviderEvents::new(self.events.clone(), "history"),
            false,
            ChatToolPolicy::default(),
        )
    }
}

impl ProviderAdapter for AcpAdapter {
    fn id(&self) -> &str {
        &self.descriptor.id
    }

    fn capability(&self) -> ProviderCapability {
        let (installed, version, probe_error) = self.descriptor.version_probe();
        let protocol = if installed {
            self.temporary(None)
                .map(|(_, initialized)| initialized)
                .map_err(|error| error.message)
        } else {
            Err(acp_probe_failure_reason(
                &self.descriptor.name,
                probe_error.clone(),
            ))
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
            id: self.descriptor.id.clone(),
            name: self.descriptor.name.clone(),
            installed,
            version,
            terminal: installed && self.descriptor.terminal.is_some(),
            chat,
            history,
            resume,
            terminal_resume_capture: self.terminal_capture().as_str(),
            reason: protocol.err().or(probe_error),
            auth: "unknown".to_owned(),
            source: if self.kimi_native {
                "builtin"
            } else {
                "plugin"
            },
            plugin_id: self.descriptor.plugin_id.clone(),
            icon: self.descriptor.icon.clone(),
            sign_in: self.descriptor.sign_in(),
            homepage: self.descriptor.homepage.clone(),
        }
    }

    fn terminal_command(
        &self,
        resume_id: Option<&str>,
        assign_id: Option<&str>,
    ) -> Result<TerminalCommand, ProviderError> {
        if resume_id.is_some() && assign_id.is_some() {
            return Err(ProviderError::new(
                "provider_invalid_request",
                "terminal resume and assignment cannot both be requested",
            ));
        }
        if self.kimi_native {
            return self
                .descriptor
                .terminal_command(resume_id.or(assign_id), None);
        }
        self.descriptor.terminal_command(resume_id, assign_id)
    }

    fn terminal_capture(&self) -> super::TerminalCapture {
        if self.kimi_native {
            super::TerminalCapture::PreAssigned
        } else {
            super::TerminalCapture::None
        }
    }

    fn prepare_terminal(&self, cwd: &str) -> Result<Option<String>, ProviderError> {
        if !self.kimi_native {
            return Ok(None);
        }
        // Kimi's TUI uses process.cwd(), which omits Windows verbatim prefixes.
        // ACP accepts either spelling but stores it as a distinct workspace key;
        // session/load alone succeeds globally and cannot catch the mismatch.
        // Keep runtime canonical paths/containment unchanged; adapt only this
        // native terminal session's creation and verification boundary.
        let cwd = kimi_terminal_cwd(cwd);
        let (process, _) = self.temporary(None)?;
        let response = process.request("session/new", json!({"cwd":cwd,"mcpServers":[]}))?;
        let id = response
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProviderError::new("provider_protocol", "Kimi returned no session id")
            })?;
        validate_native_id(id)?;
        // The CLI and ACP share native storage. Confirm the exact identity is
        // loadable from a separate process before giving it to the terminal.
        drop(process);
        let (verifier, initialized) = self.temporary(None)?;
        ensure_capability(&initialized, "load", "session/load")?;
        verifier.request(
            "session/load",
            json!({"sessionId":id,"cwd":cwd,"mcpServers":[]}),
        )?;
        Ok(Some(id.to_owned()))
    }

    fn fork_session(
        &self,
        cwd: &str,
        native_id: &str,
        _anchor: Option<&crate::domain::NativeForkAnchor>,
        is_latest: bool,
    ) -> Result<Option<String>, ProviderError> {
        // ACP session/fork has no point-in-history argument. It is therefore
        // native only for a whole/latest-session fork; older replies fall back
        // to the service copy-fork. A temporary control process loads the
        // source so the visible Chat worker and its active native identity are
        // never mutated.
        if !is_latest {
            return Ok(None);
        }
        validate_native_id(native_id)?;
        let (process, initialized) = self.temporary(None)?;
        if !has_capability(&initialized, "fork") {
            return Ok(None);
        }
        ensure_capability(&initialized, "load", "session/load")?;
        process.request(
            "session/load",
            json!({"sessionId":native_id,"cwd":cwd,"mcpServers":[]}),
        )?;
        let forked = process.request(
            "session/fork",
            json!({"sessionId":native_id,"cwd":cwd,"mcpServers":[]}),
        )?;
        let Some(id) = forked.get("sessionId").and_then(Value::as_str) else {
            return Err(ProviderError::new("provider_protocol", "ACP session/fork returned no session id"));
        };
        validate_native_id(id)?;
        Ok(Some(id.to_owned()))
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
            .filter_map(|row| acp_history_item(&self.descriptor.id, &row))
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
        Ok(Value::Array(acp_transcript_for_provider(&self.descriptor.id, &raw)))
    }

    fn subagent_transcript(
        &self,
        session: &NativeSessionRef,
        info: &Value,
    ) -> Result<Vec<Value>, ProviderError> {
        if self.descriptor.id != "kimi" {
            return Err(ProviderError::new(
                "unsupported",
                "This agent does not expose subagent transcripts",
            ));
        }
        // Same home precedence as kimi_plan_usage (its resolver is private).
        let home = std::env::var("KIMI_CODE_HOME")
            .ok()
            .map(|value| value.trim().trim_end_matches('/').to_owned())
            .filter(|value| !value.is_empty())
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("USERPROFILE")
                    .or_else(|| std::env::var_os("HOME"))
                    .map(std::path::PathBuf::from)
                    .map(|home| home.join(".kimi-code"))
            })
            .ok_or_else(|| ProviderError::new("history_unavailable", "Kimi home is unavailable"))?;
        kimi_subagent_transcript(&home, session, info)
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
        if self.kimi_native {
            super::kimi_plan_usage::prefetch();
        }
        // Passed on new and on load: a reconnect must re-attach the server
        // with this open's identity (verified with Kimi 2.0.2).
        let mcp_servers = acp_mcp_servers(tools);
        let native = Arc::new(Mutex::new(None));
        let active_turn = Arc::new(Mutex::new(None));
        let permissions = Arc::new(Mutex::new(HashMap::new()));
        let ui = Arc::new(Mutex::new(AcpUiState::default()));
        let policy = chat_tool_policy(tools);
        if let Ok(mut state) = ui.lock() {
            state.note_steer = policy.feedback;
        }
        let replay_gate = Arc::new(AtomicBool::new(false));
        let (process, initialized) = self.spawn(
            session_id,
            Arc::clone(&native),
            Arc::clone(&active_turn),
            Arc::clone(&permissions),
            Arc::clone(&ui),
            None,
            Arc::clone(&replay_gate),
            events.clone(),
            true,
            policy,
        )?;
        let response = if let Some(id) = native_id {
            validate_native_id(id)?;
            replay_gate.store(true, Ordering::SeqCst);
            let loaded = if has_capability(&initialized, "load") {
                process.request(
                    "session/load",
                    json!({"sessionId":id,"cwd":cwd,"mcpServers":mcp_servers}),
                )
            } else if has_capability(&initialized, "resume") {
                if tools.is_some() {
                    Err(ProviderError::new(
                        "resume_tools_unsupported",
                        "This ACP agent only advertises session/resume, whose MCP re-attachment schema is unknown. Reconnect without managed tools or use an agent that supports session/load.",
                    ))
                } else {
                    process.request("session/resume", json!({"sessionId":id,"cwd":cwd}))
                }
            } else {
                Err(ProviderError::new(
                    "resume_unsupported",
                    format!(
                        "{} ACP agent does not advertise session resume",
                        self.descriptor.name
                    ),
                ))
            };
            replay_gate.store(false, Ordering::SeqCst);
            loaded?
        } else {
            process.request("session/new", json!({"cwd":cwd,"mcpServers":mcp_servers}))?
        };
        let bound_id = response
            .get("sessionId")
            .and_then(Value::as_str)
            .or(native_id)
            .ok_or_else(|| {
                ProviderError::new("provider_protocol", "ACP agent returned no session id")
            })?
            .to_owned();
        if let Ok(mut value) = native.lock() {
            *value = Some(bound_id.clone());
        }
        if let Ok(mut state) = ui.lock() {
            merge_acp_ui(&mut state, &response);
            merge_acp_ui(&mut state, &initialized);
        }
        emit_chat_ui(
            &events,
            &self.descriptor.id,
            session_id,
            Some(&bound_id),
            &ui,
        );
        emit(
            &events,
            &self.descriptor.id,
            session_id,
            Some(&bound_id),
            None,
            "session.ready",
            json!({"nativeId":bound_id}),
        );
        Ok(Box::new(AcpChat {
            provider: self.descriptor.id.clone(),
            process,
            session_id: session_id.to_owned(),
            native_id: bound_id,
            events,
            active_turn,
            permissions,
            ui,
        }))
    }

    fn open_chat_with_startup_options(
        &self, session_id: &str, cwd: &str, native_id: Option<&str>, worker_token: &str,
        tools: Option<&ChatToolServer>, startup: &super::ChatStartupOptions<'_>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        let options = startup.permissions;
        let mut chat = self.open_chat_with_tools(session_id, cwd, native_id, worker_token, tools)?;
        let restored = (|| {
            for option in options.as_array().into_iter().flatten() {
                let id = option.get("id").and_then(Value::as_str).ok_or_else(|| ProviderError::new("chat_permission_restore_failed", "Invalid saved ACP permission option"))?;
                let value = option.get("value").and_then(Value::as_str).ok_or_else(|| ProviderError::new("chat_permission_restore_failed", "Invalid saved ACP permission value"))?;
                let state = chat.ui_state();
                let current = super::permission_option(&state, id);
                if current.is_none() {
                    return Err(super::permission_restore_error(option, None, "missing", None));
                }
                chat.set_option(id, value).map_err(|error| {
                    if super::is_structured_permission_restore_error(&error) {
                        error
                    } else if error.details.as_ref().and_then(|details| details.get("permissionUnconfirmed")).and_then(Value::as_bool) == Some(true) {
                        let state = chat.ui_state();
                        let reported = super::permission_option(&state, id);
                        super::permission_restore_error(
                            option,
                            reported,
                            if reported.is_some() { "mismatch" } else { "missing" },
                            reported.and_then(super::permission_value),
                        )
                    } else {
                        super::permission_restore_error(
                            option,
                            current,
                            "rejected",
                            current.and_then(super::permission_value),
                        )
                    }
                })?;
            }
            verify_permission_options(&chat.ui_state(), options)
        })();
        if let Err(error) = restored {
            let _ = chat.stop();
            return Err(super::with_permission_options(error, chat.ui_state()));
        }
        Ok(chat)
    }
}

fn acp_probe_failure_reason(name: &str, probe_error: Option<String>) -> String {
    probe_error.unwrap_or_else(|| format!("{name} CLI is not installed"))
}

#[derive(Clone)]
struct PermissionRequest {
    rpc_id: Value,
    turn_id: Option<String>,
    choices: Vec<ApprovalChoice>,
    question_data: Option<Value>,
    /// Kimi's plan review: answered through the plan card, not choices.
    plan: bool,
    state: PendingApprovalState,
}

#[derive(Clone, Default)]
struct AcpUiState {
    browser_activity: super::browser_activity::BrowserActivityTracker,
    permission_responder: Option<JsonLineResponder>,
    text_segments: ChatTextSegments,
    subagent_calls: HashMap<String, Value>,
    parent_tool_calls: HashSet<String>,
    options: Vec<Value>,
    commands: Vec<Value>,
    config_generation: u64,
    legacy_mode: bool,
    modern_mode: bool,
    last_emitted: Option<String>,
    usage_reply: Option<PendingUsageReply>,
    /// E2: this open was granted the Feedback tool, and ACP agents never steer
    /// natively, so the composer offers "Send note for next check" instead.
    note_steer: bool,
}

impl AcpUiState {
    fn wire(&self, provider: &str) -> Value {
        let mut state = json!({"options":self.options.clone(),"commands":merge_local_commands(provider, self.commands.clone())});
        if self.note_steer {
            state["inputCapabilities"] = json!({"steer":"note"});
        }
        state
    }
}

#[derive(Clone)]
struct PendingUsageReply {
    turn_id: String,
    text: String,
    native_done: bool,
    cancelled: bool,
    started: std::time::Instant,
}

#[derive(Clone)]
struct UsageReplyContext {
    events: ScopedProviderEvents,
    session_id: String,
    native_id: String,
    turn_id: String,
    active: Arc<Mutex<Option<String>>>,
    ui: Arc<Mutex<AcpUiState>>,
}

impl UsageReplyContext {
    fn finish(
        &self,
        result: Result<Value, ProviderError>,
        usage: Option<super::kimi_plan_usage::PlanUsage>,
    ) {
        // Fence late network results after cancellation, stop, or a newer turn.
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        if active.as_deref() != Some(&self.turn_id) {
            return;
        }
        let Ok(mut ui) = self.ui.lock() else {
            return;
        };
        if ui.usage_reply.as_ref().map(|reply| reply.turn_id.as_str()) != Some(&self.turn_id) {
            return;
        }
        let reply = ui.usage_reply.take().unwrap();
        let emit_reply = |kind, data| {
            emit(
                &self.events,
                "kimi",
                &self.session_id,
                Some(&self.native_id),
                Some(&self.turn_id),
                kind,
                data,
            )
        };
        if reply.cancelled {
            emit_reply(
                "chat.turn.completed",
                json!({"result":{"stopReason":"cancelled"}}),
            );
        } else {
            match result {
                Ok(value) => {
                    let mut parts = vec![];
                    if !reply.text.is_empty() {
                        parts.push(json!({"type":"text","text":reply.text,"status":"complete"}));
                    }
                    if let Some(usage) = usage {
                        parts.push(json!({"type":"text","text":usage.text,"status":"complete","data":usage.data}));
                    } else {
                        parts.push(json!({"type":"text","text":"Plan usage is currently unavailable. Please retry /usage.","status":"complete"}));
                    }
                    emit_reply("chat.item", json!({"parts":parts}));
                    emit_reply(
                        "chat.turn.completed",
                        json!({"result":value,"elapsedMs":reply.started.elapsed().as_millis() as u64}),
                    );
                }
                Err(error) => emit_reply(
                    "chat.error",
                    json!({"code":error.code,"message":error.message,"details":error.details}),
                ),
            }
        }
        *active = None;
    }
}

struct AcpChat {
    provider: String,
    process: JsonLineProcess,
    session_id: String,
    native_id: String,
    events: ScopedProviderEvents,
    active_turn: Arc<Mutex<Option<String>>>,
    permissions: Arc<Mutex<HashMap<String, PermissionRequest>>>,
    ui: Arc<Mutex<AcpUiState>>,
}

impl AcpChat {
    fn usage_context(&self, turn_id: &str) -> UsageReplyContext {
        UsageReplyContext {
            events: self.events.clone(),
            session_id: self.session_id.clone(),
            native_id: self.native_id.clone(),
            turn_id: turn_id.to_owned(),
            active: Arc::clone(&self.active_turn),
            ui: Arc::clone(&self.ui),
        }
    }

    fn start_usage(&mut self, text: &str, operation_id: &str) -> Result<Value, ProviderError> {
        {
            let mut active = self
                .active_turn
                .lock()
                .map_err(|_| ProviderError::new("provider_internal", "ACP turn lock poisoned"))?;
            if active.is_some() {
                return Err(ProviderError::new(
                    "turn_in_progress",
                    "ACP session already has an active turn",
                ));
            }
            let mut ui = self
                .ui
                .lock()
                .map_err(|_| ProviderError::new("provider_internal", "ACP UI lock poisoned"))?;
            ui.usage_reply = Some(PendingUsageReply {
                turn_id: operation_id.to_owned(),
                text: String::new(),
                native_done: false,
                cancelled: false,
                started: std::time::Instant::now(),
            });
            *active = Some(operation_id.to_owned());
        }
        let context = self.usage_context(operation_id);
        let callback = context.clone();
        // Start before dispatch so a fast builtin cannot complete before started.
        emit(
            &self.events,
            "kimi",
            &self.session_id,
            Some(&self.native_id),
            Some(operation_id),
            "chat.turn.started",
            json!({}),
        );
        let fetch = std::thread::spawn(super::kimi_plan_usage::plan_usage);
        let request = self.process.request_async(
            "session/prompt",
            json!({"sessionId":self.native_id,"prompt":[{"type":"text","text":text}]}),
            move |result| {
                let cancelled = callback
                    .ui
                    .lock()
                    .ok()
                    .and_then(|mut ui| {
                        let reply = ui
                            .usage_reply
                            .as_mut()
                            .filter(|reply| reply.turn_id == callback.turn_id)?;
                        reply.native_done = true;
                        Some(reply.cancelled)
                    })
                    .unwrap_or(true);
                if cancelled || result.is_err() {
                    callback.finish(result, None);
                    return;
                }
                // Never block the ACP reader while waiting for the managed API.
                std::thread::spawn(move || callback.finish(result, fetch.join().ok().flatten()));
            },
        );
        if let Err(error) = request {
            context.finish(Err(error.clone()), None);
            return Err(error);
        }
        Ok(json!({"turnId":operation_id}))
    }

    /// Kimi's TUI ships many slash commands that have no ACP builtin; the
    /// ones with a real ACP/CLI backing are handled locally, the rest get
    /// guidance instead of the agent's "Unknown ACP command" notice. Returns
    /// `None` for anything the agent itself handles (builtins, skills,
    /// ordinary prompts).
    fn dispatch_slash(
        &mut self,
        text: &str,
        operation_id: &str,
    ) -> Result<Option<Value>, ProviderError> {
        if self.provider != "kimi" {
            return Ok(None);
        }
        let Some((name, args)) = parse_slash(text) else {
            return Ok(None);
        };
        match name {
            "model" | "thinking" | "mode" | "permission" => {
                self.option_command(name, args, operation_id).map(Some)
            }
            "plan" => self.plan_command(args, operation_id).map(Some),
            "yolo" | "yes" => self.mode_command("yolo", operation_id).map(Some),
            "auto" => self.mode_command("auto", operation_id).map(Some),
            // `chat.send` routes /fork through the shared chat.fork service
            // before an adapter receives it. Do not retain a direct ACP fork
            // path here: it used to print a native id without creating the
            // required ThreadTerm sidebar session.
            "fork" => Ok(None),
            "logout" => self.logout_command(operation_id).map(Some),
            "version" => {
                let (_, version, _) = version_probe("kimi");
                self.reply_command(
                    operation_id,
                    &format!(
                        "Kimi Code CLI {}",
                        version.as_deref().unwrap_or("(unknown)")
                    ),
                );
                Ok(Some(json!({"turnId":operation_id})))
            }
            "init" => self.start_prompt(KIMI_INIT_PROMPT, operation_id).map(Some),
            "export-debug-zip" => self.export_command(args, operation_id).map(Some),
            "task" => self.start_prompt("/tasks", operation_id).map(Some),
            "h" | "?" => self.start_prompt("/help", operation_id).map(Some),
            _ => match kimi_command_guidance(name) {
                Some(guidance) => {
                    self.reply_command(operation_id, guidance);
                    Ok(Some(json!({"turnId":operation_id})))
                }
                None => Ok(None),
            },
        }
    }

    /// Emit a locally produced command reply as a settled assistant item,
    /// without opening a provider turn.
    fn reply_command(&mut self, operation_id: &str, text: &str) {
        emit(
            &self.events,
            &self.provider,
            &self.session_id,
            Some(&self.native_id),
            Some(operation_id),
            "chat.item",
            json!({"parts":[{"type":"text","text":text,"status":"complete"}]}),
        );
    }

    fn option_value(&self, option_id: &str) -> Option<String> {
        let state = self.ui.lock().ok()?;
        state
            .options
            .iter()
            .find(|option| option.get("id").and_then(Value::as_str) == Some(option_id))?
            .get("value")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    fn option_command(
        &mut self,
        name: &str,
        args: &str,
        operation_id: &str,
    ) -> Result<Value, ProviderError> {
        let option_id = if name == "permission" { "mode" } else { name };
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
        let title = option
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(option_id);
        let choices = option
            .get("choices")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if args.is_empty() {
            self.reply_command(
                operation_id,
                &format_option_listing(title, &option, &choices),
            );
            return Ok(json!({"turnId":operation_id}));
        }
        let Some((value, choice_name)) = match_choice(&choices, args) else {
            self.reply_command(
                operation_id,
                &format!(
                    "Unknown {title} \"{args}\".\n{}",
                    format_option_listing(title, &option, &choices)
                ),
            );
            return Ok(json!({"turnId":operation_id}));
        };
        match self.set_option(option_id, &value) {
            Ok(_) => self.reply_command(operation_id, &format!("{title}: {choice_name}")),
            Err(error) => self.reply_command(
                operation_id,
                &format!("Failed to switch {title}: {}", error.message),
            ),
        }
        Ok(json!({"turnId":operation_id}))
    }

    fn mode_command(&mut self, mode: &str, operation_id: &str) -> Result<Value, ProviderError> {
        let result = self.set_option("mode", mode).and_then(|state| {
            verify_permission_options(&state, &json!([{"id":"mode","value":mode}]))?;
            Ok(state)
        });
        match result {
            Ok(_) => self.reply_command(operation_id, &format!("Mode: {mode}")),
            Err(error) => self.reply_command(
                operation_id,
                &format!("Failed to switch mode: {}", error.message),
            ),
        }
        Ok(json!({"turnId":operation_id}))
    }

    fn plan_command(&mut self, args: &str, operation_id: &str) -> Result<Value, ProviderError> {
        match args {
            "" => {
                let next = if self.option_value("mode").as_deref() == Some("plan") {
                    "default"
                } else {
                    "plan"
                };
                self.mode_command(next, operation_id)
            }
            "on" => self.mode_command("plan", operation_id),
            "off" => self.mode_command("default", operation_id),
            "clear" => {
                self.reply_command(
                    operation_id,
                    "Clearing the plan file is only available in the Kimi TUI.",
                );
                Ok(json!({"turnId":operation_id}))
            }
            _ => {
                self.reply_command(operation_id, "Usage: /plan [on|off]");
                Ok(json!({"turnId":operation_id}))
            }
        }
    }

    fn logout_command(&mut self, operation_id: &str) -> Result<Value, ProviderError> {
        match self.process.request("logout", json!({})) {
            Ok(_) => self.reply_command(
                operation_id,
                "Logged out of the managed Kimi account. Run `kimi login` in a terminal or use ThreadTerm's provider setup before the next prompt.",
            ),
            Err(error) => self.reply_command(operation_id, &format!("Logout failed: {}", error.message)),
        }
        Ok(json!({"turnId":operation_id}))
    }

    fn export_command(&mut self, args: &str, operation_id: &str) -> Result<Value, ProviderError> {
        let mut argv = vec!["export", self.native_id.as_str(), "--yes"];
        if !args.is_empty() {
            argv.push("--output");
            argv.push(args);
        }
        let result = CommandSpec::provider("kimi", &argv)
            .and_then(|spec| command_output(&spec, Duration::from_secs(60)));
        match result {
            Ok(output) => {
                let output = output.trim();
                self.reply_command(
                    operation_id,
                    if output.is_empty() {
                        "Export finished."
                    } else {
                        output
                    },
                );
            }
            Err(error) => {
                self.reply_command(operation_id, &format!("Export failed: {}", error.message))
            }
        }
        Ok(json!({"turnId":operation_id}))
    }

    fn start_prompt(&mut self, text: &str, operation_id: &str) -> Result<Value, ProviderError> {
        if self.provider == "kimi" && text.split_whitespace().next() == Some("/usage") {
            return self.start_usage(text, operation_id);
        }
        {
            let mut active = self
                .active_turn
                .lock()
                .map_err(|_| ProviderError::new("provider_internal", "ACP turn lock poisoned"))?;
            if active.is_some() {
                return Err(ProviderError::new(
                    "turn_in_progress",
                    "ACP session already has an active turn",
                ));
            }
            *active = Some(operation_id.to_owned());
        }
        let events = self.events.clone();
        let provider = self.provider.clone();
        let session_id = self.session_id.clone();
        let native_id = self.native_id.clone();
        let turn_id = operation_id.to_owned();
        let active = Arc::clone(&self.active_turn);
        let permissions = Arc::clone(&self.permissions);
        let responder = self.process.responder();
        let started = std::time::Instant::now();
        let request = self.process.request_async(
            "session/prompt",
            json!({
                "sessionId":self.native_id,"prompt":[{"type":"text","text":text}]
            }),
            move |result| {
                if let Ok(mut value) = active.lock() {
                    if value.as_deref() != Some(&turn_id) { return; }
                    *value = None;
                    drain_acp_permissions(&permissions, &responder);
                }
                match result {
                    Ok(value) => {
                        emit(
                            &events,
                            &provider,
                            &session_id,
                            Some(&native_id),
                            Some(&turn_id),
                            "chat.turn.completed",
                            json!({"result":value,"elapsedMs":(provider == "kimi").then(|| started.elapsed().as_millis() as u64)}),
                        );
                    }
                    Err(error) => emit(
                        &events,
                        &provider,
                        &session_id,
                        Some(&native_id),
                        Some(&turn_id),
                        "chat.error",
                        json!({"code":error.code,"message":error.message,"details":error.details}),
                    ),
                }
            },
        );
        if let Err(error) = request {
            if let Ok(mut active) = self.active_turn.lock() {
                *active = None;
            }
            drain_acp_permissions(&self.permissions, &self.process.responder());
            return Err(error);
        }
        emit(
            &self.events,
            &self.provider,
            &self.session_id,
            Some(&self.native_id),
            Some(operation_id),
            "chat.turn.started",
            json!({}),
        );
        Ok(json!({"turnId":operation_id}))
    }

    fn submit_choice(
        &mut self,
        turn_id: &str,
        approval_id: &str,
        choice_id: &str,
        operation_id: &str,
        resolved: Value,
    ) -> Result<(), ProviderError> {
        // Terminal drain and submission share active -> permissions lock order.
        let active_turn = self.active_turn.lock()
            .map_err(|_| ProviderError::new("provider_internal", "ACP turn lock poisoned"))?;
        let mut permissions = self
            .permissions
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "ACP permission lock poisoned"))?;
        let pending = permissions.get_mut(approval_id).ok_or_else(|| {
            ProviderError::new(
                "approval_not_pending",
                "ACP approval is unknown or already resolved",
            )
        })?;
        validate_turn(pending.turn_id.as_deref(), active_turn.as_deref(), turn_id)?;
        find_choice(&pending.choices, choice_id)?;
        match pending.state.begin_submit(operation_id) {
            Ok(()) => {}
            Err(error) if error.code == "approval_duplicate" => return Ok(()),
            Err(error) => return Err(error),
        }
        let rpc_id = pending.rpc_id.clone();
        let outcome = json!({"outcome":{"outcome":"selected","optionId":choice_id}});
        let result = self.process.respond(rpc_id, outcome);
        match result {
            Ok(()) => {
                permissions.remove(approval_id);
                emit(
                    &self.events,
                    &self.provider,
                    &self.session_id,
                    Some(&self.native_id),
                    Some(turn_id),
                    "chat.approval.resolved",
                    resolved,
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
                    &self.provider,
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
}

impl ChatSession for AcpChat {
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
        let active = self
            .active_turn
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "ACP turn lock poisoned"))?;
        if active.as_deref() != Some(turn_id) {
            return Err(ProviderError::new(
                "turn_not_active",
                "the requested ACP turn is not active",
            ));
        }
        let usage_done = self.ui.lock().ok().and_then(|mut ui| {
            let reply = ui
                .usage_reply
                .as_mut()
                .filter(|reply| reply.turn_id == turn_id)?;
            reply.cancelled = true;
            Some(reply.native_done)
        });
        if usage_done == Some(true) {
            drop(active);
            self.usage_context(turn_id)
                .finish(Ok(json!({"stopReason":"cancelled"})), None);
            return Ok(());
        }
        // Keep the turn fenced until the native cancel has been written. A
        // completion must not allow a new prompt to receive this notification.
        let result = self
            .process
            .notification("session/cancel", json!({"sessionId":self.native_id}));
        drop(active);
        result
    }

    fn approve(
        &mut self,
        turn_id: &str,
        approval_id: &str,
        choice_id: &str,
        operation_id: &str,
    ) -> Result<(), ProviderError> {
        self.submit_choice(turn_id, approval_id, choice_id, operation_id,
            json!({"approvalId":approval_id,"outcome":"submitted"}))
    }

    fn plan_response(
        &mut self,
        turn_id: &str,
        approval_id: &str,
        response: &Value,
        operation_id: &str,
    ) -> Result<Option<String>, ProviderError> {
        crate::chat_plan_approval::validate_response(response, false)?;
        let pending_plan = self.permissions.lock().ok()
            .is_some_and(|values| values.get(approval_id).is_some_and(|pending| pending.plan));
        if !pending_plan {
            return Err(ProviderError::new("approval_not_pending", "This plan is no longer waiting for a decision"));
        }
        let (choice_id, outcome) = match response.get("action").and_then(Value::as_str) {
            Some("approve") => ("plan_approve", "approved"),
            Some("abandon") => ("plan_reject_and_exit", "abandoned"),
            _ => ("plan_revise", "changes_requested"),
        };
        let mut resolved = json!({"approvalId":approval_id,"status":"answered","outcome":"submitted","planOutcome":outcome});
        let feedback = response.get("feedback").and_then(Value::as_str).map(str::trim)
            .filter(|text| outcome == "changes_requested" && !text.is_empty());
        if let Some(feedback) = feedback {
            resolved["feedback"] = json!(feedback);
        }
        self.submit_choice(turn_id, approval_id, choice_id, operation_id, resolved)?;
        if outcome != "changes_requested" {
            // Approve and Reject and Exit both leave plan mode, but Kimi reports
            // a mode change only for session/set_mode (live 2.0.2).
            let moved = self.ui.lock().ok().is_some_and(|mut state| {
                state.options.iter_mut()
                    .find(|option| option.get("id").and_then(Value::as_str) == Some("mode")
                        && option.get("value").and_then(Value::as_str) == Some("plan"))
                    .map(|option| option["value"] = json!("default"))
                    .is_some()
            });
            if moved {
                emit_permission_mode_confirmed(
                    &self.events,
                    &self.provider,
                    &self.session_id,
                    Some(&self.native_id),
                    &self.ui,
                );
            }
        }
        let Some(feedback) = feedback else { return Ok(None); };
        // Kimi's ACP reply has no feedback field: Revise keeps plan mode and the
        // agent goes on to ask what to change. End that turn, then the feedback
        // is the next prompt and Kimi revises the plan.
        match self.cancel(turn_id) {
            Ok(()) => {}
            Err(error) if error.code == "turn_not_active" => {}
            Err(error) => return Err(error),
        }
        let deadline = std::time::Instant::now() + KIMI_REVISE_STOP_WAIT;
        while self.active_turn.lock().ok().is_some_and(|active| active.as_deref() == Some(turn_id)) {
            if std::time::Instant::now() >= deadline {
                return Err(ProviderError::new("turn_in_progress",
                    "Kimi has not stopped the planning turn yet; send your plan changes once it ends."));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(Some(format!("Revise the plan with this feedback:\n\n{feedback}")))
    }

    fn answer(
        &mut self,
        turn_id: &str,
        approval_id: &str,
        response: &Value,
        operation_id: &str,
    ) -> Result<(), ProviderError> {
        let active_turn = self.active_turn.lock()
            .map_err(|_| ProviderError::new("provider_internal", "ACP turn lock poisoned"))?;
        let mut permissions = self
            .permissions
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "ACP permission lock poisoned"))?;
        let pending = permissions.get_mut(approval_id).ok_or_else(|| {
            ProviderError::new("approval_not_pending", "ACP question is unknown or already resolved")
        })?;
        let Some(question_data) = pending.question_data.as_ref() else {
            return Err(ProviderError::new("answer_invalid", "interaction is not a Kimi question"));
        };
        validate_turn(pending.turn_id.as_deref(), active_turn.as_deref(), turn_id)?;
        let (choice_id, status) = kimi_question_choice(&pending.choices, response)?;
        let summary = answer_summary(question_data, response);
        match pending.state.begin_submit(operation_id) {
            Ok(()) => {}
            Err(error) if error.code == "approval_duplicate" => return Ok(()),
            Err(error) => return Err(error),
        }
        let rpc_id = pending.rpc_id.clone();
        let outcome = json!({"outcome":{"outcome":"selected","optionId":choice_id}});
        let result = self.process.respond(rpc_id, outcome);
        match result {
            Ok(()) => {
                permissions.remove(approval_id);
                emit(&self.events, &self.provider, &self.session_id, Some(&self.native_id), Some(turn_id),
                    "chat.approval.resolved",
                    json!({"approvalId":approval_id,"status":status,"outcome":"submitted","answerSummary":summary}));
                Ok(())
            }
            Err(error) if write_failed_not_sent(&error) => {
                if let Some(pending) = permissions.get_mut(approval_id) { pending.state.clear_submit(); }
                Err(error)
            }
            Err(error) => {
                if let Some(pending) = permissions.get_mut(approval_id) { pending.state.mark_unknown(); }
                emit(&self.events, &self.provider, &self.session_id, Some(&self.native_id), Some(turn_id),
                    "chat.approval.resolved",
                    json!({"approvalId":approval_id,"status":"outcomeUnknown","outcome":"unknown"}));
                Err(ProviderError::new("approval_outcome_unknown", error.message))
            }
        }
    }

    fn stop(&mut self) -> Result<(), ProviderError> {
        let turn = self.active_turn.lock().ok().and_then(|v| v.clone());
        if let Some(turn) = turn {
            let _ = self.cancel(&turn);
        }
        Ok(())
    }

    fn ui_state(&self) -> Value {
        self.ui
            .lock()
            .ok()
            .map(|state| state.wire(&self.provider))
            .unwrap_or_else(|| json!({"options":[],"commands":[]}))
    }

    fn set_option(&mut self, option_id: &str, value: &str) -> Result<Value, ProviderError> {
        let permission_option = self.ui.lock().ok().is_some_and(|state| {
            state.options.iter().find(|option| option.get("id").and_then(Value::as_str) == Some(option_id))
                .is_some_and(|option| option_id == "mode" || option.get("category").and_then(Value::as_str) == Some("mode"))
        });
        let valid_choice = self.ui.lock().ok().is_some_and(|state| {
            state.options.iter().find(|option| option.get("id").and_then(Value::as_str) == Some(option_id))
                .and_then(|option| option.get("choices").and_then(Value::as_array))
                .is_some_and(|choices| choices.iter().any(|choice| choice.get("value").and_then(Value::as_str) == Some(value)))
        });
        if permission_option && !valid_choice {
            return Err(ProviderError::new("provider_protocol", format!("ACP no longer advertises permission mode {option_id}={value}")));
        }
        if option_id == "mode" && self.ui.lock().map(|state| state.legacy_mode).unwrap_or(false) {
            let result = self.process.request("session/set_mode", json!({"sessionId":self.native_id,"modeId":value}))?;
            if let Ok(mut state) = self.ui.lock() { merge_acp_ui(&mut state, &result); }
            wait_for_acp_option(&self.ui, option_id, value)?;
            emit_chat_ui(&self.events, &self.provider, &self.session_id, Some(&self.native_id), &self.ui);
            return Ok(self.ui_state());
        }
        let config_generation = self
            .ui
            .lock()
            .map(|state| state.config_generation)
            .unwrap_or_default();
        let result = self.process.request(
            "session/set_config_option",
            json!({"sessionId":self.native_id,"configId":option_id,"value":value}),
        );
        let result = match result {
            Ok(value) => value,
            Err(error) => {
                // Kimi 2.0.2 can retain plan internally across `session/load`
                // while advertising default. Re-applying plan then returns this
                // exact idempotency error. It is an acknowledgement only for
                // Kimi's native mode option and the requested mode; every other
                // native error remains a failed/uncertain restoration.
                if option_id == "mode" && self.provider == "kimi"
                    && kimi_mode_already_active(&error, value)
                {
                    if let Ok(mut state) = self.ui.lock() {
                        if let Some(option) = state.options.iter_mut().find(|option| option.get("id").and_then(Value::as_str) == Some("mode")) {
                            option["value"] = json!(value);
                        }
                    }
                    emit_chat_ui(
                        &self.events,
                        &self.provider,
                        &self.session_id,
                        Some(&self.native_id),
                        &self.ui,
                    );
                    return Ok(self.ui_state());
                }
                // The legacy session/set_model interface exists only for agents
                // that genuinely do not implement session/set_config_option,
                // and only a model change may use it. Argument rejections,
                // authentication failures, timeouts and disconnects describe a
                // failed or uncertain setting, never a model fallback.
                let method_missing = error
                    .details
                    .as_ref()
                    .and_then(|details| details.get("code"))
                    .and_then(Value::as_i64)
                    == Some(-32601);
                if option_id == "model" && method_missing {
                    self.process.request(
                        "session/set_model",
                        json!({"sessionId":self.native_id,"modelId":value}),
                    )?
                } else {
                    return Err(error);
                }
            }
        };
        if let Ok(mut state) = self.ui.lock() {
            // An intervening ACP config notification is a newer full snapshot.
            // The delayed RPC reply must not roll it back.
            if state.config_generation != config_generation {
                drop(state);
                emit_chat_ui(
                    &self.events,
                    &self.provider,
                    &self.session_id,
                    Some(&self.native_id),
                    &self.ui,
                );
                return Ok(self.ui_state());
            }
            // The agent's reply is authoritative: a normalized or canonical
            // value it returns wins over the submitted text. Only when the
            // reply says nothing about this option do we keep the accepted
            // submission as the optimistic current value.
            merge_acp_ui(&mut state, &result);
            let confirmed = result
                .get("configOptions")
                .or_else(|| result.get("availableConfigOptions"))
                .and_then(Value::as_array)
                .map(|options| {
                    options.iter().any(|option| {
                        option
                            .get("configId")
                            .or_else(|| option.get("id"))
                            .and_then(Value::as_str)
                            == Some(option_id)
                    })
                })
                .unwrap_or(false)
                || result
                    .get("configOption")
                    .or_else(|| result.get("option"))
                    .and_then(|option| {
                        option
                            .get("configId")
                            .or_else(|| option.get("id"))
                            .and_then(Value::as_str)
                    })
                    == Some(option_id);
            if !confirmed && !permission_option {
                if let Some(option) = state
                    .options
                    .iter_mut()
                    .find(|option| option.get("id").and_then(Value::as_str) == Some(option_id))
                {
                    option["value"] = json!(value);
                }
            }
        }
        if permission_option {
            wait_for_acp_option(&self.ui, option_id, value)?;
        }
        emit_chat_ui(
            &self.events,
            &self.provider,
            &self.session_id,
            Some(&self.native_id),
            &self.ui,
        );
        Ok(self.ui_state())
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
            format!("ACP agent does not advertise {operation}"),
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

fn acp_permission_subagent(params: &Value, state: &AcpUiState) -> Option<Value> {
    if params
        .get("toolCallId")
        .and_then(Value::as_str)
        .is_some_and(|tool_call_id| state.parent_tool_calls.contains(tool_call_id))
    {
        return None;
    }

    let mut running = state.subagent_calls.iter().filter(|(_, info)| {
        info.get("status").and_then(Value::as_str) == Some("running")
    });
    let (key, info) = running.next()?;
    let label = info
        .get("description")
        .and_then(Value::as_str)
        .filter(|description| !description.is_empty())
        .or_else(|| info.get("agentType").and_then(Value::as_str))
        .filter(|agent_type| !agent_type.is_empty())
        .unwrap_or("Subagent");
    if running.next().is_some() {
        Some(json!({"label":"Subagent"}))
    } else {
        Some(json!({"key":key,"label":label}))
    }
}

/// Settle unsubmitted interactions when the parent native prompt ends.
fn drain_acp_permissions(
    permissions: &Mutex<HashMap<String, PermissionRequest>>,
    responder: &JsonLineResponder,
) {
    if let Ok(mut pending) = permissions.lock() {
        for (_, request) in pending.drain() {
            // An uncertain response must never be retried with another outcome.
            if request.state.outcome_unknown || request.state.submitting_operation.is_some() { continue; }
            let _ = responder.respond(request.rpc_id, json!({"outcome":{"outcome":"cancelled"}}));
        }
    }
}

/// Return whether this frame may be projected. Delegation approval precedes
/// replay cancellation; every unsupported reverse request is rejected once.
fn handle_acp_message(
    responder: &Mutex<Option<JsonLineResponder>>,
    raw: &Value,
    tool_policy: ChatToolPolicy,
    project_events: bool,
) -> bool {
    let request = raw.get("id").is_some() && raw.get("method").is_some()
        && raw.get("result").is_none() && raw.get("error").is_none();
    if !request { return project_events; }
    let permission = raw["method"] == "session/request_permission";
    if permission && raw.get("params")
        .and_then(|params| acp_scoped_permission_option(params, &tool_policy)).is_some() {
        // Once attempted, do not send a different outcome after a partial write.
        let _ = approve_scoped_threadterm_tool(responder, raw, &tool_policy);
        return false;
    }
    if permission && project_events { return true; }
    if let Ok(slot) = responder.lock() {
        if let Some(responder) = slot.as_ref() {
            let id = raw["id"].clone();
            let result = if permission {
                responder.respond(id, json!({"outcome":{"outcome":"cancelled"}}))
            } else {
                responder.reject(id, -32601, "Method not found")
            };
            if let Err(error) = result { eprintln!("[acp] reverse response failed: {}", error.message); }
        }
    }
    false
}

#[allow(clippy::too_many_arguments)]
fn emit_acp_message(
    events: &ScopedProviderEvents,
    provider: &str,
    session_id: &str,
    native: &Mutex<Option<String>>,
    active_turn: &Mutex<Option<String>>,
    permissions: &Mutex<HashMap<String, PermissionRequest>>,
    think_open: &Mutex<bool>,
    ui: &Mutex<AcpUiState>,
    mut raw: Value,
) {
    let bound_native = native.lock().ok().and_then(|value| value.clone());
    let activity_scope=raw.pointer("/params/sessionId").and_then(Value::as_str).or(bound_native.as_deref()).unwrap_or_default().to_owned();
    if let Some(update)=raw.pointer_mut("/params/update") {
        let context=super::browser_activity::Context {session:Some(session_id),worker:Some(&events.worker_token),scope:&activity_scope};
        ui.lock().unwrap_or_else(|p|p.into_inner()).browser_activity.acp(update,&context);
    }
    let foreign = raw.pointer("/params/sessionId").and_then(Value::as_str)
        .is_some_and(|event_session| bound_native.as_deref().is_some_and(|parent| parent != event_session));
    let permission = raw["method"] == "session/request_permission"
        && raw.get("id").is_some() && raw.get("result").is_none() && raw.get("error").is_none();
    if foreign && !permission {
        #[cfg(debug_assertions)]
        eprintln!("[acp debug] {provider}: dropping foreign frame");
        return;
    }
    // A child interaction belongs to the parent UI, never to its native binding.
    let native_id = bound_native.or_else(|| raw
        .get("params")
        .and_then(|p| p.get("sessionId"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned));
    let method = raw
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("provider.event");
    let params = raw.get("params").cloned().unwrap_or_else(|| raw.clone());
    let turn_id = if foreign {
        active_turn.lock().ok().and_then(|value| value.clone())
    } else { params
        .get("turnId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| active_turn.lock().ok().and_then(|value| value.clone())) };
    let active = active_turn.lock().ok().and_then(|value| value.clone());
    if let Ok(mut state) = ui.lock() {
        state.text_segments.sync_turn(active.as_deref());
    }
    if permission {
        let rpc_id = raw.get("id").cloned().unwrap_or(Value::Null);
        // Keep publication serialized with terminal drainage and submission.
        // A late request must settle without creating an unanswerable card.
        let Ok(active) = active_turn.lock() else { return; };
        let turn_id = active.clone();
        if turn_id.is_none() {
            if let Some(responder) = ui.lock().ok().and_then(|state| state.permission_responder.clone()) {
                let _ = responder.respond(rpc_id, json!({"outcome":{"outcome":"cancelled"}}));
            }
            return;
        }
        let approval_id = encode_approval_id(&rpc_id);
        let options = params
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let choices = acp_choices(&options);
        let question_data = kimi_question_payload(provider, &params, &options);
        let plan = kimi_plan_text(provider, &params, &options);
        if let Ok(mut values) = permissions.lock() {
            values.insert(
                approval_id.clone(),
                PermissionRequest {
                    rpc_id,
                    turn_id: turn_id.clone(),
                    choices: choices.clone(),
                    question_data: question_data.clone(),
                    plan: plan.is_some(),
                    state: PendingApprovalState::default(),
                },
            );
        }
        let card_choices = if plan.is_some() { &[][..] } else { &choices[..] };
        let mut payload = approval_payload(
            &approval_id,
            provider,
            "session/request_permission",
            &acp_title(&params),
            &params,
            card_choices,
            turn_id.as_deref(),
            !choices.is_empty(),
        );
        if let Some(question_data) = question_data {
            payload["interaction"] = json!("question");
            payload["answerable"] = json!(true);
            payload["form"] = question_data["form"].clone();
        }
        if let Some(plan) = plan {
            payload["interaction"] = json!("plan");
            payload["title"] = json!("Plan review");
            payload["plan"] = json!(plan);
        }
        if foreign {
            payload["subagent"] = json!({"label":"Subagent"});
        } else if let Some(subagent) = ui
            .lock()
            .ok()
            .and_then(|state| acp_permission_subagent(&params, &state))
        {
            payload["subagent"] = subagent;
        }
        if let Ok(mut state) = ui.lock() {
            state.text_segments.sync_turn(turn_id.as_deref());
            state.text_segments.advance(turn_id.as_deref());
        }
        emit(
            events,
            provider,
            session_id,
            native_id.as_deref(),
            turn_id.as_deref(),
            "chat.approval",
            json!({
                "approvalId":approval_id,
                "request":params,
                "choices":card_choices,
                "part":{"type":"approval","approvalId":approval_id,"status":"pending","data":payload}
            }),
        );
        return;
    }
    let update = params.get("update").unwrap_or(&params);
    let kind = update
        .get("sessionUpdate")
        .or_else(|| update.get("type"))
        .and_then(Value::as_str)
        .unwrap_or(method);
    if kind.contains("command")
        || kind.contains("config")
        || kind.contains("Config")
        || kind.contains("Command")
        || kind.contains("mode")
        || kind.contains("Mode")
    {
        if let Ok(mut state) = ui.lock() {
            merge_acp_ui(&mut state, update);
            merge_acp_ui(&mut state, &params);
            if [update, &params].iter().any(|value| {
                value.get("configOptions").is_some()
                    || value.get("availableConfigOptions").is_some()
                    || value.get("configOption").is_some()
                    || value.get("option").is_some()
            }) {
                state.config_generation = state.config_generation.wrapping_add(1);
            }
        }
        emit_chat_ui(events, provider, session_id, native_id.as_deref(), ui);
    }
    if kind == "plan" {
        // ACP plan updates carry `entries` and no text; they used to fall through
        // to provider.event and were dropped from the transcript.
        if let Some(data) = acp_plan_data(update) {
            emit(
                events,
                provider,
                session_id,
                native_id.as_deref(),
                turn_id.as_deref(),
                "chat.item",
                json!({"merge":true,"part":crate::chat_plan::plan_part(data, turn_id.as_deref())}),
            );
        }
        return;
    }
    if matches!(kind, "usage_update" | "usageUpdate") {
        // Context pressure arrives as its own session update for agents that
        // implement the ACP usage extension; nothing is polled.
        if let Some(usage) = context_usage_from_update(update) {
            emit(
                events,
                provider,
                session_id,
                native_id.as_deref(),
                turn_id.as_deref(),
                "chat.context",
                json!({"usage":usage}),
            );
        }
        return;
    }
    let text = update
        .get("content")
        .and_then(|c| c.get("text"))
        .and_then(Value::as_str)
        .or_else(|| update.get("text").and_then(Value::as_str));
    if let Some(text) = text.filter(|value| !value.is_empty()) {
        if acp_part_type(kind) == Some("thinking") {
            if let Ok(mut open) = think_open.lock() {
                *open = false;
            }
            emit_chat_delta(
                events,
                provider,
                session_id,
                native_id.as_deref(),
                turn_id.as_deref(),
                "thinking",
                text,
                &raw,
                ui,
            );
            return;
        }
        if acp_part_type(kind) == Some("text") {
            if provider == "kimi" {
                if let Ok(mut state) = ui.lock() {
                    if let Some(reply) = state
                        .usage_reply
                        .as_mut()
                        .filter(|reply| Some(reply.turn_id.as_str()) == turn_id.as_deref())
                    {
                        reply.text.push_str(text);
                        return;
                    }
                }
                if let Ok(mut open) = think_open.lock() {
                    for (part_type, piece) in split_kimi_think_stream(&mut open, text) {
                        emit_chat_delta(
                            events,
                            provider,
                            session_id,
                            native_id.as_deref(),
                            turn_id.as_deref(),
                            part_type,
                            &piece,
                            &raw,
                            ui,
                        );
                    }
                    return;
                }
            }
            emit_chat_delta(
                events,
                provider,
                session_id,
                native_id.as_deref(),
                turn_id.as_deref(),
                "text",
                text,
                &raw,
                ui,
            );
            return;
        }
    }
    let event_kind = if kind.contains("tool_call") || kind.contains("toolCall") {
        "chat.item"
    } else {
        "provider.event"
    };
    if event_kind == "chat.item" {
        if let Ok(mut state) = ui.lock() {
            state.text_segments.advance(turn_id.as_deref());
        }
        let subagent = ui.lock().ok().and_then(|mut state| {
            let (key, info) = acp_subagent_update(provider, update, &mut state.subagent_calls)?;
            let retract = state.parent_tool_calls.remove(&key);
            Some((key, info, retract))
        });
        if let Some((key, info, retract)) = subagent {
            if retract {
                // Replace the previously projected tool snapshot, using its native id.
                emit(events, provider, session_id, native_id.as_deref(), turn_id.as_deref(),
                    "chat.item", json!({"item":{"id":key},"parts":[]}));
            }
            emit(events, provider, session_id, native_id.as_deref(), turn_id.as_deref(),
                "chat.subagent", json!({"key":key,"info":info}));
            return;
        }
    }
    emit(
        events,
        provider,
        session_id,
        native_id.as_deref(),
        turn_id.as_deref(),
        event_kind,
        json!({"raw":raw}),
    );
    if event_kind == "chat.item" {
        if let Some((tool_id, part)) = acp_tool_part(update, kind) {
            if let Ok(mut state) = ui.lock() {
                state.parent_tool_calls.insert(tool_id.clone());
            }
            emit(
                events,
                provider,
                session_id,
                native_id.as_deref(),
                turn_id.as_deref(),
                "chat.item",
                json!({"item":{"id":tool_id},"merge":true,"part":part}),
            );
        }
    }
}

fn kimi_question_payload(provider: &str, params: &Value, options: &[Value]) -> Option<Value> {
    if provider != "kimi" {
        return None;
    }
    let mut labels = Vec::new();
    let mut ids = HashSet::new();
    let mut skip_count = 0;
    for option in options {
        let id = option.get("optionId")?.as_str()?;
        if !ids.insert(id) {
            return None;
        }
        if id == "q0_skip" {
            skip_count += 1;
            continue;
        }
        let suffix = id.strip_prefix("q0_opt_")?;
        if suffix.is_empty() || !suffix.chars().all(|character| character.is_ascii_digit()) {
            return None;
        }
        let label = option.get("name").and_then(Value::as_str)?;
        if label.trim().is_empty() || labels.iter().any(|existing: &String| existing == label) {
            return None;
        }
        labels.push(label.to_owned());
    }
    if labels.is_empty() || skip_count != 1 {
        return None;
    }
    // Kimi's bridge (acp-server handleQuestion) titles the call "AskUserQuestion" and carries the question text
    // as the first text content block; the rawInput fallbacks cover other shapes.
    let question = params.pointer("/toolCall/content/0/content/text")
        .filter(|value| value.as_str().is_some_and(|text| !text.trim().is_empty()))
        .or_else(|| params.pointer("/toolCall/rawInput/question"))
        .or_else(|| params.pointer("/toolCall/rawInput/questions/0/question"))
        .or_else(|| params.pointer("/rawInput/question"))
        .or_else(|| params.pointer("/rawInput/questions/0/question"))
        .or_else(|| params.pointer("/toolCall/rawInput"))
        .or_else(|| params.get("rawInput"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| params.pointer("/toolCall/title").and_then(Value::as_str))
        .or_else(|| params.get("title").and_then(Value::as_str))?;
    Some(json!({"interaction":"question","answerable":true,"form":{"kind":"questions","questions":[{
        "id":"q0","question":question,"options":labels.into_iter().map(|label| json!({"label":label})).collect::<Vec<_>>(),
        "multiSelect":false,"allowOther":false,"secret":false
    }]}}))
}

/// Kimi 2.0 ends plan mode with a permission request offering exactly
/// `plan_approve` / `plan_revise` / `plan_reject_and_exit`; its first text block
/// is the plan, after an optional "Plan saved to: <path>" line. A review with
/// alternative approaches (`plan_opt_<i>`) keeps the generic choice card.
fn kimi_plan_text(provider: &str, params: &Value, options: &[Value]) -> Option<String> {
    if provider != "kimi" {
        return None;
    }
    let mut ids: Vec<&str> = options.iter().filter_map(|option| option.get("optionId")?.as_str()).collect();
    ids.sort_unstable();
    if ids != ["plan_approve", "plan_reject_and_exit", "plan_revise"] {
        return None;
    }
    let text = params.pointer("/toolCall/content")?.as_array()?.iter()
        .filter_map(|block| block.pointer("/content/text")?.as_str())
        .find(|text| !text.starts_with("Requesting approval to "))?;
    let plan = match text.strip_prefix("Plan saved to: ").and_then(|rest| rest.split_once("\n\n")) {
        Some((_, plan)) => plan,
        None => text,
    };
    (!plan.trim().is_empty()).then(|| plan.trim_end().to_owned())
}

fn kimi_question_choice(
    choices: &[ApprovalChoice],
    response: &Value,
) -> Result<(String, &'static str), ProviderError> {
    match response.get("action").and_then(Value::as_str) {
        Some("dismiss") => Ok((find_choice(choices, "q0_skip")?.choice_id.clone(), "dismissed")),
        Some("submit") => {
            let label = response.pointer("/values/q0/0").and_then(Value::as_str).ok_or_else(|| {
                ProviderError::new("answer_invalid", "Kimi question needs one selected option")
            })?;
            let choice = choices.iter().find(|choice| {
                choice.choice_id.starts_with("q0_opt_") && choice.label == label
            }).ok_or_else(|| ProviderError::new("answer_invalid", "Kimi answer is not an offered option"))?;
            Ok((choice.choice_id.clone(), "answered"))
        }
        _ => Err(ProviderError::new("answer_invalid", "Expected submit or dismiss")),
    }
}

fn acp_subagent_update(
    provider: &str,
    update: &Value,
    calls: &mut HashMap<String, Value>,
) -> Option<(String, Value)> {
    let key = update.get("toolCallId").and_then(Value::as_str)?;
    let input = update.get("rawInput").unwrap_or(&Value::Null);
    let title_agent = (provider == "kimi")
        .then(|| {
            let title = update.get("title")?.as_str()?.strip_prefix("Launching ")?;
            let (agent_type, description) = title.split_once(" agent: ")?;
            (!agent_type.is_empty()
                && !agent_type.chars().any(char::is_whitespace)
                && !description.is_empty()
                && !description.contains(['\n', '\r']))
            .then_some((agent_type, description))
        })
        .flatten();
    let agent_type = input
        .get("subagent_type")
        .and_then(Value::as_str)
        .or_else(|| title_agent.map(|(agent_type, _)| agent_type));
    let kimi_agent = provider == "kimi" && update.get("title").and_then(Value::as_str) == Some("Agent");
    if !calls.contains_key(key) && input.get("subagent_type").is_none() && title_agent.is_none() && !kimi_agent {
        return None;
    }
    let info = calls
        .entry(key.to_owned())
        .or_insert_with(|| json!({"provider":provider,"status":"running","transcript":"none"}));
    if let Some(agent_type) = agent_type {
        info["agentType"] = json!(agent_type);
    }
    for field in ["description", "prompt"] {
        if let Some(value) = input.get(field).filter(|value| value.is_string()) {
            info[field] = value.clone();
        }
    }
    if info.get("description").and_then(Value::as_str).is_none_or(str::is_empty) {
        if let Some((_, description)) = title_agent {
            info["description"] = json!(description);
        }
    }
    let result = acp_subagent_result_text(update);
    if provider == "kimi" && !result.is_empty() {
        let patch = kimi_subagent_result(&result);
        for (field, value) in patch.as_object().into_iter().flatten() {
            info[field] = value.clone();
        }
    }
    match update.get("status").and_then(Value::as_str) {
        Some("failed" | "error") => info["status"] = json!("failed"),
        Some("completed" | "complete" | "success") if info["status"] == "running" => {
            info["status"] = json!("completed");
        }
        _ => {}
    }
    if !result.is_empty() && info.get("summary").is_none() {
        info["summary"] = json!(result);
    }
    crate::db::bound_json(info);
    Some((key.to_owned(), info.clone()))
}

fn acp_subagent_result_text(update: &Value) -> String {
    if let Some(output) = update.get("rawOutput") {
        if let Some(text) = output
            .as_str()
            .or_else(|| output.get("text").and_then(Value::as_str))
        {
            if !text.is_empty() {
                return text.to_owned();
            }
        }
    }
    update
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.pointer("/content/text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn kimi_subagent_result(text: &str) -> Value {
    let mut info = json!({});
    let (header, summary) = text
        .split_once("[summary]")
        .map(|(h, s)| (h, Some(s.trim())))
        .unwrap_or((text, None));
    let mut status = None;
    let mut stop_reason = None;
    for line in header.lines() {
        let Some((field, value)) = line.trim().split_once(':') else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match field {
            "agent_id" => {
                info["native"] = json!({"kind":"kimi-agent","id":value});
                info["transcript"] = json!("native");
            }
            "actual_subagent_type" => info["agentType"] = json!(value),
            "status" => status = Some(value),
            "stop_reason" => stop_reason = Some(value),
            _ => {}
        }
    }
    if let Some(status) = status.or(stop_reason) {
        info["status"] = json!(match status {
            "completed" | "complete" | "success" => "completed",
            "failed" | "error" => "failed",
            "cancelled" | "canceled" | "stopped" | "interrupted" | "killed" => "cancelled",
            "pending" | "running" | "in_progress" => "running",
            _ => "unknown",
        });
    }
    if let Some(summary) = summary {
        info["summary"] = json!(summary);
    }
    info
}

fn kimi_subagent_transcript(
    home: &std::path::Path,
    session: &NativeSessionRef,
    info: &Value,
) -> Result<Vec<Value>, ProviderError> {
    use std::io::{Read, Seek, SeekFrom};
    let agent_id = info
        .pointer("/native/id")
        .and_then(Value::as_str)
        .filter(|_| info.pointer("/native/kind").and_then(Value::as_str) == Some("kimi-agent"))
        .ok_or_else(|| ProviderError::new("invalid_native_id", "Kimi agent id is unavailable"))?;
    for id in [session.native_id.as_str(), agent_id] {
        if id.is_empty()
            || id.len() > 512
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_".contains(c))
        {
            return Err(ProviderError::new(
                "invalid_native_id",
                "Invalid Kimi transcript identity",
            ));
        }
    }
    let io_error =
        |error: std::io::Error| ProviderError::new("history_unavailable", error.to_string());
    let sessions = home.join("sessions");
    let root = sessions.canonicalize().map_err(io_error)?;
    for entry in std::fs::read_dir(&sessions).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let path = entry
            .path()
            .join(&session.native_id)
            .join("agents")
            .join(agent_id)
            .join("wire.jsonl");
        if !path.is_file() {
            continue;
        }
        let path = path.canonicalize().map_err(io_error)?;
        if !path.starts_with(&root) {
            return Err(ProviderError::new(
                "history_unavailable",
                "Kimi transcript is outside its session directory",
            ));
        }
        let mut file = std::fs::File::open(path).map_err(io_error)?;
        const LIMIT: u64 = 4 * 1024 * 1024;
        let start = file
            .metadata()
            .map_err(io_error)?
            .len()
            .saturating_sub(LIMIT);
        file.seek(SeekFrom::Start(start)).map_err(io_error)?;
        let mut bytes = Vec::new();
        file.take(LIMIT).read_to_end(&mut bytes).map_err(io_error)?;
        let tail = if start > 0 {
            bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|end| &bytes[end + 1..])
                .unwrap_or(&[])
        } else {
            &bytes
        };
        return Ok(kimi_wire_transcript(tail));
    }
    Err(ProviderError::new(
        "history_unavailable",
        "Kimi subagent transcript was not found",
    ))
}

fn kimi_wire_transcript(bytes: &[u8]) -> Vec<Value> {
    let mut items: Vec<Value> = Vec::new();
    let mut browser_activity=super::browser_activity::BrowserActivityTracker::default();
    let mut prompt_seen = false;
    for (index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
        let Ok(record) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let source_event = if record["type"] == "context.append_loop_event" {
            record.get("event").unwrap_or(&record)
        } else {
            &record
        };
        let mut safe_event=source_event.clone();
        browser_activity.kimi(&mut safe_event,&super::browser_activity::Context {session:None,worker:None,scope:""});
        let event=&safe_event;
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut role = "assistant";
        let mut id = format!("kimi-wire-{index}");
        let part = match kind {
            "turn.prompt" if !prompt_seen => {
                prompt_seen = true;
                role = "user";
                let text = record
                    .get("input")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|part| part["type"] == "text")
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n");
                json!({"type":"text","text":text})
            }
            "content.part" => {
                let part = &event["part"];
                match part["type"].as_str() {
                    Some("text") => {
                        json!({"type":"text","text":part["text"].as_str().unwrap_or_default()})
                    }
                    Some("think") => {
                        json!({"type":"thinking","text":part["think"].as_str().unwrap_or_default()})
                    }
                    _ => continue,
                }
            }
            "tool.call" | "tool.result" => {
                let Some(tool_id) = event.get("toolCallId").and_then(Value::as_str) else {
                    continue;
                };
                role = "tool";
                id = format!("kimi-tool-{tool_id}");
                if kind == "tool.call" {
                    if event["resultRedacted"]==true {json!({"type":"tool","toolId":tool_id,"toolName":event["name"],"status":"running","data":event})}else{
                    json!({"type":"tool","toolId":tool_id,"toolName":event["name"],"status":"running",
                        "data":{"args":event["args"],"display":event["display"]}})
                    }
                } else {
                    let status = if event.pointer("/result/isError").and_then(Value::as_bool)
                        == Some(true) || event.pointer("/browserActivity/outcome").and_then(Value::as_str) == Some("failed")
                    {
                        "failed"
                    } else {
                        "complete"
                    };
                    let output = event
                        .pointer("/result/output")
                        .cloned()
                        .unwrap_or(Value::Null);
                    if let Some(item) = items.iter_mut().find(|item| item["id"] == id) {
                        let part = &mut item["parts"][0];
                        part["status"] = json!(status);
                        if event["resultRedacted"]==true {part["data"]=event.clone();}else{part["data"]["output"] = output;}
                        crate::db::bound_json(item);
                        continue;
                    }
                    if event["resultRedacted"]==true {json!({"type":"tool","toolId":tool_id,"toolName":event["name"],"status":status,"data":event})}else{json!({"type":"tool","toolId":tool_id,"status":status,"data":{"output":output}})}
                }
            }
            "turn.ended" if event["reason"] == "failed" => {
                let text = event
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .or_else(|| event.get("error").and_then(Value::as_str))
                    .unwrap_or("Kimi subagent failed");
                json!({"type":"error","text":text})
            }
            _ => continue,
        };
        let created = record
            .get("time")
            .and_then(Value::as_i64)
            .and_then(chrono::DateTime::<Utc>::from_timestamp_millis)
            .map(|time| time.to_rfc3339())
            .unwrap_or_else(|| Utc::now().to_rfc3339());
        let mut item = json!({"id":id,"role":role,"parts":[part],"createdAt":created});
        crate::db::bound_json(&mut item);
        items.push(item);
        if items.len() > 500 {
            items.remove(0);
        }
    }
    items
}

fn acp_tool_part(update: &Value, kind: &str) -> Option<(String, Value)> {
    if !kind.contains("tool_call") && !kind.contains("toolCall") {
        return None;
    }
    let tool_id = update.get("toolCallId").and_then(Value::as_str)?.to_owned();
    let status = match update.get("status").and_then(Value::as_str) {
        Some("completed" | "complete" | "success") => "complete",
        Some("failed" | "error") => "failed",
        Some("pending" | "in_progress" | "running") | None if kind == "tool_call" => "running",
        Some("pending" | "in_progress" | "running") => "running",
        Some(other) => other,
        None => "complete",
    };
    let mut part = json!({"type":"tool","toolId":tool_id,"status":status,"data":update});
    if let Some(title) = update.get("title").and_then(Value::as_str) {
        part["toolName"] = json!(title);
    }
    crate::file_references::enrich_tool_part(&mut part, None);
    Some((tool_id, part))
}

fn acp_part_type(kind: &str) -> Option<&'static str> {
    match kind {
        "agent_thought_chunk" | "agentThoughtChunk" => Some("thinking"),
        "agent_message_chunk" | "agentMessageChunk" | "message" => Some("text"),
        _ => None,
    }
}

/// ACP `sessionUpdate:"plan"` entries. Kimi and Gemini send the whole list;
/// `priority` is optional. A malformed nonempty list is ignored; only an
/// explicitly empty native list produces the clearing snapshot.
fn acp_plan_data(update: &Value) -> Option<Value> {
    let entries = update.get("entries").and_then(Value::as_array)?;
    let entries = entries.iter().map(|entry| {
        let content = entry.get("content").and_then(Value::as_str).unwrap_or_default().to_owned();
        let status = entry
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("pending")
            .to_owned();
        let priority = entry
            .get("priority")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        (content, status, priority)
    });
    let explanation = update.get("explanation").and_then(Value::as_str);
    crate::chat_plan::plan_data(entries, explanation)
}

#[allow(clippy::too_many_arguments)]
fn emit_chat_delta(
    events: &ScopedProviderEvents,
    provider: &str,
    session_id: &str,
    native_id: Option<&str>,
    turn_id: Option<&str>,
    part_type: &str,
    text: &str,
    raw: &Value,
    ui: &Mutex<AcpUiState>,
) {
    let mut data = json!({"part":{"type":part_type,"text":text,"status":"streaming"},"raw":raw});
    if let Some(id) = ui.lock().ok().and_then(|state| state.text_segments.item_id(turn_id)) {
        data["item"] = json!({"id":id});
    }
    emit(
        events,
        provider,
        session_id,
        native_id,
        turn_id,
        "chat.delta",
        data,
    );
}

fn split_kimi_think_stream(in_think: &mut bool, chunk: &str) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    let mut rest = chunk;
    loop {
        if *in_think {
            if let Some(end) = rest.find("</think>") {
                if end > 0 {
                    out.push(("thinking", rest[..end].to_string()));
                }
                *in_think = false;
                rest = &rest[end + "</think>".len()..];
                continue;
            }
            if !rest.is_empty() {
                out.push(("thinking", rest.to_string()));
            }
            break;
        }
        if let Some(start) = rest.find("<think>") {
            if start > 0 {
                out.push(("text", rest[..start].to_string()));
            }
            *in_think = true;
            rest = &rest[start + "<think>".len()..];
            continue;
        }
        if !rest.is_empty() {
            out.push(("text", rest.to_string()));
        }
        break;
    }
    out.into_iter()
        .filter(|(_, text)| !text.is_empty())
        .collect()
}

/// How long Request changes waits for Kimi to stop the planning turn before
/// the feedback can go out as the next prompt.
const KIMI_REVISE_STOP_WAIT: Duration = Duration::from_secs(15);

/// Locally handled kimi commands, merged into the slash menu alongside the
/// agent's ACP-advertised commands.
const KIMI_LOCAL_SLASH_COMMANDS: &[(&str, &str)] = &[
    ("model", "Switch model"),
    ("thinking", "Switch thinking level"),
    ("mode", "Switch permission mode"),
    ("plan", "Toggle plan mode"),
    ("yolo", "Switch to YOLO mode"),
    ("auto", "Switch to auto mode"),
    ("fork", "Fork this session"),
    ("logout", "Log out of the Kimi account"),
    ("version", "Show the Kimi CLI version"),
    ("init", "Generate AGENTS.md for this project"),
    ("export-debug-zip", "Export this session as a debug ZIP"),
];

fn merge_local_commands(provider: &str, mut commands: Vec<Value>) -> Vec<Value> {
    if provider == "kimi" {
        for (name, description) in KIMI_LOCAL_SLASH_COMMANDS {
            if !commands
                .iter()
                .any(|command| command.get("name").and_then(Value::as_str) == Some(name))
            {
                commands.push(json!({"name":name,"description":description}));
            }
        }
    }
    commands
}

/// The verbatim prompt the kimi TUI's `/init` runs (kimi 0.42.0
/// `sessionInit/profile/init.md`); ACP has no builtin for it.
const KIMI_INIT_PROMPT: &str = "You are a software engineering expert with many years of programming experience. Please explore the current project directory to understand the project's architecture and main details.\n\nTask requirements:\n1. Analyze the project structure and identify key configuration files (such as pyproject.toml, package.json, Cargo.toml, etc.).\n2. Understand the project's technology stack, build process and runtime architecture.\n3. Identify how the code is organized and main module divisions.\n4. Discover project-specific development conventions, testing strategies, and deployment processes.\n\nAfter the exploration, do a thorough summary of your findings and write it to the `AGENTS.md` file in the project root, replacing the file's previous content. If the file already exists, read it first and carry forward whatever is still accurate — the result should be one coherent, up-to-date file, not an append.\n\nFor your information, `AGENTS.md` is a file intended to be read by AI coding agents. Expect the reader of this file to know nothing about the project.\n\nYou should compose this file according to the actual project content. Do not make any assumptions or generalizations. Ensure the information is accurate and useful. You must use the natural language that is mainly used in the project's comments and documentation.\n\nPopular sections that people usually write in `AGENTS.md` are:\n\n- Project overview\n- Build and test commands\n- Code style guidelines\n- Testing instructions\n- Security considerations\n";

fn parse_slash(text: &str) -> Option<(&str, &str)> {
    let rest = text.trim().strip_prefix('/')?;
    if rest.is_empty() || rest.starts_with('/') {
        return None;
    }
    match rest.split_once(char::is_whitespace) {
        Some((name, args)) => Some((name, args.trim())),
        None => Some((rest, "")),
    }
}

/// Match a user-typed option value against the ACP choices: exact value,
/// case-insensitive value, case-insensitive display name, then substring.
fn match_choice(choices: &[Value], query: &str) -> Option<(String, String)> {
    let entries: Vec<(String, String)> = choices
        .iter()
        .filter_map(|choice| {
            let value = choice.get("value").and_then(Value::as_str)?;
            let name = choice.get("name").and_then(Value::as_str).unwrap_or(value);
            Some((value.to_owned(), name.to_owned()))
        })
        .collect();
    entries
        .iter()
        .find(|(value, _)| value == query)
        .or_else(|| {
            entries
                .iter()
                .find(|(value, _)| value.eq_ignore_ascii_case(query))
        })
        .or_else(|| {
            entries
                .iter()
                .find(|(_, name)| name.eq_ignore_ascii_case(query))
        })
        .or_else(|| {
            let query = query.to_ascii_lowercase();
            entries.iter().find(|(value, name)| {
                value.to_ascii_lowercase().contains(&query)
                    || name.to_ascii_lowercase().contains(&query)
            })
        })
        .cloned()
}

fn format_option_listing(title: &str, option: &Value, choices: &[Value]) -> String {
    let current = option.get("value").and_then(Value::as_str).unwrap_or("");
    let current_name = choices
        .iter()
        .find(|choice| choice.get("value").and_then(Value::as_str) == Some(current))
        .and_then(|choice| choice.get("name"))
        .and_then(Value::as_str);
    let mut lines = vec![match current_name {
        Some(name) => format!("{title}: {name} ({current})"),
        None => format!("{title}: {current}"),
    }];
    if !choices.is_empty() {
        lines.push("Choices:".to_owned());
        for choice in choices {
            let value = choice.get("value").and_then(Value::as_str).unwrap_or("");
            let name = choice.get("name").and_then(Value::as_str).unwrap_or(value);
            lines.push(format!("  {value} — {name}"));
        }
    }
    lines.join("\n")
}

/// TUI-only commands with no ACP backing: point at the ThreadTerm surface or
/// CLI flow that covers them instead of showing "Unknown ACP command".
fn kimi_command_guidance(name: &str) -> Option<&'static str> {
    Some(match name {
        "login" => "Sign in from ThreadTerm's provider setup, or run `kimi login` in a terminal.",
        "new" | "clear" => {
            "Start a fresh chat from ThreadTerm's session list; each chat keeps its own context."
        }
        "sessions" | "resume" => "Browse and resume Kimi sessions from ThreadTerm's history rail.",
        "title" | "rename" => "Rename this session from ThreadTerm's session menu.",
        "undo" => "Undo is only available in the Kimi TUI; ask the agent to revert specific changes instead.",
        "reload" | "reload-tui" => "Reopen this chat to apply config.toml / tui.toml changes.",
        "theme" => "Kimi TUI themes don't apply here — pick a theme in ThreadTerm settings.",
        "settings" | "config" => {
            "Open ThreadTerm settings. To edit Kimi's own config, use /update-config."
        }
        "experiments" | "experimental" => "Experimental flags are only available in the Kimi TUI.",
        "editor" => "External editor settings only apply to the Kimi TUI.",
        "provider" => "Manage providers from ThreadTerm's provider setup, or run `kimi provider` in a terminal.",
        "plugins" => "Manage plugins in the Kimi TUI.",
        "feedback" | "bug" => "Report issues at https://kimi.com/code/feedback.",
        "copy" => "Copy message text directly from the chat view.",
        "add-dir" => "Add extra workspaces from ThreadTerm's project list.",
        "web" => "Run `kimi web` in a terminal to open the web UI.",
        "exit" | "quit" | "q" => "Close the window, or stop this session from ThreadTerm.",
        "btw" => "Side conversations aren't available over ACP; open another chat session in ThreadTerm instead.",
        "swarm" => "Swarm mode is only available in the Kimi TUI.",
        "goal" => "Goal mode is only available in the Kimi TUI.",
        "secondary-model" | "subagent-model" => {
            "Pick the subagent model in the Kimi TUI or via [secondary_model] in config.toml."
        }
        "export" | "export-md" => {
            "Markdown export is only available in the Kimi TUI; use /export-debug-zip here for a ZIP export."
        }
        _ => return None,
    })
}

fn emit_chat_ui(
    events: &ScopedProviderEvents,
    provider: &str,
    session_id: &str,
    native_id: Option<&str>,
    ui: &Mutex<AcpUiState>,
) {
    let mut state = ui.lock().ok();
    let data = state
        .as_ref()
        .map(|value| {
            let mut wire = value.wire(provider);
            wire["sessionId"] = json!(session_id);
            wire
        })
        .unwrap_or_else(|| json!({"sessionId":session_id,"options":[],"commands":[]}));
    // ACP agents push config/command updates on a heartbeat; re-emitting an
    // unchanged payload would flood the outbox and re-render every chat view.
    let signature = data.to_string();
    if let Some(state) = state.as_mut() {
        if state.last_emitted.as_deref() == Some(signature.as_str()) {
            return;
        }
        state.last_emitted = Some(signature);
    }
    emit(
        events, provider, session_id, native_id, None, "chat.ui", data,
    );
}

fn wait_for_acp_option(ui: &Mutex<AcpUiState>, option_id: &str, value: &str) -> Result<(), ProviderError> {
    for _ in 0..6 {
        if ui.lock().ok().is_some_and(|state| state.options.iter().find(|option| option.get("id").and_then(Value::as_str) == Some(option_id))
            .and_then(|option| option.get("value").and_then(Value::as_str)) == Some(value)) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    // The setter completed; distinguish missing confirmation from an RPC rejection.
    Err(ProviderError::new("provider_protocol", format!("ACP did not confirm permission mode {option_id}={value}"))
        .with_details(json!({"permissionUnconfirmed":true})))
}

fn kimi_mode_already_active(error: &ProviderError, requested: &str) -> bool {
    let details = error.details.as_ref();
    details.and_then(|details| details.get("code")).and_then(Value::as_i64) == Some(-32603)
        && details
            .and_then(|details| details.pointer("/data/details"))
            .and_then(Value::as_str)
            .is_some_and(|detail| detail.eq_ignore_ascii_case(&format!("Already in {requested} mode")))
}

/// A plan approval is a user-approved native transition from Kimi's plan
/// mode. Mark only that live transition, never startup restoration.
fn emit_permission_mode_confirmed(
    events: &ScopedProviderEvents,
    provider: &str,
    session_id: &str,
    native_id: Option<&str>,
    ui: &Mutex<AcpUiState>,
) {
    let mut data = ui
        .lock()
        .ok()
        .map(|state| state.wire(provider))
        .unwrap_or_else(|| json!({"options":[],"commands":[]}));
    data["permissionChangeConfirmed"] = json!(true);
    emit(events, provider, session_id, native_id, None, "chat.ui", data);
}

fn merge_acp_ui(state: &mut AcpUiState, value: &Value) {
    let mut modern_mode = false;
    if let Some(options) = value
        .get("configOptions")
        .or_else(|| value.get("availableConfigOptions"))
        .and_then(Value::as_array)
    {
        let parsed: Vec<Value> = options.iter().filter_map(parse_acp_option).collect();
        modern_mode = parsed.iter().any(|option| {
            option.get("id").and_then(Value::as_str) == Some("mode")
                && option.get("category").and_then(Value::as_str) == Some("mode")
        });
        if !parsed.is_empty() {
            state.options = parsed;
        }
    }
    if let Some(option) = value.get("configOption").or_else(|| value.get("option")) {
        if let Some(parsed) = parse_acp_option(option) {
            modern_mode |= parsed.get("id").and_then(Value::as_str) == Some("mode")
                && parsed.get("category").and_then(Value::as_str) == Some("mode");
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
    }
    if modern_mode {
        // Kimi advertises its modern category-mode config option together with
        // a compatibility `modes` catalogue. The config option owns mutation.
        state.legacy_mode = false;
        state.modern_mode = true;
    }
    let supplied_modern_mode = modern_mode;
    let modern_mode = modern_mode || state.modern_mode;
    let raw_modes = value.get("modes");
    let available_modes = raw_modes.and_then(|modes| modes.get("availableModes"))
        .or_else(|| value.get("availableModes"))
        .or_else(|| raw_modes.filter(|modes| modes.is_array()))
        .and_then(Value::as_array);
    if let Some(available_modes) = available_modes.filter(|_| !modern_mode) {
        let choices = available_modes.iter().filter_map(|mode| {
            let id = mode.get("modeId").or_else(|| mode.get("id")).or_else(|| mode.get("value")).and_then(Value::as_str)?;
            let name = mode.get("name").or_else(|| mode.get("label")).and_then(Value::as_str).unwrap_or(id);
            Some(json!({"value":id,"name":name}))
        }).collect::<Vec<_>>();
        if !choices.is_empty() {
            let current = value.get("currentModeId").or_else(|| value.get("modeId")).or_else(|| value.get("currentMode"))
                .or_else(|| raw_modes.and_then(|modes| modes.get("currentModeId"))).and_then(Value::as_str)
                .unwrap_or_else(|| choices[0]["value"].as_str().unwrap_or_default());
            let mode = json!({"id":"mode","name":"Mode","value":current,"choices":choices,"category":"mode"});
            if let Some(existing) = state.options.iter_mut().find(|item| item.get("id").and_then(Value::as_str) == Some("mode")) { *existing = mode; } else { state.options.push(mode); }
            state.legacy_mode = true;
        }
    } else if state.legacy_mode || (state.modern_mode && !supplied_modern_mode) {
        if let Some(current) = value.get("currentModeId").or_else(|| value.get("modeId")).or_else(|| value.get("currentMode")).and_then(Value::as_str) {
            if let Some(mode) = state.options.iter_mut().find(|item| item.get("id").and_then(Value::as_str) == Some("mode")) { mode["value"] = json!(current); }
        }
    }
    if let Some(commands) = value
        .get("availableCommands")
        .or_else(|| value.get("commands"))
        .and_then(Value::as_array)
    {
        let parsed: Vec<Value> = commands.iter().filter_map(parse_acp_command).collect();
        if !parsed.is_empty() {
            state.commands = parsed;
        }
    }
}

fn parse_acp_option(value: &Value) -> Option<Value> {
    let id = value
        .get("configId")
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)?;
    let name = value
        .get("name")
        .or_else(|| value.get("title"))
        .and_then(Value::as_str)
        .unwrap_or(id);
    let current = value
        .get("currentValue")
        .or_else(|| value.get("value"))
        .and_then(|item| {
            item.as_str()
                .map(str::to_owned)
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
    Some({
        let boolean = acp_option_is_boolean(value, &choices);
        let mut option = json!({"id":id,"name":name,"value":current,"choices":choices});
        if value.get("category").and_then(Value::as_str).is_some_and(|category| category.eq_ignore_ascii_case("mode")) {
            option["category"] = json!("mode");
        }
        if boolean {
            option["kind"] = json!("boolean");
        }
        option
    })
}

/// ACP advertises booleans as `type:"boolean"`, or as a two-choice list whose
/// values match the renderer's supported On/Off pairs. Native values remain
/// preserved for `session/set_config_option`.
fn acp_option_is_boolean(value: &Value, choices: &[Value]) -> bool {
    if choices.len() != 2 {
        return choices.is_empty() && value.get("type").and_then(Value::as_str) == Some("boolean");
    }
    let first = choices[0].get("value").and_then(Value::as_str);
    let second = choices[1].get("value").and_then(Value::as_str);
    matches!((first, second), (Some(a), Some(b))
        if (a.eq_ignore_ascii_case("on") && b.eq_ignore_ascii_case("off"))
            || (a.eq_ignore_ascii_case("off") && b.eq_ignore_ascii_case("on"))
            || (a.eq_ignore_ascii_case("true") && b.eq_ignore_ascii_case("false"))
            || (a.eq_ignore_ascii_case("false") && b.eq_ignore_ascii_case("true")))
}

fn parse_acp_command(value: &Value) -> Option<Value> {
    let name = value
        .get("name")
        .or_else(|| value.get("command"))
        .and_then(Value::as_str)?;
    let description = value.get("description").and_then(Value::as_str);
    let mut command = json!({"name":name.trim_start_matches('/')});
    if let Some(description) = description {
        command["description"] = json!(description);
    }
    Some(command)
}

fn acp_history_item(provider: &str, row: &Value) -> Option<Value> {
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
        "provider":provider,"nativeId":id,
        "title":row.get("title").or_else(|| row.get("name")).and_then(Value::as_str).unwrap_or("ACP session"),
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

#[cfg(test)]
fn acp_transcript(raw: &[Value]) -> Vec<Value> {
    acp_transcript_for_provider("gemini", raw)
}

fn acp_transcript_for_provider(provider: &str, raw: &[Value]) -> Vec<Value> {
    let mut transcript = Vec::new();
    let mut browser_activity=super::browser_activity::BrowserActivityTracker::default();
    let mut last_message = None;
    let mut subagents = HashMap::new();
    for (index, message) in raw.iter().enumerate() {
        let Some(update) = message.get("params").and_then(|params| params.get("update")) else {
            continue;
        };
        let mut safe_update=update.clone();
        browser_activity.acp(&mut safe_update,&super::browser_activity::Context {session:None,worker:None,scope:message.pointer("/params/sessionId").and_then(Value::as_str).unwrap_or_default()});
        let update=&safe_update;
        let Some(kind) = update
            .get("sessionUpdate")
            .or_else(|| update.get("type"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        if kind.contains("tool_call") || kind.contains("toolCall") {
            if let Some((key, mut info)) = acp_subagent_update(provider, update, &mut subagents) {
                // History snapshots can also discover a spawn after its first tool frame.
                transcript.retain(|item: &Value| item["id"] != format!("acp-tool-{key}"));
                info["key"] = json!(key);
                info["transcript"] = json!("none");
                let part = json!({"type":"subagent","toolId":key,"status":info["status"],"data":info});
                if let Some(item) = transcript.iter_mut().find(|item: &&mut Value| item["id"] == format!("acp-subagent-{key}")) {
                    item["parts"] = json!([part]);
                } else {
                    transcript.push(json!({"id":format!("acp-subagent-{key}"),"role":"assistant","parts":[part],"createdAt":Utc::now().to_rfc3339()}));
                }
                last_message = None;
                continue;
            }
        }
        if let Some((tool_id, part)) = acp_tool_part(update, kind) {
            crate::file_references::upsert_history_tool(
                &mut transcript,
                json!({"id":format!("acp-tool-{tool_id}"),"role":"tool","parts":[part],"createdAt":Utc::now().to_rfc3339()}),
            );
            last_message = None;
            continue;
        }
        if kind == "plan" {
            // ACP history carries the same plan updates; keep the latest list
            // in one part for the current user turn, so later turns cannot
            // overwrite an earlier turn's saved plan.
            if let Some(data) = acp_plan_data(update) {
                let current_turn = transcript
                    .iter()
                    .rev()
                    .find(|item| item.get("role").and_then(Value::as_str) == Some("user"))
                    .and_then(|item| item.get("id").and_then(Value::as_str))
                    .map(ToOwned::to_owned);
                let part = crate::chat_plan::plan_part(data, current_turn.as_deref());
                let tool_id = part.get("toolId").and_then(Value::as_str);
                let mut replaced = false;
                for item in transcript.iter_mut().rev() {
                    let Some(parts) = item.get_mut("parts").and_then(Value::as_array_mut) else {
                        continue;
                    };
                    if let Some(existing) = parts
                        .iter_mut()
                        .find(|candidate| candidate.get("toolId").and_then(Value::as_str) == tool_id)
                    {
                        *existing = part.clone();
                        replaced = true;
                        break;
                    }
                }
                if !replaced {
                    transcript.push(json!({"id":format!("acp-plan-{index}"),"role":"assistant","parts":[part],"createdAt":Utc::now().to_rfc3339()}));
                }
                last_message = None;
                continue;
            }
        }
        let content = update.get("content").unwrap_or(update);
        let Some(text) = content.get("text").and_then(Value::as_str) else {
            continue;
        };
        let part_type = acp_part_type(kind).unwrap_or("text");
        let role = if kind.contains("user") {
            "user"
        } else if kind.contains("thought")
            || kind.contains("Thought")
            || kind.contains("agent")
            || kind.contains("assistant")
        {
            "assistant"
        } else {
            continue;
        };
        let text = if role == "user" {
            strip_acp_system_reminders(text)
        } else {
            text.to_owned()
        };
        if text.is_empty() {
            continue;
        }
        if let Some(existing) = last_message
            .and_then(|entry: usize| transcript.get_mut(entry))
            .filter(|entry| entry.get("role").and_then(Value::as_str) == Some(role))
        {
            append_acp_part(existing, part_type, &text);
        } else {
            transcript.push(json!({"id":format!("acp-{index}"),"role":role,"parts":[{"type":part_type,"text":text}],"createdAt":Utc::now().to_rfc3339()}));
            last_message = Some(transcript.len() - 1);
        }
    }
    transcript
}

fn strip_acp_system_reminders(text: &str) -> String {
    const OPEN: &str = "<system-reminder>";
    const CLOSE: &str = "</system-reminder>";

    let mut result = String::new();
    let mut remainder = text;
    let mut stripped = false;
    while let Some(start) = remainder.find(OPEN) {
        result.push_str(&remainder[..start]);
        let after_open = &remainder[start + OPEN.len()..];
        let Some(end) = after_open.find(CLOSE) else {
            result.push_str(&remainder[start..]);
            return if stripped {
                result.trim().to_owned()
            } else {
                text.to_owned()
            };
        };
        stripped = true;
        remainder = &after_open[end + CLOSE.len()..];
    }
    result.push_str(remainder);
    if stripped {
        result.trim().to_owned()
    } else {
        text.to_owned()
    }
}

fn append_acp_part(item: &mut Value, part_type: &str, text: &str) {
    let Some(parts) = item.get_mut("parts").and_then(Value::as_array_mut) else {
        return;
    };
    if let Some(last) = parts.last_mut().filter(|part| part["type"] == part_type) {
        if let Some(Value::String(existing)) = last.get_mut("text") {
            existing.push_str(text);
            return;
        }
    }
    parts.push(json!({"type":part_type,"text":text}));
}

fn kimi_terminal_cwd(cwd: &str) -> std::borrow::Cow<'_, str> {
    #[cfg(windows)]
    if let Some(std::path::Component::Prefix(prefix)) =
        std::path::Path::new(cwd).components().next()
    {
        match prefix.kind() {
            std::path::Prefix::VerbatimDisk(_) => {
                return std::borrow::Cow::Borrowed(&cwd[4..]);
            }
            std::path::Prefix::VerbatimUNC(_, _) => {
                return std::borrow::Cow::Owned(format!(r"\\{}", &cwd[8..]));
            }
            _ => {}
        }
    }
    std::borrow::Cow::Borrowed(cwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_privacy_acp_nameless_completion_and_history_redact_before_fanout() {
        for provider in ["gemini","kimi"] {
            let (sender,mut receiver)=crate::provider_events::tap_channel(32);
            let events=ScopedProviderEvents::new(sender,"worker");
            let native=Mutex::new(Some("native".into()));
            let active=Mutex::new(Some("turn".into()));
            let permissions=Mutex::new(HashMap::new());
            let ui=Mutex::new(AcpUiState::default());
            let think=Mutex::new(false);
            let frames=vec![
                json!({"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"tool_call","toolCallId":"browser","title":"browser_console_messages","rawInput":{"tabId":"tab"},"status":"in_progress"}}}),
                json!({"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"tool_call_update","toolCallId":"browser","status":"completed","rawOutput":{"content":[{"type":"text","text":"RAW_ACP_CONSOLE_SECRET"},{"type":"image","data":"RAW_ACP_BASE64_SECRET"}]}}}}),
            ];
            for frame in &frames {emit_acp_message(&events,provider,"chat",&native,&active,&permissions,&think,&ui,frame.clone());}
            let observed:Vec<_>=std::iter::from_fn(||receiver.try_recv().ok()).collect();
            assert!(observed.iter().any(|event|event.data.pointer("/part/data/resultRedacted")==Some(&json!(true))));
            let live=serde_json::to_string(&observed.iter().map(|event|&event.data).collect::<Vec<_>>()).unwrap();
            assert!(!live.contains("RAW_ACP"));
            assert!(live.contains("browser_console_messages"));
            let history=serde_json::to_string(&acp_transcript_for_provider(provider,&frames)).unwrap();
            assert!(!history.contains("RAW_ACP"));
            assert!(history.contains("provenanceUnavailable"));
        }
    }

    #[test]
    fn browser_privacy_kimi_wire_history_removes_result_and_retains_failure() {
        let frames=[
            json!({"type":"tool.call","toolCallId":"browser","name":"browser_screenshot","args":{"tabId":"tab"}}),
            json!({"type":"tool.result","toolCallId":"browser","result":{"isError":true,"output":"RAW_KIMI_IMAGE_SECRET"}}),
            json!({"type":"tool.call","toolCallId":"ordinary","name":"read_file","args":{"path":"keep"}}),
            json!({"type":"tool.result","toolCallId":"ordinary","result":{"output":"KEEP_ORDINARY"}}),
        ];
        let wire=frames.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        let history=kimi_wire_transcript(wire.as_bytes());
        assert_eq!(history[0]["parts"][0]["status"],"failed");
        let history=serde_json::to_string(&history).unwrap();
        assert!(!history.contains("RAW_KIMI"));
        assert!(history.contains("browser_screenshot"));
        assert!(history.contains("KEEP_ORDINARY"));
    }

    #[test]
    fn a_granted_feedback_tool_offers_a_note_not_native_steering() {
        let mut state = AcpUiState::default();
        assert!(state.wire("kimi").get("inputCapabilities").is_none());
        state.note_steer = true;
        assert_eq!(state.wire("kimi")["inputCapabilities"], json!({"steer":"note"}));
    }

    #[cfg(windows)]
    fn conformance_response_sink(dir: &std::path::Path) -> (JsonLineProcess, std::path::PathBuf) {
        let log = dir.join("responses.jsonl");
        let log_literal = log.to_string_lossy().replace('\'', "''");
        let script = format!(r#"$ErrorActionPreference='Stop'; Get-ChildItem Env: | Where-Object {{ $_.Name -ieq 'PATH' }} | Remove-Item; if (Get-ChildItem Env: | Where-Object {{ $_.Name -ieq 'PATH' }}) {{ exit 3 }}; while ($null -ne ($line=[Console]::In.ReadLine())) {{ [System.IO.File]::AppendAllText('{log_literal}',$line+"`n"); $frame=ConvertFrom-Json $line; if ($frame.method -eq 'session/prompt') {{ $prompt=$frame.id }}; if ($frame.method -eq 'finish-parent') {{ [Console]::Out.WriteLine('{{"jsonrpc":"2.0","id":'+$prompt+',"result":{{"stopReason":"end_turn"}}}}'); [Console]::Out.Flush() }}; if ($frame.method -eq 'barrier') {{ [Console]::Out.WriteLine('{{"jsonrpc":"2.0","id":'+$frame.id+',"result":{{}}}}'); [Console]::Out.Flush() }} }}"#);
        let powershell = std::path::PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()))
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let spec = CommandSpec::from_path(powershell, vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), script]).unwrap();
        let process = JsonLineProcess::spawn("conformance-acp", &spec, None, &[], EnvelopeStyle::JsonRpc2, Arc::new(|_| {})).unwrap();
        (process, log)
    }

    fn kimi_plan_review(id: &str) -> Value {
        // Live Kimi 2.0.2 ExitPlanMode request.
        json!({"id":id,"method":"session/request_permission","params":{"sessionId":"parent",
            "options":[{"kind":"allow_once","name":"Approve","optionId":"plan_approve"},
                {"kind":"reject_once","name":"Revise","optionId":"plan_revise"},
                {"kind":"reject_once","name":"Reject and Exit","optionId":"plan_reject_and_exit"}],
            "toolCall":{"title":"ExitPlanMode","toolCallId":"0:tool_plan","content":[
                {"type":"content","content":{"type":"text","text":"Plan saved to: C:/Users/me/.kimi-code/sessions/s/plans/plan.md\n\n# Plan: add subtract\n\n1. Edit `src/math.js`.\n"}},
                {"type":"content","content":{"type":"text","text":"Requesting approval to Presenting plan and exiting plan mode"}}]}}})
    }

    #[test]
    fn only_kimis_plain_plan_review_becomes_a_plan() {
        let request = kimi_plan_review("plan");
        let options = request["params"]["options"].as_array().unwrap().clone();
        assert_eq!(kimi_plan_text("kimi", &request["params"], &options).as_deref(), Some("# Plan: add subtract\n\n1. Edit `src/math.js`."));
        assert!(kimi_plan_text("gemini", &request["params"], &options).is_none());
        let mut approaches = options.clone();
        approaches[0] = json!({"kind":"allow_once","name":"A","optionId":"plan_opt_0"});
        assert!(kimi_plan_text("kimi", &request["params"], &approaches).is_none(), "alternative approaches keep their choices");
        let mut bare = request["params"].clone();
        bare["toolCall"]["content"][0]["content"]["text"] = json!("# Plan\n\nStep");
        assert_eq!(kimi_plan_text("kimi", &bare, &options).as_deref(), Some("# Plan\n\nStep"));
    }

    #[cfg(windows)]
    #[test]
    fn kimi_plan_card_answers_with_the_native_plan_options() {
        let dir = tempfile::tempdir().unwrap();
        let (process, log) = conformance_response_sink(dir.path());
        let (sender, mut receiver) = crate::provider_events::tap_channel(64);
        let events = ScopedProviderEvents::new(sender, "worker");
        let native = Mutex::new(Some("parent".to_owned()));
        let ui = Arc::new(Mutex::new(AcpUiState { permission_responder: Some(process.responder()), ..AcpUiState::default() }));
        let mut chat = AcpChat { provider: "kimi".into(), process, session_id: "s".into(), native_id: "parent".into(), events,
            active_turn: Arc::new(Mutex::new(None)), permissions: Arc::new(Mutex::new(HashMap::new())), ui };
        chat.start_prompt("plan it", "turn").unwrap();
        macro_rules! card { ($id:expr) => {{
            emit_acp_message(&chat.events, "kimi", "s", &native, &chat.active_turn, &chat.permissions, &Mutex::new(false), &chat.ui, kimi_plan_review($id));
            std::iter::from_fn(|| receiver.try_recv().ok()).find(|event| event.kind == "chat.approval").expect("plan card")
        }}; }
        let first = card!("first");
        let data = &first.data["part"]["data"];
        assert_eq!((data["interaction"].as_str(), data["title"].as_str()), (Some("plan"), Some("Plan review")));
        assert_eq!(data["plan"], "# Plan: add subtract\n\n1. Edit `src/math.js`.");
        assert_eq!(data["choices"], json!([]));
        assert_eq!(data["submittable"], true);
        assert!(chat.plan_response("turn", "not-a-plan", &json!({"action":"approve"}), "op").is_err());
        assert!(chat.plan_response("turn", &encode_approval_id(&json!("first")), &json!({"action":"request_changes"}), "op").is_err(), "changes need feedback");
        chat.ui.lock().unwrap().options.push(json!({"id":"mode","name":"Mode","value":"plan","choices":[]}));
        assert_eq!(chat.plan_response("turn", &encode_approval_id(&json!("first")), &json!({"action":"approve"}), "op-approve").unwrap(), None);
        // Kimi leaves plan mode silently; the chip follows.
        let ui = std::iter::from_fn(|| receiver.try_recv().ok()).find(|event| event.kind == "chat.ui").expect("mode chip update");
        assert!(ui.data["options"].as_array().unwrap().iter().any(|option| option["id"] == "mode" && option["value"] == "default"));
        assert_eq!(ui.data["permissionChangeConfirmed"], true);

        card!("second");
        // Revise carries no feedback natively: the planning turn is stopped and
        // the feedback becomes the next prompt.
        let active = Arc::clone(&chat.active_turn);
        let ender = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            *active.lock().unwrap() = None;
        });
        let prompt = chat.plan_response("turn", &encode_approval_id(&json!("second")),
            &json!({"action":"request_changes","feedback":" Also add multiply "}), "op-revise").unwrap();
        ender.join().unwrap();
        assert_eq!(prompt.as_deref(), Some("Revise the plan with this feedback:\n\nAlso add multiply"));
        let resolved: Vec<_> = std::iter::from_fn(|| receiver.try_recv().ok()).filter(|event| event.kind == "chat.approval.resolved").collect();
        assert_eq!(resolved.len(), 1);
        assert_eq!((resolved[0].data["planOutcome"].as_str(), resolved[0].data["feedback"].as_str()), (Some("changes_requested"), Some("Also add multiply")));
        chat.process.request("barrier", json!({})).unwrap();
        let frames: Vec<Value> = std::fs::read_to_string(log).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        let reply = |id: &str| frames.iter().find(|frame| frame["id"] == id).map(|frame| frame["result"]["outcome"]["optionId"].clone());
        assert_eq!(reply("first"), Some(json!("plan_approve")));
        assert_eq!(reply("second"), Some(json!("plan_revise")));
        assert!(frames.iter().any(|frame| frame["method"] == "session/cancel"));
    }

    #[cfg(windows)]
    #[test]
    fn acp_conformance_terminal_and_kimi_wire() {
        use super::super::conformance::{assert_exactly_once, assert_no_parent_effect, fixture};
        for provider in ["gemini", "kimi"] {
            let dir = tempfile::tempdir().unwrap();
            let (process, log) = conformance_response_sink(dir.path());
            let (sender, mut receiver) = crate::provider_events::tap_channel(64);
            let events = ScopedProviderEvents::new(sender, "worker");
            let native = Mutex::new(Some("parent".to_owned()));
            let active = Arc::new(Mutex::new(None));
            let permissions = Arc::new(Mutex::new(HashMap::new()));
            let ui = Arc::new(Mutex::new(AcpUiState { permission_responder: Some(process.responder()), ..AcpUiState::default() }));
            let mut chat = AcpChat { provider: provider.into(), process, session_id: "s".into(), native_id: "parent".into(), events,
                active_turn: active, permissions, ui };
            chat.start_prompt("test", "parent-turn").unwrap();
            assert_eq!(receiver.try_recv().unwrap().kind, "chat.turn.started");
            // Kimi's child wire history is separate from ACP parent ingress.
            let wire = fixture("kimi-subagent-wire.jsonl");
            assert!(wire.iter().any(|row| row["type"] == "turn.ended"));
            let child_items = kimi_wire_transcript(KIMI_WIRE);
            assert!(child_items.iter().flat_map(|item| item["parts"].as_array().unwrap()).any(|part| part["text"] == "Review complete."));
            assert!(receiver.try_recv().is_err());
            for raw in fixture("acp-foreign-session-frames.jsonl").into_iter().take(5) {
                emit_acp_message(&chat.events, provider, "s", &native, &chat.active_turn, &chat.permissions, &Mutex::new(false), &chat.ui, raw);
            }
            let foreign: Vec<_> = std::iter::from_fn(|| receiver.try_recv().ok()).collect();
            assert_no_parent_effect(&foreign, "s");
            assert!(foreign.is_empty());
            assert_eq!(chat.active_turn.lock().unwrap().as_deref(), Some("parent-turn"));
            assert_eq!(native.lock().unwrap().as_deref(), Some("parent"));
            // A Kimi permission for an unknown tool ID is labelled using the
            // existing running native subagent, while staying on the parent turn.
            chat.ui.lock().unwrap().subagent_calls.insert("agent-call".into(), json!({"status":"running","description":"Review"}));
            let request = json!({"id":"terminal-pending","method":"session/request_permission","params":{"sessionId":"parent","toolCallId":"unknown-child-tool","options":[{"optionId":"allow","kind":"allow_once","name":"Allow"}]}});
            emit_acp_message(&chat.events, provider, "s", &native, &chat.active_turn, &chat.permissions, &Mutex::new(false), &chat.ui, request);
            let permission = receiver.try_recv().unwrap();
            assert_eq!(permission.data["part"]["data"]["subagent"]["key"], "agent-call");
            chat.process.request("barrier", json!({})).unwrap();
            assert_eq!(chat.active_turn.lock().unwrap().as_deref(), Some("parent-turn"));
            chat.process.notification("finish-parent", json!({})).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut terminal = Vec::new();
            while std::time::Instant::now() < deadline {
                terminal.extend(std::iter::from_fn(|| receiver.try_recv().ok()));
                if terminal.iter().any(|event| event.kind == "chat.turn.completed") { break; }
                std::thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(terminal.iter().filter(|event| event.kind == "chat.turn.completed").count(), 1);
            assert!(chat.active_turn.lock().unwrap().is_none());
            assert!(chat.permissions.lock().unwrap().is_empty());
            emit_acp_message(&chat.events, provider, "s", &native, &chat.active_turn, &chat.permissions, &Mutex::new(false), &chat.ui,
                json!({"id":"late-permission","method":"session/request_permission","params":{"sessionId":"child","options":[]}}));
            assert!(receiver.try_recv().is_err());
            assert!(chat.permissions.lock().unwrap().is_empty());
            drain_acp_permissions(&chat.permissions, &chat.process.responder());
            chat.process.request("barrier", json!({})).unwrap();
            let responses: Vec<Value> = std::fs::read_to_string(log).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
            assert_exactly_once(&responses, &[json!("terminal-pending"), json!("late-permission")]);
            assert_eq!(responses.iter().find(|row| row["id"] == "terminal-pending").unwrap()["result"], json!({"outcome":{"outcome":"cancelled"}}));
            assert_eq!(responses.iter().find(|row| row["id"] == "late-permission").unwrap()["result"], json!({"outcome":{"outcome":"cancelled"}}));
        }
    }

    #[cfg(windows)]
    #[test]
    fn acp_conformance_foreign_frames_and_reverse_requests() {
        use super::super::conformance::{assert_exactly_once, assert_no_parent_effect, fixture};
        for provider in ["gemini", "kimi"] {
            let dir = tempfile::tempdir().unwrap();
            let (process, log) = conformance_response_sink(dir.path());
            let responder = Arc::new(Mutex::new(None));
            let ready_responder = Arc::clone(&responder);
            let ready: Arc<dyn Fn(Value) + Send + Sync> = Arc::new(move |raw| {
                assert!(!handle_acp_message(&ready_responder, &raw, ChatToolPolicy::default(), false));
            });
            let startup = Mutex::new(Some(Vec::new()));
            dispatch_acp_message(&startup, &ready, json!({"id":"early-unknown","method":"terminal/create"}));
            dispatch_acp_message(&startup, &ready, json!({"id":"early-permission","method":"session/request_permission","params":{"sessionId":"parent"}}));
            assert_eq!(startup.lock().unwrap().as_ref().unwrap().len(), 2);
            *responder.lock().unwrap() = Some(process.responder());
            flush_acp_messages(&startup, &ready);
            flush_acp_messages(&startup, &ready);
            let (sender, mut receiver) = crate::provider_events::tap_channel(64);
            let events = ScopedProviderEvents::new(sender, "worker");
            let native = Mutex::new(Some("parent".to_owned()));
            let active = Arc::new(Mutex::new(Some("turn".to_owned())));
            let permissions = Arc::new(Mutex::new(HashMap::new()));
            let ui = Arc::new(Mutex::new(AcpUiState::default()));
            let think = Mutex::new(false);
            for raw in fixture("acp-foreign-session-frames.jsonl") {
                let replay = raw["id"] == "replay";
                if handle_acp_message(&responder, &raw, ChatToolPolicy::default(), !replay) {
                    emit_acp_message(&events, provider, "s", &native, &active, &permissions, &think, &ui, raw);
                }
            }
            let observed: Vec<_> = std::iter::from_fn(|| receiver.try_recv().ok()).collect();
            assert_no_parent_effect(&observed, "s");
            assert_eq!(observed.len(), 1);
            assert_eq!(observed[0].kind, "chat.approval");
            assert_eq!(observed[0].native_id.as_deref(), Some("parent"));
            assert_eq!(observed[0].turn_id.as_deref(), Some("turn"));
            assert_eq!(observed[0].data["part"]["data"]["subagent"]["label"], "Subagent");
            assert_eq!(native.lock().unwrap().as_deref(), Some("parent"));
            assert_eq!(active.lock().unwrap().as_deref(), Some("turn"));
            assert_eq!(ui.lock().unwrap().config_generation, 0);
            assert!(ui.lock().unwrap().parent_tool_calls.is_empty());
            assert_eq!(permissions.lock().unwrap().len(), 1);
            let mut chat = AcpChat { provider: provider.into(), process, session_id: "s".into(), native_id: "parent".into(), events,
                active_turn: active, permissions, ui };
            let id = encode_approval_id(&json!("child-permission"));
            chat.approve("turn", &id, "allow", "answer").unwrap();
            assert!(chat.approve("turn", &id, "allow", "answer").is_err());
            // Delegation must precede a closed replay gate.
            let delegation = json!({"id":"delegation","method":"session/request_permission","params":{"sessionId":"parent","toolCall":{"title":"mcp__threadterm__delegate_start","kind":"other"},"options":[{"optionId":"once","kind":"allow_once","name":"Allow"}]}});
            assert!(!handle_acp_message(&responder, &delegation, ChatToolPolicy { delegation: true, preview: false, ..Default::default() }, false));
            chat.process.request("barrier", json!({})).unwrap();
            let responses: Vec<Value> = std::fs::read_to_string(log).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
            assert_exactly_once(&responses, &[json!("unknown"), json!("replay"), json!("child-permission"), json!("delegation"), json!("early-unknown"), json!("early-permission")]);
            for (id, expected) in [
                ("replay", json!({"outcome":{"outcome":"cancelled"}})),
                ("early-permission", json!({"outcome":{"outcome":"cancelled"}})),
                ("child-permission", json!({"outcome":{"outcome":"selected","optionId":"allow"}})),
                ("delegation", json!({"outcome":{"outcome":"selected","optionId":"once"}})),
            ] {
                assert_eq!(responses.iter().find(|row| row["id"] == id).unwrap()["result"], expected);
            }
            assert_eq!(responses.iter().find(|row| row["id"] == "unknown").unwrap()["error"]["code"], -32601);
            assert_eq!(responses.iter().find(|row| row["id"] == "early-unknown").unwrap()["error"]["code"], -32601);
        }
    }
    use crate::plugins::PluginRegistry;

    #[test]
    fn acp_usage_update_emits_a_context_snapshot() {
        let (sender, mut receiver) = crate::provider_events::tap_channel(8);
        let events = ScopedProviderEvents::new(sender, "usage-worker");
        let native = Mutex::new(Some("native".to_owned()));
        let active = Mutex::new(Some("turn".to_owned()));
        let permissions = Mutex::new(HashMap::new());
        let think = Mutex::new(false);
        let ui = Mutex::new(AcpUiState::default());
        emit_acp_message(
            &events,
            "kimi",
            "usage",
            &native,
            &active,
            &permissions,
            &think,
            &ui,
            json!({"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"usage_update","used":60000,"size":200000}}}),
        );
        let emitted: Vec<_> = std::iter::from_fn(|| receiver.try_recv().ok()).collect();
        let context: Vec<_> = emitted.iter().filter(|event| event.kind == "chat.context").collect();
        assert_eq!(context.len(), 1);
        assert_eq!(context[0].data["usage"]["usedTokens"], 60000);
        assert_eq!(context[0].data["usage"]["windowTokens"], 200000);
        assert_eq!(context[0].data["usage"]["percent"], 30.0);

        // Nothing measurable means no event, and no transcript row.
        emit_acp_message(
            &events,
            "kimi",
            "usage",
            &native,
            &active,
            &permissions,
            &think,
            &ui,
            json!({"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"usage_update"}}}),
        );
        let extra: Vec<_> = std::iter::from_fn(|| receiver.try_recv().ok()).collect();
        assert!(extra.iter().all(|event| event.kind != "chat.context"));
    }

    #[test]
    fn acp_stream_output_stays_estimated_in_the_neutral_tracker() {
        let (sender, mut receiver) = crate::provider_events::tap_channel(8);
        let events = ScopedProviderEvents::new(sender, "speed-worker");
        let native = Mutex::new(Some("native".to_owned()));
        let active = Mutex::new(Some("turn".to_owned()));
        let permissions = Mutex::new(HashMap::new());
        let think = Mutex::new(false);
        let ui = Mutex::new(AcpUiState::default());
        for update in [
            json!({"sessionUpdate":"agent_thought_chunk","content":{"text":"plan"}}),
            json!({"sessionUpdate":"agent_message_chunk","content":{"text":"answer"}}),
        ] {
            emit_acp_message(&events, "kimi", "speed", &native, &active, &permissions, &think, &ui,
                json!({"method":"session/update","params":{"sessionId":"native","update":update}}));
        }
        let mut speed = crate::turn_speed::TurnSpeed::new(0);
        for (index, event) in std::iter::from_fn(|| receiver.try_recv().ok()).enumerate() {
            speed.observe(&event.kind, &event.data, 100 + index as u64 * 100);
        }
        assert_eq!(speed.usage(1000).unwrap()["outputTokensEstimated"], true);
    }

    #[test]
    fn acp_replay_splits_text_at_parent_interactions() {
        for provider in ["kimi", "gemini", "custom"] {
            for boundary in ["tool", "permission", "question", "subagent"] {
                let (sender, mut receiver) = crate::provider_events::tap_channel(32);
                let events = ScopedProviderEvents::new(sender, "segment-worker");
                let native = Mutex::new(Some("native".to_owned()));
                let active = Mutex::new(Some("turn".to_owned()));
                let permissions = Mutex::new(HashMap::new());
                let think = Mutex::new(false);
                let ui = Mutex::new(AcpUiState::default());
                let update = |kind: &str, text: &str| json!({"method":"session/update","params":{
                    "sessionId":"native","update":{"sessionUpdate":kind,"content":{"text":text}}}});
                let frame = match boundary {
                    "permission" => json!({"id":1,"method":"session/request_permission","params":{
                        "sessionId":"native","toolCall":{"title":"Read"},"options":[{"optionId":"allow","kind":"allow_once","name":"Allow"}]}}),
                    "question" => serde_json::from_str::<Value>(include_str!("../../tests/fixtures/kimi-question-bridge.jsonl").lines()
                        .find(|line| line.contains("session/request_permission")).unwrap()).unwrap(),
                    _ => json!({"method":"session/update","params":{"sessionId":"native","update":{
                        "sessionUpdate":"tool_call","toolCallId":"call","title":"Read",
                        "rawInput":if boundary == "subagent" { json!({"subagent_type":"explore","description":"Inspect"}) } else { json!({}) }}}}),
                };
                for frame in [update("agent_message_chunk", "Before"), frame,
                    update("agent_thought_chunk", "Thinking after"), update("agent_message_chunk", "After")] {
                    emit_acp_message(&events, provider, "segments", &native, &active, &permissions, &think, &ui, frame);
                }
                let emitted: Vec<_> = std::iter::from_fn(|| receiver.try_recv().ok()).collect();
                let deltas: Vec<_> = emitted.iter().filter(|event| event.kind == "chat.delta").collect();
                assert!(deltas[0].data.get("item").is_none());
                assert_eq!(deltas[1].data["item"]["id"], "turn:seg:1");
                assert_eq!(deltas[2].data["item"], deltas[1].data["item"]);
                super::super::common::assert_segmented_turn_projection("segments", provider, "turn", &emitted);
                *active.lock().unwrap() = Some("next".into());
                emit_acp_message(&events, provider, "segments", &native, &active, &permissions, &think, &ui, update("agent_message_chunk", "Next"));
                assert!(receiver.try_recv().unwrap().data.get("item").is_none());
            }
        }
    }

    #[test]
    fn chat_ui_event_matches_acp_ui_state() {
        let (sender, mut receiver) = crate::provider_events::tap_channel(1);
        let events = ScopedProviderEvents::new(sender, "worker");
        let ui = Mutex::new(AcpUiState {
            options: vec![json!({"id":"model","value":"qa"})],
            commands: vec![json!({"name":"compact"})],
            ..Default::default()
        });
        emit_chat_ui(&events, "kimi", "s", Some("n"), &ui);
        let event = receiver.try_recv().unwrap();
        let mut expected = ui.lock().unwrap().wire("kimi");
        expected["sessionId"] = json!("s");
        assert_eq!(event.data, expected);
    }

    #[test]
    fn subagent_result_headers_map_status_identity_and_summary() {
        for (native_status, expected) in [
            ("completed", "completed"),
            ("failed", "failed"),
            ("stopped", "cancelled"),
            ("running", "running"),
            ("future", "unknown"),
        ] {
            let info = kimi_subagent_result(&format!("agent_id: agent-1\r\nactual_subagent_type: coder\r\nstatus: {native_status}\r\nstop_reason: completed\r\n\r\n[summary]\r\nDone.\nstatus: failed"));
            assert_eq!(info["status"], expected);
            assert_eq!(info["agentType"], "coder");
            assert_eq!(info["native"], json!({"kind":"kimi-agent","id":"agent-1"}));
            assert_eq!(info["transcript"], "native");
            assert_eq!(info["summary"], "Done.\nstatus: failed");
        }
        assert_eq!(
            kimi_subagent_result("stop_reason: interrupted")["status"],
            "cancelled"
        );
        assert_eq!(kimi_subagent_result("ordinary output"), json!({}));
        let mut calls = HashMap::new();
        acp_subagent_update("kimi", &json!({"toolCallId":"raw-only",
            "rawInput":{"subagent_type":"explore"}}), &mut calls).unwrap();
        let (_, info) = acp_subagent_update("kimi", &json!({"toolCallId":"raw-only",
            "rawOutput":"agent_id: agent-2\nactual_subagent_type: coder\nstatus: completed\n[summary]\nRaw result"}),
            &mut calls).unwrap();
        assert_eq!(info["native"]["id"], "agent-2");
        assert_eq!(info["transcript"], "native");
        assert_eq!(info["agentType"], "coder");
        assert_eq!(info["status"], "completed");
        assert_eq!(info["summary"], "Raw result");
    }

    #[test]
    fn subagent_detection_is_provider_scoped_and_remembers_sparse_updates() {
        for provider in ["kimi", "gemini", "plugin"] {
            let mut calls = HashMap::new();
            let title = json!({"toolCallId":"a","title":"Launching coder agent: Review"});
            assert_eq!(
                acp_subagent_update(provider, &title, &mut calls).is_some(),
                provider == "kimi"
            );
            let launch = json!({"toolCallId":"b","rawInput":{"subagent_type":"explore","description":"Inspect","prompt":"Read code"}});
            let (_, info) = acp_subagent_update(provider, &launch, &mut calls).unwrap();
            assert_eq!(info["agentType"], "explore");
            assert_eq!(info["prompt"], "Read code");
            assert_eq!(info["transcript"], "none");
            let (_, info) = acp_subagent_update(
                provider,
                &json!({"toolCallId":"b","status":"failed"}),
                &mut calls,
            )
            .unwrap();
            assert_eq!(info["status"], "failed");
            assert_eq!(info["description"], "Inspect");
            assert!(
                acp_subagent_update(provider, &json!({"toolCallId":"unknown"}), &mut calls)
                    .is_none()
            );
        }
        for title in [
            "Launching two words agent: task",
            "Launching coder agent: ",
            "prefix Launching coder agent: task",
            "Launching coder agent: task\nextra",
        ] {
            assert!(acp_subagent_update(
                "kimi",
                &json!({"toolCallId":"a","title":title}),
                &mut HashMap::new()
            )
            .is_none());
        }
        let (_, info) = acp_subagent_update("kimi", &json!({"toolCallId":"blank",
            "title":"Launching coder agent: Review","rawInput":{"description":""}}),
            &mut HashMap::new()).unwrap();
        assert_eq!(info["description"], "Review");
    }

    #[test]
    fn kimi_agent_first_frame_with_partial_input_is_a_card() {
        let (sender, mut receiver) = crate::provider_events::tap_channel(16);
        let events = ScopedProviderEvents::new(sender, "worker");
        let native = Mutex::new(Some("native".to_owned()));
        let active = Mutex::new(Some("parent-turn".to_owned()));
        let permissions = Mutex::new(HashMap::new());
        let think = Mutex::new(false);
        let ui = Mutex::new(AcpUiState::default());
        let first = json!({"method":"session/update","params":{"sessionId":"native","update":{
            "sessionUpdate":"tool_call","toolCallId":"a","title":"Agent","rawInput":{"description":"Review"}}}});
        emit_acp_message(&events, "kimi", "parent", &native, &active, &permissions, &think, &ui, first.clone());
        let event = receiver.try_recv().unwrap();
        assert_eq!(event.kind, "chat.subagent");
        assert_eq!(event.data["key"], "a");
        assert_eq!(event.data["info"]["description"], "Review");
        assert!(receiver.try_recv().is_err());
        assert!(ui.lock().unwrap().parent_tool_calls.is_empty());
        let history = acp_transcript_for_provider("kimi", &[first]);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["parts"][0]["type"], "subagent");
        let mut calls = HashMap::new();
        assert!(acp_subagent_update("gemini", &json!({"toolCallId":"a","title":"Agent"}), &mut calls).is_none());
    }

    #[test]
    fn acp_late_subagent_detection_retracts_the_projected_parent_tool() {
        for provider in ["kimi", "gemini", "custom"] {
            let (sender, mut receiver) = crate::provider_events::tap_channel(16);
            let events = ScopedProviderEvents::new(sender, "worker");
            let native = Mutex::new(Some("native".to_owned()));
            let active = Mutex::new(Some("parent-turn".to_owned()));
            let permissions = Mutex::new(HashMap::new());
            let think = Mutex::new(false);
            let ui = Mutex::new(AcpUiState::default());
            let root = tempfile::tempdir().unwrap();
            let db = crate::db::Database::open(&root.path().join("late.sqlite")).unwrap();
            db.transaction(|tx| {
                tx.execute("INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at) VALUES ('parent','test',?,'chat','running','now','now')", [provider])?;
                Ok(())
            }).unwrap();
            let updates = [
                json!({"sessionUpdate":"tool_call","toolCallId":"a","title":"Task","rawInput":{"description":"Review"}}),
                json!({"sessionUpdate":"tool_call_update","toolCallId":"a","rawInput":{"subagent_type":"explore","prompt":"Inspect"}}),
                json!({"sessionUpdate":"tool_call_update","toolCallId":"a","status":"completed"}),
            ];
            let frames: Vec<_> = updates.iter().map(|update| json!({"method":"session/update","params":{"sessionId":"native","update":update}})).collect();
            for (index, frame) in frames.iter().enumerate() {
                emit_acp_message(&events, provider, "parent", &native, &active, &permissions, &think, &ui, frame.clone());
                let mut emitted = Vec::new();
                while let Ok(event) = receiver.try_recv() {
                    assert_eq!(event.worker_token.as_deref(), Some("worker"));
                    assert_eq!(event.turn_id.as_deref(), Some("parent-turn"));
                    crate::chat_projection::record(&db, "parent", event.turn_id.as_deref(), &event.kind, &event.data).unwrap();
                    emitted.push(event);
                }
                if index == 0 {
                    assert_eq!(emitted.len(), 2);
                    assert_eq!(emitted[1].data["part"]["type"], "tool");
                } else if index == 1 {
                    assert_eq!(emitted.len(), 2);
                    assert_eq!(emitted[0].kind, "chat.item");
                    assert_eq!(emitted[0].data["item"]["id"], "a");
                    assert_eq!(emitted[0].data["parts"], json!([]));
                    assert_eq!(emitted[1].kind, "chat.subagent");
                } else {
                    assert_eq!(emitted.len(), 1);
                    assert_eq!(emitted[0].kind, "chat.subagent");
                }
            }
            db.transaction(|tx| {
                let tool: String = tx.query_row("SELECT data FROM chat_items WHERE id='parent:assistant:a'", [], |row| row.get(0))?;
                assert_eq!(serde_json::from_str::<Value>(&tool).unwrap()["parts"], json!([]));
                let card: String = tx.query_row("SELECT data FROM chat_items WHERE id='parent:assistant:subagent:a'", [], |row| row.get(0))?;
                assert_eq!(serde_json::from_str::<Value>(&card).unwrap()["parts"][0]["data"]["status"], "completed");
                Ok(())
            }).unwrap();
            assert_eq!(active.lock().unwrap().as_deref(), Some("parent-turn"));
            assert!(ui.lock().unwrap().parent_tool_calls.is_empty());
            let history = acp_transcript_for_provider(provider, &frames);
            assert_eq!(history.len(), 1);
            assert_eq!(history[0]["parts"][0]["type"], "subagent");
        }
    }

    #[test]
    fn subagent_live_and_history_replace_tools_through_completion() {
        let (sender, mut receiver) = crate::provider_events::tap_channel(32);
        let events = ScopedProviderEvents::new(sender, "worker");
        let native = Mutex::new(Some("native".to_owned()));
        let active = Mutex::new(Some("parent-turn".to_owned()));
        let permissions = Mutex::new(HashMap::new());
        let think = Mutex::new(false);
        let ui = Mutex::new(AcpUiState::default());
        let updates = [
            json!({"sessionUpdate":"tool_call","toolCallId":"a","title":"Launching coder agent: Review","rawInput":{"prompt":"Inspect"}}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"a","status":"in_progress"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"a","status":"completed","content":[{"type":"content","content":{"type":"text","text":"agent_id: agent-1\nactual_subagent_type: coder\nstatus: completed\nstop_reason: completed\n[summary]\nDone"}}]}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"a","status":"completed","rawOutput":"agent_id: agent-1\nactual_subagent_type: coder\nstatus: completed\nstop_reason: completed\n[summary]\nDone"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"a","status":"failed"}),
        ];
        let raw: Vec<_> = updates.iter().map(|update| json!({"method":"session/update","params":{"sessionId":"native","update":update}})).collect();
        for frame in &raw {
            emit_acp_message(
                &events,
                "kimi",
                "parent",
                &native,
                &active,
                &permissions,
                &think,
                &ui,
                frame.clone(),
            );
            let event = receiver.try_recv().unwrap();
            assert_eq!(event.kind, "chat.subagent");
            assert_eq!(event.data["key"], "a");
            assert_eq!(event.worker_token.as_deref(), Some("worker"));
            assert_eq!(event.native_id.as_deref(), Some("native"));
            assert_eq!(event.turn_id.as_deref(), Some("parent-turn"));
            assert!(receiver.try_recv().is_err());
        }
        let info = &ui.lock().unwrap().subagent_calls["a"];
        assert_eq!(info["transcript"], "native");
        assert_eq!(info["summary"], "Done");
        assert_eq!(info["status"], "failed");
        assert_eq!(active.lock().unwrap().as_deref(), Some("parent-turn"));
        let history = acp_transcript_for_provider("kimi", &raw);
        assert_eq!(history.len(), 1);
        let part = &history[0]["parts"][0];
        assert_eq!(part["type"], "subagent");
        assert_eq!(part["status"], "failed");
        assert_eq!(part["data"]["transcript"], "none");
        assert_eq!(part["data"]["native"]["id"], "agent-1");
        assert_eq!(part["data"]["prompt"], "Inspect");
        assert_eq!(
            acp_transcript_for_provider("gemini", &raw)[0]["parts"][0]["type"],
            "tool"
        );
    }

    #[test]
    fn foreign_acp_updates_do_not_project_or_mutate_parent_state() {
        for provider in ["kimi", "gemini"] {
            let (sender, mut receiver) = crate::provider_events::tap_channel(32);
            let events = ScopedProviderEvents::new(sender, "worker");
            let native = Mutex::new(Some("parent".to_owned()));
            let active = Mutex::new(Some("turn".to_owned()));
            let permissions = Mutex::new(HashMap::new());
            let think = Mutex::new(false);
            let ui = Mutex::new(AcpUiState::default());
            for update in [
                json!({"sessionUpdate":"agent_message_chunk","content":{"text":"child"}}),
                json!({"sessionUpdate":"tool_call","toolCallId":"child","rawInput":{"subagent_type":"coder"}}),
                json!({"sessionUpdate":"config_options_update","configOptions":[{"id":"child"}]}),
            ] {
                emit_acp_message(
                    &events,
                    provider,
                    "s",
                    &native,
                    &active,
                    &permissions,
                    &think,
                    &ui,
                    json!({"method":"session/update","params":{"sessionId":"child","update":update}}),
                );
            }
            assert!(receiver.try_recv().is_err());
            assert!(ui.lock().unwrap().subagent_calls.is_empty());
            assert_eq!(ui.lock().unwrap().config_generation, 0);
            assert_eq!(active.lock().unwrap().as_deref(), Some("turn"));
            for session in [Some("parent"), None] {
                let mut params = json!({"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"parent"}}});
                if let Some(session) = session {
                    params["sessionId"] = json!(session);
                }
                emit_acp_message(
                    &events,
                    provider,
                    "s",
                    &native,
                    &active,
                    &permissions,
                    &think,
                    &ui,
                    json!({"method":"session/update","params":params}),
                );
                assert_eq!(receiver.try_recv().unwrap().kind, "chat.delta");
            }
        }
    }

    const KIMI_WIRE: &[u8] = include_bytes!("../../tests/fixtures/kimi-subagent-wire.jsonl");
    const KIMI_QUESTION_BRIDGE: &[u8] = include_bytes!("../../tests/fixtures/kimi-question-bridge.jsonl");

    #[test]
    fn kimi_ask_user_question_bridge_is_a_question_only_for_kimi() {
        let raw = serde_json::from_slice::<Value>(KIMI_QUESTION_BRIDGE).unwrap();
        let emit_request = |provider: &str, raw: Value| {
            let (sender, mut receiver) = crate::provider_events::tap_channel(4);
            let events = ScopedProviderEvents::new(sender, "worker");
            let native = Mutex::new(Some("kimi-question-session".to_owned()));
            let active = Mutex::new(Some("turn".to_owned()));
            let permissions = Mutex::new(HashMap::new());
            let ui = Mutex::new(AcpUiState::default());
            emit_acp_message(&events, provider, "session", &native, &active, &permissions, &Mutex::new(false), &ui, raw);
            (receiver.try_recv().unwrap(), permissions)
        };
        let (event, permissions) = emit_request("kimi", raw.clone());
        let data = &event.data["part"]["data"];
        assert_eq!(event.kind, "chat.approval");
        assert_eq!(data["interaction"], "question");
        assert_eq!(data["form"]["kind"], "questions");
        assert_eq!(data["form"]["questions"][0]["question"], "Which release channel should I use?");
        assert_eq!(data["form"]["questions"][0]["options"], json!([{"label":"Stable"},{"label":"Preview"}]));
        assert_eq!(data["form"]["questions"][0]["multiSelect"], false);
        assert_eq!(data["form"]["questions"][0]["allowOther"], false);
        assert_eq!(permissions.lock().unwrap().values().next().unwrap().question_data.as_ref().unwrap()["form"], data["form"]);
        let locked_permissions = permissions.lock().unwrap();
        let choices = &locked_permissions.values().next().unwrap().choices;
        let (choice, status) = kimi_question_choice(choices, &json!({"action":"submit","values":{"q0":["Preview"]}})).unwrap();
        assert_eq!(status, "answered");
        assert_eq!(json!({"outcome":{"outcome":"selected","optionId":choice}}), json!({"outcome":{"outcome":"selected","optionId":"q0_opt_1"}}));
        let (choice, status) = kimi_question_choice(choices, &json!({"action":"dismiss"})).unwrap();
        assert_eq!(status, "dismissed");
        assert_eq!(json!({"outcome":{"outcome":"selected","optionId":choice}}), json!({"outcome":{"outcome":"selected","optionId":"q0_skip"}}));

        let (generic, _) = emit_request("gemini", raw.clone());
        assert_eq!(generic.data["part"]["data"]["interaction"], "permission");
        assert!(generic.data["part"]["data"].get("form").is_none());

        let mut spaced = raw.clone();
        spaced["params"]["options"][0]["name"] = json!(" Sapphire ");
        let (spaced, permissions) = emit_request("kimi", spaced);
        assert_eq!(spaced.data["part"]["data"]["form"]["questions"][0]["options"][0]["label"], " Sapphire ");
        let locked_permissions = permissions.lock().unwrap();
        let choices = &locked_permissions.values().next().unwrap().choices;
        assert_eq!(kimi_question_choice(choices, &json!({"action":"submit","values":{"q0":[" Sapphire "]}})).unwrap().0, "q0_opt_0");

        let mut malformed = raw.clone();
        malformed["params"]["options"][1]["optionId"] = json!("q1_opt_1");
        let (generic, _) = emit_request("kimi", malformed);
        assert_eq!(generic.data["part"]["data"]["interaction"], "permission");
        assert!(generic.data["part"]["data"].get("form").is_none());

        let mut duplicate = raw.clone();
        duplicate["params"]["options"][1]["optionId"] = json!("q0_opt_0");
        let (generic, _) = emit_request("kimi", duplicate);
        assert_eq!(generic.data["part"]["data"]["interaction"], "permission");

        let mut title_only = raw;
        title_only["params"]["toolCall"]["rawInput"] = Value::Null;
        title_only["params"]["toolCall"]["content"] = Value::Null;
        title_only["params"]["toolCall"]["title"] = json!("Title fallback question");
        let (title_only, _) = emit_request("kimi", title_only);
        assert_eq!(title_only.data["part"]["data"]["form"]["questions"][0]["question"], "Title fallback question");
    }

    #[test]
    fn kimi_redacted_wire_maps_prompt_thinking_tools_output_and_error() {
        let items = kimi_wire_transcript(KIMI_WIRE);
        assert_eq!(
            items.iter().filter(|item| item["role"] == "user").count(),
            1
        );
        let parts: Vec<_> = items.iter().map(|item| &item["parts"][0]).collect();
        assert!(parts
            .iter()
            .any(|part| part["type"] == "thinking" && part["text"] == "Inspecting the example."));
        let tool = parts.iter().find(|part| part["type"] == "tool").unwrap();
        assert_eq!(tool["toolName"], "Read");
        assert_eq!(tool["status"], "complete");
        assert_eq!(tool["data"]["args"]["path"], "src/example.rs");
        assert_eq!(tool["data"]["output"], "Example file contents.");
        assert!(parts
            .iter()
            .any(|part| part["type"] == "error" && part["text"] == "Redacted provider error."));
    }

    #[test]
    fn kimi_wire_caps_items_bounds_strings_and_merges_failed_tool_results() {
        let mut bytes = KIMI_WIRE.to_vec();
        bytes.extend_from_slice(b"not json\n");
        bytes.extend_from_slice(
            b"{\"type\":\"turn.prompt\",\"input\":[{\"type\":\"text\",\"text\":\"second\"}]}\n",
        );
        bytes.extend_from_slice(b"{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.result\",\"toolCallId\":\"tool-redacted\",\"result\":{\"isError\":true,\"output\":\"failure\"}}}\n");
        let items = kimi_wire_transcript(&bytes);
        assert_eq!(
            items.iter().filter(|item| item["role"] == "user").count(),
            1
        );
        let tool = items
            .iter()
            .find(|item| item["parts"][0]["type"] == "tool")
            .unwrap();
        assert_eq!(tool["parts"][0]["status"], "failed");
        for index in 0..501 {
            let record = json!({"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":if index == 500 { "界".repeat(20000) } else { index.to_string() }}}});
            bytes.extend_from_slice(record.to_string().as_bytes());
            bytes.push(b'\n');
        }
        let items = kimi_wire_transcript(&bytes);
        assert_eq!(items.len(), 500);
        assert_eq!(items[0]["parts"][0]["text"], "1");
        let text = items.last().unwrap()["parts"][0]["text"].as_str().unwrap();
        assert!(text.len() <= 16 * 1024);
        assert!(text.ends_with("[truncated]"));
    }

    #[test]
    fn kimi_native_reader_finds_session_bounds_tail_and_rejects_path_ids() {
        use std::io::Write;
        let home = tempfile::tempdir().unwrap();
        let path = home
            .path()
            .join("sessions/wd_fixture/session_uuid/agents/agent-1/wire.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, KIMI_WIRE).unwrap();
        let session = NativeSessionRef {
            native_id: "session_uuid".into(),
            cwd: "unused".into(),
        };
        let info = json!({"native":{"kind":"kimi-agent","id":"agent-1"}});
        assert_eq!(
            kimi_subagent_transcript(home.path(), &session, &info).unwrap(),
            kimi_wire_transcript(KIMI_WIRE)
        );
        // An explicitly ordinary tool can survive without its call in the tail.
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(KIMI_WIRE).unwrap();
        file.write_all(&vec![b'x'; 4 * 1024 * 1024]).unwrap();
        file.write_all(b"\n{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.result\",\"toolCallId\":\"orphan\",\"name\":\"read_file\",\"result\":{\"output\":\"tail result\"}}}\n").unwrap();
        drop(file);
        let items = kimi_subagent_transcript(home.path(), &session, &info).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["parts"][0]["toolId"], "orphan");
        assert_eq!(items[0]["parts"][0]["status"], "complete");
        assert_eq!(items[0]["parts"][0]["data"]["output"], "tail result");
        // A genuinely nameless tail result could contain a browser read. Its
        // bytes are unavailable when the identifying call is outside the tail.
        let orphan = kimi_wire_transcript(b"{\"type\":\"tool.result\",\"toolCallId\":\"unknown\",\"result\":{\"output\":\"private orphan\"}}\n");
        assert_eq!(orphan[0]["parts"][0]["data"]["resultRedacted"],true);
        assert!(!orphan[0].to_string().contains("private orphan"));
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(
            b"{\"type\":\"turn.prompt\",\"input\":[{\"type\":\"text\",\"text\":\"old\"}]}\n",
        )
        .unwrap();
        file.write_all(&vec![b'x'; 4 * 1024 * 1024]).unwrap();
        file.write_all(b"\n").unwrap();
        file.write_all(KIMI_WIRE).unwrap();
        drop(file);
        assert_eq!(
            kimi_subagent_transcript(home.path(), &session, &info).unwrap(),
            kimi_wire_transcript(KIMI_WIRE)
        );
        for id in ["../agent-1", "..", "a/b", "C:evil", ""] {
            assert!(kimi_subagent_transcript(
                home.path(),
                &session,
                &json!({"native":{"kind":"kimi-agent","id":id}})
            )
            .is_err());
        }
        assert!(kimi_subagent_transcript(
            home.path(),
            &session,
            &json!({"native":{"kind":"kimi-agent","id":"missing"}})
        )
        .is_err());
    }

    fn gemini(events: crate::provider_events::Sender) -> AcpAdapter {
        let data_dir = tempfile::tempdir().unwrap();
        let registry = PluginRegistry::discover_with_roots(data_dir.path(), &json!({}), &[]);
        let descriptor = registry
            .agents
            .into_iter()
            .find(|agent| agent.id == "gemini")
            .expect("bundled Gemini descriptor");
        AcpAdapter::from_descriptor(descriptor, events)
    }

    #[test]
    fn kimi_and_gemini_tool_updates_keep_native_identity_and_file_candidates() {
        for provider in ["kimi", "gemini"] {
            let (sender, mut receiver) = crate::provider_events::tap_channel(16);
            let events = ScopedProviderEvents::new(sender, "worker");
            let native = Mutex::new(Some("native".to_owned()));
            let active = Mutex::new(Some("turn".to_owned()));
            let permissions = Mutex::new(HashMap::new());
            let think = Mutex::new(false);
            let ui = Mutex::new(AcpUiState::default());
            for update in [
                json!({"sessionUpdate":"tool_call","toolCallId":"tc-1","title":"Read File","status":"running","locations":[{"path":"src/a.rs","line":3}],"rawInput":{"path":"src/b.rs"}}),
                json!({"sessionUpdate":"tool_call_update","toolCallId":"tc-1","status":"failed","rawOutput":{"filePath":"src/c.rs"}}),
            ] {
                emit_acp_message(
                    &events,
                    provider,
                    "session",
                    &native,
                    &active,
                    &permissions,
                    &think,
                    &ui,
                    json!({"method":"session/update","params":{"sessionId":"native","update":update}}),
                );
                let raw = receiver.try_recv().unwrap();
                assert_eq!(raw.kind, "chat.item");
                let projected = receiver.try_recv().unwrap();
                assert_eq!(projected.kind, "chat.item");
                assert_eq!(projected.worker_token.as_deref(), Some("worker"));
                assert_eq!(projected.native_id.as_deref(), Some("native"));
                assert_eq!(projected.turn_id.as_deref(), Some("turn"));
                assert_eq!(projected.data["item"]["id"], "tc-1");
                assert_eq!(projected.data["part"]["toolId"], "tc-1");
                assert!(projected.data["part"]["fileReferences"]
                    .as_array()
                    .is_some());
            }
            let history = acp_transcript(&[
                json!({"params":{"update":{"sessionUpdate":"tool_call","toolCallId":"tc-1","title":"Read File","rawInput":{"path":"src/b.rs"}}}}),
                json!({"params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"tc-1","status":"failed","rawOutput":{"path":"src/d.rs"}}}}),
            ]);
            assert_eq!(history.len(), 1);
            assert_eq!(history[0]["parts"][0]["status"], "failed");
            assert_eq!(
                history[0]["parts"][0]["fileReferences"][0]["path"],
                "src/b.rs"
            );
            assert_eq!(
                history[0]["parts"][0]["fileReferences"][1]["path"],
                "src/d.rs"
            );
        }
    }

    #[test]
    fn kimi_terminal_cwd_preserves_non_verbatim_paths() {
        for path in [
            r"D:\Repo\工作 目录",
            "D:/Repo/",
            r"\\server\share\repo",
            "/tmp/repo",
            r"\\.\device",
            r"\\?\Volume{abc}\repo",
        ] {
            assert_eq!(kimi_terminal_cwd(path), path);
        }
    }

    #[test]
    fn kimi_terminal_cwd_uses_cli_windows_spelling_only_on_windows() {
        for (verbatim, plain) in [
            (r"\\?\D:\Repo\工作 目录", r"D:\Repo\工作 目录"),
            (r"\\?\d:\Repo\", r"d:\Repo\"),
            (r"\\?\D:\", r"D:\"),
            (
                r"\\?\UNC\server\share\工作 目录",
                r"\\server\share\工作 目录",
            ),
            (r"\\?\UNC\server\share\", r"\\server\share\"),
        ] {
            let expected = if cfg!(windows) { plain } else { verbatim };
            assert_eq!(kimi_terminal_cwd(verbatim), expected);
        }
    }

    #[test]
    fn usage_notifications_keep_the_originating_worker_token() {
        let (context, mut receiver) = usage_reply_fixture();
        context.finish(Ok(json!({})), None);
        for expected_kind in ["chat.item", "chat.turn.completed"] {
            let event = receiver.try_recv().unwrap();
            assert_eq!(event.kind, expected_kind);
            assert_eq!(event.worker_token.as_deref(), Some("test-worker"));
        }
        let (events, _) = crate::provider_events::tap_channel(4);
        assert!(AcpAdapter::kimi(events.clone()).scopes_chat_events());
        assert!(gemini(events).scopes_chat_events());
    }

    #[test]
    fn acp_subagent_permissions_label_only_unmatched_calls_while_agents_run() {
        let mut state = AcpUiState::default();
        state.subagent_calls.insert(
            "agent-call".into(),
            json!({"status":"running","description":"Review the change","agentType":"coder"}),
        );
        let single = acp_permission_subagent(&json!({"toolCallId":"child-tool"}), &state).unwrap();
        assert_eq!(single, json!({"key":"agent-call","label":"Review the change"}));

        state.subagent_calls.insert(
            "other-agent".into(),
            json!({"status":"running","description":"Inspect tests","agentType":"explore"}),
        );
        assert_eq!(
            acp_permission_subagent(&json!({"toolCallId":"child-tool"}), &state),
            Some(json!({"label":"Subagent"}))
        );

        state.parent_tool_calls.insert("parent-tool".into());
        assert_eq!(
            acp_permission_subagent(&json!({"toolCallId":"parent-tool"}), &state),
            None
        );

        state.subagent_calls.clear();
        assert_eq!(
            acp_permission_subagent(&json!({"toolCallId":"child-tool"}), &state),
            None
        );
    }
    #[test]
    fn acp_native_notification_paths_keep_the_worker_token() {
        for provider in ["kimi", "gemini"] {
            let (sender, mut receiver) = crate::provider_events::tap_channel(32);
            let events = ScopedProviderEvents::new(sender, "old-worker");
            let native = Mutex::new(Some("native".to_owned()));
            let active = Mutex::new(Some("turn".to_owned()));
            let permissions = Mutex::new(HashMap::new());
            let ui = Mutex::new(AcpUiState::default());
            for raw in [
                json!({"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"answer"}}}}),
                json!({"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"agent_thought_chunk","content":{"text":"reasoning"}}}}),
                json!({"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"config_option_update","configOptions":[]}}}),
                json!({"id":1,"method":"session/request_permission","params":{"sessionId":"native","options":[{"optionId":"deny","kind":"reject_once","name":"Deny"}]}}),
                json!({"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"tool_call","toolCallId":"tool"}}}),
            ] {
                emit_acp_message(
                    &events,
                    provider,
                    "session",
                    &native,
                    &active,
                    &permissions,
                    &Mutex::new(false),
                    &ui,
                    raw,
                );
                let mut count = 0;
                while let Ok(event) = receiver.try_recv() {
                    count += 1;
                    assert_eq!(event.worker_token.as_deref(), Some("old-worker"));
                    assert_eq!(event.provider, provider);
                    assert_eq!(event.native_id.as_deref(), Some("native"));
                }
                assert!(count > 0);
            }
        }
    }

    #[test]
    fn failed_version_probe_keeps_its_specific_error() {
        assert_eq!(
            acp_probe_failure_reason("Gemini", Some("version probe timed out".into())),
            "version probe timed out"
        );
        assert_eq!(
            acp_probe_failure_reason("Kimi", None),
            "Kimi CLI is not installed"
        );
    }

    #[cfg(windows)]
    struct SettingsFixture {
        chat: AcpChat,
        log: std::path::PathBuf,
        _dir: tempfile::TempDir,
    }

    #[cfg(windows)]
    fn settings_fixture(provider: &'static str, scenario: &str) -> SettingsFixture {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("settings-calls.jsonl");
        std::fs::write(&log, "").unwrap();
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../qa/fixtures/fake-acp-settings.cjs");
        let spec = CommandSpec::provider("node", &[fixture.to_str().unwrap()]).unwrap();
        let (events, _) = crate::provider_events::tap_channel(32);
        let events = ScopedProviderEvents::new(events, "test-worker");
        let native = Arc::new(Mutex::new(Some("qa-acp-settings-session".to_owned())));
        let active_turn = Arc::new(Mutex::new(None));
        let permissions = Arc::new(Mutex::new(HashMap::new()));
        let think_open = Arc::new(Mutex::new(false));
        let ui = Arc::new(Mutex::new(AcpUiState::default()));
        let callback = {
            let events = events.clone();
            let native = Arc::clone(&native);
            let active_turn = Arc::clone(&active_turn);
            let permissions = Arc::clone(&permissions);
            let think_open = Arc::clone(&think_open);
            let ui = Arc::clone(&ui);
            Arc::new(move |raw| {
                emit_acp_message(
                    &events,
                    provider,
                    "settings-qa",
                    &native,
                    &active_turn,
                    &permissions,
                    &think_open,
                    &ui,
                    raw,
                );
            })
        };
        let process = JsonLineProcess::spawn(
            "acp-settings-qa",
            &spec,
            None,
            &[
                ("THREADTERM_QA_ACP_SETTINGS_LOG", log.to_str().unwrap()),
                ("THREADTERM_QA_ACP_SETTINGS_SCENARIO", scenario),
            ],
            EnvelopeStyle::JsonRpc2,
            callback,
        )
        .unwrap();
        let initialized = process.request("initialize", json!({})).unwrap();
        assert_eq!(initialized["protocolVersion"], 1);
        let opened = process
            .request("session/new", json!({"cwd":dir.path().to_string_lossy()}))
            .unwrap();
        merge_acp_ui(&mut ui.lock().unwrap(), &opened);
        SettingsFixture {
            chat: AcpChat {
                provider: provider.to_owned(),
                process,
                session_id: "settings-qa".to_owned(),
                native_id: "qa-acp-settings-session".to_owned(),
                events,
                active_turn,
                permissions,
                ui,
            },
            log,
            _dir: dir,
        }
    }

    #[cfg(windows)]
    fn setting_calls(log: &std::path::Path, method: &str) -> usize {
        std::fs::read_to_string(log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|entry| entry["method"] == method)
            .count()
    }

    #[cfg(windows)]
    fn current_setting(state: &Value, option_id: &str) -> Option<String> {
        state["options"]
            .as_array()?
            .iter()
            .find(|option| option["id"] == option_id)?["value"]
            .as_str()
            .map(ToOwned::to_owned)
    }

    #[cfg(windows)]
    #[test]
    fn settings_contract_is_shared_by_kimi_and_gemini() {
        for provider in ["kimi", "gemini"] {
            let mut rejected = settings_fixture(provider, "default");
            let original = rejected.chat.ui_state();
            let error = rejected.chat.set_option("thinking", "reject").unwrap_err();
            assert!(error.message.contains("thinking rejected"));
            assert_eq!(rejected.chat.ui_state(), original);
            assert_eq!(setting_calls(&rejected.log, "session/set_model"), 0);

            let normalized = rejected.chat.set_option("model", "new-model").unwrap();
            assert_eq!(normalized["options"][0]["value"], "NEW-MODEL");
            let next = rejected.chat.set_option("model", "second-model").unwrap();
            assert_eq!(next["options"][0]["value"], "SECOND-MODEL");

            for invalid in ["bad-model", "auth-error"] {
                assert!(rejected.chat.set_option("model", invalid).is_err());
                assert_eq!(
                    rejected.chat.ui_state()["options"][0]["value"],
                    "SECOND-MODEL"
                );
                assert_eq!(setting_calls(&rejected.log, "session/set_model"), 0);
            }
            let mut legacy = settings_fixture(provider, "method-missing");
            assert_eq!(
                legacy.chat.set_option("model", "old-api").unwrap()["options"][0]["value"],
                "old-api"
            );
            assert_eq!(setting_calls(&legacy.log, "session/set_model"), 1);
        }
    }

    #[cfg(windows)]
    #[test]
    fn config_notification_wins_over_an_older_setting_response() {
        for provider in ["kimi", "gemini"] {
            let mut fixture = settings_fixture(provider, "default");
            let result = fixture
                .chat
                .set_option("thinking", "late-response")
                .unwrap();
            assert_eq!(
                current_setting(&result, "thinking").as_deref(),
                Some("ultra")
            );
            assert_eq!(
                current_setting(&fixture.chat.ui_state(), "thinking").as_deref(),
                Some("ultra")
            );
            assert_eq!(
                current_setting(&result, "model").as_deref(),
                Some("old-model")
            );
        }
    }

    fn usage_reply_fixture() -> (UsageReplyContext, broadcast::Receiver<ProviderEvent>) {
        let (events, receiver) = crate::provider_events::tap_channel(16);
        let events = ScopedProviderEvents::new(events, "test-worker");
        let context = UsageReplyContext {
            events,
            session_id: "s".into(),
            native_id: "n".into(),
            turn_id: "usage".into(),
            active: Arc::new(Mutex::new(Some("usage".into()))),
            ui: Arc::new(Mutex::new(AcpUiState {
                usage_reply: Some(PendingUsageReply {
                    turn_id: "usage".into(),
                    text: String::new(),
                    native_done: true,
                    cancelled: false,
                    started: std::time::Instant::now(),
                }),
                ..Default::default()
            })),
        };
        (context, receiver)
    }

    #[test]
    fn kimi_usage_buffers_native_statistics_and_emits_one_complete_reply() {
        let (context, mut receiver) = usage_reply_fixture();
        for text in [
            "Context: 0 / 1048576 tokens (0%)\n",
            "Session total: no LLM calls yet",
        ] {
            emit_acp_message(
                &context.events,
                "kimi",
                "s",
                &Mutex::new(Some("n".into())),
                &context.active,
                &Mutex::new(HashMap::new()),
                &Mutex::new(false),
                &context.ui,
                json!({"method":"session/update","params":{"sessionId":"n","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}}),
            );
        }
        assert!(
            receiver.try_recv().is_err(),
            "partial statistics must not be displayed before plan usage"
        );
        context.finish(
            Ok(json!({})),
            Some(super::super::kimi_plan_usage::PlanUsage {
                text: "Plan usage".into(),
                data: json!({"kind":"plan","rows":[]}),
            }),
        );
        let item = receiver.try_recv().unwrap();
        assert_eq!(item.kind, "chat.item");
        assert_eq!(item.data["parts"].as_array().unwrap().len(), 2);
        assert!(item.data["parts"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Session total"));
        assert_eq!(item.data["parts"][1]["data"]["kind"], "plan");
        assert_eq!(receiver.try_recv().unwrap().kind, "chat.turn.completed");
        assert!(context.active.lock().unwrap().is_none());
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn kimi_usage_cancellation_suppresses_late_results_and_preserves_new_turn() {
        let (context, mut receiver) = usage_reply_fixture();
        context
            .ui
            .lock()
            .unwrap()
            .usage_reply
            .as_mut()
            .unwrap()
            .cancelled = true;
        context.finish(Ok(json!({})), None);
        let completed = receiver.try_recv().unwrap();
        assert_eq!(completed.kind, "chat.turn.completed");
        assert_eq!(completed.data["result"]["stopReason"], "cancelled");
        *context.active.lock().unwrap() = Some("new-turn".into());
        context.finish(
            Ok(json!({})),
            Some(super::super::kimi_plan_usage::PlanUsage {
                text: "Late plan".into(),
                data: json!({"kind":"plan"}),
            }),
        );
        assert!(receiver.try_recv().is_err());
        assert_eq!(context.active.lock().unwrap().as_deref(), Some("new-turn"));
    }

    #[test]
    fn kimi_usage_failure_retains_context_and_finishes() {
        let (context, mut receiver) = usage_reply_fixture();
        context
            .ui
            .lock()
            .unwrap()
            .usage_reply
            .as_mut()
            .unwrap()
            .text = "Context: 42 tokens".into();
        context.finish(Ok(json!({})), None);
        let item = receiver.try_recv().unwrap();
        assert_eq!(item.data["parts"][0]["text"], "Context: 42 tokens");
        assert!(item.data["parts"][1]["text"]
            .as_str()
            .unwrap()
            .contains("unavailable"));
        assert_eq!(receiver.try_recv().unwrap().kind, "chat.turn.completed");
        assert!(context.active.lock().unwrap().is_none());
    }

    #[test]
    fn kimi_usage_native_error_releases_turn_without_a_late_card() {
        let (context, mut receiver) = usage_reply_fixture();
        context.finish(Err(ProviderError::new("provider_error", "Failed")), None);
        assert_eq!(receiver.try_recv().unwrap().kind, "chat.error");
        assert!(context.active.lock().unwrap().is_none());
        context.finish(Ok(json!({})), None);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    #[ignore = "starts installed Kimi in a temporary workspace and queries real usage, no LLM turn"]
    fn kimi_usage_roundtrip_timing_probe() {
        let cwd = tempfile::tempdir().unwrap();
        let (events, mut receiver) = crate::provider_events::tap_channel(256);
        let adapter = AcpAdapter::kimi(events);
        let started = std::time::Instant::now();
        let mut chat = adapter
            .open_chat("usage-timing", cwd.path().to_str().unwrap(), None)
            .unwrap();
        eprintln!("open_chat: {:?}", started.elapsed());
        for index in 0..2 {
            let turn_id = format!("usage-timing-{index}");
            let started = std::time::Instant::now();
            chat.send("/usage", &turn_id).unwrap();
            let mut card = false;
            let mut completed = false;
            while started.elapsed() < Duration::from_secs(25) && !(card && completed) {
                if let Ok(event) = receiver.try_recv() {
                    if event.turn_id.as_deref() != Some(&turn_id) {
                        continue;
                    }
                    if matches!(
                        event.kind.as_str(),
                        "chat.delta" | "chat.item" | "chat.turn.completed" | "chat.error"
                    ) {
                        eprintln!("sample {index} {}: {:?}", event.kind, started.elapsed());
                    }
                    card |= event.kind == "chat.item"
                        && event.data["parts"].as_array().is_some_and(|parts| {
                            parts.iter().any(|part| part["data"]["kind"] == "plan")
                        });
                    completed |= event.kind == "chat.turn.completed";
                } else {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            assert!(card && completed, "usage card/completion not received");
        }
        chat.send("/usage", "cancelled-usage").unwrap();
        chat.cancel("cancelled-usage").unwrap();
        let cancelled_at = std::time::Instant::now();
        let mut cancelled = false;
        while cancelled_at.elapsed() < Duration::from_secs(3) && !cancelled {
            if let Ok(event) = receiver.try_recv() {
                if event.turn_id.as_deref() != Some("cancelled-usage") {
                    continue;
                }
                assert_ne!(
                    event.kind, "chat.item",
                    "cancelled usage must not publish a card"
                );
                cancelled = event.kind == "chat.turn.completed";
            } else {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        assert!(
            cancelled,
            "native cancellation must finish the usage request"
        );
        chat.stop().unwrap();
    }
    #[test]
    fn recognizes_nested_session_capabilities() {
        assert!(has_capability(
            &json!({"agentCapabilities":{"sessionCapabilities":{"load":{}}}}),
            "load"
        ));
    }
    #[test]
    fn normalizes_session_identity() {
        assert_eq!(
            acp_history_item("kimi", &json!({"sessionId":"s1","title":"Hi"})).unwrap()["nativeId"],
            "s1"
        );
    }
    #[test]
    fn kimi_prepares_identity_through_acp_while_gemini_remains_unverified() {
        let adapter = AcpAdapter::kimi(crate::provider_events::tap_channel(1).0);
        assert_eq!(
            adapter.terminal_capture(),
            super::super::TerminalCapture::PreAssigned
        );
        assert_eq!(
            gemini(crate::provider_events::tap_channel(1).0).terminal_capture(),
            super::super::TerminalCapture::None
        );
    }

    #[test]
    fn bundled_gemini_descriptor_keeps_its_acp_and_terminal_commands() {
        let adapter = gemini(crate::provider_events::tap_channel(1).0);
        assert_eq!(adapter.id(), "gemini");
        assert_eq!(adapter.descriptor.command, "gemini");
        assert_eq!(
            adapter.descriptor.chat_args.as_deref(),
            Some(&["--acp".into()][..])
        );
        assert_eq!(
            adapter
                .descriptor
                .terminal
                .as_ref()
                .map(|terminal| terminal.resume_args.as_slice()),
            Some(&["--resume".into(), "{sessionId}".into()][..])
        );
    }

    #[test]
    fn kimi_terminal_assignment_uses_its_preassigned_session_flag() {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let executable = directory.path().join("kimi-test.cmd");
        #[cfg(not(windows))]
        let executable = directory.path().join("kimi-test");
        std::fs::write(&executable, "placeholder").unwrap();
        let mut adapter = AcpAdapter::kimi(crate::provider_events::tap_channel(1).0);
        adapter.descriptor.command = executable.to_string_lossy().into_owned();

        let command = adapter.terminal_command(None, Some("native-123")).unwrap();
        assert_eq!(command.args, vec!["--session", "native-123"]);
    }
    #[test]
    fn history_item_never_serializes_optional_nulls() {
        let item = acp_history_item("kimi", &json!({"sessionId":"s1"})).unwrap();
        assert!(item.get("cwd").is_none());
        assert!(item["updatedAt"].is_string());
    }

    #[test]
    fn repair_fixture_normalizes_kimi_and_generic_acp_history() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/repair-native-history.json"
        ))
        .unwrap();
        let frames = fixture["acp"].as_array().unwrap();
        for provider in ["kimi", "gemini"] {
            let items = acp_transcript_for_provider(provider, frames);
            assert_eq!(
                items
                    .iter()
                    .map(|item| item["role"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                vec!["user", "assistant", "tool"]
            );
        }
    }
    #[test]
    fn plan_updates_project_one_upserted_plan_part() {
        let (sender, mut receiver) = crate::provider_events::tap_channel(8);
        let events = ScopedProviderEvents::new(sender, "worker");
        let native = Mutex::new(Some("parent".to_owned()));
        let active = Mutex::new(Some("turn-1".to_owned()));
        let permissions = Mutex::new(HashMap::new());
        let think = Mutex::new(false);
        let ui = Mutex::new(AcpUiState::default());
        emit_acp_message(
            &events,
            "kimi",
            "s",
            &native,
            &active,
            &permissions,
            &think,
            &ui,
            json!({"method":"session/update","params":{"sessionId":"parent","update":{"sessionUpdate":"plan","entries":[
                {"content":"Explore","status":"completed"},
                {"content":"Implement","status":"in_progress","priority":"high"}]}}}),
        );
        let event = receiver.try_recv().unwrap();
        assert_eq!(event.kind, "chat.item");
        assert_eq!(event.data["merge"], true);
        assert_eq!(event.data["part"]["type"], "plan");
        assert_eq!(event.data["part"]["toolId"], "plan:turn-1");
        assert_eq!(event.data["part"]["data"]["entries"][0]["status"], "completed");
        assert_eq!(event.data["part"]["data"]["entries"][1]["status"], "in_progress");
        assert_eq!(event.data["part"]["data"]["entries"][1]["priority"], "high");
        assert!(receiver.try_recv().is_err());
    }
    #[test]
    fn acp_history_derives_a_plan_part_and_keeps_the_latest() {
        let frames = vec![
            json!({"params":{"update":{"sessionUpdate":"plan","entries":[{"content":"One","status":"pending"}]}}}),
            json!({"params":{"update":{"sessionUpdate":"plan","entries":[{"content":"One","status":"completed"},{"content":"Two","status":"in_progress"}]}}}),
        ];
        let transcript = acp_transcript_for_provider("kimi", &frames);
        let plans: Vec<_> = transcript
            .iter()
            .flat_map(|item| item["parts"].as_array().unwrap())
            .filter(|part| part["type"] == "plan")
            .collect();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0]["data"]["entries"].as_array().unwrap().len(), 2);
        assert_eq!(plans[0]["data"]["entries"][0]["status"], "completed");
    }
    #[test]
    fn acp_plan_mapper_distinguishes_empty_snapshots_from_malformed_entries() {
        assert_eq!(acp_plan_data(&json!({"entries":[]})).unwrap()["entries"], json!([]));
        assert!(acp_plan_data(&json!({"entries":[{}]})).is_none());
    }
    #[test]
    fn acp_history_keeps_one_plan_per_user_turn() {
        let frames = vec![
            json!({"params":{"update":{"sessionUpdate":"user_message_chunk","content":{"text":"first"}}}}),
            json!({"params":{"update":{"sessionUpdate":"plan","entries":[{"content":"First plan","status":"pending"}]}}}),
            json!({"params":{"update":{"sessionUpdate":"user_message_chunk","content":{"text":"second"}}}}),
            json!({"params":{"update":{"sessionUpdate":"plan","entries":[{"content":"Second plan","status":"pending"}]}}}),
            json!({"params":{"update":{"sessionUpdate":"plan","entries":[{"content":"Second plan","status":"completed"}]}}}),
        ];
        let transcript = acp_transcript_for_provider("kimi", &frames);
        let plans: Vec<_> = transcript.iter().flat_map(|item| item["parts"].as_array().unwrap()).filter(|part| part["type"] == "plan").collect();
        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0]["toolId"], "plan:acp-0");
        assert_eq!(plans[0]["data"]["entries"][0]["content"], "First plan");
        assert_eq!(plans[1]["toolId"], "plan:acp-2");
        assert_eq!(plans[1]["data"]["entries"][0]["status"], "completed");
    }
    #[test]
    fn maps_thought_chunks_to_thinking_parts() {
        assert_eq!(acp_part_type("agent_thought_chunk"), Some("thinking"));
        assert_eq!(acp_part_type("agentThoughtChunk"), Some("thinking"));
        assert_eq!(acp_part_type("agent_message_chunk"), Some("text"));
        let transcript = acp_transcript(&[json!({
            "params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"plan"}}}
        })]);
        assert_eq!(transcript[0]["parts"][0]["type"], "thinking");
        assert_eq!(transcript[0]["parts"][0]["text"], "plan");
    }
    #[test]
    fn parses_kimi_config_options_and_slash_commands() {
        let mut state = AcpUiState::default();
        merge_acp_ui(
            &mut state,
            &json!({
                "configOptions":[{"configId":"model","name":"Model","currentValue":"kimi-for-coding","options":[{"value":"kimi-for-coding","name":"Kimi K2.5"}]}],
                "availableCommands":[{"name":"/compact","description":"Compact context"}]
            }),
        );
        assert_eq!(state.options[0]["id"], "model");
        assert_eq!(state.options[0]["value"], "kimi-for-coding");
        assert_eq!(state.commands[0]["name"], "compact");
    }

    #[test]
    fn preserves_generic_acp_mode_category_and_legacy_modes() {
        let mut state = AcpUiState::default();
        merge_acp_ui(&mut state, &json!({
            "configOptions":[{"configId":"permission","category":"mode","currentValue":"ask","options":[{"value":"ask"},{"value":"auto"}]}],
            "modes":{"availableModes":[{"id":"plan","name":"Plan"},{"id":"default","name":"Default"}],"currentModeId":"plan"}
        }));
        let permission = state.options.iter().find(|option| option["id"] == "permission").unwrap();
        assert_eq!(permission["category"], "mode");
        let mode = state.options.iter().find(|option| option["id"] == "mode").unwrap();
        assert_eq!(mode["category"], "mode");
        assert_eq!(mode["value"], "plan");
        assert!(state.legacy_mode);
    }

    #[test]
    fn modern_acp_mode_keeps_config_route_and_accepts_mode_notifications() {
        let mut state = AcpUiState::default();
        merge_acp_ui(&mut state, &json!({
            "configOptions":[{"id":"mode","category":"mode","currentValue":"plan","options":[{"value":"plan"},{"value":"auto"}]}],
            "modes":{"currentModeId":"default","availableModes":[{"id":"default"},{"id":"plan"}]}
        }));
        assert!(!state.legacy_mode, "the modern setter owns combined catalogues");
        assert_eq!(state.options[0]["value"], "plan");
        merge_acp_ui(&mut state, &json!({"sessionUpdate":"current_mode_update","currentModeId":"auto"}));
        assert_eq!(state.options[0]["value"], "auto", "native notifications remain authoritative with the modern setter");
        assert!(!state.legacy_mode);
    }

    #[test]
    fn kimi_already_active_exception_is_exact() {
        let exact = ProviderError::new("provider_error", "Internal error").with_details(json!({
            "code": -32603,
            "data": {"details": "Already in plan mode"}
        }));
        assert!(kimi_mode_already_active(&exact, "plan"));

        let generic = ProviderError::new("provider_error", "Internal error").with_details(json!({"code": -32603}));
        assert!(!kimi_mode_already_active(&generic, "plan"));
        assert!(!kimi_mode_already_active(&exact, "auto"));
        let wrong_code = ProviderError::new("provider_error", "Internal error").with_details(json!({
            "code": -32602,
            "data": {"details": "Already in plan mode"}
        }));
        assert!(!kimi_mode_already_active(&wrong_code, "plan"));
    }

    #[cfg(windows)]
    #[test]
    fn startup_mode_restore_uses_config_option_and_rejects_a_mismatch() {
        let Some(node) = crate::providers::common::find_executable("node") else { return; };
        for scenario in ["success", "mismatch", "kimi-already-plan"] {
            let dir = tempfile::tempdir().unwrap();
            let script = dir.path().join("acp-startup.mjs");
            let log = dir.path().join("calls.jsonl");
            let source = serde_json::to_string(&log.to_string_lossy()).unwrap();
            std::fs::write(&script, format!(r#"import {{createInterface}} from 'node:readline'; import {{appendFileSync}} from 'node:fs';
for (const key of Object.keys(process.env)) if(key.toUpperCase()==='PATH') delete process.env[key];
const log={source}, scenario='{scenario}';
const options=mode=>[{{configId:'mode',category:'mode',currentValue:mode,options:[{{value:'default'}},{{value:'auto'}},{{value:'plan'}}]}}];
const combined=mode=>({{sessionId:'native',configOptions:options(mode),modes:{{currentModeId:mode,availableModes:[{{id:'default',name:'Default'}},{{id:'auto',name:'Auto'}},{{id:'plan',name:'Plan'}}]}}}});
createInterface({{input:process.stdin}}).on('line', line=>{{
 const r=JSON.parse(line); appendFileSync(log,JSON.stringify(r)+'\n'); if(!r.id)return;
 const ok=x=>process.stdout.write(JSON.stringify({{jsonrpc:'2.0',id:r.id,result:x}})+'\n');
 const fail=(code,message,data)=>process.stdout.write(JSON.stringify({{jsonrpc:'2.0',id:r.id,error:{{code,message,data}}}})+'\n');
 if(r.method==='initialize')return ok({{agentCapabilities:{{sessionCapabilities:{{resume:{{}}}}}}}});
 if(r.method==='session/resume')return ok(combined('default'));
 if(r.method==='session/set_config_option'){{
   if(scenario==='kimi-already-plan')return fail(-32603,'Internal error',{{details:'Already in plan mode'}});
   return ok({{configOptions:options(scenario==='mismatch'?'default':r.params.value)}});
 }}
 ok({{}});
}});"#)).unwrap();
            let descriptor = AgentDescriptor { id:"kimi".into(), name:"Fake ACP".into(), plugin_id:None, icon:None, homepage:None, command:node.to_string_lossy().into_owned(), args:vec![script.to_string_lossy().into_owned()], version_args:vec![], terminal:None, chat_args:None, sign_in_args:None, plugin_dir:None };
            let adapter = AcpAdapter::from_descriptor(descriptor, crate::provider_events::tap_channel(8).0);
            let requested = if scenario == "kimi-already-plan" { "plan" } else { "auto" };
            let result = adapter.open_chat_with_startup_options("s", "C:/", Some("native"), "worker", None, &super::super::ChatStartupOptions {project_trust:None, permissions:&json!([{"id":"mode","value":requested}])});
            if scenario == "mismatch" {
                match result {
                    Err(error) => {
                        assert_eq!(error.code, "chat_permission_restore_failed");
                        assert_eq!(error.details.as_ref().and_then(|details| details.pointer("/permissionRestore/reason")).and_then(Value::as_str), Some("mismatch"));
                        assert_eq!(error.details.as_ref().and_then(|details| details.pointer("/permissionRestore/optionId")).and_then(Value::as_str), Some("mode"));
                        assert_eq!(error.details.as_ref().and_then(|details| details.pointer("/permissionRestore/savedValue")).and_then(Value::as_str), Some("auto"));
                        assert_eq!(error.details.as_ref().and_then(|details| details.pointer("/permissionRestore/reportedValue")).and_then(Value::as_str), Some("default"));
                    }
                    Ok(_) => panic!("mismatched mode must fail"),
                }
            } else {
                let chat = result.unwrap_or_else(|error| panic!("{}", error.message));
                assert_eq!(chat.ui_state()["options"].as_array().unwrap().iter().find(|option| option["id"] == "mode").unwrap()["value"], requested);
            }
            let calls = std::fs::read_to_string(log).unwrap().lines().map(|line| serde_json::from_str::<Value>(line).unwrap()).collect::<Vec<_>>();
            assert!(calls.iter().any(|call| call["method"] == "session/resume" && call["params"] == json!({"sessionId":"native","cwd":"C:/"})));
            assert!(calls.iter().any(|call| call["method"] == "session/set_config_option" && call["params"]["configId"] == "mode" && call["params"]["value"] == requested));
        }
    }

    #[test]
    fn maps_boolean_like_config_options_to_on_off_chips() {
        let mut state = AcpUiState::default();
        merge_acp_ui(
            &mut state,
            &json!({
                "configOptions":[
                    {"configId":"web","name":"Web access","type":"boolean","currentValue":"true","options":[{"value":"true","name":"On"},{"value":"false","name":"Off"}]},
                    {"configId":"review","name":"Review","currentValue":"on","options":[{"value":"on","name":"On"},{"value":"off","name":"Off"}]},
                    {"configId":"model","name":"Model","currentValue":"m","options":[{"value":"m","name":"M"}]}
                ]
            }),
        );
        assert_eq!(state.options[0]["kind"], "boolean");
        assert_eq!(state.options[0]["choices"][1]["value"], "false");
        assert_eq!(state.options[1]["kind"], "boolean");
        assert_eq!(state.options[2].get("kind"), None);
    }

    #[test]
    fn only_renderer_supported_acp_pairs_become_boolean_chips() {
        let choices = |yes: &str, no: &str| vec![json!({"value":yes}), json!({"value":no})];
        for pair in [("on", "off"), ("ON", "OFF"), ("true", "false"), ("FALSE", "TRUE")] {
            assert!(acp_option_is_boolean(&json!({}), &choices(pair.0, pair.1)), "{pair:?}");
        }
        for pair in [("yes", "no"), ("enabled", "disabled"), ("on", "false"), ("on", "on")] {
            assert!(!acp_option_is_boolean(&json!({}), &choices(pair.0, pair.1)), "{pair:?}");
        }
        assert!(!acp_option_is_boolean(&json!({}), &[json!({"value":"yes"}), json!({"value":"no"}), json!({"value":"on"})]));
        assert!(acp_option_is_boolean(&json!({"type":"boolean"}), &[]));
        assert!(!acp_option_is_boolean(&json!({"type":"boolean"}), &choices("yes", "no")));
    }

    /// A JSON-RPC ACP fixture: rejects `thinking`, normalizes accepted model
    /// values to uppercase, fails `model` set_config_option with
    /// method-not-found only when told to, and logs every method it receives.
    #[cfg(windows)]
    fn fake_acp_agent(
        dir: &std::path::Path,
        model_method_missing: bool,
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        let script = dir.join("fake-acp-agent.mjs");
        let log = dir.join("calls.log");
        let script_body = format!(
            r#"import {{ createInterface }} from 'node:readline';
import {{ appendFileSync }} from 'node:fs';
const log = {log:?};
const modelMethodMissing = {model_method_missing};
createInterface({{ input: process.stdin, crlfDelay: Infinity }}).on('line', line => {{
  let req; try {{ req = JSON.parse(line); }} catch {{ return; }}
  if (typeof req.method !== 'string') return;
  appendFileSync(log, req.method + '\n');
  const reply = result => process.stdout.write(JSON.stringify({{ jsonrpc: '2.0', id: req.id, result }}) + '\n');
  const fail = (code, message) => process.stdout.write(JSON.stringify({{ jsonrpc: '2.0', id: req.id, error: {{ code, message }} }}) + '\n');
  if (req.method === 'session/set_config_option') {{
    const {{ configId, value }} = req.params;
    if (configId === 'thinking') return fail(-32602, 'Invalid params: thinking does not support this value');
    if (configId === 'model' && modelMethodMissing) return fail(-32601, 'Method not found: session/set_config_option');
    if (configId === 'model' && value === 'bad-model') return fail(-32602, 'Invalid params: unknown model');
    if (configId === 'model') return reply({{ configOptions: [{{ configId: 'model', name: 'Model', currentValue: String(value).toUpperCase(), options: [] }}] }});
    return reply({{ configOptions: [{{ configId, name: configId, currentValue: value, options: [] }}] }});
  }}
  if (req.method === 'session/set_model') return reply({{ configOptions: [{{ configId: 'model', name: 'Model', currentValue: req.params.modelId, options: [] }}] }});
  reply({{}});
}});
"#,
            log = log.to_string_lossy().replace('\\', "\\\\"),
            model_method_missing = model_method_missing,
        );
        std::fs::write(&script, script_body).unwrap();
        (script, log)
    }

    #[cfg(windows)]
    fn fake_acp_chat(script: &std::path::Path) -> Option<AcpChat> {
        let node = crate::providers::common::find_executable("node")?;
        let spec = crate::providers::common::CommandSpec::from_path(
            node,
            vec![script.to_string_lossy().into_owned()],
        )
        .unwrap();
        let process = crate::providers::common::JsonLineProcess::spawn(
            "fake-acp",
            &spec,
            None,
            &[],
            crate::providers::common::EnvelopeStyle::JsonRpc2,
            Arc::new(|_| {}),
        )
        .unwrap();
        let (events, _) = crate::provider_events::tap_channel(16);
        Some(AcpChat {
            provider: "kimi".into(),
            process,
            session_id: "s".into(),
            native_id: "n".into(),
            events: ScopedProviderEvents::new(events, "test-worker"),
            active_turn: Arc::new(Mutex::new(None)),
            permissions: Arc::new(Mutex::new(HashMap::new())),
            ui: Arc::new(Mutex::new(AcpUiState::default())),
        })
    }

    #[cfg(windows)]
    struct FakeAcp {
        _dir: tempfile::TempDir,
        log: std::path::PathBuf,
        chat: AcpChat,
    }

    #[cfg(windows)]
    fn fake_acp(model_method_missing: bool) -> Option<FakeAcp> {
        let dir = tempfile::tempdir().unwrap();
        let (script, log) = fake_acp_agent(dir.path(), model_method_missing);
        let chat = fake_acp_chat(&script)?;
        Some(FakeAcp {
            _dir: dir,
            log,
            chat,
        })
    }

    #[cfg(windows)]
    fn logged_methods(log: &std::path::Path) -> Vec<String> {
        std::fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[cfg(windows)]
    fn acp_fork_fixture(advertise_fork: bool) -> Option<(AcpAdapter, std::path::PathBuf, tempfile::TempDir)> {
        let node = crate::providers::common::find_executable("node")?;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-acp-fork.mjs");
        let log = dir.path().join("fork-calls.jsonl");
        let source = log.to_string_lossy().replace('\\', "\\\\");
        std::fs::write(&script, format!(r#"import {{ createInterface }} from 'node:readline';
import {{ appendFileSync }} from 'node:fs';
const log = {source:?};
const fork = {advertise_fork};
createInterface({{input:process.stdin,crlfDelay:Infinity}}).on('line', line => {{
  const frame = JSON.parse(line);
  appendFileSync(log, JSON.stringify(frame)+'\n');
  if (!frame.id) return;
  const reply = result => process.stdout.write(JSON.stringify({{jsonrpc:'2.0',id:frame.id,result}})+'\n');
  if (frame.method === 'initialize') return reply({{agentCapabilities:{{sessionCapabilities:{{load:{{}},fork:fork?{{}}:false}}}}}});
  if (frame.method === 'session/load') return reply({{sessionId:frame.params.sessionId}});
  if (frame.method === 'session/fork') return reply({{sessionId:'forked-session'}});
  reply({{}});
}});
"#))
        .unwrap();
        let descriptor = AgentDescriptor {
            id: "fake-acp-fork".into(), name: "Fake ACP fork".into(), plugin_id: None,
            icon: None, homepage: None, command: node.to_string_lossy().into_owned(),
            args: vec![script.to_string_lossy().into_owned()], version_args: vec![], terminal: None,
            chat_args: None, sign_in_args: None, plugin_dir: None,
        };
        let (events, _) = crate::provider_events::tap_channel(8);
        Some((AcpAdapter::from_descriptor(descriptor, events), log, dir))
    }

    #[cfg(windows)]
    #[test]
    fn acp_native_fork_loads_the_source_then_returns_the_child_without_touching_it() {
        let Some((adapter, log, _dir)) = acp_fork_fixture(true) else {
            eprintln!("node is unavailable; skipping ACP fork fixture test");
            return;
        };
        assert_eq!(
            adapter.fork_session("C:/workspace", "source-session", None, true).unwrap(),
            Some("forked-session".to_owned())
        );
        let calls = std::fs::read_to_string(&log).unwrap().lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap()).collect::<Vec<_>>();
        let load = calls.iter().find(|call| call["method"] == "session/load").unwrap();
        let fork = calls.iter().find(|call| call["method"] == "session/fork").unwrap();
        let expected = json!({"sessionId":"source-session","cwd":"C:/workspace","mcpServers":[]});
        assert_eq!(load["params"], expected);
        assert_eq!(fork["params"], expected);
        assert!(!calls.iter().any(|call| call.pointer("/params/sessionId") == Some(&json!("forked-session"))), "source identity must remain the only loaded/forked session");

        let Some((older, older_log, _older_dir)) = acp_fork_fixture(true) else { return; };
        assert_eq!(older.fork_session("C:/workspace", "source-session", None, false).unwrap(), None);
        assert!(!older_log.exists() || std::fs::read_to_string(older_log).unwrap().is_empty(), "earlier replies must not start ACP native fork traffic");
    }

    /// The audit reproduction: the agent rejects a thinking change, and no
    /// set_model rescue may follow. The UI must keep the previous value.
    #[cfg(windows)]
    #[test]
    fn a_rejected_non_model_setting_never_falls_back_to_set_model() {
        let Some(mut fake) = fake_acp(false) else {
            eprintln!("node is unavailable; skipping ACP fixture test");
            return;
        };
        let error = fake.chat.set_option("thinking", "high").unwrap_err();
        assert!(
            error.message.contains("thinking"),
            "the original setting error must surface: {}",
            error.message
        );
        assert!(
            !logged_methods(&fake.log)
                .iter()
                .any(|method| method == "session/set_model"),
            "a rejected thinking change must not call session/set_model"
        );
        assert!(fake.chat.ui.lock().unwrap().options.is_empty());
    }

    /// Only a method-not-found error for the model option may use the legacy
    /// session/set_model interface; invalid values must not trigger it.
    #[cfg(windows)]
    #[test]
    fn model_fallback_is_limited_to_method_not_found() {
        let Some(mut missing) = fake_acp(true) else {
            eprintln!("node is unavailable; skipping ACP fixture test");
            return;
        };
        let state = missing.chat.set_option("model", "k2").unwrap();
        assert!(
            logged_methods(&missing.log)
                .iter()
                .any(|method| method == "session/set_model"),
            "method-not-found for the model option must try the legacy interface"
        );
        let model = state["options"]
            .as_array()
            .unwrap()
            .iter()
            .find(|option| option["id"] == "model")
            .cloned()
            .unwrap();
        assert_eq!(
            model["value"], "k2",
            "the legacy interface reply carries the confirmed value"
        );

        let Some(mut invalid) = fake_acp(false) else {
            return;
        };
        let error = invalid.chat.set_option("model", "bad-model").unwrap_err();
        assert!(error.message.contains("unknown model"));
        assert!(
            !logged_methods(&invalid.log)
                .iter()
                .any(|method| method == "session/set_model"),
            "an invalid model value must not trigger the fallback"
        );
    }

    /// A successful set adopts the agent-normalized value, not the submitted one.
    #[cfg(windows)]
    #[test]
    fn a_successful_set_adopts_the_agent_confirmed_value() {
        let Some(mut fake) = fake_acp(false) else {
            eprintln!("node is unavailable; skipping ACP fixture test");
            return;
        };
        let state = fake.chat.set_option("model", "k2").unwrap();
        let model = state["options"]
            .as_array()
            .unwrap()
            .iter()
            .find(|option| option["id"] == "model")
            .cloned()
            .unwrap();
        assert_eq!(
            model["value"], "K2",
            "the agent-normalized value must win over the submitted text"
        );
    }
    #[test]
    fn splits_kimi_think_tags_across_chunks() {
        let mut open = false;
        assert_eq!(
            split_kimi_think_stream(&mut open, "<think>plan"),
            vec![("thinking", "plan".to_string())]
        );
        assert!(open);
        assert_eq!(
            split_kimi_think_stream(&mut open, " more</think>hello"),
            vec![
                ("thinking", " more".to_string()),
                ("text", "hello".to_string())
            ]
        );
        assert!(!open);
    }
    #[test]
    fn parses_slash_command_name_and_args() {
        assert_eq!(parse_slash("/model"), Some(("model", "")));
        assert_eq!(
            parse_slash("/model kimi-code/k3"),
            Some(("model", "kimi-code/k3"))
        );
        assert_eq!(parse_slash("  /plan  on "), Some(("plan", "on")));
        assert_eq!(parse_slash("hello"), None);
        assert_eq!(parse_slash("//"), None);
        assert_eq!(parse_slash("/"), None);
        assert_eq!(parse_slash("text /model"), None);
    }
    #[test]
    fn matches_choices_by_value_name_or_substring() {
        let choices = vec![
            json!({"value":"kimi-code/k3","name":"K3"}),
            json!({"value":"kimi-code/kimi-for-coding","name":"K2.8 Preview"}),
        ];
        assert_eq!(
            match_choice(&choices, "kimi-code/k3"),
            Some(("kimi-code/k3".to_owned(), "K3".to_owned()))
        );
        assert_eq!(
            match_choice(&choices, "K3"),
            Some(("kimi-code/k3".to_owned(), "K3".to_owned()))
        );
        assert_eq!(
            match_choice(&choices, "preview"),
            Some((
                "kimi-code/kimi-for-coding".to_owned(),
                "K2.8 Preview".to_owned()
            ))
        );
        assert_eq!(match_choice(&choices, "nonexistent"), None);
        assert_eq!(match_choice(&[], "k3"), None);
    }
    #[test]
    fn option_listing_marks_current_value_and_choices() {
        let option = json!({"id":"mode","name":"Mode","value":"default"});
        let choices = vec![
            json!({"value":"default","name":"Default"}),
            json!({"value":"plan","name":"Plan"}),
        ];
        assert_eq!(
            format_option_listing("Mode", &option, &choices),
            "Mode: Default (default)\nChoices:\n  default — Default\n  plan — Plan"
        );
    }
    #[test]
    fn local_commands_merge_into_the_menu_once() {
        let merged = merge_local_commands("kimi", vec![json!({"name":"usage"})]);
        assert!(merged.iter().any(|command| command["name"] == "model"));
        assert!(merged.iter().any(|command| command["name"] == "usage"));
        let again = merge_local_commands("kimi", merged.clone());
        assert_eq!(again.len(), merged.len());
        let gemini = merge_local_commands("gemini", vec![json!({"name":"usage"})]);
        assert!(!gemini.iter().any(|command| command["name"] == "model"));
    }
    #[test]
    fn guidance_covers_every_documented_tui_only_command() {
        for name in [
            "login",
            "new",
            "clear",
            "sessions",
            "resume",
            "title",
            "rename",
            "undo",
            "reload",
            "reload-tui",
            "theme",
            "settings",
            "config",
            "experiments",
            "experimental",
            "editor",
            "provider",
            "plugins",
            "feedback",
            "bug",
            "copy",
            "add-dir",
            "web",
            "exit",
            "quit",
            "q",
            "btw",
            "swarm",
            "goal",
            "secondary-model",
            "subagent-model",
            "export",
            "export-md",
        ] {
            assert!(
                kimi_command_guidance(name).is_some(),
                "no guidance for /{name}"
            );
        }
        assert!(kimi_command_guidance("usage").is_none());
        assert!(kimi_command_guidance("nonsense").is_none());
    }

    #[test]
    fn transcript_drops_reminder_only_user_chunk() {
        let transcript = acp_transcript(&[json!({
            "params":{"update":{"sessionUpdate":"user_message_chunk","content":{"text":"<system-reminder>private</system-reminder>"}}}
        })]);
        assert!(transcript.is_empty());
    }

    #[test]
    fn transcript_keeps_user_text_around_reminder() {
        let transcript = acp_transcript(&[json!({
            "params":{"update":{"sessionUpdate":"user_message_chunk","content":{"text":"  Hello <system-reminder>private</system-reminder> world  "}}}
        })]);
        assert_eq!(transcript[0]["parts"][0]["text"], "Hello  world");
        let streamed = acp_transcript(&[
            json!({"params":{"update":{"sessionUpdate":"user_message_chunk","content":{"text":"hello "}}}}),
            json!({"params":{"update":{"sessionUpdate":"user_message_chunk","content":{"text":"world"}}}}),
        ]);
        assert_eq!(streamed[0]["parts"][0]["text"], "hello world");
        assert_eq!(
            strip_acp_system_reminders(
                "keep <system-reminder>private</system-reminder> <system-reminder>unfinished"
            ),
            "keep  <system-reminder>unfinished"
        );
    }

    #[test]
    fn transcript_merges_chunked_thinking_and_text_reply() {
        let transcript = acp_transcript(&[
            json!({"params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"text":"plan "}}}}),
            json!({"params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"text":"more"}}}}),
            json!({"params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"answer"}}}}),
            json!({"params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":" "}}}}),
            json!({"params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"reply"}}}}),
            json!({"params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":""}}}}),
        ]);
        assert_eq!(transcript.len(), 1);
        assert_eq!(transcript[0]["id"], "acp-0");
        assert_eq!(transcript[0]["parts"], json!([
            {"type":"thinking","text":"plan more"},
            {"type":"text","text":"answer reply"},
        ]));
    }

    #[test]
    fn transcript_preserves_user_assistant_alternation() {
        let transcript = acp_transcript(&[
            json!({"params":{"update":{"sessionUpdate":"user_message_chunk","content":{"text":"one"}}}}),
            json!({"params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"two"}}}}),
            json!({"params":{"update":{"sessionUpdate":"user_message_chunk","content":{"text":"three"}}}}),
        ]);
        assert_eq!(transcript.len(), 3);
        assert_eq!(transcript[0]["role"], "user");
        assert_eq!(transcript[1]["role"], "assistant");
        assert_eq!(transcript[2]["role"], "user");
    }

    #[test]
    fn transcript_tool_call_splits_assistant_chunks() {
        let transcript = acp_transcript(&[
            json!({"params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"before"}}}}),
            json!({"params":{"update":{"sessionUpdate":"tool_call","toolCallId":"tool-1","title":"Read"}}}),
            json!({"params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"after"}}}}),
        ]);
        assert_eq!(transcript.len(), 3);
        assert_eq!(transcript[0]["parts"][0]["text"], "before");
        assert_eq!(transcript[1]["role"], "tool");
        assert_eq!(transcript[2]["parts"][0]["text"], "after");
    }
}
