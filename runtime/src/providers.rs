//! Native provider adapters for structured Chat and provider-owned history.
//!
//! Terminal mode is intentionally separate: this module only returns an
//! executable specification for the PTY owner. Chat workers use native
//! machine-readable protocols and never parse terminal output.

mod acp;
mod approval;
mod claude;
mod codex;
#[cfg(test)]
mod conformance;
pub(crate) mod common;
mod grok;
mod kimi_plan_usage;
pub(crate) mod network;
mod opencode;
mod pi;
#[cfg(test)]
mod retirement_tests;

use serde::{Deserialize, Serialize};
pub(crate) use crate::domain::NativeForkAnchor;
use serde_json::{json, Value};
use crate::provider_events::{self, ProjectionReceiver, Sender as ProviderEventSender};
use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex, RwLock},
    time::Instant,
};
#[cfg(test)]
use std::time::Duration;
use tokio::sync::broadcast;

/// A stdio MCP server attached to one Chat session when it opens (ThreadTerm's
/// own delegation tools). `env` carries that session's identity, so a fresh
/// spec is resolved for every open, including reconnects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatToolServer {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Decides, per `(session_id, provider)`, whether a Chat gets a tool server.
pub type ToolServerResolver = Arc<dyn Fn(&str, &str) -> Option<ChatToolServer> + Send + Sync>;
/// Reads ThreadTerm's per-project Pi trust choice when a Chat worker opens.
pub type ProjectTrustResolver =
    Arc<dyn Fn(&str, &str) -> Result<Option<String>, ProviderError> + Send + Sync>;

#[derive(Clone, Copy, Default)]
pub(crate) struct ChatToolPolicy {pub delegation:bool,pub preview:bool,pub ask:bool,pub session_info:bool,pub feedback:bool}
pub(crate) fn chat_tool_policy(tools:Option<&ChatToolServer>)->ChatToolPolicy {
    let Some(server)=tools.filter(|s|s.name=="threadterm") else{return ChatToolPolicy::default()};
    let env=|key:&str|server.env.iter().find(|(name,_)|name==key).map(|(_,value)|value.as_str());
    let composed=env("THREADTERM_MCP_PROFILE")==Some("chat-tools");
    ChatToolPolicy {
        delegation: !composed || env("THREADTERM_SESSION_TOKEN").is_some_and(|s|!s.is_empty()),
        preview: composed && env("THREADTERM_PREVIEW_TOKEN").is_some_and(|s|!s.is_empty()),
        ask: composed && env("THREADTERM_CHAT_TOKEN").is_some_and(|s|!s.is_empty()) && env("THREADTERM_CHAT_TOOL_ASK") == Some("1"),
        session_info: composed && env("THREADTERM_CHAT_TOKEN").is_some_and(|s|!s.is_empty()) && env("THREADTERM_CHAT_TOOL_SESSION_INFO") == Some("1"),
        feedback: composed && env("THREADTERM_CHAT_TOKEN").is_some_and(|s|!s.is_empty()) && env("THREADTERM_CHAT_TOOL_FEEDBACK") == Some("1"),
    }
}
pub(crate) fn acp_scoped_permission_option(params:&Value,policy:&ChatToolPolicy)->Option<String> {
    let call=params.get("toolCall")?;let title=call.get("title")?.as_str()?;
    if !is_threadterm_tool(title)
        && !title
            .strip_prefix("mcp__threadterm__")
            .or_else(|| title.strip_prefix("threadterm__"))
            .is_some_and(|tool| crate::preview::TOOL_NAMES.contains(&tool))
    {
        return None;
    }
    let tool=title.strip_prefix("mcp__threadterm__").or_else(||title.strip_prefix("threadterm__"))?;
    let allowed=crate::delegation::TOOL_NAMES.contains(&tool) && policy.delegation
        || tool=="ask_user" && policy.ask
        || tool=="session_info" && policy.session_info
        || tool=="feedback_check" && policy.feedback
        || crate::preview::TOOL_NAMES.contains(&tool) && policy.preview;
    if !allowed||matches!(call.get("kind").and_then(Value::as_str),Some("read"|"edit"|"delete"|"move"|"execute"|"fetch")){return None}
    params.get("options")?.as_array()?.iter().find(|o|o.get("kind").and_then(Value::as_str)==Some("allow_once"))?.get("optionId")?.as_str().map(str::to_owned)
}
pub(crate) fn approve_scoped_threadterm_tool(responder:&Mutex<Option<common::JsonLineResponder>>,raw:&Value,policy:&ChatToolPolicy)->bool {
    if raw.get("method").and_then(Value::as_str)!=Some("session/request_permission"){return false}
    let (Some(id),Some(option))=(raw.get("id"),raw.get("params").and_then(|p|acp_scoped_permission_option(p,policy))) else{return false};
    let Ok(slot)=responder.lock() else{return false};
    slot.as_ref().is_some_and(|r|r.respond(id.clone(),json!({"outcome":{"outcome":"selected","optionId":option}})).is_ok())
}

/// True only for the exact names agents give ThreadTerm's own delegation tools
/// (`mcp__threadterm__<tool>` for Claude and Kimi, `threadterm__<tool>` for
/// Grok). Never a prefix match: a shell command titled with the prefix must
/// still go through normal approval.
pub(crate) fn is_threadterm_tool(name: &str) -> bool {
    name.strip_prefix("mcp__threadterm__")
        .or_else(|| name.strip_prefix("threadterm__"))
        .is_some_and(|tool| crate::delegation::TOOL_NAMES.contains(&tool) || matches!(tool, "ask_user" | "session_info" | "feedback_check"))
}

/// ACP `session/new` / `session/load` `mcpServers` for an optional tool server.
pub(crate) fn acp_mcp_servers(tools: Option<&ChatToolServer>) -> Value {
    match tools {
        None => json!([]),
        Some(tools) => json!([{
            "name": tools.name,
            "command": tools.command,
            "args": tools.args,
            "env": tools.env.iter().map(|(name, value)| json!({"name":name,"value":value})).collect::<Vec<_>>(),
        }]),
    }
}

/// For an ACP `session/request_permission` about one of ThreadTerm's own
/// delegation tools, the once-only allow option to answer with. Requires the
/// exact tool title and a non-file, non-shell tool kind.
#[cfg(test)]
pub(crate) fn acp_threadterm_permission_option(params: &Value) -> Option<String> {
    let call = params.get("toolCall")?;
    let title = call.get("title").and_then(Value::as_str)?;
    let kind = call.get("kind").and_then(Value::as_str);
    if !is_threadterm_tool(title)
        || matches!(kind, Some("read" | "edit" | "delete" | "move" | "execute" | "fetch"))
    {
        return None;
    }
    params
        .get("options")?
        .as_array()?
        .iter()
        .find(|option| option.get("kind").and_then(Value::as_str) == Some("allow_once"))
        .and_then(|option| option.get("optionId").and_then(Value::as_str))
        .map(str::to_owned)
}

pub(crate) struct BuiltinDescriptor {
    pub id: &'static str,
    pub name: &'static str,
    sign_in_args: &'static [&'static str],
}

pub(crate) const BUILTIN_AGENTS: &[BuiltinDescriptor] = &[
    BuiltinDescriptor { id: "codex", name: "Codex", sign_in_args: &["login"] },
    BuiltinDescriptor { id: "claude", name: "Claude Code", sign_in_args: &["auth", "login"] },
    BuiltinDescriptor { id: "kimi", name: "Kimi", sign_in_args: &["login"] },
    BuiltinDescriptor { id: "opencode", name: "OpenCode", sign_in_args: &["providers", "login"] },
    BuiltinDescriptor { id: "grok", name: "Grok", sign_in_args: &[] },
    BuiltinDescriptor { id: "pi", name: "Pi", sign_in_args: &[] },
];

pub(crate) fn builtin_name(id: &str) -> &str {
    BUILTIN_AGENTS.iter().find(|agent| agent.id == id).map(|agent| agent.name).unwrap_or(id)
}

pub(crate) fn builtin_sign_in(id: &str) -> Option<ProviderSignIn> {
    let descriptor = BUILTIN_AGENTS.iter().find(|agent| agent.id == id)?;
    if descriptor.sign_in_args.is_empty() { return None; }
    let spec = common::CommandSpec::provider(id, descriptor.sign_in_args).ok()?;
    Some(ProviderSignIn { executable: spec.program, args: spec.args, display: spec.display })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSignIn {
    pub executable: String,
    pub args: Vec<String>,
    pub display: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatBackgroundTask {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    pub can_stop: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
}

impl ProviderError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn unavailable(provider: &str, message: impl Into<String>) -> Self {
        Self::new("provider_unavailable", message).with_details(json!({"provider": provider}))
    }
}

/// Shown when a steer is rejected because the turn is no longer active.
/// The renderer matches this sentence when the IPC error drops `code`.
pub(crate) const STEER_TURN_ENDED: &str = "The turn ended before the message was inserted";

impl std::fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for ProviderError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEvent {
    pub provider: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub kind: String,
    pub data: Value,
    /// Runtime-only identity of the worker which produced this notification.
    #[serde(skip)]
    pub worker_token: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapability {
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sign_in: Option<ProviderSignIn>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    pub id: String,
    pub name: String,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub terminal: bool,
    pub chat: bool,
    pub history: bool,
    pub resume: bool,
    /// How a provider-native conversation id becomes known for a NEW terminal
    /// session launched by ThreadTerm: "preassigned" (a provider-owned
    /// structured API or provider flag binds the id before PTY launch), or
    /// "none" (terminal resume is unavailable for new sessions). Terminal
    /// output is never treated as identity evidence.
    pub terminal_resume_capture: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// `authenticated`, `unauthenticated`, or `unknown`. This is additive to
    /// the V1 renderer contract and avoids claiming that installation implies
    /// a usable account.
    pub auth: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalCapture {
    PreAssigned,
    None,
}

impl TerminalCapture {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::PreAssigned => "preassigned",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommand {
    pub program: String,
    pub args: Vec<String>,
    pub display: String,
}

/// Durable native identity used by provider readers that run without a live
/// Chat worker. This deliberately contains only the persisted session values
/// needed to locate provider-owned transcript files.
#[derive(Debug, Clone)]
pub(crate) struct NativeSessionRef {
    pub(crate) native_id: String,
    pub(crate) cwd: String,
}

pub trait ProviderRuntime: Send + Sync {
    fn capabilities(&self) -> Vec<Value>;
    fn terminal_command(
        &self,
        provider: &str,
        resume_id: Option<&str>,
        assign_id: Option<&str>,
    ) -> Result<Value, ProviderError>;
    fn history_list(
        &self,
        provider: &str,
        cursor: Option<&str>,
        limit: u32,
        cwd: Option<&str>,
    ) -> Result<Value, ProviderError>;
    fn history_read(&self, provider: &str, native_id: &str) -> Result<Value, ProviderError>;
    fn chat_open(
        &self,
        session_id: &str,
        provider: &str,
        cwd: &str,
        native_id: Option<&str>,
    ) -> Result<Value, ProviderError>;
    fn chat_send(
        &self,
        session_id: &str,
        text: &str,
        operation_id: &str,
    ) -> Result<Value, ProviderError>;
    fn chat_cancel(&self, session_id: &str, turn_id: &str) -> Result<(), ProviderError>;
    fn chat_approve(
        &self,
        session_id: &str,
        turn_id: &str,
        approval_id: &str,
        choice_id: &str,
        operation_id: &str,
    ) -> Result<(), ProviderError>;
    fn chat_stop(&self, session_id: &str) -> Result<(), ProviderError>;
    fn chat_answer(
        &self,
        session_id: &str,
        turn_id: &str,
        approval_id: &str,
        response: &Value,
        operation_id: &str,
    ) -> Result<(), ProviderError>;
    fn chat_options(&self, session_id: &str) -> Result<Value, ProviderError>;
    fn chat_background_tasks(&self, session_id: &str) -> Result<Value, ProviderError>;
    fn chat_background_task_stop(
        &self,
        session_id: &str,
        task_id: &str,
    ) -> Result<bool, ProviderError>;
    fn chat_connection(&self, session_id: &str) -> Value;
    fn chat_set_option(
        &self,
        session_id: &str,
        option_id: &str,
        value: &str,
    ) -> Result<Value, ProviderError>;
    fn subscribe(&self) -> broadcast::Receiver<ProviderEvent>;
}

pub(crate) trait ProviderAdapter: Send + Sync {
    fn id(&self) -> &str;
    fn capability(&self) -> ProviderCapability;
    /// Builds the PTY launch command. `resume_id` continues an existing native
    /// conversation; `assign_id` identifies a NEW conversation, either prepared
    /// through a provider API or assigned through a native CLI flag. Providers
    /// without pre-assignment support ignore `assign_id`; passing both is a
    /// caller bug and rejected.
    fn terminal_command(
        &self,
        resume_id: Option<&str>,
        assign_id: Option<&str>,
    ) -> Result<TerminalCommand, ProviderError>;
    /// How a native conversation id becomes known for new terminal sessions.
    fn terminal_capture(&self) -> TerminalCapture {
        TerminalCapture::None
    }
    /// Creates the native conversation identity for a new terminal session
    /// through a provider-owned structured API. Providers without a verified
    /// pre-assignment channel must return `None`; terminal output is never an
    /// authoritative identity source.
    fn prepare_terminal(&self, _cwd: &str) -> Result<Option<String>, ProviderError> {
        Ok(None)
    }
    /// Fork provider-owned history without opening or mutating the source
    /// worker. `None` means the adapter has no native fork for this point.
    fn fork_session(
        &self,
        _cwd: &str,
        _native_id: &str,
        _anchor: Option<&crate::domain::NativeForkAnchor>,
        _is_latest: bool,
    ) -> Result<Option<String>, ProviderError> {
        Ok(None)
    }
    /// Read-only provider validation before reserving a terminal resume. Must
    /// not create history, change identity, or submit a model/tool request.
    fn preflight_terminal_resume(&self, _cwd: &str, _native_id: &str) -> Result<(), ProviderError> {
        Ok(())
    }
    fn history_list(
        &self,
        cursor: Option<&str>,
        limit: u32,
        cwd: Option<&str>,
    ) -> Result<Value, ProviderError>;
    fn history_read(&self, native_id: &str) -> Result<Value, ProviderError>;
    fn subagent_transcript(
        &self,
        _session: &NativeSessionRef,
        _info: &Value,
    ) -> Result<Vec<Value>, ProviderError> {
        Err(ProviderError::new(
            "unsupported",
            "This agent does not expose subagent transcripts",
        ))
    }
    fn open_chat(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError>;

    fn scopes_chat_events(&self) -> bool {
        false
    }

    fn open_chat_scoped(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
        _worker_token: &str,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        self.open_chat(session_id, cwd, native_id)
    }

    /// Opens a Chat with an optional session-bound tool server. Adapters that
    /// cannot inject one keep this default and ignore `tools`.
    fn open_chat_with_tools(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
        worker_token: &str,
        tools: Option<&ChatToolServer>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        let _ = tools;
        self.open_chat_scoped(session_id, cwd, native_id, worker_token)
    }

    /// Opens a Chat with the ThreadTerm-owned, per-project Pi trust decision.
    /// Other adapters deliberately ignore this additive argument.
    fn open_chat_with_project_trust(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
        worker_token: &str,
        tools: Option<&ChatToolServer>,
        _decision: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        self.open_chat_with_tools(session_id, cwd, native_id, worker_token, tools)
    }
}

pub(crate) trait ChatSession: Send {
    fn native_id(&self) -> Option<String>;
    fn is_alive(&self) -> bool {
        true
    }
    /// Side-effect-free rejection before a user turn is durably recorded.
    fn validate_send(&self, _text: &str) -> Result<(), ProviderError> {
        Ok(())
    }
    /// Side-effect-free admission check before replacing an idle Chat worker.
    fn validate_restart(&self) -> Result<(), ProviderError> {
        self.validate_send("")
    }
    /// Side-effect-free validation before a user turn is durably recorded.
    /// Providers that do not opt in reject image inputs without changing their
    /// existing adapter implementation.
    fn validate_images(&self, images: &[String]) -> Result<(), ProviderError> {
        if images.is_empty() {
            Ok(())
        } else {
            Err(ProviderError::new(
                "images_unsupported",
                "This provider does not support chat images. / 此 Provider 不支持聊天图片。",
            ))
        }
    }
    fn validate_send_with_images(
        &self,
        text: &str,
        images: &[String],
    ) -> Result<(), ProviderError> {
        let _ = text;
        self.validate_images(images)
    }
    fn send_with_images(
        &mut self,
        text: &str,
        images: &[String],
        operation_id: &str,
    ) -> Result<Value, ProviderError> {
        self.validate_images(images)?;
        self.send(text, operation_id)
    }
    fn send(&mut self, text: &str, operation_id: &str) -> Result<Value, ProviderError>;
    /// Side-effect-free rejection before a steered row is recorded. Adapters
    /// that cannot steer fail here, so nothing is persisted for them.
    fn validate_steer(&self, _text: &str, _images: &[String]) -> Result<(), ProviderError> {
        Err(ProviderError::new(
            "steer_unsupported",
            "This provider does not support steering into the current turn. / 此 Provider 不支持插入当前回合。",
        ))
    }
    /// Confirms the requested turn is still active. Adapters that only learn
    /// that from the provider leave this successful and return `turn_changed`
    /// from `steer` when the provider rejects the insert.
    fn steer_turn_ready(&self, _turn_id: &str) -> Result<(), ProviderError> {
        Ok(())
    }
    fn steer(
        &mut self,
        _turn_id: &str,
        _text: &str,
        _images: &[String],
        _operation_id: &str,
    ) -> Result<Value, ProviderError> {
        Err(ProviderError::new(
            "steer_unsupported",
            "This provider does not support steering into the current turn. / 此 Provider 不支持插入当前回合。",
        ))
    }
    fn cancel(&mut self, turn_id: &str) -> Result<(), ProviderError>;
    fn approve(
        &mut self,
        turn_id: &str,
        approval_id: &str,
        choice_id: &str,
        operation_id: &str,
    ) -> Result<(), ProviderError>;
    fn stop(&mut self) -> Result<(), ProviderError>;
    /// Held transcript items must commit before the worker token is retired.
    /// Return a snapshot so a failed database write can be retried safely.
    fn retirement_events(&self) -> Vec<ProviderEvent> { Vec::new() }
    fn prepare_retirement(&mut self, persist: &dyn Fn(&ProviderEvent) -> Result<(), ProviderError>) -> Result<(), ProviderError> {
        for event in &self.retirement_events() { persist(event)?; }
        Ok(())
    }
    /// Native decisions can have a terminal partial outcome (for example an
    /// approved plan whose mode switch failed). Persist that exact receipt.
    fn plan_response_receipt(&self) -> Option<Value> { None }
    /// Native plan decisions return no prompt; runtime-owned plans may request
    /// a normal, durably recorded implementation turn through the service.
    fn plan_response(&mut self, _turn_id: &str, _approval_id: &str, _response: &Value, _operation_id: &str) -> Result<Option<String>, ProviderError> {
        Err(ProviderError::new("plan_unsupported", "This provider has no plan approval"))
    }
    fn answer(
        &mut self,
        _turn_id: &str,
        _approval_id: &str,
        _response: &Value,
        _operation_id: &str,
    ) -> Result<(), ProviderError> {
        Err(ProviderError::new("answer_unsupported", "This provider does not support question answers"))
    }
    fn ui_state(&self) -> Value {
        json!({"options":[],"commands":[]})
    }
    fn background_tasks(&mut self) -> Result<Vec<ChatBackgroundTask>, ProviderError> {
        Ok(Vec::new())
    }
    fn stop_background_task(&mut self, _task_id: &str) -> Result<bool, ProviderError> {
        Err(ProviderError::new(
            "background_task_stop_unsupported",
            "This provider cannot stop background tasks",
        ))
    }
    fn set_option(&mut self, _option_id: &str, _value: &str) -> Result<Value, ProviderError> {
        Err(ProviderError::new(
            "chat_options_unsupported",
            "This provider does not expose live model options",
        ))
    }
}

type SharedChat = Arc<Mutex<Box<dyn ChatSession>>>;

pub(crate) struct PlanResponseRequest<'a> {
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub approval_id: &'a str,
    pub response: &'a Value,
    pub operation_id: &'a str,
    pub implementation_id: &'a str,
}

/// Normalizes the complete UI snapshot shared by `chat.options` and `chat.ui`.
pub(crate) fn normalize_chat_ui(value: Value) -> Value {
    let mut options = value
        .get("options")
        .filter(|value| value.is_array())
        .cloned()
        .unwrap_or_else(|| json!([]));
    enrich_chat_options(&mut options);
    let commands = value
        .get("commands")
        .filter(|value| value.is_array())
        .cloned()
        .unwrap_or_else(|| json!([]));
    let background_tasks = value
        .get("backgroundTasks")
        .filter(|value| value.is_array())
        .and_then(Value::as_array)
        .map(|tasks| {
            tasks
                .iter()
                .filter_map(|task| serde_json::from_value::<ChatBackgroundTask>(task.clone()).ok())
                .filter(|task| {
                    !task.id.trim().is_empty()
                        && !task.title.trim().is_empty()
                        && matches!(task.status.as_str(), "running" | "completed" | "failed" | "stopped")
                        && (task.status == "running" || !task.can_stop)
                })
                .collect::<Vec<_>>()
        })
        .and_then(|tasks| serde_json::to_value(tasks).ok())
        .unwrap_or_else(|| json!([]));
    let input_capabilities = value
        .get("inputCapabilities")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let load_state = value.get("loadState").cloned().unwrap_or_else(|| {
        json!(if options.as_array().is_some_and(Vec::is_empty) {
            "empty"
        } else {
            "ready"
        })
    });
    let mut normalized = json!({
        "options": options,
        "commands": commands,
        "backgroundTasks": background_tasks,
        "inputCapabilities": input_capabilities,
        "loadState": load_state,
    });
    if let Some(error) = value.get("error") {
        normalized["error"] = error.clone();
    }
    if let Some(trust) = normalized_pi_trust(value.get("piTrust")) {
        normalized["piTrust"] = trust;
    }
    // Skills stay absent unless the adapter can tell them apart (E3); a
    // malformed row is dropped rather than shown as an invocable skill.
    if let Some(skills) = value.get("skills").and_then(Value::as_array) {
        let valid = |skill: &&Value| {
            let text = |key: &str| skill.get(key).and_then(Value::as_str).filter(|value| !value.trim().is_empty());
            text("name").is_some_and(|name| !name.chars().any(char::is_whitespace))
                && text("invocation").is_some()
                && skill.get("description").is_none_or(Value::is_string)
        };
        normalized["skills"] = Value::Array(skills.iter().filter(valid).cloned().collect());
    }
    normalized
}

fn option_category(id: &str) -> &'static str {
    let lower = id.to_ascii_lowercase();
    if lower.contains("model") {
        "model"
    } else if lower.contains("think") || lower.contains("reason") {
        "thinking"
    } else if lower.contains("mode") {
        "mode"
    } else {
        "other"
    }
}

/// Additive option metadata (task 10-11-chat-parity C1). Every option carries a
/// `category`; a model choice carries a `group` when its value has a provider
/// prefix; a choice marked `recommended` also names the option's recommended
/// value. Adapters may set any of these themselves - the runtime fills only what
/// is missing, so adapters that do not describe their options keep working.
fn enrich_chat_options(options: &mut Value) {
    let Some(rows) = options.as_array_mut() else {
        return;
    };
    for option in rows.iter_mut() {
        let Some(object) = option.as_object_mut() else {
            continue;
        };
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if !object.contains_key("category") {
            object.insert("category".into(), json!(option_category(&id)));
        }
        let Some(choices) = object.get_mut("choices").and_then(Value::as_array_mut) else {
            continue;
        };
        let mut recommended_value: Option<String> = None;
        for choice in choices.iter_mut() {
            let Some(choice) = choice.as_object_mut() else {
                continue;
            };
            let value = choice
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if !choice.contains_key("group") {
                if let Some((group, rest)) = value.split_once('/') {
                    if !group.is_empty() && !rest.is_empty() {
                        choice.insert("group".into(), json!(group));
                    }
                }
            }
            if choice.get("recommended").and_then(Value::as_bool) == Some(true) {
                recommended_value = Some(value);
            }
        }
        if !object.contains_key("recommended") {
            if let Some(value) = recommended_value {
                object.insert("recommended".into(), json!(value));
            }
        }
    }
}

fn normalized_pi_trust(value: Option<&Value>) -> Option<Value> {
    let value = value?.as_object()?;
    let enum_value = |key: &str, allowed: &[&str]| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|candidate| allowed.contains(candidate))
    };
    let protected = value.get("protectedResources")?.as_array()?;
    if !protected.iter().all(Value::is_string) {
        return None;
    }
    let pi_decision = enum_value("piDecision", &["trusted", "declined", "none"])?;
    let default_trust = enum_value("defaultProjectTrust", &["always", "ask", "never"])?;
    let threadterm_decision = enum_value("threadtermDecision", &["trusted", "declined", "none"])?;
    let effective = enum_value("effective", &["loaded", "skipped"])?;
    let mut normalized = json!({
        "protectedResources": protected,
        "piDecision": pi_decision,
        "defaultProjectTrust": default_trust,
        "threadtermDecision": threadterm_decision,
        "effective": effective,
    });
    if let Some(outside) = value.get("outsideProtectedResources") {
        let outside = outside.as_array()?;
        if !outside.iter().all(|entry| entry.get("path").is_some_and(Value::is_string)
            && entry.get("target").is_some_and(Value::is_string)) { return None; }
        normalized["outsideProtectedResources"] = json!(outside);
    }
    Some(normalized)
}

struct ChatSlot {
    generation: u64,
    revision: u64,
    phase: &'static str,
    native_id: Option<String>,
    error: Option<Value>,
    worker: Option<SharedChat>,
    connecting: bool,
    worker_token: Option<String>,
    requires_scoped_events: bool,
}

impl ChatSlot {
    fn new() -> Self {
        Self {
            generation: 0,
            revision: 0,
            phase: "disconnected",
            native_id: None,
            error: None,
            worker: None,
            connecting: false,
            worker_token: None,
            requires_scoped_events: false,
        }
    }

    fn worker_alive(&self) -> bool {
        self.worker
            .as_ref()
            .and_then(|worker| worker.lock().ok().map(|chat| chat.is_alive()))
            .unwrap_or(false)
    }

    fn mark_disconnected(&mut self) -> Option<SharedChat> {
        let retired = self.worker.take();
        self.connecting = false;
        if self.phase != "failed" && self.phase != "unavailable" {
            self.phase = "disconnected";
        }
        self.generation = self.generation.saturating_add(1);
        self.revision = self.revision.saturating_add(1);
        retired
    }

    fn wire(
        &self,
        session_id: &str,
        options_load_state: &str,
        options_error: Option<Value>,
    ) -> Value {
        let mut value = json!({
            "sessionId": session_id,
            "connectionGeneration": self.generation,
            "revision": self.revision,
            "phase": self.phase,
            "optionsLoadState": options_load_state,
        });
        if let Some(native_id) = &self.native_id {
            value["nativeId"] = json!(native_id);
        }
        if let Some(error) = &self.error {
            value["error"] = error.clone();
        }
        if let Some(error) = options_error {
            value["optionsError"] = error;
        }
        value
    }
}

pub struct Providers {
    adapters: RwLock<HashMap<String, Arc<dyn ProviderAdapter>>>,
    plugins: RwLock<Option<crate::plugins::PluginRegistry>>,
    chats: Mutex<HashMap<String, ChatSlot>>,
    connect_wait: Condvar,
    capability_cache: Arc<Mutex<CapabilityCache>>,
    capability_wait: Arc<Condvar>,
    events: ProviderEventSender,
    projection_events: Mutex<Option<ProjectionReceiver>>,
    network: network::NetworkSettings,
    tool_servers: RwLock<Option<ToolServerResolver>>,
    project_trust: RwLock<Option<ProjectTrustResolver>>,
    retirement_projector: RwLock<Option<RetirementProjector>>,
    #[cfg(test)]
    probe_spawn_should_fail: std::sync::atomic::AtomicBool,
}

type RetirementProjector = Arc<dyn Fn(&ProviderEvent) -> Result<(), ProviderError> + Send + Sync>;

/// Completion of one provider capability probe round, published to the listener
/// installed by the runtime service.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CapabilityUpdate {
    /// Set only when the round was started by `request_capability_refresh`.
    pub refresh_id: Option<u64>,
    /// `"ok"` or `"failed"`.
    pub outcome: &'static str,
}

/// Last provider capability probe. Probing runs every provider CLI and takes
/// seconds, while `runtime.snapshot`/`provider.list` share the ordered request
/// lane with `chat.send`. Cold UI reads get an empty pending list; admission
/// readers wait for confirmed values from the same background job.
///
/// Successful values never expire: a read returns them until something
/// invalidates the cache (a plugin rebuild or an explicit refresh). A failed
/// cold probe is remembered, so later reads never retry on their own.
#[derive(Default)]
struct CapabilityCache {
    values: Option<(Instant, Vec<Value>)>,
    /// The generation of the probe currently running, if any. A completion only
    /// clears this when its own generation is still current.
    refreshing: Option<u64>,
    /// Newest claimed generation. A completion for an older generation is
    /// discarded instead of overwriting newer values.
    generation: u64,
    /// The generation claimed by the last forced refresh, until it completes.
    manual_request: Option<u64>,
    on_updated: Option<Arc<dyn Fn(CapabilityUpdate) + Send + Sync>>,
    /// A failed cold probe. Kept until an explicit refresh or plugin rebuild.
    failed_at: Option<Instant>,
}

impl CapabilityCache {
    /// Claims a new generation and marks it refreshing. Every probe start goes
    /// through here so a completion can tell whether it is still current.
    fn start_probe_locked(&mut self) -> u64 {
        self.generation += 1;
        let generation = self.generation;
        self.refreshing = Some(generation);
        generation
    }
}

fn probe_capabilities(adapters: &[Arc<dyn ProviderAdapter>]) -> Vec<Value> {
    adapters
        .iter()
        .filter_map(|adapter| serde_json::to_value(adapter.capability()).ok())
        .collect()
}

impl Providers {
    /// Revoke a project decision only after every matching worker is idle.
    /// Registry admission and all captured send handles are fenced together.
    pub(crate) fn restart_idle_project_chats(
        &self,
        selected: &str,
        belongs: impl Fn(&str) -> anyhow::Result<bool>,
        before_stop: impl FnOnce(&[String]) -> anyhow::Result<()>,
    ) -> Result<Vec<String>, ProviderError> {
        let mut chats = self.chats.lock().map_err(|_| ProviderError::new("provider_internal", "provider chat lock poisoned"))?;
        let mut ids = Vec::new();
        for (id, slot) in chats.iter() {
            if !belongs(id).map_err(|error| ProviderError::new("chat_persistence", error.to_string()))? { continue; }
            if slot.connecting {
                return Err(ProviderError::new("turn_in_progress", "Wait for all Pi chats in this project to finish connecting before revoking trust."));
            }
            if slot.worker.is_some() { ids.push(id.clone()); }
        }
        if !ids.iter().any(|id| id == selected) {
            return Err(ProviderError::new("chat_not_open", "Open the selected Pi chat before changing project trust."));
        }
        ids.sort();
        let handles: Vec<_> = ids.iter().map(|id| chats[id].worker.as_ref().unwrap().clone()).collect();
        let mut workers = Vec::new();
        for handle in &handles {
            let worker = handle.try_lock().map_err(|_| ProviderError::new("turn_in_progress", "Stop the active turns in every Pi chat in this project before revoking trust."))?;
            worker.validate_restart().map_err(|error| ProviderError::new(error.code, "Stop the active turns in every Pi chat in this project before revoking trust."))?;
            workers.push(worker);
        }
        before_stop(&ids).map_err(|error| ProviderError::new("project_trust_persist_failed", error.to_string()))?;
        let mut states = Vec::new();
        for id in &ids {
            let slot = chats.get_mut(id).unwrap();
            slot.worker_token = None;
            let _ = slot.mark_disconnected();
            states.push((id.clone(), slot.wire(id, "unknown", None)));
        }
        drop(chats);
        self.connect_wait.notify_all();
        for (id, state) in states { self.emit_connection(&id, state); }
        let mut failure = None;
        for worker in &mut workers {
            if let Err(error) = worker.stop() { failure.get_or_insert(error); }
        }
        if let Some(error) = failure { return Err(error); }
        Ok(ids)
    }

    /// Persists a decision and retires an idle worker without waiting under
    /// the shared registry lock. Captured old sends are fenced by stop().
    pub(crate) fn restart_idle_chat(
        &self,
        session_id: &str,
        before_stop: impl FnOnce() -> anyhow::Result<()>,
    ) -> Result<Value, ProviderError> {
        let mut chats = self
            .chats
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "provider chat lock poisoned"))?;
        let slot = chats.get_mut(session_id).ok_or_else(|| {
            ProviderError::new(
                "chat_not_open",
                format!("no provider Chat worker is open for session {session_id}"),
            )
        })?;
        let worker = slot.worker.clone().ok_or_else(|| {
            ProviderError::new(
                "chat_not_open",
                format!("no provider Chat worker is open for session {session_id}"),
            )
        })?;
        // Never wait for a captured sender while holding the global registry.
        // The sender itself may need that registry to publish its completion.
        let mut worker = match worker.try_lock() {
            Ok(worker) => worker,
            Err(std::sync::TryLockError::WouldBlock) => {
                return Err(ProviderError::new(
                    "turn_in_progress",
                    "the Pi chat still has an active turn",
                ));
            }
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err(ProviderError::new(
                    "provider_internal",
                    "session worker lock poisoned",
                ));
            }
        };
        worker.validate_restart()?;
        self.persist_retirement(worker.as_mut())?;
        before_stop().map_err(|error| {
            ProviderError::new("project_trust_persist_failed", error.to_string())
        })?;

        // The new generation rejects stale scoped events before the old native
        // process is stopped. Clear its token so unscoped old events cannot
        // claim the replacement slot either.
        slot.worker_token = None;
        let _retired = slot.mark_disconnected();
        let state = slot.wire(session_id, "unknown", None);
        drop(chats);
        self.connect_wait.notify_all();
        self.emit_connection(session_id, state.clone());
        worker.stop()?;
        Ok(state)
    }


    /// Nonblocking provider information for snapshots and settings UI.
    /// An empty cold result means detection is pending, not uninstalled.
    /// Successful values are returned as-is; only a cold, unfailed, idle cache
    /// starts the shared probe.
    pub(crate) fn capability_snapshot(&self) -> Vec<Value> {
        let mut start = None;
        let values = {
            let Ok(mut cache) = self.capability_cache.lock() else { return Vec::new() };
            let values = cache.values.as_ref().map(|(_, values)| values.clone()).unwrap_or_default();
            if cache.values.is_none() && cache.failed_at.is_none() && cache.refreshing.is_none() {
                start = Some(cache.start_probe_locked());
            }
            values
        };
        if let Some(generation) = start {
            let adapters = self.supported_adapters();
            self.spawn_capability_probe(generation, adapters);
        }
        values
    }

    /// UI reads expose a real failed cold probe instead of indefinite pending.
    pub(crate) fn capability_snapshot_result(&self) -> Result<Vec<Value>, ProviderError> {
        let values = self.capability_snapshot();
        let cache = self.capability_cache.lock().map_err(|_| {
            ProviderError::new("provider_detection_failed", "Provider detection cache is unavailable.")
        })?;
        if cache.values.is_none() && cache.failed_at.is_some() {
            return Err(ProviderError::new("provider_detection_failed",
                "Provider detection failed. Use Refresh provider status in Settings, or reload the provider plugins."));
        }
        Ok(values)
    }

    /// Forces one fresh capability round and returns its refresh id. The current
    /// values stay visible and a failed refresh keeps them. The probe runs on a
    /// worker thread, so this returns before detection completes.
    pub(crate) fn request_capability_refresh(&self) -> u64 {
        let generation = {
            let Ok(mut cache) = self.capability_cache.lock() else { return 0 };
            cache.failed_at = None;
            let generation = cache.start_probe_locked();
            cache.manual_request = Some(generation);
            generation
        };
        let adapters = self.supported_adapters();
        self.spawn_capability_probe(generation, adapters);
        generation
    }

    /// Runs one claimed capability round on a worker thread. Only a completion
    /// whose generation is still current writes values, clears `refreshing` and
    /// reaches the listener; an obsolete round just wakes waiters.
    fn spawn_capability_probe(&self, generation: u64, adapters: Vec<Arc<dyn ProviderAdapter>>) {
        let shared = Arc::clone(&self.capability_cache);
        let wait = Arc::clone(&self.capability_wait);
        #[cfg(test)]
        let forced_failure = self.probe_spawn_should_fail.swap(false, std::sync::atomic::Ordering::SeqCst);
        #[cfg(not(test))]
        let forced_failure = false;
        let spawned = if forced_failure {
            Err(std::io::Error::new(std::io::ErrorKind::Other, "forced capability probe spawn failure"))
        } else {
            std::thread::Builder::new()
                .name("provider-capabilities".into())
                .spawn(move || {
                    let fresh = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| probe_capabilities(&adapters)));
                    let outcome_ok = fresh.is_ok();
                    let notification = if let Ok(mut cache) = shared.lock() {
                        if cache.generation == generation {
                            cache.refreshing = None;
                            match fresh {
                                Ok(values) => {
                                    cache.values = Some((Instant::now(), values));
                                    cache.failed_at = None;
                                }
                                Err(_) => { cache.failed_at = Some(Instant::now()); }
                            }
                            let refresh_id = (cache.manual_request == Some(generation)).then_some(generation);
                            if refresh_id.is_some() { cache.manual_request = None; }
                            cache.on_updated.clone().map(|notify| (notify, refresh_id))
                        } else { None }
                    } else { None };
                    wait.notify_all();
                    // Notification can re-enter snapshot: release the cache first.
                    if let Some((notify, refresh_id)) = notification {
                        notify(CapabilityUpdate { refresh_id, outcome: if outcome_ok { "ok" } else { "failed" } });
                    }
                })
        };
        if spawned.is_err() {
            let notification = if let Ok(mut cache) = self.capability_cache.lock() {
                if cache.generation == generation {
                    cache.refreshing = None;
                    cache.failed_at = Some(Instant::now());
                    let refresh_id = (cache.manual_request == Some(generation)).then_some(generation);
                    if refresh_id.is_some() { cache.manual_request = None; }
                    cache.on_updated.clone().map(|notify| (notify, refresh_id))
                } else { None }
            } else { None };
            self.capability_wait.notify_all();
            if let Some((notify, refresh_id)) = notification {
                notify(CapabilityUpdate { refresh_id, outcome: "failed" });
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn fail_next_probe_spawn(&self) {
        self.probe_spawn_should_fail.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub(crate) fn set_capability_listener(&self, listener: Arc<dyn Fn(CapabilityUpdate) + Send + Sync>) {
        if let Ok(mut cache) = self.capability_cache.lock() {
            cache.on_updated = Some(listener);
        }
    }

    fn confirmed_capabilities(&self, mut generation: u64) -> Vec<Value> {
        let Ok(mut cache) = self.capability_cache.lock() else { return Vec::new() };
        loop {
            if let Some((_, values)) = cache.values.as_ref() { return values.clone(); }
            if cache.refreshing.is_some() {
                let Ok(next) = self.capability_wait.wait(cache) else { return Vec::new() };
                cache = next;
            } else if cache.generation != generation {
                // Invalidation can run between the pending snapshot and this
                // lock acquisition, or while waiting. Start its current job.
                generation = cache.generation;
                drop(cache);
                self.capability_snapshot();
                let Ok(next) = self.capability_cache.lock() else { return Vec::new() };
                cache = next;
            } else {
                // This generation failed to start or its adapter panicked.
                // A later explicit read can retry without a busy retry loop.
                return Vec::new();
            }
        }
    }

    pub fn new() -> Self {
        let providers = Self::native(&std::env::temp_dir());
        providers.rebuild_plugins(crate::plugins::PluginRegistry::bundled());
        providers
    }

    fn native(spool_dir: &std::path::Path) -> Self {
        let (events, projection_events) = provider_events::channel(spool_dir);
        let network = network::NetworkSettings::default();
        let adapters: Vec<Arc<dyn ProviderAdapter>> = vec![
            Arc::new(codex::CodexAdapter::new(events.clone())),
            Arc::new(claude::ClaudeAdapter::new(events.clone())),
            Arc::new(acp::AcpAdapter::kimi(events.clone())),
            Arc::new(opencode::OpenCodeAdapter::new(events.clone())),
            Arc::new(grok::GrokAdapter::new(events.clone(), network.clone())),
            Arc::new(pi::PiAdapter::new(events.clone())),
        ];
        Self::from_adapters(events, projection_events, adapters, network)
    }

    pub fn with_plugins(data_dir: &std::path::Path, settings: &Value) -> Self {
        let providers = Self::native(data_dir);
        providers.rebuild_plugins(crate::plugins::PluginRegistry::discover(data_dir, settings));
        providers
    }

    pub(crate) fn rebuild_plugins(&self, registry: crate::plugins::PluginRegistry) {
        let plugins = registry.agents.iter().cloned().map(|descriptor| {
            let id = descriptor.id.clone();
            let adapter: Arc<dyn ProviderAdapter> = if descriptor.chat_args.is_some() {
                Arc::new(acp::AcpAdapter::from_descriptor(descriptor, self.events.clone()))
            } else {
                Arc::new(crate::plugins::ManifestTerminalAdapter::new(descriptor))
            };
            (id, adapter)
        }).collect::<Vec<_>>();
        if let Ok(mut adapters) = self.adapters.write() {
            adapters.retain(|id, _| BUILTIN_AGENTS.iter().any(|agent| agent.id == id));
            adapters.extend(plugins);
        }
        if let Ok(mut current) = self.plugins.write() { *current = Some(registry); }
        self.refresh_capabilities();
    }

    pub(crate) fn plugin_registry(&self) -> Option<crate::plugins::PluginRegistry> {
        self.plugins.read().ok()?.clone()
    }

    pub(crate) fn plugin_list(&self) -> Option<crate::plugins::PluginList> {
        self.plugins.read().ok()?.as_ref().map(|registry| registry.list.clone())
    }

    pub(crate) fn contains(&self, provider: &str) -> bool {
        self.adapters.read().is_ok_and(|adapters| adapters.contains_key(provider))
    }

    pub(crate) fn require_agent(&self, provider: &str) -> Result<(), ProviderError> {
        self.adapter(provider).map(|_| ())
    }

    #[cfg(test)]
    pub(crate) fn registered_ids(&self) -> Vec<String> {
        self.supported_adapters().iter().map(|adapter| adapter.id().to_owned()).collect()
    }

    fn from_adapters(
        events: ProviderEventSender,
        projection_events: ProjectionReceiver,
        adapters: Vec<Arc<dyn ProviderAdapter>>,
        network: network::NetworkSettings,
    ) -> Self {
        Self {
            adapters: RwLock::new(adapters
                .into_iter()
                .map(|adapter| (adapter.id().to_owned(), adapter))
                .collect()),
            plugins: RwLock::new(None),
            chats: Mutex::new(HashMap::new()),
            connect_wait: Condvar::new(),
            capability_cache: Arc::new(Mutex::new(CapabilityCache::default())),
            capability_wait: Arc::new(Condvar::new()),
            events,
            projection_events: Mutex::new(Some(projection_events)),
            network,
            tool_servers: RwLock::new(None),
            project_trust: RwLock::new(None),
            retirement_projector: RwLock::new(None),
            #[cfg(test)]
            probe_spawn_should_fail: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Installed once by the runtime service; consulted on every Chat open.
    pub fn set_tool_server_resolver(&self, resolver: ToolServerResolver) {
        if let Ok(mut slot) = self.tool_servers.write() {
            *slot = Some(resolver);
        }
    }

    /// Installed once by the runtime service; read only while opening a Chat.
    pub fn set_project_trust_resolver(&self, resolver: ProjectTrustResolver) {
        if let Ok(mut slot) = self.project_trust.write() {
            *slot = Some(resolver);
        }
    }

    pub(crate) fn set_retirement_projector(&self, projector: RetirementProjector) {
        if let Ok(mut slot) = self.retirement_projector.write() { *slot = Some(projector); }
    }

    /// Called with the registry and old worker locked, before token invalidation.
    fn persist_retirement(&self, worker: &mut dyn ChatSession) -> Result<(), ProviderError> {
        let projector = self.retirement_projector.read().ok().and_then(|slot| slot.clone())
            .unwrap_or_else(|| Arc::new(|_| Err(ProviderError::new("chat_persistence", "Held transcript items cannot be persisted"))));
        worker.prepare_retirement(projector.as_ref())
    }

    fn tool_server(&self, session_id: &str, provider: &str) -> Option<ChatToolServer> {
        let resolver = self.tool_servers.read().ok()?.clone()?;
        resolver(session_id, provider)
    }

    fn project_trust(
        &self,
        session_id: &str,
        provider: &str,
    ) -> Result<Option<String>, ProviderError> {
        let resolver = self
            .project_trust
            .read()
            .map_err(|_| {
                ProviderError::new("provider_internal", "project trust resolver lock poisoned")
            })?
            .clone();
        resolver
            .map(|resolve| resolve(session_id, provider))
            .transpose()
            .map(Option::flatten)
    }

    #[cfg(test)]
    pub(crate) fn for_test(adapters: Vec<Arc<dyn ProviderAdapter>>) -> Self {
        let (events, projection_events) = provider_events::channel(&std::env::temp_dir());
        Self::from_adapters(
            events,
            projection_events,
            adapters,
            network::NetworkSettings::default(),
        )
    }

    /// Takes the sole reliable projection receiver. Broadcast subscribers are
    /// observation taps and may lag without affecting this queue.
    pub(crate) fn take_projection_events(&self) -> Option<ProjectionReceiver> {
        self.projection_events.lock().ok()?.take()
    }

    pub fn configure_network(&self, settings: &Value) -> Result<(), ProviderError> {
        self.network.update(settings)
    }

    /// Invalidates executable/auth probes after a plugin install, removal or
    /// reload. Values are cleared and the next read starts the shared probe;
    /// any round already running is discarded by the generation bump.
    pub fn refresh_capabilities(&self) {
        if let Ok(mut cache) = self.capability_cache.lock() {
            cache.values = None;
            cache.refreshing = None;
            cache.failed_at = None;
            cache.manual_request = None;
            cache.generation += 1;
        }
        self.capability_wait.notify_all();
    }

    fn supported_adapters(&self) -> Vec<Arc<dyn ProviderAdapter>> {
        let mut adapters = self.adapters.read().map(|adapters| adapters.values().cloned().collect::<Vec<_>>()).unwrap_or_default();
        adapters.sort_by_key(|adapter| {
            let id = adapter.id();
            let order = match id {
                "codex" => 0, "claude" => 1, "kimi" => 2, "gemini" => 3,
                "opencode" => 4, "grok" => 5, _ => 6,
            };
            (order, id.to_owned())
        });
        adapters
    }

    fn adapter(&self, provider: &str) -> Result<Arc<dyn ProviderAdapter>, ProviderError> {
        if let Some(adapter) = self.adapters.read().map_err(|_| ProviderError::new("provider_internal", "agent registry lock poisoned"))?.get(provider).cloned() {
            return Ok(adapter);
        }
        let plugin = self.plugins.read().ok().and_then(|registry| {
            registry.as_ref()?.list.plugins.iter().find(|plugin| plugin.agents.iter().any(|agent| agent.id == provider)).map(|plugin| plugin.id.clone())
        });
        Err(ProviderError::new("unsupported_provider", match plugin {
            Some(plugin) => format!("Agent {provider} is unavailable. Enable plugin {plugin} in Settings → Plugins and resolve any listed issues."),
            None => format!("Unknown agent {provider}; no enabled adapter is registered"),
        }))
    }

    /// How a provider's native conversation id becomes known for a new
    /// terminal session. Unknown providers cannot capture one.
    pub(crate) fn terminal_capture(&self, provider: &str) -> TerminalCapture {
        self.adapter(provider)
            .map(|adapter| adapter.terminal_capture())
            .unwrap_or(TerminalCapture::None)
    }

    pub(crate) fn prepare_terminal(
        &self,
        provider: &str,
        cwd: &str,
    ) -> Result<Option<String>, ProviderError> {
        self.adapter(provider)?.prepare_terminal(cwd)
    }

    pub(crate) fn preflight_terminal_resume(
        &self,
        provider: &str,
        cwd: &str,
        native_id: &str,
    ) -> Result<(), ProviderError> {
        self.adapter(provider)?
            .preflight_terminal_resume(cwd, native_id)
    }

    pub(crate) fn subagent_transcript(
        &self,
        provider: &str,
        session: &NativeSessionRef,
        info: &Value,
    ) -> Result<Vec<Value>, ProviderError> {
        self.adapter(provider)?.subagent_transcript(session, info)
    }

    fn worker_handle(&self, session_id: &str) -> Result<SharedChat, ProviderError> {
        let mut chats = self
            .chats
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "provider chat lock poisoned"))?;
        let slot = chats.get_mut(session_id).ok_or_else(|| {
            ProviderError::new(
                "chat_not_open",
                format!("no provider Chat worker is open for session {session_id}"),
            )
        })?;
        let worker = slot.worker.clone().ok_or_else(|| {
            ProviderError::new(
                "chat_not_open",
                format!("no provider Chat worker is open for session {session_id}"),
            )
        })?;
        let alive = worker.lock().ok().is_some_and(|chat| chat.is_alive());
        if !alive {
            let mut guard = worker.try_lock().map_err(|_| ProviderError::new("chat_busy", "Chat retirement is still in progress"))?;
            self.persist_retirement(guard.as_mut())?;
            drop(guard);
            let retired = slot.mark_disconnected();
            self.connect_wait.notify_all();
            let state = slot.wire(session_id, "unknown", None);
            drop(chats);
            self.emit_connection(session_id, state);
            drop(retired);
            return Err(ProviderError::new(
                "provider_disconnected",
                format!("provider Chat worker for session {session_id} is no longer alive"),
            ));
        }
        Ok(worker)
    }

    fn chat<T>(
        &self,
        session_id: &str,
        call: impl FnOnce(&mut dyn ChatSession) -> Result<T, ProviderError>,
    ) -> Result<T, ProviderError> {
        // Hold the registry lock only long enough to clone the per-session
        // handle. A slow provider call must not block unrelated sessions.
        let chat = self.worker_handle(session_id)?;
        let lock_timer = crate::send_trace::Timer::start();
        crate::send_trace::emit(crate::send_trace::Event::new("provider.worker_lock.begin")
            .method("chat.send"));
        let mut chat = match chat.lock() {
            Ok(chat) => chat,
            Err(_) => {
                crate::send_trace::emit(crate::send_trace::Event::new("provider.worker_lock.end")
                    .method("chat.send").outcome("error")
                    .duration_us(lock_timer.elapsed_us()));
                return Err(ProviderError::new("provider_internal", "session worker lock poisoned"));
            }
        };
        crate::send_trace::emit(crate::send_trace::Event::new("provider.worker_lock.end")
            .method("chat.send").outcome("ok")
            .duration_us(lock_timer.elapsed_us()));
        call(chat.as_mut())
    }

    pub(crate) fn chat_plan_response_recording(
        &self,
        request: PlanResponseRequest<'_>,
        record: impl FnOnce(&str) -> Result<(), ProviderError>,
    ) -> Result<(Option<Value>, Option<Value>), ProviderError> {
        let PlanResponseRequest { session_id, turn_id, approval_id, response, operation_id, implementation_id } = request;
        self.chat(session_id, |chat| {
            let prompt = chat.plan_response(turn_id, approval_id, response, operation_id)?;
            let receipt = chat.plan_response_receipt();
            let Some(prompt) = prompt else { return Ok((None, receipt)); };
            // Option transition, durable user record and dispatch share the
            // worker lock, so a queue send cannot consume the approved plan.
            chat.validate_send(&prompt)?;
            record(&prompt)?;
            chat.send(&prompt, implementation_id).map(|result| (Some(result), receipt))
        })
    }

    pub fn chat_is_open(&self, session_id: &str) -> bool {
        self.worker_handle(session_id).is_ok()
    }

    /// Pure registry/cached-capability lookup: never probes or starts a reader.
    pub(crate) fn history_reader_available(&self, provider: &str) -> bool {
        if !self
            .adapters
            .read()
            .is_ok_and(|adapters| adapters.contains_key(provider))
        {
            return false;
        }
        if let Some(available) = self.capability_cache.lock().ok().and_then(|cache| {
            cache.values.as_ref().and_then(|(_, values)| {
                values
                    .iter()
                    .find(|value| value["id"] == provider)
                    .and_then(|value| value["history"].as_bool())
            })
        }) {
            return available;
        }
        // ACP load support is learned by the existing capability probe, not by
        // opening a worker from a snapshot. Its reader checks load again on use.
        matches!(provider, "codex" | "claude" | "opencode" | "grok")
    }

    /// Uses the existing replacement/projection fence for a short DB callback.
    /// No worker lock, provider I/O or registry reentry is allowed in `read`.
    pub(crate) fn with_chat_repair_state<T>(
        &self,
        session_id: &str,
        read: impl FnOnce(crate::chat_repair::RepairWorkerState) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let chats = self
            .chats
            .lock()
            .map_err(|_| anyhow::anyhow!("provider_internal"))?;
        let state = chats
            .get(session_id)
            .map(|slot| crate::chat_repair::RepairWorkerState {
                generation: slot.generation,
                worker_token: slot.worker_token.clone(),
                registered: slot.worker.is_some(),
                connecting: slot.connecting,
            })
            .unwrap_or_default();
        read(state)
    }

    pub(crate) fn registered_chat_sessions(&self) -> Vec<String> {
        self.chats
            .lock()
            .map(|chats| {
                chats
                    .iter()
                    .filter(|(_, slot)| slot.worker.is_some())
                    .map(|(id, _)| id.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Snapshot only: no provider I/O or native worker lock. Preview grants use
    /// the same open token as projection to fence stopped/replaced workers.
    pub(crate) fn preview_worker_token(&self, session_id: &str) -> Option<String> {
        let chats=self.chats.lock().ok()?;
        let slot=chats.get(session_id)?;
        if !slot.connecting&&slot.worker.is_none(){return None}
        slot.worker_token.clone()
    }
    /// Holds the chat registry fence while the caller verifies that an MCP
    /// grant still belongs to the current worker. The callback may use the
    /// database, but must not reenter `Providers` or perform provider I/O.
    pub(crate) fn with_current_preview_generation<T>(
        &self,
        session_id: &str,
        generation: &str,
        callback: impl FnOnce() -> T,
    ) -> Option<T> {
        let chats = self.chats.lock().ok()?;
        let slot = chats.get(session_id)?;
        (slot.connecting || slot.worker.is_some())
            .then_some(())
            .filter(|_| slot.worker_token.as_deref() == Some(generation))
            .map(|_| callback())
    }
    #[cfg(test)]
    pub(crate) fn preview_test_worker(&self,session_id:&str,token:Option<&str>) {
        let mut chats=self.chats.lock().unwrap();let slot=chats.entry(session_id.into()).or_insert_with(ChatSlot::new);slot.worker_token=token.map(str::to_owned);slot.connecting=token.is_some();
    }

    pub(crate) fn chat_send_recording(
        &self,
        session_id: &str,
        text: &str,
        images: &[String],
        operation_id: &str,
        record: impl FnOnce() -> Result<(), ProviderError>,
    ) -> Result<Value, ProviderError> {
        if text.trim().is_empty() && images.is_empty() {
            return Err(ProviderError::new(
                "empty_message",
                "Chat message cannot be empty",
            ));
        }
        let _trace_context = crate::send_trace::Context::capture(None, Some(operation_id), Some(session_id))
            .map(crate::send_trace::Context::enter);
        // Serialize validation, persistence and dispatch with other writes to
        // this worker. A rejected local command must not become the UI's most
        // recent turn or complete the active reply's streaming parts.
        let result = self.chat(session_id, |chat| {
            chat.validate_send(text)?;
            chat.validate_send_with_images(text, images)?;
            let record_timer = crate::send_trace::Timer::start();
            crate::send_trace::emit(crate::send_trace::Event::new("persistence.record.begin")
                .method("chat.send"));
            let recorded = record();
            crate::send_trace::emit(crate::send_trace::Event::new("persistence.record.end")
                .method("chat.send")
                .outcome(if recorded.is_ok() { "ok" } else { "error" })
                .duration_us(record_timer.elapsed_us()));
            recorded?;
            let handoff_timer = crate::send_trace::Timer::start();
            crate::send_trace::emit(crate::send_trace::Event::new("provider.handoff.begin")
                .method("chat.send"));
            let sent = chat.send_with_images(text, images, operation_id);
            crate::send_trace::emit(crate::send_trace::Event::new("provider.handoff.end")
                .method("chat.send")
                .outcome(if sent.is_ok() { "ok" } else { "error" })
                .duration_us(handoff_timer.elapsed_us()));
            sent
        });
        match result {
            Err(error) if error.code == "provider_disconnected" => {
                let _ = self.chat_stop(session_id);
                Err(error)
            }
            other => other,
        }
    }

    /// Same lock and validate-then-record order as `chat_send_recording`. The
    /// provider call is `steer`, which must not start a new turn.
    pub(crate) fn chat_steer_recording(
        &self,
        session_id: &str,
        turn_id: &str,
        text: &str,
        images: &[String],
        operation_id: &str,
        record: impl FnOnce() -> Result<(), ProviderError>,
    ) -> Result<Value, ProviderError> {
        if text.trim().is_empty() && images.is_empty() {
            return Err(ProviderError::new(
                "empty_message",
                "Chat message cannot be empty",
            ));
        }
        let result = self.chat(session_id, |chat| {
            chat.validate_steer(text, images)?;
            chat.steer_turn_ready(turn_id)?;
            record()?;
            chat.steer(turn_id, text, images, operation_id)
        });
        match result {
            Err(error) if error.code == "provider_disconnected" => {
                let _ = self.chat_stop(session_id);
                Err(error)
            }
            other => other,
        }
    }

    /// A provider-reported internal session close (e.g. the Claude SDK query
    /// ended while its host process is still alive). Invalidates the current
    /// worker only when that worker no longer reports itself alive, so a late
    /// close from a replaced generation can never tear down a healthy worker.
    #[cfg(test)]
    pub(crate) fn note_session_closed(&self, session_id: &str) {
        self.note_session_closed_scoped(session_id, None);
    }

    pub(crate) fn note_session_closed_scoped(&self, session_id: &str, worker_token: Option<&str>) {
        let mut chats = match self.chats.lock() {
            Ok(chats) => chats,
            Err(_) => return,
        };
        let Some(slot) = chats.get_mut(session_id) else {
            return;
        };
        if worker_token.is_some() && slot.worker_token.as_deref() != worker_token {
            return;
        }
        if slot.worker.is_none() || slot.worker_alive() {
            return;
        }
        if let Some(worker) = slot.worker.as_ref() {
            let Ok(mut guard) = worker.try_lock() else { return; };
            if let Err(error) = self.persist_retirement(guard.as_mut()) {
                eprintln!("held transcript persistence failed for {session_id}: {error}");
                return;
            }
        }
        let retired = slot.mark_disconnected();
        let state = slot.wire(session_id, "unknown", None);
        drop(chats);
        self.connect_wait.notify_all();
        self.emit_connection(session_id, state);
        drop(retired);
    }

    /// Projection and connection replacement share this short registry fence.
    /// The callback may access the DB, but must never call a provider or reenter
    /// Providers. No provider I/O is performed while holding this guard.
    pub(crate) fn with_current_event<T>(
        &self,
        event: &ProviderEvent,
        project: impl FnOnce() -> T,
    ) -> Option<T> {
        let chats = self.chats.lock().ok()?;
        let slot = chats.get(&event.session_id);
        let current = if event.provider == "runtime" && event.kind == "chat.connection" {
            slot.is_some_and(|slot| {
                event
                    .data
                    .get("connectionGeneration")
                    .and_then(Value::as_u64)
                    == Some(slot.generation)
            })
        } else if let Some(token) = event.worker_token.as_deref() {
            slot.is_some_and(|slot| slot.worker_token.as_deref() == Some(token))
        } else {
            !slot.is_some_and(|slot| slot.requires_scoped_events)
        };
        current.then(project)
    }

    fn emit_connection(&self, session_id: &str, mut data: Value) {
        data["sessionId"] = json!(session_id);
        let native_id = data
            .get("nativeId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        emit(
            &self.events,
            "runtime",
            session_id,
            native_id.as_deref(),
            None,
            "chat.connection",
            data,
        );
    }

    fn connection_error_value(error: &ProviderError) -> Value {
        let category = match error.code.as_str() {
            "provider_unavailable" => {
                if error.message.to_ascii_lowercase().contains("not found")
                    || error.message.to_ascii_lowercase().contains("install")
                {
                    "install"
                } else {
                    "provider"
                }
            }
            "unauthenticated" | "auth_required" => "auth",
            "cwd_missing" | "cwd_required" | "cwd_missing_choose_relocation" => "cwd",
            "resume_unsupported" | "native_resume_failed" | "invalid_native_id" => "provider",
            "provider_disconnected" => "runtime",
            "lease_held" | "stale_lease" | "lease_missing" => "control",
            _ => "provider",
        };
        let retryable = !matches!(category, "install" | "auth");
        json!({
            "code": error.code,
            "message": error.message,
            "retryable": retryable,
            "category": category
        })
    }
}

impl Default for Providers {
    fn default() -> Self {
        Self::new()
    }
}

impl Providers {
    pub(crate) fn fork_session(
        &self,
        provider: &str,
        cwd: &str,
        native_id: &str,
        anchor: Option<&NativeForkAnchor>,
        is_latest: bool,
    ) -> Result<Option<String>, ProviderError> {
        if cwd.trim().is_empty() || native_id.trim().is_empty() {
            return Err(ProviderError::new("invalid_fork_request", "cwd and native session id are required"));
        }
        self.adapter(provider)?.fork_session(cwd, native_id, anchor, is_latest)
    }
}

impl ProviderRuntime for Providers {
    fn capabilities(&self) -> Vec<Value> {
        let generation = self.capability_cache.lock().map(|cache| cache.generation).unwrap_or(0);
        let values = self.capability_snapshot();
        if !values.is_empty() { return values; }
        // Admission/delegation callers still require confirmed capabilities.
        // Wait for the shared job, rather than starting another probe.
        self.confirmed_capabilities(generation)
    }

    fn terminal_command(
        &self,
        provider: &str,
        resume_id: Option<&str>,
        assign_id: Option<&str>,
    ) -> Result<Value, ProviderError> {
        if resume_id.is_some() && assign_id.is_some() {
            return Err(ProviderError::new(
                "provider_internal",
                "resume and pre-assigned identities are mutually exclusive",
            ));
        }
        serde_json::to_value(
            self.adapter(provider)?
                .terminal_command(resume_id, assign_id)?,
        )
        .map_err(|error| ProviderError::new("provider_internal", error.to_string()))
    }

    fn history_list(
        &self,
        provider: &str,
        cursor: Option<&str>,
        limit: u32,
        cwd: Option<&str>,
    ) -> Result<Value, ProviderError> {
        self.adapter(provider)?
            .history_list(cursor, limit.clamp(1, 100), cwd)
    }

    fn history_read(&self, provider: &str, native_id: &str) -> Result<Value, ProviderError> {
        if native_id.trim().is_empty() {
            return Err(ProviderError::new(
                "invalid_native_id",
                "native session id is required",
            ));
        }
        self.adapter(provider)?.history_read(native_id)
    }

    fn chat_open(
        &self,
        session_id: &str,
        provider: &str,
        cwd: &str,
        native_id: Option<&str>,
    ) -> Result<Value, ProviderError> {
        if session_id.trim().is_empty() || cwd.trim().is_empty() {
            return Err(ProviderError::new(
                "invalid_chat_request",
                "sessionId and cwd are required",
            ));
        }
        let adapter = self.adapter(provider)?.clone();
        // The resolver may read durable project state; never run it under the
        // Chat registry lock.
        let mut chats = self
            .chats
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "provider chat lock poisoned"))?;
        let mut waited = false;
        loop {
            let slot = chats.get(session_id);
            if slot.is_some_and(ChatSlot::worker_alive) {
                let native = slot.and_then(|slot| slot.native_id.clone());
                return Ok(json!({"nativeId": native, "status": "ready"}));
            }
            if slot.is_some_and(|slot| slot.connecting) {
                waited = true;
                chats = self.connect_wait.wait(chats).map_err(|_| {
                    ProviderError::new("provider_internal", "provider chat lock poisoned")
                })?;
                continue;
            }
            if waited {
                let error = slot.and_then(|slot| {
                    slot.error.as_ref().and_then(|value| {
                        value.get("code").and_then(Value::as_str).map(|code| {
                            ProviderError::new(
                                code,
                                value
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("provider Chat failed to connect"),
                            )
                        })
                    })
                });
                return Err(error.unwrap_or_else(|| {
                    ProviderError::new("chat_not_open", "provider Chat failed to connect")
                }));
            }
            break;
        }
        let worker_token = uuid::Uuid::new_v4().to_string();
        if let Some(worker) = chats.get(session_id).and_then(|slot| slot.worker.clone()) {
            let mut worker = worker.try_lock().map_err(|_| ProviderError::new("chat_busy", "Chat retirement is still in progress"))?;
            self.persist_retirement(worker.as_mut())?;
        }
        let (generation, old_worker) = {
            let slot = chats
                .entry(session_id.to_owned())
                .or_insert_with(ChatSlot::new);
            slot.connecting = true;
            slot.phase = "connecting";
            slot.error = None;
            slot.worker_token = Some(worker_token.clone());
            slot.requires_scoped_events = adapter.scopes_chat_events();
            slot.generation = slot.generation.saturating_add(1);
            slot.revision = slot.revision.saturating_add(1);
            (slot.generation, slot.worker.take())
        };
        let connecting = chats
            .get(session_id)
            .map(|slot| slot.wire(session_id, "unknown", None))
            .unwrap_or_else(|| json!({"sessionId":session_id,"phase":"connecting"}));
        drop(chats);
        self.emit_connection(session_id, connecting);
        drop(old_worker);

        // Resolved per open: reconnects rotate the session token.
        let tools = self.tool_server(session_id, provider);
        let opened = self.project_trust(session_id, provider).and_then(|trust| {
            adapter.open_chat_with_project_trust(session_id, cwd, native_id, &worker_token, tools.as_ref(), trust.as_deref())
        });
        let mut chats = self
            .chats
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "provider chat lock poisoned"))?;
        let slot = chats
            .entry(session_id.to_owned())
            .or_insert_with(ChatSlot::new);
        if slot.generation != generation {
            drop(chats);
            self.connect_wait.notify_all();
            if let Ok(mut worker) = opened {
                let _ = worker.stop();
            }
            return Err(ProviderError::new(
                "chat_connect_superseded",
                "a newer Chat connection attempt replaced this one",
            ));
        }
        slot.connecting = false;
        let mut rejected_worker = None;
        let opened = opened.and_then(|worker| {
            if worker.is_alive() {
                Ok(worker)
            } else {
                rejected_worker = Some(worker);
                Err(ProviderError::new(
                    "provider_disconnected",
                    "provider Chat ended before the connection handoff",
                ))
            }
        });
        let result = match opened {
            Ok(worker) => {
                let native = worker.native_id();
                slot.phase = "ready";
                slot.native_id = native.clone();
                slot.error = None;
                slot.worker = Some(Arc::new(Mutex::new(worker)));
                slot.revision = slot.revision.saturating_add(1);
                json!({"nativeId": native, "status": "ready"})
            }
            Err(error) => {
                let mut failed = error;
                if native_id.is_some()
                    && !matches!(
                        failed.code.as_str(),
                        "native_resume_failed"
                            | "resume_unsupported"
                            | "invalid_native_id"
                            | "provider_unavailable"
                            | "unauthenticated"
                            | "auth_required"
                            | "cwd_missing"
                            | "cwd_required"
                            | "cwd_missing_choose_relocation"
                    )
                {
                    failed = ProviderError::new("native_resume_failed", failed.message.clone())
                        .with_details(json!({"cause": failed.code.clone()}));
                }
                slot.phase = "failed";
                slot.error = Some(Self::connection_error_value(&failed));
                slot.worker = None;
                slot.worker_token = None;
                slot.revision = slot.revision.saturating_add(1);
                let state = slot.wire(session_id, "error", slot.error.clone());
                drop(chats);
                self.connect_wait.notify_all();
                self.emit_connection(session_id, state);
                // Provider stop/drop may wait on native I/O. The registry is
                // already released so unrelated sessions/projection stay live.
                if let Some(mut worker) = rejected_worker {
                    let _ = worker.stop();
                }
                return Err(failed);
            }
        };
        let state = slot.wire(session_id, "unknown", None);
        drop(chats);
        self.connect_wait.notify_all();
        self.emit_connection(session_id, state);
        Ok(result)
    }

    fn chat_send(
        &self,
        session_id: &str,
        text: &str,
        operation_id: &str,
    ) -> Result<Value, ProviderError> {
        self.chat_send_recording(session_id, text, &[], operation_id, || Ok(()))
    }

    fn chat_cancel(&self, session_id: &str, turn_id: &str) -> Result<(), ProviderError> {
        self.chat(session_id, |chat| chat.cancel(turn_id))
    }

    fn chat_approve(
        &self,
        session_id: &str,
        turn_id: &str,
        approval_id: &str,
        choice_id: &str,
        operation_id: &str,
    ) -> Result<(), ProviderError> {
        self.chat(session_id, |chat| {
            chat.approve(turn_id, approval_id, choice_id, operation_id)
        })
    }

    fn chat_answer(
        &self,
        session_id: &str,
        turn_id: &str,
        approval_id: &str,
        response: &Value,
        operation_id: &str,
    ) -> Result<(), ProviderError> {
        self.chat(session_id, |chat| chat.answer(turn_id, approval_id, response, operation_id))
    }

    fn chat_stop(&self, session_id: &str) -> Result<(), ProviderError> {
        let mut chats = self
            .chats
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "provider chat lock poisoned"))?;
        // Stopping a durable Chat session before its explicit `chat.connect`
        // starts is a valid lifecycle transition. Treat an absent worker slot
        // as already stopped so the database can move `starting` to `exited`.
        let Some(slot) = chats.get_mut(session_id) else {
            return Ok(());
        };
        let worker = slot.worker.clone();
        // Wait outside the registry, then confirm that this is still the same
        // worker before committing held items and invalidating its token.
        if let Some(worker) = worker {
            drop(chats);
            let mut guard = worker.lock().map_err(|_| ProviderError::new("provider_internal", "session worker lock poisoned"))?;
            chats = self.chats.lock().map_err(|_| ProviderError::new("provider_internal", "provider chat lock poisoned"))?;
            let Some(slot) = chats.get_mut(session_id) else { return Ok(()); };
            if !slot.worker.as_ref().is_some_and(|current| Arc::ptr_eq(current, &worker)) { return Ok(()); }
            self.persist_retirement(guard.as_mut())?;
            slot.worker_token = None;
            let _ = slot.mark_disconnected();
            let state = slot.wire(session_id, "unknown", None);
            drop(chats);
            self.connect_wait.notify_all();
            self.emit_connection(session_id, state);
            return guard.stop();
        }
        // An explicit stop invalidates even notifications queued by a worker
        // whose startup has not returned. Natural EOF keeps its token until
        // replacement so already-queued final error/expiry events can settle.
        slot.worker_token = None;
        let _ = slot.mark_disconnected();
        let state = slot.wire(session_id, "unknown", None);
        drop(chats);
        self.connect_wait.notify_all();
        self.emit_connection(session_id, state);
        Ok(())
    }

    fn chat_options(&self, session_id: &str) -> Result<Value, ProviderError> {
        match self.chat(session_id, |chat| Ok(chat.ui_state())) {
            Ok(value) => Ok(normalize_chat_ui(value)),
            Err(error) if error.code == "chat_not_open" => Ok(json!({
                "options":[],
                "commands":[],
                "loadState":"unknown",
                "error":{"code":error.code,"message":error.message}
            })),
            Err(error) => Ok(json!({
                "options":[],
                "commands":[],
                "loadState":"error",
                "error":{"code":error.code,"message":error.message}
            })),
        }
    }

    fn chat_background_tasks(&self, session_id: &str) -> Result<Value, ProviderError> {
        let tasks = self.chat(session_id, |chat| chat.background_tasks())?;
        Ok(json!({"tasks":tasks}))
    }

    fn chat_background_task_stop(
        &self,
        session_id: &str,
        task_id: &str,
    ) -> Result<bool, ProviderError> {
        if task_id.trim().is_empty() {
            return Err(ProviderError::new(
                "background_task_invalid",
                "Background task id is required",
            ));
        }
        self.chat(session_id, |chat| chat.stop_background_task(task_id))
    }

    fn chat_connection(&self, session_id: &str) -> Value {
        let mut chats = match self.chats.lock() {
            Ok(chats) => chats,
            Err(_) => {
                return json!({
                    "sessionId":session_id,
                    "connectionGeneration":0,
                    "revision":0,
                    "phase":"unavailable",
                    "optionsLoadState":"unknown"
                })
            }
        };
        if let Some(slot) = chats.get_mut(session_id) {
            if slot.worker.is_some() && !slot.worker_alive() {
                if let Some(worker) = slot.worker.as_ref() {
                    let Ok(mut guard) = worker.try_lock() else { return slot.wire(session_id, "unknown", None); };
                    if let Err(error) = self.persist_retirement(guard.as_mut()) {
                        return slot.wire(session_id, "error", Some(json!({"code":error.code,"message":error.message})));
                    }
                }
                let retired = slot.mark_disconnected();
                let state = slot.wire(session_id, "unknown", None);
                drop(chats);
                self.connect_wait.notify_all();
                self.emit_connection(session_id, state.clone());
                drop(retired);
                return state;
            }
            return slot.wire(session_id, "unknown", None);
        }
        json!({
            "sessionId":session_id,
            "connectionGeneration":0,
            "revision":0,
            "phase":"disconnected",
            "optionsLoadState":"unknown"
        })
    }

    fn chat_set_option(
        &self,
        session_id: &str,
        option_id: &str,
        value: &str,
    ) -> Result<Value, ProviderError> {
        self.chat(session_id, |chat| chat.set_option(option_id, value))
    }

    fn subscribe(&self) -> broadcast::Receiver<ProviderEvent> {
        self.events.subscribe()
    }
}

impl Drop for Providers {
    fn drop(&mut self) {
        if let Ok(chats) = self.chats.get_mut() {
            for slot in chats.values_mut() {
                if let Some(worker) = slot.worker.take() {
                    if let Ok(mut worker) = worker.lock() {
                        let _ = worker.stop();
                    }
                }
            }
        }
    }
}

/// Event destination bound once to a worker generation. Cloning this for an
/// asynchronous callback cannot accidentally adopt a replacement worker token.
#[derive(Clone)]
pub(crate) struct ScopedProviderEvents {
    events: ProviderEventSender,
    worker_token: String,
}

impl ScopedProviderEvents {
    pub(crate) fn new(events: ProviderEventSender, worker_token: &str) -> Self {
        Self {
            events,
            worker_token: worker_token.to_owned(),
        }
    }
}

pub(crate) fn emit_bound(
    events: &ScopedProviderEvents,
    provider: &str,
    session_id: &str,
    native_id: Option<&str>,
    turn_id: Option<&str>,
    kind: &str,
    data: Value,
) {
    emit_scoped(
        &events.events,
        provider,
        session_id,
        native_id,
        turn_id,
        kind,
        data,
        Some(&events.worker_token),
    );
}

pub(crate) fn emit(
    events: &ProviderEventSender,
    provider: &str,
    session_id: &str,
    native_id: Option<&str>,
    turn_id: Option<&str>,
    kind: &str,
    data: Value,
) {
    emit_scoped(
        events, provider, session_id, native_id, turn_id, kind, data, None,
    );
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_scoped(
    events: &ProviderEventSender,
    provider: &str,
    session_id: &str,
    native_id: Option<&str>,
    turn_id: Option<&str>,
    kind: &str,
    mut data: Value,
    worker_token: Option<&str>,
) {
    if kind == "chat.context" {
        if let Some(usage) = data.get_mut("usage").and_then(Value::as_object_mut) {
            usage.insert("updatedAt".into(), json!(chrono::Utc::now().to_rfc3339()));
        }
    }
    let _ = events.send(ProviderEvent {
        provider: provider.to_owned(),
        session_id: session_id.to_owned(),
        native_id: native_id.map(ToOwned::to_owned),
        turn_id: turn_id.map(ToOwned::to_owned),
        kind: kind.to_owned(),
        data,
        worker_token: worker_token.map(ToOwned::to_owned),
    });
}

#[cfg(test)]
mod registry_cleanup_tests {
    use super::*;
    use std::sync::{mpsc, Weak};

    #[test]
    fn context_emission_populates_timestamp_before_projection() {
        let (sender, mut receiver) = crate::provider_events::tap_channel(8);
        emit_scoped(&sender, "pi", "s", None, None, "chat.context", json!({"usage":{"totalTokens":5}}), Some("worker"));
        let snapshot = receiver.try_recv().unwrap();
        chrono::DateTime::parse_from_rfc3339(snapshot.data["usage"]["updatedAt"].as_str().unwrap()).unwrap();
        assert_eq!(snapshot.data["usage"]["totalTokens"], 5);
        assert_eq!(snapshot.worker_token.as_deref(), Some("worker"));
    }

    #[test]
    fn normalize_chat_ui_preserves_the_existing_default_load_state_rules() {
        assert_eq!(normalize_chat_ui(json!({}))["loadState"], "empty");
        assert_eq!(
            normalize_chat_ui(json!({"options":[{"id":"model"}]}))["loadState"],
            "ready"
        );
        assert_eq!(
            normalize_chat_ui(json!({"options":[],"loadState":"loading"}))["loadState"],
            "loading"
        );
        assert_eq!(normalize_chat_ui(json!({}))["inputCapabilities"], json!({}));
    }

    #[test]
    fn normalize_chat_ui_rejects_invalid_collection_types_and_preserves_explicit_state() {
        let normalized = normalize_chat_ui(json!({
            "options": {"not":"an array"},
            "commands": "not an array",
            "inputCapabilities": [],
            "loadState": "error",
            "error": {"code":"options_failed","message":"Options failed"}
        }));
        assert_eq!(normalized["options"], json!([]));
        assert_eq!(normalized["commands"], json!([]));
        assert_eq!(normalized["inputCapabilities"], json!({}));
        assert_eq!(normalized["loadState"], "error");
        assert_eq!(normalized["error"]["code"], "options_failed");
    }

    #[test]
    fn normalize_chat_ui_preserves_valid_background_tasks_and_drops_invalid_rows() {
        let normalized = normalize_chat_ui(json!({
            "backgroundTasks":[
                {"id":"p1","title":"Build","command":"npm test","status":"running","startedAt":"now","canStop":true,"toolId":"tool-1"},
                {"id":"p2","title":"Done","status":"completed","endedAt":"later","canStop":false},
                {"id":"bad","title":"Bad","status":"unknown","canStop":false},
                {"id":"bad-terminal","title":"Bad","status":"failed","canStop":true}
            ]
        }));
        assert_eq!(normalized["backgroundTasks"].as_array().unwrap().len(), 2);
        assert_eq!(normalized["backgroundTasks"][0]["toolId"], "tool-1");
        assert_eq!(normalized["backgroundTasks"][1]["endedAt"], "later");
    }

    #[test]
    fn normalize_chat_ui_adds_option_categories_groups_and_recommendations() {
        let normalized = normalize_chat_ui(json!({
            "options":[
                {"id":"model","name":"Model","value":"openai/gpt-5","choices":[
                    {"value":"openai/gpt-5","name":"GPT-5","recommended":true},
                    {"value":"anthropic/claude","name":"Claude"}
                ]},
                {"id":"thinking","name":"Thinking","value":"high","choices":[]},
                {"id":"mode","name":"Mode","value":"default","choices":[]},
                {"id":"fast","name":"Fast mode","kind":"boolean","choices":[
                    {"value":"true","name":"On"},{"value":"false","name":"Off"}
                ]}
            ]
        }));
        let options = normalized["options"].as_array().unwrap();
        assert_eq!(options[0]["category"], "model");
        assert_eq!(options[0]["choices"][0]["group"], "openai");
        assert_eq!(options[0]["choices"][1]["group"], "anthropic");
        assert_eq!(options[0]["recommended"], "openai/gpt-5");
        assert_eq!(options[0]["choices"][0]["recommended"], true);
        assert_eq!(options[1]["category"], "thinking");
        assert_eq!(options[2]["category"], "mode");
        assert_eq!(options[3]["category"], "other");
        assert_eq!(options[3]["kind"], "boolean");
    }

    #[test]
    fn normalize_chat_ui_keeps_adapter_supplied_metadata() {
        let normalized = normalize_chat_ui(json!({
            "options":[{"id":"custom","name":"Custom","value":"a","category":"mode",
                "choices":[{"value":"a","name":"A","group":"own"}]}]
        }));
        assert_eq!(normalized["options"][0]["category"], "mode");
        assert_eq!(normalized["options"][0]["choices"][0]["group"], "own");
    }

    #[test]
    fn normalize_chat_ui_passes_adapter_skills_through_and_drops_malformed_rows() {
        // Live 2026-10-14: Pi's skills reached the adapter state but never the client.
        let ui = normalize_chat_ui(json!({"options":[],"skills":[
            {"name":"skill:review","description":"Review","invocation":"/skill:review"},
            {"name":"two words","invocation":"/two words"},
            {"name":"skill:bare","invocation":""},
            {"name":"skill:odd","invocation":"/skill:odd","description":7}
        ]}));
        assert_eq!(ui["skills"], json!([{"name":"skill:review","description":"Review","invocation":"/skill:review"}]));
        assert!(normalize_chat_ui(json!({"options":[]})).get("skills").is_none(), "absent stays absent");
    }

    #[test]
    fn normalize_chat_ui_preserves_only_a_valid_pi_trust_snapshot() {
        let trust = json!({
            "protectedResources":[".pi/extensions","../.agents/skills"],
            "piDecision":"none",
            "defaultProjectTrust":"ask",
            "threadtermDecision":"declined",
            "effective":"skipped",
            "unexpected":"discarded",
        });
        let normalized = normalize_chat_ui(json!({"piTrust":trust}));
        assert_eq!(normalized["piTrust"]["effective"], "skipped");
        assert!(normalized["piTrust"].get("unexpected").is_none());
        assert!(
            normalize_chat_ui(json!({"piTrust":{"protectedResources":[4]}}))
                .get("piTrust")
                .is_none()
        );
        assert!(normalize_chat_ui(json!({"piTrust":{
            "protectedResources":[],"piDecision":"maybe","defaultProjectTrust":"ask",
            "threadtermDecision":"none","effective":"skipped"
        }}))
        .get("piTrust")
        .is_none());
    }

    #[test]
    fn every_production_adapter_fences_late_events_after_reconnect_and_stop() {
        let providers = Providers::new();
        assert_eq!(providers.adapters.read().unwrap().len(), 7);
        let mut receiver = providers.events.subscribe();
        for (provider, adapter) in providers.adapters.read().unwrap().iter() {
            assert!(
                adapter.scopes_chat_events(),
                "{provider} must opt in before accepting Chat events"
            );
            let mut slot = ChatSlot::new();
            slot.requires_scoped_events = adapter.scopes_chat_events();
            slot.worker_token = Some("new-worker".into());
            slot.connecting = true;
            providers.chats.lock().unwrap().insert("s".into(), slot);
            let old = ScopedProviderEvents::new(providers.events.clone(), "old-worker");
            let queued_callback = old.clone();
            let current = ScopedProviderEvents::new(providers.events.clone(), "new-worker");
            for kind in [
                "session.ready",
                "chat.delta",
                "chat.ui",
                "chat.approval",
                "chat.approval.resolved",
                "chat.error",
                "chat.turn.completed",
                "session.closed",
            ] {
                emit_bound(
                    &queued_callback,
                    provider,
                    "s",
                    Some("native"),
                    Some("turn"),
                    kind,
                    json!({}),
                );
                let stale = receiver.try_recv().unwrap();
                assert!(providers
                    .with_current_event(&stale, || panic!("old callback entered projection"))
                    .is_none());
                emit(
                    &providers.events,
                    provider,
                    "s",
                    Some("native"),
                    Some("turn"),
                    kind,
                    json!({}),
                );
                assert!(providers
                    .with_current_event(&receiver.try_recv().unwrap(), || panic!(
                        "unscoped event entered projection"
                    ))
                    .is_none());
                emit_bound(
                    &current,
                    provider,
                    "s",
                    Some("native"),
                    Some("turn"),
                    kind,
                    json!({}),
                );
                assert_eq!(
                    providers.with_current_event(&receiver.try_recv().unwrap(), || "accepted"),
                    Some("accepted"),
                    "early current {provider}/{kind} must be accepted"
                );
            }
            providers.chat_stop("s").unwrap();
            emit_bound(
                &current,
                provider,
                "s",
                Some("native"),
                None,
                "chat.error",
                json!({}),
            );
            // chat_stop also emits a runtime connection event.
            while let Ok(event) = receiver.try_recv() {
                if event.provider != "runtime" {
                    assert!(providers
                        .with_current_event(&event, || panic!("stopped worker entered projection"))
                        .is_none());
                }
            }
        }
    }

    struct DeadWorker {
        registry: Weak<Providers>,
        observed: mpsc::Sender<bool>,
    }
    impl Drop for DeadWorker {
        fn drop(&mut self) {
            let registry = self.registry.upgrade().unwrap();
            let _ = self.observed.send(registry.chats.try_lock().is_ok());
        }
    }
    impl ChatSession for DeadWorker {
        fn native_id(&self) -> Option<String> {
            None
        }
        fn is_alive(&self) -> bool {
            false
        }
        fn send(&mut self, _: &str, _: &str) -> Result<Value, ProviderError> {
            unreachable!()
        }
        fn cancel(&mut self, _: &str) -> Result<(), ProviderError> {
            unreachable!()
        }
        fn approve(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ProviderError> {
            unreachable!()
        }
        fn stop(&mut self) -> Result<(), ProviderError> {
            Ok(())
        }
    }

    struct UnsupportedImageWorker;
    impl ChatSession for UnsupportedImageWorker {
        fn native_id(&self) -> Option<String> {
            None
        }
        fn send(&mut self, _: &str, _: &str) -> Result<Value, ProviderError> {
            Ok(json!({}))
        }
        fn cancel(&mut self, _: &str) -> Result<(), ProviderError> {
            Ok(())
        }
        fn approve(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ProviderError> {
            Ok(())
        }
        fn stop(&mut self) -> Result<(), ProviderError> {
            Ok(())
        }
    }

    struct RestartWorker {
        retired: bool,
    }
    impl ChatSession for RestartWorker {
        fn native_id(&self) -> Option<String> {
            None
        }
        fn validate_send(&self, _: &str) -> Result<(), ProviderError> {
            if self.retired {
                Err(ProviderError::new("provider_disconnected", "retired"))
            } else {
                Ok(())
            }
        }
        fn send(&mut self, _: &str, _: &str) -> Result<Value, ProviderError> {
            self.validate_send("")?;
            Ok(json!({}))
        }
        fn cancel(&mut self, _: &str) -> Result<(), ProviderError> {
            Ok(())
        }
        fn approve(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ProviderError> {
            Ok(())
        }
        fn stop(&mut self) -> Result<(), ProviderError> {
            self.retired = true;
            Ok(())
        }
    }

    #[test]
    fn default_chat_session_rejects_images_before_send() {
        let worker = UnsupportedImageWorker;
        let error = worker
            .validate_send_with_images("", &["data:image/png;base64,cG5n".to_owned()])
            .unwrap_err();
        assert_eq!(error.code, "images_unsupported");
    }

    #[test]
    fn dead_worker_cleanup_releases_the_registry_before_provider_drop() {
        for path in ["poll", "send", "closed"] {
            let providers = Arc::new(Providers::for_test(vec![]));
            let (observed, result) = mpsc::channel();
            let mut slot = ChatSlot::new();
            slot.phase = "ready";
            slot.worker = Some(Arc::new(Mutex::new(Box::new(DeadWorker {
                registry: Arc::downgrade(&providers),
                observed,
            }))));
            providers.chats.lock().unwrap().insert("s".into(), slot);
            match path {
                "poll" => {
                    providers.chat_connection("s");
                }
                "send" => {
                    assert!(providers.worker_handle("s").is_err());
                }
                _ => providers.note_session_closed("s"),
            }
            assert!(
                result.recv_timeout(Duration::from_secs(1)).unwrap(),
                "{path}: provider cleanup held the shared registry"
            );
        }
    }

    #[test]
    fn restart_fences_a_send_that_captured_the_old_worker() {
        let providers = Providers::for_test(vec![]);
        let stale: SharedChat = Arc::new(Mutex::new(Box::new(RestartWorker { retired: false })));
        let mut slot = ChatSlot::new();
        slot.phase = "ready";
        slot.worker_token = Some("old".into());
        slot.worker = Some(Arc::clone(&stale));
        providers.chats.lock().unwrap().insert("s".into(), slot);
        let state = providers.restart_idle_chat("s", || Ok(())).unwrap();
        assert_eq!(state["phase"], "disconnected");
        assert!(providers.chats.lock().unwrap()["s"].worker.is_none());
        let error = stale.lock().unwrap().send("late", "turn").unwrap_err();
        assert_eq!(error.code, "provider_disconnected");
    }

    #[test]
    fn restart_rejects_a_busy_worker_without_persisting_or_holding_the_registry() {
        let providers = Providers::for_test(vec![]);
        let worker: SharedChat = Arc::new(Mutex::new(Box::new(RestartWorker { retired: false })));
        let mut slot = ChatSlot::new();
        slot.worker = Some(Arc::clone(&worker));
        providers.chats.lock().unwrap().insert("s".into(), slot);
        let _busy = worker.lock().unwrap();
        let error = providers.restart_idle_chat("s", || panic!("busy restart persisted a decision")).unwrap_err();
        assert_eq!(error.code, "turn_in_progress");
        assert!(providers.chats.try_lock().unwrap()["s"].worker.is_some());
    }

    #[test]
    fn failed_trust_persistence_leaves_the_original_worker_open() {
        let providers = Providers::for_test(vec![]);
        let worker: SharedChat = Arc::new(Mutex::new(Box::new(RestartWorker { retired: false })));
        let mut slot = ChatSlot::new();
        slot.worker = Some(Arc::clone(&worker));
        slot.worker_token = Some("original".into());
        providers.chats.lock().unwrap().insert("s".into(), slot);
        assert!(providers.restart_idle_chat("s", || Err(anyhow::anyhow!("persistence failed"))).is_err());
        assert_eq!(providers.chats.lock().unwrap()["s"].worker_token.as_deref(), Some("original"));
        assert!(worker.lock().unwrap().validate_send("next prompt").is_ok());
    }
}

#[cfg(test)]
mod capability_cache_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};

    fn capability(id: &str, name: String) -> ProviderCapability {
        ProviderCapability {
            source: "builtin", plugin_id: None, icon: None, sign_in: None, homepage: None,
            id: id.into(), name, installed: true, version: None, terminal: false, chat: false,
            history: false, resume: false, terminal_resume_capture: "none", reason: None,
            auth: "unknown".into(),
        }
    }

    /// A provider whose capability probe is slow and numbered.
    struct SlowProbe {
        probes: Arc<AtomicUsize>,
        delay: Duration,
    }

    impl SlowProbe {
        fn new(probes: &Arc<AtomicUsize>) -> Self {
            Self { probes: Arc::clone(probes), delay: Duration::from_millis(300) }
        }
    }

    impl ProviderAdapter for SlowProbe {
        fn id(&self) -> &'static str { "codex" }
        fn capability(&self) -> ProviderCapability {
            let probe = self.probes.fetch_add(1, SeqCst) + 1;
            std::thread::sleep(self.delay);
            capability("codex", format!("probe {probe}"))
        }
        fn terminal_command(&self, _: Option<&str>, _: Option<&str>) -> Result<TerminalCommand, ProviderError> {
            Err(ProviderError::new("unsupported", "capability fixture"))
        }
        fn history_list(&self, _: Option<&str>, _: u32, _: Option<&str>) -> Result<Value, ProviderError> {
            Ok(json!({}))
        }
        fn history_read(&self, _: &str) -> Result<Value, ProviderError> {
            Ok(json!([]))
        }
        fn open_chat(&self, _: &str, _: &str, _: Option<&str>) -> Result<Box<dyn ChatSession>, ProviderError> {
            Err(ProviderError::new("unsupported", "capability fixture"))
        }
    }

    /// A probe that blocks every call until the test releases the gate.
    struct GateProbe {
        probes: Arc<AtomicUsize>,
        entered: Arc<AtomicUsize>,
        gate: Arc<(Mutex<bool>, Condvar)>,
    }

    impl GateProbe {
        fn new(probes: &Arc<AtomicUsize>, entered: &Arc<AtomicUsize>) -> Self {
            Self { probes: Arc::clone(probes), entered: Arc::clone(entered), gate: Arc::new((Mutex::new(false), Condvar::new())) }
        }
        fn release(&self) {
            let (lock, wait) = &*self.gate;
            *lock.lock().unwrap() = true;
            wait.notify_all();
        }
        fn wait_entered(&self, count: usize) {
            let deadline = Instant::now() + Duration::from_secs(5);
            while self.entered.load(SeqCst) < count && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(1));
            }
            assert!(self.entered.load(SeqCst) >= count, "only {} probe(s) entered; expected {count}", self.entered.load(SeqCst));
        }
    }

    impl ProviderAdapter for GateProbe {
        fn id(&self) -> &'static str { "codex" }
        fn capability(&self) -> ProviderCapability {
            let probe = self.probes.fetch_add(1, SeqCst) + 1;
            self.entered.fetch_add(1, SeqCst);
            let (lock, wait) = &*self.gate;
            let mut released = lock.lock().unwrap();
            while !*released { released = wait.wait(released).unwrap(); }
            capability("codex", format!("probe {probe}"))
        }
        fn terminal_command(&self, _: Option<&str>, _: Option<&str>) -> Result<TerminalCommand, ProviderError> {
            Err(ProviderError::new("unsupported", "capability fixture"))
        }
        fn history_list(&self, _: Option<&str>, _: u32, _: Option<&str>) -> Result<Value, ProviderError> { Ok(json!({})) }
        fn history_read(&self, _: &str) -> Result<Value, ProviderError> { Ok(json!([])) }
        fn open_chat(&self, _: &str, _: &str, _: Option<&str>) -> Result<Box<dyn ChatSession>, ProviderError> {
            Err(ProviderError::new("unsupported", "capability fixture"))
        }
    }

    struct FailingProbe {
        inner: SlowProbe,
        fail: Arc<AtomicBool>,
    }

    impl ProviderAdapter for FailingProbe {
        fn id(&self) -> &'static str { "codex" }
        fn capability(&self) -> ProviderCapability {
            if self.fail.load(SeqCst) {
                self.inner.probes.fetch_add(1, SeqCst);
                panic!("isolated capability failure fixture");
            }
            self.inner.capability()
        }
        fn terminal_command(&self, native_id: Option<&str>, extra: Option<&str>) -> Result<TerminalCommand, ProviderError> {
            self.inner.terminal_command(native_id, extra)
        }
        fn history_list(&self, cwd: Option<&str>, limit: u32, cursor: Option<&str>) -> Result<Value, ProviderError> {
            self.inner.history_list(cwd, limit, cursor)
        }
        fn history_read(&self, native_id: &str) -> Result<Value, ProviderError> { self.inner.history_read(native_id) }
        fn open_chat(&self, session: &str, cwd: &str, native_id: Option<&str>) -> Result<Box<dyn ChatSession>, ProviderError> {
            self.inner.open_chat(session, cwd, native_id)
        }
    }

    fn name(values: &[Value]) -> String {
        values[0]["name"].as_str().unwrap().to_owned()
    }

    /// Moves a cached value's timestamp back; only the tests use it because
    /// successful values must never expire by time.
    fn age(providers: &Providers, by: Duration) {
        let mut cache = providers.capability_cache.lock().unwrap();
        let (created, _) = cache.values.as_mut().unwrap();
        *created = created.checked_sub(by).unwrap();
    }

    fn wait_for_name(providers: &Providers, expected: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let values = providers.capability_snapshot();
            if values.first().is_some_and(|value| value["name"] == expected) { return; }
            assert!(Instant::now() < deadline, "capability probe did not reach {expected}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn recorder(providers: &Providers) -> Arc<Mutex<Vec<CapabilityUpdate>>> {
        let updates = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&updates);
        providers.set_capability_listener(Arc::new(move |update| sink.lock().unwrap().push(update)));
        updates
    }

    fn wait_for_updates(updates: &Arc<Mutex<Vec<CapabilityUpdate>>>, count: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while updates.lock().unwrap().len() < count {
            assert!(Instant::now() < deadline, "capability completion did not publish");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn trust_resolver_runs_after_connection_admission_and_failure_does_not_stall_retry() {
        let providers = Arc::new(Providers::for_test(vec![Arc::new(SlowProbe::new(&Arc::new(AtomicUsize::new(0))))]));
        let observer = Arc::downgrade(&providers);
        providers.set_project_trust_resolver(Arc::new(move |session_id, _| {
            let providers = observer.upgrade().unwrap();
            assert!(providers.chats.lock().unwrap()[session_id].connecting);
            Err(ProviderError::new("trust_read_failed", "fixture failure"))
        }));
        for _ in 0..2 {
            assert_eq!(providers.chat_open("s", "codex", "fixture-cwd", None).unwrap_err().code, "trust_read_failed");
            let chats = providers.chats.lock().unwrap();
            assert!(!chats["s"].connecting);
            assert_eq!(chats["s"].phase, "failed");
        }
    }

    // A1: successful values never expire and reads never start another round.
    #[test]
    fn successful_values_never_expire_by_time() {
        let probes = Arc::new(AtomicUsize::new(0));
        let providers = Providers::for_test(vec![Arc::new(SlowProbe::new(&probes))]);
        assert_eq!(name(&providers.capabilities()), "probe 1");
        for _ in 0..50 {
            assert_eq!(name(&providers.capability_snapshot()), "probe 1");
            assert_eq!(name(&providers.capability_snapshot_result().unwrap()), "probe 1");
        }
        age(&providers, Duration::from_secs(3700));
        for _ in 0..50 {
            assert_eq!(name(&providers.capability_snapshot()), "probe 1");
            assert_eq!(name(&providers.capability_snapshot_result().unwrap()), "probe 1");
        }
        assert_eq!(probes.load(SeqCst), 1, "reads started a time-based re-probe");
    }

    // A2: a forced refresh keeps warm values visible, probes once and publishes
    // exactly one completion carrying its refresh id.
    #[test]
    fn forced_refresh_keeps_values_then_publishes_new_ones_once() {
        let probes = Arc::new(AtomicUsize::new(0));
        let providers = Providers::for_test(vec![Arc::new(SlowProbe { probes: Arc::clone(&probes), delay: Duration::from_millis(200) })]);
        assert_eq!(name(&providers.capabilities()), "probe 1");
        let updates = recorder(&providers);
        let refresh_id = providers.request_capability_refresh();
        assert!(refresh_id >= 1);
        // During the round the old non-empty values still answer.
        assert_eq!(name(&providers.capability_snapshot()), "probe 1");
        assert_eq!(name(&providers.capability_snapshot_result().unwrap()), "probe 1");
        wait_for_name(&providers, "probe 2");
        assert_eq!(probes.load(SeqCst), 2, "one forced refresh must run exactly one round");
        wait_for_updates(&updates, 1);
        let seen = updates.lock().unwrap().clone();
        assert_eq!(seen.len(), 1, "one completion publishes once: {seen:?}");
        assert_eq!(seen[0].refresh_id, Some(refresh_id));
        assert_eq!(seen[0].outcome, "ok");
    }

    // A3: a forced refresh during a cold probe supersedes the older round; the
    // newer generation owns the values and `refreshing`.
    #[test]
    fn refresh_during_cold_probe_supersedes_the_older_round() {
        let probes = Arc::new(AtomicUsize::new(0));
        let entered = Arc::new(AtomicUsize::new(0));
        let probe = Arc::new(GateProbe::new(&probes, &entered));
        let providers = Providers::for_test(vec![probe.clone()]);
        assert!(providers.capability_snapshot().is_empty());
        probe.wait_entered(1);
        let refresh_id = providers.request_capability_refresh();
        assert_eq!(refresh_id, 2, "the forced refresh claims a new generation");
        probe.wait_entered(2);
        probe.release();
        wait_for_name(&providers, "probe 2");
        assert_eq!(probes.load(SeqCst), 2, "at most two rounds run: {}", probes.load(SeqCst));
        let cache = providers.capability_cache.lock().unwrap();
        assert_eq!(cache.refreshing, None, "the newer round cleared refreshing");
        assert_eq!(cache.generation, 2);
    }

    // A3: a plugin rebuild during a probe discards the obsolete round and the
    // next read probes again.
    #[test]
    fn plugin_rebuild_during_a_probe_discards_the_obsolete_round() {
        let probes = Arc::new(AtomicUsize::new(0));
        let entered = Arc::new(AtomicUsize::new(0));
        let probe = Arc::new(GateProbe::new(&probes, &entered));
        let providers = Providers::for_test(vec![probe.clone()]);
        assert!(providers.capability_snapshot().is_empty());
        probe.wait_entered(1);
        providers.refresh_capabilities();
        assert!(providers.capability_snapshot().is_empty(), "a rebuild clears values");
        probe.release();
        wait_for_name(&providers, "probe 2");
        assert_eq!(probes.load(SeqCst), 2, "the rebuild started exactly one new round");
    }

    // A3: an adapter panic publishes a failure, releases waiters and leaves the
    // cache usable (the failed cold probe stays failed, warm values survive).
    #[test]
    fn adapter_panic_publishes_failed_and_releases_waiters() {
        let probes = Arc::new(AtomicUsize::new(0));
        let fail = Arc::new(AtomicBool::new(true));
        let providers = Arc::new(Providers::for_test(vec![Arc::new(FailingProbe {
            inner: SlowProbe::new(&probes), fail: Arc::clone(&fail),
        })]));
        let updates = recorder(&providers);
        // A cold admission call must not hang when the adapter panics.
        let waiting = Arc::clone(&providers);
        let joined = std::thread::spawn(move || waiting.capabilities());
        wait_for_updates(&updates, 1);
        let seen = updates.lock().unwrap().clone();
        assert_eq!(seen[0].outcome, "failed");
        assert_eq!(seen[0].refresh_id, None);
        assert_eq!(joined.join().unwrap(), Vec::<Value>::new(), "admission waiters are released on failure");
        assert_eq!(providers.capability_snapshot_result().unwrap_err().code, "provider_detection_failed");
        assert_eq!(probes.load(SeqCst), 1, "a panicked cold probe is never retried by a read");
        assert_eq!(providers.capability_cache.lock().unwrap().refreshing, None);

        // A warm forced refresh that panics keeps the confirmed values.
        fail.store(false, SeqCst);
        providers.refresh_capabilities();
        assert_eq!(name(&providers.capabilities()), "probe 2");
        fail.store(true, SeqCst);
        let refresh_id = providers.request_capability_refresh();
        wait_for_updates(&updates, 3);
        let seen = updates.lock().unwrap().clone();
        assert_eq!(seen[2].outcome, "failed");
        assert_eq!(seen[2].refresh_id, Some(refresh_id));
        assert_eq!(name(&providers.capability_snapshot()), "probe 2", "a failed warm refresh keeps the previous values");
    }

    // A3: a thread-spawn failure reports failed, clears `refreshing` and lets a
    // later refresh retry.
    #[test]
    fn spawn_failure_publishes_failed_and_clears_refreshing() {
        let probes = Arc::new(AtomicUsize::new(0));
        let providers = Providers::for_test(vec![Arc::new(SlowProbe::new(&probes))]);
        assert_eq!(name(&providers.capabilities()), "probe 1");
        let updates = recorder(&providers);
        providers.fail_next_probe_spawn();
        let refresh_id = providers.request_capability_refresh();
        wait_for_updates(&updates, 1);
        let seen = updates.lock().unwrap().clone();
        assert_eq!(seen[0].outcome, "failed");
        assert_eq!(seen[0].refresh_id, Some(refresh_id));
        assert_eq!(providers.capability_cache.lock().unwrap().refreshing, None);
        assert_eq!(name(&providers.capability_snapshot()), "probe 1", "warm values survive a spawn failure");
        let second = providers.request_capability_refresh();
        wait_for_name(&providers, "probe 2");
        assert!(second > refresh_id);
        assert_eq!(probes.load(SeqCst), 2, "the retry after a spawn failure probes once");
    }

    // A4: a failed cold probe never retries on later reads; an explicit refresh
    // recovers, and a failed warm refresh keeps the previous values.
    #[test]
    fn failed_cold_probe_never_retries_until_an_explicit_refresh() {
        let probes = Arc::new(AtomicUsize::new(0));
        let fail = Arc::new(AtomicBool::new(true));
        let providers = Providers::for_test(vec![Arc::new(FailingProbe {
            inner: SlowProbe::new(&probes), fail: Arc::clone(&fail),
        })]);
        let updates = recorder(&providers);
        let initial = providers.capability_snapshot_result();
        if let Ok(values) = initial { assert!(values.is_empty()); }
        wait_for_updates(&updates, 1);
        assert_eq!(updates.lock().unwrap()[0].outcome, "failed");
        for _ in 0..16 {
            assert_eq!(providers.capability_snapshot_result().unwrap_err().code, "provider_detection_failed");
        }
        assert_eq!(probes.load(SeqCst), 1, "a failed cold probe must not retry on later reads");
        assert!(providers.capabilities().is_empty(), "failed discovery cannot admit an unconfirmed provider");

        fail.store(false, SeqCst);
        let refresh_id = providers.request_capability_refresh();
        wait_for_name(&providers, "probe 2");
        wait_for_updates(&updates, 2);
        let recovered = updates.lock().unwrap().clone();
        assert_eq!(recovered[1].outcome, "ok");
        assert_eq!(recovered[1].refresh_id, Some(refresh_id));

        fail.store(true, SeqCst);
        let warm = providers.request_capability_refresh();
        wait_for_updates(&updates, 3);
        let seen = updates.lock().unwrap().clone();
        assert_eq!(seen[2].outcome, "failed");
        assert_eq!(seen[2].refresh_id, Some(warm));
        assert_eq!(name(&providers.capability_snapshot()), "probe 2");
        for _ in 0..16 { assert_eq!(name(&providers.capability_snapshot()), "probe 2"); }
        assert_eq!(probes.load(SeqCst), 3);
    }

    #[test]
    fn cold_ui_reads_are_pending_and_share_one_probe_with_confirmed_admission() {
        let probes = Arc::new(AtomicUsize::new(0));
        let providers = Arc::new(Providers::for_test(vec![Arc::new(SlowProbe::new(&probes))]));
        let (notified, notification) = std::sync::mpsc::sync_channel(1);
        let observer = Arc::downgrade(&providers);
        providers.set_capability_listener(Arc::new(move |_update| {
            let providers = observer.upgrade().unwrap();
            // Publication must not hold the cache: snapshot readers can re-enter.
            let current = providers.capability_snapshot();
            notified.send(name(&current) == "probe 1").unwrap();
        }));
        let started = Instant::now();
        for _ in 0..16 { assert!(providers.capability_snapshot().is_empty()); }
        assert!(started.elapsed() < Duration::from_millis(200), "cold snapshots waited for a native capability probe");
        let waiting = Arc::clone(&providers);
        let admission = std::thread::spawn(move || waiting.capabilities());
        assert!(notification.recv_timeout(Duration::from_secs(5)).unwrap());
        assert_eq!(name(&admission.join().unwrap()), "probe 1");
        assert_eq!(name(&providers.capability_snapshot()), "probe 1");
        assert_eq!(probes.load(SeqCst), 1, "cold UI and admission duplicated probes");
        assert!(notification.try_recv().is_err(), "completion was published more than once");
    }

    #[test]
    fn invalidation_between_pending_snapshot_and_admission_wait_restarts_current_probe() {
        let probes = Arc::new(AtomicUsize::new(0));
        let providers = Providers::for_test(vec![Arc::new(SlowProbe::new(&probes))]);
        let generation = providers.capability_cache.lock().unwrap().generation;
        assert!(providers.capability_snapshot().is_empty());
        let deadline = Instant::now() + Duration::from_secs(5);
        while probes.load(SeqCst) != 1 && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(1)); }
        assert_eq!(probes.load(SeqCst), 1);
        // Exact reviewed interleaving: a queued invalidation clears the old
        // refreshing flag before the admission reader acquires the cache.
        providers.refresh_capabilities();
        let values = providers.confirmed_capabilities(generation);
        assert_eq!(name(&values), "probe 2");
        assert_eq!(probes.load(SeqCst), 2);
        assert_eq!(name(&providers.capability_snapshot()), "probe 2");
    }
}

#[cfg(test)]
mod delegation_tool_tests {
    use super::*;

    #[test]
    fn only_exact_delegation_tool_names_are_threadterm_tools() {
        assert!(is_threadterm_tool("mcp__threadterm__delegate_start"));
        assert!(is_threadterm_tool("threadterm__delegate_wait"));
        assert!(!is_threadterm_tool("mcp__threadterm__terminal_create"));
        assert!(!is_threadterm_tool("mcp__threadterm__delegate_start; rm -rf ."));
        assert!(!is_threadterm_tool("Shell: mcp__threadterm__delegate_start"));
        assert!(!is_threadterm_tool("mcp__other__delegate_start"));
        assert!(is_threadterm_tool("mcp__threadterm__ask_user"));
        assert!(is_threadterm_tool("threadterm__session_info"));
        assert!(is_threadterm_tool("mcp__threadterm__feedback_check"));
        assert!(!is_threadterm_tool("mcp__threadterm__ask_user; rm -rf ."));
    }

    #[test]
    fn acp_servers_carry_the_session_identity_as_name_value_env() {
        assert_eq!(acp_mcp_servers(None), json!([]));
        let tools = ChatToolServer {
            name: "threadterm".into(),
            command: "C:/rt/threadterm-v3-mcp.exe".into(),
            args: Vec::new(),
            env: vec![("THREADTERM_SESSION_ID".into(), "s-1".into())],
        };
        assert_eq!(
            acp_mcp_servers(Some(&tools)),
            json!([{"name":"threadterm","command":"C:/rt/threadterm-v3-mcp.exe","args":[],"env":[{"name":"THREADTERM_SESSION_ID","value":"s-1"}]}])
        );
    }

    #[test]
    fn acp_permissions_for_delegation_tools_pick_allow_once_only() {
        let request = |title: &str, kind: &str| {
            json!({"toolCall":{"title":title,"kind":kind},"options":[
                {"optionId":"approve_once","kind":"allow_once"},
                {"optionId":"approve_always","kind":"allow_always"},
                {"optionId":"reject","kind":"reject_once"}
            ]})
        };
        assert_eq!(
            acp_threadterm_permission_option(&request("mcp__threadterm__delegate_start", "other")),
            Some("approve_once".into())
        );
        assert_eq!(
            acp_threadterm_permission_option(&request("threadterm__delegate_wait", "other")),
            Some("approve_once".into())
        );
        assert_eq!(
            acp_threadterm_permission_option(&request("mcp__threadterm__delegate_start", "execute")),
            None,
            "a shell call is never auto-approved, whatever its title"
        );
        assert_eq!(
            acp_threadterm_permission_option(&request("mcp__codegraph__search", "other")),
            None
        );
        let no_once = json!({"toolCall":{"title":"mcp__threadterm__delegate_start","kind":"other"},"options":[{"optionId":"approve_always","kind":"allow_always"}]});
        assert_eq!(acp_threadterm_permission_option(&no_once), None);
    }

    #[test]
    fn scoped_permissions_never_approve_a_disabled_app_tool() {
        let request = json!({"toolCall":{"title":"mcp__threadterm__ask_user","kind":"other"},"options":[{"optionId":"once","kind":"allow_once"}]});
        assert_eq!(acp_scoped_permission_option(&request, &ChatToolPolicy { delegation: true, ..Default::default() }), None);
        assert_eq!(acp_scoped_permission_option(&request, &ChatToolPolicy { ask: true, ..Default::default() }), Some("once".into()));
        let shell = json!({"toolCall":{"title":"mcp__threadterm__ask_user","kind":"execute"},"options":[{"optionId":"once","kind":"allow_once"}]});
        assert_eq!(acp_scoped_permission_option(&shell, &ChatToolPolicy { ask: true, ..Default::default() }), None);
    }

    #[test]
    fn scoped_permissions_keep_preview_exact_and_never_prefix_match() {
        let request = |title: &str, kind: &str| json!({"toolCall":{"title":title,"kind":kind},"options":[{"optionId":"once","kind":"allow_once"}]});
        let policy = ChatToolPolicy { preview: true, ..Default::default() };
        assert_eq!(acp_scoped_permission_option(&request("mcp__threadterm__preview_present", "other"), &policy), Some("once".into()));
        assert_eq!(acp_scoped_permission_option(&request("threadterm__preview_status", "other"), &policy), Some("once".into()));
        assert_eq!(acp_scoped_permission_option(&request("mcp__threadterm__preview_present", "other"), &ChatToolPolicy::default()), None);
        assert_eq!(acp_scoped_permission_option(&request("mcp__threadterm__preview_present_extra", "other"), &policy), None);
        assert_eq!(acp_scoped_permission_option(&request("mcp__threadterm__preview_present", "execute"), &policy), None);
    }
}
