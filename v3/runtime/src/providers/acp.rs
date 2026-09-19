use super::{
    approval::{
        acp_choices, acp_title, approval_payload, drain_inactive_approvals, find_choice,
        validate_turn, write_failed_not_sent, ApprovalChoice, PendingApprovalState,
    },
    common::{
        command_output, encode_approval_id, history_page, insert_optional, validate_native_id,
        version_probe, CommandSpec, EnvelopeStyle, JsonLineProcess,
    },
    emit, ChatSession, ProviderAdapter, ProviderCapability, ProviderError, ProviderEvent,
    TerminalCommand,
};
use chrono::Utc;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::broadcast;

#[derive(Clone, Copy)]
enum AcpKind {
    Kimi,
    Gemini,
}

impl AcpKind {
    fn id(self) -> &'static str {
        match self {
            Self::Kimi => "kimi",
            Self::Gemini => "gemini",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Kimi => "Kimi",
            Self::Gemini => "Gemini",
        }
    }
    fn command(self) -> &'static str {
        self.id()
    }
    fn acp_args(self) -> &'static [&'static str] {
        match self {
            Self::Kimi => &["acp"],
            Self::Gemini => &["--acp"],
        }
    }
}

pub struct AcpAdapter {
    kind: AcpKind,
    events: broadcast::Sender<ProviderEvent>,
}

impl AcpAdapter {
    pub fn kimi(events: broadcast::Sender<ProviderEvent>) -> Self {
        Self {
            kind: AcpKind::Kimi,
            events,
        }
    }
    pub fn gemini(events: broadcast::Sender<ProviderEvent>) -> Self {
        Self {
            kind: AcpKind::Gemini,
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
        project_events: bool,
    ) -> Result<(JsonLineProcess, Value), ProviderError> {
        let spec = CommandSpec::provider(self.kind.command(), self.kind.acp_args())?;
        let events = self.events.clone();
        let provider = self.kind.id();
        let owned_session = session_id.to_owned();
        let think_open = Arc::new(Mutex::new(false));
        let on_message = Arc::new(move |raw: Value| {
            if let Some(capture) = &capture {
                if let Ok(mut values) = capture.lock() {
                    values.push(raw.clone());
                }
            }
            // While session/load or session/resume is in flight the agent
            // replays the transcript as session/update notifications; they
            // carry no turn id, so projecting them would append a duplicate
            // phantom message under the "current" key on every reconnect.
            if project_events && !replay_gate.load(Ordering::SeqCst) {
                emit_acp_message(
                    &events,
                    provider,
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
        let process = JsonLineProcess::spawn(
            format!("{}-acp", self.kind.id()),
            &spec,
            None,
            &[],
            EnvelopeStyle::JsonRpc2,
            on_message,
        )?;
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
            false,
        )
    }
}

impl ProviderAdapter for AcpAdapter {
    fn id(&self) -> &'static str {
        self.kind.id()
    }

    fn capability(&self) -> ProviderCapability {
        let (installed, version, probe_error) = version_probe(self.kind.command());
        let protocol = if installed {
            self.temporary(None)
                .map(|(_, initialized)| initialized)
                .map_err(|error| error.message)
        } else {
            Err(format!("{} CLI is not installed", self.kind.name()))
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
            id: self.kind.id().to_owned(),
            name: self.kind.name().to_owned(),
            installed,
            version,
            terminal: installed,
            chat,
            history,
            resume,
            reason: protocol.err().or(probe_error),
            auth: "unknown".to_owned(),
        }
    }

    fn terminal_command(&self, native_id: Option<&str>) -> Result<TerminalCommand, ProviderError> {
        let args = match (self.kind, native_id) {
            (AcpKind::Kimi, Some(id)) => {
                validate_native_id(id)?;
                vec!["--session".to_owned(), id.to_owned()]
            }
            (AcpKind::Gemini, Some(id)) => {
                validate_native_id(id)?;
                vec!["--resume".to_owned(), id.to_owned()]
            }
            (_, None) => Vec::new(),
        };
        let path = super::common::find_executable(self.kind.command()).ok_or_else(|| {
            ProviderError::unavailable(
                self.kind.id(),
                format!("{} executable was not found on PATH", self.kind.command()),
            )
        })?;
        let spec = CommandSpec::from_path(path, args);
        Ok(TerminalCommand {
            program: spec.program,
            args: spec.args,
            display: spec.display,
        })
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
            .filter_map(|row| acp_history_item(self.kind.id(), &row))
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
        Ok(Value::Array(acp_transcript(&raw)))
    }

    fn open_chat(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        if matches!(self.kind, AcpKind::Kimi) {
            super::kimi_plan_usage::prefetch();
        }
        let native = Arc::new(Mutex::new(None));
        let active_turn = Arc::new(Mutex::new(None));
        let permissions = Arc::new(Mutex::new(HashMap::new()));
        let ui = Arc::new(Mutex::new(AcpUiState::default()));
        let replay_gate = Arc::new(AtomicBool::new(false));
        let (process, initialized) = self.spawn(
            session_id,
            Arc::clone(&native),
            Arc::clone(&active_turn),
            Arc::clone(&permissions),
            Arc::clone(&ui),
            None,
            Arc::clone(&replay_gate),
            true,
        )?;
        let response = if let Some(id) = native_id {
            validate_native_id(id)?;
            replay_gate.store(true, Ordering::SeqCst);
            let loaded = if has_capability(&initialized, "load") {
                process.request(
                    "session/load",
                    json!({"sessionId":id,"cwd":cwd,"mcpServers":[]}),
                )
            } else if has_capability(&initialized, "resume") {
                process.request("session/resume", json!({"sessionId":id,"cwd":cwd}))
            } else {
                Err(ProviderError::new(
                    "resume_unsupported",
                    format!(
                        "{} ACP agent does not advertise session resume",
                        self.kind.name()
                    ),
                ))
            };
            replay_gate.store(false, Ordering::SeqCst);
            loaded?
        } else {
            process.request("session/new", json!({"cwd":cwd,"mcpServers":[]}))?
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
            &self.events,
            self.kind.id(),
            session_id,
            Some(&bound_id),
            &ui,
        );
        emit(
            &self.events,
            self.kind.id(),
            session_id,
            Some(&bound_id),
            None,
            "session.ready",
            json!({"nativeId":bound_id}),
        );
        Ok(Box::new(AcpChat {
            provider: self.kind.id(),
            process,
            session_id: session_id.to_owned(),
            native_id: bound_id,
            cwd: cwd.to_owned(),
            events: self.events.clone(),
            active_turn,
            permissions,
            ui,
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
struct AcpUiState {
    options: Vec<Value>,
    commands: Vec<Value>,
    last_emitted: Option<String>,
    usage_reply: Option<PendingUsageReply>,
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
    events: broadcast::Sender<ProviderEvent>,
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
    provider: &'static str,
    process: JsonLineProcess,
    session_id: String,
    native_id: String,
    cwd: String,
    events: broadcast::Sender<ProviderEvent>,
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
            "fork" => self.fork_command(operation_id).map(Some),
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
            self.provider,
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
        match self.set_option("mode", mode) {
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

    fn fork_command(&mut self, operation_id: &str) -> Result<Value, ProviderError> {
        match self.process.request(
            "session/fork",
            json!({"sessionId":self.native_id,"cwd":self.cwd,"mcpServers":[]}),
        ) {
            Ok(value) => {
                let forked = value
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("(unknown)");
                self.reply_command(
                    operation_id,
                    &format!("Forked this session to {forked}. Resume it from the history rail; this chat stays on the original session."),
                );
            }
            Err(error) => {
                self.reply_command(operation_id, &format!("Fork failed: {}", error.message))
            }
        }
        Ok(json!({"turnId":operation_id}))
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
        let provider = self.provider;
        let session_id = self.session_id.clone();
        let native_id = self.native_id.clone();
        let turn_id = operation_id.to_owned();
        let active = Arc::clone(&self.active_turn);
        let permissions = Arc::clone(&self.permissions);
        let started = std::time::Instant::now();
        let request = self.process.request_async(
            "session/prompt",
            json!({
                "sessionId":self.native_id,"prompt":[{"type":"text","text":text}]
            }),
            move |result| {
                if let Ok(mut value) = active.lock() {
                    *value = None;
                }
                if let Ok(mut pending) = permissions.lock() {
                    drain_inactive_approvals(&mut pending, |item| item.turn_id.as_deref(), None);
                }
                match result {
                    Ok(value) => {
                        emit(
                            &events,
                            provider,
                            &session_id,
                            Some(&native_id),
                            Some(&turn_id),
                            "chat.turn.completed",
                            json!({"result":value,"elapsedMs":(provider == "kimi").then(|| started.elapsed().as_millis() as u64)}),
                        );
                    }
                    Err(error) => emit(
                        &events,
                        provider,
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
            if let Ok(mut pending) = self.permissions.lock() {
                drain_inactive_approvals(&mut pending, |item| item.turn_id.as_deref(), None);
            }
            return Err(error);
        }
        emit(
            &self.events,
            self.provider,
            &self.session_id,
            Some(&self.native_id),
            Some(operation_id),
            "chat.turn.started",
            json!({}),
        );
        Ok(json!({"turnId":operation_id}))
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
        let mut permissions = self
            .permissions
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "ACP permission lock poisoned"))?;
        match result {
            Ok(()) => {
                permissions.remove(approval_id);
                emit(
                    &self.events,
                    self.provider,
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
                    self.provider,
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
            .map(|state| json!({"options":state.options.clone(),"commands":state.commands.clone()}))
            .unwrap_or_else(|| json!({"options":[],"commands":[]}))
    }

    fn set_option(&mut self, option_id: &str, value: &str) -> Result<Value, ProviderError> {
        let result = self.process.request(
            "session/set_config_option",
            json!({"sessionId":self.native_id,"configId":option_id,"value":value}),
        );
        let result = match result {
            Ok(value) => value,
            Err(_) => self.process.request(
                "session/set_model",
                json!({"sessionId":self.native_id,"modelId":value}),
            )?,
        };
        if let Ok(mut state) = self.ui.lock() {
            merge_acp_ui(&mut state, &result);
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
            self.provider,
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

#[allow(clippy::too_many_arguments)]
fn emit_acp_message(
    events: &broadcast::Sender<ProviderEvent>,
    provider: &str,
    session_id: &str,
    native: &Mutex<Option<String>>,
    active_turn: &Mutex<Option<String>>,
    permissions: &Mutex<HashMap<String, PermissionRequest>>,
    think_open: &Mutex<bool>,
    ui: &Mutex<AcpUiState>,
    raw: Value,
) {
    let native_id = raw
        .get("params")
        .and_then(|p| p.get("sessionId"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| native.lock().ok().and_then(|v| v.clone()));
    let method = raw
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("provider.event");
    let params = raw.get("params").cloned().unwrap_or_else(|| raw.clone());
    let turn_id = params
        .get("turnId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| active_turn.lock().ok().and_then(|value| value.clone()));
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
        let payload = approval_payload(
            &approval_id,
            provider,
            "session/request_permission",
            &acp_title(&params),
            &params,
            &choices,
            turn_id.as_deref(),
            !choices.is_empty(),
        );
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
                "choices":choices,
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
    {
        if let Ok(mut state) = ui.lock() {
            merge_acp_ui(&mut state, update);
            merge_acp_ui(&mut state, &params);
        }
        emit_chat_ui(events, provider, session_id, native_id.as_deref(), ui);
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
            );
            return;
        }
    }
    let event_kind = if kind.contains("tool_call") || kind.contains("toolCall") {
        "chat.item"
    } else {
        "provider.event"
    };
    emit(
        events,
        provider,
        session_id,
        native_id.as_deref(),
        turn_id.as_deref(),
        event_kind,
        json!({"raw":raw}),
    );
}

fn acp_part_type(kind: &str) -> Option<&'static str> {
    match kind {
        "agent_thought_chunk" | "agentThoughtChunk" => Some("thinking"),
        "agent_message_chunk" | "agentMessageChunk" | "message" => Some("text"),
        _ => None,
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_chat_delta(
    events: &broadcast::Sender<ProviderEvent>,
    provider: &str,
    session_id: &str,
    native_id: Option<&str>,
    turn_id: Option<&str>,
    part_type: &str,
    text: &str,
    raw: &Value,
) {
    emit(
        events,
        provider,
        session_id,
        native_id,
        turn_id,
        "chat.delta",
        json!({"part":{"type":part_type,"text":text,"status":"streaming"},"raw":raw}),
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
    events: &broadcast::Sender<ProviderEvent>,
    provider: &str,
    session_id: &str,
    native_id: Option<&str>,
    ui: &Mutex<AcpUiState>,
) {
    let mut state = ui.lock().ok();
    let data = state
        .as_ref()
        .map(|value| {
            json!({"sessionId":session_id,"options":value.options.clone(),"commands":merge_local_commands(provider, value.commands.clone())})
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

fn merge_acp_ui(state: &mut AcpUiState, value: &Value) {
    if let Some(options) = value
        .get("configOptions")
        .or_else(|| value.get("availableConfigOptions"))
        .and_then(Value::as_array)
    {
        let parsed: Vec<Value> = options.iter().filter_map(parse_acp_option).collect();
        if !parsed.is_empty() {
            state.options = parsed;
        }
    }
    if let Some(option) = value.get("configOption").or_else(|| value.get("option")) {
        if let Some(parsed) = parse_acp_option(option) {
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
    Some(json!({"id":id,"name":name,"value":current,"choices":choices}))
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

fn acp_transcript(raw: &[Value]) -> Vec<Value> {
    raw.iter().enumerate().filter_map(|(index, message)| {
        let update = message.get("params")?.get("update")?;
        let kind = update.get("sessionUpdate").or_else(|| update.get("type"))?.as_str()?;
        let content = update.get("content").unwrap_or(update);
        let text = content.get("text").and_then(Value::as_str)?;
        let part_type = acp_part_type(kind).unwrap_or("text");
        let role = if kind.contains("user") { "user" } else if kind.contains("thought") || kind.contains("Thought") || kind.contains("agent") || kind.contains("assistant") { "assistant" } else { return None; };
        Some(json!({"id":format!("acp-{index}"),"role":role,"parts":[{"type":part_type,"text":text}],"createdAt":Utc::now().to_rfc3339()}))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage_reply_fixture() -> (UsageReplyContext, broadcast::Receiver<ProviderEvent>) {
        let (events, receiver) = broadcast::channel(16);
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
        let (events, mut receiver) = broadcast::channel(256);
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
    fn history_item_never_serializes_optional_nulls() {
        let item = acp_history_item("kimi", &json!({"sessionId":"s1"})).unwrap();
        assert!(item.get("cwd").is_none());
        assert!(item["updatedAt"].is_string());
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
}
