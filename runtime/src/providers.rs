//! Native provider adapters for structured Chat and provider-owned history.
//!
//! Terminal mode is intentionally separate: this module only returns an
//! executable specification for the PTY owner. Chat workers use native
//! machine-readable protocols and never parse terminal output.

mod acp;
mod approval;
mod claude;
mod codex;
pub(crate) mod common;
mod grok;
mod kimi_plan_usage;
pub(crate) mod network;
mod opencode;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex, RwLock},
    time::{Duration, Instant},
};
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

/// True only for the exact names agents give ThreadTerm's own delegation tools
/// (`mcp__threadterm__<tool>` for Claude and Kimi, `threadterm__<tool>` for
/// Grok). Never a prefix match: a shell command titled with the prefix must
/// still go through normal approval.
pub(crate) fn is_threadterm_tool(name: &str) -> bool {
    name.strip_prefix("mcp__threadterm__")
        .or_else(|| name.strip_prefix("threadterm__"))
        .is_some_and(|tool| crate::delegation::TOOL_NAMES.contains(&tool))
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

/// Answers an ACP permission request for one of ThreadTerm's delegation tools
/// with its once-only allow option (Kimi, Gemini, Grok parent Chats only).
/// Returns false, leaving normal handling, for anything else.
pub(crate) fn approve_threadterm_tool(
    responder: &Mutex<Option<common::JsonLineResponder>>,
    raw: &Value,
) -> bool {
    if raw.get("method").and_then(Value::as_str) != Some("session/request_permission") {
        return false;
    }
    let (Some(id), Some(option)) = (
        raw.get("id"),
        raw.get("params").and_then(acp_threadterm_permission_option),
    ) else {
        return false;
    };
    let Ok(slot) = responder.lock() else {
        return false;
    };
    slot.as_ref().is_some_and(|responder| {
        responder
            .respond(id.clone(), json!({"outcome":{"outcome":"selected","optionId":option}}))
            .is_ok()
    })
}

pub const SUPPORTED_PROVIDERS: [&str; 6] =
    ["codex", "claude", "kimi", "gemini", "opencode", "grok"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
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
    fn chat_options(&self, session_id: &str) -> Result<Value, ProviderError>;
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
    fn id(&self) -> &'static str;
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
    fn cancel(&mut self, turn_id: &str) -> Result<(), ProviderError>;
    fn approve(
        &mut self,
        turn_id: &str,
        approval_id: &str,
        choice_id: &str,
        operation_id: &str,
    ) -> Result<(), ProviderError>;
    fn stop(&mut self) -> Result<(), ProviderError>;
    fn ui_state(&self) -> Value {
        json!({"options":[],"commands":[]})
    }
    fn set_option(&mut self, _option_id: &str, _value: &str) -> Result<Value, ProviderError> {
        Err(ProviderError::new(
            "chat_options_unsupported",
            "This provider does not expose live model options",
        ))
    }
}

type SharedChat = Arc<Mutex<Box<dyn ChatSession>>>;

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
    adapters: HashMap<&'static str, Arc<dyn ProviderAdapter>>,
    chats: Mutex<HashMap<String, ChatSlot>>,
    connect_wait: Condvar,
    capability_cache: Arc<Mutex<CapabilityCache>>,
    events: broadcast::Sender<ProviderEvent>,
    network: network::NetworkSettings,
    tool_servers: RwLock<Option<ToolServerResolver>>,
}

/// Last provider capability probe. Probing runs every provider CLI and takes
/// seconds, while `runtime.snapshot`/`provider.list` share the ordered request
/// lane with `chat.send`. After expiry, callers get the previous values while
/// one background thread re-probes, so a send never queues behind the probes.
#[derive(Default)]
struct CapabilityCache {
    values: Option<(Instant, Vec<Value>)>,
    refreshing: bool,
    /// Bumped by `refresh_capabilities`; an older background probe is discarded.
    generation: u64,
}

const CAPABILITY_TTL: Duration = Duration::from_secs(30);

fn probe_capabilities(adapters: &[Arc<dyn ProviderAdapter>]) -> Vec<Value> {
    adapters
        .iter()
        .filter_map(|adapter| serde_json::to_value(adapter.capability()).ok())
        .collect()
}

impl Providers {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(1_024);
        let network = network::NetworkSettings::default();
        let adapters: Vec<Arc<dyn ProviderAdapter>> = vec![
            Arc::new(codex::CodexAdapter::new(events.clone())),
            Arc::new(claude::ClaudeAdapter::new(events.clone())),
            Arc::new(acp::AcpAdapter::kimi(events.clone())),
            Arc::new(acp::AcpAdapter::gemini(events.clone())),
            Arc::new(opencode::OpenCodeAdapter::new(events.clone())),
            Arc::new(grok::GrokAdapter::new(events.clone(), network.clone())),
        ];
        Self::from_adapters(events, adapters, network)
    }

    fn from_adapters(
        events: broadcast::Sender<ProviderEvent>,
        adapters: Vec<Arc<dyn ProviderAdapter>>,
        network: network::NetworkSettings,
    ) -> Self {
        Self {
            adapters: adapters
                .into_iter()
                .map(|adapter| (adapter.id(), adapter))
                .collect(),
            chats: Mutex::new(HashMap::new()),
            connect_wait: Condvar::new(),
            capability_cache: Arc::new(Mutex::new(CapabilityCache::default())),
            events,
            network,
            tool_servers: RwLock::new(None),
        }
    }

    /// Installed once by the runtime service; consulted on every Chat open.
    pub fn set_tool_server_resolver(&self, resolver: ToolServerResolver) {
        if let Ok(mut slot) = self.tool_servers.write() {
            *slot = Some(resolver);
        }
    }

    fn tool_server(&self, session_id: &str, provider: &str) -> Option<ChatToolServer> {
        let resolver = self.tool_servers.read().ok()?.clone()?;
        resolver(session_id, provider)
    }

    #[cfg(test)]
    pub(crate) fn for_test(adapters: Vec<Arc<dyn ProviderAdapter>>) -> Self {
        let (events, _) = broadcast::channel(1_024);
        Self::from_adapters(events, adapters, network::NetworkSettings::default())
    }

    pub fn configure_network(&self, settings: &Value) -> Result<(), ProviderError> {
        self.network.update(settings)
    }

    /// Invalidates executable/auth probes. The normal snapshot path uses a
    /// short-lived cache; setup UI can call this after login or installation.
    pub fn refresh_capabilities(&self) {
        if let Ok(mut cache) = self.capability_cache.lock() {
            cache.values = None;
            cache.refreshing = false;
            cache.generation += 1;
        }
    }

    fn supported_adapters(&self) -> Vec<Arc<dyn ProviderAdapter>> {
        SUPPORTED_PROVIDERS
            .iter()
            .filter_map(|id| self.adapters.get(id).cloned())
            .collect()
    }

    fn adapter(&self, provider: &str) -> Result<&Arc<dyn ProviderAdapter>, ProviderError> {
        self.adapters.get(provider).ok_or_else(|| {
            ProviderError::new(
                "unsupported_provider",
                format!("{provider} has no structured Chat adapter"),
            )
        })
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
        let mut chat = chat
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "session worker lock poisoned"))?;
        call(chat.as_mut())
    }

    pub fn chat_is_open(&self, session_id: &str) -> bool {
        self.worker_handle(session_id).is_ok()
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
        // Serialize validation, persistence and dispatch with other writes to
        // this worker. A rejected local command must not become the UI's most
        // recent turn or complete the active reply's streaming parts.
        let result = self.chat(session_id, |chat| {
            chat.validate_send(text)?;
            chat.validate_send_with_images(text, images)?;
            record()?;
            chat.send_with_images(text, images, operation_id)
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

impl ProviderRuntime for Providers {
    fn capabilities(&self) -> Vec<Value> {
        if let Ok(mut cache) = self.capability_cache.lock() {
            if let Some((created, values)) = cache.values.as_ref() {
                let values = values.clone();
                if created.elapsed() >= CAPABILITY_TTL && !cache.refreshing {
                    cache.refreshing = true;
                    let generation = cache.generation;
                    let shared = Arc::clone(&self.capability_cache);
                    let adapters = self.supported_adapters();
                    let spawned = std::thread::Builder::new()
                        .name("provider-capabilities".into())
                        .spawn(move || {
                            let fresh = probe_capabilities(&adapters);
                            if let Ok(mut cache) = shared.lock() {
                                if cache.generation == generation {
                                    cache.values = Some((Instant::now(), fresh));
                                    cache.refreshing = false;
                                }
                            }
                        });
                    if spawned.is_err() {
                        cache.refreshing = false;
                    }
                }
                return values;
            }
        }
        // First probe, or the first after an explicit refresh: callers need real
        // values, so this one runs synchronously.
        let values = probe_capabilities(&self.supported_adapters());
        if let Ok(mut cache) = self.capability_cache.lock() {
            cache.values = Some((Instant::now(), values.clone()));
        }
        values
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
        let opened =
            adapter.open_chat_with_tools(session_id, cwd, native_id, &worker_token, tools.as_ref());
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
        let worker = slot.worker.take();
        // An explicit stop invalidates even notifications queued by a worker
        // whose startup has not returned. Natural EOF keeps its token until
        // replacement so already-queued final error/expiry events can settle.
        slot.worker_token = None;
        let _ = slot.mark_disconnected();
        let state = slot.wire(session_id, "unknown", None);
        drop(chats);
        self.connect_wait.notify_all();
        self.emit_connection(session_id, state);
        let Some(worker) = worker else {
            return Ok(());
        };
        let mut worker = worker
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "session worker lock poisoned"))?;
        worker.stop()
    }

    fn chat_options(&self, session_id: &str) -> Result<Value, ProviderError> {
        match self.chat(session_id, |chat| Ok(chat.ui_state())) {
            Ok(mut value) => {
                if value.get("loadState").is_none() {
                    let empty_options = value
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|items| items.is_empty())
                        .unwrap_or(true);
                    value["loadState"] = json!(if empty_options { "empty" } else { "ready" });
                }
                Ok(value)
            }
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
    events: broadcast::Sender<ProviderEvent>,
    worker_token: String,
}

impl ScopedProviderEvents {
    pub(crate) fn new(events: broadcast::Sender<ProviderEvent>, worker_token: &str) -> Self {
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
    events: &broadcast::Sender<ProviderEvent>,
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
    events: &broadcast::Sender<ProviderEvent>,
    provider: &str,
    session_id: &str,
    native_id: Option<&str>,
    turn_id: Option<&str>,
    kind: &str,
    data: Value,
    worker_token: Option<&str>,
) {
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
    fn every_production_adapter_fences_late_events_after_reconnect_and_stop() {
        let providers = Providers::new();
        assert_eq!(providers.adapters.len(), 6);
        let mut receiver = providers.events.subscribe();
        for (provider, adapter) in &providers.adapters {
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
}

#[cfg(test)]
mod capability_cache_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};

    /// A provider whose capability probe is slow and numbered.
    struct SlowProbe {
        probes: Arc<AtomicUsize>,
    }

    impl ProviderAdapter for SlowProbe {
        fn id(&self) -> &'static str {
            "codex"
        }
        fn capability(&self) -> ProviderCapability {
            let probe = self.probes.fetch_add(1, SeqCst) + 1;
            std::thread::sleep(Duration::from_millis(300));
            ProviderCapability {
                id: "codex".into(),
                name: format!("probe {probe}"),
                installed: true,
                version: None,
                terminal: false,
                chat: false,
                history: false,
                resume: false,
                terminal_resume_capture: "none",
                reason: None,
                auth: "unknown".into(),
            }
        }
        fn terminal_command(
            &self,
            _: Option<&str>,
            _: Option<&str>,
        ) -> Result<TerminalCommand, ProviderError> {
            Err(ProviderError::new("unsupported", "capability fixture"))
        }
        fn history_list(
            &self,
            _: Option<&str>,
            _: u32,
            _: Option<&str>,
        ) -> Result<Value, ProviderError> {
            Ok(json!({}))
        }
        fn history_read(&self, _: &str) -> Result<Value, ProviderError> {
            Ok(json!([]))
        }
        fn open_chat(
            &self,
            _: &str,
            _: &str,
            _: Option<&str>,
        ) -> Result<Box<dyn ChatSession>, ProviderError> {
            Err(ProviderError::new("unsupported", "capability fixture"))
        }
    }

    fn name(values: &[Value]) -> String {
        values[0]["name"].as_str().unwrap().to_owned()
    }

    fn expire(providers: &Providers) {
        let expired = Instant::now()
            .checked_sub(CAPABILITY_TTL + Duration::from_secs(1))
            .unwrap();
        let mut cache = providers.capability_cache.lock().unwrap();
        cache.values.as_mut().unwrap().0 = expired;
    }

    #[test]
    fn expired_capabilities_answer_immediately_and_refresh_once_in_the_background() {
        let probes = Arc::new(AtomicUsize::new(0));
        let providers = Providers::for_test(vec![Arc::new(SlowProbe {
            probes: Arc::clone(&probes),
        })]);
        // First probe is synchronous; fresh values are cached.
        assert_eq!(name(&providers.capabilities()), "probe 1");
        assert_eq!(name(&providers.capabilities()), "probe 1");
        assert_eq!(probes.load(SeqCst), 1);

        // Expired values still answer, without waiting for the probes.
        expire(&providers);
        let started = Instant::now();
        assert_eq!(name(&providers.capabilities()), "probe 1");
        assert_eq!(name(&providers.capabilities()), "probe 1");
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "an expired cache must not make the caller wait for the probes"
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while name(&providers.capabilities()) != "probe 2" && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(name(&providers.capabilities()), "probe 2");
        // Repeated expired reads started a single refresh.
        assert_eq!(probes.load(SeqCst), 2);

        // An explicit refresh probes synchronously; the in-flight background
        // probe it superseded must not overwrite the newer values later.
        expire(&providers);
        let _ = providers.capabilities();
        providers.refresh_capabilities();
        let current = name(&providers.capabilities());
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(probes.load(SeqCst), 4);
        assert_eq!(name(&providers.capabilities()), current);
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
}
