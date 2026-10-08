use super::{
    approval::{approval_payload, ApprovalChoice},
    common::{
        command_output, find_executable, history_page, insert_optional, validate_native_id,
        version_probe, CommandSpec, EnvelopeStyle, JsonLineProcess,
    },
    emit_scoped, ChatSession, ChatToolServer, ProviderAdapter, ProviderCapability, ProviderError,
    TerminalCommand,
};
use chrono::{TimeZone, Utc};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

pub struct ClaudeAdapter {
    events: crate::provider_events::Sender,
}

/// Tracks whether the SDK query inside a Claude sidecar has ended. The host
/// Node process can stay alive after the query finished, so process liveness
/// alone is not evidence the Chat session is usable.
#[derive(Clone, Default)]
pub(crate) struct WorkerLiveness {
    ended: Arc<std::sync::atomic::AtomicBool>,
}

impl WorkerLiveness {
    fn mark_ended(&self) {
        self.ended.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    pub(crate) fn ended(&self) -> bool {
        self.ended.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// Latest Chat options and command menu published by the sidecar (`session.ui`).
#[derive(Clone, Default)]
pub(crate) struct ClaudeUi(Arc<Mutex<Option<Value>>>, Arc<Mutex<ClaudeSubagents>>);

#[derive(Default)]
struct ClaudeSubagents {
    agents: HashMap<String, ClaudeSubagent>,
    tasks: HashMap<String, String>,
    task_agents: HashMap<String, String>,
    ignored_tasks: HashSet<String>,
    pending_tasks: VecDeque<Value>,
}

struct ClaudeSubagent {
    root: String,
    task_id: Option<String>,
    backgrounded: bool,
    label: String,
}

impl ClaudeUi {
    fn replace(&self, ui: &Value) {
        if !ui.is_object() {
            return;
        }
        if let Ok(mut state) = self.0.lock() {
            *state = Some(ui.clone());
        }
    }

    fn wire(&self) -> Value {
        let state = self.0.lock().ok().and_then(|state| state.clone());
        let list = |key: &str| {
            state
                .as_ref()
                .and_then(|ui| ui.get(key))
                .filter(|value| value.is_array())
                .cloned()
                .unwrap_or_else(|| json!([]))
        };
        json!({"options":list("options"),"commands":list("commands")})
    }
}

impl ClaudeAdapter {
    pub fn new(events: crate::provider_events::Sender) -> Self {
        Self { events }
    }

    fn worker_spec(&self) -> Result<CommandSpec, ProviderError> {
        let script = claude_worker_path().ok_or_else(|| {
            ProviderError::unavailable(
                "claude",
                "Claude Agent SDK worker was not built; run the claude-sdk workspace build",
            )
        })?;
        let node = std::env::var_os("THREADTERM_CLAUDE_NODE")
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .or_else(|| find_executable("node"))
            .ok_or_else(|| {
                ProviderError::unavailable(
                    "claude",
                    "Node.js was not found for the Claude Agent SDK worker",
                )
            })?;
        CommandSpec::from_path(node, vec![script.to_string_lossy().into_owned()])
    }

    fn spawn(
        &self,
        session_id: &str,
        native: Arc<Mutex<Option<String>>>,
        project_events: bool,
    ) -> Result<JsonLineProcess, ProviderError> {
        self.spawn_with_liveness(
            session_id,
            native,
            project_events,
            None,
            ClaudeUi::default(),
        )
        .map(|(process, _)| process)
    }

    fn spawn_with_liveness(
        &self,
        session_id: &str,
        native: Arc<Mutex<Option<String>>>,
        project_events: bool,
        worker_token: Option<&str>,
        ui: ClaudeUi,
    ) -> Result<(JsonLineProcess, WorkerLiveness), ProviderError> {
        let spec = self.worker_spec()?;
        let worker_env: &[(&str, &str)] = if claude_worker_uses_electron_node() {
            &[("ELECTRON_RUN_AS_NODE", "1")]
        } else {
            &[]
        };
        let events = self.events.clone();
        let owned_session = session_id.to_owned();
        let owned_token = worker_token.map(ToOwned::to_owned);
        let liveness = WorkerLiveness::default();
        let liveness_ref = liveness.clone();
        let on_message = Arc::new(move |raw| {
            if project_events {
                emit_claude_message(
                    &events,
                    &owned_session,
                    &native,
                    &liveness_ref,
                    &ui,
                    owned_token.as_deref(),
                    raw,
                );
            }
        });
        let process = JsonLineProcess::spawn(
            "claude-sdk",
            &spec,
            None,
            worker_env,
            EnvelopeStyle::Sidecar,
            on_message,
        )?;
        process.sidecar_request("host.ping", json!({}))?;
        Ok((process, liveness))
    }

    fn temporary(&self) -> Result<JsonLineProcess, ProviderError> {
        self.spawn("history", Arc::new(Mutex::new(None)), false)
    }

    fn open_chat_worker(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
        worker_token: Option<&str>,
        tools: Option<&ChatToolServer>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        // Credentials are not pre-checked here: the sidecar rejects a signed-out
        // handshake with the exact reason, whatever auth source Claude Code uses.
        if let Some(id) = native_id {
            validate_native_id(id)?;
        }
        let native = Arc::new(Mutex::new(native_id.map(ToOwned::to_owned)));
        let ui = ClaudeUi::default();
        let (process, liveness) = self.spawn_with_liveness(
            session_id,
            Arc::clone(&native),
            true,
            worker_token,
            ui.clone(),
        )?;
        let mut start = json!({"cardId":session_id,"cwd":cwd,"sessionId":native_id});
        if let Some(tools) = tools {
            // Agent SDK `mcpServers` query option (verified with SDK 0.3.266).
            let env = tools
                .env
                .iter()
                .map(|(key, value)| (key.clone(), Value::String(value.clone())))
                .collect::<serde_json::Map<String, Value>>();
            let mut servers = serde_json::Map::new();
            servers.insert(
                tools.name.clone(),
                json!({"type":"stdio","command":tools.command,"args":tools.args,"env":env}),
            );
            start["mcpServers"] = Value::Object(servers);
        }
        let result = process.sidecar_request("session.start", start)?;
        if let Some(state) = result.get("ui") {
            ui.replace(state);
        }
        if liveness.ended() {
            return Err(ProviderError::new(
                "provider_disconnected",
                "Claude SDK query ended during initialization",
            ));
        }
        let learned = native.lock().ok().and_then(|value| value.clone());
        let bound = result
            .get("sessionId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or(learned)
            .or_else(|| native_id.map(ToOwned::to_owned));
        Ok(Box::new(ClaudeChat {
            process,
            session_id: session_id.to_owned(),
            native_id: bound,
            liveness,
            ui,
            events: self.events.clone(),
            worker_token: worker_token.map(ToOwned::to_owned),
        }))
    }
}

fn claude_worker_uses_electron_node() -> bool {
    std::env::var_os("THREADTERM_CLAUDE_ELECTRON_NODE").is_some_and(|value| value == "1")
}

impl ProviderAdapter for ClaudeAdapter {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn capability(&self) -> ProviderCapability {
        let (installed, version, probe_error) = version_probe("claude");
        let worker_probe = self.temporary().map(|_| ()).map_err(|error| error.message);
        let worker = worker_probe.is_ok();
        // Chat uses whatever Claude Code is configured with (user decision,
        // 2026-09-30). The Chat CLI's own `auth status` recognises every source
        // (claude.ai login, API key or token in env or settings, apiKeyHelper,
        // cloud providers) without a model request.
        let chat_cli = claude_chat_cli_path();
        let auth = match (worker, chat_cli.as_deref()) {
            (true, Some(cli)) => claude_auth_status(cli),
            _ => ClaudeAuth::Unknown,
        };
        let chat = worker && auth != ClaudeAuth::SignedOut;
        let reason = if !worker {
            worker_probe
                .err()
                .or_else(|| Some("Claude Agent SDK worker is unavailable".to_owned()))
        } else if auth == ClaudeAuth::SignedOut {
            Some(CLAUDE_NOT_SIGNED_IN.to_owned())
        } else if !installed {
            probe_error.or_else(|| {
                Some("Claude CLI is not installed; Terminal mode is unavailable".to_owned())
            })
        } else {
            probe_error.or_else(|| {
                claude_version_note(
                    chat_cli.as_deref().and_then(claude_cli_version).as_deref(),
                    version.as_deref(),
                )
            })
        };
        let auth = auth.as_str().to_owned();
        ProviderCapability {
            source: "builtin",
            plugin_id: None,
            icon: None,
            sign_in: super::builtin_sign_in("claude"),
            homepage: None,
            id: "claude".to_owned(),
            name: super::builtin_name("claude").to_owned(),
            installed,
            version,
            terminal: installed,
            chat,
            history: worker,
            resume: chat,
            terminal_resume_capture: self.terminal_capture().as_str(),
            reason,
            auth,
        }
    }

    fn terminal_command(
        &self,
        resume_id: Option<&str>,
        assign_id: Option<&str>,
    ) -> Result<TerminalCommand, ProviderError> {
        let mut args = Vec::new();
        if let Some(id) = resume_id {
            validate_native_id(id)?;
            args.extend(["--resume".to_owned(), id.to_owned()]);
        } else if let Some(id) = assign_id {
            // Claude adopts a caller-chosen UUID for a new conversation, so the
            // native identity is known before the PTY starts.
            validate_native_id(id)?;
            if !super::common::is_uuid(id) {
                return Err(ProviderError::new(
                    "invalid_native_id",
                    "Claude --session-id requires a UUID",
                ));
            }
            args.extend(["--session-id".to_owned(), id.to_owned()]);
        }
        let path = find_executable("claude").ok_or_else(|| {
            ProviderError::unavailable("claude", "Claude executable was not found on PATH")
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

    fn preflight_terminal_resume(&self, cwd: &str, native_id: &str) -> Result<(), ProviderError> {
        validate_native_id(native_id)?;
        let process = self.temporary()?;
        let has_messages = |result: &Value| -> Result<bool, ProviderError> {
            result
                .get("messages")
                .and_then(Value::as_array)
                .map(|messages| !messages.is_empty())
                .ok_or_else(|| {
                    ProviderError::new(
                        "provider_protocol",
                        "Claude SDK returned malformed session history",
                    )
                })
        };
        // Check the current project first. A relocated cwd can be empty even
        // when the exact native ID still exists in another project; the SDK's
        // no-dir lookup handles that case without selecting a new identity.
        // This only checks presence; the native CLI still decides whether its
        // exact-ID resume is valid (including ambiguous duplicate records).
        let local =
            process.sidecar_request("history.read", json!({"sessionId":native_id,"cwd":cwd}))?;
        if has_messages(&local)? {
            return Ok(());
        }
        let global = process.sidecar_request("history.read", json!({"sessionId":native_id}))?;
        if has_messages(&global)? {
            return Ok(());
        }
        Err(ProviderError::new(
            "session_has_no_native_history",
            "Claude has no persisted conversation for this session ID; an empty terminal session cannot be resumed",
        ))
    }

    fn history_list(
        &self,
        cursor: Option<&str>,
        limit: u32,
        cwd: Option<&str>,
    ) -> Result<Value, ProviderError> {
        let offset = cursor
            .map(|value| value.parse::<u64>())
            .transpose()
            .map_err(|_| ProviderError::new("invalid_cursor", "Claude history cursor is invalid"))?
            .unwrap_or(0);
        let process = self.temporary()?;
        let result = process.sidecar_request(
            "history.list",
            json!({"cwd":cwd,"limit":limit,"offset":offset}),
        )?;
        let rows = result
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let count = rows.len() as u64;
        let items = rows
            .into_iter()
            .filter_map(claude_history_item)
            .collect::<Vec<_>>();
        let next = if count == limit as u64 {
            Some((offset + count).to_string())
        } else {
            None
        };
        Ok(history_page(items, next.map(Value::String)))
    }

    fn history_read(&self, native_id: &str) -> Result<Value, ProviderError> {
        validate_native_id(native_id)?;
        let process = self.temporary()?;
        let result = process.sidecar_request("history.read", json!({"sessionId":native_id}))?;
        let raw = result
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(Value::Array(claude_transcript(&raw)))
    }

    fn open_chat(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        self.open_chat_worker(session_id, cwd, native_id, None, None)
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
        self.open_chat_worker(session_id, cwd, native_id, Some(worker_token), None)
    }

    fn open_chat_with_tools(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
        worker_token: &str,
        tools: Option<&ChatToolServer>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        self.open_chat_worker(session_id, cwd, native_id, Some(worker_token), tools)
    }
}

struct ClaudeChat {
    process: JsonLineProcess,
    session_id: String,
    native_id: Option<String>,
    liveness: WorkerLiveness,
    ui: ClaudeUi,
    events: crate::provider_events::Sender,
    worker_token: Option<String>,
}

impl ChatSession for ClaudeChat {
    fn native_id(&self) -> Option<String> {
        self.native_id.clone()
    }
    fn is_alive(&self) -> bool {
        // The sidecar host process can outlive the SDK query it drives; both
        // must be alive for the session to count as usable.
        self.process.is_alive() && !self.liveness.ended()
    }
    fn validate_send(&self, text: &str) -> Result<(), ProviderError> {
        claude_blocked_command(text).map_or(Ok(()), Err)
    }
    fn send(&mut self, text: &str, operation_id: &str) -> Result<Value, ProviderError> {
        validate_native_id(operation_id)?;
        self.process.sidecar_request(
            "session.send",
            json!({"cardId":self.session_id,"text":text,"operationId":operation_id}),
        )?;
        Ok(json!({"turnId":operation_id}))
    }
    fn cancel(&mut self, _turn_id: &str) -> Result<(), ProviderError> {
        self.process
            .sidecar_request("session.interrupt", json!({"cardId":self.session_id}))?;
        Ok(())
    }
    fn approve(
        &mut self,
        turn_id: &str,
        approval_id: &str,
        choice_id: &str,
        _operation_id: &str,
    ) -> Result<(), ProviderError> {
        // The sidecar answers `allow_always` with the SDK's own suggestions and
        // refuses it when the request carried none.
        let behavior = match choice_id {
            "allow" | "allow_always" | "deny" => choice_id,
            _ => {
                return Err(ProviderError::new(
                    "approval_choice_invalid",
                    format!("{choice_id} is not a supported Claude approval choice"),
                ))
            }
        };
        self.process.sidecar_request(
            "session.decision",
            json!({"cardId":self.session_id,"requestId":approval_id,"behavior":behavior}),
        )?;
        // The SDK has the answer; Claude itself reports only cancellations, so
        // settle the card here as the ACP and Codex adapters do. Otherwise it
        // stays pending (a delegate keeps waiting for its parent) until the turn
        // ends and expires it.
        emit_scoped(
            &self.events,
            "claude",
            &self.session_id,
            self.native_id.as_deref(),
            Some(turn_id),
            "chat.approval.resolved",
            json!({"approvalId":approval_id,"outcome":"submitted"}),
            self.worker_token.as_deref(),
        );
        Ok(())
    }
    fn answer(
        &mut self,
        turn_id: &str,
        approval_id: &str,
        response: &Value,
        _operation_id: &str,
    ) -> Result<(), ProviderError> {
        let values = response.get("values").cloned().unwrap_or(Value::Null);
        self.process.sidecar_request(
            "session.answer",
            json!({"cardId":self.session_id,"requestId":approval_id,"values":values}),
        )?;
        let status = if response.get("action").and_then(Value::as_str) == Some("dismiss") {
            "dismissed"
        } else {
            "answered"
        };
        let answer_summary = values.as_object().map(|values| {
            let values = values
                .iter()
                .map(|(id, value)| {
                    let text = value
                        .as_array()
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .or_else(|| value.as_str().map(ToOwned::to_owned))
                        .unwrap_or_else(|| value.to_string());
                    (id.clone(), Value::String(text))
                })
                .collect::<serde_json::Map<_, _>>();
            Value::Object(values)
        });
        emit_scoped(
            &self.events,
            "claude",
            &self.session_id,
            self.native_id.as_deref(),
            Some(turn_id),
            "chat.approval.resolved",
            json!({"approvalId":approval_id,"status":status,"outcome":"submitted","answerSummary":answer_summary}),
            self.worker_token.as_deref(),
        );
        Ok(())
    }
    fn stop(&mut self) -> Result<(), ProviderError> {
        self.process
            .sidecar_request("session.stop", json!({"cardId":self.session_id}))?;
        Ok(())
    }
    fn ui_state(&self) -> Value {
        self.ui.wire()
    }
    fn set_option(&mut self, option_id: &str, value: &str) -> Result<Value, ProviderError> {
        let result = self.process.sidecar_request(
            "session.set_option",
            json!({"cardId":self.session_id,"optionId":option_id,"value":value}),
        )?;
        if let Some(ui) = result.get("ui") {
            self.ui.replace(ui);
        }
        Ok(self.ui.wire())
    }
}

/// Typed commands that must not reach the CLI from Chat, rejected before the
/// message is recorded. The menu already hides them (sidecar HIDDEN_COMMANDS).
fn claude_blocked_command(text: &str) -> Option<ProviderError> {
    let name = text
        .trim_start()
        .strip_prefix('/')?
        .split_whitespace()
        .next()?;
    let message = match name {
        "clear" => "/clear would start a new Claude session and end this chat. Start a new Claude chat instead. / /clear 会开启新的 Claude 会话并结束当前聊天，请改为新建 Claude 聊天。".to_owned(),
        "extra-usage" | "usage-credits" => format!(
            "/{name} opens your web browser; run it in Claude Terminal instead. / /{name} 会打开网页浏览器，请在 Claude 终端中运行。"
        ),
        _ => return None,
    };
    Some(ProviderError::new("chat_command_unavailable", message))
}

/// Choices for one SDK permission request. "Always" appears only when the SDK
/// suggested rules; its label says where Claude Code will keep them.
fn claude_approval_choices(request: &Value) -> Vec<ApprovalChoice> {
    let choice = |id: &str, label: &str, kind: &str, scope: &str| ApprovalChoice {
        choice_id: id.into(),
        label: label.into(),
        kind: kind.into(),
        scope: scope.into(),
        description: None,
    };
    let mut choices = vec![choice("allow", "Allow once", "allow", "once")];
    let updates = request
        .get("suggestions")
        .and_then(Value::as_array)
        .filter(|updates| !updates.is_empty());
    if let Some(updates) = updates {
        let destination = |target: &[&str]| {
            updates.iter().any(|update| {
                update
                    .get("destination")
                    .and_then(Value::as_str)
                    .is_some_and(|value| target.contains(&value))
            })
        };
        let accept_edits = updates.iter().all(|update| {
            update.get("type").and_then(Value::as_str) == Some("setMode")
                && update.get("mode").and_then(Value::as_str) == Some("acceptEdits")
        });
        let (label, scope) = if destination(&["userSettings"]) {
            ("Always allow everywhere", "persistent")
        } else if destination(&["localSettings", "projectSettings"]) {
            ("Always allow in this project", "persistent")
        } else if accept_edits {
            ("Allow all edits this session", "session")
        } else {
            ("Allow for this session", "session")
        };
        choices.push(choice("allow_always", label, "allow", scope));
    }
    choices.push(choice("deny", "Deny", "deny", "once"));
    choices
}

fn claude_question_payload(request: &Value) -> Value {
    let questions = request
        .pointer("/question/questions")
        .and_then(Value::as_array)
        .map(|questions| {
            questions
                .iter()
                .enumerate()
                .filter_map(|(index, question)| {
                    let question = question.as_object()?;
                    let question_text = question.get("question")?.as_str()?;
                    let header = question.get("header")?.as_str()?;
                    let options = question
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|options| {
                            options
                                .iter()
                                .filter_map(|option| {
                                    let option = option.as_object()?;
                                    let label = option.get("label")?.as_str()?;
                                    let mut value = json!({"label":label});
                                    if let Some(description) =
                                        option.get("description").and_then(Value::as_str)
                                    {
                                        value["description"] = json!(description);
                                    }
                                    Some(value)
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    Some(json!({"id":format!("q{index}"),"header":header,"question":question_text,"options":options,
                        "multiSelect":question.get("multiSelect").and_then(Value::as_bool).unwrap_or(false),"allowOther":true,"secret":false}))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({"interaction":"question","answerable":!questions.is_empty(),"form":{"kind":"questions","questions":questions}})
}

/// Same text as the sidecar's signed-out handshake error.
const CLAUDE_NOT_SIGNED_IN: &str = "Claude Code is not signed in. Run `claude auth login` (or /login in Claude Terminal), or configure an API key, apiKeyHelper or cloud provider for Claude Code. / Claude Code 未登录。请运行 `claude auth login`（或在 Claude 终端中使用 /login），或为 Claude Code 配置 API 密钥、apiKeyHelper 或云服务商。";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClaudeAuth {
    SignedIn,
    SignedOut,
    Unknown,
}

impl ClaudeAuth {
    fn as_str(self) -> &'static str {
        match self {
            Self::SignedIn => "authenticated",
            Self::SignedOut => "unauthenticated",
            Self::Unknown => "unknown",
        }
    }
}

fn claude_auth_status(cli: &Path) -> ClaudeAuth {
    let Ok(spec) = CommandSpec::from_path(
        cli.to_path_buf(),
        vec!["auth".into(), "status".into(), "--json".into()],
    ) else {
        return ClaudeAuth::Unknown;
    };
    // `auth status` exits 1 when signed out; its JSON then arrives as the error.
    match command_output(&spec, Duration::from_secs(5)) {
        Ok(output) => parse_claude_auth_status(&output),
        Err(error) if error.code == "provider_probe_failed" => {
            parse_claude_auth_status(&error.message)
        }
        Err(_) => ClaudeAuth::Unknown,
    }
}

fn parse_claude_auth_status(text: &str) -> ClaudeAuth {
    // Tolerate warning lines around the JSON object.
    let json = match (text.find('{'), text.rfind('}')) {
        (Some(start), Some(end)) if start < end => &text[start..=end],
        _ => text,
    };
    match serde_json::from_str::<Value>(json)
        .ok()
        .and_then(|status| status.get("loggedIn").and_then(Value::as_bool))
    {
        Some(true) => ClaudeAuth::SignedIn,
        Some(false) => ClaudeAuth::SignedOut,
        None => ClaudeAuth::Unknown,
    }
}

/// The CLI Chat runs: `THREADTERM_CLAUDE_PATH`, else the Agent SDK's native CLI that
/// the build copies beside the sidecar host (`providers/claude-sdk/dist` in dev).
fn claude_chat_cli_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("THREADTERM_CLAUDE_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    let name = if cfg!(windows) {
        "claude-sdk-cli.exe"
    } else {
        "claude-sdk-cli"
    };
    let host = claude_worker_path()?;
    let dir = host.parent()?;
    [dir.join(name), dir.join("../dist").join(name)]
        .into_iter()
        .find(|path| path.is_file())
}

/// `--version` of the Chat CLI, cached per file state; capability probes repeat.
fn claude_cli_version(cli: &Path) -> Option<String> {
    type Cached = Option<(PathBuf, u64, Option<std::time::SystemTime>, String)>;
    static CACHE: OnceLock<Mutex<Cached>> = OnceLock::new();
    let meta = std::fs::metadata(cli).ok()?;
    let key = (cli.to_path_buf(), meta.len(), meta.modified().ok());
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Some((path, len, modified, version)) = cache.lock().ok()?.as_ref() {
        if (path, len, modified) == (&key.0, &key.1, &key.2) {
            return Some(version.clone());
        }
    }
    let spec = CommandSpec::from_path(cli.to_path_buf(), vec!["--version".into()]).ok()?;
    let output = command_output(&spec, Duration::from_secs(5)).ok()?;
    let version = claude_version_number(&output)?.to_owned();
    if let Ok(mut slot) = cache.lock() {
        *slot = Some((key.0, key.1, key.2, version.clone()));
    }
    Some(version)
}

/// Chat runs the SDK's CLI and Terminal runs the installed one; say so when their
/// versions differ, so version-specific behaviour is explainable.
fn claude_version_note(chat: Option<&str>, terminal: Option<&str>) -> Option<String> {
    let chat = claude_version_number(chat?)?;
    let terminal = claude_version_number(terminal?)?;
    (chat != terminal).then(|| {
        format!(
            "Chat runs Claude Code {chat} through the Agent SDK; Terminal runs the installed Claude Code {terminal}. / 聊天通过 Agent SDK 运行 Claude Code {chat}；终端运行已安装的 Claude Code {terminal}。"
        )
    })
}

/// First version-like token ("2.1.266"), skipping any warning text around it.
fn claude_version_number(text: &str) -> Option<&str> {
    text.split_whitespace()
        .find(|token| token.starts_with(|c: char| c.is_ascii_digit()) && token.contains('.'))
}

fn claude_worker_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("THREADTERM_CLAUDE_SDK_HOST")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    // Packaged locations first: the compile-time checkout paths only exist on the
    // machine that built this runtime.
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("claude-sdk-host.mjs"));
            candidates.push(dir.join("../providers/claude-sdk-host.mjs"));
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest.join("../providers/claude-sdk/dist/claude-sdk-host.mjs"));
    candidates.push(manifest.join("../providers/claude-sdk/src/main.mjs"));
    candidates.into_iter().find(|path| path.is_file())
}

fn claude_agent_tool(block: &Value) -> bool {
    matches!(
        block.get("name").and_then(Value::as_str),
        Some("Agent" | "Task")
    )
}

fn claude_agent_info(id: &str, input: &Value, transcript: &str) -> Value {
    let mut info = json!({"agentType":input.get("subagent_type").and_then(Value::as_str).unwrap_or("general-purpose"),
        "background":input.get("run_in_background").and_then(Value::as_bool)==Some(true),
        "native":{"kind":"claude-agent","id":id},"transcript":transcript,"status":"running"});
    for field in ["description", "prompt"] {
        if let Some(value) = input.get(field).filter(|value| value.is_string()) {
            info[field] = value.clone();
        }
    }
    info
}

fn claude_result_text(content: &Value) -> String {
    content.as_str().map(ToOwned::to_owned).unwrap_or_else(|| {
        content
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n")
    })
}

fn claude_task_usage(message: &Value, info: &mut Value) {
    if let Some(usage) = message.get("usage").filter(|usage| usage.is_object()) {
        let mut mapped = json!({});
        for (source, target) in [
            ("total_tokens", "totalTokens"),
            ("tool_uses", "toolUses"),
            ("duration_ms", "durationMs"),
        ] {
            if let Some(value) = usage.get(source).filter(|value| value.is_number()) {
                mapped[target] = value.clone();
            }
        }
        info["usage"] = mapped;
    }
}

impl ClaudeSubagents {
    fn root(&self, id: &str) -> String {
        self.agents
            .get(id)
            .map(|agent| agent.root.clone())
            .unwrap_or_else(|| id.to_owned())
    }

    fn bind_agent(&mut self, id: &str, root: &str, input: &Value) -> Vec<(&'static str, Value)> {
        let agent = self
            .agents
            .entry(id.into())
            .or_insert_with(|| ClaudeSubagent {
                root: root.into(),
                task_id: None,
                backgrounded: false,
                label: "Subagent".into(),
            });
        agent.root = root.into();
        agent.backgrounded |= input.get("run_in_background").and_then(Value::as_bool) == Some(true);
        if let Some(label) = input.get("description").and_then(Value::as_str) {
            agent.label = label.into();
        }
        let mut task_ids: HashSet<String> = self
            .task_agents
            .iter()
            .filter(|(_, agent)| agent.as_str() == id)
            .map(|(task, _)| task.clone())
            .collect();
        for task in &task_ids {
            self.tasks.insert(task.clone(), root.into());
        }
        // A task can precede the completed Agent block that tells us its
        // ancestry. Hold those updates until binding so no inner card leaks out.
        let pending = std::mem::take(&mut self.pending_tasks);
        task_ids.extend(
            pending
                .iter()
                .filter(|message| message.get("tool_use_id").and_then(Value::as_str) == Some(id))
                .filter_map(|message| {
                    message
                        .get("task_id")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                }),
        );
        let mut events = Vec::new();
        for message in pending {
            if message.get("tool_use_id").and_then(Value::as_str) == Some(id)
                || message
                    .get("task_id")
                    .and_then(Value::as_str)
                    .is_some_and(|task| task_ids.contains(task))
            {
                events.extend(self.task_events(&message));
            } else {
                self.pending_tasks.push_back(message);
            }
        }
        events
    }

    /// The reader owns one state for its entire session, including background
    /// task notifications received after the parent operation has ended.
    fn message_events(&mut self, message: &Value) -> (Vec<(&'static str, Value)>, bool) {
        let mut events = Vec::new();
        let kind = message.get("type").and_then(Value::as_str).unwrap_or("");
        if let Some(parent) = message.get("parent_tool_use_id").filter(|id| !id.is_null()) {
            let Some(parent) = parent.as_str() else {
                return (events, true);
            };
            if !matches!(kind, "assistant" | "user") {
                return (events, true);
            }
            let root = self.root(parent);
            let message_id = message
                .get("uuid")
                .or_else(|| message.pointer("/message/id"))
                .and_then(Value::as_str);
            for (index, block) in message
                .pointer("/message/content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(64)
                .enumerate()
            {
                let block_kind = block.get("type").and_then(Value::as_str).unwrap_or("");
                if block_kind == "tool_use" && claude_agent_tool(block) {
                    if let Some(id) = block.get("id").and_then(Value::as_str) {
                        events.extend(self.bind_agent(
                            id,
                            &root,
                            block.get("input").unwrap_or(&Value::Null),
                        ));
                    }
                }
                match block_kind {
                    "text" | "thinking" => {
                        if let (Some(id), Some(text)) = (
                            message_id,
                            block
                                .get(if block_kind == "thinking" {
                                    "thinking"
                                } else {
                                    "text"
                                })
                                .and_then(Value::as_str),
                        ) {
                            // No merge: snapshots without toolId must replace.
                            events.push(("chat.subagent.item", json!({"key":root,"item":{"id":format!("{id}:{index}"),
                                "role":kind,"parts":[{"type":block_kind,"text":text,"status":"complete"}]}})));
                        }
                    }
                    "tool_use" | "tool_result" => {
                        let single =
                            json!({"parent_tool_use_id":parent,"message":{"content":[block]}});
                        for (id, part) in claude_message_tool_parts(&single) {
                            events.push(("chat.subagent.item", json!({"key":root,"merge":true,
                                "item":{"id":id,"role":if block_kind=="tool_result" {"tool"} else {kind},"parts":[part]}})));
                        }
                    }
                    _ => {}
                }
            }
            return (events, true);
        }
        if kind == "system"
            && message
                .get("subtype")
                .and_then(Value::as_str)
                .is_some_and(|subtype| subtype.starts_with("task_"))
        {
            return (self.task_events(message), true);
        }
        if matches!(kind, "assistant" | "user") {
            for block in message
                .pointer("/message/content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(64)
            {
                match block.get("type").and_then(Value::as_str) {
                    Some("tool_use") if claude_agent_tool(block) => {
                        let Some(id) = block.get("id").and_then(Value::as_str) else {
                            continue;
                        };
                        let input = block.get("input").unwrap_or(&Value::Null);
                        let info = claude_agent_info(id, input, "live");
                        let pending = self.bind_agent(id, id, input);
                        let agent = self.agents.get_mut(id).expect("just bound agent");
                        // task_started may already have supplied background state.
                        agent.backgrounded |= info["background"] == true;
                        agent.label = input
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or("Subagent")
                            .into();
                        let mut info = info;
                        info["background"] = json!(agent.backgrounded);
                        events.push(("chat.subagent", json!({"key":agent.root,"info":info})));
                        events.extend(pending);
                    }
                    Some("tool_result") => {
                        let Some(agent) = block
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .and_then(|id| self.agents.get(id))
                        else {
                            continue;
                        };
                        let info = if agent.backgrounded {
                            json!({"lastActivity":"Running in background"})
                        } else {
                            json!({"status":if block.get("is_error").and_then(Value::as_bool)==Some(true) {"failed"} else {"completed"},
                                "summary":claude_result_text(block.get("content").unwrap_or(&Value::Null))})
                        };
                        events.push(("chat.subagent", json!({"key":agent.root,"info":info})));
                    }
                    _ => {}
                }
            }
        }
        (events, false)
    }

    fn task_events(&mut self, message: &Value) -> Vec<(&'static str, Value)> {
        let Some(task_id) = message.get("task_id").and_then(Value::as_str) else {
            return Vec::new();
        };
        if message.get("skip_transcript").and_then(Value::as_bool) == Some(true)
            || message.get("ambient").and_then(Value::as_bool) == Some(true)
        {
            self.ignored_tasks.insert(task_id.into());
        }
        if self.ignored_tasks.contains(task_id) {
            return Vec::new();
        }
        let subtype = message.get("subtype").and_then(Value::as_str).unwrap_or("");
        if !matches!(
            subtype,
            "task_started" | "task_progress" | "task_updated" | "task_notification"
        ) {
            return Vec::new();
        }
        let tool_id = message.get("tool_use_id").and_then(Value::as_str);
        if subtype == "task_started"
            && message.get("task_type").and_then(Value::as_str) != Some("local_agent")
            && message
                .get("subagent_type")
                .and_then(Value::as_str)
                .is_none()
            && tool_id.is_none()
        {
            self.ignored_tasks.insert(task_id.into());
            return Vec::new();
        }
        let pending_tool = tool_id.or_else(|| {
            self.pending_tasks
                .iter()
                .find(|pending| pending.get("task_id").and_then(Value::as_str) == Some(task_id))
                .and_then(|pending| pending.get("tool_use_id").and_then(Value::as_str))
        });
        if pending_tool.is_some_and(|id| !self.agents.contains_key(id))
            && !(subtype == "task_started"
                && message.get("spawn_depth").and_then(Value::as_u64) == Some(1))
        {
            // Bound speculative ordering state. Unmatched tasks must not
            // manufacture root cards; the SDK normally sends the block next.
            if self.pending_tasks.len() == 200 {
                self.pending_tasks.pop_front();
            }
            self.pending_tasks.push_back(message.clone());
            return Vec::new();
        }
        let key = tool_id
            .map(|id| self.root(id))
            .or_else(|| self.tasks.get(task_id).cloned())
            .or_else(|| (subtype == "task_started").then(|| task_id.into()));
        let Some(key) = key else {
            return Vec::new();
        };
        let id = tool_id
            .map(ToOwned::to_owned)
            .or_else(|| self.task_agents.get(task_id).cloned())
            .unwrap_or_else(|| key.clone());
        let nested = id != key;
        self.tasks.insert(task_id.into(), key.clone());
        self.task_agents.insert(task_id.into(), id.clone());
        let agent = self.agents.entry(id).or_insert_with(|| ClaudeSubagent {
            root: key.clone(),
            task_id: None,
            backgrounded: false,
            label: "Subagent".into(),
        });
        agent.task_id = Some(task_id.into());
        let mut info = json!({});
        let mut reopen = false;
        match subtype {
            "task_started" => {
                if let Some(background) = message.get("is_backgrounded").and_then(Value::as_bool) {
                    agent.backgrounded = background;
                    info["background"] = json!(background);
                }
                info["status"] = json!("running");
                info["transcript"] = json!("live");
                info["native"] = json!({"kind":"claude-agent","id":key});
                for (source, target) in [
                    ("subagent_type", "agentType"),
                    ("description", "description"),
                    ("prompt", "prompt"),
                    ("spawn_depth", "depth"),
                ] {
                    if let Some(value) = message.get(source) {
                        info[target] = value.clone();
                    }
                }
                if let Some(label) = message.get("description").and_then(Value::as_str) {
                    agent.label = label.into();
                }
            }
            "task_progress" => {
                claude_task_usage(message, &mut info);
                if let Some(activity) = message
                    .get("summary")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .or_else(|| message.get("last_tool_name").and_then(Value::as_str))
                {
                    info["lastActivity"] = json!(activity);
                }
            }
            "task_updated" => {
                let patch = message.get("patch").unwrap_or(&Value::Null);
                if let Some(status) = patch.get("status").and_then(Value::as_str) {
                    info["status"] = json!(match status {
                        "running" | "pending" | "paused" => "running",
                        "completed" => "completed",
                        "failed" => "failed",
                        "killed" => "cancelled",
                        _ => "unknown",
                    });
                    reopen = status == "running";
                    if status == "failed" {
                        if let Some(error) = patch.get("error").and_then(Value::as_str) {
                            info["summary"] = json!(error);
                        }
                    }
                }
                if let Some(description) = patch.get("description").and_then(Value::as_str) {
                    info["description"] = json!(description);
                    agent.label = description.into();
                }
                if let Some(background) = patch.get("is_backgrounded").and_then(Value::as_bool) {
                    agent.backgrounded = background;
                    info["background"] = json!(background);
                }
            }
            "task_notification" => {
                info["status"] = json!(match message.get("status").and_then(Value::as_str) {
                    Some("completed") => "completed",
                    Some("failed") => "failed",
                    Some("stopped") => "cancelled",
                    _ => "unknown",
                });
                if let Some(summary) = message.get("summary").and_then(Value::as_str) {
                    info["summary"] = json!(summary);
                }
                claude_task_usage(message, &mut info);
            }
            _ => return Vec::new(),
        }
        // Inner tasks contribute activity to their root, never settle/reopen it
        // or replace its title, prompt, usage or native identity.
        if nested {
            info = json!({"lastActivity":info.get("lastActivity").cloned().unwrap_or_else(|| json!(
                if matches!(subtype, "task_notification") { "Nested agent finished" } else { "Nested agent activity" }))});
            reopen = false;
        }
        let mut data = json!({"key":key,"info":info});
        if reopen {
            data["reopen"] = json!(true);
        }
        vec![("chat.subagent", data)]
    }
}

fn emit_claude_message(
    events: &crate::provider_events::Sender,
    session_id: &str,
    native: &Mutex<Option<String>>,
    liveness: &WorkerLiveness,
    ui: &ClaudeUi,
    worker_token: Option<&str>,
    raw: Value,
) {
    let ev = raw
        .get("ev")
        .and_then(Value::as_str)
        .unwrap_or("provider.event");
    if ev == "host.fatal" {
        liveness.mark_ended();
        emit_scoped(
            events,
            "claude",
            session_id,
            native
                .lock()
                .ok()
                .and_then(|value| value.clone())
                .as_deref(),
            None,
            "chat.error",
            json!({"raw":raw}),
            worker_token,
        );
        return;
    }
    if raw
        .get("cardId")
        .and_then(Value::as_str)
        .is_some_and(|id| id != session_id)
    {
        return;
    }
    let learned_native = raw
        .get("sessionId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    if let Some(id) = &learned_native {
        if let Ok(mut value) = native.lock() {
            if value.as_ref().is_some_and(|bound| bound != id) {
                liveness.mark_ended();
                emit_scoped(
                    events,
                    "claude",
                    session_id,
                    value.as_deref(),
                    raw.get("operationId").and_then(Value::as_str),
                    "chat.error",
                    json!({"raw":{"error":"Claude native session identity changed unexpectedly"}}),
                    worker_token,
                );
                return;
            }
            *value = Some(id.clone());
        }
    }
    let native_id = learned_native.or_else(|| native.lock().ok().and_then(|value| value.clone()));
    let turn_id = raw.get("operationId").and_then(Value::as_str);
    if ev == "session.ui" {
        if let Some(state) = raw.get("ui").filter(|state| state.is_object()) {
            ui.replace(state);
            let mut data = ui.wire();
            data["sessionId"] = json!(session_id);
            emit_scoped(
                events,
                "claude",
                session_id,
                native_id.as_deref(),
                None,
                "chat.ui",
                data,
                worker_token,
            );
        }
        return;
    }
    if ev == "session.request" {
        let approval_id = raw
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let is_question = raw.get("question").is_some();
        let choices = if is_question {
            Vec::new()
        } else {
            claude_approval_choices(&raw)
        };
        let title = raw
            .pointer("/question/questions/0/header")
            .and_then(Value::as_str)
            .or_else(|| raw.get("title").and_then(Value::as_str))
            .unwrap_or("Permission request");
        let mut payload = if is_question {
            let mut payload = claude_question_payload(&raw);
            payload["approvalId"] = json!(approval_id);
            payload["provider"] = json!("claude");
            payload["method"] = json!("session.request");
            payload["title"] = json!(title);
            payload["raw"] = raw.clone();
            if let Some(turn_id) = turn_id {
                payload["turnId"] = json!(turn_id);
            }
            payload
        } else {
            approval_payload(
                approval_id,
                "claude",
                "session.request",
                title,
                &raw,
                &choices,
                turn_id,
                true,
            )
        };
        if let Some(agent_id) = raw.get("agentId").and_then(Value::as_str) {
            let mut subagent = json!({"agentId":agent_id,"label":"Subagent"});
            if let Ok(state) = ui.1.lock() {
                if let Some(key) = state.tasks.get(agent_id) {
                    subagent["key"] = json!(key);
                    if let Some(agent) = state.task_agents.get(agent_id).and_then(|id| state.agents.get(id)) {
                        subagent["label"] = json!(agent.label);
                    }
                }
            }
            payload["subagent"] = subagent;
        }
        emit_scoped(
            events,
            "claude",
            session_id,
            native_id.as_deref(),
            turn_id,
            "chat.approval",
            json!({
                "approvalId":approval_id,
                "request":raw,
                "choices":choices,
                "part":{"type":"approval","approvalId":approval_id,"status":"pending","data":payload}
            }),
            worker_token,
        );
        return;
    }
    if ev == "session.request_cancelled" {
        // A cancellation settles exactly one card: expire it, never approve it,
        // and never touch any other pending request.
        let approval_id = raw
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        emit_scoped(
            events,
            "claude",
            session_id,
            native_id.as_deref(),
            turn_id,
            "chat.approval.resolved",
            json!({
                "approvalId":approval_id,
                "status":"expired",
                "outcome":"cancelled",
                "message":raw.get("message").and_then(Value::as_str).unwrap_or("Request cancelled")
            }),
            worker_token,
        );
        return;
    }
    if ev == "session.status" {
        let phase = raw
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        if matches!(phase, "closed" | "error") {
            liveness.mark_ended();
        }
        let kind = match phase {
            "ready" => "session.ready",
            "running" => "chat.turn.started",
            "idle" => "chat.turn.completed",
            "error" => "chat.error",
            "closed" => "session.closed",
            _ => "provider.event",
        };
        let mut data = json!({"raw":raw});
        // completed / interrupted / failed: only a completed turn asks for the
        // user's attention in the session activity projection.
        if phase == "idle" {
            if let Some(status) = raw.get("status").and_then(Value::as_str) {
                data["status"] = json!(status);
            }
        }
        emit_scoped(
            events,
            "claude",
            session_id,
            native_id.as_deref(),
            turn_id,
            kind,
            data,
            worker_token,
        );
        return;
    }
    if ev == "session.event" {
        let message = raw.get("message").cloned().unwrap_or(Value::Null);
        let (subagent_events, handled) = ui.1.lock().map(|mut state| state.message_events(&message))
            .unwrap_or_else(|_| (Vec::new(), message.get("parent_tool_use_id").is_some_and(|id| !id.is_null())));
        for (kind, data) in subagent_events {
            emit_scoped(events, "claude", session_id, native_id.as_deref(), turn_id, kind, data, worker_token);
        }
        if handled {
            return;
        }
        let text = message
            .get("event")
            .and_then(|e| e.get("delta"))
            .and_then(|d| d.get("text"))
            .and_then(Value::as_str);
        let kind = if text.is_some() {
            "chat.delta"
        } else {
            "chat.item"
        };
        let data = text
            .map(|text| json!({"part":{"type":"text","text":text},"raw":raw}))
            .unwrap_or_else(|| json!({"raw":raw}));
        emit_scoped(
            events,
            "claude",
            session_id,
            native_id.as_deref(),
            turn_id,
            kind,
            data,
            worker_token,
        );
        if text.is_none() {
            // Complete SDK assistant/user messages can carry several native
            // tool blocks. Never turn their text blocks into a second copy of
            // the already-streamed answer; merge each tool by its native id.
            for (tool_id, part) in claude_message_tool_parts(&message) {
                if ui.1.lock().ok().is_some_and(|state| state.agents.contains_key(&tool_id)) {
                    continue;
                }
                emit_scoped(
                    events,
                    "claude",
                    session_id,
                    native_id.as_deref(),
                    turn_id,
                    "chat.item",
                    json!({"item":{"id":tool_id},"merge":true,"part":part}),
                    worker_token,
                );
            }
            if let Some((item_id, text)) = claude_unstreamed_text(&raw, &message) {
                emit_scoped(
                    events,
                    "claude",
                    session_id,
                    native_id.as_deref(),
                    turn_id,
                    "chat.item",
                    json!({"item":{"id":item_id},"part":{"type":"text","text":text,"status":"complete"}}),
                    worker_token,
                );
            }
        }
        return;
    }
    emit_scoped(
        events,
        "claude",
        session_id,
        native_id.as_deref(),
        turn_id,
        "provider.event",
        json!({"raw":raw}),
        worker_token,
    );
}

/// Text the CLI produced without streaming it: local command output (`/context`,
/// `/compact`'s "Compacted") and synthetic assistant messages. Streamed answers
/// already arrived as deltas and are never repeated. Only kept inside a turn.
fn claude_unstreamed_text(raw: &Value, message: &Value) -> Option<(String, String)> {
    raw.get("operationId").and_then(Value::as_str)?;
    let item_id = message
        .get("uuid")
        .and_then(Value::as_str)
        .or_else(|| message.pointer("/message/id").and_then(Value::as_str))?;
    let kind = message.get("type").and_then(Value::as_str);
    let text = match (kind, message.get("subtype").and_then(Value::as_str)) {
        (Some("assistant"), _)
            if raw.get("streamed").and_then(Value::as_bool) == Some(false)
                && message.get("parent_tool_use_id").is_none_or(Value::is_null) =>
        {
            message
                .pointer("/message/content")?
                .as_array()?
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        }
        (Some("user"), _) => {
            claude_local_command_output(message.pointer("/message/content")?.as_str()?)
        }
        (Some("system"), Some("local_command_output")) => {
            message.get("content")?.as_str()?.to_owned()
        }
        _ => return None,
    };
    let text = text.trim();
    (!text.is_empty()).then(|| (item_id.to_owned(), text.to_owned()))
}

fn claude_local_command_output(content: &str) -> String {
    let mut output = Vec::new();
    for tag in ["local-command-stdout", "local-command-stderr"] {
        let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
        let mut rest = content;
        while let Some(start) = rest.find(&open) {
            let after = &rest[start + open.len()..];
            let Some(end) = after.find(&close) else {
                break;
            };
            output.push(after[..end].trim());
            rest = &after[end + close.len()..];
        }
    }
    output.retain(|text| !text.is_empty());
    output.join("\n")
}

fn claude_message_tool_parts(message: &Value) -> Vec<(String, Value)> {
    let Some(content) = message
        .pointer("/message/content")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    content
        .iter()
        .take(64)
        .filter_map(|block| {
            let kind = block.get("type")?.as_str()?;
            if kind == "tool_use" && claude_agent_tool(block)
                && message.get("parent_tool_use_id").is_none_or(Value::is_null)
            {
                return None;
            }
            let tool_id = match kind {
                "tool_use" => block.get("id")?.as_str()?,
                "tool_result" => block.get("tool_use_id")?.as_str()?,
                _ => return None,
            };
            let status = if kind == "tool_result" {
                if block.get("is_error").and_then(Value::as_bool) == Some(true) {
                    "failed"
                } else {
                    "complete"
                }
            } else {
                "running"
            };
            let mut part = json!({"type":"tool","toolId":tool_id,"status":status,"data":block});
            if let Some(name) = block.get("name").and_then(Value::as_str) {
                part["toolName"] = json!(name);
            }
            crate::file_references::enrich_tool_part(&mut part, None);
            Some((tool_id.to_owned(), part))
        })
        .collect()
}

fn claude_history_item(row: Value) -> Option<Value> {
    let id = row
        .get("sessionId")
        .or_else(|| row.get("session_id"))
        .and_then(Value::as_str)?;
    let title = row
        .get("customTitle")
        .or_else(|| row.get("custom_title"))
        .or_else(|| row.get("summary"))
        .and_then(Value::as_str)
        .unwrap_or("Claude session");
    let updated = row
        .get("lastModified")
        .or_else(|| row.get("last_modified"))
        .and_then(Value::as_i64)
        .and_then(|millis| Utc.timestamp_millis_opt(millis).single())
        .map(|date| date.to_rfc3339())
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let mut item = json!({"provider":"claude","nativeId":id,"title":title,"updatedAt":updated,"resumable":true});
    insert_optional(
        &mut item,
        "cwd",
        row.get("cwd")
            .or_else(|| row.get("projectPath"))
            .or_else(|| row.get("project_path"))
            .and_then(Value::as_str)
            .map(|value| json!(value)),
    );
    Some(item)
}

fn claude_transcript(raw: &[Value]) -> Vec<Value> {
    let agents: HashSet<&str> = raw.iter().filter_map(|entry| entry.pointer("/message/content").and_then(Value::as_array))
        .flatten().filter(|block| block.get("type").and_then(Value::as_str)==Some("tool_use") && claude_agent_tool(block))
        .filter_map(|block| block.get("id").and_then(Value::as_str)).collect();
    raw.iter().enumerate().filter_map(|(index, entry)| {
        if entry.get("parent_tool_use_id").is_some_and(|id| !id.is_null()) { return None; }
        let message = entry.get("message")?;
        let role = entry.get("type").or_else(|| message.get("role")).and_then(Value::as_str)?;
        if !matches!(role, "user"|"assistant") { return None; }
        let parts = message.get("content").and_then(Value::as_array).map(|content| content.iter().filter_map(|part| {
            match part.get("type").and_then(Value::as_str) {
                Some("text") => Some(json!({"type":"text","text":part.get("text").and_then(Value::as_str).unwrap_or_default()})),
                Some("tool_use") if claude_agent_tool(part) => {
                    let id = part.get("id").and_then(Value::as_str)?;
                    let mut info = claude_agent_info(id, part.get("input").unwrap_or(&Value::Null), "none");
                    info["key"] = json!(id);
                    info["provider"] = json!("claude");
                    info["status"] = json!("unknown");
                    Some(json!({"type":"subagent","toolId":id,"status":"unknown","data":info}))
                }
                Some("tool_result") if part.get("tool_use_id").and_then(Value::as_str).is_some_and(|id| agents.contains(id)) => None,
                Some(kind) => {
                    let mut tool = json!({"type":"tool","toolName":kind,"data":part});
                    insert_optional(
                        &mut tool,
                        "toolId",
                        part.get("id")
                            .or_else(|| part.get("tool_use_id"))
                            .and_then(Value::as_str)
                            .map(|value| json!(value)),
                    );
                    crate::file_references::enrich_tool_part(&mut tool, None);
                    Some(tool)
                }
                None => None,
            }
        }).collect::<Vec<_>>()).unwrap_or_default();
        Some(json!({"id":entry.get("uuid").and_then(Value::as_str).map(ToOwned::to_owned).unwrap_or_else(|| format!("claude-{index}")),"role":role,"parts":parts,"createdAt":Utc::now().to_rfc3339()}))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn chat_ui_event_matches_claude_ui_state() {
        let (events, mut receiver) = crate::provider_events::tap_channel(1);
        let ui = ClaudeUi::default();
        let native = Mutex::new(Some("n".to_owned()));
        emit_claude_message(
            &events,
            "s",
            &native,
            &WorkerLiveness::default(),
            &ui,
            Some("worker"),
            json!({"ev":"session.ui","ui":{"options":[{"id":"model","value":"qa"}],"commands":[{"name":"compact"}]}}),
        );
        let event = receiver.try_recv().unwrap();
        let mut expected = ui.wire();
        expected["sessionId"] = json!("s");
        assert_eq!(event.data, expected);
    }

    struct SubagentReplay {
        events: crate::provider_events::Sender,
        receiver: tokio::sync::broadcast::Receiver<super::super::ProviderEvent>,
        native: Mutex<Option<String>>,
        ui: ClaudeUi,
        liveness: WorkerLiveness,
    }

    impl SubagentReplay {
        fn new() -> Self {
            let (events, receiver) = crate::provider_events::tap_channel(128);
            Self {
                events,
                receiver,
                native: Mutex::new(Some("native".into())),
                ui: ClaudeUi::default(),
                liveness: WorkerLiveness::default(),
            }
        }
        fn raw(&mut self, raw: Value) -> Vec<super::super::ProviderEvent> {
            emit_claude_message(
                &self.events,
                "s",
                &self.native,
                &self.liveness,
                &self.ui,
                Some("worker"),
                raw,
            );
            let mut all = Vec::new();
            while let Ok(event) = self.receiver.try_recv() {
                all.push(event);
            }
            assert!(all
                .iter()
                .all(|event| event.worker_token.as_deref() == Some("worker")
                    && event.native_id.as_deref() == Some("native")));
            assert!(!self.liveness.ended());
            all
        }
        fn message(&mut self, message: Value) -> Vec<super::super::ProviderEvent> {
            self.raw(json!({"ev":"session.event","cardId":"s","sessionId":"native","operationId":"turn","message":message}))
        }
        fn spawn(&mut self, name: &str, background: bool) -> Vec<super::super::ProviderEvent> {
            self.message(json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[
                {"type":"tool_use","id":"agent","name":name,"input":{"description":"Inspect Rust","prompt":"Find the bug",
                    "subagent_type":"explore","run_in_background":background}}
            ]}}))
        }
        fn task(&mut self, subtype: &str, fields: Value) -> Vec<super::super::ProviderEvent> {
            let mut message = json!({"type":"system","subtype":subtype,"task_id":"task"});
            for (key, value) in fields.as_object().unwrap() {
                message[key] = value.clone();
            }
            self.message(message)
        }
    }

    #[test]
    fn parent_agent_and_task_spawns_and_results_are_cards_not_tools() {
        for name in ["Agent", "Task"] {
            for failed in [false, true] {
                let mut replay = SubagentReplay::new();
                let all = replay.spawn(name, false);
                let cards: Vec<_> = all
                    .iter()
                    .filter(|event| event.kind == "chat.subagent")
                    .collect();
                assert_eq!(cards.len(), 1);
                assert_eq!(cards[0].data["key"], "agent");
                assert_eq!(
                    cards[0].data["info"],
                    json!({"agentType":"explore","description":"Inspect Rust","prompt":"Find the bug",
                    "background":false,"native":{"kind":"claude-agent","id":"agent"},"transcript":"live","status":"running"})
                );
                assert!(all.iter().all(|event| event.data.get("part").is_none()));
                let all = replay.message(json!({"type":"user","message":{"content":[
                    {"type":"tool_result","tool_use_id":"agent","is_error":failed,"content":[{"type":"text","text":"Final report"}]},
                    {"type":"tool_result","tool_use_id":"read","content":"ordinary result"}
                ]}}));
                assert_eq!(all[0].kind, "chat.subagent");
                assert_eq!(
                    all[0].data["info"]["status"],
                    if failed { "failed" } else { "completed" }
                );
                assert_eq!(all[0].data["info"]["summary"], "Final report");
                let parts: Vec<_> = all
                    .iter()
                    .filter_map(|event| event.data.get("part"))
                    .collect();
                assert_eq!(parts.len(), 1);
                assert_eq!(parts[0]["toolId"], "read");
                assert_eq!(replay.native.lock().unwrap().as_deref(), Some("native"));
            }
        }
    }

    #[test]
    fn child_snapshots_replace_text_and_merge_native_tool_parts() {
        let mut replay = SubagentReplay::new();
        replay.spawn("Agent", false);
        let message = json!({"type":"assistant","uuid":"child-uuid","parent_tool_use_id":"agent","message":{"id":"shared-id","content":[
            {"type":"text","text":"Child report"}, {"type":"thinking","thinking":"Child thought"},
            {"type":"tool_use","id":"read","name":"Read","input":{"file_path":"src/a.rs"}}
        ]}});
        for _ in 0..2 {
            let all = replay.message(message.clone());
            assert_eq!(all.len(), 3);
            assert!(all
                .iter()
                .all(|event| event.kind == "chat.subagent.item" && event.data["key"] == "agent"));
            assert_eq!(all[0].data["item"]["id"], "child-uuid:0");
            assert_eq!(all[1].data["item"]["id"], "child-uuid:1");
            assert_eq!(all[1].data["item"]["parts"][0]["type"], "thinking");
            assert!(all[0].data.get("merge").is_none() && all[1].data.get("merge").is_none());
            assert_eq!(all[2].data["merge"], true);
            assert_eq!(all[2].data["item"]["id"], "read");
            assert_eq!(all[2].data["item"]["parts"][0]["toolName"], "Read");
        }
        let all = replay.message(json!({"type":"user","parent_tool_use_id":"agent","message":{"id":"user-id","content":[
            {"type":"text","text":"Child user"}, {"type":"tool_result","tool_use_id":"read","is_error":true,"content":"bad"}
        ]}}));
        assert_eq!(all[0].data["item"]["id"], "user-id:0");
        assert_eq!(all[0].data["item"]["role"], "user");
        assert!(all[0].data.get("merge").is_none());
        assert_eq!(all[1].data["item"]["id"], "read");
        assert_eq!(all[1].data["item"]["parts"][0]["status"], "failed");
        assert_eq!(all[1].data["merge"], true);
    }

    #[test]
    fn nested_agent_messages_and_tasks_use_root_without_settling_it() {
        let mut replay = SubagentReplay::new();
        replay.spawn("Agent", false);
        let all = replay.message(
            json!({"type":"assistant","parent_tool_use_id":"agent","message":{"content":[
                {"type":"tool_use","id":"inner","name":"Task","input":{"description":"Nested"}}
            ]}}),
        );
        assert_eq!(all[0].kind, "chat.subagent.item");
        assert_eq!(all[0].data["key"], "agent");
        let all = replay.message(json!({"type":"assistant","parent_tool_use_id":"inner","uuid":"deep","message":{"content":[{"type":"text","text":"Deep report"}]}}));
        assert_eq!(all[0].data["key"], "agent");
        for (subtype, fields) in [
            (
                "task_started",
                json!({"tool_use_id":"inner","task_type":"local_agent","description":"Nested","spawn_depth":2}),
            ),
            ("task_updated", json!({"patch":{"status":"completed"}})),
            (
                "task_notification",
                json!({"status":"completed","summary":"Inner done"}),
            ),
        ] {
            let all = replay.task(subtype, fields);
            assert_eq!(all.len(), 1);
            assert_eq!(all[0].data["key"], "agent");
            assert!(all[0].data["info"].get("status").is_none());
            assert!(all[0].data["info"].get("description").is_none());
            assert!(all[0].data.get("reopen").is_none());
        }
    }

    #[test]
    fn task_events_before_agent_blocks_wait_for_root_binding() {
        for depth in [Value::Null, json!(2)] {
            let mut replay = SubagentReplay::new();
            replay.spawn("Agent", false);
            assert!(replay
                .task(
                    "task_started",
                    json!({"tool_use_id":"inner","task_type":"local_agent","spawn_depth":depth,
                "description":"Nested task"})
                )
                .is_empty());
            assert!(replay
                .task("task_progress", json!({"last_tool_name":"Read"}))
                .is_empty());
            assert!(replay
                .task("task_updated", json!({"patch":{"status":"completed"}}))
                .is_empty());
            let all = replay.message(json!({"type":"assistant","parent_tool_use_id":"agent","message":{"content":[
                {"type":"tool_use","id":"inner","name":"Task","input":{"description":"Nested task"}}
            ]}}));
            assert_eq!(all.len(), 4);
            assert!(all.iter().all(|event| event.data["key"] == "agent"));
            assert!(all
                .iter()
                .filter(|event| event.kind == "chat.subagent")
                .all(|event| event.data["info"].get("status").is_none()));
            let all = replay.message(json!({"type":"assistant","parent_tool_use_id":"inner","uuid":"later","message":{"content":[{"type":"text","text":"Deep report"}]}}));
            assert_eq!(all[0].data["key"], "agent");
            let all = replay.task(
                "task_notification",
                json!({"status":"completed","summary":"Done"}),
            );
            assert_eq!(all[0].data["key"], "agent");
            assert!(all[0].data["info"].get("status").is_none());
            let all = replay.raw(json!({"ev":"session.request","cardId":"s","requestId":"inner-permission","agentId":"task","toolName":"Read"}));
            assert_eq!(
                all[0].data["part"]["data"]["subagent"],
                json!({"agentId":"task","key":"agent","label":"Nested task"})
            );
        }
        let mut replay = SubagentReplay::new();
        assert!(replay
            .task(
                "task_started",
                json!({"tool_use_id":"agent","task_type":"local_agent","is_backgrounded":true})
            )
            .is_empty());
        assert!(replay
            .task(
                "task_notification",
                json!({"status":"completed","summary":"Early result"})
            )
            .is_empty());
        let all = replay.spawn("Agent", false);
        let cards: Vec<_> = all
            .iter()
            .filter(|event| event.kind == "chat.subagent")
            .collect();
        assert_eq!(cards.len(), 3);
        assert_eq!(cards[0].data["info"]["background"], true);
        assert_eq!(cards[2].data["info"]["status"], "completed");
        assert_eq!(cards[2].data["info"]["summary"], "Early result");
        let mut depth_one = SubagentReplay::new();
        let all = depth_one.task(
            "task_started",
            json!({"tool_use_id":"agent","task_type":"local_agent","spawn_depth":1}),
        );
        assert_eq!(all[0].data["key"], "agent");
        let mut bounded = ClaudeSubagents::default();
        for index in 0..201 {
            bounded.task_events(
                &json!({"type":"system","subtype":"task_started","task_id":format!("task-{index}"),
                "tool_use_id":format!("unknown-{index}"),"task_type":"local_agent"}),
            );
        }
        assert_eq!(bounded.pending_tasks.len(), 200);
    }

    #[test]
    fn background_agent_waits_for_notification_after_parent_turn_ends() {
        for initially_background in [false, true] {
            let mut replay = SubagentReplay::new();
            replay.spawn("Agent", initially_background);
            let all = replay.task("task_started", json!({"tool_use_id":"agent","task_type":"local_agent","subagent_type":"explore",
                "description":"Inspect Rust","prompt":"Find the bug","is_backgrounded":initially_background,"spawn_depth":1}));
            assert_eq!(all[0].data["key"], "agent");
            assert_eq!(all[0].data["info"]["depth"], 1);
            replay.task("task_updated", json!({"patch":{"is_backgrounded":true}}));
            let all = replay.message(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"agent","content":"running in the background"}]}}));
            assert_eq!(
                all[0].data["info"],
                json!({"lastActivity":"Running in background"})
            );
            assert!(all.iter().all(|event| event.data.get("part").is_none()));
            replay.raw(json!({"ev":"session.status","cardId":"s","phase":"idle","operationId":"turn","status":"completed"}));
            let all = replay.raw(json!({"ev":"session.event","cardId":"s","message":{"type":"system","subtype":"task_notification","task_id":"task",
                "status":"completed","summary":"Real completion","usage":{"total_tokens":200,"tool_uses":3,"duration_ms":500}}}));
            assert_eq!(all.len(), 1);
            assert_eq!(all[0].kind, "chat.subagent");
            assert_eq!(all[0].turn_id, None);
            assert_eq!(all[0].data["info"]["status"], "completed");
            assert_eq!(all[0].data["info"]["summary"], "Real completion");
            assert_eq!(
                all[0].data["info"]["usage"],
                json!({"totalTokens":200,"toolUses":3,"durationMs":500})
            );
        }
    }

    #[test]
    fn task_progress_statuses_fallback_keys_and_ambient_filtering() {
        let mut replay = SubagentReplay::new();
        let all = replay.task(
            "task_started",
            json!({"task_type":"local_agent","description":"Fallback"}),
        );
        assert_eq!(all[0].data["key"], "task");
        let all = replay.task("task_progress", json!({"usage":{"total_tokens":10,"tool_uses":2,"duration_ms":9},"last_tool_name":"Read"}));
        assert_eq!(all[0].data["info"]["lastActivity"], "Read");
        assert_eq!(
            all[0].data["info"]["usage"],
            json!({"totalTokens":10,"toolUses":2,"durationMs":9})
        );
        let all = replay.task(
            "task_progress",
            json!({"summary":"Reviewing Rust","last_tool_name":"Read"}),
        );
        assert_eq!(all[0].data["info"]["lastActivity"], "Reviewing Rust");
        for (status, expected, reopen) in [
            ("running", "running", true),
            ("completed", "completed", false),
            ("failed", "failed", false),
            ("killed", "cancelled", false),
            ("paused", "running", false),
            ("pending", "running", false),
            ("new-status", "unknown", false),
        ] {
            let all = replay.task(
                "task_updated",
                json!({"patch":{"status":status,"error":"Task failed"}}),
            );
            assert_eq!(all[0].data["info"]["status"], expected);
            assert_eq!(
                all[0].data.get("reopen").and_then(Value::as_bool) == Some(true),
                reopen
            );
            assert_eq!(
                all[0].data["info"].get("summary").is_some(),
                status == "failed"
            );
        }
        for (status, expected) in [
            ("completed", "completed"),
            ("failed", "failed"),
            ("stopped", "cancelled"),
            ("new-status", "unknown"),
        ] {
            let all = replay.task(
                "task_notification",
                json!({"status":status,"summary":"Done"}),
            );
            assert_eq!(all[0].data["info"]["status"], expected);
        }
        for fields in [
            json!({"skip_transcript":true,"tool_use_id":"hidden"}),
            json!({"ambient":true,"tool_use_id":"hidden"}),
            json!({"task_type":"local_bash"}),
        ] {
            let mut hidden = SubagentReplay::new();
            assert!(hidden.task("task_started", fields).is_empty());
            assert!(hidden
                .task(
                    "task_progress",
                    json!({"tool_use_id":"hidden","summary":"Ignore"})
                )
                .is_empty());
            assert!(hidden
                .task(
                    "task_notification",
                    json!({"tool_use_id":"hidden","status":"completed"})
                )
                .is_empty());
        }
        assert!(SubagentReplay::new()
            .task("task_updated", json!({"patch":{"status":"running"}}))
            .is_empty());
    }

    #[test]
    fn child_stream_deltas_never_become_parent_deltas() {
        let mut replay = SubagentReplay::new();
        for kind in ["stream_event", "tool_progress"] {
            assert!(replay.message(json!({"type":kind,"parent_tool_use_id":"unknown-child","event":{"delta":{"text":"leaked"}}})).is_empty());
        }
        let all = replay.message(json!({"type":"stream_event","parent_tool_use_id":null,"event":{"delta":{"text":"Parent answer"}}}));
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].kind, "chat.delta");
        assert_eq!(all[0].data["part"]["text"], "Parent answer");
        let all = replay.message(json!({"type":"assistant","parent_tool_use_id":"unknown-child","uuid":"early","message":{"content":[{"type":"text","text":"Early child"}]}}));
        assert_eq!(all[0].data["key"], "unknown-child");
    }

    #[test]
    fn subagent_permissions_resolve_known_task_and_label_unknown_agent() {
        let mut replay = SubagentReplay::new();
        replay.spawn("Agent", false);
        replay.task(
            "task_started",
            json!({"tool_use_id":"agent","task_type":"local_agent","description":"Inspect Rust"}),
        );
        for (agent_id, expected) in [
            (
                "task",
                json!({"agentId":"task","key":"agent","label":"Inspect Rust"}),
            ),
            ("unknown", json!({"agentId":"unknown","label":"Subagent"})),
        ] {
            let all = replay.raw(json!({"ev":"session.request","cardId":"s","requestId":"permission","operationId":"turn",
                "agentId":agent_id,"toolUseId":"read","toolName":"Read","input":{"file_path":"a.rs"}}));
            assert_eq!(all.len(), 1);
            assert_eq!(all[0].kind, "chat.approval");
            assert_eq!(all[0].data["part"]["data"]["subagent"], expected);
            assert_eq!(all[0].data["request"]["toolUseId"], "read");
        }
        let all = replay.raw(json!({"ev":"session.request","cardId":"s","requestId":"parent-permission","toolName":"Read"}));
        assert!(all[0].data["part"]["data"].get("subagent").is_none());
    }

    #[test]
    fn ask_user_question_maps_questions_and_keeps_the_subagent_label() {
        let mut replay = SubagentReplay::new();
        replay.spawn("Agent", false);
        replay.task(
            "task_started",
            json!({"tool_use_id":"agent","task_type":"local_agent","description":"Inspect Rust"}),
        );
        let all = replay.raw(json!({"ev":"session.request","cardId":"s","requestId":"question","operationId":"turn",
            "agentId":"task","toolName":"AskUserQuestion","question":{"questions":[
                {"header":"Colour","question":"Which colour?","options":[{"label":"Blue","description":"Recommended"}]},
                {"header":"Tools","question":"Which tools?","options":[{"label":"Read"}],"multiSelect":true}
            ]}}));
        assert_eq!(all.len(), 1);
        let part = &all[0].data["part"];
        assert_eq!(part["data"]["interaction"], "question");
        assert_eq!(
            part["data"]["form"]["questions"][0],
            json!({"id":"q0","header":"Colour","question":"Which colour?","options":[{"label":"Blue","description":"Recommended"}],"multiSelect":false,"allowOther":true,"secret":false})
        );
        assert_eq!(part["data"]["form"]["questions"][1]["id"], "q1");
        assert_eq!(part["data"]["form"]["questions"][1]["multiSelect"], true);
        assert_eq!(
            part["data"]["subagent"],
            json!({"agentId":"task","key":"agent","label":"Inspect Rust"})
        );
        assert_eq!(all[0].data["choices"], json!([]));
    }

    #[test]
    fn history_agent_and_task_spawns_have_static_subagent_parts() {
        for name in ["Agent", "Task"] {
            let items = claude_transcript(&[
                json!({"type":"assistant","uuid":"spawn","message":{"content":[
                    {"type":"tool_use","id":"agent","name":name,"input":{"description":"Old task"}},
                    {"type":"tool_use","id":"read","name":"Read","input":{}}
                ]}}),
                json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"agent","content":"done"}]}}),
                json!({"type":"assistant","parent_tool_use_id":"agent","message":{"content":[{"type":"text","text":"child"}]}}),
            ]);
            let part = &items[0]["parts"][0];
            assert_eq!(part["type"], "subagent");
            assert_eq!(part["toolId"], "agent");
            assert_eq!(part["data"]["transcript"], "none");
            assert_eq!(part["data"]["agentType"], "general-purpose");
            assert_eq!(items[0]["parts"][1]["type"], "tool");
            assert_eq!(items[1]["parts"], json!([]));
            assert_eq!(items.len(), 2);
        }
    }

    #[test]
    fn subagent_replay_projects_bounded_rows_without_parent_lifecycle_side_effects() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(&dir.path().join("subagents.sqlite")).unwrap();
        db.transaction(|tx| {
            tx.execute("INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at) VALUES ('s','test','claude','chat','running','now','now')", [])?;
            Ok(())
        }).unwrap();
        crate::chat_projection::record(
            &db,
            "s",
            Some("turn"),
            "message.user",
            &json!({"text":"Parent prompt"}),
        )
        .unwrap();
        let project = |events: Vec<super::super::ProviderEvent>| {
            for event in events {
                crate::chat_projection::record(
                    &db,
                    "s",
                    event.turn_id.as_deref(),
                    &event.kind,
                    &event.data,
                )
                .unwrap();
            }
        };
        let mut replay = SubagentReplay::new();
        project(replay.spawn("Agent", true));
        for text in ["Initial text", "Authoritative text"] {
            project(replay.message(json!({"type":"assistant","uuid":"snapshot","parent_tool_use_id":"agent","message":{"content":[
                {"type":"text","text":text}, {"type":"thinking","thinking":"Thought"},
                {"type":"tool_use","id":"read","name":"Read","input":{"file_path":"src/a.rs"}}
            ]}})));
        }
        project(replay.message(
            json!({"type":"user","parent_tool_use_id":"agent","message":{"content":[
                {"type":"tool_result","tool_use_id":"read","content":"File output"}
            ]}}),
        ));
        let (items, rev, _) = db.subagent_items_after("s", "agent", 0).unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(rev, 7);
        assert_eq!(items[0].parts.len(), 1);
        assert_eq!(items[0].parts[0]["text"], "Authoritative text");
        assert_eq!(items[1].parts.len(), 1);
        assert_eq!(items[2].parts.len(), 1);
        assert_eq!(items[2].parts[0]["toolName"], "Read");
        assert_eq!(items[2].parts[0]["status"], "complete");
        assert_eq!(items[2].parts[0]["data"]["content"], "File output");
        let card = db.subagent_card("s", "agent").unwrap().unwrap();
        assert_eq!(card.parts[0]["data"]["itemCount"], 3);
        assert_eq!(card.parts[0]["data"]["toolCount"], 1);
        project(replay.task(
            "task_started",
            json!({"tool_use_id":"agent","task_type":"local_agent","is_backgrounded":true}),
        ));
        project(replay.message(
            json!({"type":"assistant","parent_tool_use_id":"agent","message":{"content":[
                {"type":"tool_use","id":"inner","name":"Agent","input":{}}
            ]}}),
        ));
        project(replay.task(
            "task_started",
            json!({"task_id":"inner-task","tool_use_id":"inner","task_type":"local_agent"}),
        ));
        project(replay.task(
            "task_notification",
            json!({"task_id":"inner-task","status":"completed","summary":"Nested result"}),
        ));
        assert_eq!(
            db.subagent_card("s", "agent").unwrap().unwrap().parts[0]["status"],
            "running"
        );
        assert_eq!(db.session_by_id("s").unwrap().unwrap().status, "running");
        project(replay.raw(json!({"ev":"session.status","cardId":"s","phase":"idle","operationId":"turn","status":"completed"})));
        let parent = db.session_by_id("s").unwrap().unwrap();
        project(replay.raw(json!({"ev":"session.event","cardId":"s","message":{"type":"system","subtype":"task_notification",
            "task_id":"task","status":"completed","summary":"Final background result","usage":{"total_tokens":100}}})));
        let after = db.session_by_id("s").unwrap().unwrap();
        assert_eq!(after.status, parent.status);
        assert_eq!(
            serde_json::to_value(after.activity).unwrap(),
            serde_json::to_value(parent.activity).unwrap()
        );
        let card = db.subagent_card("s", "agent").unwrap().unwrap();
        assert_eq!(card.turn_id.as_deref(), Some("turn"));
        assert_eq!(card.parts[0]["status"], "completed");
        assert_eq!(card.parts[0]["data"]["summary"], "Final background result");
        db.transaction(|tx| {
            let count: i64 =
                tx.query_row("SELECT COUNT(*) FROM usage_records", [], |row| row.get(0))?;
            assert_eq!(count, 0, "child usage must not become parent usage");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn sdk_tool_use_and_failed_result_keep_native_id_without_duplicate_text() {
        let (events, mut receiver) = crate::provider_events::tap_channel(16);
        let native = Mutex::new(Some("native".to_owned()));
        let liveness = WorkerLiveness::default();
        for message in [
            json!({"type":"assistant","message":{"content":[
                {"type":"text","text":"already streamed"},
                {"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"src/one.rs"}},
                {"type":"tool_use","id":"toolu_2","name":"Write","input":{"path":"src/two.rs"}}
            ]}}),
            json!({"type":"user","message":{"content":[
                {"type":"tool_result","tool_use_id":"toolu_1","is_error":true,"content":[{"path":"src/three.rs"}]}
            ]}}),
        ] {
            emit_claude_message(
                &events,
                "session",
                &native,
                &liveness,
                &ClaudeUi::default(),
                Some("worker"),
                json!({"ev":"session.event","cardId":"session","sessionId":"native","operationId":"turn","message":message}),
            );
        }
        let all: Vec<_> = (0..5).map(|_| receiver.try_recv().unwrap()).collect();
        assert_eq!(
            all.iter()
                .filter(|event| event.data.get("part").is_some())
                .count(),
            3
        );
        assert_eq!(all[1].data["item"]["id"], "toolu_1");
        assert_eq!(all[2].data["item"]["id"], "toolu_2");
        assert_eq!(all[4].data["part"]["status"], "failed");
        assert_eq!(all[4].data["part"]["toolId"], "toolu_1");
        assert_eq!(all[4].worker_token.as_deref(), Some("worker"));
        let history = claude_transcript(&[
            json!({"type":"assistant","message":{"content":[
                {"type":"tool_use","id":"toolu_h","name":"Read","input":{"path":"history.rs"}}
            ]}}),
            json!({"type":"user","message":{"content":[
                {"type":"tool_result","tool_use_id":"toolu_h","is_error":true,"content":[{"file_path":"failed.rs"}]}
            ]}}),
        ]);
        assert_eq!(
            history[0]["parts"][0]["fileReferences"][0]["path"],
            "history.rs"
        );
        assert_eq!(history[1]["parts"][0]["toolId"], "toolu_h");
        assert_eq!(
            history[1]["parts"][0]["fileReferences"][0]["path"],
            "failed.rs"
        );
    }

    struct EnvironmentRestore(Vec<(&'static str, Option<std::ffi::OsString>)>);

    impl EnvironmentRestore {
        fn set(&mut self, key: &'static str, value: impl AsRef<std::ffi::OsStr>) {
            if !self.0.iter().any(|(existing, _)| *existing == key) {
                self.0.push((key, std::env::var_os(key)));
            }
            std::env::set_var(key, value);
        }
    }

    impl Drop for EnvironmentRestore {
        fn drop(&mut self) {
            for (key, value) in self.0.drain(..) {
                if let Some(value) = value {
                    std::env::set_var(key, value);
                } else {
                    std::env::remove_var(key);
                }
            }
        }
    }

    #[test]
    fn keeps_claude_session_id() {
        assert_eq!(
            claude_history_item(json!({"sessionId":"c1","summary":"Hello"})).unwrap()["nativeId"],
            "c1"
        );
    }
    #[test]
    fn extracts_text_blocks() {
        assert_eq!(
            claude_transcript(&[
                json!({"type":"assistant","uuid":"m1","message":{"content":[{"type":"text","text":"ok"}]}})
            ])[0]["parts"][0]["text"],
            "ok"
        );
    }

    #[test]
    fn request_cancelled_maps_to_a_targeted_expired_resolution() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let native = Mutex::new(Some("native-1".to_owned()));
        let liveness = WorkerLiveness::default();
        emit_claude_message(
            &events,
            "card-1",
            &native,
            &liveness,
            &ClaudeUi::default(),
            None,
            json!({
                "ev":"session.request_cancelled",
                "requestId":"card-1-permission-3",
                "operationId":"op-9",
                "sessionId":"native-1"
            }),
        );
        let event = rx.try_recv().unwrap();
        assert_eq!(event.kind, "chat.approval.resolved");
        assert_eq!(event.session_id, "card-1");
        assert_eq!(event.native_id.as_deref(), Some("native-1"));
        assert_eq!(event.turn_id.as_deref(), Some("op-9"));
        assert_eq!(event.data["approvalId"], "card-1-permission-3");
        assert_eq!(event.data["status"], "expired");
        assert_eq!(event.data["outcome"], "cancelled");
    }

    #[test]
    fn closed_and_error_phases_mark_the_worker_ended() {
        let (events, _rx) = crate::provider_events::tap_channel(16);
        let native = Mutex::new(None);
        let liveness = WorkerLiveness::default();
        assert!(!liveness.ended());
        emit_claude_message(
            &events,
            "card-1",
            &native,
            &liveness,
            &ClaudeUi::default(),
            None,
            json!({"ev":"session.status","phase":"running"}),
        );
        assert!(!liveness.ended(), "a running turn is not a death signal");
        emit_claude_message(
            &events,
            "card-1",
            &native,
            &liveness,
            &ClaudeUi::default(),
            None,
            json!({"ev":"session.status","phase":"error","error":"boom"}),
        );
        assert!(liveness.ended(), "an internal error must end liveness");
        let second = WorkerLiveness::default();
        emit_claude_message(
            &events,
            "card-1",
            &native,
            &second,
            &ClaudeUi::default(),
            None,
            json!({"ev":"session.status","phase":"closed"}),
        );
        assert!(second.ended(), "an internal close must end liveness");
    }

    #[test]
    fn mismatched_native_identity_cannot_replace_a_resumed_binding() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let native = Mutex::new(Some("native-original".to_owned()));
        let liveness = WorkerLiveness::default();
        emit_claude_message(
            &events,
            "card-1",
            &native,
            &liveness,
            &ClaudeUi::default(),
            Some("worker-1"),
            json!({"ev":"session.status","cardId":"card-1","phase":"ready","sessionId":"native-other"}),
        );
        assert_eq!(native.lock().unwrap().as_deref(), Some("native-original"));
        assert!(liveness.ended());
        let event = rx.try_recv().unwrap();
        assert_eq!(event.kind, "chat.error");
        assert_eq!(event.native_id.as_deref(), Some("native-original"));
        assert_eq!(event.worker_token.as_deref(), Some("worker-1"));
        assert!(
            rx.try_recv().is_err(),
            "a foreign ready event must not leak"
        );
    }

    #[test]
    fn host_fatal_ends_liveness_with_the_original_worker_token() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let native = Mutex::new(None);
        let liveness = WorkerLiveness::default();
        emit_claude_message(
            &events,
            "card-1",
            &native,
            &liveness,
            &ClaudeUi::default(),
            Some("worker-1"),
            json!({"ev":"host.fatal","cardId":"","error":"SDK crashed"}),
        );
        assert!(liveness.ended());
        let event = rx.try_recv().unwrap();
        assert_eq!(event.kind, "chat.error");
        assert_eq!(event.worker_token.as_deref(), Some("worker-1"));
    }

    /// Writes a minimal sidecar-protocol host. mode: `ok` answers session.start
    /// after `delay_ms`; `fail` answers with an error; `die` answers then
    /// reports the internal query closed shortly after.
    #[cfg(windows)]
    fn fake_host(dir: &std::path::Path, mode: &str, delay_ms: u64) -> PathBuf {
        let script = format!(
            r#"import {{ createInterface }} from 'node:readline';
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const ui = mode => ({{ options: [{{ id: 'mode', name: 'Permission mode', value: mode, choices: [{{ value: 'default', name: 'Default' }}, {{ value: 'plan', name: 'Plan' }}] }}], commands: [{{ name: 'compact', description: 'Free up context' }}] }});
let localHistoryId;
createInterface({{ input: process.stdin, crlfDelay: Infinity }}).on('line', line => {{
  let req; try {{ req = JSON.parse(line); }} catch {{ return; }}
  if (req.op === 'host.ping') return write({{ id: req.id, ok: {{ pid: process.pid }} }});
  if (req.op === 'history.read') {{
    if ('{mode}' === 'history-relocated' || '{mode}' === 'history-global-malformed' || '{mode}' === 'history-global-error') {{
      if (req.cwd) {{ localHistoryId = req.sessionId; return write({{ id: req.id, ok: {{ messages: [] }} }}); }}
      if (localHistoryId !== req.sessionId) return write({{ id: req.id, error: {{ message: 'global lookup used another worker or ID' }} }});
      if ('{mode}' === 'history-relocated') return write({{ id: req.id, ok: {{ messages: [{{ fixtureHistoryPresent: true }}] }} }});
      if ('{mode}' === 'history-global-malformed') return write({{ id: req.id, ok: {{ messages: 'not-an-array' }} }});
      return write({{ id: req.id, error: {{ message: 'global history read failed' }} }});
    }}
    if ('{mode}' === 'history-error') return req.cwd
      ? write({{ id: req.id, error: {{ message: 'native history read failed' }} }})
      : write({{ id: req.id, ok: {{ messages: [{{ fixtureHistoryPresent: true }}] }} }});
    if ('{mode}' === 'history-malformed') return req.cwd
      ? write({{ id: req.id, ok: {{ messages: 'not-an-array' }} }})
      : write({{ id: req.id, ok: {{ messages: [{{ fixtureHistoryPresent: true }}] }} }});
    if ('{mode}' === 'history-empty') return write({{ id: req.id, ok: {{ messages: [] }} }});
    return write({{ id: req.id, error: {{ message: 'unsupported history fixture' }} }});
  }}
  if (req.op === 'session.start') {{
    setTimeout(() => {{
      if ('{mode}' === 'fail') return write({{ id: req.id, error: {{ message: 'handshake rejected: not authenticated' }} }});
      if ('{mode}' === 'die-before') write({{ ev: 'session.status', cardId: req.cardId, phase: 'closed', sessionId: 'native-fixture' }});
      write({{ id: req.id, ok: {{ sessionId: req.sessionId ?? null, ui: ui('default') }} }});
      if ('{mode}' === 'die') setTimeout(() => write({{ ev: 'session.status', cardId: req.cardId, phase: 'closed', sessionId: 'native-fixture' }}), 250);
    }}, {delay_ms});
    return;
  }}
  if (req.op === 'session.set_option') return req.optionId === 'mode' && req.value === 'plan'
    ? write({{ id: req.id, ok: {{ ui: ui('plan') }} }})
    : write({{ id: req.id, error: {{ message: `${{req.value}} is not an available choice` }} }});
  if (req.op === 'session.decision') {{
    write({{ ev: 'provider.event', cardId: req.cardId, decision: req.behavior, requestId: req.requestId }});
    return write({{ id: req.id, ok: {{}} }});
  }}
  if (req.op === 'session.stop') return write({{ id: req.id, ok: {{}} }});
  write({{ id: req.id, error: {{ message: 'unsupported op' }} }});
}});
"#
        );
        let path = dir.join(format!("fake-host-{mode}.mjs"));
        std::fs::write(&path, script).unwrap();
        path
    }

    #[cfg(windows)]
    #[test]
    fn sidecar_handshake_gates_open_and_internal_death_ends_liveness() {
        if crate::providers::common::find_executable("node").is_none() {
            eprintln!("node is unavailable; skipping the sidecar fixture test");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut environment = EnvironmentRestore(Vec::new());
        let cwd = dir.path().to_string_lossy().into_owned();

        // A slow handshake must delay open_chat instead of reporting ready early.
        let ok_host = fake_host(dir.path(), "ok", 400);
        environment.set("THREADTERM_CLAUDE_SDK_HOST", &ok_host);
        let adapter = ClaudeAdapter::new(crate::provider_events::tap_channel(16).0);
        let started = std::time::Instant::now();
        let mut chat = adapter.open_chat("card-ok", &cwd, None).unwrap();
        assert!(
            started.elapsed() >= Duration::from_millis(350),
            "open_chat returned before the sidecar handshake completed"
        );
        assert!(chat.is_alive());
        chat.stop().unwrap();

        // A rejected handshake fails open_chat with the real error.
        let fail_host = fake_host(dir.path(), "fail", 20);
        environment.set("THREADTERM_CLAUDE_SDK_HOST", &fail_host);
        let failure = adapter
            .open_chat("card-fail", &cwd, None)
            .err()
            .expect("a rejected handshake must fail open_chat");
        assert!(
            failure.message.contains("not authenticated"),
            "unexpected failure: {}",
            failure.message
        );

        // A query that dies before its successful start reply cannot leave a
        // briefly ready worker behind.
        let early_death_host = fake_host(dir.path(), "die-before", 20);
        environment.set("THREADTERM_CLAUDE_SDK_HOST", &early_death_host);
        let early_death = adapter
            .open_chat("card-die-before", &cwd, None)
            .err()
            .expect("an already-ended query cannot open a ready chat");
        assert_eq!(early_death.code, "provider_disconnected");

        // The host staying alive while the internal query ends must end liveness.
        let die_host = fake_host(dir.path(), "die", 20);
        environment.set("THREADTERM_CLAUDE_SDK_HOST", &die_host);
        let chat = adapter.open_chat("card-die", &cwd, None).unwrap();
        assert!(chat.is_alive());
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while chat.is_alive() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !chat.is_alive(),
            "host process alive but internal query closed must not stay alive"
        );

        let native_id = "3d209631-5558-452c-adf5-25d14cff23d7";
        let relocated_host = fake_host(dir.path(), "history-relocated", 0);
        environment.set("THREADTERM_CLAUDE_SDK_HOST", &relocated_host);
        adapter.preflight_terminal_resume(&cwd, native_id).unwrap();
        for (mode, code, message) in [
            (
                "history-empty",
                "session_has_no_native_history",
                "Claude has no persisted conversation",
            ),
            (
                "history-malformed",
                "provider_protocol",
                "malformed session history",
            ),
            (
                "history-error",
                "provider_error",
                "native history read failed",
            ),
            (
                "history-global-malformed",
                "provider_protocol",
                "malformed session history",
            ),
            (
                "history-global-error",
                "provider_error",
                "global history read failed",
            ),
        ] {
            let host = fake_host(dir.path(), mode, 0);
            environment.set("THREADTERM_CLAUDE_SDK_HOST", &host);
            let error = adapter
                .preflight_terminal_resume(&cwd, native_id)
                .unwrap_err();
            assert_eq!(error.code, code, "{mode}");
            assert!(error.message.contains(message), "{mode}: {}", error.message);
        }

        // Options, approvals and blocked commands over the real sidecar pipes.
        let options_host = fake_host(dir.path(), "options", 0);
        environment.set("THREADTERM_CLAUDE_SDK_HOST", &options_host);
        let (sender, mut receiver) = crate::provider_events::tap_channel(64);
        let adapter = ClaudeAdapter::new(sender);
        let mut chat = adapter.open_chat("card-options", &cwd, None).unwrap();
        let ui = chat.ui_state();
        assert_eq!(ui["options"][0]["id"], "mode");
        assert_eq!(ui["options"][0]["value"], "default");
        assert_eq!(ui["commands"][0]["name"], "compact");
        let updated = chat.set_option("mode", "plan").unwrap();
        assert_eq!(updated["options"][0]["value"], "plan");
        assert_eq!(chat.ui_state()["options"][0]["value"], "plan");
        let refused = chat.set_option("mode", "bypassPermissions").unwrap_err();
        assert!(refused.message.contains("not an available choice"));
        assert_eq!(chat.ui_state()["options"][0]["value"], "plan");
        chat.approve("turn", "card-options-permission-1", "allow_always", "op-1")
            .unwrap();
        let invalid = chat
            .approve("turn", "card-options-permission-1", "allow_forever", "op-2")
            .unwrap_err();
        assert_eq!(invalid.code, "approval_choice_invalid");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut decisions = Vec::new();
        let mut resolved = Vec::new();
        while std::time::Instant::now() < deadline && (decisions.is_empty() || resolved.is_empty()) {
            while let Ok(event) = receiver.try_recv() {
                if let Some(decision) = event.data.pointer("/raw/decision").and_then(Value::as_str)
                {
                    decisions.push(decision.to_owned());
                }
                if event.kind == "chat.approval.resolved" {
                    resolved.push((event.turn_id.clone(), event.data.clone()));
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            decisions,
            ["allow_always"],
            "only the valid choice reaches the sidecar"
        );
        assert_eq!(
            resolved,
            [(
                Some("turn".to_owned()),
                json!({"approvalId":"card-options-permission-1","outcome":"submitted"})
            )],
            "the accepted decision settles its card; the refused one settles nothing"
        );
        assert_eq!(
            chat.validate_send("/clear").unwrap_err().code,
            "chat_command_unavailable"
        );
        chat.stop().unwrap();

        // Capability: the Chat CLI's own `auth status` decides Chat availability.
        environment.set("THREADTERM_CLAUDE_SDK_HOST", &ok_host);
        environment.set("THREADTERM_CLAUDE_PATH", fake_cli(dir.path(), false));
        let capability = adapter.capability();
        assert_eq!(capability.auth, "unauthenticated");
        assert!(!capability.chat);
        assert_eq!(capability.reason.as_deref(), Some(CLAUDE_NOT_SIGNED_IN));
        environment.set("THREADTERM_CLAUDE_PATH", fake_cli(dir.path(), true));
        let capability = adapter.capability();
        assert_eq!(capability.auth, "authenticated");
        assert!(capability.chat);
        // Only with a real Terminal version (the harness can prefix child stdout).
        if capability
            .version
            .as_deref()
            .and_then(claude_version_number)
            .is_some()
        {
            let reason = capability.reason.unwrap_or_default();
            assert!(reason.contains("Claude Code 9.9.9"), "{reason}");
        }
    }

    /// A stand-in for the Chat CLI answering `auth status --json` and `--version`.
    #[cfg(windows)]
    fn fake_cli(dir: &std::path::Path, logged_in: bool) -> PathBuf {
        let (json, code) = if logged_in {
            (r#"{"loggedIn":true,"authMethod":"claude.ai"}"#, 0)
        } else {
            (r#"{"loggedIn":false,"authMethod":"none"}"#, 1)
        };
        let script = format!(
            "@echo off\r\nif \"%~1\"==\"--version\" goto version\r\necho {json}\r\nexit /b {code}\r\n:version\r\necho 9.9.9 (Claude Code)\r\nexit /b 0\r\n"
        );
        let path = dir.join(format!("fake-claude-cli-{logged_in}.cmd"));
        std::fs::write(&path, script).unwrap();
        path
    }

    fn approval_choice_ids(raw: Value) -> Vec<(String, String, String)> {
        claude_approval_choices(&raw)
            .into_iter()
            .map(|choice| (choice.choice_id, choice.label, choice.scope))
            .collect()
    }

    #[test]
    fn approval_offers_always_only_for_sdk_suggestions_and_names_their_scope() {
        let plain = approval_choice_ids(json!({"suggestions":[]}));
        assert_eq!(
            plain
                .iter()
                .map(|(id, _, _)| id.as_str())
                .collect::<Vec<_>>(),
            ["allow", "deny"]
        );
        assert_eq!(approval_choice_ids(json!({})).len(), 2);
        let project = approval_choice_ids(
            json!({"suggestions":[{"type":"addRules","rules":[{"toolName":"PowerShell","ruleContent":"node tt.js"}],"behavior":"allow","destination":"localSettings"}]}),
        );
        assert_eq!(
            project[1],
            (
                "allow_always".into(),
                "Always allow in this project".into(),
                "persistent".into()
            )
        );
        let edits = approval_choice_ids(
            json!({"suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}),
        );
        assert_eq!(
            edits[1],
            (
                "allow_always".into(),
                "Allow all edits this session".into(),
                "session".into()
            )
        );
        let session = approval_choice_ids(
            json!({"suggestions":[{"type":"addDirectories","directories":["C:/x"],"destination":"session"}]}),
        );
        assert_eq!(session[1].1, "Allow for this session");
        let everywhere = approval_choice_ids(json!({"suggestions":[
            {"type":"addRules","rules":[],"behavior":"allow","destination":"session"},
            {"type":"addRules","rules":[],"behavior":"allow","destination":"userSettings"}
        ]}));
        assert_eq!(everywhere[1].1, "Always allow everywhere");
        assert_eq!(everywhere[2].0, "deny");
    }

    #[test]
    fn approval_card_and_ui_updates_carry_claude_choices_and_state() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let native = Mutex::new(Some("native".to_owned()));
        let liveness = WorkerLiveness::default();
        let ui = ClaudeUi::default();
        emit_claude_message(
            &events,
            "card-1",
            &native,
            &liveness,
            &ui,
            Some("worker"),
            json!({"ev":"session.request","cardId":"card-1","requestId":"card-1-permission-1","operationId":"op","sessionId":"native","toolName":"Write","suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}),
        );
        let card = rx.try_recv().unwrap();
        assert_eq!(card.kind, "chat.approval");
        assert_eq!(card.data["choices"][1]["choiceId"], "allow_always");
        assert_eq!(card.data["part"]["data"]["choices"][1]["scope"], "session");
        emit_claude_message(
            &events,
            "card-1",
            &native,
            &liveness,
            &ui,
            Some("worker"),
            json!({"ev":"session.ui","cardId":"card-1","sessionId":"native","ui":{"options":[{"id":"mode","name":"Permission mode","value":"plan","choices":[]}],"commands":[{"name":"compact"}],"extra":true}}),
        );
        let update = rx.try_recv().unwrap();
        assert_eq!(update.kind, "chat.ui");
        assert_eq!(update.data["sessionId"], "card-1");
        assert_eq!(update.data["options"][0]["value"], "plan");
        assert_eq!(update.worker_token.as_deref(), Some("worker"));
        assert!(
            update.data.get("extra").is_none(),
            "only options and commands are forwarded"
        );
        assert_eq!(ui.wire()["commands"][0]["name"], "compact");
        emit_claude_message(
            &events,
            "card-1",
            &native,
            &liveness,
            &ui,
            None,
            json!({"ev":"session.ui","cardId":"card-1","ui":"not-an-object"}),
        );
        assert!(rx.try_recv().is_err());
        assert_eq!(ui.wire()["options"][0]["value"], "plan");
    }

    fn visible_text(raw: Value) -> Vec<(Option<String>, String)> {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        emit_claude_message(
            &events,
            "card-1",
            &Mutex::new(None),
            &WorkerLiveness::default(),
            &ClaudeUi::default(),
            None,
            raw,
        );
        let mut texts = Vec::new();
        while let Ok(event) = rx.try_recv() {
            if let Some(text) = event.data.pointer("/part/text").and_then(Value::as_str) {
                texts.push((
                    event
                        .data
                        .pointer("/item/id")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    text.to_owned(),
                ));
            }
        }
        texts
    }

    #[test]
    fn local_command_output_is_shown_once_and_streamed_answers_are_not_repeated() {
        let event = |message: Value, extra: Value| {
            let mut raw = json!({"ev":"session.event","cardId":"card-1","operationId":"op","message":message});
            for (key, value) in extra.as_object().unwrap() {
                raw[key] = value.clone();
            }
            raw
        };
        let local = json!({"type":"assistant","uuid":"u-local","parent_tool_use_id":null,"message":{"id":"m-local","content":[{"type":"text","text":"## Context Usage"}]}});
        assert_eq!(
            visible_text(event(local.clone(), json!({"streamed":false}))),
            [(Some("u-local".to_owned()), "## Context Usage".to_owned())]
        );
        assert!(visible_text(event(local.clone(), json!({"streamed":true}))).is_empty());
        assert!(
            visible_text(event(local.clone(), json!({}))).is_empty(),
            "no flag: older sidecar, stay silent"
        );
        let mut subagent = local.clone();
        subagent["parent_tool_use_id"] = json!("toolu_1");
        assert!(visible_text(event(subagent, json!({"streamed":false}))).is_empty());
        let mut outside = event(local, json!({"streamed":false}));
        outside.as_object_mut().unwrap().remove("operationId");
        assert!(
            visible_text(outside).is_empty(),
            "output between turns has no turn to join"
        );
        let stdout = json!({"type":"user","uuid":"u-out","message":{"role":"user","content":"<local-command-stdout>Compacted </local-command-stdout>"}});
        assert_eq!(
            visible_text(event(stdout, json!({}))),
            [(Some("u-out".to_owned()), "Compacted".to_owned())]
        );
        let summary = json!({"type":"user","uuid":"u-summary","message":{"role":"user","content":"This session is being continued from a previous conversation."}});
        assert!(visible_text(event(summary, json!({}))).is_empty());
        let system = json!({"type":"system","subtype":"local_command_output","uuid":"u-sys","content":"Session renamed to: x"});
        assert_eq!(
            visible_text(event(system, json!({})))[0].1,
            "Session renamed to: x"
        );
        assert_eq!(
            claude_local_command_output("<local-command-stdout>a</local-command-stdout><local-command-stderr>b</local-command-stderr>"),
            "a\nb"
        );
    }

    #[test]
    fn only_completed_turns_ask_for_attention_in_the_branch_tree() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(&dir.path().join("activity.sqlite")).unwrap();
        db.transaction(|tx| {
            tx.execute("INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at) VALUES ('s','test','claude','chat','idle','now','now')", [])?;
            Ok(())
        })
        .unwrap();
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let native = Mutex::new(Some("native".to_owned()));
        let (liveness, ui) = (WorkerLiveness::default(), ClaudeUi::default());
        let mut activity_after = |turn: &str, status: &str| {
            crate::chat_projection::record(
                &db,
                "s",
                Some(turn),
                "message.user",
                &json!({"text":"hi"}),
            )
            .unwrap();
            for raw in [
                json!({"ev":"session.status","cardId":"s","phase":"running","operationId":turn}),
                json!({"ev":"session.status","cardId":"s","phase":"idle","status":status,"operationId":turn}),
            ] {
                emit_claude_message(&events, "s", &native, &liveness, &ui, None, raw);
                let event = rx.try_recv().unwrap();
                crate::chat_projection::record(
                    &db,
                    "s",
                    event.turn_id.as_deref(),
                    &event.kind,
                    &event.data,
                )
                .unwrap();
            }
            db.session_by_id("s")
                .unwrap()
                .unwrap()
                .activity
                .unwrap()
                .state
        };
        assert_eq!(activity_after("t1", "completed"), "awaiting_input");
        assert_eq!(
            activity_after("t2", "interrupted"),
            "idle",
            "a turn the user stopped is not waiting for them"
        );
        assert_eq!(activity_after("t3", "failed"), "idle");
    }

    #[test]
    fn chat_rejects_commands_that_would_break_the_session_or_open_a_browser() {
        for text in ["/clear", "  /clear now", "/extra-usage", "/usage-credits x"] {
            let error = claude_blocked_command(text).expect(text);
            assert_eq!(error.code, "chat_command_unavailable");
            assert!(
                error.message.contains(" / "),
                "bilingual: {}",
                error.message
            );
        }
        for text in ["/compact", "//clear", "clear the screen", "/clearer", ""] {
            assert!(claude_blocked_command(text).is_none(), "{text}");
        }
    }

    #[test]
    fn auth_status_and_version_note_parsing() {
        assert_eq!(
            parse_claude_auth_status(r#"{"loggedIn":true,"authMethod":"api_key"}"#),
            ClaudeAuth::SignedIn
        );
        assert_eq!(
            parse_claude_auth_status("{\n  \"loggedIn\": false,\n  \"authMethod\": \"none\"\n}"),
            ClaudeAuth::SignedOut
        );
        assert_eq!(
            parse_claude_auth_status(
                "warning: stale plugin cache
{\"loggedIn\":true}
"
            ),
            ClaudeAuth::SignedIn
        );
        assert_eq!(
            parse_claude_auth_status("error: unknown command 'auth'"),
            ClaudeAuth::Unknown
        );
        assert_eq!(ClaudeAuth::Unknown.as_str(), "unknown");
        assert_eq!(
            claude_version_note(Some("2.1.266 (Claude Code)"), Some("2.1.266 (Claude Code)")),
            None
        );
        let note =
            claude_version_note(Some("2.1.266 (Claude Code)"), Some("2.1.282 (Claude Code)"))
                .unwrap();
        assert!(note.contains("Claude Code 2.1.266") && note.contains("Claude Code 2.1.282"));
        assert_eq!(claude_version_note(None, Some("2.1.282")), None);
        assert_eq!(
            claude_version_number(
                "running 1 test
9.9.9 (Claude Code)"
            ),
            Some("9.9.9")
        );
        assert_eq!(claude_version_number("running 1 test"), None);
    }
}
