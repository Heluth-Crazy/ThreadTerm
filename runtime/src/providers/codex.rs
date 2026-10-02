use super::{
    approval::{
        approval_payload, codex_choices, codex_response, drain_inactive_approvals, find_choice,
        validate_codex_turn, write_failed_not_sent, ApprovalChoice, PendingApprovalState,
    },
    common::{
        encode_approval_id, history_page, insert_optional, validate_native_id, version_probe,
        CommandSpec, EnvelopeStyle, JsonLineProcess, JsonLineResponder,
    },
    emit_scoped, ChatSession, ChatToolServer, ProviderAdapter, ProviderCapability, ProviderError,
    ProviderEvent, TerminalCommand,
};
use chrono::{TimeZone, Utc};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::broadcast;

pub struct CodexAdapter {
    events: broadcast::Sender<ProviderEvent>,
}

impl CodexAdapter {
    pub fn new(events: broadcast::Sender<ProviderEvent>) -> Self {
        Self { events }
    }

    #[allow(clippy::too_many_arguments)]
    fn process(
        &self,
        session_id: &str,
        native: Arc<Mutex<Option<String>>>,
        approvals: Arc<Mutex<HashMap<String, PendingCodexApproval>>>,
        active_turn: CodexTurnState,
        ui: Arc<Mutex<CodexUiState>>,
        responder: Arc<Mutex<Option<JsonLineResponder>>>,
        project_events: bool,
        worker_token: &str,
        tools: Option<&ChatToolServer>,
    ) -> Result<JsonLineProcess, ProviderError> {
        // Stdio is the native default, including releases predating --stdio.
        // One app-server per Chat, so `-c` overrides attach this session's
        // tool server without touching the user's config.toml.
        let mut args = codex_tool_server_overrides(tools);
        args.push("app-server".into());
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let spec = CommandSpec::provider("codex", &args)?;
        let events = self.events.clone();
        let owned_session_id = session_id.to_owned();
        let worker_token = worker_token.to_owned();
        let delegation_tools = tools.is_some();
        let on_message = Arc::new(move |raw: Value| {
            if delegation_tools && approve_threadterm_elicitation(&responder, &raw) {
                return;
            }
            if project_events {
                emit_codex_message(
                    &events,
                    &owned_session_id,
                    &native,
                    &approvals,
                    &active_turn,
                    &ui,
                    &responder,
                    &worker_token,
                    raw,
                );
            }
        });
        let process = JsonLineProcess::spawn(
            "codex-app-server",
            &spec,
            None,
            &[],
            EnvelopeStyle::Codex,
            on_message,
        )?;
        codex_request(
            &process,
            "initialize",
            json!({
                "clientInfo": {"name":"threadterm","title":"ThreadTerm","version":env!("CARGO_PKG_VERSION")},
                "capabilities": {"experimentalApi":true,"requestAttestation":false}
            }),
        )?;
        process.notification("initialized", json!({}))?;
        Ok(process)
    }

    fn temporary_process(&self) -> Result<JsonLineProcess, ProviderError> {
        self.process(
            "history",
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(HashMap::new())),
            new_codex_turn_state(),
            Arc::new(Mutex::new(CodexUiState::default())),
            Arc::new(Mutex::new(None)),
            false,
            "",
            None,
        )
    }
}

/// `-c mcp_servers.<name>.*` overrides for a session's tool server. Values
/// are TOML literal strings (Windows backslashes kept), or JSON-escaped
/// basic strings when a value contains a quote or newline.
fn codex_tool_server_overrides(tools: Option<&ChatToolServer>) -> Vec<String> {
    let Some(tools) = tools else {
        return Vec::new();
    };
    let toml = |value: &str| {
        if value.contains('\'') || value.contains('\n') {
            serde_json::to_string(value).unwrap_or_default()
        } else {
            format!("'{value}'")
        }
    };
    let prefix = format!("mcp_servers.{}", tools.name);
    let args = tools.args.iter().map(|arg| toml(arg)).collect::<Vec<_>>().join(",");
    let env = tools
        .env
        .iter()
        .map(|(key, value)| format!("{key}={}", toml(value)))
        .collect::<Vec<_>>()
        .join(",");
    vec![
        "-c".into(),
        format!("{prefix}.command={}", toml(&tools.command)),
        "-c".into(),
        format!("{prefix}.args=[{args}]"),
        "-c".into(),
        format!("{prefix}.env={{{env}}}"),
    ]
}

impl ProviderAdapter for CodexAdapter {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn capability(&self) -> ProviderCapability {
        let (installed, version, probe_error) = version_probe("codex");
        let auth = if installed {
            CommandSpec::provider("codex", &["login", "status"])
                .and_then(|spec| {
                    super::common::command_output(&spec, std::time::Duration::from_secs(5))
                })
                .map(|_| "authenticated")
                .unwrap_or("unauthenticated")
                .to_owned()
        } else {
            "unknown".to_owned()
        };
        ProviderCapability {
            id: "codex".to_owned(),
            name: "Codex".to_owned(),
            installed,
            version,
            terminal: installed,
            chat: installed && auth == "authenticated",
            history: installed,
            resume: installed,
            terminal_resume_capture: self.terminal_capture().as_str(),
            reason: codex_capability_reason(installed, &auth, probe_error),
            auth,
        }
    }

    fn terminal_command(
        &self,
        resume_id: Option<&str>,
        assign_id: Option<&str>,
    ) -> Result<TerminalCommand, ProviderError> {
        let mut args = Vec::new();
        if let Some(native_id) = resume_id.or(assign_id) {
            validate_native_id(native_id)?;
            if resume_id.is_some() {
                let process = self.temporary_process()?;
                let response = process.request(
                    "thread/read",
                    json!({"threadId":native_id,"includeTurns":false}),
                )?;
                validate_resume_thread(response.get("thread").unwrap_or(&response))?;
            }
            args.extend(["resume".to_owned(), native_id.to_owned()]);
        }
        args.push("--no-alt-screen".to_owned());
        let help_spec = CommandSpec::provider("codex", &["--help"])?;
        let help = super::common::command_output(&help_spec, Duration::from_secs(5))?;
        if !help.contains("--no-alt-screen") {
            return Err(ProviderError::new("provider_version_unsupported", "This Codex CLI does not support --no-alt-screen. Update Codex before opening a terminal. / 当前 Codex 版本不支持 --no-alt-screen，请更新后打开终端。"));
        }
        // Keep the native server inside the runtime-owned PTY lifetime. Newer
        // CLIs otherwise attach to a shared daemon, which can fail at resume
        // before the TUI can handle input (including clipboard shortcuts).
        if help.contains("--no-daemon") {
            args.push("--no-daemon".to_owned());
        }
        let path = super::common::find_executable("codex").ok_or_else(|| {
            ProviderError::unavailable("codex", "Codex executable was not found on PATH")
        })?;
        let spec = CommandSpec::from_path(path, args)?;
        Ok(TerminalCommand {
            program: spec.program,
            args: spec.args,
            display: spec.display,
        })
    }

    fn terminal_capture(&self) -> super::TerminalCapture {
        // Codex has no caller-supplied --session-id flag. Use its structured
        // app-server thread/start API before creating the PTY instead.
        super::TerminalCapture::PreAssigned
    }

    fn prepare_terminal(&self, cwd: &str) -> Result<Option<String>, ProviderError> {
        let process = self.temporary_process()?;
        let response = process.request("thread/start", json!({"cwd":cwd,"threadSource":"user"}))?;
        let thread = response
            .get("thread")
            .cloned()
            .unwrap_or_else(|| response.clone());
        let native_id = thread.get("id").and_then(Value::as_str).ok_or_else(|| {
            ProviderError::new("provider_protocol", "Codex returned no thread id")
        })?;
        validate_native_id(native_id)?;
        // thread/start allocates an id but Codex does not persist an empty
        // rollout. Materialize it through the native history API without a
        // model turn, user message, or additional developer instructions.
        codex_request(
            &process,
            "thread/inject_items",
            json!({"threadId":native_id,"items":[{"type":"message","role":"developer","content":[]}]}),
        )?;
        // A different process must be able to load it before the PTY is
        // launched. Never return a merely in-memory thread as resumable.
        let verifier = self.temporary_process()?;
        let stored = verifier.request(
            "thread/read",
            json!({"threadId":native_id,"includeTurns":true}),
        )?;
        validate_resume_thread(stored.get("thread").unwrap_or(&stored))?;
        Ok(Some(native_id.to_owned()))
    }

    fn history_list(
        &self,
        cursor: Option<&str>,
        limit: u32,
        cwd: Option<&str>,
    ) -> Result<Value, ProviderError> {
        let process = self.temporary_process()?;
        let result = process.request("thread/list", history_list_params(cursor, limit, cwd))?;
        let items = result
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(codex_history_item)
            .collect::<Vec<_>>();
        Ok(history_page(items, result.get("nextCursor").cloned()))
    }

    fn history_read(&self, native_id: &str) -> Result<Value, ProviderError> {
        validate_native_id(native_id)?;
        let process = self.temporary_process()?;
        let response = process.request(
            "thread/read",
            json!({"threadId":native_id,"includeTurns":true}),
        )?;
        let thread = response.get("thread").cloned().unwrap_or(response);
        Ok(Value::Array(codex_transcript_items(&thread)))
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
        let native = Arc::new(Mutex::new(None));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let active_turn = new_codex_turn_state();
        let ui = Arc::new(Mutex::new(CodexUiState::default()));
        let responder = Arc::new(Mutex::new(None));
        let process = self.process(
            session_id,
            Arc::clone(&native),
            Arc::clone(&approvals),
            Arc::clone(&active_turn),
            Arc::clone(&ui),
            Arc::clone(&responder),
            true,
            worker_token,
            tools,
        )?;
        if let Ok(mut slot) = responder.lock() {
            *slot = Some(process.responder());
        }
        let thread_response = if let Some(native_id) = native_id {
            validate_native_id(native_id)?;
            // Never replace an unavailable requested identity with a fresh
            // thread. Read first so a stale/child identity fails visibly.
            let existing = process.request(
                "thread/read",
                json!({"threadId":native_id,"includeTurns":false}),
            )?;
            validate_resume_thread(existing.get("thread").unwrap_or(&existing))?;
            process.request("thread/resume", json!({"threadId":native_id,"cwd":cwd}))?
        } else {
            process.request("thread/start", json!({"cwd":cwd,"threadSource":"user"}))?
        };
        let thread = thread_response
            .get("thread")
            .cloned()
            .unwrap_or_else(|| thread_response.clone());
        let native_id = thread
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| ProviderError::new("provider_protocol", "Codex returned no thread id"))?
            .to_owned();
        if let Ok(mut value) = native.lock() {
            *value = Some(native_id.clone());
        }
        emit_scoped(
            &self.events,
            "codex",
            session_id,
            Some(&native_id),
            None,
            "session.ready",
            json!({"nativeId":native_id}),
            Some(worker_token),
        );
        let prior_status = ui.lock().ok().map(|state| state.status.clone());
        let mut loaded = load_codex_ui(&process, &thread, &thread_response, cwd);
        if let Some(prior_status) = prior_status.as_ref() {
            merge_status_runtime_data(&mut loaded.status, prior_status);
        }
        if let Ok(mut state) = ui.lock() {
            *state = loaded;
        }
        emit_chat_ui(
            &self.events,
            session_id,
            Some(&native_id),
            &ui,
            worker_token,
        );
        schedule_codex_status_reads(&process, &ui, None);
        Ok(Box::new(CodexChat {
            process,
            native_id,
            approvals,
            active_turn,
            session_id: session_id.to_owned(),
            cwd: cwd.to_owned(),
            events: self.events.clone(),
            ui,
            worker_token: worker_token.to_owned(),
        }))
    }
}

fn codex_capability_reason(
    installed: bool,
    auth: &str,
    probe_error: Option<String>,
) -> Option<String> {
    if !installed {
        Some(probe_error.unwrap_or_else(|| "Codex CLI is not installed".to_owned()))
    } else if auth != "authenticated" {
        Some("Codex CLI is not authenticated".to_owned())
    } else {
        probe_error
    }
}

fn history_list_params(cursor: Option<&str>, limit: u32, cwd: Option<&str>) -> Value {
    // Runtime-started threads use a source that current Codex app-server
    // versions cannot express in sourceKinds. Filtering there made our own
    // resumable sessions undiscoverable; projection below validates roots.
    json!({
        "cursor": cursor,
        "limit": limit,
        "sortKey": "updated_at",
        "sortDirection": "desc",
        "cwd": cwd
    })
}

struct CodexChat {
    process: JsonLineProcess,
    native_id: String,
    approvals: Arc<Mutex<HashMap<String, PendingCodexApproval>>>,
    active_turn: CodexTurnState,
    session_id: String,
    cwd: String,
    events: broadcast::Sender<ProviderEvent>,
    ui: Arc<Mutex<CodexUiState>>,
    worker_token: String,
}

#[derive(Clone)]
struct ActiveCodexTurn {
    public_id: String,
    native_id: Option<String>,
    assistant_item_id: Option<String>,
    started_at: Instant,
}

type CodexTurnState = Arc<(Mutex<Option<ActiveCodexTurn>>, Condvar)>;

fn new_codex_turn_state() -> CodexTurnState {
    Arc::new((Mutex::new(None), Condvar::new()))
}

#[derive(Clone)]
struct PendingCodexApproval {
    method: String,
    turn_id: Option<String>,
    params: Value,
    choices: Vec<ApprovalChoice>,
    submittable: bool,
    state: PendingApprovalState,
}

impl ChatSession for CodexChat {
    fn native_id(&self) -> Option<String> {
        Some(self.native_id.clone())
    }

    fn is_alive(&self) -> bool {
        self.process.is_alive()
    }

    fn validate_send(&self, _text: &str) -> Result<(), ProviderError> {
        self.validate_active_turn()
    }

    fn validate_images(&self, images: &[String]) -> Result<(), ProviderError> {
        for image in images {
            if !image.starts_with("data:image/") || !image.contains(";base64,") {
                return Err(ProviderError::new(
                    "invalid_image",
                    "Codex requires base64 image data URLs. / Codex 图片必须使用 base64 data URL。",
                ));
            }
        }
        Ok(())
    }

    fn validate_send_with_images(
        &self,
        text: &str,
        images: &[String],
    ) -> Result<(), ProviderError> {
        self.validate_images(images)?;
        if !images.is_empty() {
            if let Some((name, _)) = parse_slash(text.trim()) {
                if is_codex_local_command(name)
                    || matches!(
                        name,
                        "model"
                            | "plan"
                            | "approvals"
                            | "sandbox"
                            | "status"
                            | "usage"
                            | "compact"
                            | "review"
                    )
                {
                    return Err(ProviderError::new(
                        "images_not_supported_for_command",
                        format!(
                            "/{name} does not accept image attachments. / /{name} 不接受图片附件。"
                        ),
                    ));
                }
            }
        }
        Ok(())
    }

    fn send_with_images(
        &mut self,
        text: &str,
        images: &[String],
        operation_id: &str,
    ) -> Result<Value, ProviderError> {
        validate_native_id(operation_id)?;
        self.validate_send(text)?;
        self.validate_send_with_images(text, images)?;
        if images.is_empty() {
            return self.send(text, operation_id);
        }
        if let Some((name, args)) = parse_slash(text.trim()) {
            if is_codex_local_command(name)
                || matches!(
                    name,
                    "model"
                        | "plan"
                        | "approvals"
                        | "sandbox"
                        | "status"
                        | "usage"
                        | "compact"
                        | "review"
                )
            {
                return Err(ProviderError::new(
                    "images_not_supported_for_command",
                    format!(
                        "/{name} does not accept image attachments. / /{name} 不接受图片附件。"
                    ),
                ));
            }
            if let Some(skill) = self.skill_named(name) {
                let mut input = vec![json!({"type":"skill","name":skill.name,"path":skill.path})];
                input.extend(native_image_inputs(images));
                if !args.is_empty() {
                    input.push(json!({"type":"text","text":args}));
                }
                return self.start_turn(operation_id, input);
            }
        }
        let mut input = native_image_inputs(images);
        if !text.trim().is_empty() {
            input.push(json!({"type":"text","text":text}));
        }
        self.start_turn(operation_id, input)
    }

    fn send(&mut self, text: &str, operation_id: &str) -> Result<Value, ProviderError> {
        validate_native_id(operation_id)?;
        self.validate_send(text)?;
        if let Some(result) = self.dispatch_slash(text.trim(), operation_id)? {
            return Ok(result);
        }
        let input = {
            let ui = self.ui.lock().ok();
            turn_input_for(text, ui.as_deref())?
        };
        self.start_turn(operation_id, input)
    }

    fn cancel(&mut self, turn_id: &str) -> Result<(), ProviderError> {
        validate_native_id(turn_id)?;
        let native_turn_id = wait_for_codex_native_turn(&self.active_turn, turn_id)?;
        let Some(native_turn_id) = native_turn_id else {
            // Completion can win the race with a user cancellation. Treat an
            // already-finished turn as an idempotent cancellation success.
            return Ok(());
        };
        self.process.request(
            "turn/interrupt",
            json!({"threadId":self.native_id,"turnId":native_turn_id}),
        )?;
        Ok(())
    }

    fn approve(
        &mut self,
        turn_id: &str,
        approval_id: &str,
        choice_id: &str,
        operation_id: &str,
    ) -> Result<(), ProviderError> {
        let mut approvals = self
            .approvals
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "Codex approval lock poisoned"))?;
        let pending = approvals.get_mut(approval_id).ok_or_else(|| {
            ProviderError::new(
                "approval_not_pending",
                "Codex approval is unknown or already resolved",
            )
        })?;
        let (active_public, active_native) = {
            let (active, _) = &*self.active_turn;
            active
                .lock()
                .ok()
                .and_then(|turn| {
                    turn.as_ref()
                        .map(|turn| (Some(turn.public_id.clone()), turn.native_id.clone()))
                })
                .unwrap_or((None, None))
        };
        validate_codex_turn(
            pending.turn_id.as_deref(),
            active_public.as_deref(),
            active_native.as_deref(),
            turn_id,
        )?;
        if !pending.submittable {
            return Err(ProviderError::new(
                "approval_unsupported",
                format!(
                    "Codex request {} cannot be answered with a permission choice",
                    pending.method
                ),
            ));
        }
        find_choice(&pending.choices, choice_id)?;
        match pending.state.begin_submit(operation_id) {
            Ok(()) => {}
            Err(error) if error.code == "approval_duplicate" => return Ok(()),
            Err(error) => return Err(error),
        }
        let result = codex_response(&pending.method, choice_id, &pending.params)?;
        drop(approvals);
        let still_active = {
            let (active, _) = &*self.active_turn;
            active
                .lock()
                .ok()
                .is_some_and(|turn| turn.as_ref().is_some_and(|turn| turn.public_id == turn_id))
        };
        if !still_active {
            return Err(ProviderError::new(
                "approval_stale",
                "approval is not bound to a live turn",
            ));
        }
        let sent = self
            .process
            .respond(super::common::decode_approval_id(approval_id)?, result);
        let mut approvals = self
            .approvals
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "Codex approval lock poisoned"))?;
        match sent {
            Ok(()) => {
                approvals.remove(approval_id);
                emit_scoped(
                    &self.events,
                    "codex",
                    &self.session_id,
                    Some(&self.native_id),
                    Some(turn_id),
                    "chat.approval.resolved",
                    json!({"approvalId":approval_id,"outcome":"submitted"}),
                    Some(&self.worker_token),
                );
                Ok(())
            }
            Err(error) if write_failed_not_sent(&error) => {
                if let Some(pending) = approvals.get_mut(approval_id) {
                    pending.state.clear_submit();
                }
                Err(error)
            }
            Err(error) => {
                if let Some(pending) = approvals.get_mut(approval_id) {
                    pending.state.mark_unknown();
                }
                emit_scoped(
                    &self.events,
                    "codex",
                    &self.session_id,
                    Some(&self.native_id),
                    Some(turn_id),
                    "chat.approval.resolved",
                    json!({"approvalId":approval_id,"status":"outcomeUnknown","outcome":"unknown"}),
                    Some(&self.worker_token),
                );
                Err(ProviderError::new(
                    "approval_outcome_unknown",
                    error.message,
                ))
            }
        }
    }

    fn stop(&mut self) -> Result<(), ProviderError> {
        // Dropping the app-server process is the ownership boundary. Threads
        // remain provider-owned and are resumable by their native id.
        Ok(())
    }

    fn ui_state(&self) -> Value {
        self.ui
            .lock()
            .ok()
            .map(|state| state.wire())
            .unwrap_or_else(|| json!({"options":[],"commands":[]}))
    }

    fn set_option(&mut self, option_id: &str, value: &str) -> Result<Value, ProviderError> {
        self.apply_option(option_id, value)
    }
}

impl CodexChat {
    fn validate_active_turn(&self) -> Result<(), ProviderError> {
        let (active, _) = &*self.active_turn;
        if active
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "Codex turn lock poisoned"))?
            .is_some()
        {
            return Err(ProviderError::new(
                "turn_in_progress",
                "Codex session already has an active turn",
            ));
        }
        Ok(())
    }

    fn start_turn(
        &mut self,
        operation_id: &str,
        input: Vec<Value>,
    ) -> Result<Value, ProviderError> {
        self.start_native_turn(
            operation_id,
            "turn/start",
            json!({
                "threadId":self.native_id,"clientUserMessageId":operation_id,"input":input
            }),
        )
    }

    fn start_native_turn(
        &mut self,
        operation_id: &str,
        method: &'static str,
        params: Value,
    ) -> Result<Value, ProviderError> {
        {
            let (active, _) = &*self.active_turn;
            let mut active = active
                .lock()
                .map_err(|_| ProviderError::new("provider_internal", "Codex turn lock poisoned"))?;
            if active.is_some() {
                return Err(ProviderError::new(
                    "turn_in_progress",
                    "Codex session already has an active turn",
                ));
            }
            *active = Some(ActiveCodexTurn {
                public_id: operation_id.to_owned(),
                native_id: None,
                assistant_item_id: None,
                started_at: Instant::now(),
            });
        }
        let active_turn = Arc::clone(&self.active_turn);
        let public_id = operation_id.to_owned();
        let events = self.events.clone();
        let session_id = self.session_id.clone();
        let native_id = self.native_id.clone();
        let approvals = Arc::clone(&self.approvals);
        let worker_token = self.worker_token.clone();
        let request = self.process.request_async(method, params, move |result| {
            if let Err(error) = result {
                let error = codex_protocol_error(method, error);
                clear_codex_turn(&active_turn, &public_id);
                if let Ok(mut pending) = approvals.lock() {
                    drain_inactive_approvals(&mut pending, |item| item.turn_id.as_deref(), None);
                }
                emit_scoped(
                    &events,
                    "codex",
                    &session_id,
                    Some(&native_id),
                    Some(&public_id),
                    "chat.error",
                    json!({"code":error.code,"message":error.message,"details":error.details}),
                    Some(&worker_token),
                );
            }
        });
        if let Err(error) = request {
            clear_codex_turn(&self.active_turn, operation_id);
            if let Ok(mut pending) = self.approvals.lock() {
                drain_inactive_approvals(&mut pending, |item| item.turn_id.as_deref(), None);
            }
            return Err(error);
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
        match name {
            "model" | "plan" | "approvals" | "sandbox" => {
                Ok(Some(self.setting_command(name, args, operation_id)))
            }
            "status" | "usage" => {
                // Emit the cached report first, then refresh account/quota
                // data. Each callback replaces this same chat item so a
                // freshly opened session never persists a half-loaded auth
                // snapshot as its final `/status` result.
                let refresh_events = self.events.clone();
                let refresh_session_id = self.session_id.clone();
                let refresh_native_id = self.native_id.clone();
                let refresh_operation_id = operation_id.to_owned();
                let refresh_command = name.to_owned();
                let refresh_cwd = self.cwd.clone();
                let refresh_ui = Arc::clone(&self.ui);
                let refresh_turn = Arc::clone(&self.active_turn);
                let refresh_worker_token = self.worker_token.clone();
                let refresh = Arc::new(move || {
                    emit_codex_status_item(
                        &refresh_events,
                        &refresh_session_id,
                        &refresh_native_id,
                        CodexStatusCommand {
                            operation_id: &refresh_operation_id,
                            command: &refresh_command,
                            worker_token: &refresh_worker_token,
                        },
                        &refresh_cwd,
                        &refresh_ui,
                        &refresh_turn,
                    );
                });
                emit_codex_status_item(
                    &self.events,
                    &self.session_id,
                    &self.native_id,
                    CodexStatusCommand {
                        operation_id,
                        command: name,
                        worker_token: &self.worker_token,
                    },
                    &self.cwd,
                    &self.ui,
                    &self.active_turn,
                );
                schedule_codex_status_reads(&self.process, &self.ui, Some(refresh));
                Ok(Some(json!({"turnId":operation_id})))
            }
            "compact" => Ok(Some(self.start_native_turn(
                operation_id,
                "thread/compact/start",
                json!({"threadId":self.native_id}),
            )?)),
            "review" => {
                let target = if args.is_empty() {
                    json!({"type":"uncommittedChanges"})
                } else {
                    json!({"type":"custom","instructions":args})
                };
                Ok(Some(self.start_native_turn(
                    operation_id,
                    "review/start",
                    json!({"threadId":self.native_id,"target":target,"delivery":"inline"}),
                )?))
            }
            _ => {
                if is_codex_local_command(name) {
                    let (en, zh) = codex_local_command_text(name, self.ui.lock().ok().as_deref());
                    return Ok(Some(self.local_command_reply(name, operation_id, &en, &zh)));
                }
                if let Some(skill) = self.skill_named(name) {
                    let mut input =
                        vec![json!({"type":"skill","name":skill.name,"path":skill.path})];
                    if !args.is_empty() {
                        input.push(json!({"type":"text","text":args}));
                    }
                    return Ok(Some(self.start_turn(operation_id, input)?));
                }
                Ok(None)
            }
        }
    }

    fn local_command_reply(&self, name: &str, operation_id: &str, en: &str, zh: &str) -> Value {
        emit_scoped(
            &self.events,
            "codex",
            &self.session_id,
            Some(&self.native_id),
            Some(operation_id),
            "chat.item",
            json!({"parts":[{"type":"text","text":en,"status":"complete", "data":{"localizedText":{"en":en,"zh-CN":zh}}}],"command":name}),
            Some(&self.worker_token),
        );
        emit_scoped(
            &self.events,
            "codex",
            &self.session_id,
            Some(&self.native_id),
            Some(operation_id),
            "chat.turn.completed",
            json!({"command":name}),
            Some(&self.worker_token),
        );
        json!({"turnId":operation_id})
    }

    fn skill_named(&self, name: &str) -> Option<CodexSkill> {
        self.ui.lock().ok().and_then(|state| {
            state
                .skills
                .iter()
                .find(|skill| skill.name.eq_ignore_ascii_case(name))
                .cloned()
        })
    }

    fn setting_command(&mut self, name: &str, args: &str, operation_id: &str) -> Value {
        emit_scoped(
            &self.events,
            "codex",
            &self.session_id,
            Some(&self.native_id),
            Some(operation_id),
            "chat.turn.started",
            json!({"command":name}),
            Some(&self.worker_token),
        );
        let result = match name {
            "model" if args.is_empty() || matches!(args, "?" | "status") => Ok(format!(
                "Model: {}",
                self.current_setting("model")
                    .unwrap_or_else(|| "unavailable".to_owned())
            )),
            "model" if args.split_whitespace().count() == 1 => {
                self.apply_option("model", args).map(|_| {
                    format!(
                        "Model: {}",
                        self.current_setting("model")
                            .unwrap_or_else(|| args.to_owned())
                    )
                })
            }
            "model" => Err(ProviderError::new(
                "invalid_command",
                "Usage: /model [model-id]",
            )),
            "plan" if matches!(args, "?" | "status") => Ok(format!(
                "Mode: {}",
                self.current_setting("collaboration")
                    .unwrap_or_else(|| "unavailable".to_owned())
            )),
            "plan" => {
                let mode = match args {
                    "" | "on" | "plan" => Ok("plan"),
                    "off" | "default" => Ok("default"),
                    _ => Err(ProviderError::new(
                        "invalid_command",
                        "Usage: /plan [on|off|status]",
                    )),
                };
                mode.and_then(|mode| {
                    self.apply_option("collaboration", mode).map(|_| {
                        format!(
                            "Mode: {}",
                            self.current_setting("collaboration")
                                .unwrap_or_else(|| mode.to_owned())
                        )
                    })
                })
            }
            "approvals" | "sandbox" => {
                let option_id = if name == "approvals" {
                    "mode"
                } else {
                    "sandbox"
                };
                let label = if name == "approvals" {
                    "Approval policy"
                } else {
                    "Sandbox"
                };
                if args.is_empty() || matches!(args, "?" | "status") {
                    Ok(format!(
                        "{label}: {}",
                        self.current_setting(option_id)
                            .unwrap_or_else(|| "unavailable".to_owned())
                    ))
                } else {
                    self.apply_option(option_id, args).map(|_| {
                        format!(
                            "{label}: {}",
                            self.current_setting(option_id)
                                .unwrap_or_else(|| "unavailable".to_owned())
                        )
                    })
                }
            }
            _ => unreachable!(),
        };
        match result {
            Ok(text) => emit_scoped(
                &self.events,
                "codex",
                &self.session_id,
                Some(&self.native_id),
                Some(operation_id),
                "chat.item",
                json!({"parts":[{"type":"text","text":text,"status":"complete","data":{"localizedText":{"en":text,"zh-CN":codex_setting_text_zh(name, &text)}}}],"command":name}),
                Some(&self.worker_token),
            ),
            Err(error) => emit_scoped(
                &self.events,
                "codex",
                &self.session_id,
                Some(&self.native_id),
                Some(operation_id),
                "chat.error",
                json!({"code":error.code,"message":error.message,"details":error.details,"command":name}),
                Some(&self.worker_token),
            ),
        }
        emit_scoped(
            &self.events,
            "codex",
            &self.session_id,
            Some(&self.native_id),
            Some(operation_id),
            "chat.turn.completed",
            json!({"command":name}),
            Some(&self.worker_token),
        );
        json!({"turnId":operation_id})
    }

    fn current_setting(&self, option_id: &str) -> Option<String> {
        self.ui
            .lock()
            .ok()
            .and_then(|state| option_value(Some(&state), option_id))
    }

    fn apply_option(&mut self, option_id: &str, value: &str) -> Result<Value, ProviderError> {
        let current = self.ui.lock().ok().map(|state| state.clone());
        let params = codex_settings_params(option_id, &self.native_id, value, current.as_ref())
            .ok_or_else(|| {
                ProviderError::new(
                    "option_unknown",
                    format!("Codex has no live option {option_id}"),
                )
            })?;
        let generation = current
            .as_ref()
            .map(|state| state.settings_generation)
            .unwrap_or(0);
        let response = codex_request(&self.process, "thread/settings/update", params.clone())?;
        // Native 0.159.1 returns {} and confirms through a notification. Some
        // versions return threadSettings directly. Neither thread/read nor an
        // empty success response is evidence that an unknown field was applied.
        if let Some(settings) = response.get("threadSettings") {
            if let Ok(mut state) = self.ui.lock() {
                adopt_codex_settings(&mut state, settings);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let confirmed = self.ui.lock().ok().is_some_and(|state| {
                state.settings_generation > generation
                    && codex_settings_confirmed(&state.status.thread_settings, &params)
            });
            if confirmed {
                break;
            }
            if Instant::now() >= deadline || !self.process.is_alive() {
                return Err(ProviderError::new("provider_settings_unconfirmed", "Codex did not confirm the requested setting. This CLI may not support it; reconnect to read native settings. / Codex 未确认此设置，当前版本可能不支持；请重新连接以读取原生设置。"));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        emit_chat_ui(
            &self.events,
            &self.session_id,
            Some(&self.native_id),
            &self.ui,
            &self.worker_token,
        );
        Ok(self.ui_state())
    }
}

const CODEX_SLASH_COMMANDS: &[(&str, &str)] = &[
    ("compact", "Compact the conversation context"),
    ("review", "Review uncommitted changes"),
    ("status", "Show current session status"),
    ("diff", "Show the local git diff"),
    ("init", "Create or update AGENTS.md"),
    ("mcp", "Show MCP servers"),
    ("skills", "List available skills"),
    ("plan", "Switch to plan mode"),
    ("model", "Switch model"),
    ("approvals", "Change the approval policy"),
    ("sandbox", "Change the sandbox"),
    ("usage", "Show token usage"),
    ("memory", "Show memory"),
    ("undo", "Undo the last turn"),
    ("help", "Show slash command help"),
];

#[derive(Clone, Default)]
struct CodexUiState {
    options: Vec<Value>,
    commands: Vec<Value>,
    skills: Vec<CodexSkill>,
    catalog: Value,
    status: CodexStatusState,
    settings_generation: u64,
    skills_error: Option<String>,
    options_error: Option<ProviderError>,
}

#[derive(Clone, Default)]
struct CodexStatusState {
    /// The inner thread object returned by thread/start, thread/resume, or
    /// thread/read. Keeping this separate from the outer response preserves
    /// session metadata that app-server returns alongside `thread`.
    thread: Value,
    /// Outer thread/start or thread/resume response. It carries permissions,
    /// loaded AGENTS.md paths, and service metadata.
    thread_response: Value,
    thread_settings: Value,
    account: Value,
    rate_limits: Value,
    token_usage: Value,
    /// Whether the asynchronous account/read request has completed. A
    /// missing account before this flips is a loading state, not an auth
    /// failure.
    account_loaded: bool,
    account_error: Option<String>,
    /// Whether a rate-limit read or native update has completed. An empty
    /// rate-limit list before this flips is still loading, not unavailable.
    rate_limits_loaded: bool,
    rate_limits_error: Option<String>,
}

struct CodexStatusCommand<'a> {
    operation_id: &'a str,
    command: &'a str,
    worker_token: &'a str,
}

#[derive(Clone)]
struct CodexSkill {
    name: String,
    path: String,
}

impl CodexUiState {
    fn wire(&self) -> Value {
        let mut wire = json!({"options":self.options.clone(),"commands":self.commands.clone(),"inputCapabilities":{"images":true}});
        if let Some(error) = &self.options_error {
            wire["loadState"] = json!("error");
            wire["error"] = json!({"code":error.code,"message":error.message});
        }
        wire
    }
}

fn parse_slash(text: &str) -> Option<(&str, &str)> {
    let trimmed = text.trim();
    let rest = trimmed.strip_prefix('/')?;
    if rest.is_empty() || rest.starts_with('/') {
        return None;
    }
    match rest.split_once(char::is_whitespace) {
        Some((name, args)) => Some((name, args.trim())),
        None => Some((rest, "")),
    }
}

fn is_codex_local_command(name: &str) -> bool {
    matches!(
        name,
        "diff" | "init" | "mcp" | "skills" | "memory" | "undo" | "help"
    )
}

fn codex_setting_text_zh(name: &str, text: &str) -> String {
    let label = match name {
        "model" => "模型",
        "plan" => "协作模式",
        "approvals" => "审批策略",
        "sandbox" => "沙箱",
        _ => return text.to_owned(),
    };
    format!(
        "{label}：{}",
        text.split_once(": ")
            .map(|(_, value)| value)
            .unwrap_or(text)
    )
}

fn codex_local_command_text(name: &str, ui: Option<&CodexUiState>) -> (String, String) {
    match name {
        "help" => {
            let commands = ui.map(|state| &state.commands).into_iter().flatten()
                .filter_map(|command| command.get("name").and_then(Value::as_str))
                .map(|name| format!("/{name}")).collect::<Vec<_>>().join("  ");
            (format!("Chat commands: {commands}\n/approvals [on-request|never]; /sandbox [read-only|workspace-write|danger-full-access]. /diff, /init, /mcp, /memory and /undo provide local guidance; use Codex Terminal for these actions."),
             format!("聊天命令：{commands}\n/approvals [on-request|never]；/sandbox [read-only|workspace-write|danger-full-access]。/diff、/init、/mcp、/memory 和 /undo 显示本地说明；请在 Codex 终端中执行这些操作。"))
        }
        "skills" => {
            if let Some(error) = ui.and_then(|state| state.skills_error.as_ref()) {
                return (format!("Skills could not be loaded: {error}"), format!("无法读取技能：{error}"));
            }
            let skills = ui.map(|state| &state.skills).into_iter().flatten()
                .map(|skill| format!("/{} — {}", skill.name, skill.path)).collect::<Vec<_>>().join("\n");
            if skills.is_empty() {
                ("No enabled native skills were found for this project.".to_owned(), "此项目未发现已启用的原生技能。".to_owned())
            } else {
                (format!("Native skills (select /name to invoke):\n{skills}"), format!("原生技能（选择 /技能名 执行）：\n{skills}"))
            }
        }
        _ => (format!("/{name} is not implemented in Chat. Use Codex Terminal for this action. No model prompt or workspace change was submitted."),
              format!("聊天模式尚未实现 /{name}。请在 Codex 终端中执行此操作。未向模型发送提示词，也未修改工作区。")),
    }
}

fn codex_protocol_error(method: &str, error: ProviderError) -> ProviderError {
    let code = error
        .details
        .as_ref()
        .and_then(|details| details.get("code"))
        .and_then(Value::as_i64);
    if code == Some(-32601)
        || (code == Some(-32600)
            && error.message.contains("unknown variant")
            && error.message.contains(&format!("`{method}`")))
    {
        ProviderError::new("provider_method_unsupported", format!("This Codex CLI does not support {method}. Update Codex to use this feature. / 当前 Codex 版本不支持 {method}，请更新 Codex 后使用此功能。"))
            .with_details(json!({"method":method,"nativeError":error.details}))
    } else {
        error
    }
}

fn codex_request(
    process: &JsonLineProcess,
    method: &str,
    params: Value,
) -> Result<Value, ProviderError> {
    process
        .request(method, params)
        .map_err(|error| codex_protocol_error(method, error))
}

fn adopt_codex_settings(state: &mut CodexUiState, settings: &Value) {
    merge_json_values(&mut state.status.thread_settings, settings);
    state.options = codex_options_from_catalog(&state.catalog, &state.status.thread_settings);
    state.settings_generation = state.settings_generation.wrapping_add(1);
}

fn codex_settings_confirmed(settings: &Value, requested: &Value) -> bool {
    requested.as_object().is_some_and(|fields| {
        fields.iter().all(|(key, value)| match key.as_str() {
            "threadId" => true,
            // Native collaboration settings include generated developer instructions.
            "collaborationMode" => settings.pointer("/collaborationMode/mode") == value.get("mode"),
            "sandboxPolicy" => value.as_object().is_some_and(|fields| {
                fields.iter().all(|(field, expected)| {
                    settings.get(key).and_then(|policy| policy.get(field)) == Some(expected)
                })
            }),
            _ => settings.get(key) == Some(value),
        })
    })
}

fn turn_input_for(text: &str, ui: Option<&CodexUiState>) -> Result<Vec<Value>, ProviderError> {
    if let Some((name, args)) = parse_slash(text) {
        if CODEX_SLASH_COMMANDS
            .iter()
            .any(|(command, _)| *command == name)
        {
            return Err(ProviderError::new("invalid_command", format!("/{name} must be handled as a Chat command, not a model prompt. / /{name} 必须作为聊天命令处理，不能作为模型提示词发送。")));
        }
        if let Some(skill) = ui.and_then(|state| {
            state
                .skills
                .iter()
                .find(|skill| skill.name.eq_ignore_ascii_case(name))
        }) {
            let mut input = vec![json!({"type":"skill","name":skill.name,"path":skill.path})];
            if !args.is_empty() {
                input.push(json!({"type":"text","text":args}));
            }
            return Ok(input);
        }
    }
    Ok(vec![json!({"type":"text","text":text})])
}

fn native_image_inputs(images: &[String]) -> Vec<Value> {
    images
        .iter()
        .map(|url| json!({"type":"image","url":url}))
        .collect()
}

// Verified against Codex 0.159.1. Confirm the canonical settings notification
// after every update: native deserialization can silently ignore unknown fields.
fn codex_settings_params(
    option_id: &str,
    thread_id: &str,
    value: &str,
    ui: Option<&CodexUiState>,
) -> Option<Value> {
    match option_id {
        "model" => {
            let mut params = json!({"threadId":thread_id,"model":value});
            if let Some(effort) = effort_for_model(ui, value) {
                params["effort"] = json!(effort);
            }
            Some(params)
        }
        "thinking" => Some(json!({"threadId":thread_id,"effort":value})),
        "collaboration" if matches!(value, "default" | "plan") => {
            let model = option_value(ui, "model")?;
            let mut settings =
                json!({"model":model,"reasoning_effort":null,"developer_instructions":null});
            if let Some(effort) = option_value(ui, "thinking") {
                settings["reasoning_effort"] = json!(effort);
            }
            Some(json!({
                "threadId":thread_id,
                "collaborationMode":{"mode":value,"settings":settings}
            }))
        }
        "mode" if matches!(value, "on-request" | "never") => {
            Some(json!({"threadId":thread_id,"approvalPolicy":value}))
        }
        "sandbox" => {
            let policy = match value {
                "read-only" => json!({"type":"readOnly","networkAccess":false}),
                "workspace-write" => {
                    json!({"type":"workspaceWrite","networkAccess":false,"writableRoots":[]})
                }
                "danger-full-access" => json!({"type":"dangerFullAccess"}),
                _ => return None,
            };
            Some(json!({"threadId":thread_id,"sandboxPolicy":policy}))
        }
        _ => None,
    }
}

fn option_value(ui: Option<&CodexUiState>, id: &str) -> Option<String> {
    ui.and_then(|state| {
        state
            .options
            .iter()
            .find(|option| option.get("id").and_then(Value::as_str) == Some(id))
            .and_then(|option| option.get("value").and_then(Value::as_str))
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn codex_status_report(
    native_id: &str,
    cwd: &str,
    ui: Option<&CodexUiState>,
    active_turn: Option<&ActiveCodexTurn>,
) -> Value {
    let status = ui.map(|state| &state.status);
    let thread = status.map(|state| &state.thread).unwrap_or(&Value::Null);
    let response = status
        .map(|state| &state.thread_response)
        .unwrap_or(&Value::Null);
    let settings = status
        .map(|state| &state.thread_settings)
        .unwrap_or(&Value::Null);
    let model = option_value(ui, "model")
        .or_else(|| first_string(&[thread, response, settings], &["model"]))
        .unwrap_or_else(|| "unavailable".to_owned());
    let reasoning_effort = option_value(ui, "thinking")
        .or_else(|| {
            first_string(
                &[thread, response, settings],
                &["reasoningEffort", "effort", "reasoning_effort"],
            )
        })
        .unwrap_or_else(|| "unavailable".to_owned());
    let mode = option_value(ui, "collaboration")
        .or_else(|| {
            settings
                .pointer("/collaborationMode/mode")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            thread
                .pointer("/collaborationMode/mode")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| "default".to_owned());
    let directory =
        first_string(&[thread, response, settings], &["cwd"]).unwrap_or_else(|| cwd.to_owned());
    let thread_name = first_string(&[thread, response], &["name", "threadName"]);
    let session_id = first_string(&[thread, response], &["sessionId"]);
    let cli_version = first_string(&[thread, response], &["cliVersion"]);
    let summary = first_string(&[settings, thread, response], &["summary"])
        .unwrap_or_else(|| "auto".to_owned());
    let approval_policy = first_value(&[settings, response], &["approvalPolicy"]);
    let approvals_reviewer = first_value(&[settings, response], &["approvalsReviewer"]);
    let sandbox = first_value(&[settings, response], &["sandboxPolicy", "sandbox"]);
    let active_profile = first_value(&[settings, response], &["activePermissionProfile"]);
    let instruction_sources = first_value(&[response, thread], &["instructionSources"])
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let account = status
        .and_then(|state| state.account.get("account"))
        .filter(|value| !value.is_null())
        .cloned();
    let account_type = account
        .as_ref()
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str);
    let account_loaded = status.map(|state| state.account_loaded).unwrap_or(false);
    let requires_openai_auth = status
        .filter(|state| state.account_loaded)
        .and_then(|state| state.account.get("requiresOpenaiAuth"))
        .and_then(Value::as_bool);
    let token_usage = status
        .map(|state| &state.token_usage)
        .unwrap_or(&Value::Null);
    let context = codex_context_report(token_usage);
    let rate_limit_rows = status
        .map(|state| codex_rate_limit_rows(&state.rate_limits))
        .unwrap_or_default();
    let rate_limits_loaded = status
        .map(|state| state.rate_limits_loaded)
        .unwrap_or(false);
    let turn = active_turn
        .map(|turn| {
            json!({
                "state":"active",
                "id":turn.native_id.as_deref().unwrap_or(&turn.public_id),
                "operationId":turn.public_id
            })
        })
        .unwrap_or_else(|| json!({"state":"idle"}));
    let session_status = status
        .and_then(|state| state.thread.get("status"))
        .cloned()
        .unwrap_or_else(|| json!({"type":"idle"}));
    let mut warning_parts = Vec::new();
    if let Some(state) = status {
        if state.account_error.is_some() {
            warning_parts.push("account data unavailable");
        }
        if state.rate_limits_error.is_some() {
            warning_parts.push("rate-limit data unavailable");
        }
        if state
            .account
            .get("requiresOpenaiAuth")
            .and_then(Value::as_bool)
            == Some(true)
            && state.account_loaded
            && account_type.is_none()
        {
            warning_parts.push("OpenAI authentication required");
        }
    }
    if context
        .get("percentUsed")
        .and_then(Value::as_f64)
        .is_some_and(|percent| percent >= 85.0)
    {
        warning_parts.push("context window is nearing its limit");
    }
    if rate_limit_rows.iter().any(|row| {
        row.get("rateLimitReachedType")
            .is_some_and(|value| !value.is_null())
            || ["primary", "secondary"].iter().any(|key| {
                row.get(*key)
                    .and_then(|window| window.get("usedPercent"))
                    .and_then(Value::as_f64)
                    .is_some_and(|percent| percent >= 90.0)
            })
    }) {
        warning_parts.push("a usage limit is nearly exhausted");
    }
    let mut report = json!({
        "cliVersion":cli_version,
        "usageUrl":"https://chatgpt.com/codex/settings/usage",
        "model":model,
        "reasoningEffort":reasoning_effort,
        "summary":summary,
        "directory":directory,
        "approvalPolicy":approval_policy,
        "approvalsReviewer":approvals_reviewer,
        "sandbox":sandbox,
        "activePermissionProfile":active_profile,
        "instructionSources":instruction_sources,
        "account":account,
        "accountLoaded":account_loaded,
        "requiresOpenaiAuth":requires_openai_auth,
        "thread":{
            "id":native_id,
            "name":thread_name,
            "sessionId":session_id
        },
        "collaborationMode":mode,
        "session":{"id":session_id,"status":session_status},
        "turn":turn,
        "context":context,
        "rateLimits":rate_limit_rows,
        "rateLimitsLoaded":rate_limits_loaded,
    });
    if !warning_parts.is_empty() {
        report["warning"] = json!(warning_parts.join("; "));
    }
    report
}

#[cfg(test)]
fn codex_status_text(
    native_id: &str,
    cwd: &str,
    ui: Option<&CodexUiState>,
    active_turn: Option<&ActiveCodexTurn>,
) -> String {
    codex_status_text_from_report(&codex_status_report(native_id, cwd, ui, active_turn))
}

fn codex_status_text_from_report(report: &Value) -> String {
    let string = |path: &str, fallback: &str| {
        report
            .pointer(path)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(fallback)
            .to_owned()
    };
    let turn = report
        .pointer("/turn/state")
        .and_then(Value::as_str)
        .unwrap_or("idle");
    let turn_id = report
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .map(|value| format!(" ({value})"))
        .unwrap_or_default();
    let mut lines = vec!["Codex session status".to_owned()];
    if let Some(version) = report.get("cliVersion").and_then(Value::as_str) {
        lines.push(format!("CLI: {version}"));
    }
    lines.push(format!("Thread: {}", string("/thread/id", "unavailable")));
    if let Some(name) = report.pointer("/thread/name").and_then(Value::as_str) {
        lines.push(format!("Thread name: {name}"));
    }
    lines.push(format!(
        "Directory: {}",
        string("/directory", "unavailable")
    ));
    lines.push(format!("Model: {}", string("/model", "unavailable")));
    lines.push(format!(
        "Thinking: {}",
        string("/reasoningEffort", "unavailable")
    ));
    lines.push(format!("Mode: {}", string("/collaborationMode", "default")));
    if let Some(policy) = report
        .get("approvalPolicy")
        .filter(|value| !value.is_null())
    {
        lines.push(format!(
            "Approval policy: {}",
            policy
                .as_str()
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| policy.to_string())
        ));
    }
    if let Some(sandbox) = report.get("sandbox").filter(|value| !value.is_null()) {
        lines.push(format!("Sandbox: {sandbox}"));
    }
    lines.push(format!("Turn: {turn}{turn_id}"));
    if let Some(context) = report.get("context") {
        if let (Some(used), Some(window)) = (
            context.get("usedTokens").and_then(Value::as_u64),
            context.get("modelContextWindow").and_then(Value::as_u64),
        ) {
            lines.push(format!("Context: {used}/{window} tokens"));
        }
    }
    if let Some(warning) = report.get("warning").and_then(Value::as_str) {
        lines.push(format!("Warning: {warning}"));
    }
    lines.join("\n")
}

fn first_value(values: &[&Value], keys: &[&str]) -> Option<Value> {
    values.iter().find_map(|value| {
        keys.iter().find_map(|key| {
            value
                .get(*key)
                .filter(|candidate| !candidate.is_null())
                .cloned()
        })
    })
}

fn first_string(values: &[&Value], keys: &[&str]) -> Option<String> {
    first_value(values, keys).and_then(|value| value.as_str().map(ToOwned::to_owned))
}

fn codex_context_report(token_usage: &Value) -> Value {
    let last = token_usage.get("last").unwrap_or(&Value::Null);
    let used = last
        .get("totalTokens")
        .or_else(|| last.get("total_tokens"))
        .and_then(Value::as_u64)
        .or_else(|| {
            token_usage
                .get("total")
                .and_then(|total| total.get("totalTokens"))
                .and_then(Value::as_u64)
        });
    let window = token_usage
        .get("modelContextWindow")
        .and_then(Value::as_u64);
    let mut context = json!({});
    if let Some(used) = used {
        context["usedTokens"] = json!(used);
    }
    if let Some(window) = window {
        context["modelContextWindow"] = json!(window);
        if let Some(used) = used {
            context["remainingTokens"] = json!(window.saturating_sub(used));
            context["percentUsed"] = json!(context_percent(window, used));
        }
    }
    context
}

fn context_percent(window: u64, used: u64) -> f64 {
    if window <= 12_000 {
        return 0.0;
    }
    let remaining = window.saturating_sub(used) as f64;
    ((remaining / (window - 12_000) as f64) * 100.0).clamp(0.0, 100.0)
}

fn codex_rate_limit_rows(rate_limits: &Value) -> Vec<Value> {
    let mut rows = Vec::new();
    let mut ids = HashSet::new();
    if let Some(map) = rate_limits
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object)
    {
        for (key, value) in map {
            if !value.is_object() {
                continue;
            }
            let mut row = value.clone();
            if row.get("limitId").and_then(Value::as_str).is_none() {
                row["limitId"] = json!(key);
            }
            let id = row
                .get("limitId")
                .and_then(Value::as_str)
                .unwrap_or(key)
                .to_owned();
            if ids.insert(id) {
                rows.push(row);
            }
        }
    }
    if let Some(row) = rate_limits.get("rateLimits") {
        if !row.is_object() {
            return rows;
        }
        let id = row
            .get("limitId")
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_owned();
        if ids.insert(id) {
            rows.push(row.clone());
        }
    }
    rows
}

fn merge_json_values(base: &mut Value, update: &Value) {
    match (base, update) {
        (Value::Object(base), Value::Object(update)) => {
            for (key, value) in update {
                match base.get_mut(key) {
                    Some(existing) => merge_json_values(existing, value),
                    None => {
                        base.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (base, update) => *base = update.clone(),
    }
}

fn merge_status_runtime_data(target: &mut CodexStatusState, prior: &CodexStatusState) {
    if !prior.thread.is_null() {
        merge_json_values(&mut target.thread, &prior.thread);
    }
    if !prior.thread_settings.is_null() {
        merge_json_values(&mut target.thread_settings, &prior.thread_settings);
    }
    if !prior.account.is_null() {
        merge_json_values(&mut target.account, &prior.account);
    }
    if !prior.rate_limits.is_null() {
        merge_json_values(&mut target.rate_limits, &prior.rate_limits);
    }
    if !prior.token_usage.is_null() {
        merge_json_values(&mut target.token_usage, &prior.token_usage);
    }
    target.account_loaded |= prior.account_loaded;
    target.rate_limits_loaded |= prior.rate_limits_loaded;
    if target.account_error.is_none() {
        target.account_error = prior.account_error.clone();
    }
    if target.rate_limits_error.is_none() {
        target.rate_limits_error = prior.rate_limits_error.clone();
    }
}

fn effort_for_model(ui: Option<&CodexUiState>, model_id: &str) -> Option<String> {
    let catalog = ui.map(|state| &state.catalog)?;
    let models = catalog.get("data").and_then(Value::as_array)?;
    let model = models
        .iter()
        .find(|model| model.get("id").and_then(Value::as_str) == Some(model_id))?;
    let supported = model
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let current = ui.and_then(|state| {
        state
            .options
            .iter()
            .find(|option| option.get("id").and_then(Value::as_str) == Some("thinking"))
            .and_then(|option| option.get("value").and_then(Value::as_str))
            .map(ToOwned::to_owned)
    });
    if current.as_deref().is_some_and(|value| {
        supported
            .iter()
            .any(|effort| effort.get("reasoningEffort").and_then(Value::as_str) == Some(value))
    }) {
        return current;
    }
    model
        .get("defaultReasoningEffort")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            supported
                .first()
                .and_then(|effort| effort.get("reasoningEffort").and_then(Value::as_str))
                .map(ToOwned::to_owned)
        })
}

fn load_codex_ui(
    process: &JsonLineProcess,
    thread: &Value,
    thread_response: &Value,
    cwd: &str,
) -> CodexUiState {
    let skills_result = list_codex_skills(process, cwd);
    let catalog_result = model_catalog(process);
    let mut state = CodexUiState {
        catalog: catalog_result
            .as_ref()
            .cloned()
            .unwrap_or_else(|_| json!({"data":[]})),
        options_error: catalog_result.err(),
        skills: skills_result.as_ref().cloned().unwrap_or_default(),
        skills_error: skills_result.err().map(|error| error.message),
        status: codex_status_state(thread, thread_response, cwd),
        ..CodexUiState::default()
    };
    // thread/start and thread/resume return model/permissions beside `thread`.
    let mut settings = thread.clone();
    merge_json_values(&mut settings, thread_response);
    if let Some(native_settings) = thread_response.get("threadSettings") {
        merge_json_values(&mut settings, native_settings);
    }
    adopt_codex_settings(&mut state, &settings);
    state.commands = merge_codex_commands(&state.skills);
    state
}

fn codex_status_state(thread: &Value, thread_response: &Value, cwd: &str) -> CodexStatusState {
    let mut state = CodexStatusState {
        thread: thread.clone(),
        thread_response: thread_response.clone(),
        thread_settings: thread_response
            .get("threadSettings")
            .cloned()
            .unwrap_or_default(),
        ..CodexStatusState::default()
    };
    if state.thread.get("cwd").is_none() {
        if let Some(object) = state.thread.as_object_mut() {
            object.insert("cwd".to_owned(), json!(cwd));
        }
    }
    state
}

fn schedule_codex_status_reads(
    process: &JsonLineProcess,
    ui: &Arc<Mutex<CodexUiState>>,
    on_update: Option<Arc<dyn Fn() + Send + Sync>>,
) {
    let account_ui = Arc::clone(ui);
    let account_update = on_update.clone();
    if let Err(error) = process.request_async("account/read", json!({}), move |result| match result
    {
        Ok(response) => {
            if let Ok(mut state) = account_ui.lock() {
                state.status.account = response;
                state.status.account_loaded = true;
                state.status.account_error = None;
            }
            if let Some(update) = account_update.as_ref() {
                update();
            }
        }
        Err(error) => {
            if let Ok(mut state) = account_ui.lock() {
                state.status.account_loaded = true;
                state.status.account_error = Some(error.message);
            }
            if let Some(update) = account_update.as_ref() {
                update();
            }
        }
    }) {
        if let Ok(mut state) = ui.lock() {
            state.status.account_loaded = true;
            state.status.account_error = Some(error.message);
        }
        if let Some(update) = on_update.as_ref() {
            update();
        }
    }

    let rate_ui = Arc::clone(ui);
    let rate_update = on_update;
    let rate_error_update = rate_update.clone();
    if let Err(error) =
        process.request_async(
            "account/rateLimits/read",
            json!({}),
            move |result| match result {
                Ok(response) => {
                    if let Ok(mut state) = rate_ui.lock() {
                        merge_json_values(&mut state.status.rate_limits, &response);
                        state.status.rate_limits_loaded = true;
                        state.status.rate_limits_error = None;
                    }
                    if let Some(update) = rate_update.as_ref() {
                        update();
                    }
                }
                Err(error) => {
                    if let Ok(mut state) = rate_ui.lock() {
                        state.status.rate_limits_loaded = true;
                        state.status.rate_limits_error = Some(error.message);
                    }
                    if let Some(update) = rate_update.as_ref() {
                        update();
                    }
                }
            },
        )
    {
        if let Ok(mut state) = ui.lock() {
            state.status.rate_limits_loaded = true;
            state.status.rate_limits_error = Some(error.message);
        }
        if let Some(update) = rate_error_update.as_ref() {
            update();
        }
    }
}

fn model_catalog(process: &JsonLineProcess) -> Result<Value, ProviderError> {
    let mut models = Vec::new();
    let mut cursor = None::<String>;
    for _ in 0..20 {
        let mut params = serde_json::Map::new();
        params.insert("includeHidden".to_owned(), json!(true));
        if let Some(cursor) = &cursor {
            params.insert("cursor".to_owned(), json!(cursor));
        }
        let page = codex_request(process, "model/list", Value::Object(params))?;
        if let Some(data) = page.get("data").and_then(Value::as_array) {
            models.extend(data.iter().cloned());
        }
        cursor = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    Ok(json!({"data":models}))
}

fn list_codex_skills(
    process: &JsonLineProcess,
    cwd: &str,
) -> Result<Vec<CodexSkill>, ProviderError> {
    let result = codex_request(process, "skills/list", json!({"cwds":[cwd]}))?;
    Ok(result
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|entry| {
            entry
                .get("skills")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter(|skill| skill.get("enabled").and_then(Value::as_bool) != Some(false))
        .filter_map(|skill| {
            Some(CodexSkill {
                name: skill.get("name").and_then(Value::as_str)?.to_owned(),
                path: skill.get("path").and_then(Value::as_str)?.to_owned(),
            })
        })
        .collect())
}

fn merge_codex_commands(skills: &[CodexSkill]) -> Vec<Value> {
    let mut commands = CODEX_SLASH_COMMANDS
        .iter()
        .map(|(name, description)| json!({"name":name,"description":description}))
        .collect::<Vec<_>>();
    for skill in skills {
        if commands
            .iter()
            .any(|command| command.get("name").and_then(Value::as_str) == Some(skill.name.as_str()))
        {
            continue;
        }
        commands.push(json!({
            "name":skill.name,
            "description":format!("Skill · {}", skill.name)
        }));
    }
    commands
}

fn codex_options_from_catalog(catalog: &Value, thread: &Value) -> Vec<Value> {
    let current_model = thread_model(thread);
    let models = catalog
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let visible: Vec<&Value> = models
        .iter()
        .filter(|model| {
            let id = model.get("id").and_then(Value::as_str).unwrap_or_default();
            model.get("hidden").and_then(Value::as_bool) != Some(true) || id == current_model
        })
        .collect();
    let current_effort = thread_effort(thread);
    let current_mode = thread_mode(thread);
    let mut model_choices: Vec<Value> = visible
        .iter()
        .filter_map(|model| {
            let value = model.get("id").and_then(Value::as_str)?;
            let name = model
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or(value);
            Some(json!({"value":value,"name":name}))
        })
        .collect();
    if !current_model.is_empty()
        && !model_choices.iter().any(|choice| {
            choice.get("value").and_then(Value::as_str) == Some(current_model.as_str())
        })
    {
        model_choices.insert(0, json!({"value":current_model,"name":current_model}));
    }
    let efforts = visible
        .iter()
        .find(|model| model.get("id").and_then(Value::as_str) == Some(current_model.as_str()))
        .and_then(|model| {
            model
                .get("supportedReasoningEfforts")
                .and_then(Value::as_array)
        })
        .map(|efforts| {
            efforts
                .iter()
                .filter_map(|effort| {
                    let value = effort.get("reasoningEffort").and_then(Value::as_str)?;
                    Some(json!({"value":value,"name":capitalize(value)}))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut options = vec![json!({
        "id":"model","name":"Model","value":current_model,"choices":model_choices
    })];
    if !efforts.is_empty() {
        options.push(json!({
            "id":"thinking","name":"Thinking","value":current_effort,"choices":efforts
        }));
    }
    options.push(json!({
        "id":"collaboration","name":"Collaboration","value":current_mode,
        "choices":[{"value":"default","name":"Default"},{"value":"plan","name":"Plan"}]
    }));
    let approval = thread
        .get("approvalPolicy")
        .and_then(Value::as_str)
        .unwrap_or("unavailable");
    options.push(json!({
        "id":"mode","name":"Approval policy","value":approval,
        "choices":[{"value":"on-request","name":"Ask as needed"},{"value":"never","name":"Never ask"}]
    }));
    let sandbox = thread
        .get("sandboxPolicy")
        .or_else(|| thread.get("sandbox"))
        .and_then(|policy| policy.get("type"))
        .and_then(Value::as_str);
    let sandbox = match sandbox {
        Some("readOnly") => "read-only",
        Some("workspaceWrite") => "workspace-write",
        Some("dangerFullAccess") => "danger-full-access",
        _ => "unavailable",
    };
    options.push(json!({
        "id":"sandbox","name":"Sandbox","value":sandbox,
        "choices":[{"value":"read-only","name":"Read only"},{"value":"workspace-write","name":"Workspace write"},{"value":"danger-full-access","name":"Full access"}]
    }));
    options
}

fn thread_model(thread: &Value) -> String {
    thread
        .get("model")
        .and_then(Value::as_str)
        .or_else(|| thread.pointer("/settings/model").and_then(Value::as_str))
        .unwrap_or_default()
        .to_owned()
}

fn thread_effort(thread: &Value) -> String {
    thread
        .get("reasoningEffort")
        .and_then(Value::as_str)
        .or_else(|| thread.get("effort").and_then(Value::as_str))
        .or_else(|| thread.pointer("/settings/effort").and_then(Value::as_str))
        .unwrap_or_default()
        .to_owned()
}

fn thread_mode(thread: &Value) -> String {
    thread
        .pointer("/collaborationMode/mode")
        .and_then(Value::as_str)
        .or_else(|| {
            thread
                .pointer("/settings/collaborationMode/mode")
                .and_then(Value::as_str)
        })
        .unwrap_or("default")
        .to_owned()
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}

fn emit_chat_ui(
    events: &broadcast::Sender<ProviderEvent>,
    session_id: &str,
    native_id: Option<&str>,
    ui: &Mutex<CodexUiState>,
    worker_token: &str,
) {
    let data = ui
        .lock()
        .ok()
        .map(|state| {
            let mut wire = state.wire();
            wire["sessionId"] = json!(session_id);
            wire
        })
        .unwrap_or_else(|| json!({"sessionId":session_id,"options":[],"commands":[]}));
    emit_scoped(
        events,
        "codex",
        session_id,
        native_id,
        None,
        "chat.ui",
        data,
        Some(worker_token),
    );
}

fn emit_codex_status_item(
    events: &broadcast::Sender<ProviderEvent>,
    session_id: &str,
    native_id: &str,
    request: CodexStatusCommand<'_>,
    cwd: &str,
    ui: &Arc<Mutex<CodexUiState>>,
    active_turn: &CodexTurnState,
) {
    let active_turn = {
        let (active, _) = &**active_turn;
        active.lock().ok().and_then(|turn| turn.clone())
    };
    let ui = ui.lock().ok();
    let mut status = codex_status_report(native_id, cwd, ui.as_deref(), active_turn.as_ref());
    status["kind"] = json!(request.command);
    let text = codex_status_text_from_report(&status);
    emit_scoped(
        events,
        "codex",
        session_id,
        Some(native_id),
        Some(request.operation_id),
        "chat.item",
        json!({
            "parts":[{
                "type":"status",
                "text":text,
                "status":"complete",
                "data":status
            }],
            "command":request.command
        }),
        Some(request.worker_token),
    );
}

fn clear_codex_turn(state: &CodexTurnState, public_id: &str) {
    let (active, changed) = &**state;
    if let Ok(mut active) = active.lock() {
        if active
            .as_ref()
            .is_some_and(|turn| turn.public_id == public_id)
        {
            *active = None;
            changed.notify_all();
        }
    }
}

fn codex_turn_elapsed_ms(state: &CodexTurnState, public_id: &str) -> Option<u64> {
    let (active, _) = &**state;
    active.lock().ok().and_then(|active| {
        active
            .as_ref()
            .filter(|turn| turn.public_id == public_id)
            .map(|turn| turn.started_at.elapsed().as_millis().min(u64::MAX as u128) as u64)
    })
}

fn codex_turn_assistant_item_id(state: &CodexTurnState, public_id: &str) -> Option<String> {
    let (active, _) = &**state;
    active.lock().ok().and_then(|active| {
        active
            .as_ref()
            .filter(|turn| turn.public_id == public_id)
            .and_then(|turn| turn.assistant_item_id.clone())
    })
}

fn wait_for_codex_native_turn(
    state: &CodexTurnState,
    public_id: &str,
) -> Result<Option<String>, ProviderError> {
    let (active, changed) = &**state;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut active = active
        .lock()
        .map_err(|_| ProviderError::new("provider_internal", "Codex turn lock poisoned"))?;
    loop {
        match active.as_ref() {
            Some(turn) if turn.public_id != public_id => {
                return Err(ProviderError::new(
                    "turn_not_active",
                    "the requested Codex turn is not active",
                ));
            }
            Some(turn) if turn.native_id.is_some() => return Ok(turn.native_id.clone()),
            None => return Ok(None),
            Some(_) => {}
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ProviderError::new(
                "turn_not_started",
                "Codex did not report the native turn id before cancellation",
            ));
        }
        let (next, timeout) = changed
            .wait_timeout(active, remaining)
            .map_err(|_| ProviderError::new("provider_internal", "Codex turn lock poisoned"))?;
        active = next;
        if timeout.timed_out() {
            return Err(ProviderError::new(
                "turn_not_started",
                "Codex did not report the native turn id before cancellation",
            ));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_codex_message(
    events: &broadcast::Sender<ProviderEvent>,
    session_id: &str,
    native: &Mutex<Option<String>>,
    approvals: &Mutex<HashMap<String, PendingCodexApproval>>,
    active_turn: &CodexTurnState,
    ui: &Mutex<CodexUiState>,
    responder: &Mutex<Option<JsonLineResponder>>,
    worker_token: &str,
    raw: Value,
) {
    let native_id = native.lock().ok().and_then(|value| value.clone());
    let method = raw
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("provider.event");
    let params = raw.get("params").cloned().unwrap_or_else(|| raw.clone());
    let provider_turn_id = params
        .get("turnId")
        .or_else(|| params.get("turn").and_then(|turn| turn.get("id")))
        .and_then(Value::as_str);
    let provider_item_id = params
        .get("itemId")
        .or_else(|| params.get("item").and_then(|item| item.get("id")))
        .and_then(Value::as_str);
    let provider_item_type = params
        .get("item")
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str);
    let turn_id = {
        let (active, changed) = &**active_turn;
        active.lock().ok().and_then(|mut active| {
            if method == "turn/started" {
                if let (Some(turn), Some(provider_turn_id)) = (active.as_mut(), provider_turn_id) {
                    turn.native_id = Some(provider_turn_id.to_owned());
                    changed.notify_all();
                }
            }
            if (method == "item/started" && provider_item_type == Some("agentMessage"))
                || method == "item/agentMessage/delta"
            {
                if let (Some(turn), Some(provider_item_id)) = (active.as_mut(), provider_item_id) {
                    turn.assistant_item_id = Some(provider_item_id.to_owned());
                }
            }
            active
                .as_ref()
                .map(|turn| turn.public_id.clone())
                .or_else(|| provider_turn_id.map(ToOwned::to_owned))
        })
    };
    let elapsed_ms = if method == "turn/completed" {
        turn_id
            .as_deref()
            .and_then(|public_id| codex_turn_elapsed_ms(active_turn, public_id))
    } else {
        None
    };
    let assistant_item_id = if method == "turn/completed" {
        turn_id
            .as_deref()
            .and_then(|public_id| codex_turn_assistant_item_id(active_turn, public_id))
    } else {
        None
    };
    if raw.get("id").is_some() && raw.get("method").is_some() {
        if auto_respond_codex(
            responder,
            method,
            raw.get("id").cloned().unwrap_or(Value::Null),
        ) {
            return;
        }
        let supported = matches!(
            method,
            "item/commandExecution/requestApproval"
                | "item/fileChange/requestApproval"
                | "item/permissions/requestApproval"
                | "item/tool/requestUserInput"
                | "mcpServer/elicitation/request"
                | "execCommandApproval"
                | "applyPatchApproval"
        );
        if !supported {
            emit_scoped(
                events,
                "codex",
                session_id,
                native_id.as_deref(),
                turn_id.as_deref(),
                "chat.error",
                json!({
                    "code":"unsupported_server_request","message":format!("Codex requested unsupported interaction {method}"),"raw":raw
                }),
                Some(worker_token),
            );
            return;
        }
        let approval_id = encode_approval_id(raw.get("id").unwrap_or(&Value::Null));
        let (choices, submittable) = codex_choices(method, &params);
        if let Ok(mut pending) = approvals.lock() {
            pending.insert(
                approval_id.clone(),
                PendingCodexApproval {
                    method: method.to_owned(),
                    turn_id: {
                        let (active, _) = &**active_turn;
                        active
                            .lock()
                            .ok()
                            .and_then(|turn| turn.as_ref().map(|turn| turn.public_id.clone()))
                    },
                    params: params.clone(),
                    choices: choices.clone(),
                    submittable,
                    state: PendingApprovalState::default(),
                },
            );
        }
        let title = params
            .get("command")
            .or_else(|| params.pointer("/item/command"))
            .or_else(|| params.get("reason"))
            .and_then(Value::as_str)
            .unwrap_or(method);
        let payload = approval_payload(
            &approval_id,
            "codex",
            method,
            title,
            &params,
            &choices,
            turn_id.as_deref(),
            submittable,
        );
        emit_scoped(
            events,
            "codex",
            session_id,
            native_id.as_deref(),
            turn_id.as_deref(),
            "chat.approval",
            json!({
                "approvalId":approval_id,
                "method":method,
                "request":params,
                "choices":choices,
                "part":{"type":"approval","approvalId":approval_id,"status":"pending","data":payload}
            }),
            Some(worker_token),
        );
        return;
    }
    if method == "thread/settings/updated" {
        if params
            .get("threadId")
            .and_then(Value::as_str)
            .is_some_and(|id| Some(id) != native_id.as_deref())
        {
            return;
        }
        if let Ok(mut state) = ui.lock() {
            let settings = params
                .get("threadSettings")
                .or_else(|| params.get("settings"))
                .unwrap_or(&params);
            adopt_codex_settings(&mut state, settings);
        }
        emit_chat_ui(events, session_id, native_id.as_deref(), ui, worker_token);
        return;
    }
    match method {
        "thread/tokenUsage/updated" => {
            if let Ok(mut state) = ui.lock() {
                state.status.token_usage = params
                    .get("tokenUsage")
                    .cloned()
                    .unwrap_or_else(|| params.clone());
            }
        }
        "thread/name/updated" => {
            if let Ok(mut state) = ui.lock() {
                if let Some(name) = params.get("threadName").or_else(|| params.get("name")) {
                    state.status.thread["name"] = name.clone();
                }
            }
        }
        "thread/status/changed" => {
            if let Ok(mut state) = ui.lock() {
                if let Some(status) = params.get("status") {
                    state.status.thread["status"] = status.clone();
                }
            }
        }
        "account/updated" => {
            if let Ok(mut state) = ui.lock() {
                if state.status.account.is_null() {
                    state.status.account = json!({"account":{}});
                }
                let account = state.status.account.get_mut("account");
                if let Some(account) = account {
                    merge_json_values(account, &params);
                }
            }
        }
        "account/rateLimits/updated" => {
            if let Ok(mut state) = ui.lock() {
                merge_json_values(&mut state.status.rate_limits, &params);
                state.status.rate_limits_loaded = true;
                state.status.rate_limits_error = None;
            }
        }
        _ => {}
    }
    let kind = match method {
        "item/agentMessage/delta" => "chat.delta",
        "item/reasoning/summaryTextDelta"
        | "item/reasoning/textDelta"
        | "item/reasoning/summaryPartAdded" => "chat.delta",
        "item/started" | "item/completed" => "chat.item",
        "turn/started" => "chat.turn.started",
        "turn/completed" | "thread/compacted" => "chat.turn.completed",
        "error" => "chat.error",
        "serverRequest/resolved" => "chat.approval.resolved",
        _ => "provider.event",
    };
    let mut data = match method {
        "item/agentMessage/delta" => json!({
            "part":{"type":"text","text":params.get("delta").and_then(Value::as_str).unwrap_or_default(),"status":"streaming"},
            "raw":raw
        }),
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => json!({
            "part":{"type":"thinking","text":params.get("delta").and_then(Value::as_str).unwrap_or_default(),"status":"streaming"},
            "raw":raw
        }),
        "item/reasoning/summaryPartAdded" => json!({
            "part":{"type":"thinking","text":params.pointer("/summary/text").or_else(||params.get("text")).and_then(Value::as_str).unwrap_or("\n"),"status":"streaming"},
            "raw":raw
        }),
        _ => json!({"raw":raw}),
    };
    if let Some(elapsed_ms) = elapsed_ms {
        data["elapsedMs"] = json!(elapsed_ms);
    }
    if let Some(item_id) = assistant_item_id {
        // The completion event has no native item id. Supplying the last
        // assistant item lets the projection enrich that existing item rather
        // than creating a second, empty assistant row for the duration.
        data["item"] = json!({"id": item_id});
    }
    emit_scoped(
        events,
        "codex",
        session_id,
        native_id.as_deref(),
        turn_id.as_deref(),
        kind,
        data,
        Some(worker_token),
    );
    if matches!(method, "turn/completed" | "thread/compacted" | "error") {
        if let Some(turn_id) = turn_id {
            clear_codex_turn(active_turn, &turn_id);
            if let Ok(mut pending) = approvals.lock() {
                drain_inactive_approvals(&mut pending, |item| item.turn_id.as_deref(), None);
            }
        }
    }
}

/// Codex asks (`mcpServer/elicitation/request`) before every MCP tool call. In
/// a parent Chat, calls to ThreadTerm's own delegation server are accepted
/// here; URL elicitations and every other server still reach the user.
fn approve_threadterm_elicitation(
    responder: &Mutex<Option<JsonLineResponder>>,
    raw: &Value,
) -> bool {
    let Some(id) = raw.get("id").filter(|_| is_threadterm_elicitation(raw)) else {
        return false;
    };
    let Ok(slot) = responder.lock() else {
        return false;
    };
    slot.as_ref().is_some_and(|responder| {
        responder
            .respond(id.clone(), json!({"action":"accept","content":{}}))
            .is_ok()
    })
}

fn is_threadterm_elicitation(raw: &Value) -> bool {
    raw.get("id").is_some()
        && raw.get("method").and_then(Value::as_str) == Some("mcpServer/elicitation/request")
        && raw.pointer("/params/serverName").and_then(Value::as_str)
            == Some(crate::delegation::TOOL_SERVER_NAME)
        && raw.pointer("/params/mode").and_then(Value::as_str) != Some("url")
}

fn auto_respond_codex(
    responder: &Mutex<Option<JsonLineResponder>>,
    method: &str,
    id: Value,
) -> bool {
    let result = match method {
        "currentTime/read" => json!({"currentTimeAt":Utc::now().timestamp()}),
        "item/tool/call" => json!({
            "success":false,
            "contentItems":[{"type":"inputText","text":"ThreadTerm Chat does not execute Codex client-side tools."}]
        }),
        _ => return false,
    };
    if let Ok(slot) = responder.lock() {
        if let Some(responder) = slot.as_ref() {
            let _ = responder.respond(id, result);
        }
    }
    true
}

fn validate_resume_thread(thread: &Value) -> Result<(), ProviderError> {
    let source = thread.get("source");
    let child = source
        .and_then(Value::as_str)
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("subagent"))
        || source.is_some_and(|value| {
            value.get("subAgent").is_some() || value.get("sub_agent").is_some()
        });
    if child || thread.get("ephemeral").and_then(Value::as_bool) == Some(true) {
        return Err(ProviderError::new(
            "history_not_resumable",
            "Only persistent interactive root Codex threads can be resumed",
        ));
    }
    Ok(())
}
fn codex_history_item(thread: &Value) -> Option<Value> {
    let native_id = thread.get("id")?.as_str()?;
    let title = thread
        .get("name")
        .or_else(|| thread.get("preview"))
        .and_then(Value::as_str)
        .unwrap_or("Codex session");
    let updated_at = thread
        .get("updatedAt")
        .or_else(|| thread.get("createdAt"))
        .and_then(Value::as_i64)
        .and_then(|seconds| Utc.timestamp_opt(seconds, 0).single())
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let resumable = validate_resume_thread(thread).is_ok();
    let mut item = json!({
        "provider":"codex",
        "nativeId":native_id,
        "title":title,
        "updatedAt":updated_at,
        "resumable":resumable
    });
    insert_optional(
        &mut item,
        "cwd",
        thread
            .get("cwd")
            .and_then(Value::as_str)
            .map(|value| Value::String(value.to_owned())),
    );
    if !resumable {
        insert_optional(
            &mut item,
            "reason",
            Some(Value::String(
                "Only persistent interactive root Codex threads can be resumed".to_owned(),
            )),
        );
    }
    Some(item)
}

fn codex_transcript_items(thread: &Value) -> Vec<Value> {
    let mut transcript = Vec::new();
    let turns = thread
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for turn in turns {
        let turn_id = turn.get("id").and_then(Value::as_str);
        for item in turn
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let item_type = item
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let (role, parts) = match item_type {
                "userMessage" => (
                    "user",
                    vec![json!({"type":"text","text":extract_text(item)})],
                ),
                "agentMessage" => (
                    "assistant",
                    vec![json!({"type":"text","text":extract_text(item)})],
                ),
                _ => {
                    let mut part = json!({
                        "type":"tool",
                        "toolName":item_type,
                        "data":item
                    });
                    insert_optional(
                        &mut part,
                        "toolId",
                        item.get("id")
                            .and_then(Value::as_str)
                            .map(|value| json!(value)),
                    );
                    insert_optional(
                        &mut part,
                        "status",
                        item.get("status")
                            .and_then(Value::as_str)
                            .map(|value| json!(value)),
                    );
                    crate::file_references::enrich_tool_part(&mut part, None);
                    ("tool", vec![part])
                }
            };
            let mut chat_item = json!({
                "id":item.get("id").and_then(Value::as_str).unwrap_or("unknown"),
                "role":role,
                "parts":parts,
                "createdAt":Utc::now().to_rfc3339()
            });
            insert_optional(&mut chat_item, "turnId", turn_id.map(|value| json!(value)));
            transcript.push(chat_item);
        }
    }
    transcript
}

fn extract_text(item: &Value) -> String {
    item.get("text")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            item.get("content")
                .and_then(Value::as_array)
                .map(|content| {
                    content
                        .iter()
                        .filter_map(|part| part.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("")
                })
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_version_probe_keeps_its_specific_error() {
        assert_eq!(
            codex_capability_reason(false, "unknown", Some("version probe timed out".into())),
            Some("version probe timed out".into())
        );
        assert_eq!(
            codex_capability_reason(false, "unknown", None),
            Some("Codex CLI is not installed".into())
        );
    }

    #[test]
    fn native_reader_producers_keep_the_reserved_worker_token() {
        let (events, mut received) = broadcast::channel(16);
        let native = Mutex::new(Some("native-1".to_owned()));
        let approvals = Mutex::new(HashMap::new());
        let active_turn = new_codex_turn_state();
        let ui = Mutex::new(CodexUiState::default());
        let responder = Mutex::new(None);
        for raw in [
            json!({"method":"turn/started","params":{"turn":{"id":"native-turn"}}}),
            json!({"id":99,"method":"item/commandExecution/requestApproval","params":{"command":"echo qa"}}),
            json!({"method":"thread/settings/updated","params":{"threadSettings":{"model":"qa-model"}}}),
            json!({"kind":"process.error","message":"fake reader EOF"}),
        ] {
            emit_codex_message(
                &events,
                "session-1",
                &native,
                &approvals,
                &active_turn,
                &ui,
                &responder,
                "reserved-token",
                raw,
            );
        }
        let observed: Vec<_> = std::iter::from_fn(|| received.try_recv().ok()).collect();
        assert_eq!(
            observed
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            [
                "chat.turn.started",
                "chat.approval",
                "chat.ui",
                "provider.event"
            ]
        );
        assert!(observed
            .iter()
            .all(|event| event.worker_token.as_deref() == Some("reserved-token")));
        assert_eq!(
            approvals.lock().unwrap().len(),
            1,
            "approval is not auto-submitted"
        );
    }

    #[test]
    fn local_settings_emit_one_turn_and_do_not_complete_an_active_turn() {
        let scratch = tempfile::tempdir().unwrap();
        let log = scratch.path().join("requests.jsonl");
        std::fs::write(&log, "").unwrap();
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../qa/fixtures/fake-codex-slash.cjs");
        let spec = CommandSpec::provider("node", &[fixture.to_str().unwrap()]).unwrap();
        let process = JsonLineProcess::spawn(
            "codex-slash-test",
            &spec,
            None,
            &[
                ("THREADTERM_QA_CODEX_SLASH_LOG", log.to_str().unwrap()),
                (
                    "THREADTERM_QA_CODEX_SLASH_CWD",
                    scratch.path().to_str().unwrap(),
                ),
            ],
            EnvelopeStyle::Codex,
            Arc::new(|_| {}),
        )
        .unwrap();
        let (events, mut received) = broadcast::channel(32);
        let active_turn = new_codex_turn_state();
        let mut chat = CodexChat {
            process,
            native_id: "qa-codex-slash-thread".to_owned(),
            approvals: Arc::new(Mutex::new(HashMap::new())),
            active_turn: Arc::clone(&active_turn),
            session_id: "session-qa".to_owned(),
            cwd: scratch.path().to_string_lossy().into_owned(),
            events,
            ui: Arc::new(Mutex::new(CodexUiState {
                options: vec![
                    json!({"id":"model","value":"qa-model-a"}),
                    json!({"id":"collaboration","value":"default"}),
                ],
                ..CodexUiState::default()
            })),
            worker_token: "qa-worker-token".to_owned(),
        };
        for (command, turn, expected_kind) in [
            ("/model", "query", "chat.item"),
            ("/plan invalid", "invalid", "chat.error"),
            ("/plan", "plan", "chat.item"),
        ] {
            assert_eq!(chat.send(command, turn).unwrap()["turnId"], turn);
            let kinds = std::iter::from_fn(|| received.try_recv().ok())
                .filter(|event| event.kind.starts_with("chat.") && event.kind != "chat.ui")
                .map(|event| {
                    assert_eq!(event.turn_id.as_deref(), Some(turn));
                    assert_eq!(event.worker_token.as_deref(), Some("qa-worker-token"));
                    event.kind
                })
                .collect::<Vec<_>>();
            assert_eq!(
                kinds,
                vec![
                    "chat.turn.started".to_owned(),
                    expected_kind.to_owned(),
                    "chat.turn.completed".to_owned()
                ]
            );
        }
        assert_eq!(
            chat.send("/status", "status-turn").unwrap()["turnId"],
            "status-turn"
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut status_items = 0;
        while status_items < 3 && Instant::now() < deadline {
            match received.try_recv() {
                Ok(event) => {
                    assert_eq!(event.worker_token.as_deref(), Some("qa-worker-token"));
                    if event.kind == "chat.item" && event.turn_id.as_deref() == Some("status-turn")
                    {
                        status_items += 1;
                    }
                }
                Err(broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                other => panic!("scoped /status callback failed: {other:?}"),
            }
        }
        assert_eq!(
            status_items, 3,
            "cached status and both async account callbacks"
        );
        let before = std::fs::read_to_string(&log).unwrap();
        let image = vec!["data:image/png;base64,cG5n".to_owned()];
        for (command, _) in CODEX_SLASH_COMMANDS {
            let error = chat
                .validate_send_with_images(&format!("/{command}"), &image)
                .unwrap_err();
            assert_eq!(error.code, "images_not_supported_for_command", "/{command}");
        }
        assert_eq!(std::fs::read_to_string(&log).unwrap(), before);
        chat.ui.lock().unwrap().skills.push(CodexSkill {
            name: "probe".to_owned(),
            path: "/tmp/probe".to_owned(),
        });
        chat.send_with_images("/probe inspect", &image, "skill-image-turn")
            .unwrap();
        std::thread::sleep(Duration::from_millis(25));
        let requests = std::fs::read_to_string(&log).unwrap();
        assert!(requests.contains("\"type\":\"skill\""));
        assert!(requests.contains("\"type\":\"image\",\"url\":\"data:image/png;base64,cG5n\""));
        let (active, _) = &*active_turn;
        *active.lock().unwrap() = None;
        chat.send_with_images("", &image, "image-only-turn")
            .unwrap();
        std::thread::sleep(Duration::from_millis(25));
        let requests = std::fs::read_to_string(&log).unwrap();
        assert!(requests.contains("\"clientUserMessageId\":\"image-only-turn\",\"input\":[{\"type\":\"image\",\"url\":\"data:image/png;base64,cG5n\"}]"));
        *active.lock().unwrap() = None;
        let before_conflict = std::fs::read_to_string(&log).unwrap();
        {
            let (active, _) = &*active_turn;
            *active.lock().unwrap() = Some(ActiveCodexTurn {
                public_id: "normal-turn".to_owned(),
                native_id: Some("native-normal".to_owned()),
                assistant_item_id: None,
                started_at: Instant::now(),
            });
        }
        assert_eq!(
            chat.validate_send("/plan").unwrap_err().code,
            "turn_in_progress"
        );
        assert_eq!(
            chat.send("/plan", "conflict").unwrap_err().code,
            "turn_in_progress"
        );
        assert!(received.try_recv().is_err());
        assert_eq!(std::fs::read_to_string(&log).unwrap(), before_conflict);
        let (active, _) = &*active_turn;
        assert_eq!(
            active.lock().unwrap().as_ref().unwrap().public_id,
            "normal-turn"
        );
        *active.lock().unwrap() = None;
        assert_eq!(
            chat.send("qa fail ordinary turn", "failed-turn").unwrap()["turnId"],
            "failed-turn"
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match received.try_recv() {
                Ok(event) if event.kind == "chat.error" => {
                    assert_eq!(event.turn_id.as_deref(), Some("failed-turn"));
                    assert_eq!(event.worker_token.as_deref(), Some("qa-worker-token"));
                    break;
                }
                Ok(_) | Err(broadcast::error::TryRecvError::Empty) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                other => panic!("missing scoped async turn/start error: {other:?}"),
            }
        }
    }
    #[test]
    fn child_and_ephemeral_threads_are_not_interactive_resume_targets() {
        for thread in [
            json!({"source":{"subAgent":{"review":{}}}}),
            json!({"source":"subAgent"}),
            json!({"ephemeral":true}),
        ] {
            assert!(validate_resume_thread(&thread).is_err());
        }
        assert!(validate_resume_thread(&json!({"source":"cli","ephemeral":false})).is_ok());
    }

    #[test]
    fn terminal_output_never_becomes_codex_identity_evidence() {
        // Codex identity is obtained only from app-server thread/start. There
        // is intentionally no output parser that could bind spoofed text.
        let adapter = CodexAdapter::new(broadcast::channel(1).0);
        assert_eq!(
            adapter.terminal_capture(),
            super::super::TerminalCapture::PreAssigned
        );
    }

    #[test]
    fn precreated_thread_id_launches_codex_resume_without_output_parsing() {
        let adapter = CodexAdapter::new(broadcast::channel(1).0);
        let id = "01a0be7e-b463-7bd0-8d12-c184185b3a0f";
        let command = adapter.terminal_command(None, Some(id)).unwrap();
        assert!(command
            .args
            .windows(2)
            .any(|pair| { pair[0] == "resume" && pair[1] == id }));
        assert!(command.args.contains(&"--no-alt-screen".to_owned()));
    }

    #[test]
    fn history_item_keeps_native_identity() {
        let item = codex_history_item(&json!({
            "id":"thr_1","preview":"Fix tests","cwd":"D:/repo","updatedAt":1,"ephemeral":false
        }))
        .unwrap();
        assert_eq!(item["nativeId"], "thr_1");
        assert_eq!(item["resumable"], true);
        assert!(item.get("reason").is_none());
    }

    #[test]
    fn history_listing_does_not_filter_out_runtime_started_threads() {
        assert!(history_list_params(None, 20, None)
            .get("sourceKinds")
            .is_none());
    }

    #[test]
    fn transcript_preserves_tool_parts() {
        let items = codex_transcript_items(&json!({"turns":[{"id":"turn_1","items":[
            {"id":"i1","type":"agentMessage","text":"done"},
            {"id":"i2","type":"commandExecution","status":"completed"},
            {"id":"i3","type":"fileChange","status":"failed","changes":[{"path":"src/a.rs"},{"path":"src/b.rs"}]}
        ]}]}));
        assert_eq!(items[0]["parts"][0]["text"], "done");
        assert_eq!(items[1]["parts"][0]["toolName"], "commandExecution");
        assert_eq!(
            items[2]["parts"][0]["fileReferences"],
            json!([{"path":"src/a.rs"},{"path":"src/b.rs"}])
        );
    }

    #[test]
    fn settings_params_use_codex_field_names() {
        assert_eq!(
            codex_settings_params("model", "thr", "gpt-5.5-luna", None).unwrap(),
            json!({"threadId":"thr","model":"gpt-5.5-luna"})
        );
        assert_eq!(
            codex_settings_params("thinking", "thr", "high", None).unwrap(),
            json!({"threadId":"thr","effort":"high"})
        );
        assert_eq!(
            codex_settings_params(
                "collaboration",
                "thr",
                "plan",
                Some(&CodexUiState {
                    options: vec![json!({"id":"model","value":"catalog-model"})],
                    ..CodexUiState::default()
                })
            )
            .unwrap()["collaborationMode"]["mode"],
            "plan"
        );
        assert!(codex_settings_params("unknown", "thr", "auto", None).is_none());
    }

    #[test]
    fn options_come_from_catalog_and_thread() {
        let process_input = json!({
            "data":[
                {"id":"gpt-6-astra","displayName":"GPT-6-Astra","hidden":false,"supportedReasoningEfforts":[
                    {"reasoningEffort":"low"},{"reasoningEffort":"xhigh"}
                ]},
                {"id":"internal","displayName":"Hidden","hidden":true},
                {"id":"gpt-5.5-luna","displayName":"GPT-5.5-Luna","hidden":false,"supportedReasoningEfforts":[
                    {"reasoningEffort":"low","description":"low"},{"reasoningEffort":"xhigh","description":"extra high"}
                ]}
            ]
        });
        let options = codex_options_from_catalog(
            &process_input,
            &json!({"model":"gpt-5.5-luna","reasoningEffort":"xhigh"}),
        );
        assert_eq!(options.len(), 5);
        assert_eq!(options[0]["id"], "model");
        assert_eq!(options[0]["value"], "gpt-5.5-luna");
        assert_eq!(options[0]["choices"].as_array().unwrap().len(), 2);
        assert_eq!(options[1]["id"], "thinking");
        assert_eq!(options[1]["value"], "xhigh");
        assert_eq!(options[1]["choices"][1]["name"], "Xhigh");
        assert_eq!(options[2]["id"], "collaboration");
        assert_eq!(options[2]["value"], "default");
    }

    #[test]
    fn unknown_model_omits_thinking_choices() {
        let process_input = json!({
            "data":[{"id":"gpt-6-astra","displayName":"GPT-6-Astra","hidden":false,"supportedReasoningEfforts":[
                {"reasoningEffort":"low"}
            ]}]
        });
        let options = codex_options_from_catalog(
            &process_input,
            &json!({"model":"custom-model","reasoningEffort":"low"}),
        );
        assert_eq!(options.len(), 4);
        assert_eq!(options[0]["value"], "custom-model");
        assert_eq!(options[1]["id"], "collaboration");
    }

    #[test]
    fn hidden_test_model_stays_selectable() {
        let options = codex_options_from_catalog(
            &json!({"data":[
                {"id":"gpt-5.6-luna","displayName":"GPT-5.6-Luna","hidden":false,"supportedReasoningEfforts":[{"reasoningEffort":"low"}]},
                {"id":"gpt-5.5-luna","displayName":"GPT-5.5-Luna","hidden":true,"supportedReasoningEfforts":[{"reasoningEffort":"medium"}]}
            ]}),
            &json!({"model":"gpt-5.5-luna","reasoningEffort":"medium"}),
        );
        let models = options[0]["choices"].as_array().unwrap();
        assert!(models
            .iter()
            .any(|choice| choice["value"] == "gpt-5.5-luna"));
        assert_eq!(options[1]["id"], "thinking");
        assert_eq!(options[1]["value"], "medium");
    }

    #[test]
    fn slash_commands_include_builtins_and_skills() {
        let commands = merge_codex_commands(&[CodexSkill {
            name: "demo-skill".to_owned(),
            path: "/tmp/demo".to_owned(),
        }]);
        assert!(commands.iter().any(|command| command["name"] == "compact"));
        assert!(commands.iter().any(|command| command["name"] == "review"));
        assert!(commands.iter().any(|command| command["name"] == "status"));
        assert!(commands
            .iter()
            .any(|command| command["name"] == "demo-skill"));
        assert_eq!(parse_slash("/compact"), Some(("compact", "")));
        assert_eq!(parse_slash("/status"), Some(("status", "")));
        assert_eq!(
            parse_slash("/model gpt-5.5-luna"),
            Some(("model", "gpt-5.5-luna"))
        );
        let ui = CodexUiState {
            skills: vec![CodexSkill {
                name: "demo-skill".to_owned(),
                path: "/tmp/demo".to_owned(),
            }],
            ..CodexUiState::default()
        };
        assert_eq!(
            turn_input_for("/demo-skill now", Some(&ui)).unwrap(),
            vec![
                json!({"type":"skill","name":"demo-skill","path":"/tmp/demo"}),
                json!({"type":"text","text":"now"})
            ]
        );
    }

    #[test]
    fn status_text_reports_local_session_state() {
        let ui = CodexUiState {
            options: vec![
                json!({"id":"model","value":"gpt-5.5-luna"}),
                json!({"id":"thinking","value":"high"}),
                json!({"id":"collaboration","value":"plan"}),
            ],
            ..CodexUiState::default()
        };
        let active_turn = ActiveCodexTurn {
            public_id: "operation-1".to_owned(),
            native_id: Some("turn-1".to_owned()),
            assistant_item_id: None,
            started_at: Instant::now(),
        };
        let status = codex_status_text("thread-1", "D:/workspace", Some(&ui), Some(&active_turn));
        assert!(status.contains("Thread: thread-1"));
        assert!(status.contains("Directory: D:/workspace"));
        assert!(status.contains("Model: gpt-5.5-luna"));
        assert!(status.contains("Thinking: high"));
        assert!(status.contains("Mode: plan"));
        assert!(status.contains("Turn: active (turn-1)"));
        assert!(codex_status_text("thread-1", "D:/workspace", None, None).contains("Turn: idle"));
    }

    #[test]
    fn elapsed_turn_time_is_scoped_to_the_active_codex_turn() {
        let state = new_codex_turn_state();
        {
            let (active, _) = &*state;
            *active.lock().unwrap() = Some(ActiveCodexTurn {
                public_id: "operation-1".to_owned(),
                native_id: Some("turn-1".to_owned()),
                assistant_item_id: Some("item-1".to_owned()),
                started_at: Instant::now() - Duration::from_millis(25),
            });
        }
        let elapsed = codex_turn_elapsed_ms(&state, "operation-1").unwrap();
        assert!(elapsed >= 25);
        assert_eq!(
            codex_turn_assistant_item_id(&state, "operation-1").as_deref(),
            Some("item-1")
        );
        assert!(codex_turn_elapsed_ms(&state, "operation-2").is_none());
    }

    #[test]
    fn status_report_keeps_native_metadata_context_and_dynamic_limits() {
        let ui = CodexUiState {
            options: vec![
                json!({"id":"model","value":"gpt-5.5-luna"}),
                json!({"id":"thinking","value":"high"}),
                json!({"id":"collaboration","value":"plan"}),
            ],
            status: CodexStatusState {
                thread: json!({
                    "id":"thread-1","name":"Investigate","sessionId":"session-1",
                    "cwd":"D:/workspace","cliVersion":"codex-0.153.4"
                }),
                thread_response: json!({
                    "approvalPolicy":"on-request",
                    "approvalsReviewer":"user",
                    "sandbox":{"type":"workspaceWrite","writableRoots":["D:/workspace"]},
                    "instructionSources":["D:/workspace/AGENTS.md"]
                }),
                thread_settings: json!({"summary":"auto","collaborationMode":{"mode":"plan"}}),
                account: json!({"account":{"type":"chatgpt","planType":"prolite","email":"qa@example.com"},"requiresOpenaiAuth":true}),
                rate_limits: json!({"rateLimitsByLimitId":{
                    "codex":{"limitId":"codex","limitName":"Codex","primary":{"usedPercent":24,"windowDurationMins":300}},
                    "models":{"limitId":"models","limitName":"Models","primary":{"usedPercent":8,"windowDurationMins":1440}}
                }}),
                token_usage: json!({"last":{"totalTokens":94700},"modelContextWindow":258000}),
                account_loaded: true,
                rate_limits_loaded: true,
                ..CodexStatusState::default()
            },
            ..CodexUiState::default()
        };
        let report = codex_status_report("thread-1", "D:/workspace", Some(&ui), None);
        assert_eq!(report["cliVersion"], "codex-0.153.4");
        assert_eq!(report["approvalPolicy"], "on-request");
        assert_eq!(report["instructionSources"][0], "D:/workspace/AGENTS.md");
        assert_eq!(report["account"]["planType"], "prolite");
        assert_eq!(report["requiresOpenaiAuth"], true);
        assert!(report.get("warning").is_none());
        assert_eq!(report["context"]["modelContextWindow"], 258000);
        assert_eq!(report["context"]["remainingTokens"], 163300);
        assert!(report["context"]["percentUsed"].as_f64().unwrap() > 66.0);
        assert_eq!(report["rateLimits"].as_array().unwrap().len(), 2);
        assert_eq!(report["rateLimitsLoaded"], true);
        assert_eq!(report["collaborationMode"], "plan");
    }

    #[test]
    fn status_item_marks_requested_command_without_dropping_report_data() {
        let (events, mut receiver) = broadcast::channel(4);
        let ui = Arc::new(Mutex::new(CodexUiState {
            status: CodexStatusState {
                account: json!({"account":{"type":"chatgpt","planType":"prolite"}}),
                token_usage: json!({"last":{"totalTokens":42},"modelContextWindow":128000}),
                ..CodexStatusState::default()
            },
            ..CodexUiState::default()
        }));
        let active_turn = new_codex_turn_state();

        emit_codex_status_item(
            &events,
            "session-1",
            "thread-1",
            CodexStatusCommand {
                operation_id: "status-turn",
                command: "status",
                worker_token: "status-worker-token",
            },
            "D:/workspace",
            &ui,
            &active_turn,
        );
        emit_codex_status_item(
            &events,
            "session-1",
            "thread-1",
            CodexStatusCommand {
                operation_id: "usage-turn",
                command: "usage",
                worker_token: "status-worker-token",
            },
            "D:/workspace",
            &ui,
            &active_turn,
        );

        let status = receiver.try_recv().unwrap();
        let usage = receiver.try_recv().unwrap();
        assert_eq!(status.worker_token.as_deref(), Some("status-worker-token"));
        assert_eq!(usage.worker_token.as_deref(), Some("status-worker-token"));
        assert_eq!(status.data["command"], "status");
        assert_eq!(status.data["parts"][0]["data"]["kind"], "status");
        assert_eq!(usage.data["command"], "usage");
        assert_eq!(usage.data["parts"][0]["data"]["kind"], "usage");
        assert_eq!(
            usage.data["parts"][0]["data"]["account"]["planType"],
            "prolite"
        );
        assert_eq!(usage.data["parts"][0]["data"]["context"]["usedTokens"], 42);
    }

    #[test]
    fn rate_limit_load_state_distinguishes_pending_empty_and_error() {
        let pending = codex_status_report(
            "thread-1",
            "D:/workspace",
            Some(&CodexUiState::default()),
            None,
        );
        assert_eq!(pending["rateLimitsLoaded"], false);
        assert_eq!(pending["rateLimits"], json!([]));
        assert!(pending.get("warning").is_none());

        let resolved = codex_status_report(
            "thread-1",
            "D:/workspace",
            Some(&CodexUiState {
                status: CodexStatusState {
                    rate_limits_loaded: true,
                    ..CodexStatusState::default()
                },
                ..CodexUiState::default()
            }),
            None,
        );
        assert_eq!(resolved["rateLimitsLoaded"], true);
        assert_eq!(resolved["rateLimits"], json!([]));
        assert!(resolved.get("warning").is_none());

        let failed = codex_status_report(
            "thread-1",
            "D:/workspace",
            Some(&CodexUiState {
                status: CodexStatusState {
                    rate_limits_loaded: true,
                    rate_limits_error: Some("offline".to_owned()),
                    ..CodexStatusState::default()
                },
                ..CodexUiState::default()
            }),
            None,
        );
        assert_eq!(failed["rateLimitsLoaded"], true);
        assert_eq!(failed["rateLimits"], json!([]));
        assert_eq!(failed["warning"], "rate-limit data unavailable");
    }

    #[test]
    fn status_report_warns_when_auth_is_required_without_account() {
        let ui = CodexUiState {
            status: CodexStatusState {
                account: json!({"requiresOpenaiAuth":true}),
                account_loaded: true,
                ..CodexStatusState::default()
            },
            ..CodexUiState::default()
        };
        let report = codex_status_report("thread-1", "D:/workspace", Some(&ui), None);
        assert_eq!(report["requiresOpenaiAuth"], true);
        assert_eq!(report["warning"], "OpenAI authentication required");
    }

    #[test]
    fn status_report_does_not_treat_loading_account_as_auth_failure() {
        let ui = CodexUiState {
            status: CodexStatusState {
                account: json!({"requiresOpenaiAuth":true}),
                ..CodexStatusState::default()
            },
            ..CodexUiState::default()
        };
        let report = codex_status_report("thread-1", "D:/workspace", Some(&ui), None);
        assert!(report["requiresOpenaiAuth"].is_null());
        assert!(report.get("warning").is_none());
    }

    #[test]
    fn sparse_rate_limit_updates_merge_without_erasing_buckets() {
        let mut value = json!({
            "rateLimitsByLimitId":{"codex":{"limitId":"codex","primary":{"usedPercent":20},"secondary":{"usedPercent":40}}},
            "rateLimits":{"limitId":"codex","primary":{"usedPercent":20}}
        });
        merge_json_values(
            &mut value,
            &json!({"rateLimits":{"limitId":"codex","primary":{"usedPercent":35}}}),
        );
        assert_eq!(value["rateLimits"]["primary"]["usedPercent"], 35);
        assert_eq!(
            value["rateLimitsByLimitId"]["codex"]["secondary"]["usedPercent"],
            40
        );
    }

    #[test]
    fn context_percent_uses_codex_reserved_baseline() {
        let percent = context_percent(258_000, 94_700);
        assert!(percent > 66.0 && percent < 67.0);
        assert_eq!(context_percent(12_000, 12_000), 0.0);
        assert_eq!(context_percent(258_000, 300_000), 0.0);
    }

    #[test]
    fn switching_model_keeps_supported_effort() {
        let ui = CodexUiState {
            catalog: json!({"data":[{"id":"gpt-5.5-luna","defaultReasoningEffort":"medium","supportedReasoningEfforts":[
                {"reasoningEffort":"low"},{"reasoningEffort":"medium"},{"reasoningEffort":"xhigh"}
            ]}]}),
            options: vec![json!({"id":"thinking","value":"xhigh"})],
            ..CodexUiState::default()
        };
        let params = codex_settings_params("model", "thr", "gpt-5.5-luna", Some(&ui)).unwrap();
        assert_eq!(params["effort"], "xhigh");
    }

    #[test]
    fn every_advertised_command_is_blocked_from_plain_model_input() {
        for (command, _) in CODEX_SLASH_COMMANDS {
            assert!(
                turn_input_for(&format!("/{command}"), None).is_err(),
                "{command}"
            );
            assert!(
                turn_input_for(&format!("/{command} args"), None).is_err(),
                "{command} with arguments"
            );
            assert!(
                is_codex_local_command(command)
                    || matches!(
                        *command,
                        "model"
                            | "plan"
                            | "approvals"
                            | "sandbox"
                            | "status"
                            | "usage"
                            | "compact"
                            | "review"
                    ),
                "{command} has no dispatcher route"
            );
        }
        assert_eq!(
            turn_input_for("/tmp/example.rs", None).unwrap(),
            vec![json!({"type":"text","text":"/tmp/example.rs"})]
        );
    }

    #[test]
    fn permissions_use_native_fields_and_collaboration_stays_separate() {
        let mut ui = CodexUiState {
            catalog: json!({"data":[]}),
            ..CodexUiState::default()
        };
        let settings = json!({"model":"current-hidden-model","approvalPolicy":"on-request","sandboxPolicy":{"type":"readOnly","networkAccess":false},"collaborationMode":{"mode":"plan"}});
        adopt_codex_settings(&mut ui, &settings);
        assert_eq!(
            option_value(Some(&ui), "mode").as_deref(),
            Some("on-request")
        );
        assert_eq!(
            option_value(Some(&ui), "collaboration").as_deref(),
            Some("plan")
        );
        assert_eq!(
            option_value(Some(&ui), "sandbox").as_deref(),
            Some("read-only")
        );
        let params = codex_settings_params("mode", "thr", "never", Some(&ui)).unwrap();
        assert_eq!(params, json!({"threadId":"thr","approvalPolicy":"never"}));
        assert!(!codex_settings_confirmed(&settings, &params));
        assert!(codex_settings_params("mode", "thr", "plan", Some(&ui)).is_none());
        let sandbox =
            codex_settings_params("sandbox", "thr", "workspace-write", Some(&ui)).unwrap();
        assert_eq!(sandbox["sandboxPolicy"]["type"], "workspaceWrite");
        assert_eq!(sandbox["sandboxPolicy"]["networkAccess"], false);
        assert!(codex_settings_confirmed(
            &json!({"sandboxPolicy":{"type":"workspaceWrite","networkAccess":false,"writableRoots":[],"excludeSlashTmp":false}}),
            &sandbox
        ));
    }

    #[test]
    fn ignored_settings_are_not_confirmation_and_errors_do_not_trigger_fallback() {
        let params = json!({"threadId":"thr","approvalPolicy":"never"});
        assert!(!codex_settings_confirmed(&json!({}), &params));
        assert!(!codex_settings_confirmed(
            &json!({"approvalPolicy":"on-request"}),
            &params
        ));
        assert!(codex_settings_confirmed(
            &json!({"approvalPolicy":"never"}),
            &params
        ));
        for (code, message) in [
            (-32601, "Method not found"),
            (
                -32600,
                "Invalid request: unknown variant `thread/settings/update`, expected one of ...",
            ),
        ] {
            let error = codex_protocol_error(
                "thread/settings/update",
                ProviderError::new("provider_error", message).with_details(json!({"code":code})),
            );
            assert_eq!(error.code, "provider_method_unsupported");
            assert!(error.message.contains("Update Codex"));
        }
        let error = codex_protocol_error(
            "thread/settings/update",
            ProviderError::new("provider_error", "unknown variant `invalid-policy`")
                .with_details(json!({"code":-32600})),
        );
        assert_eq!(error.code, "provider_error");
    }

    #[test]
    fn arbitrary_current_hidden_model_remains_selectable_without_pinned_ids() {
        let options = codex_options_from_catalog(
            &json!({"data":[{"id":"hidden-current","hidden":true,"supportedReasoningEfforts":[{"reasoningEffort":"high"}]},{"id":"hidden-other","hidden":true}]}),
            &json!({"model":"hidden-current","effort":"high"}),
        );
        assert_eq!(
            options[0]["choices"],
            json!([{"value":"hidden-current","name":"hidden-current"}])
        );
        assert_eq!(options[1]["id"], "thinking");
    }

    #[test]
    fn native_images_keep_data_urls_as_native_image_items() {
        let image = "data:image/png;base64,cG5n".to_owned();
        assert_eq!(
            native_image_inputs(std::slice::from_ref(&image)),
            vec![json!({"type":"image","url":image})]
        );
        let mut text_and_image = native_image_inputs(std::slice::from_ref(&image));
        text_and_image.push(json!({"type":"text","text":"describe this"}));
        assert_eq!(
            text_and_image,
            vec![
                json!({"type":"image","url":image}),
                json!({"type":"text","text":"describe this"})
            ]
        );
    }

    #[test]
    fn delegation_tool_server_becomes_per_process_config_overrides() {
        assert!(codex_tool_server_overrides(None).is_empty());
        let tools = ChatToolServer {
            name: "threadterm".into(),
            command: r"C:\Program Files\ThreadTerm\runtime\threadterm-v3-mcp.exe".into(),
            args: Vec::new(),
            env: vec![
                ("THREADTERM_SESSION_ID".into(), "s-1".into()),
                ("THREADTERM_V3_PIPE".into(), r"\\.\pipe\threadterm-v3-x".into()),
                ("ODD".into(), "it's".into()),
            ],
        };
        assert_eq!(
            codex_tool_server_overrides(Some(&tools)),
            vec![
                "-c",
                r"mcp_servers.threadterm.command='C:\Program Files\ThreadTerm\runtime\threadterm-v3-mcp.exe'",
                "-c",
                "mcp_servers.threadterm.args=[]",
                "-c",
                r#"mcp_servers.threadterm.env={THREADTERM_SESSION_ID='s-1',THREADTERM_V3_PIPE='\\.\pipe\threadterm-v3-x',ODD="it's"}"#,
            ]
        );
    }

    #[test]
    fn only_threadterm_form_elicitations_are_accepted_automatically() {
        let request = |params: Value| {
            json!({"id":1,"method":"mcpServer/elicitation/request","params":params})
        };
        assert!(is_threadterm_elicitation(&request(
            json!({"serverName":"threadterm","threadId":"t","mode":"form","message":"Allow?"})
        )));
        assert!(!is_threadterm_elicitation(&request(
            json!({"serverName":"codegraph","threadId":"t","mode":"form"})
        )));
        assert!(!is_threadterm_elicitation(&request(
            json!({"serverName":"threadterm","threadId":"t","mode":"url","url":"https://example.com"})
        )));
        assert!(!is_threadterm_elicitation(
            &json!({"id":2,"method":"item/tool/call","params":{"serverName":"threadterm"}})
        ));
        // Without a live responder nothing is claimed, so the request still
        // reaches normal handling.
        assert!(!approve_threadterm_elicitation(
            &Mutex::new(None),
            &request(json!({"serverName":"threadterm","threadId":"t","mode":"form"}))
        ));
    }
}
