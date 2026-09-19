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
    emit, ChatSession, ProviderAdapter, ProviderCapability, ProviderError, ProviderEvent,
    TerminalCommand,
};
use chrono::Utc;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};
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
    events: broadcast::Sender<ProviderEvent>,
    network: super::network::NetworkSettings,
}

impl GrokAdapter {
    pub fn new(
        events: broadcast::Sender<ProviderEvent>,
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
        project_events: bool,
    ) -> Result<(JsonLineProcess, Value), ProviderError> {
        // `--no-leader` is an `grok agent` flag, not `grok agent stdio`.
        // Putting it after `stdio` makes the process exit immediately with
        // "unexpected argument" and Chat surfaces "grok-acp closed its output stream".
        let spec = CommandSpec::provider("grok", &["agent", "--no-leader", "stdio"])?;
        let events = self.events.clone();
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
            id: "grok".to_owned(),
            name: "Grok".to_owned(),
            installed,
            version,
            terminal: installed,
            chat,
            history,
            resume,
            reason: protocol.err().or(probe_error),
            auth: grok_auth_state(),
        }
    }

    fn terminal_command(&self, native_id: Option<&str>) -> Result<TerminalCommand, ProviderError> {
        let args = if let Some(id) = native_id {
            validate_native_id(id)?;
            vec!["--resume".to_owned(), id.to_owned()]
        } else {
            Vec::new()
        };
        let path = super::common::find_executable("grok").ok_or_else(|| {
            ProviderError::unavailable("grok", "grok executable was not found on PATH")
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
        let native = Arc::new(Mutex::new(None));
        let active_turn = Arc::new(Mutex::new(None));
        let permissions = Arc::new(Mutex::new(HashMap::new()));
        let ui = Arc::new(Mutex::new(GrokUiState::default()));
        let (process, initialized) = self.spawn(
            session_id,
            Arc::clone(&native),
            Arc::clone(&active_turn),
            Arc::clone(&permissions),
            Arc::clone(&ui),
            None,
            true,
        )?;
        let response = if let Some(id) = native_id {
            validate_native_id(id)?;
            if has_capability(&initialized, "load") {
                process.request(
                    "session/load",
                    json!({"sessionId":id,"cwd":cwd,"mcpServers":[]}),
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
            process.request("session/new", json!({"cwd":cwd,"mcpServers":[]}))?
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
        emit_chat_ui(&self.events, session_id, Some(&bound_id), &ui);
        emit(
            &self.events,
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
            events: self.events.clone(),
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
}

struct GrokChat {
    process: JsonLineProcess,
    session_id: String,
    native_id: String,
    events: broadcast::Sender<ProviderEvent>,
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
    events: broadcast::Sender<ProviderEvent>,
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
    events: &broadcast::Sender<ProviderEvent>,
    session_id: &str,
    native: &Mutex<Option<String>>,
    active_turn: &Mutex<Option<String>>,
    permissions: &Mutex<HashMap<String, PermissionRequest>>,
    ui: &Mutex<GrokUiState>,
    responder: &Mutex<Option<JsonLineResponder>>,
    raw: Value,
) {
    if reject_unknown_grok_rpc(responder, &raw) {
        return;
    }
    let native_id = raw
        .get("params")
        .and_then(|params| params.get("sessionId"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| native.lock().ok().and_then(|value| value.clone()));
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
            "grok",
            "session/request_permission",
            &acp_title(&params),
            &params,
            &choices,
            turn_id.as_deref(),
            !choices.is_empty(),
        );
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
    events: &broadcast::Sender<ProviderEvent>,
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
    part
}

fn emit_chat_ui(
    events: &broadcast::Sender<ProviderEvent>,
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
    raw.iter()
        .enumerate()
        .filter_map(|(index, message)| {
            let update = message.get("params")?.get("update")?;
            let kind = update
                .get("sessionUpdate")
                .or_else(|| update.get("type"))?
                .as_str()?;
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
        .collect()
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
        let (events, receiver) = broadcast::channel(16);
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
