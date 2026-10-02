use super::{
    approval::{approval_payload, ApprovalChoice},
    common::{
        command_output, find_executable, history_page, insert_optional, validate_native_id,
        version_probe, CommandSpec, EnvelopeStyle, JsonLineProcess,
    },
    emit_scoped, ChatSession, ChatToolServer, ProviderAdapter, ProviderCapability, ProviderError,
    ProviderEvent, TerminalCommand,
};
use chrono::{TimeZone, Utc};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::broadcast;

pub struct ClaudeAdapter {
    events: broadcast::Sender<ProviderEvent>,
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
pub(crate) struct ClaudeUi(Arc<Mutex<Option<Value>>>);

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
    pub fn new(events: broadcast::Sender<ProviderEvent>) -> Self {
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
            id: "claude".to_owned(),
            name: "Claude".to_owned(),
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
    events: broadcast::Sender<ProviderEvent>,
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

fn emit_claude_message(
    events: &broadcast::Sender<ProviderEvent>,
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
        let choices = claude_approval_choices(&raw);
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
                "part":{"type":"approval","approvalId":approval_id,"status":"pending","data":approval_payload(approval_id,"claude","session.request",raw.get("title").and_then(Value::as_str).unwrap_or("Permission request"),&raw,&choices,turn_id,true)}
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
    raw.iter().enumerate().filter_map(|(index, entry)| {
        let message = entry.get("message")?;
        let role = entry.get("type").or_else(|| message.get("role")).and_then(Value::as_str)?;
        if !matches!(role, "user"|"assistant") { return None; }
        let parts = message.get("content").and_then(Value::as_array).map(|content| content.iter().filter_map(|part| {
            match part.get("type").and_then(Value::as_str) {
                Some("text") => Some(json!({"type":"text","text":part.get("text").and_then(Value::as_str).unwrap_or_default()})),
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
    fn sdk_tool_use_and_failed_result_keep_native_id_without_duplicate_text() {
        let (events, mut receiver) = broadcast::channel(16);
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
        let (events, mut rx) = broadcast::channel(16);
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
        let (events, _rx) = broadcast::channel(16);
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
        let (events, mut rx) = broadcast::channel(16);
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
        let (events, mut rx) = broadcast::channel(16);
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
        let adapter = ClaudeAdapter::new(broadcast::channel(16).0);
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
        let (sender, mut receiver) = broadcast::channel(64);
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
        let (events, mut rx) = broadcast::channel(16);
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
        let (events, mut rx) = broadcast::channel(16);
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
        let (events, mut rx) = broadcast::channel(16);
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
