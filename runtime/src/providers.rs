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
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::broadcast;

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
    capability_cache: Mutex<Option<(Instant, Vec<Value>)>>,
    events: broadcast::Sender<ProviderEvent>,
    network: network::NetworkSettings,
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
            capability_cache: Mutex::new(None),
            events,
            network,
        }
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
            *cache = None;
        }
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
        operation_id: &str,
        record: impl FnOnce() -> Result<(), ProviderError>,
    ) -> Result<Value, ProviderError> {
        if text.trim().is_empty() {
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
            record()?;
            chat.send(text, operation_id)
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
        const CAPABILITY_TTL: Duration = Duration::from_secs(30);
        if let Ok(cache) = self.capability_cache.lock() {
            if let Some((created, values)) = cache.as_ref() {
                if created.elapsed() < CAPABILITY_TTL {
                    return values.clone();
                }
            }
        }
        let values = SUPPORTED_PROVIDERS
            .iter()
            .filter_map(|id| self.adapters.get(id))
            .filter_map(|adapter| serde_json::to_value(adapter.capability()).ok())
            .collect::<Vec<_>>();
        if let Ok(mut cache) = self.capability_cache.lock() {
            *cache = Some((Instant::now(), values.clone()));
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

        let opened = adapter.open_chat_scoped(session_id, cwd, native_id, &worker_token);
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
        self.chat_send_recording(session_id, text, operation_id, || Ok(()))
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
