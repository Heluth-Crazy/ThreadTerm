use super::{
    approval::{allow_deny_choices, approval_payload, map_allow_deny_choice},
    common::{
        command_output, find_executable, history_page, insert_optional, spawn_managed_service,
        validate_native_id, version_probe, CommandSpec,
    },
    emit_scoped, ChatSession, ProviderAdapter, ProviderCapability, ProviderError,
    TerminalCommand,
};
use crate::chat_questions::answer_summary;
use base64::Engine;
use chrono::{TimeZone, Utc};
use rand::RngCore;
use reqwest::blocking::{Client, Response};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{self, BufRead, BufReader},
    net::TcpListener,
    process::Child,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
#[cfg(test)]
use super::ProviderEvent;
#[cfg(test)]
use tokio::sync::broadcast;

pub struct OpenCodeAdapter {
    events: crate::provider_events::Sender,
}
impl OpenCodeAdapter {
    pub fn new(events: crate::provider_events::Sender) -> Self {
        Self { events }
    }
}

impl ProviderAdapter for OpenCodeAdapter {
    fn id(&self) -> &'static str {
        "opencode"
    }
    fn capability(&self) -> ProviderCapability {
        let (installed, version, probe_error) = version_probe("opencode");
        let auth = if installed {
            CommandSpec::provider("opencode", &["auth", "list"])
                .and_then(|spec| command_output(&spec, Duration::from_secs(5)))
                .map(|output| {
                    if output.contains("0 credentials") {
                        "unauthenticated"
                    } else {
                        "unknown"
                    }
                })
                .unwrap_or("unknown")
                .to_owned()
        } else {
            "unknown".to_owned()
        };
        ProviderCapability {
            source: "builtin",
            plugin_id: None,
            icon: None,
            sign_in: super::builtin_sign_in("opencode"),
            homepage: None,
            id: "opencode".to_owned(),
            name: super::builtin_name("opencode").to_owned(),
            installed,
            version,
            terminal: installed,
            chat: installed && auth != "unauthenticated",
            history: installed,
            resume: installed,
            terminal_resume_capture: self.terminal_capture().as_str(),
            reason: if installed {
                probe_error
            } else {
                probe_error.or_else(|| Some("OpenCode CLI is not installed".to_owned()))
            },
            auth,
        }
    }

    fn terminal_command(
        &self,
        resume_id: Option<&str>,
        assign_id: Option<&str>,
    ) -> Result<TerminalCommand, ProviderError> {
        let mut args = Vec::new();
        if let Some(id) = resume_id.or(assign_id) {
            validate_native_id(id)?;
            args.extend(["--session".to_owned(), id.to_owned()]);
        }
        let path = find_executable("opencode").ok_or_else(|| {
            ProviderError::unavailable("opencode", "OpenCode executable was not found on PATH")
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

    fn prepare_terminal(&self, cwd: &str) -> Result<Option<String>, ProviderError> {
        // Create through the authenticated local native API. No prompt/turn
        // is sent, and the terminal subsequently opens this exact session.
        let server = OpenCodeServer::start(cwd, "terminal-prepare", crate::provider_events::tap_channel(1).0, "")?;
        let session =
            server.json(server.request(reqwest::Method::POST, "/session", Some(json!({})))?)?;
        let id = session.get("id").and_then(Value::as_str).ok_or_else(|| {
            ProviderError::new("provider_protocol", "OpenCode returned no session id")
        })?;
        validate_native_id(id)?;
        Ok(Some(id.to_owned()))
    }

    fn fork_session(&self, cwd: &str, native_id: &str, anchor: Option<&crate::domain::NativeForkAnchor>, is_latest: bool) -> Result<Option<String>, ProviderError> {
        validate_native_id(native_id)?;
        let server = OpenCodeServer::start(cwd, "native-fork", self.events.clone(), "")?;
        let messages = if anchor.is_some() {
            server.json(server.request(reqwest::Method::GET, &format!("/session/{native_id}/message"), None)?)?
        } else { json!([]) };
        let Some(body) = opencode_fork_body(native_id, anchor, is_latest, &messages)? else { return Ok(None) };
        let response = match server.request(reqwest::Method::POST, &format!("/session/{native_id}/fork"), Some(body)) {
            Ok(response) => response,
            Err(error) if error.details.as_ref().and_then(|details| details["httpStatus"].as_u64()).is_some_and(|status| matches!(status, 404 | 405 | 501)) => return Ok(None),
            Err(error) => return Err(ProviderError::new("operation_outcome_unknown", format!("OpenCode fork was not confirmed; do not retry this operation: {}", error.message))),
        };
        let result = server.json(response).map_err(|error| ProviderError::new("operation_outcome_unknown", error.message))?;
        let id = result.get("id").and_then(Value::as_str).filter(|id| *id != native_id)
            .ok_or_else(|| ProviderError::new("operation_outcome_unknown", "OpenCode fork returned no distinct session identity"))?;
        validate_native_id(id).map_err(|error| ProviderError::new("operation_outcome_unknown", error.message))?;
        Ok(Some(id.to_owned()))
    }
    fn history_list(
        &self,
        cursor: Option<&str>,
        limit: u32,
        cwd: Option<&str>,
    ) -> Result<Value, ProviderError> {
        let offset = cursor
            .map(str::parse::<usize>)
            .transpose()
            .map_err(|_| {
                ProviderError::new("invalid_cursor", "OpenCode history cursor is invalid")
            })?
            .unwrap_or(0);
        let spec = CommandSpec::provider(
            "opencode",
            &[
                "session",
                "list",
                "--format",
                "json",
                "--max-count",
                "10000",
                "--pure",
            ],
        )?;
        let output = command_output(&spec, Duration::from_secs(15))?;
        let value: Value = serde_json::from_str(&output).map_err(|error| {
            ProviderError::new(
                "provider_protocol",
                format!("OpenCode returned invalid session JSON: {error}"),
            )
        })?;
        let rows = value
            .as_array()
            .or_else(|| value.get("sessions").and_then(Value::as_array))
            .cloned()
            .unwrap_or_default();
        let filtered = rows
            .into_iter()
            .filter_map(|row| opencode_history_item(&row, cwd))
            .collect::<Vec<_>>();
        let filtered_total = filtered.len();
        let items = filtered
            .into_iter()
            .skip(offset)
            .take(limit as usize)
            .collect::<Vec<_>>();
        let next = if offset + items.len() < filtered_total {
            Some((offset + items.len()).to_string())
        } else {
            None
        };
        Ok(history_page(items, next.map(Value::String)))
    }

    fn history_read(&self, native_id: &str) -> Result<Value, ProviderError> {
        validate_native_id(native_id)?;
        let spec = CommandSpec::provider("opencode", &["export", native_id, "--pure"])?;
        let output = command_output(&spec, Duration::from_secs(30))?;
        let raw: Value = serde_json::from_str(&output).map_err(|error| {
            ProviderError::new(
                "provider_protocol",
                format!("OpenCode returned invalid export JSON: {error}"),
            )
        })?;
        Ok(Value::Array(opencode_transcript(&raw)))
    }

    fn open_chat(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        self.open_chat_scoped(session_id, cwd, native_id, "")
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
        if let Some(id) = native_id {
            validate_native_id(id)?;
        }
        let server = OpenCodeServer::start(cwd, session_id, self.events.clone(), worker_token)?;
        let session = if let Some(id) = native_id {
            server.json(server.request(reqwest::Method::GET, &format!("/session/{id}"), None)?)?
        } else {
            server.json(server.request(reqwest::Method::POST, "/session", Some(json!({})))?)?
        };
        let native_id = session
            .get("id")
            .and_then(Value::as_str)
            .or(native_id)
            .ok_or_else(|| {
                ProviderError::new("provider_protocol", "OpenCode returned no session id")
            })?
            .to_owned();
        // The event stream binds only after the native identity is known; a
        // failed event channel fails the connect instead of leaving a blind
        // "ready" worker behind.
        let sse_target = server.attach_events(&native_id)?;
        let ui = sse_target.ui.lock().map(|ui| ui.wire()).unwrap_or_else(|_| json!({"options":[],"commands":[]}));
        emit_scoped(&self.events, "opencode", session_id, Some(&native_id), None, "chat.ui", ui, Some(worker_token));
        emit_scoped(
            &self.events,
            "opencode",
            session_id,
            Some(&native_id),
            None,
            "session.ready",
            json!({"nativeId":native_id}),
            Some(worker_token),
        );
        Ok(Box::new(OpenCodeChat {
            server,
            session_id: session_id.to_owned(),
            native_id,
            events: self.events.clone(),
            sse_target,
            worker_token: worker_token.to_owned(),
        }))
    }
}

struct OpenCodeServer {
    base_url: String,
    cwd: String,
    username: String,
    password: String,
    client: Client,
    child: Arc<Mutex<Child>>,
    stopped: Arc<AtomicBool>,
    event_gate: Arc<Mutex<()>>,
    active_turn: Arc<Mutex<Option<String>>>,
    permissions: Arc<Mutex<HashMap<String, OpenCodeInteraction>>>,
    events: crate::provider_events::Sender,
    threadterm_session: String,
    worker_token: String,
    _job: crate::job::SessionJob,
}

/// The turn marker used when a reconnect finds the native session still busy.
/// It blocks new sends until the native turn finishes; it is never a real
/// ThreadTerm turn id.
const NATIVE_BUSY_TURN: &str = "native-busy";
const MAX_ASSEMBLED_MESSAGES: usize = 128;
const MAX_ASSEMBLED_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;
// OpenCode 1.18.31 emits a complete `server.heartbeat` SSE frame every 10s,
// including while no model output is produced. Three missed beats plus slack
// means the stream is unusable, not that a model turn has completed.
const SSE_EVENT_SILENCE_LIMIT: Duration = Duration::from_secs(35);
const SSE_WATCHDOG_POLL: Duration = Duration::from_secs(1);
const MAX_SSE_LINE_BYTES: usize = 8 * 1024 * 1024;

impl OpenCodeServer {
    fn start(
        cwd: &str,
        threadterm_session: &str,
        events: crate::provider_events::Sender,
        worker_token: &str,
    ) -> Result<Self, ProviderError> {
        let port = TcpListener::bind(("127.0.0.1", 0))
            .and_then(|listener| listener.local_addr())
            .map_err(|error| ProviderError::new("provider_launch_failed", error.to_string()))?
            .port();
        let mut random = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut random);
        let password = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random);
        let username = "threadterm".to_owned();
        let spec = CommandSpec::provider(
            "opencode",
            &[
                "serve",
                "--hostname",
                "127.0.0.1",
                "--port",
                &port.to_string(),
            ],
        )?;
        let (mut child, job) = spawn_managed_service(
            &spec,
            Some(cwd),
            &[
                ("OPENCODE_SERVER_USERNAME", &username),
                ("OPENCODE_SERVER_PASSWORD", &password),
            ],
        )?;
        if let Some(stdout) = child.stdout.take() {
            thread::spawn(move || for _ in BufReader::new(stdout).lines() {});
        }
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    eprintln!("[opencode-server] {line}");
                }
            });
        }
        let child = Arc::new(Mutex::new(child));
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|error| ProviderError::new("provider_internal", error.to_string()))?;
        let base_url = format!("http://127.0.0.1:{port}");
        let started = Instant::now();
        loop {
            if let Ok(response) = client
                .get(format!("{base_url}/global/health"))
                .basic_auth(&username, Some(&password))
                .send()
            {
                if response.status().is_success() {
                    break;
                }
            }
            if started.elapsed() >= Duration::from_secs(10) {
                if let Ok(mut child) = child.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                return Err(ProviderError::new(
                    "provider_launch_failed",
                    "OpenCode server did not become healthy",
                ));
            }
            thread::sleep(Duration::from_millis(50));
        }
        let stopped = Arc::new(AtomicBool::new(false));
        let event_gate = Arc::new(Mutex::new(()));
        let active_turn = Arc::new(Mutex::new(None));
        let permissions = Arc::new(Mutex::new(HashMap::new()));
        Ok(Self {
            base_url,
            cwd: cwd.to_owned(),
            username,
            password,
            client,
            child,
            stopped,
            event_gate,
            active_turn,
            permissions,
            events,
            threadterm_session: threadterm_session.to_owned(),
            worker_token: worker_token.to_owned(),
            _job: job,
        })
    }

    /// Binds the event stream to an already-known native session id. The SSE
    /// connection is established synchronously (bounded), the message assembly
    /// is seeded from the native message log so late part updates for existing
    /// messages stay complete, and a natively busy session blocks new sends
    /// through a sentinel turn until its idle event arrives.
    fn attach_events(&self, native_id: &str) -> Result<Arc<EventTarget>, ProviderError> {
        // `connect_timeout` only covers TCP establishment. A peer can accept
        // TCP yet never send SSE headers, so bound this handshake separately.
        // The Response is then read without a total timeout: normal SSE turns
        // can remain open far longer than the header deadline.
        let (sender, receiver) = mpsc::sync_channel(1);
        let base_url = self.base_url.clone();
        let username = self.username.clone();
        let password = self.password.clone();
        let directory = self.cwd.clone();
        thread::Builder::new()
            .name(format!(
                "opencode-sse-handshake-{}",
                self.threadterm_session
            ))
            .spawn(move || {
                let response = Client::builder()
                    .connect_timeout(Duration::from_secs(3))
                    // Reqwest blocking otherwise applies an implicit 30s
                    // per-read timeout. The complete-frame watchdog below
                    // must own liveness; comments/partial frames cannot
                    // refresh it merely by delivering transport bytes.
                    .timeout(None)
                    .build()
                    .map_err(|error| error.to_string())
                    .and_then(|client| {
                        client
                            .get(format!("{base_url}/global/event"))
                            .basic_auth(&username, Some(&password))
                            .query(&[("directory", &directory)])
                            .send()
                            .map_err(|error| error.to_string())
                    });
                let _ = sender.send(response);
            })
            .map_err(|error| {
                ProviderError::new(
                    "provider_internal",
                    format!("OpenCode event handshake could not start: {error}"),
                )
            })?;
        let response = receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|error| {
                ProviderError::new(
                    "provider_disconnected",
                    format!("OpenCode event stream headers were not received: {error}"),
                )
            })?
            .map_err(|error| {
                ProviderError::new(
                    "provider_disconnected",
                    format!("OpenCode event stream failed to connect: {error}"),
                )
            })?;
        if !response.status().is_success() {
            return Err(ProviderError::new(
                "provider_disconnected",
                format!("OpenCode event stream returned {}", response.status()),
            ));
        }

        let assembly = Arc::new(Mutex::new(OpenCodeAssembly::default()));
        // Seed recent message identities before reading buffered SSE events.
        // Existing messages must be refreshed from native snapshots: a delta
        // buffered during this fetch may already be included in its result.
        let messages = self.json(self.request(
            reqwest::Method::GET,
            &format!("/session/{native_id}/message?limit={MAX_ASSEMBLED_MESSAGES}"),
            None,
        )?)?;
        assembly
            .lock()
            .map_err(|_| {
                ProviderError::new(
                    "provider_internal",
                    "OpenCode message assembly lock poisoned",
                )
            })?
            .seed(&messages, native_id)?;
        // A native turn that is still running must not see a second local turn.
        let statuses = self.json(self.request(reqwest::Method::GET, "/session/status", None)?)?;
        let status_map = statuses.as_object().ok_or_else(|| {
            ProviderError::new(
                "provider_protocol",
                "OpenCode native session status is not a map",
            )
        })?;
        // OpenCode 1.18.31 omits idle sessions from this map. The exact
        // session was validated by GET /session/{id} before subscribing.
        let kind = match status_map.get(native_id) {
            None => "idle",
            Some(status) => status.get("type").and_then(Value::as_str).ok_or_else(|| {
                ProviderError::new(
                    "provider_protocol",
                    "OpenCode native session status has no type",
                )
            })?,
        };
        if kind == "busy" || kind == "retry" {
            *self.active_turn.lock().map_err(|_| {
                ProviderError::new("provider_internal", "OpenCode turn lock poisoned")
            })? = Some(NATIVE_BUSY_TURN.to_owned());
            emit_scoped(
                &self.events,
                "opencode",
                &self.threadterm_session,
                Some(native_id),
                Some(NATIVE_BUSY_TURN),
                "chat.turn.started",
                json!({"resumedNativeTurn":true}),
                Some(&self.worker_token),
            );
        } else if kind != "idle" {
            return Err(ProviderError::new(
                "provider_protocol",
                format!("OpenCode reported unsupported native session state {kind}"),
            ));
        }

        let catalogue = self.request(reqwest::Method::GET, "/provider", None).and_then(|response| self.json(response));
        let agents = self.request(reqwest::Method::GET, "/agent", None).and_then(|response| self.json(response));
        let model_limits = catalogue.as_ref().map(opencode_provider_context_limits).unwrap_or_default();
        let mut ui = OpenCodeOptions::from_catalogues(catalogue, agents);
        // Optional discovery/recovery must not hold the base controls hostage.
        emit_scoped(&self.events, "opencode", &self.threadterm_session, Some(native_id), None, "chat.ui", ui.wire(), Some(&self.worker_token));
        let commands = self.request(reqwest::Method::GET, "/command", None).and_then(|response| self.json(response));
        ui.load_commands(commands);
        ui.effective_model = messages.as_array().into_iter().flatten().rev().find_map(|row| {
            let info = row.get("info").unwrap_or(row);
            Some(json!({"providerID":info.get("providerID")?.as_str()?,"modelID":info.get("modelID")?.as_str()?}))
        });
        let liveness = Arc::new(AtomicBool::new(true));
        let target = Arc::new(EventTarget {
            threadterm_session: self.threadterm_session.clone(),
            native_id: native_id.to_owned(),
            worker_token: self.worker_token.clone(),
            events: self.events.clone(),
            active: Arc::clone(&self.active_turn),
            assembly,
            permissions: Arc::clone(&self.permissions),
            settled_permissions: Arc::new(Mutex::new(HashSet::new())),
            subagents: Mutex::new(OpenCodeSubagents::default()),
            permission_sessions: Mutex::new(HashMap::new()),
            native_turn_observed: AtomicBool::new(false),
            stopped: Arc::clone(&self.stopped),
            event_gate: Arc::clone(&self.event_gate),
            liveness: Arc::clone(&liveness),
            snapshot_client: self.client.clone(),
            base_url: self.base_url.clone(),
            directory: self.cwd.clone(),
            username: self.username.clone(),
            password: self.password.clone(),
            model_limits,
            ui: Mutex::new(ui),
            abort_pending: Mutex::new(None),
            retry_visible: AtomicBool::new(false),
            compact_pending: Mutex::new(None),
        });
        // The SSE response is already buffering. Hydrate before draining it so
        // replied/updated events win over these read-only snapshots.
        target.hydrate(&messages, |path| self.request(reqwest::Method::GET, path, None).and_then(|response| self.json(response)));
        let context = SseContext {
            reader: BufReader::new(response),
            target: Arc::clone(&target),
            stopped: Arc::clone(&self.stopped),
            liveness: Arc::clone(&liveness),
        };
        if kind == "retry" {
            target.retry_status(status_map.get(native_id), Some(NATIVE_BUSY_TURN));
        }
        spawn_sse(context)?;
        Ok(target)
    }

    fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Response, ProviderError> {
        let mut request = self
            .client
            .request(method, format!("{}{}", self.base_url, path))
            .basic_auth(&self.username, Some(&self.password))
            .query(&[("directory", &self.cwd)]);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().map_err(|error| {
            ProviderError::new(
                "provider_disconnected",
                format!("OpenCode request failed: {error}"),
            )
        })?;
        if response.status().is_success() {
            Ok(response)
        } else {
            let status = response.status();
            let message = response.text().unwrap_or_default();
            Err(ProviderError::new(
                "provider_error",
                format!("OpenCode returned {status}: {message}"),
            )
            .with_details(json!({"httpStatus":status.as_u16()})))
        }
    }
    fn json(&self, response: Response) -> Result<Value, ProviderError> {
        response.json().map_err(|error| {
            ProviderError::new(
                "provider_protocol",
                format!("invalid OpenCode response: {error}"),
            )
        })
    }
    fn shutdown(&self) {
        let already_stopped = if let Ok(_guard) = self.event_gate.lock() {
            self.stopped.swap(true, Ordering::SeqCst)
        } else {
            self.stopped.swap(true, Ordering::SeqCst)
        };
        if already_stopped {
            return;
        }
        let _ = self.request(reqwest::Method::POST, "/instance/dispose", None);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Drop for OpenCodeServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// These are prompt overrides, never an observation of the model currently running.
// Keep the pair structured: both provider and model identifiers can contain '/'.
#[derive(Clone)]
struct OpenCodeModel {
    value: String,
    model: Value,
    name: String,
    group: String,
    variants: Vec<String>,
    images: bool,
}
#[derive(Clone, Default)]
struct OpenCodeOptions {
    models: Vec<OpenCodeModel>,
    agents: Vec<Value>,
    commands: Vec<Value>,
    effective_model: Option<Value>,
    model: String,
    agent: String,
    variant: String,
    error: Option<ProviderError>,
    selection_error: Option<ProviderError>,
}
impl OpenCodeOptions {
    fn from_catalogues(providers: Result<Value, ProviderError>, agents: Result<Value, ProviderError>) -> Self {
        let mut ui = Self::default();
        match providers {
            Ok(providers) => {
                if let (Some(all), Some(connected)) = (providers.get("all").and_then(Value::as_array), providers.get("connected").and_then(Value::as_array)) {
                    for provider in all {
                        let Some(id) = provider.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) else { continue };
                        if !connected.iter().any(|value| value.as_str() == Some(id)) { continue; }
                        let group = provider.get("name").and_then(Value::as_str).unwrap_or(id);
                        let Some(models) = provider.get("models").and_then(Value::as_object) else { continue };
                        for (key, model) in models {
                            let model_id = model.get("id").and_then(Value::as_str).unwrap_or(key);
                            if model_id.is_empty() || model.get("disabled").and_then(Value::as_bool) == Some(true) || model.get("status").and_then(Value::as_str) == Some("unavailable") { continue; }
                            let name = model.get("name").and_then(Value::as_str).unwrap_or(model_id);
                            let variants = model.get("variants").and_then(Value::as_object).map(|variants| variants.iter()
                                .filter(|(_, value)| value.get("disabled").and_then(Value::as_bool) != Some(true))
                                .map(|(key, _)| key.clone()).collect()).unwrap_or_default();
                            ui.models.push(OpenCodeModel {
                                value: format!("{{\"providerID\":{},\"modelID\":{}}}", json!(id), json!(model_id)),
                                model: json!({"providerID":id,"modelID":model_id}),
                                name: format!("{group} \u{00b7} {name}"), group: group.to_owned(), variants,
                                images: model.pointer("/capabilities/input/image").and_then(Value::as_bool) == Some(true),
                            });
                        }
                    }
                } else {
                    ui.error = Some(ProviderError::new("provider_protocol", "OpenCode returned an invalid provider catalogue"));
                }
            }
            Err(error) => ui.error = Some(error),
        }
        match agents {
            Ok(agents) => if let Some(agents) = agents.as_array() {
                for agent in agents {
                    if agent.get("hidden").and_then(Value::as_bool) == Some(true)
                        || !matches!(agent.get("mode").and_then(Value::as_str), Some("primary" | "all")) { continue; }
                    let Some(name) = agent.get("name").and_then(Value::as_str).filter(|name| !name.is_empty()) else { continue };
                    let mut choice = json!({"value":name,"name":name});
                    if let Some(description) = agent.get("description").and_then(Value::as_str) { choice["description"] = json!(description); }
                    ui.agents.push(choice);
                }
            } else { ui.error = Some(ProviderError::new("provider_protocol", "OpenCode returned an invalid agent catalogue")); },
            Err(error) => ui.error = Some(error),
        }
        ui
    }
    fn load_commands(&mut self, commands: Result<Value, ProviderError>) {
        self.commands.clear();
        let commands = match commands.and_then(|value| value.as_array().cloned().ok_or_else(|| ProviderError::new("provider_protocol", "OpenCode returned an invalid command catalogue"))) {
            Ok(commands) => commands,
            Err(error) => {
                // Aggregate options errors fail saved-selection restoration.
                // A missing command feature must not invalidate model/agent data.
                if !error.details.as_ref().and_then(|details| details["httpStatus"].as_u64()).is_some_and(|status| matches!(status, 404 | 405)) {
                    eprintln!("[opencode-commands] catalogue unavailable ({})", error.code);
                }
                return;
            }
        };
        let mut names = HashSet::new();
        self.commands = commands.iter().filter_map(|command| {
            let name = command.get("name")?.as_str()?;
            if name.is_empty() || name.chars().any(char::is_whitespace) || name.starts_with('/') || matches!(name, "compact" | "summarize") || !names.insert(name) { return None; }
            let mut entry = json!({"name":name});
            if let Some(description) = command.get("description").and_then(Value::as_str) { entry["description"] = json!(description); }
            Some(entry)
        }).collect();
    }
    fn current_model(&self) -> Option<&Value> { self.selected_model().map(|model| &model.model).or(self.effective_model.as_ref()) }
    fn accepts_images(&self) -> bool { self.selected_model().is_some_and(|model| model.images) }
    fn validate_input(&self, text: &str, images: &[String]) -> Result<(), ProviderError> {
        if let Some(("compact" | "summarize", arguments)) = opencode_slash(text) {
            if !images.is_empty() || !arguments.is_empty() { return Err(ProviderError::new("command_arguments_invalid", "Compact conversation accepts no arguments or images")); }
            if self.current_model().is_none() { return Err(ProviderError::new("chat_option_invalid", "Choose a model before compacting this conversation")); }
        }
        self.validate_image_capability(images)
    }
    fn validate_image_capability(&self, images: &[String]) -> Result<(), ProviderError> {
        if !images.is_empty() && !self.accepts_images() {
            return Err(ProviderError::new("images_unsupported", "The selected OpenCode model does not advertise image input. Choose an image-capable model first."));
        }
        Ok(())
    }
    fn dispatch(&self, text: &str, images: &[String]) -> Result<(&'static str, Value), ProviderError> {
        self.validate_input(text, images)?;
        let slash = opencode_slash(text);
        if slash.is_some_and(|(name, _)| matches!(name, "compact" | "summarize")) {
            if !images.is_empty() || slash.is_some_and(|(_, args)| !args.is_empty()) {
                return Err(ProviderError::new("command_arguments_invalid", "Compact conversation accepts no arguments or images"));
            }
            let model = self.current_model().ok_or_else(|| ProviderError::new("chat_option_invalid", "Choose a model before compacting this conversation"))?;
            return Ok(("summarize", model.clone()));
        }
        let parts = opencode_image_parts(images)?;
        if let Some((name, arguments)) = slash.filter(|(name, _)| self.commands.iter().any(|command| command["name"] == *name)) {
            let mut body = json!({"command":name,"arguments":arguments});
            if let Some(model) = self.selected_model() {
                body["model"] = json!(format!("{}/{}", model.model["providerID"].as_str().unwrap_or_default(), model.model["modelID"].as_str().unwrap_or_default()));
            }
            if !self.agent.is_empty() { body["agent"] = json!(self.agent); }
            if !self.variant.is_empty() { body["variant"] = json!(self.variant); }
            if !parts.is_empty() { body["parts"] = json!(parts); }
            return Ok(("command", body));
        }
        let mut body = self.prompt(text);
        body["parts"].as_array_mut().unwrap().extend(parts);
        Ok(("prompt_async", body))
    }
    fn selected_model(&self) -> Option<&OpenCodeModel> { self.models.iter().find(|model| model.value == self.model) }
    fn select(&mut self, id: &str, value: &str) -> Result<(), ProviderError> {
        let valid = match id {
            "next-model" => value.is_empty() || self.models.iter().any(|model| model.value == value),
            "agent" => value.is_empty() || self.agents.iter().any(|agent| agent["value"].as_str() == Some(value)),
            "variant" => self.selected_model().is_some_and(|model| !model.variants.is_empty() && (value.is_empty() || model.variants.iter().any(|variant| variant == value))),
            _ => return Err(ProviderError::new("option_unknown", format!("OpenCode has no option {id}"))),
        };
        if !valid {
            let label = if id == "next-model" { "model" } else { id };
            let error = ProviderError::new("chat_option_invalid", format!("OpenCode no longer offers the selected {label}. It was not applied; the available next-turn selections are shown below."));
            self.selection_error = Some(error.clone());
            return Err(error);
        }
        self.selection_error = None;
        match id {
            "next-model" => { if self.model != value { self.variant.clear(); } self.model = value.to_owned(); }
            "agent" => self.agent = value.to_owned(),
            "variant" => self.variant = value.to_owned(),
            _ => unreachable!(),
        }
        Ok(())
    }
    fn prompt(&self, text: &str) -> Value {
        let mut body = json!({"parts":[{"type":"text","text":text}]});
        if let Some(model) = self.selected_model() { body["model"] = model.model.clone(); }
        if !self.agent.is_empty() { body["agent"] = json!(self.agent); }
        if !self.variant.is_empty() { body["variant"] = json!(self.variant); }
        body
    }
    fn wire(&self) -> Value {
        let description = "Selected for the next turn. OpenCode reports the model actually used in the reply footer.";
        let default = || json!({"value":"","name":"OpenCode default","group":"OpenCode"});
        let mut options = Vec::new();
        if !self.models.is_empty() {
            let mut choices = vec![default()];
            choices.extend(self.models.iter().map(|model| json!({"value":model.value,"name":model.name,"group":model.group})));
            options.push(json!({"id":"next-model","name":"Model","category":"model","value":self.model,"description":description,"choices":choices}));
        }
        if !self.agents.is_empty() {
            let mut choices = vec![default()]; choices.extend(self.agents.clone());
            options.push(json!({"id":"agent","name":"Agent","category":"other","value":self.agent,"description":"Selected for the next turn.","choices":choices}));
        }
        if let Some(model) = self.selected_model().filter(|model| !model.variants.is_empty()) {
            let mut choices = vec![default()]; choices.extend(model.variants.iter().map(|variant| json!({"value":variant,"name":variant})));
            // The catalogue exposes arbitrary provider options, not a reasoning-level contract.
            options.push(json!({"id":"variant","name":"Variant","category":"other","value":self.variant,"description":"Selected for the next turn.","choices":choices}));
        }
        let error = self.error.as_ref().or(self.selection_error.as_ref());
        let mut commands = self.commands.clone();
        commands.push(json!({"name":"compact","description":"Compact conversation using the current model"}));
        let mut state = json!({"options":options,"commands":commands,"inputCapabilities":{"images":self.accepts_images()},"loadState":if error.is_some() { "error" } else { "ready" }});
        if let Some(error) = error { state["error"] = json!(error); }
        state
    }
}

fn opencode_slash(text: &str) -> Option<(&str, &str)> {
    let text = text.trim().strip_prefix('/')?;
    let end = text.find(char::is_whitespace).unwrap_or(text.len());
    Some((&text[..end], text[end..].trim()))
}
fn opencode_image_mime(image: &str) -> Result<&str, ProviderError> {
    let (header, encoded) = image.split_once(";base64,").ok_or_else(|| ProviderError::new("invalid_image", "OpenCode requires base64 image data URLs"))?;
    let mime = header.strip_prefix("data:").filter(|mime| matches!(*mime, "image/png" | "image/jpeg" | "image/webp" | "image/gif"))
        .ok_or_else(|| ProviderError::new("invalid_image", "OpenCode requires a PNG, JPEG, WebP or GIF image data URL"))?;
    if encoded.is_empty() || base64::engine::general_purpose::STANDARD.decode(encoded).is_err() {
        return Err(ProviderError::new("invalid_image", "OpenCode image data is not valid base64"));
    }
    Ok(mime)
}
fn opencode_image_parts(images: &[String]) -> Result<Vec<Value>, ProviderError> {
    images.iter().map(|image| Ok(json!({"type":"file","mime":opencode_image_mime(image)?,"url":image}))).collect()
}
// The root SDK declares only an optional messageID, without boundary semantics.
// Assume an exclusive cutoff. Resolve the *following* native message so a
// selected reply is included. Never use latest-only for an unresolved anchor.
fn opencode_fork_body(native_id: &str, anchor: Option<&crate::domain::NativeForkAnchor>, is_latest: bool, messages: &Value) -> Result<Option<Value>, ProviderError> {
    let Some(anchor) = anchor else { return Ok(is_latest.then(|| json!({}))) };
    if anchor.native_id != native_id { return Ok(None); }
    let Some(id) = anchor.message_id.as_deref() else { return Ok(None) };
    validate_native_id(id)?;
    let Some(messages) = messages.as_array() else { return Err(ProviderError::new("provider_protocol", "OpenCode fork history is not a message list")) };
    let Some(index) = messages.iter().position(|row| row.pointer("/info/id").and_then(Value::as_str) == Some(id)) else { return Ok(None) };
    match messages.get(index + 1) {
        Some(row) => {
            let Some(next) = row.pointer("/info/id").and_then(Value::as_str) else { return Ok(None) };
            validate_native_id(next)?;
            Ok(Some(json!({"messageID":next})))
        }
        None => Ok(Some(json!({}))),
    }
}
fn opencode_error(error: &Value) -> Value {
    let name = error.get("name").and_then(Value::as_str).unwrap_or("UnknownError");
    let detail = error.pointer("/data/message").or_else(|| error.get("message")).and_then(Value::as_str).filter(|message| !message.trim().is_empty());
    let (category, fallback) = match name {
        "ProviderAuthError" => ("authentication", "OpenCode could not authenticate with the model provider. Check that provider's credentials."),
        "ContextOverflowError" => ("context_overflow", "The conversation exceeds this model's context limit."),
        "MessageOutputLengthError" => ("output_limit", "The model reached its response length limit."),
        "MessageAbortedError" => ("interrupted", "The OpenCode response was interrupted."),
        "ContentFilterError" => ("content_filter", "The model provider blocked this request with its content filter."),
        "StructuredOutputError" => ("structured_output", "OpenCode could not produce the requested structured response."),
        "APIError" => ("api", "The model provider rejected the OpenCode request."),
        _ => ("provider", "OpenCode could not complete the request."),
    };
    let message = detail.map(|detail| format!("{fallback} {detail}")).unwrap_or_else(|| fallback.to_owned());
    let mut data = json!({"message":message,"category":category,"reason":name});
    if let Some(status) = error.pointer("/data/statusCode").and_then(Value::as_u64) { data["httpStatus"] = json!(status); }
    if let Some(retryable) = error.pointer("/data/isRetryable").and_then(Value::as_bool) { data["retryable"] = json!(retryable); }
    data
}

struct OpenCodeChat {
    server: OpenCodeServer,
    session_id: String,
    native_id: String,
    events: crate::provider_events::Sender,
    sse_target: Arc<EventTarget>,
    worker_token: String,
}
impl ChatSession for OpenCodeChat {
    fn native_id(&self) -> Option<String> {
        Some(self.native_id.clone())
    }
    fn is_alive(&self) -> bool {
        // A live event stream is what makes this chat usable: the server
        // process alone proves nothing about message delivery.
        if self.server.stopped.load(Ordering::SeqCst)
            || !self.sse_target.liveness.load(Ordering::SeqCst)
        {
            return false;
        }
        self.server
            .child
            .lock()
            .ok()
            .and_then(|mut child| child.try_wait().ok().map(|status| status.is_none()))
            .unwrap_or(false)
    }
    fn validate_send(&self, _text: &str) -> Result<(), ProviderError> {
        if !self.is_alive() {
            return Err(ProviderError::new(
                "provider_disconnected",
                "OpenCode event stream is disconnected",
            ));
        }
        if self
            .server
            .active_turn
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "OpenCode turn lock poisoned"))?
            .is_some()
        {
            return Err(ProviderError::new(
                "turn_in_progress",
                "OpenCode session already has an active turn",
            ));
        }
        Ok(())
    }
    fn validate_images(&self, images: &[String]) -> Result<(), ProviderError> {
        self.sse_target.ui.lock().map_err(|_| ProviderError::new("provider_internal", "OpenCode options lock poisoned"))?.validate_image_capability(images)?;
        for image in images { opencode_image_mime(image)?; }
        Ok(())
    }
    fn validate_send_with_images(&self, text: &str, images: &[String]) -> Result<(), ProviderError> {
        self.sse_target.ui.lock().map_err(|_| ProviderError::new("provider_internal", "OpenCode options lock poisoned"))?.validate_input(text, images)?;
        // Validate once before durable recording, without cloning data URLs.
        for image in images { opencode_image_mime(image)?; }
        Ok(())
    }
    fn send(&mut self, text: &str, operation_id: &str) -> Result<Value, ProviderError> { self.send_with_images(text, &[], operation_id) }
    fn send_with_images(&mut self, text: &str, images: &[String], operation_id: &str) -> Result<Value, ProviderError> {
        validate_native_id(operation_id)?;
        let (route, prompt) = self.sse_target.ui.lock().map_err(|_| ProviderError::new("provider_internal", "OpenCode options lock poisoned"))?.dispatch(text, images)?;
        {
            let _commit = self.server.event_gate.lock().map_err(|_| {
                ProviderError::new("provider_internal", "OpenCode event gate poisoned")
            })?;
            if !self.is_alive() {
                return Err(ProviderError::new(
                    "provider_disconnected",
                    "OpenCode event stream is disconnected",
                ));
            }
            let mut active = self.server.active_turn.lock().map_err(|_| {
                ProviderError::new("provider_internal", "OpenCode turn lock poisoned")
            })?;
            if active.is_some() {
                return Err(ProviderError::new(
                    "turn_in_progress",
                    "OpenCode session already has an active turn",
                ));
            }
            *active = Some(operation_id.to_owned());
            if route == "summarize" {
                *self.sse_target.compact_pending.lock().map_err(|_| ProviderError::new("provider_internal", "OpenCode compact lock poisoned"))? = Some(OpenCodeCompact { turn: operation_id.to_owned(), confirmed: false, idle_observed: false });
            }
            self.sse_target
                .native_turn_observed
                .store(false, Ordering::SeqCst);
            // Announce the local turn before dispatch. OpenCode may emit an
            // approval, completion or error before prompt_async replies;
            // adding started after that would regress waiting/idle to running.
            emit_scoped(
                &self.events,
                "opencode",
                &self.session_id,
                Some(&self.native_id),
                Some(operation_id),
                "chat.turn.started",
                json!({}),
                Some(&self.worker_token),
            );
        }
        // The blocking client exposes response headers, not a request-written
        // acknowledgement. Do not acknowledge a queued thread as a dispatched
        // prompt: Stop could otherwise overtake it, and late replies could use
        // the next turn's native_turn_observed state. Keep this acceptance
        // boundary until dispatch and per-request outcome fencing are explicit.
        let sent = self.server.request(
            reqwest::Method::POST,
            &format!("/session/{}/{route}", self.native_id),
            Some(prompt),
        );
        if route == "summarize" {
            let result = sent.and_then(|response| self.server.json(response)).and_then(|value| {
                if value == json!(true) { Ok(()) } else { Err(ProviderError::new("compact_not_confirmed", "OpenCode did not confirm conversation compaction").with_details(json!({"httpStatus":400}))) }
            });
            self.sse_target.finish_compact(operation_id, result)?;
        } else {
            self.sse_target.finish_prompt(operation_id, sent.map(|_| ()))?;
        }
        Ok(json!({"turnId":operation_id}))
    }
    fn ui_state(&self) -> Value {
        self.sse_target.ui.lock().map(|ui| ui.wire()).unwrap_or_else(|_| json!({"options":[],"commands":[],"loadState":"error"}))
    }
    fn set_option(&mut self, option_id: &str, value: &str) -> Result<Value, ProviderError> {
        let (state, result) = {
            let mut ui = self.sse_target.ui.lock().map_err(|_| ProviderError::new("provider_internal", "OpenCode options lock poisoned"))?;
            let result = ui.select(option_id, value);
            (ui.wire(), result)
        };
        emit_scoped(&self.events, "opencode", &self.session_id, Some(&self.native_id), None, "chat.ui", state.clone(), Some(&self.worker_token));
        result?;
        Ok(state)
    }
    fn cancel(&mut self, turn_id: &str) -> Result<(), ProviderError> {
        {
            let _commit = self.server.event_gate.lock().map_err(|_| ProviderError::new("provider_internal", "OpenCode event gate poisoned"))?;
            if self.server.active_turn.lock().map_err(|_| ProviderError::new("provider_internal", "OpenCode turn lock poisoned"))?.as_deref() != Some(turn_id) {
                return Err(ProviderError::new("turn_not_active", "the requested OpenCode turn is not active"));
            }
            *self.sse_target.abort_pending.lock().map_err(|_| ProviderError::new("provider_internal", "OpenCode abort lock poisoned"))? = Some(OpenCodeAbort { turn: turn_id.to_owned(), confirmed: false, idle_observed: false });
        }
        let result = self.server.request(reqwest::Method::POST, &format!("/session/{}/abort", self.native_id), None)
            .and_then(|response| self.server.json(response))
            .and_then(|value| if value == json!(true) { Ok(()) } else { Err(ProviderError::new("abort_result_unknown", "OpenCode did not confirm that the turn was stopped")) });
        self.sse_target.finish_abort(turn_id, result)
    }
    fn approve(
        &mut self,
        turn_id: &str,
        approval_id: &str,
        choice_id: &str,
        _operation_id: &str,
    ) -> Result<(), ProviderError> {
        validate_native_id(approval_id)?;
        let commit =
            self.server.event_gate.lock().map_err(|_| {
                ProviderError::new("provider_internal", "OpenCode event gate poisoned")
            })?;
        if !self.is_alive() {
            return Err(ProviderError::new(
                "provider_disconnected",
                "OpenCode event stream is disconnected",
            ));
        }
        let known = self.server.permissions.lock().map_err(|_| {
            ProviderError::new("provider_internal", "OpenCode permission lock poisoned")
        })?;
        if known
            .get(approval_id)
            .is_none_or(|asked_turn| asked_turn.turn.as_deref().is_some_and(|asked| asked != turn_id))
        {
            return Err(ProviderError::new(
                "approval_not_pending",
                "OpenCode permission is no longer pending",
            ));
        }
        drop(known);
        let permission_session = self
            .sse_target
            .permission_sessions
            .lock()
            .map_err(|_| {
                ProviderError::new(
                    "provider_internal",
                    "OpenCode permission session lock poisoned",
                )
            })?
            .get(approval_id)
            .cloned()
            .unwrap_or_else(|| self.native_id.clone());
        validate_native_id(&permission_session)?;
        drop(commit);
        let response = match map_allow_deny_choice(choice_id)? {
            "allow" => "once",
            _ => "reject",
        };
        let sent = self.server.request(
            reqwest::Method::POST,
            &format!("/session/{permission_session}/permissions/{approval_id}"),
            Some(json!({"response":response})),
        );
        if let Err(error) = sent {
            // A non-2xx approval reply need not prove that the native action
            // was skipped; require a new status/permission calibration.
            expire_stream(&self.sse_target, "approval_result_unknown", &error.message);
            return Err(error);
        }
        let _commit =
            self.server.event_gate.lock().map_err(|_| {
                ProviderError::new("provider_internal", "OpenCode event gate poisoned")
            })?;
        if !self.sse_target.liveness.load(Ordering::SeqCst)
            || self.server.stopped.load(Ordering::SeqCst)
        {
            return Err(ProviderError::new(
                "provider_disconnected",
                "OpenCode approval result is uncertain after event-stream loss",
            ));
        }
        Ok(())
    }
    fn answer(
        &mut self,
        turn_id: &str,
        approval_id: &str,
        response: &Value,
        _operation_id: &str,
    ) -> Result<(), ProviderError> {
        validate_native_id(approval_id)?;
        let commit =
            self.server.event_gate.lock().map_err(|_| {
                ProviderError::new("provider_internal", "OpenCode event gate poisoned")
            })?;
        if !self.is_alive() {
            return Err(ProviderError::new(
                "provider_disconnected",
                "OpenCode event stream is disconnected",
            ));
        }
        if self
            .server
            .active_turn
            .lock()
            .ok()
            .and_then(|turn| turn.clone())
            .as_deref()
            != Some(turn_id)
        {
            return Err(ProviderError::new(
                "approval_not_pending",
                "OpenCode question is no longer bound to this turn",
            ));
        }
        let interaction = self
            .sse_target
            .permissions
            .lock()
            .map_err(|_| {
                ProviderError::new("provider_internal", "OpenCode interaction lock poisoned")
            })?
            .get(approval_id)
            .cloned()
            .ok_or_else(|| {
                ProviderError::new(
                    "approval_not_pending",
                    "OpenCode question is no longer pending",
                )
            })?;
        let question = interaction
            .question
            .ok_or_else(|| ProviderError::new("answer_invalid", "interaction is not a question"))?;
        if interaction.turn.as_deref() != Some(turn_id) {
            return Err(ProviderError::new(
                "approval_not_pending",
                "OpenCode question belongs to another turn",
            ));
        }
        let action = response
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let path = if action == "dismiss" {
            format!("/question/{approval_id}/reject")
        } else if action == "submit" {
            format!("/question/{approval_id}/reply")
        } else {
            return Err(ProviderError::new(
                "answer_invalid",
                "unsupported OpenCode question response",
            ));
        };
        let body = if action == "submit" {
            let values = response
                .get("values")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    ProviderError::new("answer_invalid", "question response has no values")
                })?;
            let answers = question
                .ids
                .iter()
                .map(|id| {
                    values.get(id).cloned().ok_or_else(|| {
                        ProviderError::new("answer_invalid", "answer is missing a question")
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            Some(json!({"answers":answers}))
        } else {
            None
        };
        drop(commit);
        if let Err(error) = self.server.request(reqwest::Method::POST, &path, body) {
            expire_stream(&self.sse_target, "answer_result_unknown", &error.message);
            return Err(ProviderError::new(
                "approval_outcome_unknown",
                error.message,
            ));
        }
        let status = if action == "dismiss" {
            "dismissed"
        } else {
            "answered"
        };
        let summary = (action == "submit").then(|| answer_summary(&question.payload, response));
        let _commit =
            self.server.event_gate.lock().map_err(|_| {
                ProviderError::new("provider_internal", "OpenCode event gate poisoned")
            })?;
        let still_pending = self
            .sse_target
            .permissions
            .lock()
            .ok()
            .is_some_and(|mut pending| pending.remove(approval_id).is_some());
        // OpenCode can publish question.replied before its HTTP reply reaches
        // us. That native receipt is authoritative; do not overwrite it with
        // a second local resolution.
        let native_resolved = self
            .sse_target
            .settled_permissions
            .lock()
            .ok()
            .is_some_and(|settled| settled.contains(approval_id));
        if !still_pending && native_resolved {
            return Ok(());
        }
        if let Ok(mut settled) = self.sse_target.settled_permissions.lock() {
            settled.insert(approval_id.into());
        }
        emit_scoped(
            &self.events,
            "opencode",
            &self.session_id,
            Some(&self.native_id),
            Some(turn_id),
            "chat.approval.resolved",
            json!({"approvalId":approval_id,"status":status,"outcome":"submitted","answerSummary":summary}),
            Some(&self.worker_token),
        );
        Ok(())
    }
    fn stop(&mut self) -> Result<(), ProviderError> {
        self.server.shutdown();
        Ok(())
    }
}

/// Per-message assembly keyed by native message/part identity. A full
/// `message.part.updated` replaces one part; a `message.part.delta` appends to
/// one field of one part. Snapshots always publish the whole assembled
/// message, so the projection replaces a single message and never the turn.
#[derive(Default)]
struct OpenCodeAssembly {
    order: Vec<String>,
    messages: HashMap<String, MessageAssembly>,
    created_at: HashMap<String, String>,
    seeded: HashSet<String>,
    authoritative_only: bool,
    /// Native user and hidden summary messages. Chat already shows the prompt
    /// and confirmed compact receipt, so their parts must not become replies.
    user_messages: HashSet<String>,
}

#[derive(Default)]
struct MessageAssembly {
    order: Vec<String>,
    parts: HashMap<String, Value>,
}

impl MessageAssembly {
    fn put(&mut self, part_id: &str, part: Value) {
        if !self.parts.contains_key(part_id) {
            self.order.push(part_id.to_owned());
        }
        self.parts.insert(part_id.to_owned(), part);
    }
    fn append_text(&mut self, part_id: &str, delta: &str) {
        if !self.parts.contains_key(part_id) {
            self.order.push(part_id.to_owned());
            self.parts.insert(
                part_id.to_owned(),
                json!({"type":"text","text":"","status":"streaming"}),
            );
        }
        if let Some(part) = self.parts.get_mut(part_id) {
            let prior = part
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            part["text"] = json!(format!("{prior}{delta}"));
            part["status"] = json!("streaming");
        }
    }
    fn snapshot(&self) -> Vec<Value> {
        self.order
            .iter()
            .filter_map(|id| self.parts.get(id).cloned())
            .collect()
    }
}

impl OpenCodeAssembly {
    fn exceeds_payload_budget(&self) -> bool {
        let mut bytes = 0;
        for message in self.messages.values() {
            for part in message.parts.values() {
                bytes += part.to_string().len();
                if bytes > MAX_ASSEMBLED_PAYLOAD_BYTES {
                    return true;
                }
            }
        }
        false
    }

    fn discard_local_cache(&mut self) {
        self.authoritative_only = true;
        self.order.clear();
        self.messages.clear();
        self.created_at.clear();
        self.seeded.clear();
    }

    /// Seeds from the native `GET /session/{id}/message` log so live updates
    /// for pre-existing messages keep their full part set.
    fn seed(&mut self, messages: &Value, native_id: &str) -> Result<(), ProviderError> {
        let rows = messages
            .as_array()
            .or_else(|| messages.get("messages").and_then(Value::as_array))
            .ok_or_else(|| {
                ProviderError::new("provider_protocol", "OpenCode message log is not an array")
            })?;
        // A full page means older messages may be omitted. In that case all
        // events use the exact native-message GET below, without a local cache.
        self.authoritative_only = rows.len() >= MAX_ASSEMBLED_MESSAGES;
        for row in rows {
            let info = row.get("info").unwrap_or(row);
            let message_id = info.get("id").and_then(Value::as_str).ok_or_else(|| {
                ProviderError::new("provider_protocol", "OpenCode message log entry has no id")
            })?;
            let normalized = native_message_parts(row, message_id, native_id)?;
            if self.authoritative_only {
                continue;
            }
            if let Some(created_at) = opencode_message_created_at(info) { self.remember_created_at(message_id, created_at); }
            self.seeded.insert(message_id.to_owned());
            let message = self
                .messages
                .entry(message_id.to_owned())
                .or_insert_with(|| {
                    self.order.push(message_id.to_owned());
                    MessageAssembly::default()
                });
            for (part_id, part) in normalized {
                message.put(&part_id, part);
            }
            if self.exceeds_payload_budget() {
                self.discard_local_cache();
            }
        }
        Ok(())
    }

    fn requires_native_snapshot(&mut self, message_id: &str) -> bool {
        if self.authoritative_only || self.seeded.contains(message_id) {
            return true;
        }
        if self.messages.contains_key(message_id) {
            return false;
        }
        if self.messages.len() >= MAX_ASSEMBLED_MESSAGES {
            self.discard_local_cache();
            return true;
        }
        false
    }

    fn remember_created_at(&mut self, message_id: &str, created_at: String) {
        if self.authoritative_only { return; }
        if !self.created_at.contains_key(message_id) && self.created_at.len() >= MAX_ASSEMBLED_MESSAGES {
            self.discard_local_cache();
            return;
        }
        self.created_at.insert(message_id.to_owned(), created_at);
    }

    fn apply_full_part(&mut self, message_id: &str, part_id: &str, part: Value) -> Vec<Value> {
        let message = self
            .messages
            .entry(message_id.to_owned())
            .or_insert_with(|| {
                self.order.push(message_id.to_owned());
                MessageAssembly::default()
            });
        message.put(part_id, part);
        message.snapshot()
    }

    fn apply_text_delta(&mut self, message_id: &str, part_id: &str, delta: &str) -> Vec<Value> {
        let message = self
            .messages
            .entry(message_id.to_owned())
            .or_insert_with(|| {
                self.order.push(message_id.to_owned());
                MessageAssembly::default()
            });
        message.append_text(part_id, delta);
        message.snapshot()
    }
}

fn opencode_message_created_at(info: &Value) -> Option<String> {
    info.pointer("/time/created").and_then(Value::as_i64).and_then(|value| Utc.timestamp_millis_opt(value).single()).map(|value| value.to_rfc3339())
}

fn native_message_parts(
    row: &Value,
    expected_message_id: &str,
    native_id: &str,
) -> Result<Vec<(String, Value)>, ProviderError> {
    let info = row.get("info").unwrap_or(row);
    if info.get("id").and_then(Value::as_str) != Some(expected_message_id)
        || info.get("sessionID").and_then(Value::as_str) != Some(native_id)
    {
        return Err(ProviderError::new(
            "provider_protocol",
            "OpenCode native message snapshot has the wrong identity",
        ));
    }
    let parts = row.get("parts").and_then(Value::as_array).ok_or_else(|| {
        ProviderError::new(
            "provider_protocol",
            "OpenCode native message has no parts array",
        )
    })?;
    parts
        .iter()
        .map(|part| {
            let part_id = part.get("id").and_then(Value::as_str).ok_or_else(|| {
                ProviderError::new("provider_protocol", "OpenCode native part has no id")
            })?;
            if part.get("messageID").and_then(Value::as_str) != Some(expected_message_id)
                || part.get("sessionID").and_then(Value::as_str) != Some(native_id)
            {
                return Err(ProviderError::new(
                    "provider_protocol",
                    "OpenCode native part belongs to another message or session",
                ));
            }
            Ok((part_id.to_owned(), opencode_chat_part(part)))
        })
        .collect::<Result<Vec<_>, ProviderError>>()
        .map(|parts: Vec<(String, Value)>| {
            parts
                .into_iter()
                .filter(|(_, part)| {
                    !part.get("data").is_some_and(|data| opencode_task_part(data) || !opencode_visible_part(data))
                })
                .collect()
        })
}

const MAX_PENDING_CHILD_EVENTS: usize = 200;

#[derive(Default)]
struct OpenCodeSubagents {
    children: HashMap<String, String>,
    pending_children: HashMap<String, VecDeque<Value>>,
    task_calls: HashMap<String, Option<String>>,
    parents: HashMap<String, String>,
    roles: HashMap<(String, String), String>,
    labels: HashMap<String, String>,
    turns: HashMap<String, Option<String>>,
}

#[derive(Clone)]
struct OpenCodeQuestion {
    session: String,
    payload: Value,
    ids: Vec<String>,
}

#[derive(Clone)]
struct OpenCodeInteraction {
    turn: Option<String>,
    question: Option<OpenCodeQuestion>,
}

impl OpenCodeSubagents {
    fn buffer(&mut self, child: &str, raw: Value) {
        let pending = self.pending_children.entry(child.into()).or_default();
        if pending.len() == MAX_PENDING_CHILD_EVENTS {
            pending.pop_front();
        }
        pending.push_back(raw);
    }

    fn bind(&mut self, child: &str, key: &str) -> Vec<Value> {
        let mut children = VecDeque::from([child.to_owned()]);
        let mut pending = Vec::new();
        let mut seen = HashSet::new();
        while let Some(child) = children.pop_front() {
            if !seen.insert(child.clone()) {
                continue;
            }
            self.children.insert(child.clone(), key.into());
            if let Some(events) = self.pending_children.remove(&child) {
                pending.extend(events);
            }
            children.extend(
                self.parents
                    .iter()
                    .filter_map(|(id, parent)| (parent == &child).then_some(id.clone())),
            );
        }
        pending
    }
}

/// OpenCode's bookkeeping parts (step boundaries, file snapshots, patch lists,
/// retries, compaction markers) carry no reply content and are not tools.
fn opencode_visible_part(part: &Value) -> bool {
    !matches!(
        part.get("type").and_then(Value::as_str),
        Some("step-start" | "step-finish" | "snapshot" | "patch" | "retry" | "compaction")
    )
}

fn opencode_task_part(part: &Value) -> bool {
    part.get("type").and_then(Value::as_str) == Some("subtask")
        || (part.get("type").and_then(Value::as_str) == Some("tool")
            && part.get("tool").and_then(Value::as_str) == Some("task"))
}

fn opencode_event_session<'a>(event_type: &str, properties: &'a Value) -> Option<&'a str> {
    properties
        .get("sessionID")
        .or_else(|| properties.get("sessionId"))
        .and_then(Value::as_str)
        .or_else(|| {
            properties
                .pointer("/info/sessionID")
                .and_then(Value::as_str)
        })
        .or_else(|| {
            properties
                .pointer("/part/sessionID")
                .and_then(Value::as_str)
        })
        .or_else(|| {
            matches!(event_type, "session.created" | "session.updated")
                .then(|| properties.pointer("/info/id").and_then(Value::as_str))
                .flatten()
        })
}

// All helpers below commit under event_gate; flushing never re-enters that gate.
fn emit_opencode_subagent(target: &EventTarget, kind: &str, key: &str, data: Value) {
    let turn = target
        .subagents
        .lock()
        .ok()
        .and_then(|state| state.turns.get(key).cloned())
        .flatten();
    emit_scoped(
        &target.events,
        "opencode",
        &target.threadterm_session,
        Some(&target.native_id),
        turn.as_deref(),
        kind,
        data,
        Some(&target.worker_token),
    );
}

fn opencode_task_update(
    target: &EventTarget,
    part: &Value,
    root: Option<&str>,
    turn: Option<&str>,
) {
    let Some(call) = (if part.get("type").and_then(Value::as_str) == Some("subtask") {
        part.get("id")
    } else {
        part.get("callID")
    })
    .and_then(Value::as_str) else {
        return;
    };
    let key = root.unwrap_or(call);
    let state = part.get("state").unwrap_or(part);
    let input = state.get("input").unwrap_or(part);
    let child = state.pointer("/metadata/sessionId").and_then(Value::as_str);
    let mut info = json!({"transcript":"live","status":match state.get("status").and_then(Value::as_str) {
        Some("completed") => "completed", Some("error") => "failed",
        Some("pending" | "running") | None => "running", _ => "unknown",
    }});
    for (field, value) in [
        (
            "agentType",
            input.get("subagent_type").or_else(|| part.get("agent")),
        ),
        (
            "description",
            input.get("description").or_else(|| state.get("title")),
        ),
        ("prompt", input.get("prompt")),
    ] {
        insert_optional(
            &mut info,
            field,
            value.filter(|value| !value.is_null()).cloned(),
        );
    }
    if let Some(child) = child {
        info["native"] = json!({"kind":"opencode-session","id":child});
    }
    if state.get("status").and_then(Value::as_str) == Some("completed") {
        insert_optional(&mut info, "summary", state.get("output").cloned());
    } else if state.get("status").and_then(Value::as_str) == Some("error") {
        insert_optional(&mut info, "summary", state.get("error").cloned());
    }
    let pending = {
        let Ok(mut subagents) = target.subagents.lock() else {
            return;
        };
        let binding = subagents.task_calls.entry(call.into()).or_default();
        if let Some(child) = child {
            *binding = Some(child.into());
        }
        subagents
            .turns
            .entry(key.into())
            .or_insert_with(|| turn.map(str::to_owned));
        if root.is_none() {
            if let Some(label) = info
                .get("description")
                .or_else(|| info.get("agentType"))
                .and_then(Value::as_str)
            {
                subagents.labels.insert(key.into(), label.into());
            }
        }
        child
            .map(|child| subagents.bind(child, key))
            .unwrap_or_default()
    };
    if root.is_none() {
        emit_opencode_subagent(target, "chat.subagent", key, json!({"key":key,"info":info}));
    }
    for event in pending {
        emit_opencode_child_event(target, event);
    }
}

fn emit_opencode_child_event(target: &EventTarget, raw: Value) {
    let payload = raw.get("payload").unwrap_or(&raw);
    let properties = payload.get("properties").unwrap_or(payload);
    let kind = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(child) = opencode_event_session(kind, properties) else {
        return;
    };
    let Some(key) = target
        .subagents
        .lock()
        .ok()
        .and_then(|state| state.children.get(child).cloned())
    else {
        return;
    };
    match kind {
        "message.updated" => {
            let info = properties.get("info").unwrap_or(properties);
            if let (Some(id), Some(role)) = (
                info.get("id").and_then(Value::as_str),
                info.get("role").and_then(Value::as_str),
            ) {
                if matches!(role, "user" | "assistant" | "tool") {
                    if let Ok(mut state) = target.subagents.lock() {
                        state.roles.insert((child.into(), id.into()), if info.get("summary").and_then(Value::as_bool) == Some(true) { "user" } else { role }.into());
                    }
                }
            }
        }
        "message.part.updated" => {
            let Some(part) = properties.get("part") else {
                return;
            };
            if opencode_task_part(part) {
                opencode_task_update(target, part, Some(&key), None);
                return;
            }
            if !opencode_visible_part(part) {
                return;
            }
            let (Some(message), Some(id)) = (
                part.get("messageID").and_then(Value::as_str),
                part.get("id").and_then(Value::as_str),
            ) else {
                return;
            };
            let role = target
                .subagents
                .lock()
                .ok()
                .and_then(|state| state.roles.get(&(child.into(), message.into())).cloned())
                .unwrap_or_else(|| "assistant".into());
            let normalized = opencode_chat_part(part);
            let merge = normalized.get("type").and_then(Value::as_str) == Some("tool");
            let mut data = json!({"key":key,"item":{"id":format!("{message}:{id}"),"role":role,"parts":[normalized]}});
            if merge {
                data["merge"] = json!(true);
            }
            emit_opencode_subagent(target, "chat.subagent.item", &key, data);
        }
        "session.error" => {
            let error = properties.get("error").unwrap_or(properties);
            let text = error
                .pointer("/data/message")
                .or_else(|| error.get("message"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| error.to_string());
            let id = payload.get("id").and_then(Value::as_str).unwrap_or("error");
            emit_opencode_subagent(
                target,
                "chat.subagent.item",
                &key,
                json!({"key":key,"item":{"id":format!("{child}:{id}"),"role":"assistant","parts":[{"type":"error","text":text,"data":error}]}}),
            );
        }
        "permission.asked" | "permission.updated" => {
            let turn = target
                .subagents
                .lock()
                .ok()
                .and_then(|state| state.turns.get(&key).cloned())
                .flatten();
            opencode_permission_asked(target, kind, properties, child, Some(&key), turn);
        }
        "permission.replied" => opencode_permission_replied(target, properties, child, &raw, None),
        "question.asked" => {
            let turn = target
                .subagents
                .lock()
                .ok()
                .and_then(|state| state.turns.get(&key).cloned())
                .flatten();
            opencode_question_asked(target, properties, child, Some(&key), turn)
        }
        "question.replied" | "question.rejected" => {
            opencode_question_resolved(target, kind, properties, child, &raw, None)
        }
        _ => {}
    }
}

fn opencode_permission_asked(
    target: &EventTarget,
    event_type: &str,
    properties: &Value,
    session: &str,
    subagent: Option<&str>,
    turn: Option<String>,
) {
    // Real 1.18 frames carry the PermissionRequest flat in properties.
    let permission = match properties.get("permission") {
        Some(value) if value.is_object() => value,
        _ => properties,
    };
    let Some(id) = permission.get("id").and_then(Value::as_str) else {
        return;
    };
    if target
        .settled_permissions
        .lock()
        .ok()
        .is_some_and(|settled| settled.contains(id))
    {
        return;
    }
    let asked_turn = match target.permissions.lock() {
        Ok(mut permissions) => {
            if let Some(asked_turn) = permissions.get(id) {
                if event_type == "permission.asked" {
                    return;
                }
                // A different session may not update an existing request.
                if target
                    .permission_sessions
                    .lock()
                    .ok()
                    .and_then(|sessions| sessions.get(id).cloned())
                    .is_some_and(|owner| owner != session)
                {
                    return;
                }
                asked_turn.turn.clone()
            } else {
                if let Ok(mut sessions) = target.permission_sessions.lock() {
                    sessions.insert(id.into(), session.into());
                } else {
                    return;
                }
                permissions.insert(
                    id.into(),
                    OpenCodeInteraction {
                        turn: turn.clone(),
                        question: None,
                    },
                );
                turn
            }
        }
        Err(_) => return,
    };
    let mut data = approval_payload(
        id,
        "opencode",
        "permission.asked",
        permission
            .get("title")
            .and_then(Value::as_str)
            .or_else(|| permission.get("permission").and_then(Value::as_str))
            .unwrap_or("Permission request"),
        permission,
        &allow_deny_choices(),
        asked_turn.as_deref(),
        true,
    );
    if let Some(key) = subagent {
        let label = target
            .subagents
            .lock()
            .ok()
            .and_then(|state| state.labels.get(key).cloned())
            .unwrap_or_else(|| "Subagent".into());
        data["subagent"] = json!({"key":key,"label":label});
    }
    emit_scoped(
        &target.events,
        "opencode",
        &target.threadterm_session,
        Some(&target.native_id),
        asked_turn.as_deref(),
        "chat.approval",
        json!({"approvalId":id,"request":permission,
            "choices":allow_deny_choices(),"part":{"type":"approval","approvalId":id,"status":"pending","data":data}}),
        Some(&target.worker_token),
    );
}

fn opencode_permission_replied(
    target: &EventTarget,
    properties: &Value,
    session: &str,
    raw: &Value,
    turn: Option<&str>,
) {
    let request_id = properties.get("requestID").and_then(Value::as_str);
    if request_id.is_some_and(|id| {
        target
            .permission_sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(id).cloned())
            .is_some_and(|owner| owner != session)
    }) {
        return;
    }
    let known = request_id.and_then(|id| {
        target
            .permissions
            .lock()
            .ok()
            .and_then(|mut permissions| permissions.remove(id))
    });
    match (request_id, known) {
        (Some(id), Some(asked_turn)) => {
            if let Ok(mut settled) = target.settled_permissions.lock() {
                settled.insert(id.into());
            }
            if let Ok(mut sessions) = target.permission_sessions.lock() {
                sessions.remove(id);
            }
            let reply = properties
                .get("reply")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let status = match reply {
                "once" | "always" | "reject" => "resolved",
                "cancelled" | "canceled" => "expired",
                _ => "outcomeUnknown",
            };
            emit_scoped(
                &target.events,
                "opencode",
                &target.threadterm_session,
                Some(&target.native_id),
                asked_turn.turn.as_deref(),
                "chat.approval.resolved",
                json!({"approvalId":id,"status":status,"outcome":reply}),
                Some(&target.worker_token),
            );
        }
        _ => emit_scoped(
            &target.events,
            "opencode",
            &target.threadterm_session,
            Some(&target.native_id),
            turn,
            "provider.event",
            json!({"raw":raw,"note":if request_id.is_some() {"permission reply for an unknown or settled request"} else {"permission reply without a request id"}}),
            Some(&target.worker_token),
        ),
    }
}

fn opencode_question_payload(question: &Value) -> (Value, Vec<String>) {
    let questions = question
        .get("questions")
        .and_then(Value::as_array)
        .map(|questions| {
            questions.iter().enumerate().filter_map(|(index, question)| {
            let text = question.get("question").and_then(Value::as_str)?;
            let options = question.get("options").and_then(Value::as_array).map(|options| {
                options.iter().filter_map(|option| Some(json!({
                    "label": option.get("label")?.as_str()?,
                    "description": option.get("description").and_then(Value::as_str),
                }))).collect::<Vec<_>>()
            }).unwrap_or_default();
            Some(json!({
                "id":format!("q{index}"),
                "header":question.get("header").and_then(Value::as_str),
                "question":text,
                "options":options,
                "multiSelect":question.get("multiple").and_then(Value::as_bool).unwrap_or(false),
                "allowOther":question.get("custom").and_then(Value::as_bool).unwrap_or(true),
                "secret":false,
            }))
        }).collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let ids = questions
        .iter()
        .filter_map(|question| {
            question
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    (
        json!({"interaction":"question","answerable":!questions.is_empty(),"form":{"kind":"questions","questions":questions}}),
        ids,
    )
}

fn opencode_question_asked(
    target: &EventTarget,
    properties: &Value,
    session: &str,
    subagent: Option<&str>,
    turn: Option<String>,
) {
    let Some(id) = properties.get("id").and_then(Value::as_str) else {
        return;
    };
    if target
        .settled_permissions
        .lock()
        .ok()
        .is_some_and(|settled| settled.contains(id))
    {
        return;
    }
    let (payload, ids) = opencode_question_payload(properties);
    let asked_turn = turn.or_else(|| target.active.lock().ok().and_then(|turn| turn.clone()));
    let existing = target
        .permissions
        .lock()
        .ok()
        .and_then(|questions| questions.get(id).cloned());
    if existing.is_some() {
        return;
    }
    if let Ok(mut questions) = target.permissions.lock() {
        questions.insert(
            id.into(),
            OpenCodeInteraction {
                turn: asked_turn.clone(),
                question: Some(OpenCodeQuestion {
                    session: session.into(),
                    payload: payload.clone(),
                    ids,
                }),
            },
        );
    } else {
        return;
    }
    let mut data = payload;
    if let Some(key) = subagent {
        let label = target
            .subagents
            .lock()
            .ok()
            .and_then(|state| state.labels.get(key).cloned())
            .unwrap_or_else(|| "Subagent".into());
        data["subagent"] = json!({"key":key,"label":label});
    }
    emit_scoped(
        &target.events,
        "opencode",
        &target.threadterm_session,
        Some(&target.native_id),
        asked_turn.as_deref(),
        "chat.approval",
        json!({"approvalId":id,"request":properties,"part":{"type":"approval","approvalId":id,"status":"pending","data":data}}),
        Some(&target.worker_token),
    );
}

fn opencode_question_resolved(
    target: &EventTarget,
    event_type: &str,
    properties: &Value,
    session: &str,
    raw: &Value,
    turn: Option<&str>,
) {
    let request_id = properties
        .get("requestID")
        .or_else(|| properties.get("id"))
        .and_then(Value::as_str);
    let known = request_id.and_then(|id| {
        target.permissions.lock().ok().and_then(|mut questions| {
            questions
                .get(id)
                .and_then(|pending| pending.question.as_ref())
                .filter(|question| question.session == session)?;
            questions.remove(id)
        })
    });
    match (request_id, known) {
        (Some(id), Some(question)) => {
            if let Ok(mut settled) = target.settled_permissions.lock() {
                settled.insert(id.into());
            }
            let status = if event_type == "question.rejected" {
                "dismissed"
            } else {
                "answered"
            };
            let answer_summary = question.question.as_ref().and_then(|question| {
                let answers = properties.get("answers")?.as_array()?;
                let values = question
                    .ids
                    .iter()
                    .zip(answers)
                    .map(|(id, answer)| (id.clone(), answer.clone()))
                    .collect::<serde_json::Map<_, _>>();
                Some(answer_summary(
                    &question.payload,
                    &json!({"action":"submit","values":values}),
                ))
            });
            emit_scoped(
                &target.events,
                "opencode",
                &target.threadterm_session,
                Some(&target.native_id),
                question.turn.as_deref(),
                "chat.approval.resolved",
                json!({"approvalId":id,"status":status,"outcome":"native","answerSummary":answer_summary}),
                Some(&target.worker_token),
            );
        }
        _ => emit_scoped(
            &target.events,
            "opencode",
            &target.threadterm_session,
            Some(&target.native_id),
            turn,
            "provider.event",
            json!({"raw":raw,"note":format!("question reply from {session} for an unknown or settled request")}),
            Some(&target.worker_token),
        ),
    }
}

/// The state an SSE event may touch: everything except the transport reader.
/// Split out so the projection path is testable without a live socket.
struct OpenCodeAbort { turn: String, confirmed: bool, idle_observed: bool }
struct OpenCodeCompact { turn: String, confirmed: bool, idle_observed: bool }

struct EventTarget {
    threadterm_session: String,
    native_id: String,
    worker_token: String,
    events: crate::provider_events::Sender,
    active: Arc<Mutex<Option<String>>>,
    assembly: Arc<Mutex<OpenCodeAssembly>>,
    permissions: Arc<Mutex<HashMap<String, OpenCodeInteraction>>>,
    settled_permissions: Arc<Mutex<HashSet<String>>>,
    subagents: Mutex<OpenCodeSubagents>,
    permission_sessions: Mutex<HashMap<String, String>>,
    native_turn_observed: AtomicBool,
    stopped: Arc<AtomicBool>,
    event_gate: Arc<Mutex<()>>,
    liveness: Arc<AtomicBool>,
    snapshot_client: Client,
    base_url: String,
    directory: String,
    username: String,
    password: String,
    model_limits: HashMap<String, u64>,
    ui: Mutex<OpenCodeOptions>,
    abort_pending: Mutex<Option<OpenCodeAbort>>,
    retry_visible: AtomicBool,
    compact_pending: Mutex<Option<OpenCodeCompact>>,
}

impl EventTarget {
    fn hydrate(&self, messages: &Value, mut read: impl FnMut(&str) -> Result<Value, ProviderError>) {
        let mut read = |path: &str| {
            let result = read(path).and_then(|value| {
                if value.is_array() { Ok(value) }
                else { Err(ProviderError::new("provider_protocol", "OpenCode recovery response is not a list")) }
            });
            match result {
                Ok(value) => value,
                Err(error) => {
                    if !error.details.as_ref().and_then(|details| details["httpStatus"].as_u64()).is_some_and(|status| matches!(status, 404 | 405)) {
                        eprintln!("[opencode-recovery] {path} unavailable ({})", error.code);
                    }
                    // Unknown is not an authoritative empty snapshot. In
                    // particular, do not clear an existing plan on read failure.
                    Value::Null
                }
            }
        };
        let children = read(&format!("/session/{}/children", self.native_id));
        let todos = read(&format!("/session/{}/todo", self.native_id));
        let permissions = read("/permission");
        let questions = read("/question");
        self.hydrate_snapshots(messages, &children, &Value::Null, &json!([]), &json!([]));
        let mut visited = HashSet::new();
        loop {
            let next = self.subagents.lock().ok().and_then(|state| state.children.keys().find(|id| !visited.contains(*id)).cloned());
            let Some(child) = next else { break };
            if visited.len() >= 128 {
                eprintln!("[opencode-recovery] child-session safety bound reached");
                break;
            }
            visited.insert(child.clone());
            if child == self.native_id || validate_native_id(&child).is_err() { continue; }
            let messages = read(&format!("/session/{child}/message?limit={MAX_ASSEMBLED_MESSAGES}"));
            if messages.is_null() { continue; }
            if let Err(error) = self.hydrate_child_messages(&child, &messages) {
                eprintln!("[opencode-recovery] child messages unavailable ({})", error.code);
            }
        }
        self.hydrate_snapshots(&json!([]), &children, &todos, &permissions, &questions);
    }
    fn hydrate_child_messages(&self, child: &str, messages: &Value) -> Result<(), ProviderError> {
        if !self.subagents.lock().ok().is_some_and(|state| state.children.contains_key(child)) { return Ok(()); }
        let rows = messages.as_array().ok_or_else(|| ProviderError::new("provider_protocol", "OpenCode child recovery messages are not a list"))?;
        for row in rows {
            let info = row.get("info").unwrap_or(row);
            let id = info.get("id").and_then(Value::as_str).ok_or_else(|| ProviderError::new("provider_protocol", "OpenCode child message has no identity"))?;
            // Validate the entire snapshot's ownership before projecting it.
            native_message_parts(row, id, child)?;
        }
        for row in rows {
            emit_opencode_event(self, json!({"type":"message.updated","properties":{"info":row.get("info").unwrap_or(row)}}));
            for part in row.get("parts").and_then(Value::as_array).into_iter().flatten() {
                emit_opencode_event(self, json!({"type":"message.part.updated","properties":{"part":part}}));
            }
        }
        Ok(())
    }
    fn hydrate_snapshots(&self, messages: &Value, children: &Value, todos: &Value, permissions: &Value, questions: &Value) {
        // These calls use the same gate, identity checks and normalizers as SSE.
        // No native decision is posted by recovery.
        for row in messages.as_array().into_iter().flatten() {
            if row.pointer("/info/role").and_then(Value::as_str) != Some("assistant") { continue; }
            for part in row.get("parts").and_then(Value::as_array).into_iter().flatten().filter(|part| opencode_task_part(part)) {
                emit_opencode_event(self, json!({"type":"message.part.updated","properties":{"part":part}}));
            }
        }
        for child in children.as_array().into_iter().flatten() {
            let Some(id) = child.get("id").and_then(Value::as_str) else { continue };
            if child.get("parentID").and_then(Value::as_str) != Some(self.native_id.as_str()) || validate_native_id(id).is_err() { continue; }
            // Native fork branches also have parentID. A parent relationship
            // alone is not task ownership and must never expose its requests.
            if let Ok(mut state) = self.subagents.lock() {
                if state.children.contains_key(id) { state.parents.insert(id.into(), self.native_id.clone()); }
            }
        }
        let owned = |entry: &Value| entry.get("sessionID").and_then(Value::as_str).is_some_and(|session| session == self.native_id || self.subagents.lock().ok().is_some_and(|state| state.children.contains_key(session)));
        if permissions.as_array().into_iter().flatten().chain(questions.as_array().into_iter().flatten()).any(owned) {
            if let Ok(mut active) = self.active.lock() {
                if active.is_none() {
                    *active = Some(NATIVE_BUSY_TURN.to_owned());
                    emit_scoped(&self.events, "opencode", &self.threadterm_session, Some(&self.native_id), Some(NATIVE_BUSY_TURN), "chat.turn.started", json!({"resumedNativeTurn":true}), Some(&self.worker_token));
                }
            }
        }
        for (kind, entries) in [("permission.asked", permissions), ("question.asked", questions)] {
            for entry in entries.as_array().into_iter().flatten().filter(|entry| owned(entry)) {
                emit_opencode_event(self, json!({"type":kind,"properties":entry}));
            }
        }
        if todos.is_array() { emit_opencode_event(self, json!({"type":"todo.updated","properties":{"sessionID":self.native_id,"todos":todos}})); }
    }
    fn finish_compact(&self, operation_id: &str, result: Result<(), ProviderError>) -> Result<(), ProviderError> {
        if let Err(error) = self.finish_prompt(operation_id, result) {
            if let Ok(mut pending) = self.compact_pending.lock() { *pending = None; }
            return Err(error);
        }
        let _commit = self.event_gate.lock().map_err(|_| ProviderError::new("provider_internal", "OpenCode event gate poisoned"))?;
        let mut pending = self.compact_pending.lock().map_err(|_| ProviderError::new("provider_internal", "OpenCode compact lock poisoned"))?;
        let Some(compact) = pending.as_mut().filter(|compact| compact.turn == operation_id) else { return Ok(()) };
        compact.confirmed = true;
        if compact.idle_observed {
            *pending = None;
            drop(pending);
            self.complete_compact(operation_id);
        }
        Ok(())
    }
    // Called under event_gate only once both HTTP true and native idle agree.
    fn complete_compact(&self, operation_id: &str) {
        if self.active.lock().ok().is_some_and(|active| active.as_deref() == Some(operation_id)) {
            emit_scoped(&self.events, "opencode", &self.threadterm_session, Some(&self.native_id), Some(operation_id), "chat.item",
                json!({"item":{"id":format!("compact:{operation_id}")},"parts":[{"type":"text","text":"Conversation compacted by OpenCode.","data":{"kind":"commandResult","command":"compact"}}]}), Some(&self.worker_token));
            self.complete_turn("completed", json!({"compacted":true}));
        }
    }
    // After attachment, called under event_gate. Replace one stable retry item.
    fn retry_status(&self, status: Option<&Value>, turn: Option<&str>) {
        let parts = if let Some(status) = status.filter(|status| status.get("type").and_then(Value::as_str) == Some("retry")) {
            let Some(attempt) = status.get("attempt").and_then(Value::as_u64) else { return };
            let Some(message) = status.get("message").and_then(Value::as_str) else { return };
            let Some(next) = status.get("next").and_then(Value::as_u64) else { return };
            self.retry_visible.store(true, Ordering::SeqCst);
            json!([{"type":"status","text":format!("OpenCode is retrying (attempt {attempt}): {message}"),
                "data":{"kind":"providerRetry","state":"retrying","attempt":attempt,"message":message,"next":next}}])
        } else {
            if !self.retry_visible.swap(false, Ordering::SeqCst) { return; }
            json!([])
        };
        emit_scoped(&self.events, "opencode", &self.threadterm_session, Some(&self.native_id), turn,
            "chat.item", json!({"item":{"id":format!("{}:retry",self.native_id)},"parts":parts}), Some(&self.worker_token));
    }
    fn complete_turn(&self, status: &str, raw: Value) {
        let turn = self.active.lock().ok().and_then(|mut active| active.take());
        if let Some(turn) = turn.as_deref() {
            if let Ok(mut compact) = self.compact_pending.lock() {
                if compact.as_ref().is_some_and(|pending| pending.turn == turn) { *compact = None; }
            }
        }
        self.retry_status(None, turn.as_deref());
        if let Some(turn) = turn {
            emit_scoped(&self.events, "opencode", &self.threadterm_session, Some(&self.native_id), Some(&turn),
                "chat.turn.completed", json!({"status":status,"raw":raw}), Some(&self.worker_token));
        }
    }
    fn native_idle(&self, status: &str, raw: Value) {
        let mut pending = match self.abort_pending.lock() { Ok(pending) => pending, Err(_) => return };
        let status = if let Some(abort) = pending.as_mut() {
            abort.idle_observed = true;
            if !abort.confirmed { return; }
            *pending = None;
            "interrupted"
        } else {
            let mut compact = match self.compact_pending.lock() { Ok(compact) => compact, Err(_) => return };
            if let Some(action) = compact.as_mut() {
                action.idle_observed = true;
                if !action.confirmed { return; }
                let turn = action.turn.clone();
                *compact = None;
                drop(compact);
                drop(pending);
                self.complete_compact(&turn);
                return;
            }
            status
        };
        drop(pending);
        self.complete_turn(status, raw);
    }
    fn finish_abort(&self, turn_id: &str, result: Result<(), ProviderError>) -> Result<(), ProviderError> {
        let commit = self.event_gate.lock().map_err(|_| ProviderError::new("provider_internal", "OpenCode event gate poisoned"))?;
        if let Err(error) = result {
            if let Ok(mut pending) = self.abort_pending.lock() { *pending = None; }
            expire_stream_locked(self, "abort_result_unknown", &error.message, &commit);
            return Err(error);
        }
        if !self.liveness.load(Ordering::SeqCst) || self.stopped.load(Ordering::SeqCst) {
            return Err(ProviderError::new("abort_result_unknown", "OpenCode Stop result is unknown after event-stream loss"));
        }
        let active = self.active.lock().ok().is_some_and(|active| active.as_deref() == Some(turn_id));
        let mut pending = self.abort_pending.lock().map_err(|_| ProviderError::new("provider_internal", "OpenCode abort lock poisoned"))?;
        if !active { *pending = None; return Ok(()); }
        if let Some(abort) = pending.as_mut().filter(|abort| abort.turn == turn_id) {
            abort.confirmed = true;
            // Preserve the active slot until native idle: an idle buffered after
            // the HTTP reply must not complete the user's following turn.
            if abort.idle_observed {
                *pending = None;
                drop(pending);
                self.complete_turn("interrupted", json!({"abortConfirmed":true}));
            }
        }
        Ok(())
    }
    /// HTTP and native events settle under the same gate; an early native
    /// permission/idle/error must never be followed by a late turn-start.
    fn finish_prompt(
        &self,
        operation_id: &str,
        result: Result<(), ProviderError>,
    ) -> Result<(), ProviderError> {
        let commit = self.event_gate.lock().map_err(|_| {
            self.liveness.store(false, Ordering::SeqCst);
            ProviderError::new("provider_internal", "OpenCode event gate poisoned")
        })?;
        if let Err(error) = result {
            let status = error.details.as_ref()
                .and_then(|details| details.get("httpStatus"))
                .and_then(Value::as_u64);
            let uncertain = error.code == "provider_disconnected"
                || status.is_none_or(|status| status >= 500)
                || self.native_turn_observed.load(Ordering::SeqCst);
            if uncertain {
                // A 5xx, lost reply, or native event before the HTTP failure
                // cannot prove the prompt was rejected. Never replay it.
                expire_stream_locked(self, "send_result_unknown", &error.message, &commit);
            } else if let Ok(mut active) = self.active.lock() {
                if active.as_deref() == Some(operation_id) {
                    *active = None;
                    emit_scoped(
                        &self.events, "opencode", &self.threadterm_session,
                        Some(&self.native_id), Some(operation_id), "chat.error",
                        json!({"message":error.message.clone(),"reason":"prompt_rejected"}),
                        Some(&self.worker_token),
                    );
                }
            }
            return Err(error);
        }
        if !self.liveness.load(Ordering::SeqCst) || self.stopped.load(Ordering::SeqCst) {
            return Err(ProviderError::new(
                "provider_disconnected",
                "OpenCode prompt result is uncertain after event-stream loss",
            ));
        }
        Ok(())
    }

    fn assembled_parts(
        &self,
        message_id: &str,
        local_update: impl FnOnce(&mut OpenCodeAssembly) -> Vec<Value>,
    ) -> Result<(Vec<Value>, Option<String>), ProviderError> {
        let native_required = self
            .assembly
            .lock()
            .map_err(|_| {
                ProviderError::new(
                    "provider_internal",
                    "OpenCode message assembly lock poisoned",
                )
            })?
            .requires_native_snapshot(message_id);
        if native_required {
            self.snapshot_parts(message_id)
        } else {
            let (parts, created_at, overflow) = self
                .assembly
                .lock()
                .map(|mut assembly| {
                    let parts = local_update(&mut assembly);
                    let created_at = assembly.created_at.get(message_id).cloned();
                    let overflow = assembly.exceeds_payload_budget();
                    if overflow {
                        assembly.discard_local_cache();
                    }
                    (parts, created_at, overflow)
                })
                .map_err(|_| {
                    ProviderError::new(
                        "provider_internal",
                        "OpenCode message assembly lock poisoned",
                    )
                })?;
            if overflow {
                self.snapshot_parts(message_id)
            } else {
                Ok((parts, created_at))
            }
        }
    }

    fn snapshot_parts(&self, message_id: &str) -> Result<(Vec<Value>, Option<String>), ProviderError> {
        validate_native_id(message_id)?;
        // OpenCode's 1.18.31 GET /session/{id}/message/{messageID} returns the
        // complete current message. Reading it for each event on a seeded
        // message costs one HTTP request per event, but avoids appending a
        // buffered delta already represented by the startup snapshot. A
        // future coalesced refresh must keep the same native authority.
        let response = self
            .snapshot_client
            .get(format!(
                "{}/session/{}/message/{message_id}",
                self.base_url, self.native_id
            ))
            .basic_auth(&self.username, Some(&self.password))
            .query(&[("directory", &self.directory)])
            .send()
            .map_err(|error| {
                ProviderError::new(
                    "provider_disconnected",
                    format!("OpenCode message snapshot failed: {error}"),
                )
            })?;
        if !response.status().is_success() {
            return Err(ProviderError::new(
                "provider_error",
                format!("OpenCode message snapshot returned {}", response.status()),
            ));
        }
        let row: Value = response.json().map_err(|error| {
            ProviderError::new(
                "provider_protocol",
                format!("OpenCode message snapshot is invalid: {error}"),
            )
        })?;
        let created_at = opencode_message_created_at(row.get("info").unwrap_or(&row));
        Ok((native_message_parts(&row, message_id, &self.native_id)?
            .into_iter()
            .map(|(_, part)| part)
            .collect(), created_at))
    }

    fn fail_snapshot(&self, error: ProviderError) {
        expire_stream(self, "message_snapshot_failed", &error.message);
    }
}

struct SseContext {
    reader: BufReader<Response>,
    target: Arc<EventTarget>,
    stopped: Arc<AtomicBool>,
    liveness: Arc<AtomicBool>,
}

fn valid_native_sse_frame(raw: &Value) -> bool {
    let payload = raw.get("payload").unwrap_or(raw);
    payload
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| !kind.is_empty())
        && payload.get("properties").is_some_and(Value::is_object)
}

fn sse_event_silent_since(last_valid: Instant, now: Instant) -> bool {
    now.saturating_duration_since(last_valid) >= SSE_EVENT_SILENCE_LIMIT
}

fn refresh_sse_clock(target: &EventTarget, clock: &Mutex<Instant>) {
    let Ok(_commit) = target.event_gate.lock() else {
        return;
    };
    if !target.stopped.load(Ordering::SeqCst) && target.liveness.load(Ordering::SeqCst) {
        if let Ok(mut last_valid) = clock.lock() {
            *last_valid = Instant::now();
        }
    }
}

fn read_bounded_sse_line(reader: &mut impl BufRead, line: &mut Vec<u8>) -> io::Result<usize> {
    line.clear();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(line.len());
        }
        let count = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if line.len() + count > MAX_SSE_LINE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "OpenCode SSE line exceeds the bounded frame size",
            ));
        }
        let finished = available[count - 1] == b'\n';
        line.extend_from_slice(&available[..count]);
        reader.consume(count);
        if finished {
            return Ok(line.len());
        }
    }
}

fn expire_stream(target: &EventTarget, reason: &str, message: &str) {
    // This same short gate protects every native-event commit. It is never
    // held while reading SSE or fetching an authoritative message snapshot.
    let Ok(guard) = target.event_gate.lock() else {
        target.liveness.store(false, Ordering::SeqCst);
        return;
    };
    expire_stream_locked(target, reason, message, &guard);
}

fn expire_silent_stream(target: &EventTarget, clock: &Mutex<Instant>) -> bool {
    let Ok(guard) = target.event_gate.lock() else {
        target.liveness.store(false, Ordering::SeqCst);
        return true;
    };
    let overdue = clock
        .lock()
        .map(|last_valid| sse_event_silent_since(*last_valid, Instant::now()))
        .unwrap_or(true);
    if overdue {
        expire_stream_locked(
            target,
            "event_stream_silent",
            "OpenCode event heartbeat was not received; permission outcome is unknown",
            &guard,
        );
    }
    overdue
}

fn expire_stream_locked(
    target: &EventTarget,
    reason: &str,
    message: &str,
    _guard: &std::sync::MutexGuard<'_, ()>,
) {
    if target.stopped.load(Ordering::SeqCst)
        || !target.liveness.swap(false, Ordering::SeqCst)
        || target.stopped.load(Ordering::SeqCst)
    {
        return;
    }
    target.retry_status(None, target.active.lock().ok().as_deref().and_then(|active| active.as_deref()));
    let pending = target
        .permissions
        .lock()
        .map(|mut permissions| std::mem::take(&mut *permissions))
        .unwrap_or_default();
    if let Ok(mut sessions) = target.permission_sessions.lock() {
        sessions.clear();
    }
    for (approval_id, asked_turn) in pending {
        emit_scoped(
            &target.events,
            "opencode",
            &target.threadterm_session,
            Some(&target.native_id),
            asked_turn.turn.as_deref(),
            "chat.approval.resolved",
            json!({"approvalId":approval_id,"status":"expired","outcome":"unknown","message":message}),
            Some(&target.worker_token),
        );
    }
    let failed = target.active.lock().ok().and_then(|mut value| value.take());
    emit_scoped(
        &target.events,
        "opencode",
        &target.threadterm_session,
        Some(&target.native_id),
        failed.as_deref(),
        "chat.error",
        json!({"message":message,"reason":reason}),
        Some(&target.worker_token),
    );
    emit_scoped(
        &target.events,
        "opencode",
        &target.threadterm_session,
        Some(&target.native_id),
        None,
        "session.closed",
        json!({"reason":reason}),
        Some(&target.worker_token),
    );
}

fn spawn_sse(context: SseContext) -> Result<(), ProviderError> {
    let last_valid_event = Arc::new(Mutex::new(Instant::now()));
    let watchdog_target = Arc::clone(&context.target);
    let watchdog_clock = Arc::clone(&last_valid_event);
    thread::Builder::new()
        .name(format!(
            "opencode-sse-{}",
            context.target.threadterm_session
        ))
        .spawn(move || {
            let SseContext {
                mut reader,
                target,
                stopped,
                liveness,
            } = context;
            let mut line = Vec::new();
            let mut data = String::new();
            loop {
                match read_bounded_sse_line(&mut reader, &mut line) {
                    Ok(0) => break,
                    Err(_) => break,
                    Ok(_) => {
                        if stopped.load(Ordering::SeqCst) || !liveness.load(Ordering::SeqCst) {
                            break;
                        }
                        let Ok(line_text) = std::str::from_utf8(&line) else {
                            break;
                        };
                        let trimmed = line_text.trim_end_matches(['\r', '\n']);
                        if let Some(value) = trimmed.strip_prefix("data:") {
                            if data.len() + value.len() + 1 > MAX_SSE_LINE_BYTES {
                                break;
                            }
                            if !data.is_empty() {
                                data.push('\n');
                            }
                            data.push_str(value.trim_start());
                        } else if trimmed.is_empty() && !data.is_empty() {
                            if let Ok(raw) = serde_json::from_str::<Value>(&data) {
                                if valid_native_sse_frame(&raw) {
                                    refresh_sse_clock(&target, &last_valid_event);
                                    emit_opencode_event(&target, raw);
                                }
                            }
                            data.clear();
                        }
                    }
                }
            }
            // EOF, malformed framing and watchdog timeout share one terminal
            // transition. The CAS prevents duplicate card expiry or errors.
            expire_stream(
                &target,
                "event_stream_disconnected",
                "OpenCode event stream disconnected; permission outcome is unknown",
            );
        })
        .map_err(|error| {
            ProviderError::new(
                "provider_internal",
                format!("OpenCode event reader could not start: {error}"),
            )
        })?;
    thread::Builder::new()
        .name(format!(
            "opencode-sse-watchdog-{}",
            watchdog_target.threadterm_session
        ))
        .spawn(move || {
            while !watchdog_target.stopped.load(Ordering::SeqCst)
                && watchdog_target.liveness.load(Ordering::SeqCst)
            {
                thread::sleep(SSE_WATCHDOG_POLL);
                if expire_silent_stream(&watchdog_target, &watchdog_clock) {
                    break;
                }
            }
        })
        .map_err(|error| {
            ProviderError::new(
                "provider_internal",
                format!("OpenCode event watchdog could not start: {error}"),
            )
        })?;
    Ok(())
}

fn emit_opencode_event(target: &EventTarget, raw: Value) {
    if target.stopped.load(Ordering::SeqCst) || !target.liveness.load(Ordering::SeqCst) {
        return;
    }
    let payload = raw.get("payload").unwrap_or(&raw);
    let properties = payload.get("properties").unwrap_or(payload);
    let event_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("provider.event");

    // Global events never project. Foreign events wait for proven task/session
    // ownership; only bound descendants may enter the subagent transcript.
    let Some(event_session) = opencode_event_session(event_type, properties) else {
        return;
    };
    let Ok(commit_guard) = target.event_gate.lock() else {
        return;
    };
    if target.stopped.load(Ordering::SeqCst) || !target.liveness.load(Ordering::SeqCst) {
        return;
    }
    if event_session != target.native_id {
        let pending = {
            let Ok(mut state) = target.subagents.lock() else {
                return;
            };
            if matches!(event_type, "session.created" | "session.updated") {
                if let Some(parent) = properties.pointer("/info/parentID").and_then(Value::as_str) {
                    state.parents.insert(event_session.into(), parent.into());
                }
            }
            let root = state.children.get(event_session).cloned().or_else(|| {
                state
                    .parents
                    .get(event_session)
                    .and_then(|parent| state.children.get(parent))
                    .cloned()
            });
            if let Some(root) = root {
                state.bind(event_session, &root)
            } else {
                if matches!(
                    event_type,
                    "message.updated"
                        | "message.part.updated"
                        | "session.error"
                        | "permission.asked"
                        | "permission.updated"
                        | "permission.replied"
                        | "question.asked"
                        | "question.replied"
                        | "question.rejected"
                ) {
                    state.buffer(event_session, raw.clone());
                }
                return;
            }
        };
        for event in pending {
            emit_opencode_child_event(target, event);
        }
        emit_opencode_child_event(target, raw);
        return;
    }
    let native_id = Some(target.native_id.as_str());
    let turn = target.active.lock().ok().and_then(|value| value.clone());
    if turn.is_some() {
        target.native_turn_observed.store(true, Ordering::SeqCst);
    }

    // Native summarize writes a hidden summary message. Its confirmed receipt
    // is the one visible result; do not also project the implementation reply.
    if target.compact_pending.lock().ok().is_some_and(|pending| pending.is_some()) && event_type.starts_with("message.") {
        if let Some(id) = properties.pointer("/info/id").or_else(|| properties.pointer("/part/messageID")).or_else(|| properties.get("messageID")).and_then(Value::as_str) {
            if let Ok(mut assembly) = target.assembly.lock() {
                if assembly.user_messages.len() >= MAX_ASSEMBLED_MESSAGES { assembly.user_messages.clear(); }
                assembly.user_messages.insert(id.to_owned());
            }
        }
        return;
    }
    match event_type {
        "question.asked" => opencode_question_asked(target, properties, event_session, None, turn),
        "question.replied" | "question.rejected" => opencode_question_resolved(
            target,
            event_type,
            properties,
            event_session,
            &raw,
            turn.as_deref(),
        ),
        "message.updated" => {
            let info = properties.get("info").unwrap_or(properties);
            if let (Some(message_id), Some(created_at)) = (info.get("id").and_then(Value::as_str), opencode_message_created_at(info)) {
                if let Ok(mut assembly) = target.assembly.lock() { assembly.remember_created_at(message_id, created_at); }
            }
            if info.get("role").and_then(Value::as_str) == Some("user") || info.get("summary").and_then(Value::as_bool) == Some(true) {
                if let Some(message_id) = info.get("id").and_then(Value::as_str) {
                    let shown = target.assembly.lock().ok().is_some_and(|mut assembly| {
                        if assembly.user_messages.len() >= MAX_ASSEMBLED_MESSAGES {
                            assembly.user_messages.clear();
                        }
                        assembly.user_messages.insert(message_id.to_owned());
                        assembly.order.retain(|id| id != message_id);
                        assembly.messages.remove(message_id).is_some()
                    });
                    // A part published before its role was known is withdrawn.
                    if shown {
                        emit_scoped(
                            &target.events,
                            "opencode",
                            &target.threadterm_session,
                            native_id,
                            turn.as_deref(),
                            "chat.item",
                            json!({"item":{"id":message_id},"parts":[]}),
                            Some(&target.worker_token),
                        );
                    }
                }
            }
            if info.get("role").and_then(Value::as_str) == Some("assistant") && info.get("summary").and_then(Value::as_bool) != Some(true) {
                if let (Some(provider), Some(model)) = (info.get("providerID").and_then(Value::as_str), info.get("modelID").and_then(Value::as_str)) {
                    if let Ok(mut ui) = target.ui.lock() { ui.effective_model = Some(json!({"providerID":provider,"modelID":model})); }
                }
                if let Some(usage) = opencode_context_usage(info, &target.model_limits) {
                    // An assistant message's tokens are its latest step, like
                    // Codex's `last` usage; they also fill the turn footer.
                    let mut data = json!({"usage":usage});
                    if turn.is_some() {
                        data["turnUsage"] = usage.clone();
                        if let (Some(provider), Some(model)) = (info.get("providerID").and_then(Value::as_str), info.get("modelID").and_then(Value::as_str)) {
                            data["model"] = json!(format!("{provider}/{model}"));
                        }
                    }
                    if let (Some(call_id), Some(output_tokens)) = (
                        info.get("id").and_then(Value::as_str),
                        usage.get("outputTokens").and_then(Value::as_u64),
                    ) {
                        emit_scoped(
                            &target.events,
                            "opencode",
                            &target.threadterm_session,
                            native_id,
                            turn.as_deref(),
                            "chat.speed.usage",
                            json!({"callId":call_id,"outputTokens":output_tokens}),
                            Some(&target.worker_token),
                        );
                    }
                    emit_scoped(
                        &target.events,
                        "opencode",
                        &target.threadterm_session,
                        native_id,
                        turn.as_deref(),
                        "chat.context",
                        data,
                        Some(&target.worker_token),
                    );
                }
            }
            emit_scoped(
                &target.events,
                "opencode",
                &target.threadterm_session,
                native_id,
                turn.as_deref(),
                "provider.event",
                json!({"raw":raw}),
                Some(&target.worker_token),
            );
        }
        "session.created" | "session.updated" => {
            let info = properties.get("info").unwrap_or(properties);
            if let Some(title) = info.get("title").and_then(Value::as_str).map(str::trim).filter(|title| !title.is_empty()) {
                emit_scoped(
                    &target.events,
                    "opencode",
                    &target.threadterm_session,
                    native_id,
                    None,
                    "chat.title",
                    json!({"title":title}),
                    Some(&target.worker_token),
                );
            }
        }
        "message.part.updated" => {
            let part = properties.get("part").cloned().unwrap_or(Value::Null);
            let (Some(part_id), Some(message_id)) = (
                part.get("id").and_then(Value::as_str),
                part.get("messageID").and_then(Value::as_str),
            ) else {
                return;
            };
            if !opencode_visible_part(&part)
                || target.assembly.lock().ok().is_some_and(|assembly| assembly.user_messages.contains(message_id))
            {
                return;
            }
            if opencode_task_part(&part) {
                // Remove any cached representation, including one seeded from
                // native history. Task activity belongs only to its card.
                if let Ok(mut assembly) = target.assembly.lock() {
                    if let Some(message) = assembly.messages.get_mut(message_id) {
                        message.parts.remove(part_id);
                        message.order.retain(|id| id != part_id);
                    }
                }
                opencode_task_update(target, &part, None, turn.as_deref());
                return;
            }
            drop(commit_guard);
            let (snapshot, created_at) = match target.assembled_parts(message_id, |assembly| {
                assembly.apply_full_part(message_id, part_id, opencode_chat_part(&part))
            }) {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    target.fail_snapshot(error);
                    return;
                }
            };
            let Ok(_commit_guard) = target.event_gate.lock() else {
                return;
            };
            if target.stopped.load(Ordering::SeqCst) || !target.liveness.load(Ordering::SeqCst) {
                return;
            }
            let mut data=json!({"item":{"id":message_id},"parts":snapshot,"forkAnchor":{"nativeId":target.native_id,"messageId":message_id},"raw":raw,"speedCallId":message_id});
            if let Some(created_at)=created_at {data["item"]["createdAt"]=json!(created_at);}
            emit_scoped(
                &target.events,
                "opencode",
                &target.threadterm_session,
                native_id,
                turn.as_deref(),
                "chat.item",
                data,
                Some(&target.worker_token),
            );
        }
        "message.part.delta" => {
            let (Some(message_id), Some(part_id)) = (
                properties.get("messageID").and_then(Value::as_str),
                properties.get("partID").and_then(Value::as_str),
            ) else {
                return;
            };
            let field = properties
                .get("field")
                .and_then(Value::as_str)
                .unwrap_or("text");
            let delta = properties
                .get("delta")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if field != "text"
                || delta.is_empty()
                || target.assembly.lock().ok().is_some_and(|assembly| assembly.user_messages.contains(message_id))
            {
                return;
            }
            drop(commit_guard);
            let (snapshot, created_at) = match target.assembled_parts(message_id, |assembly| {
                assembly.apply_text_delta(message_id, part_id, delta)
            }) {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    target.fail_snapshot(error);
                    return;
                }
            };
            let Ok(_commit_guard) = target.event_gate.lock() else {
                return;
            };
            if target.stopped.load(Ordering::SeqCst) || !target.liveness.load(Ordering::SeqCst) {
                return;
            }
            let mut data=json!({"item":{"id":message_id},"parts":snapshot,"forkAnchor":{"nativeId":target.native_id,"messageId":message_id},"raw":raw,"speedCallId":message_id});
            if let Some(created_at)=created_at {data["item"]["createdAt"]=json!(created_at);}
            emit_scoped(
                &target.events,
                "opencode",
                &target.threadterm_session,
                native_id,
                turn.as_deref(),
                "chat.item",
                data,
                Some(&target.worker_token),
            );
        }
        "permission.asked" | "permission.updated" => {
            opencode_permission_asked(
                target,
                event_type,
                properties,
                &target.native_id,
                None,
                turn,
            );
        }
        "permission.replied" => {
            opencode_permission_replied(
                target,
                properties,
                &target.native_id,
                &raw,
                turn.as_deref(),
            );
        }
        "session.status" => {
            let status = properties.get("status").unwrap_or(&Value::Null);
            match status.get("type").and_then(Value::as_str) {
                Some("retry") if turn.is_some() => target.retry_status(Some(status), turn.as_deref()),
                Some("busy") => target.retry_status(None, turn.as_deref()),
                Some("idle") => target.retry_status(None, turn.as_deref()),
                _ => {}
            }
        }
        "session.idle" => {
            target.native_idle("completed", raw);
        }
        "session.error" => {
            let error = properties.get("error").unwrap_or(properties);
            let mut data = opencode_error(error);
            if data["category"] == "interrupted" {
                if target.abort_pending.lock().ok().is_some_and(|pending| pending.is_some()) { return; }
                target.complete_turn("interrupted", raw);
            } else {
                let failed = target.active.lock().ok().and_then(|mut value| value.take());
                target.retry_status(None, failed.as_deref());
                data["raw"] = raw;
                emit_scoped(&target.events, "opencode", &target.threadterm_session, native_id, failed.as_deref(),
                    "chat.error", data, Some(&target.worker_token));
            }
        }
        // OpenCode 1.18 publishes the session todo list (`todowrite`) as
        // `todo.updated {sessionID, todos:[{content, status, priority}]}`, the
        // same entries as an ACP plan update; it feeds the turn's plan panel.
        "todo.updated" => {
            let todos = properties.get("todos").and_then(Value::as_array).cloned().unwrap_or_default();
            let entries = todos.iter().map(|todo| (
                todo.get("content").and_then(Value::as_str).unwrap_or_default().to_owned(),
                todo.get("status").and_then(Value::as_str).unwrap_or("pending").to_owned(),
                todo.get("priority").and_then(Value::as_str).map(ToOwned::to_owned),
            ));
            if let Some(data) = crate::chat_plan::plan_data(entries, None) {
                emit_scoped(
                    &target.events,
                    "opencode",
                    &target.threadterm_session,
                    native_id,
                    turn.as_deref(),
                    "chat.item",
                    json!({"item":{"id":format!("{}:todos",target.native_id)},"part":crate::chat_plan::plan_part(data, turn.as_deref())}),
                    Some(&target.worker_token),
                );
            } else {
                emit_scoped(&target.events, "opencode", &target.threadterm_session, native_id, turn.as_deref(), "chat.item",
                    json!({"item":{"id":format!("{}:todos",target.native_id)},"parts":[]}), Some(&target.worker_token));
            }
        }
        _ => {
            emit_scoped(
                &target.events,
                "opencode",
                &target.threadterm_session,
                native_id,
                turn.as_deref(),
                "provider.event",
                json!({"raw":raw}),
                Some(&target.worker_token),
            );
        }
    }
}

fn opencode_provider_context_limits(value: &Value) -> HashMap<String, u64> {
    let providers = value.get("all").or_else(|| value.get("providers")).unwrap_or(value);
    let Some(providers) = providers.as_array() else { return HashMap::new() };
    let mut limits = HashMap::new();
    for provider in providers {
        let provider_id = provider.get("id").and_then(Value::as_str).unwrap_or_default();
        let Some(models) = provider.get("models").and_then(Value::as_object) else { continue };
        for (model_id, model) in models {
            let Some(context) = model.pointer("/limit/context").and_then(Value::as_u64).filter(|v| *v > 0) else { continue };
            limits.insert(format!("{provider_id}/{model_id}"), context);
        }
    }
    limits
}

fn opencode_context_usage(info: &Value, model_limits: &HashMap<String, u64>) -> Option<Value> {
    let tokens = info.get("tokens")?;
    let read = tokens.pointer("/cache/read").and_then(Value::as_u64)
        .or_else(|| tokens.get("cacheRead").and_then(Value::as_u64));
    let write = tokens.pointer("/cache/write").and_then(Value::as_u64)
        .or_else(|| tokens.get("cacheWrite").and_then(Value::as_u64));
    let input = tokens.get("input").and_then(Value::as_u64);
    let output = tokens.get("output").and_then(Value::as_u64);
    let total = tokens.get("total").and_then(Value::as_u64).or_else(|| {
        Some(input?.saturating_add(output?).saturating_add(read.unwrap_or(0)).saturating_add(write.unwrap_or(0)))
    });
    let window = info.pointer("/model/limit/context").and_then(Value::as_u64)
        .or_else(|| info.pointer("/model/limit/contextWindow").and_then(Value::as_u64))
        .or_else(|| {
            let model = info.get("modelID").and_then(Value::as_str)?;
            let provider = info.get("providerID").and_then(Value::as_str)?;
            model_limits.get(&format!("{provider}/{model}")).copied()
        })
        .filter(|window| *window > 0);
    if input.is_none() && output.is_none() && total.is_none() {
        return None;
    }
    let mut usage = serde_json::Map::new();
    if let Some(value) = input { usage.insert("inputTokens".into(), json!(value)); }
    if let Some(value) = output { usage.insert("outputTokens".into(), json!(value)); }
    if let Some(value) = read { usage.insert("cacheReadTokens".into(), json!(value)); }
    if let Some(value) = write { usage.insert("cacheWriteTokens".into(), json!(value)); }
    if let Some(value) = total {
        usage.insert("totalTokens".into(), json!(value));
        usage.insert("usedTokens".into(), json!(value));
    }
    if let Some(value) = window {
        usage.insert("windowTokens".into(), json!(value));
        if let Some(used) = total { usage.insert("percent".into(), json!(((used as f64 / value as f64) * 100.0).clamp(0.0, 100.0))); }
    }
    Some(Value::Object(usage))
}

fn opencode_chat_part(part: &Value) -> Value {
    let part_type = part.get("type").and_then(Value::as_str);
    if matches!(part_type, Some("text" | "reasoning")) {
        return json!({
            "type":if part_type == Some("reasoning") { "thinking" } else { "text" },
            "text":part.get("text").and_then(Value::as_str).unwrap_or_default()
        });
    }
    let kind = part
        .get("tool")
        .or_else(|| part.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let mut normalized = json!({"type":"tool","toolName":kind,"data":part});
    insert_optional(
        &mut normalized,
        "toolId",
        part.get("id")
            .or_else(|| part.get("callID"))
            .and_then(Value::as_str)
            .map(|value| json!(value)),
    );
    insert_optional(
        &mut normalized,
        "status",
        part.get("state")
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str)
            .map(|value| json!(value)),
    );
    normalized
}

fn opencode_history_item(row: &Value, cwd: Option<&str>) -> Option<Value> {
    if row.get("parentID").is_some_and(|value| !value.is_null()) {
        return None;
    }
    let id = row.get("id")?.as_str()?;
    let directory = row.get("directory").and_then(Value::as_str);
    if cwd.is_some() && directory != cwd {
        return None;
    }
    let updated = row
        .get("updated")
        .or_else(|| row.get("time").and_then(|v| v.get("updated")))
        .and_then(Value::as_i64)
        .and_then(|value| Utc.timestamp_millis_opt(value).single())
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let mut item = json!({"provider":"opencode","nativeId":id,"title":row.get("title").and_then(Value::as_str).unwrap_or("OpenCode session"),"updatedAt":updated,"resumable":true});
    insert_optional(&mut item, "cwd", directory.map(|value| json!(value)));
    Some(item)
}

fn opencode_transcript(raw: &Value) -> Vec<Value> {
    let messages = raw
        .get("messages")
        .or_else(|| raw.get("data"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    messages.into_iter().enumerate().filter_map(|(index, entry)| {
        let info = entry.get("info").unwrap_or(&entry);
        let role = info.get("role").and_then(Value::as_str)?;
        if !matches!(role, "user" | "assistant") || info.get("summary").and_then(Value::as_bool) == Some(true) { return None; }
        let mut parts = entry.get("parts").and_then(Value::as_array).into_iter().flatten()
            .filter(|part| opencode_visible_part(part) && !opencode_task_part(part)).map(opencode_chat_part).collect::<Vec<_>>();
        if role == "user" {
            let images = entry.get("parts").and_then(Value::as_array).into_iter().flatten().filter(|part| part.get("type").and_then(Value::as_str) == Some("file"))
                .filter_map(|part| part.get("url").and_then(Value::as_str).filter(|url| url.starts_with("data:image/"))).map(str::to_owned).collect::<Vec<_>>();
            if !images.is_empty() {
                parts.retain(|part| !part.pointer("/data/url").and_then(Value::as_str).is_some_and(|url| images.iter().any(|image| image == url)));
                if !parts.iter().any(|part| part["type"] == "text") { parts.insert(0, json!({"type":"text","text":""})); }
                if let Some(text) = parts.iter_mut().find(|part| part["type"] == "text") { text["data"] = json!({"images":images}); }
            }
        }
        crate::file_references::enrich_parts(&mut parts);
        let id = info.get("id").and_then(Value::as_str).map(ToOwned::to_owned).unwrap_or_else(|| format!("opencode-{index}"));
        let created = info.pointer("/time/created").and_then(Value::as_i64).and_then(|value| Utc.timestamp_millis_opt(value).single())
            .map(|value| value.to_rfc3339()).unwrap_or_else(|| Utc::now().to_rfc3339());
        let mut item = json!({"id":id,"role":role,"parts":parts,"createdAt":created,"turnOrigin":"history"});
        let native = info.get("sessionID").or_else(|| raw.pointer("/info/id")).and_then(Value::as_str);
        if role == "assistant" {
            if let Some(native) = native { item["forkAnchor"] = json!({"nativeId":native,"messageId":id}); }
            if info.pointer("/time/completed").is_some() || info.get("finish").is_some() { item["turnStatus"] = json!("completed"); }
        }
        Some(item)
    }).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn oc2_native_catalogue_dispatches_only_exact_names_with_options_and_files() {
        let mut ui = options_fixture();
        ui.load_commands(Ok(json!([{"name":"review","description":"Review changes"},{"name":"review"},{"name":"compact"},{"name":"bad name"}])));
        assert_eq!(ui.wire()["commands"], json!([{"name":"review","description":"Review changes"},{"name":"compact","description":"Compact conversation using the current model"}]));
        let value = ui.models[0].value.clone();
        ui.models[0].images = true;
        ui.select("next-model", &value).unwrap();
        ui.select("agent", "plan").unwrap();
        ui.select("variant", "precise").unwrap();
        let image = "data:image/png;base64,aGVsbG8=".to_owned();
        let (route, body) = ui.dispatch(" /review  src/one.rs --check ", std::slice::from_ref(&image)).unwrap();
        assert_eq!(route, "command");
        assert_eq!(body, json!({"command":"review","arguments":"src/one.rs --check","agent":"plan","model":"provider/one/family/model","variant":"precise","parts":[{"type":"file","mime":"image/png","url":image}]}));
        for text in ["/reviewer x", "/Review x", "/unknown x", "ordinary"] {
            let (route, body) = ui.dispatch(text, &[]).unwrap();
            assert_eq!(route, "prompt_async"); assert_eq!(body["parts"][0]["text"], text);
        }
        assert_eq!(ui.dispatch("/review", &[]).unwrap().1["arguments"], "");
        ui.load_commands(Err(ProviderError::new("provider_error", "missing").with_details(json!({"httpStatus":404}))));
        assert!(ui.error.is_none());
    }
    #[test]
    fn oc2_optional_command_failure_preserves_selected_model_agent_and_variant() {
        for failure in [
            Err(ProviderError::new("provider_error", "missing").with_details(json!({"httpStatus":404}))),
            Err(ProviderError::new("provider_error", "unsupported").with_details(json!({"httpStatus":405}))),
            Err(ProviderError::new("provider_error", "failed").with_details(json!({"httpStatus":500}))),
            Err(ProviderError::new("provider_disconnected", "timed out")),
            Ok(json!({"invalid":"catalogue"})),
        ] {
            let mut ui = options_fixture();
            let model = ui.models[0].value.clone();
            ui.select("next-model", &model).unwrap(); ui.select("agent", "plan").unwrap(); ui.select("variant", "precise").unwrap();
            let options = ui.wire()["options"].clone();
            ui.load_commands(failure);
            assert_eq!(ui.wire()["options"], options, "optional command discovery cannot hide or reset the base controls");
            assert_eq!(ui.wire()["loadState"], "ready", "optional discovery must not trip the service's saved-option restoration error gate");
            assert!(ui.wire().get("error").is_none());
            assert_eq!(ui.wire()["commands"], json!([{"name":"compact","description":"Compact conversation using the current model"}]));
            assert_eq!(ui.dispatch("/review src", &[]).unwrap().0, "prompt_async");
        }
    }
    #[test]
    fn oc2_recovery_endpoint_failures_are_independent_and_do_not_clear_options_or_plans() {
        for failed in ["/session/native-1/children", "/session/native-1/todo", "/permission", "/question", "/session/child-1/message?limit=128"] {
            for failure in 0..5 {
                let (events, mut rx) = crate::provider_events::tap_channel(64);
                let target = event_target(&events, Arc::new(Mutex::new(None)));
                let mut ui = options_fixture();
                let model = ui.models[0].value.clone();
                ui.select("next-model", &model).unwrap(); ui.select("agent", "plan").unwrap(); ui.select("variant", "precise").unwrap();
                let options = ui.wire()["options"].clone(); *target.ui.lock().unwrap() = ui;
                let messages = json!([{"info":{"id":"reply-task","role":"assistant"},"parts":[{"id":"task-part","messageID":"reply-task","sessionID":"native-1","type":"tool","tool":"task","callID":"task-1","state":{"status":"running","input":{"description":"Inspect"},"metadata":{"sessionId":"child-1"}}}]}]);
                let mut paths = Vec::new();
                // Repeat recovery to exercise the same live deduplication even
                // when one independent snapshot is unavailable or malformed.
                for _ in 0..2 {
                    target.hydrate(&messages, |path| {
                        paths.push(path.to_owned());
                        if path == failed {
                            return match failure {
                                0..=2 => Err(ProviderError::new("provider_error", "unavailable").with_details(json!({"httpStatus":([404,405,500][failure])}))),
                                3 => Err(ProviderError::new("provider_disconnected", "timed out")),
                                _ => Ok(json!({"invalid":"list"})),
                            };
                        }
                        Ok(match path {
                            "/permission" => json!([{"id":"per-1","sessionID":"native-1","permission":"read","patterns":["*"]}]),
                            "/question" => json!([{"id":"q-1","sessionID":"native-1","questions":[{"header":"Choice","question":"Pick","options":[{"label":"Yes","description":"Proceed"}]}]}]),
                            "/session/native-1/todo" => json!([{"content":"Inspect","status":"in_progress"}]),
                            _ => json!([]),
                        })
                    });
                }
                for path in ["/session/native-1/children", "/session/native-1/todo", "/permission", "/question", "/session/child-1/message?limit=128"] {
                    assert_eq!(paths.iter().filter(|value| value.as_str() == path).count(), 2, "each recovery feature still gets its own read");
                }
                let emitted = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
                assert_eq!(emitted.iter().filter(|event| event.kind == "chat.approval").count(), if matches!(failed, "/permission" | "/question") { 1 } else { 2 }, "available interactions hydrate once");
                assert_eq!(emitted.iter().filter(|event| event.data["item"]["id"] == "native-1:todos").count(), if failed.ends_with("/todo") { 0 } else { 2 }, "a failed todo read never clears a prior plan");
                assert_eq!(target.ui.lock().unwrap().wire()["options"], options);
                assert!(target.liveness.load(Ordering::SeqCst), "optional recovery never disconnects the event stream");
            }
        }
    }
    #[test]
    fn oc2_image_capability_is_selected_model_only_and_file_parts_are_validated() {
        let mut ui = options_fixture();
        assert!(!ui.accepts_images());
        ui.models[0].images = true;
        let value = ui.models[0].value.clone(); ui.select("next-model", &value).unwrap();
        assert_eq!(ui.wire()["inputCapabilities"]["images"], true);
        let parts = opencode_image_parts(&["data:image/webp;base64,aGVsbG8=".into()]).unwrap();
        assert_eq!(parts[0]["mime"], "image/webp");
        assert!(opencode_image_parts(&["file:///private/image.png".into()]).is_err());
        assert!(opencode_image_parts(&["data:image/svg+xml;base64,aGVsbG8=".into()]).is_err());
        assert!(opencode_image_parts(&["data:image/png;base64,???".into()]).is_err());
        ui.select("next-model", "").unwrap(); assert!(!ui.accepts_images());
        ui.effective_model = Some(ui.models[0].model.clone()); assert!(!ui.accepts_images(), "effective footer is not selection authority");
    }
    #[test]
    fn oc2_compact_uses_current_model_and_rejects_arguments_before_dispatch() {
        let mut ui = options_fixture();
        assert_eq!(ui.dispatch("/compact", &[]).unwrap_err().code, "chat_option_invalid");
        ui.effective_model = Some(json!({"providerID":"native","modelID":"answering"}));
        assert_eq!(ui.dispatch("/compact", &[]).unwrap(), ("summarize", json!({"providerID":"native","modelID":"answering"})));
        let value = ui.models[0].value.clone(); ui.select("next-model", &value).unwrap();
        assert_eq!(ui.dispatch("/summarize", &[]).unwrap(), ("summarize", ui.models[0].model.clone()));
        assert_eq!(ui.dispatch("/compact now", &[]).unwrap_err().code, "command_arguments_invalid");
        assert_eq!(ui.dispatch("/compact", &["data:image/png;base64,aGVsbG8=".into()]).unwrap_err().code, "command_arguments_invalid");
    }
    #[test]
    fn oc2_compact_confirmation_and_idle_in_either_order_emit_one_receipt_and_no_summary() {
        for idle_first in [true, false] {
            let (events, mut rx) = crate::provider_events::tap_channel(16);
            let target = event_target(&events, Arc::new(Mutex::new(Some("compact-1".into()))));
            *target.compact_pending.lock().unwrap() = Some(OpenCodeCompact { turn:"compact-1".into(),confirmed:false,idle_observed:false });
            emit_opencode_event(&target, frame("message.part.updated", json!({"part":{"sessionID":"native-1","messageID":"summary","id":"p","type":"text","text":"Hidden summary"}})));
            if idle_first { emit_opencode_event(&target, frame("session.idle", json!({"sessionID":"native-1"}))); }
            target.finish_compact("compact-1", Ok(())).unwrap();
            if !idle_first {
                assert!(rx.try_recv().is_err(), "confirmation alone retains the slot until native idle");
                emit_opencode_event(&target, frame("session.idle", json!({"sessionID":"native-1"})));
            }
            target.finish_compact("compact-1", Ok(())).unwrap();
            emit_opencode_event(&target, frame("message.part.updated", json!({"part":{"sessionID":"native-1","messageID":"summary","id":"p","type":"text","text":"Late hidden summary"}})));
            emit_opencode_event(&target, frame("session.idle", json!({"sessionID":"native-1"})));
            let emitted = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
            assert_eq!(emitted.len(), 2); assert_eq!(emitted[0].kind, "chat.item");
            assert_eq!(emitted[0].data["parts"][0]["text"], "Conversation compacted by OpenCode.");
            assert_eq!(emitted[1].kind, "chat.turn.completed"); assert!(target.active.lock().unwrap().is_none());
        }
    }
    #[test]
    fn oc2_compact_rejection_unknown_and_stop_never_claim_success() {
        for uncertain in [false, true] {
            let (events, mut rx) = crate::provider_events::tap_channel(16);
            let target = event_target(&events, Arc::new(Mutex::new(Some("compact-1".into()))));
            *target.compact_pending.lock().unwrap() = Some(OpenCodeCompact { turn:"compact-1".into(),confirmed:false,idle_observed:false });
            let error = if uncertain { ProviderError::new("provider_disconnected", "lost reply") } else { ProviderError::new("provider_error", "bad model").with_details(json!({"httpStatus":400})) };
            assert!(target.finish_compact("compact-1", Err(error)).is_err());
            let emitted = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
            assert!(emitted.iter().any(|event| event.kind == "chat.error"));
            assert!(!emitted.iter().any(|event| event.kind == "chat.turn.completed" || event.kind == "chat.item"));
            assert_eq!(target.liveness.load(Ordering::SeqCst), !uncertain);
        }
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("compact-1".into()))));
        *target.compact_pending.lock().unwrap() = Some(OpenCodeCompact { turn:"compact-1".into(),confirmed:false,idle_observed:false });
        *target.abort_pending.lock().unwrap() = Some(OpenCodeAbort { turn:"compact-1".into(),confirmed:false,idle_observed:false });
        emit_opencode_event(&target, frame("session.idle", json!({"sessionID":"native-1"})));
        target.finish_abort("compact-1", Ok(())).unwrap();
        target.finish_compact("compact-1", Ok(())).unwrap();
        let emitted = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(emitted.len(), 1); assert_eq!(emitted[0].data["status"], "interrupted");
        assert!(target.compact_pending.lock().unwrap().is_none(), "Stop retires its compact suppression state");
        *target.active.lock().unwrap() = Some("turn-2".into());
        emit_opencode_event(&target, frame("message.part.updated", json!({"part":{"sessionID":"native-1","messageID":"next-reply","id":"p2","type":"text","text":"Next turn"}})));
        emit_opencode_event(&target, frame("session.idle", json!({"sessionID":"native-1"})));
        let next = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(next.len(), 2); assert_eq!(next[0].data["parts"][0]["text"], "Next turn");
        assert_eq!(next[1].turn_id.as_deref(), Some("turn-2")); assert_eq!(next[1].kind, "chat.turn.completed");
    }
    #[test]
    fn oc2_fork_latest_and_selected_reply_resolve_exclusive_native_boundary() {
        use crate::domain::NativeForkAnchor;
        let messages = json!([{"info":{"id":"user-1"}},{"info":{"id":"reply-1"}},{"info":{"id":"user-2"}},{"info":{"id":"reply-2"}}]);
        let anchor = |id: &str| NativeForkAnchor { native_id:"native-1".into(),message_id:Some(id.into()),turn_id:None,entry_id:None };
        assert_eq!(opencode_fork_body("native-1", None, true, &messages).unwrap(), Some(json!({})));
        assert_eq!(opencode_fork_body("native-1", Some(&anchor("reply-1")), false, &messages).unwrap(), Some(json!({"messageID":"user-2"})));
        assert_eq!(opencode_fork_body("native-1", Some(&anchor("reply-2")), true, &messages).unwrap(), Some(json!({})));
        assert!(opencode_fork_body("native-1", Some(&anchor("missing")), true, &messages).unwrap().is_none());
        assert!(opencode_fork_body("another", Some(&anchor("reply-1")), false, &messages).unwrap().is_none());
        assert!(opencode_fork_body("native-1", None, false, &messages).unwrap().is_none());
    }
    #[test]
    fn oc2_recovery_uses_live_identity_and_deduplicates_pending_cards_and_children() {
        let (events, mut rx) = crate::provider_events::tap_channel(64);
        let target = event_target(&events, Arc::new(Mutex::new(None)));
        let children = json!([{"id":"child-1","parentID":"native-1","title":"Inspect"},{"id":"fork-1","parentID":"native-1"},{"id":"foreign","parentID":"other"}]);
        let messages = json!([{"info":{"id":"reply-task","role":"assistant"},"parts":[{"id":"task-part","messageID":"reply-task","sessionID":"native-1","type":"tool","tool":"task","callID":"task-1","state":{"status":"running","input":{"description":"Inspect"},"metadata":{"sessionId":"child-1"}}}]}]);
        let permissions = json!([{"id":"per-1","sessionID":"native-1","permission":"read","patterns":["*"]},{"id":"per-child","sessionID":"child-1","permission":"read"},{"id":"per-foreign","sessionID":"foreign","permission":"read"},{"id":"per-fork","sessionID":"fork-1","permission":"read"}]);
        let questions = json!([{"id":"q-1","sessionID":"native-1","questions":[{"header":"Choice","question":"Pick","options":[{"label":"Yes","description":"Proceed"}]}]}]);
        let todos = json!([{"content":"Inspect","status":"in_progress"}]);
        for _ in 0..2 { target.hydrate_snapshots(&messages, &children, &todos, &permissions, &questions); }
        let emitted = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(emitted.iter().filter(|event| event.kind == "chat.approval").count(), 3);
        assert_eq!(emitted.iter().filter(|event| event.kind == "chat.subagent").map(|event| event.data["key"].as_str().unwrap()).collect::<HashSet<_>>(), HashSet::from(["task-1"]));
        assert!(!target.permissions.lock().unwrap().contains_key("per-fork"), "a native fork is not a task child");
        assert_eq!(emitted.iter().filter(|event| event.kind == "chat.turn.started").count(), 1);
        assert!(target.permissions.lock().unwrap().get("per-foreign").is_none());
        assert_eq!(target.permission_sessions.lock().unwrap().get("per-child").map(String::as_str), Some("child-1"));
        let plans = emitted.iter().filter(|event| event.data["item"]["id"] == "native-1:todos").collect::<Vec<_>>();
        assert_eq!(plans.len(), 2, "replaces the same plan, never appends a second card");
        emit_opencode_event(&target, frame("question.replied", json!({"sessionID":"native-1","requestID":"q-1"})));
        target.hydrate_snapshots(&json!([]), &children, &todos, &permissions, &questions);
        assert!(!std::iter::from_fn(|| rx.try_recv().ok()).any(|event| event.kind == "chat.approval"), "settled questions never reopen from a late snapshot");
    }
    #[test]
    fn oc2_nested_task_recovery_routes_grandchild_questions_but_not_fork_branches() {
        let (events, mut rx) = crate::provider_events::tap_channel(64);
        let target = event_target(&events, Arc::new(Mutex::new(None)));
        let root_task = json!([{"info":{"role":"assistant"},"parts":[{"id":"p-root","callID":"root-task","messageID":"reply-root","sessionID":"native-1","type":"tool","tool":"task","state":{"status":"running","metadata":{"sessionId":"child-1"}}}]}]);
        target.hydrate_snapshots(&root_task, &json!([]), &Value::Null, &json!([]), &json!([]));
        let nested = json!([{"info":{"id":"child-reply","sessionID":"child-1","role":"assistant"},"parts":[{"id":"p-nested","callID":"nested-task","messageID":"child-reply","sessionID":"child-1","type":"tool","tool":"task","state":{"status":"running","metadata":{"sessionId":"grandchild-1"}}}]}]);
        target.hydrate_child_messages("child-1", &nested).unwrap();
        target.hydrate_child_messages("foreign-fork", &nested).unwrap();
        let questions = json!([{"id":"q-grandchild","sessionID":"grandchild-1","questions":[]},{"id":"q-fork","sessionID":"foreign-fork","questions":[]}]);
        target.hydrate_snapshots(&json!([]), &json!([]), &Value::Null, &json!([]), &questions);
        let emitted = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        let cards = emitted.iter().filter(|event| event.kind == "chat.subagent").collect::<Vec<_>>();
        assert_eq!(cards.len(), 1); assert_eq!(cards[0].data["key"], "root-task");
        let asks = emitted.iter().filter(|event| event.kind == "chat.approval").collect::<Vec<_>>();
        assert_eq!(asks.len(), 1); assert_eq!(asks[0].data["approvalId"], "q-grandchild");
        assert_eq!(asks[0].data["part"]["data"]["subagent"]["key"], "root-task");
    }
    struct Oc2ForkOutcomeFixture { calls: Arc<std::sync::atomic::AtomicUsize>, uncertain: bool }
    impl ProviderAdapter for Oc2ForkOutcomeFixture {
        fn id(&self) -> &str { "opencode" }
        fn capability(&self) -> ProviderCapability {
            ProviderCapability { source:"test",plugin_id:None,icon:None,sign_in:None,homepage:None,id:"opencode".into(),name:"OpenCode fixture".into(),installed:true,version:None,terminal:false,chat:true,history:true,resume:true,terminal_resume_capture:"none",reason:None,auth:"unknown".into() }
        }
        fn terminal_command(&self, _: Option<&str>, _: Option<&str>) -> Result<TerminalCommand, ProviderError> { Err(ProviderError::new("unsupported", "fixture")) }
        fn history_list(&self, _: Option<&str>, _: u32, _: Option<&str>) -> Result<Value, ProviderError> { Ok(json!({"items":[]})) }
        fn history_read(&self, _: &str) -> Result<Value, ProviderError> { Ok(json!([])) }
        fn open_chat(&self, _: &str, _: &str, _: Option<&str>) -> Result<Box<dyn ChatSession>, ProviderError> { Err(ProviderError::new("unsupported", "fixture")) }
        fn fork_session(&self, _: &str, _: &str, _: Option<&crate::domain::NativeForkAnchor>, _: bool) -> Result<Option<String>, ProviderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.uncertain { Err(ProviderError::new("operation_outcome_unknown", "lost native fork reply")) } else { Ok(None) }
        }
    }
    fn oc2_fork_fixture(uncertain: bool) -> (tempfile::TempDir, Database, crate::domain::Session, Arc<std::sync::atomic::AtomicUsize>, crate::providers::Providers) {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("fork.sqlite")).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        let source = db.create_session(crate::db::CreateSession { project_id:None,title:Some("Source"),provider:"opencode",mode:"chat",native_id:Some("source-native"),operation_id:"source" }).unwrap();
        let cwd = root.path().display().to_string();
        crate::session_configs::save_new(&db, &source.id, &crate::session_configs::LaunchSpec { provider:"opencode".into(),mode:"chat".into(),cwd:cwd.clone(),project_id:None,title:Some("Source".into()),executable:None,args:vec![] }, None).unwrap();
        db.bind_session(&source.id, Some(&cwd), Some("source-native")).unwrap();
        db.set_session_status(&source.id, "idle", None).unwrap();
        let source = db.session_by_id(&source.id).unwrap().unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let providers = crate::providers::Providers::for_test(vec![Arc::new(Oc2ForkOutcomeFixture { calls:Arc::clone(&calls),uncertain })]);
        (root, db, source, calls, providers)
    }
    #[test]
    fn oc2_unavailable_native_fork_falls_back_once_and_preserves_source() {
        let (_root, db, source, calls, providers) = oc2_fork_fixture(false);
        let request = || crate::chat_fork::ForkRequest { session_id:&source.id,item_id:None,operation_id:"fork-once" };
        let first = crate::chat_fork::fork(&db, &providers, request()).unwrap();
        let second = crate::chat_fork::fork(&db, &providers, request()).unwrap();
        assert_eq!(first, second); assert_eq!(first["mode"], "copy");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(db.session_by_id(&source.id).unwrap().unwrap(), source);
    }
    #[test]
    fn oc2_uncertain_native_fork_stops_without_copy_and_never_reposts() {
        let (_root, db, source, calls, providers) = oc2_fork_fixture(true);
        let request = || crate::chat_fork::ForkRequest { session_id:&source.id,item_id:None,operation_id:"fork-once" };
        let error = crate::chat_fork::fork(&db, &providers, request()).unwrap_err();
        assert!(error.to_string().contains("operation_outcome_unknown"));
        assert!(crate::chat_fork::fork(&db, &providers, request()).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(db.snapshot().unwrap().sessions.len(), 1, "an uncertain native fork never creates a copy child");
        assert_eq!(db.session_by_id(&source.id).unwrap().unwrap(), source);
    }
    #[test]
    fn oc2_history_reuses_live_normalizer_and_keeps_native_time_and_anchor() {
        let parts = json!([{"type":"reasoning","text":"Think"},{"type":"tool","id":"tool-1","tool":"read","state":{"status":"completed","input":{"filePath":"notes.txt"}}},{"type":"text","text":"Reply"},{"type":"step-finish"}]);
        let raw = json!({"info":{"id":"native-1"},"messages":[{"info":{"id":"reply-1","role":"assistant","sessionID":"native-1","time":{"created":1000,"completed":2000}},"parts":parts}]});
        let history = opencode_transcript(&raw);
        assert_eq!(history[0]["parts"][0], opencode_chat_part(&parts[0]));
        assert_eq!(history[0]["parts"][1]["toolName"], "read");
        assert_eq!(history[0]["parts"].as_array().unwrap().len(), 3);
        assert_eq!(history[0]["createdAt"], "1970-01-01T00:00:01+00:00");
        assert_eq!(history[0]["forkAnchor"], json!({"nativeId":"native-1","messageId":"reply-1"}));
        assert_eq!(history[0]["turnOrigin"], "history"); assert_eq!(history[0]["turnStatus"], "completed");
        let hidden = json!({"messages":[{"info":{"id":"hidden","role":"assistant","summary":true},"parts":[{"type":"text","text":"Hidden native summary"}]}]});
        assert!(opencode_transcript(&hidden).is_empty());
        let image = "data:image/png;base64,AA==";
        let user = opencode_transcript(&json!({"messages":[{"info":{"id":"user","role":"user"},"parts":[{"type":"text","text":"Inspect"},{"type":"file","mime":"image/png","url":image}]}]}));
        assert_eq!(user[0]["parts"], json!([{"type":"text","text":"Inspect","data":{"images":[image]}}]), "imported user images use the same shared message shape as live sends");
    }
    fn options_fixture() -> OpenCodeOptions {
        OpenCodeOptions::from_catalogues(Ok(json!({"all":[
            {"id":"provider/one","name":"First","models":{
                "family/model":{"id":"family/model","name":"Slash model","variants":{"quick":{},"precise":{},"hidden":{"disabled":true}}},
                "plain":{"id":"plain","name":"Plain"},"unavailable":{"id":"unavailable","status":"unavailable"}}},
            {"id":"second","name":"Second","models":{"two":{"id":"two","name":"Two"}}},
            {"id":"offline","models":{"not-offered":{"id":"not-offered"}}}],"connected":["provider/one","second"]})),
            Ok(json!([{"name":"build","mode":"primary"},{"name":"plan","mode":"primary"},
                {"name":"custom","mode":"all"},{"name":"hidden","mode":"primary","hidden":true},
                {"name":"explore","mode":"subagent"},{"name":"missing-mode"}])) )
    }
    #[test]
    fn catalogue_options_preserve_structured_ids_and_filter_unavailable_choices() {
        let ui = options_fixture();
        assert_eq!(ui.models.len(), 3);
        assert_eq!(ui.agents.iter().map(|agent| agent["value"].as_str().unwrap()).collect::<Vec<_>>(), vec!["build","plan","custom"]);
        let wire = ui.wire();
        assert_eq!(wire["options"][0]["category"], "model");
        assert_eq!(wire["options"][1]["name"], "Agent");
        assert_eq!(wire["options"].as_array().unwrap().len(), 2);
        let slash = ui.models.iter().find(|model| model.model["modelID"] == "family/model").unwrap();
        assert_eq!(slash.name, "First · Slash model");
        assert_eq!(serde_json::from_str::<Value>(&slash.value).unwrap(), json!({"providerID":"provider/one","modelID":"family/model"}));
        assert_eq!(slash.variants, vec!["precise","quick"]);
        assert_eq!(ui.prompt("hello"), json!({"parts":[{"type":"text","text":"hello"}]}), "no invented default override");
    }
    #[test]
    fn options_validate_locally_and_change_only_subsequent_prompt_overrides() {
        let mut ui = options_fixture();
        let before = ui.prompt("first");
        assert!(ui.select("next-model", "provider/one/family/model").is_err());
        assert_eq!(ui.wire()["error"]["code"], "chat_option_invalid");
        assert!(ui.wire()["error"]["message"].as_str().unwrap().contains("not applied"));
        assert!(ui.select("agent", "explore").is_err());
        assert!(ui.select("variant", "precise").is_err());
        assert!(ui.select("unknown", "x").is_err());
        let value = ui.models.iter().find(|model| model.model["modelID"] == "family/model").unwrap().value.clone();
        ui.select("next-model", &value).unwrap();
        assert!(ui.wire().get("error").is_none(), "a valid user choice clears the stale selection notice");
        ui.select("agent", "plan").unwrap();
        ui.select("variant", "precise").unwrap();
        assert_eq!(before, json!({"parts":[{"type":"text","text":"first"}]}));
        assert_eq!(ui.prompt("next"), json!({"parts":[{"type":"text","text":"next"}],"model":{"providerID":"provider/one","modelID":"family/model"},"agent":"plan","variant":"precise"}));
        assert_eq!(ui.wire()["options"][2]["name"], "Variant");
        let plain = ui.models.iter().find(|model| model.model["modelID"] == "plain").unwrap().value.clone();
        ui.select("next-model", &plain).unwrap();
        assert!(ui.prompt("plain").get("variant").is_none());
        assert_eq!(ui.wire()["options"].as_array().unwrap().len(), 2);
        assert!(ui.select("variant", "precise").is_err());
        ui.select("next-model", "").unwrap(); ui.select("agent", "").unwrap();
        assert_eq!(ui.prompt("default"), json!({"parts":[{"type":"text","text":"default"}]}));
    }
    #[test]
    fn catalogue_failure_is_visible_without_breaking_the_other_controls() {
        let ui = OpenCodeOptions::from_catalogues(Err(ProviderError::new("provider_error", "catalogue unavailable")), Ok(json!([{"name":"build","mode":"primary"}])));
        assert_eq!(ui.wire()["loadState"], "error");
        assert_eq!(ui.wire()["error"]["message"], "catalogue unavailable");
        assert_eq!(ui.wire()["options"][0]["id"], "agent");
    }
    #[test]
    fn typed_errors_are_readable_and_categorized_without_raw_response_bodies() {
        for (name, category) in [("ProviderAuthError","authentication"),("ContextOverflowError","context_overflow"),
            ("APIError","api"),("MessageAbortedError","interrupted"),("MessageOutputLengthError","output_limit"),
            ("StructuredOutputError","structured_output"),("ContentFilterError","content_filter"),("UnknownError","provider")] {
            let data = opencode_error(&json!({"name":name,"data":{"message":"Native explanation","responseBody":"secret body","statusCode":429,"isRetryable":true}}));
            assert_eq!(data["category"], category);
            assert!(data["message"].as_str().unwrap().contains("Native explanation"));
            assert!(!data.to_string().contains("secret body"));
            assert_eq!(data["httpStatus"], 429); assert_eq!(data["retryable"], true);
        }
        assert!(opencode_error(&json!({"name":"MessageOutputLengthError","data":{}}))["message"].as_str().unwrap().contains("length limit"));
    }
    #[test]
    fn native_retry_updates_in_place_and_clears_without_replaying() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let active = Arc::new(Mutex::new(Some("turn-1".into())));
        let target = event_target(&events, Arc::clone(&active));
        for attempt in [1, 2] {
            emit_opencode_event(&target, frame("session.status", json!({"sessionID":"native-1","status":{"type":"retry","attempt":attempt,"message":"Rate limited","next":12345}})));
        }
        emit_opencode_event(&target, frame("session.status", json!({"sessionID":"native-1","status":{"type":"busy"}})));
        let emitted = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(emitted.len(), 3);
        assert!(emitted.iter().all(|event| event.kind == "chat.item" && event.data["item"]["id"] == "native-1:retry"));
        assert_eq!(emitted[1].data["parts"][0]["data"]["attempt"], 2);
        assert_eq!(emitted[1].data["parts"][0]["type"], "status");
        assert_eq!(emitted[1].data["parts"][0]["data"]["message"], "Rate limited");
        assert_eq!(emitted[1].data["parts"][0]["data"]["next"], 12345);
        assert_eq!(emitted[2].data["parts"], json!([]));
        assert_eq!(active.lock().unwrap().as_deref(), Some("turn-1"));
    }
    #[test]
    fn confirmed_abort_classifies_early_idle_as_interrupted_once() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        *target.abort_pending.lock().unwrap() = Some(OpenCodeAbort { turn: "turn-1".into(), confirmed: false, idle_observed: false });
        emit_opencode_event(&target, frame("session.idle", json!({"sessionID":"native-1"})));
        assert!(rx.try_recv().is_err());
        target.finish_abort("turn-1", Ok(())).unwrap();
        emit_opencode_event(&target, frame("session.idle", json!({"sessionID":"native-1"})));
        let emitted = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(emitted.len(), 1); assert_eq!(emitted[0].kind, "chat.turn.completed");
        assert_eq!(emitted[0].data["status"], "interrupted");
        assert!(target.active.lock().unwrap().is_none());
    }
    #[test]
    fn uncertain_abort_keeps_unknown_outcome_and_never_claims_completion() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        *target.abort_pending.lock().unwrap() = Some(OpenCodeAbort { turn: "turn-1".into(), confirmed: false, idle_observed: false });
        emit_opencode_event(&target, frame("session.status", json!({"sessionID":"native-1","status":{"type":"idle"}})));
        assert!(target.finish_abort("turn-1", Err(ProviderError::new("provider_disconnected", "lost abort response"))).is_err());
        let emitted = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        assert!(!emitted.iter().any(|event| event.kind == "chat.turn.completed"));
        assert!(emitted.iter().any(|event| event.kind == "chat.error" && event.data["reason"] == "abort_result_unknown"));
        assert!(!target.liveness.load(Ordering::SeqCst));
    }
    #[test]
    fn confirmed_abort_reserves_the_slot_until_native_idle() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        *target.abort_pending.lock().unwrap() = Some(OpenCodeAbort { turn: "turn-1".into(), confirmed: false, idle_observed: false });
        target.finish_abort("turn-1", Ok(())).unwrap();
        assert_eq!(target.active.lock().unwrap().as_deref(), Some("turn-1"));
        assert!(rx.try_recv().is_err(), "HTTP abort alone cannot reopen the send slot");
        emit_opencode_event(&target, frame("session.idle", json!({"sessionID":"native-1"})));
        assert_eq!(rx.try_recv().unwrap().data["status"], "interrupted");
        assert!(target.active.lock().unwrap().is_none());
    }
    #[test]
    fn status_idle_clears_retry_but_does_not_duplicate_the_native_idle_boundary() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        emit_opencode_event(&target, frame("session.status", json!({"sessionID":"native-1","status":{"type":"idle"}})));
        assert_eq!(target.active.lock().unwrap().as_deref(), Some("turn-1"));
        assert!(rx.try_recv().is_err());
        emit_opencode_event(&target, frame("session.idle", json!({"sessionID":"native-1"})));
        assert_eq!(rx.try_recv().unwrap().data["status"], "completed");
        assert!(rx.try_recv().is_err());
    }
    #[test]
    fn next_turn_selection_never_invents_the_effective_footer_model() {
        let db = projection_db();
        let mut ui = options_fixture();
        let selected = ui.models[0].value.clone();
        ui.select("next-model", &selected).unwrap();
        db.record_provider_event("chat-s", None, "chat.ui", &ui.wire()).unwrap();
        db.record_provider_event("chat-s", Some("turn-1"), "chat.turn.started", &json!({})).unwrap();
        assert!(db.chat_items("chat-s").unwrap().iter().all(|item| item.turn_model.is_none()));
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        emit_opencode_event(&target, frame("message.updated", json!({"info":{"sessionID":"native-1","id":"assistant-1","role":"assistant",
            "providerID":"actual","modelID":"reported/model","tokens":{"input":1,"output":2}}})));
        drain(&db, &mut rx, "chat-s");
        assert!(db.chat_items("chat-s").unwrap().iter().any(|item| item.turn_model.as_deref() == Some("actual/reported/model")));
    }
    #[test]
    fn error_projection_and_authoritative_aborted_outcome_are_distinct() {
        let db = projection_db();
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        emit_opencode_event(&target, frame("session.error", json!({"sessionID":"native-1","error":{"name":"ContextOverflowError","data":{"message":"Too many tokens"}}})));
        drain(&db, &mut rx, "chat-s");
        let items = db.chat_items("chat-s").unwrap();
        let part = items.iter().flat_map(|item| &item.parts).find(|part| part["type"] == "error").unwrap();
        assert!(part["text"].as_str().unwrap().contains("Too many tokens"));
        assert_eq!(part["data"]["category"], "context_overflow");
        *target.active.lock().unwrap() = Some("turn-2".into());
        emit_opencode_event(&target, frame("session.error", json!({"sessionID":"native-1","error":{"name":"MessageAbortedError","data":{"message":"Cancelled"}}})));
        let event = rx.try_recv().unwrap();
        assert_eq!(event.kind, "chat.turn.completed"); assert_eq!(event.data["status"], "interrupted");
    }
    use super::*;
    use crate::db::Database;
    use std::io::{Read, Write};

    #[test]
    fn sse_header_timeout_settles_failed_without_runtime_retry() {
        use super::super::ProviderRuntime;
        // Exercise the registry handoff with the adapter's timeout outcome.
        // No provider adapter/process is registered or launched by this test.
        for resumed in [false, true] {
            let providers = super::super::Providers::for_test(vec![]);
            let mut events = providers.take_projection_events().unwrap();
            let mut slot = super::super::ChatSlot::new();
            slot.generation = 1;
            slot.phase = "connecting";
            slot.connecting = true;
            slot.native_id = Some("native-1".into());
            slot.worker_token = Some("attempt-1".into());
            providers.chats.lock().unwrap().insert("chat-s".into(), slot);
            let failed = providers.finish_chat_open_attempt("chat-s", super::super::ChatOpenAttempt {
                generation: 1, worker_token: "attempt-1".into(), resumed,
                opened: Err(ProviderError::new("provider_disconnected", "OpenCode event stream headers were not received: timed out waiting on channel")),
            }, |_| panic!("failed handshake must never be accepted")).unwrap_err();
            assert_eq!(failed.code, if resumed { "native_resume_failed" } else { "provider_disconnected" });
            let state = providers.chat_connection("chat-s");
            assert_eq!(state["phase"], "failed");
            assert_eq!(state["nativeId"], "native-1");
            assert_eq!(state["error"]["retryable"], true);
            assert!(state["error"]["message"].as_str().unwrap().contains("headers were not received"));
            let slot = providers.chats.lock().unwrap();
            assert!(!slot["chat-s"].connecting);
            assert!(slot["chat-s"].worker.is_none());
            assert!(slot["chat-s"].worker_token.is_none());
            drop(slot);
            let event = events.try_recv().unwrap();
            assert_eq!(event.kind, "chat.connection");
            assert_eq!(event.data["phase"], "failed");
            // Repeated observations do not re-arm startup or change generation.
            assert_eq!(providers.chat_connection("chat-s"), state);
            assert_eq!(providers.chat_connection("chat-s"), state);
            assert!(events.try_recv().is_err());
        }
    }

    struct TestChildCleanup(Arc<Mutex<Child>>);

    impl Drop for TestChildCleanup {
        fn drop(&mut self) {
            if let Ok(mut child) = self.0.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    #[test]
    fn terminal_identity_is_prepared_through_native_session_api() {
        let adapter = OpenCodeAdapter::new(crate::provider_events::tap_channel(1).0);
        assert_eq!(
            adapter.terminal_capture(),
            super::super::TerminalCapture::PreAssigned
        );
    }
    #[test]
    fn filters_history_by_cwd() {
        assert!(opencode_history_item(&json!({"id":"s","directory":"/a"}), Some("/b")).is_none());
    }
    #[test]
    fn reads_export_messages() {
        assert_eq!(
            opencode_transcript(
                &json!({"messages":[{"info":{"id":"m","role":"assistant"},"parts":[{"type":"text","text":"ok"}]}]})
            )[0]["parts"][0]["text"],
            "ok"
        );
    }

    #[test]
    fn repair_fixture_normalizes_opencode_export() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/repair-native-history.json"
        ))
        .unwrap();
        let items = opencode_transcript(&fixture["opencode"]);
        assert_eq!(
            items
                .iter()
                .map(|item| item["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["repair-opencode-user", "repair-opencode-assistant"]
        );
    }
    #[test]
    fn normalizes_live_parts_to_the_public_chat_contract() {
        let text = opencode_chat_part(&json!({
            "id":"part-1","sessionID":"session-1","type":"text","text":"OK"
        }));
        assert_eq!(text, json!({"type":"text","text":"OK"}));
        let tool = opencode_chat_part(&json!({
            "id":"part-2","sessionID":"session-1","type":"tool","tool":"bash",
            "state":{"status":"completed"}
        }));
        assert_eq!(tool["type"], "tool");
        assert_eq!(tool["toolName"], "bash");
        assert_eq!(tool["toolId"], "part-2");
        assert_eq!(tool["status"], "completed");
        assert!(tool.get("sessionID").is_none());
        let history = opencode_transcript(
            &json!({"messages":[{"info":{"id":"msg-1","role":"assistant"},"parts":[
                {"id":"part-3","type":"tool","tool":"read","state":{"status":"error","input":{"filePath":"src/old.rs"}}}
            ]}]}),
        );
        assert_eq!(
            history[0]["parts"][0]["fileReferences"][0]["path"],
            "src/old.rs"
        );
    }

    #[test]
    fn the_session_todo_list_becomes_the_turn_plan() {
        let (events, mut rx) = crate::provider_events::tap_channel(8);
        let active = Arc::new(Mutex::new(None));
        let target = event_target(&events, Arc::clone(&active));
        // Live OpenCode 1.18 todo.updated (from todowrite).
        let todos = frame("todo.updated", json!({"sessionID":"native-1","todos":[
            {"content":"Read README","status":"completed","priority":"high"},
            {"content":"Write notes.txt","status":"in_progress","priority":"medium"}]}));
        emit_opencode_event(&target, todos.clone());
        let recovered = rx.try_recv().unwrap();
        assert_eq!(recovered.data["item"]["id"], "native-1:todos", "idle recovery keeps a stable session plan");
        assert!(recovered.turn_id.is_none());
        *active.lock().unwrap() = Some("turn-1".into());
        emit_opencode_event(&target, todos);
        let event = std::iter::from_fn(|| rx.try_recv().ok()).find(|event| event.kind == "chat.item").unwrap();
        assert_eq!(event.turn_id.as_deref(), Some("turn-1"));
        let part = &event.data["part"];
        assert_eq!((part["type"].as_str(), part["toolId"].as_str()), (Some("plan"), Some("plan:turn-1")));
        assert_eq!(part["data"]["entries"][1], json!({"content":"Write notes.txt","status":"in_progress","priority":"medium"}));
    }

    #[test]
    fn established_message_updated_event_emits_context_usage() {
        let fixture: Value = serde_json::from_str(include_str!("../../tests/fixtures/opencode-context-event.json")).unwrap();
        let (events, mut rx) = crate::provider_events::tap_channel(8);
        let providers: Value = serde_json::from_str(include_str!("../../tests/fixtures/opencode-provider-model-limits.json")).unwrap();
        let limits = opencode_provider_context_limits(&providers);
        assert_eq!(limits["openai/gpt-test"], 200000);
        let mut target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        target.model_limits = limits;
        emit_opencode_event(&target, fixture);
        let event = std::iter::from_fn(|| rx.try_recv().ok()).find(|event| event.kind == "chat.context").unwrap();
        assert_eq!(event.data["usage"]["inputTokens"], 120);
        assert_eq!(event.data["usage"]["outputTokens"], 30);
        assert_eq!(event.data["usage"]["cacheReadTokens"], 80);
        assert_eq!(event.data["usage"]["cacheWriteTokens"], 5);
        assert_eq!(event.data["usage"]["totalTokens"], 235, "native output already includes reasoning tokens");
        assert_eq!(event.data["usage"]["windowTokens"], 200000);
        // The same step fills the turn footer: its usage and the answering model.
        assert_eq!(event.data["turnUsage"]["inputTokens"], 120);
        assert_eq!(event.data["model"], "openai/gpt-test");
    }

    /// Event frames below mirror the real OpenCode 1.18.31 `/global/event`
    /// shapes verified against the installed server's OpenAPI document.
    fn frame(kind: &str, properties: Value) -> Value {
        json!({"payload":{"id":"evt_1","type":kind,"properties":properties}})
    }

    fn projection_db() -> Database {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("runtime.sqlite")).unwrap();
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO sessions(id,title,provider,mode,status,created_at,updated_at) VALUES ('chat-s','test','opencode','chat','running','now','now')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        db
    }
    #[test]
    fn native_session_title_is_projected_for_untitled_chats_only() {
        let db = projection_db();
        db.transaction(|tx| { tx.execute("UPDATE sessions SET title='opencode' WHERE id='chat-s'", [])?; Ok(()) }).unwrap();
        let (events, mut rx) = crate::provider_events::tap_channel(8);
        let target = event_target(&events, Arc::new(Mutex::new(None)));
        emit_opencode_event(&target, frame("session.updated", json!({"info":{"id":"native-1","title":"Native title"}})));
        drain(&db, &mut rx, "chat-s");
        assert_eq!(db.session_by_id("chat-s").unwrap().unwrap().title, "Native title");
        emit_opencode_event(&target, frame("session.updated", json!({"info":{"id":"native-1","title":"Later native title"}})));
        drain(&db, &mut rx, "chat-s");
        assert_eq!(db.session_by_id("chat-s").unwrap().unwrap().title, "Native title");
        db.transaction(|tx| { tx.execute("UPDATE sessions SET title='opencode' WHERE id='chat-s'", [])?; Ok(()) }).unwrap();
        db.bind_operation("rename-default", "session.update", &json!({"sessionId":"chat-s","title":"opencode","operationId":"rename-default"})).unwrap();
        emit_opencode_event(&target, frame("session.updated", json!({"info":{"id":"native-1","title":"Ignored native title"}})));
        drain(&db, &mut rx, "chat-s");
        assert_eq!(db.session_by_id("chat-s").unwrap().unwrap().title, "opencode");
    }
    #[test]
    fn live_message_native_timestamp_reaches_chat_projection() {
        let db = projection_db();
        let (events, mut rx) = crate::provider_events::tap_channel(8);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        emit_opencode_event(&target, frame("message.updated", json!({"info":{"id":"reply-1","sessionID":"native-1","role":"assistant","time":{"created":1000}}})));
        emit_opencode_event(&target, frame("message.part.updated", json!({"part":{"id":"part-1","messageID":"reply-1","sessionID":"native-1","type":"text","text":"Answer"}})));
        drain(&db, &mut rx, "chat-s");
        let item = db.chat_items("chat-s").unwrap().into_iter().find(|item| item.id == "chat-s:assistant:reply-1").unwrap();
        assert_eq!(item.created_at, "1970-01-01T00:00:01+00:00");
    }
    #[test]
    fn native_timestamp_cache_switches_to_authoritative_snapshots_at_the_message_bound() {
        let mut assembly = OpenCodeAssembly::default();
        for index in 0..=MAX_ASSEMBLED_MESSAGES {
            assembly.remember_created_at(&format!("message-{index}"), "1970-01-01T00:00:01+00:00".into());
        }
        assert!(assembly.authoritative_only);
        assert!(assembly.created_at.is_empty());
    }

    fn drain(db: &Database, rx: &mut broadcast::Receiver<ProviderEvent>, session: &str) {
        while let Ok(event) = rx.try_recv() {
            db.record_provider_event(session, event.turn_id.as_deref(), &event.kind, &event.data)
                .unwrap();
        }
    }

    fn projected_texts(db: &Database, session: &str) -> Vec<String> {
        db.chat_items(session)
            .unwrap()
            .iter()
            .flat_map(|item| {
                item.parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(Value::as_str).map(str::to_owned))
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    fn event_target(
        events: &crate::provider_events::Sender,
        active: Arc<Mutex<Option<String>>>,
    ) -> EventTarget {
        EventTarget {
            threadterm_session: "chat-s".into(),
            native_id: "native-1".into(),
            worker_token: "test-worker".into(),
            events: events.clone(),
            active,
            assembly: Default::default(),
            permissions: Default::default(),
            settled_permissions: Default::default(),
            subagents: Default::default(),
            permission_sessions: Default::default(),
            native_turn_observed: AtomicBool::new(false),
            stopped: Arc::new(AtomicBool::new(false)),
            event_gate: Arc::new(Mutex::new(())),
            liveness: Arc::new(AtomicBool::new(true)),
            snapshot_client: Client::new(),
            base_url: "http://127.0.0.1:0".into(),
            directory: String::new(),
            username: String::new(),
            password: String::new(),
            model_limits: HashMap::new(),
            ui: Mutex::new(OpenCodeOptions::default()),
            abort_pending: Mutex::new(None),
            retry_visible: AtomicBool::new(false),
            compact_pending: Mutex::new(None),
        }
    }

    #[test]
    fn prompt_http_acceptance_keeps_active_and_never_reopens_an_early_idle() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        target.finish_prompt("turn-1", Ok(())).unwrap();
        assert_eq!(target.active.lock().unwrap().as_deref(), Some("turn-1"));
        assert!(rx.try_recv().is_err(), "HTTP acceptance is not another turn-start");
        emit_opencode_event(&target, frame("session.idle", json!({"sessionID":"native-1"})));
        let emitted = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(emitted.iter().filter(|event| event.kind == "chat.turn.completed").count(), 1);
        assert!(target.active.lock().unwrap().is_none());
        target.finish_prompt("turn-1", Ok(())).unwrap();
        assert!(target.active.lock().unwrap().is_none());
        assert!(target.liveness.load(Ordering::SeqCst));
        assert!(rx.try_recv().is_err(), "a late success cannot restart or complete the turn again");
    }

    #[test]
    fn prompt_http_rejection_clears_only_its_turn_and_retains_the_stream() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        let rejection = || ProviderError::new("provider_error", "rejected").with_details(json!({"httpStatus":422}));
        assert_eq!(target.finish_prompt("turn-1", Err(rejection())).unwrap_err().code, "provider_error");
        assert!(target.active.lock().unwrap().is_none());
        assert!(target.liveness.load(Ordering::SeqCst));
        let rejected = rx.try_recv().unwrap();
        assert_eq!(rejected.kind, "chat.error");
        assert_eq!(rejected.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(rejected.data["reason"], "prompt_rejected");
        assert_eq!(rejected.worker_token.as_deref(), Some("test-worker"));
        assert!(rx.try_recv().is_err());
        *target.active.lock().unwrap() = Some("turn-2".into());
        target.finish_prompt("turn-1", Err(rejection())).unwrap_err();
        assert_eq!(target.active.lock().unwrap().as_deref(), Some("turn-2"));
        assert!(rx.try_recv().is_err(), "a rejection cannot settle another operation");
    }

    #[test]
    fn prompt_http_uncertain_results_expire_permissions_and_stream_exactly_once() {
        for (status, native_activity) in [(Some(503), false), (None, false), (Some(422), true)] {
            let (events, mut rx) = crate::provider_events::tap_channel(32);
            let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
            if native_activity {
                emit_opencode_event(&target, frame("permission.asked", json!({
                    "id":"permission-1","sessionID":"native-1","permission":"bash","patterns":["*"],"metadata":{},"always":[]
                })));
                assert_eq!(rx.try_recv().unwrap().kind, "chat.approval");
            }
            let error = || match status {
                Some(status) => ProviderError::new("provider_error", "HTTP failed").with_details(json!({"httpStatus":status})),
                None => ProviderError::new("provider_disconnected", "reply lost"),
            };
            target.finish_prompt("turn-1", Err(error())).unwrap_err();
            assert!(!target.liveness.load(Ordering::SeqCst));
            assert!(target.active.lock().unwrap().is_none());
            assert!(target.permissions.lock().unwrap().is_empty());
            let emitted = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
            assert_eq!(emitted.iter().filter(|event| event.kind == "chat.error" && event.data["reason"] == "send_result_unknown").count(), 1);
            assert_eq!(emitted.iter().filter(|event| event.kind == "session.closed").count(), 1);
            assert_eq!(emitted.iter().filter(|event| event.kind == "chat.approval.resolved" && event.data["status"] == "expired").count(), usize::from(native_activity));
            assert!(emitted.iter().all(|event| event.worker_token.as_deref() == Some("test-worker")));
            target.finish_prompt("turn-1", Err(error())).unwrap_err();
            emit_opencode_event(&target, frame("session.idle", json!({"sessionID":"native-1"})));
            assert!(rx.try_recv().is_err(), "late replies/events cannot duplicate terminal projection");
        }
    }

    #[test]
    fn prompt_http_success_after_stream_loss_stays_disconnected() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        expire_stream(&target, "event_stream_disconnected", "closed");
        while rx.try_recv().is_ok() {}
        assert_eq!(target.finish_prompt("turn-1", Ok(())).unwrap_err().code, "provider_disconnected");
        assert!(!target.liveness.load(Ordering::SeqCst));
        assert!(target.active.lock().unwrap().is_none());
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn assistant_message_usage_emits_distinct_exact_speed_calls_before_context() {
        let (events, mut receiver) = crate::provider_events::tap_channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        emit_opencode_event(&target, frame("message.part.updated", json!({"part":{
            "id":"reasoning-a","messageID":"assistant-a","sessionID":"native-1","type":"reasoning","text":"plan"
        }})));
        for (id, output) in [("assistant-a", 12), ("assistant-b", 7)] {
            emit_opencode_event(
                &target,
                frame("message.updated", json!({"info":{
                    "id":id,"sessionID":"native-1","role":"assistant",
                    "tokens":{"input":1,"output":output,"total":output + 1}
                }})),
            );
        }
        let emitted: Vec<_> = std::iter::from_fn(|| receiver.try_recv().ok()).collect();
        let speed = emitted.iter().filter(|event| event.kind == "chat.speed.usage").collect::<Vec<_>>();
        assert!(emitted.iter().any(|event| event.kind == "chat.item"
            && event.data["speedCallId"] == "assistant-a"
            && event.data["parts"][0]["type"] == "thinking"));
        assert_eq!(speed.iter().map(|event| event.data["callId"].as_str()).collect::<Vec<_>>(), vec![Some("assistant-a"), Some("assistant-b")]);
        assert_eq!(speed.iter().map(|event| event.data["outputTokens"].as_u64()).collect::<Vec<_>>(), vec![Some(12), Some(7)]);
        assert!(emitted.windows(2).all(|pair| pair[0].kind != "chat.context" || pair[1].kind != "chat.speed.usage"));
    }

    fn task_frame(call: &str, status: &str, child: Option<&str>) -> Value {
        let mut state = json!({"status":status,"title":"Inspect files","input":{
            "description":"Inspect files","subagent_type":"explore","prompt":"Find the entry point"},
            "output":"Found main.rs","error":"Task failed"});
        if let Some(child) = child {
            state["metadata"] = json!({"sessionId":child});
        }
        frame(
            "message.part.updated",
            json!({"part":{"sessionID":"native-1","messageID":"parent-msg",
            "id":format!("part-{call}"),"type":"tool","tool":"task","callID":call,"state":state}}),
        )
    }

    fn child_part(child: &str, id: &str, kind: &str, text: &str) -> Value {
        frame(
            "message.part.updated",
            json!({"part":{"sessionID":child,"messageID":"child-msg",
            "id":id,"type":kind,"text":text}}),
        )
    }

    #[test]
    fn task_lifecycle_projects_cards_with_summary_and_error_without_parent_tools() {
        let db = projection_db();
        let (events, mut rx) = crate::provider_events::tap_channel(32);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        for status in ["pending", "running", "completed"] {
            emit_opencode_event(
                &target,
                task_frame("call-1", status, (status != "pending").then_some("child-1")),
            );
            let event = rx.try_recv().unwrap();
            assert_eq!(event.kind, "chat.subagent");
            assert_eq!(event.data["key"], "call-1");
            assert_eq!(
                event.data["info"]["status"],
                if status == "completed" {
                    "completed"
                } else {
                    "running"
                }
            );
            db.record_provider_event("chat-s", event.turn_id.as_deref(), &event.kind, &event.data)
                .unwrap();
        }
        emit_opencode_event(&target, task_frame("call-2", "error", None));
        drain(&db, &mut rx, "chat-s");
        let cards = db.chat_items("chat-s").unwrap();
        assert_eq!(cards.len(), 2);
        let first = cards
            .iter()
            .find(|item| item.parts[0]["data"]["key"] == "call-1")
            .unwrap();
        assert_eq!(first.parts[0]["type"], "subagent");
        assert_eq!(first.parts[0]["data"]["summary"], "Found main.rs");
        assert_eq!(first.parts[0]["data"]["native"]["id"], "child-1");
        assert_eq!(first.parts[0]["data"]["agentType"], "explore");
        assert_eq!(first.parts[0]["data"]["prompt"], "Find the entry point");
        let failed = cards
            .iter()
            .find(|item| item.parts[0]["data"]["key"] == "call-2")
            .unwrap();
        assert_eq!(failed.parts[0]["data"]["status"], "failed");
        assert_eq!(failed.parts[0]["data"]["summary"], "Task failed");
        assert_eq!(target.active.lock().unwrap().as_deref(), Some("turn-1"));
        assert_eq!(
            target.subagents.lock().unwrap().task_calls["call-1"].as_deref(),
            Some("child-1")
        );
    }

    #[test]
    fn child_snapshots_before_and_after_binding_replace_text_and_merge_tools() {
        let db = projection_db();
        let (events, mut rx) = crate::provider_events::tap_channel(32);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        emit_opencode_event(
            &target,
            frame(
                "session.created",
                json!({"info":{"id":"child-1","parentID":"native-1"}}),
            ),
        );
        emit_opencode_event(
            &target,
            frame(
                "message.updated",
                json!({"info":{"id":"child-msg","sessionID":"child-1","role":"user"}}),
            ),
        );
        emit_opencode_event(&target, child_part("child-1", "text", "text", "before"));
        emit_opencode_event(
            &target,
            child_part("child-1", "thought", "reasoning", "first thought"),
        );
        assert!(rx.try_recv().is_err());
        emit_opencode_event(&target, task_frame("call-1", "running", Some("child-1")));
        emit_opencode_event(&target, child_part("child-1", "text", "text", "after"));
        emit_opencode_event(
            &target,
            child_part("child-1", "thought", "reasoning", "final thought"),
        );
        for status in ["running", "completed"] {
            emit_opencode_event(
                &target,
                frame(
                    "message.part.updated",
                    json!({"part":{"sessionID":"child-1","messageID":"child-msg",
                "id":"shell","type":"tool","tool":"bash","callID":"tool-call","state":{"status":status,"input":{"command":"echo hello"},"output":"hello"}}}),
                ),
            );
        }
        emit_opencode_event(
            &target,
            frame(
                "message.part.delta",
                json!({"sessionID":"child-1","messageID":"child-msg","partID":"text","field":"text","delta":"ignored"}),
            ),
        );
        while let Ok(event) = rx.try_recv() {
            assert!(matches!(
                event.kind.as_str(),
                "chat.subagent" | "chat.subagent.item"
            ));
            assert_eq!(event.native_id.as_deref(), Some("native-1"));
            if event.kind == "chat.subagent.item" {
                assert_eq!(event.data["key"], "call-1");
                assert_eq!(event.data["item"]["role"], "user");
                let tool = event.data["item"]["parts"][0]["type"] == "tool";
                assert_eq!(
                    event.data.get("merge").and_then(Value::as_bool),
                    tool.then_some(true)
                );
            }
            db.record_provider_event("chat-s", event.turn_id.as_deref(), &event.kind, &event.data)
                .unwrap();
        }
        let (items, _, _) = db.subagent_items_after("chat-s", "call-1", 0).unwrap();
        assert_eq!(items.len(), 3);
        assert!(items.iter().all(|item| item.parts.len() == 1));
        assert_eq!(items[0].id, "child-msg:text");
        assert_eq!(items[0].parts[0]["text"], "after");
        assert_eq!(items[1].parts[0]["text"], "final thought");
        assert_eq!(items[2].parts[0]["status"], "completed");
        assert_eq!(target.active.lock().unwrap().as_deref(), Some("turn-1"));
    }

    #[test]
    fn unbound_child_buffer_drops_oldest_and_ignores_deltas() {
        let (events, mut rx) = crate::provider_events::tap_channel(256);
        let target = event_target(&events, Arc::new(Mutex::new(None)));
        for index in 0..205 {
            emit_opencode_event(
                &target,
                child_part(
                    "child-1",
                    &format!("part-{index}"),
                    "text",
                    &index.to_string(),
                ),
            );
            emit_opencode_event(
                &target,
                frame(
                    "message.part.delta",
                    json!({"sessionID":"child-1","delta":"ignored"}),
                ),
            );
        }
        assert_eq!(
            target.subagents.lock().unwrap().pending_children["child-1"].len(),
            200
        );
        assert!(rx.try_recv().is_err());
        emit_opencode_event(&target, task_frame("call-1", "running", Some("child-1")));
        assert_eq!(rx.try_recv().unwrap().kind, "chat.subagent");
        assert_eq!(rx.try_recv().unwrap().data["item"]["parts"][0]["text"], "5");
        let rest = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(rest.len(), 199);
        assert!(target.subagents.lock().unwrap().pending_children.is_empty());
    }

    #[test]
    fn questions_map_root_and_buffered_child_with_native_resolution() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        emit_opencode_event(
            &target,
            frame(
                "question.asked",
                json!({"sessionID":"native-1","id":"root-q","questions":[
                    {"header":"Pick","question":"Which colour?","options":[{"label":"Blue","description":"Recommended"}],"custom":false},
                    {"header":"Many","question":"Which tools?","options":[{"label":"Read"}],"multiple":true}
                ]}),
            ),
        );
        let root = rx.try_recv().unwrap();
        assert_eq!(root.kind, "chat.approval");
        assert_eq!(root.data["part"]["data"]["interaction"], "question");
        assert_eq!(
            root.data["part"]["data"]["form"]["questions"][0]["allowOther"],
            false
        );
        assert_eq!(
            root.data["part"]["data"]["form"]["questions"][1]["multiSelect"],
            true
        );
        emit_opencode_event(
            &target,
            frame(
                "question.replied",
                json!({"sessionID":"native-1","requestID":"root-q"}),
            ),
        );
        assert_eq!(rx.try_recv().unwrap().data["status"], "answered");

        emit_opencode_event(
            &target,
            frame(
                "question.asked",
                json!({"sessionID":"child-1","id":"child-q","questions":[{"question":"Which file?","options":[{"label":"README.md"}]}]}),
            ),
        );
        assert!(rx.try_recv().is_err());
        emit_opencode_event(
            &target,
            task_frame("child-call", "running", Some("child-1")),
        );
        let subagent = rx.try_recv().unwrap();
        assert_eq!(subagent.kind, "chat.subagent");
        let child = rx.try_recv().unwrap();
        assert_eq!(child.kind, "chat.approval");
        assert_eq!(child.data["part"]["data"]["subagent"]["key"], "child-call");
        emit_opencode_event(
            &target,
            frame(
                "question.rejected",
                json!({"sessionID":"child-1","requestID":"child-q"}),
            ),
        );
        assert_eq!(rx.try_recv().unwrap().data["status"], "dismissed");
    }

    #[test]
    fn nested_session_registration_and_inner_tasks_keep_the_root_key() {
        let (events, mut rx) = crate::provider_events::tap_channel(32);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        // Descendant creation can precede the root's task metadata.
        emit_opencode_event(
            &target,
            frame(
                "session.created",
                json!({"info":{"id":"nested-1","parentID":"child-1"}}),
            ),
        );
        emit_opencode_event(
            &target,
            child_part("nested-1", "early", "text", "nested early"),
        );
        emit_opencode_event(&target, task_frame("root-call", "running", Some("child-1")));
        emit_opencode_event(
            &target,
            frame(
                "session.updated",
                json!({"info":{"id":"nested-2","parentID":"child-1"}}),
            ),
        );
        emit_opencode_event(
            &target,
            child_part("nested-2", "later", "text", "nested later"),
        );
        let mut inner = task_frame("inner-call", "completed", Some("nested-3"));
        inner["payload"]["properties"]["part"]["sessionID"] = json!("child-1");
        emit_opencode_event(&target, inner);
        emit_opencode_event(
            &target,
            child_part("nested-3", "tool-child", "text", "inner task"),
        );
        let all = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(all.len(), 4);
        assert_eq!(all[0].kind, "chat.subagent");
        assert!(all.iter().all(|event| event.data["key"] == "root-call"));
        assert!(all[1..]
            .iter()
            .all(|event| event.kind == "chat.subagent.item"));
        assert_eq!(
            target.subagents.lock().unwrap().children["nested-3"],
            "root-call"
        );
        assert_eq!(target.active.lock().unwrap().as_deref(), Some("turn-1"));
    }

    #[test]
    fn subtask_cards_and_native_snapshots_exclude_spawn_parts() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        let subtask = json!({"id":"subtask-part","sessionID":"native-1","messageID":"parent-msg",
            "type":"subtask","agent":"explore","description":"Inspect files","prompt":"Read the code"});
        emit_opencode_event(
            &target,
            frame("message.part.updated", json!({"part":subtask})),
        );
        let card = rx.try_recv().unwrap();
        assert_eq!(card.kind, "chat.subagent");
        assert_eq!(card.data["key"], "subtask-part");
        assert_eq!(card.data["info"]["agentType"], "explore");
        let task = task_frame("call-1", "running", None)["payload"]["properties"]["part"].clone();
        let text = json!({"id":"parent-text","sessionID":"native-1","messageID":"parent-msg","type":"text","text":"Parent answer"});
        let row =
            json!({"info":{"id":"parent-msg","sessionID":"native-1"},"parts":[task,subtask,text]});
        let normalized = native_message_parts(&row, "parent-msg", "native-1").unwrap();
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].1["text"], "Parent answer");
        emit_opencode_event(&target, task_frame("call-1", "running", None));
        rx.try_recv().unwrap();
        emit_opencode_event(&target, frame("message.part.updated", json!({"part":text})));
        let snapshot = rx.try_recv().unwrap();
        assert_eq!(snapshot.kind, "chat.item");
        assert_eq!(snapshot.data["parts"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot.data["parts"][0]["text"], "Parent answer");
    }

    #[test]
    fn child_errors_idle_and_foreign_events_cannot_settle_parent_or_permissions() {
        let (events, mut rx) = crate::provider_events::tap_channel(32);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        emit_opencode_event(&target, task_frame("call-1", "running", Some("child-1")));
        rx.try_recv().unwrap();
        target.native_turn_observed.store(false, Ordering::SeqCst);
        emit_opencode_event(
            &target,
            frame(
                "session.error",
                json!({"sessionID":"child-1","error":{"name":"UnknownError","data":{"message":"child failed"}}}),
            ),
        );
        let event = rx.try_recv().unwrap();
        assert_eq!(event.kind, "chat.subagent.item");
        assert_eq!(event.data["item"]["parts"][0]["type"], "error");
        assert_eq!(event.data["item"]["parts"][0]["text"], "child failed");
        emit_opencode_event(
            &target,
            frame("session.idle", json!({"sessionID":"child-1"})),
        );
        for kind in [
            "session.error",
            "session.idle",
            "permission.asked",
            "permission.replied",
        ] {
            emit_opencode_event(
                &target,
                frame(
                    kind,
                    json!({"sessionID":"foreign","id":"foreign-per","requestID":"foreign-per"}),
                ),
            );
        }
        emit_opencode_event(
            &target,
            child_part("foreign", "foreign-part", "text", "foreign text"),
        );
        emit_opencode_event(
            &target,
            frame(
                "session.created",
                json!({"info":{"id":"foreign","parentID":"other-root"}}),
            ),
        );
        assert!(rx.try_recv().is_err());
        assert!(target.permissions.lock().unwrap().is_empty());
        assert_eq!(target.active.lock().unwrap().as_deref(), Some("turn-1"));
        assert!(!target.native_turn_observed.load(Ordering::SeqCst));
        target.stopped.store(true, Ordering::SeqCst);
        emit_opencode_event(&target, child_part("child-1", "late", "text", "after stop"));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn history_hides_children_but_accepts_null_or_absent_parent() {
        for parent in [json!("native-1"), json!("")] {
            assert!(opencode_history_item(
                &json!({"id":"child","directory":"/a","parentID":parent}),
                Some("/a")
            )
            .is_none());
        }
        assert!(opencode_history_item(
            &json!({"id":"root","directory":"/a","parentID":null}),
            Some("/a")
        )
        .is_some());
        assert!(
            opencode_history_item(&json!({"id":"root","directory":"/a"}), Some("/a")).is_some()
        );
    }

    #[test]
    fn conformance_opencode_child_permission_and_question_settlements_are_exactly_once() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = mpsc::sync_channel(2);
        let responder = thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut chunk = [0u8; 1024];
                loop {
                    let count = stream.read(&mut chunk).unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&chunk[..count]);
                    if request
                        .windows(4)
                        .position(|window| window == b"\r\n\r\n")
                        .is_some_and(|end| {
                            let headers = String::from_utf8_lossy(&request[..end]);
                            let length = headers
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .and_then(|value| value.trim().parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            request.len() >= end + 4 + length
                        })
                    {
                        break;
                    }
                }
                request_tx
                    .send(String::from_utf8(request).unwrap())
                    .unwrap();
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                    .unwrap();
            }
        });
        let (events, mut rx) = crate::provider_events::tap_channel(32);
        let active = Arc::new(Mutex::new(Some("turn-1".into())));
        let target = Arc::new(event_target(&events, Arc::clone(&active)));
        emit_opencode_event(
            &target,
            frame(
                "permission.asked",
                json!({"id":"per_child","sessionID":"child-1","permission":"bash","patterns":["*"],"metadata":{},"always":[]}),
            ),
        );
        assert!(rx.try_recv().is_err());
        emit_opencode_event(&target, task_frame("call-1", "running", Some("child-1")));
        assert_eq!(rx.try_recv().unwrap().kind, "chat.subagent");
        let asked = rx.try_recv().unwrap();
        assert_eq!(asked.kind, "chat.approval");
        assert_eq!(
            asked.data["part"]["data"]["subagent"],
            json!({"key":"call-1","label":"Inspect files"})
        );
        assert_eq!(asked.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(
            target.permission_sessions.lock().unwrap()["per_child"],
            "child-1"
        );
        *active.lock().unwrap() = Some("turn-2".into());
        emit_opencode_event(
            &target,
            frame(
                "permission.updated",
                json!({"id":"per_child","sessionID":"child-1","permission":"bash"}),
            ),
        );
        assert_eq!(rx.try_recv().unwrap().turn_id.as_deref(), Some("turn-1"));
        // A parent/foreign reply cannot settle a child's permission.
        emit_opencode_event(
            &target,
            frame(
                "permission.replied",
                json!({"sessionID":"native-1","requestID":"per_child","reply":"once"}),
            ),
        );
        assert!(rx.try_recv().is_err());
        assert!(target.permissions.lock().unwrap().contains_key("per_child"));

        // An inert shell keeps is_alive() true for the real approve() path;
        // this test never discovers or starts an OpenCode executable.
        #[cfg(windows)]
        let spec = CommandSpec::from_path(
            std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
            vec![
                "-NoProfile".into(),
                "-Command".into(),
                "Start-Sleep -Seconds 30".into(),
            ],
        )
        .unwrap();
        #[cfg(not(windows))]
        let spec = CommandSpec::from_path(
            std::path::PathBuf::from("/bin/sh"),
            vec!["-c".into(), "sleep 30".into()],
        )
        .unwrap();
        let (child, job) = spawn_managed_service(&spec, None, &[]).unwrap();
        let child = Arc::new(Mutex::new(child));
        let _child_cleanup = TestChildCleanup(Arc::clone(&child));
        let server = OpenCodeServer {
            base_url: format!("http://{address}"),
            cwd: String::new(),
            username: String::new(),
            password: String::new(),
            client: Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            child,
            stopped: Arc::clone(&target.stopped),
            event_gate: Arc::clone(&target.event_gate),
            active_turn: Arc::clone(&active),
            permissions: Arc::clone(&target.permissions),
            events: events.clone(),
            threadterm_session: "chat-s".into(),
            worker_token: "test-worker".into(),
            _job: job,
        };
        let mut chat = OpenCodeChat {
            server,
            session_id: "chat-s".into(),
            native_id: "native-1".into(),
            events,
            sse_target: Arc::clone(&target),
            worker_token: "test-worker".into(),
        };
        assert_eq!(
            chat.approve("wrong-turn", "per_child", "allow", "op-wrong")
                .unwrap_err()
                .code,
            "approval_not_pending"
        );
        let approved = chat.approve("turn-1", "per_child", "allow", "op-1");
        approved.unwrap();
        let request = request_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            request.starts_with("POST /session/child-1/permissions/per_child?"),
            "{request}"
        );
        assert!(request.contains("\"response\":\"once\""));
        emit_opencode_event(
            &target,
            frame(
                "permission.replied",
                json!({"sessionID":"child-1","requestID":"per_child","reply":"once"}),
            ),
        );
        let resolved = rx.try_recv().unwrap();
        assert_eq!(resolved.kind, "chat.approval.resolved");
        assert_eq!(resolved.turn_id.as_deref(), Some("turn-1"));
        assert!(target.permissions.lock().unwrap().is_empty());
        assert!(target.permission_sessions.lock().unwrap().is_empty());
        assert_eq!(active.lock().unwrap().as_deref(), Some("turn-2"));

        // An OpenCode question is answered by an HTTP reply, so the captured
        // request is its protocol-specific exactly-once settlement evidence.
        emit_opencode_event(
            &target,
            frame(
                "question.asked",
                json!({"sessionID":"native-1","id":"root-q","questions":[{"question":"Pick one","options":[{"label":"Blue"}]}]}),
            ),
        );
        assert_eq!(rx.try_recv().unwrap().kind, "chat.approval");
        chat.answer(
            "turn-2",
            "root-q",
            &json!({"action":"submit","values":{"q0":["Blue"]}}),
            "op-question",
        )
        .unwrap();
        let question_request = request_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            question_request.starts_with("POST /question/root-q/reply?"),
            "{question_request}"
        );
        assert!(question_request.contains("\"answers\":[[\"Blue\"]]"));
        let question_resolved = rx.try_recv().unwrap();
        assert_eq!(question_resolved.kind, "chat.approval.resolved");
        assert_eq!(question_resolved.data["approvalId"], "root-q");
        assert!(rx.try_recv().is_err(), "the question must settle once");
        responder.join().unwrap();

        assert_eq!(
            chat.answer(
                "turn-2",
                "root-q",
                &json!({"action":"submit","values":{"q0":["Blue"]}}),
                "op-question-duplicate",
            )
            .unwrap_err()
            .code,
            "approval_not_pending"
        );
        assert!(
            request_rx.recv_timeout(Duration::from_millis(100)).is_err(),
            "a duplicate answer must not make another native HTTP request"
        );

        // The RAII guard retires the inert shell during unwinding too.
        chat.server.stopped.store(true, Ordering::SeqCst);
        {
            let mut child = chat.server.child.lock().unwrap();
            let _ = child.kill();
            let _ = child.wait();
        }
        // Suppress a disposal HTTP request when the test server has exited.
        chat.server.stopped.store(true, Ordering::SeqCst);
    }

    #[test]
    fn child_permissions_expire_and_late_updates_do_not_reopen_them() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        emit_opencode_event(&target, task_frame("call-1", "running", Some("child-1")));
        rx.try_recv().unwrap();
        emit_opencode_event(
            &target,
            frame(
                "permission.asked",
                json!({"id":"per_child","sessionID":"child-1","permission":"bash"}),
            ),
        );
        assert_eq!(rx.try_recv().unwrap().kind, "chat.approval");
        emit_opencode_event(
            &target,
            frame(
                "permission.replied",
                json!({"sessionID":"child-1","requestID":"per_child","reply":"reject"}),
            ),
        );
        assert_eq!(rx.try_recv().unwrap().kind, "chat.approval.resolved");
        emit_opencode_event(
            &target,
            frame(
                "permission.updated",
                json!({"id":"per_child","sessionID":"child-1","permission":"bash"}),
            ),
        );
        assert!(rx.try_recv().is_err());
        emit_opencode_event(
            &target,
            frame(
                "permission.asked",
                json!({"id":"per_pending","sessionID":"child-1","permission":"bash"}),
            ),
        );
        rx.try_recv().unwrap();
        expire_stream(&target, "test_expiry", "stream lost");
        let expired = rx.try_recv().unwrap();
        assert_eq!(expired.kind, "chat.approval.resolved");
        assert_eq!(expired.data["status"], "expired");
        assert!(target.permission_sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn parallel_tasks_preserve_parent_text_tools_and_independent_child_ownership() {
        let db = projection_db();
        let (events, mut rx) = crate::provider_events::tap_channel(32);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        let parent_text = |text: &str| {
            frame(
                "message.part.updated",
                json!({"part":{
            "id":"parent-text","messageID":"parent-msg","sessionID":"native-1","type":"text","text":text}}),
            )
        };
        emit_opencode_event(&target, parent_text("Parent before"));
        emit_opencode_event(&target, task_frame("call-a", "running", None));
        emit_opencode_event(&target, task_frame("call-b", "running", None));
        emit_opencode_event(&target, child_part("child-b", "text", "text", "B"));
        emit_opencode_event(&target, child_part("child-a", "text", "text", "A"));
        emit_opencode_event(&target, task_frame("call-b", "running", Some("child-b")));
        emit_opencode_event(&target, task_frame("call-a", "running", Some("child-a")));
        emit_opencode_event(
            &target,
            frame(
                "message.part.updated",
                json!({"part":{
            "id":"parent-tool","messageID":"parent-msg","sessionID":"native-1","type":"tool","tool":"bash",
            "state":{"status":"completed","input":{"command":"echo parent"},"output":"parent"}}}),
            ),
        );
        emit_opencode_event(&target, parent_text("Parent after"));
        drain(&db, &mut rx, "chat-s");
        assert_eq!(projected_texts(&db, "chat-s"), ["Parent after"]);
        let items = db.chat_items("chat-s").unwrap();
        let parent = items
            .iter()
            .find(|item| item.parts.iter().any(|part| part["type"] == "text"))
            .unwrap();
        assert_eq!(parent.parts.len(), 2);
        assert_eq!(parent.parts[1]["toolId"], "parent-tool");
        assert_eq!(parent.parts[1]["toolName"], "bash");
        assert_eq!(parent.parts[1]["status"], "completed");
        assert_eq!(
            items
                .iter()
                .filter(|item| item.parts[0]["type"] == "subagent")
                .count(),
            2
        );
        for (key, expected) in [("call-a", "A"), ("call-b", "B")] {
            let (child, _, _) = db.subagent_items_after("chat-s", key, 0).unwrap();
            assert_eq!(child.len(), 1);
            assert_eq!(child[0].parts[0]["text"], expected);
        }
        assert_eq!(target.active.lock().unwrap().as_deref(), Some("turn-1"));
        emit_opencode_event(
            &target,
            frame("session.idle", json!({"sessionID":"native-1"})),
        );
        assert_eq!(rx.try_recv().unwrap().kind, "chat.turn.completed");
        assert!(target.active.lock().unwrap().is_none());
    }

    #[test]
    fn sse_watchdog_requires_complete_native_frames_and_three_missed_heartbeats() {
        let started = Instant::now();
        assert!(!sse_event_silent_since(
            started,
            started + Duration::from_secs(34)
        ));
        assert!(sse_event_silent_since(
            started,
            started + Duration::from_secs(35)
        ));
        assert!(valid_native_sse_frame(&frame(
            "server.connected",
            json!({})
        )));
        assert!(valid_native_sse_frame(&frame(
            "server.heartbeat",
            json!({})
        )));
        assert!(valid_native_sse_frame(&frame(
            "session.idle",
            json!({"sessionID":"foreign-but-valid"})
        )));
        assert!(!valid_native_sse_frame(&json!({})));
        assert!(!valid_native_sse_frame(
            &json!({"payload":{"type":"server.heartbeat"}})
        ));
        assert!(!valid_native_sse_frame(
            &json!({"payload":{"type":"","properties":{}}})
        ));
        assert!(!valid_native_sse_frame(
            &json!({"payload":{"type":"server.heartbeat","properties":[]}})
        ));
    }

    #[test]
    fn sse_expiry_and_explicit_stop_are_single_terminal_transitions() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        target.permissions.lock().unwrap().insert(
            "per_1".into(),
            OpenCodeInteraction {
                turn: Some("turn-1".into()),
                question: None,
            },
        );
        expire_stream(&target, "event_stream_silent", "heartbeat missing");
        expire_stream(&target, "event_stream_disconnected", "EOF raced watchdog");
        assert_eq!(
            [
                rx.try_recv().unwrap().kind,
                rx.try_recv().unwrap().kind,
                rx.try_recv().unwrap().kind,
            ],
            ["chat.approval.resolved", "chat.error", "session.closed"]
        );
        assert!(rx.try_recv().is_err(), "EOF cannot emit a second failure");
        assert!(!target.liveness.load(Ordering::SeqCst));
        assert!(target.permissions.lock().unwrap().is_empty());

        let (stop_events, mut stop_rx) = crate::provider_events::tap_channel(4);
        let stopped = event_target(&stop_events, Arc::new(Mutex::new(Some("turn-2".into()))));
        stopped.stopped.store(true, Ordering::SeqCst);
        expire_stream(&stopped, "event_stream_silent", "ignored after stop");
        assert!(stop_rx.try_recv().is_err());
    }

    #[test]
    fn refreshed_frame_wins_over_a_watchdog_waiting_for_the_commit_gate() {
        let (events, mut rx) = crate::provider_events::tap_channel(8);
        let target = Arc::new(event_target(&events, Arc::new(Mutex::new(None))));
        let clock = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(36)));
        let gate = target.event_gate.lock().unwrap();
        let watchdog_target = Arc::clone(&target);
        let watchdog_clock = Arc::clone(&clock);
        let watchdog =
            thread::spawn(move || expire_silent_stream(&watchdog_target, &watchdog_clock));
        // The reader has already accepted a complete valid native frame. Its
        // clock refresh holds the same gate, so a delayed watchdog must
        // re-read this fresh value after it wins the gate.
        *clock.lock().unwrap() = Instant::now();
        drop(gate);
        assert!(!watchdog.join().unwrap());
        assert!(target.liveness.load(Ordering::SeqCst));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn delayed_native_snapshot_cannot_publish_after_watchdog_expiry() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let (request_seen, seen) = mpsc::sync_channel(1);
        let (release, allowed) = mpsc::sync_channel(1);
        let responder = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let count = stream.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..count]).contains("/message/msg_1"));
            request_seen.send(()).unwrap();
            allowed.recv().unwrap();
            let body = json!({"info":{"id":"msg_1","sessionID":"native-1"},"parts":[{"id":"prt_1","messageID":"msg_1","sessionID":"native-1","type":"text","text":"AFTER"}]}).to_string();
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(response.as_bytes()).unwrap();
        });
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let mut target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        target.base_url = format!("http://{address}");
        target
            .assembly
            .lock()
            .unwrap()
            .seed(&json!([{"info":{"id":"msg_1","sessionID":"native-1"},"parts":[{"id":"prt_1","messageID":"msg_1","sessionID":"native-1","type":"text","text":"BEFORE"}]}]), "native-1")
            .unwrap();
        let target = Arc::new(target);
        let reader_target = Arc::clone(&target);
        let projection = thread::spawn(move || {
            emit_opencode_event(
                &reader_target,
                frame(
                    "message.part.delta",
                    json!({"sessionID":"native-1","messageID":"msg_1","partID":"prt_1","field":"text","delta":"AFTER"}),
                ),
            );
        });
        seen.recv_timeout(Duration::from_secs(2)).unwrap();
        expire_stream(&target, "event_stream_silent", "native heartbeat missing");
        release.send(()).unwrap();
        projection.join().unwrap();
        responder.join().unwrap();
        let mut kinds = Vec::new();
        while let Ok(event) = rx.try_recv() {
            kinds.push(event.kind);
        }
        assert_eq!(kinds, ["chat.error", "session.closed"]);
        assert!(!kinds.iter().any(|kind| kind == "chat.item"));
    }

    #[test]
    fn seeded_messages_require_authoritative_snapshots_and_reject_wrong_identity() {
        let mut assembly = OpenCodeAssembly::default();
        let row = json!({"info":{"id":"msg_1","sessionID":"native-1"},"parts":[{"id":"prt_1","messageID":"msg_1","sessionID":"native-1","type":"text","text":"AB"}]});
        assembly.seed(&json!([row.clone()]), "native-1").unwrap();
        assert!(
            assembly.requires_native_snapshot("msg_1"),
            "a buffered delta may already be in the seeded AB snapshot"
        );
        assert_eq!(assembly.messages["msg_1"].snapshot()[0]["text"], "AB");
        assert!(native_message_parts(&row, "msg_other", "native-1").is_err());
        assert!(native_message_parts(&row, "msg_1", "native-other").is_err());
        assert!(assembly
            .seed(&json!({"unexpected":true}), "native-1")
            .is_err());

        let rows: Vec<Value> = (0..MAX_ASSEMBLED_MESSAGES)
            .map(|index| json!({"info":{"id":format!("msg_{index}"),"sessionID":"native-1"},"parts":[]}))
            .collect();
        let mut paged = OpenCodeAssembly::default();
        paged.seed(&json!(rows), "native-1").unwrap();
        assert!(
            paged.authoritative_only,
            "a full page may omit older history"
        );
        assert!(
            paged.messages.is_empty(),
            "a long history must not be cached as payload"
        );

        let mut oversized = OpenCodeAssembly::default();
        let large = "x".repeat(MAX_ASSEMBLED_PAYLOAD_BYTES + 1);
        oversized
            .seed(
                &json!([{"info":{"id":"msg_large","sessionID":"native-1"},"parts":[{"id":"prt_large","messageID":"msg_large","sessionID":"native-1","type":"text","text":large}]}]),
                "native-1",
            )
            .unwrap();
        assert!(oversized.authoritative_only);
        assert!(
            oversized.messages.is_empty(),
            "large replies are not retained in the local assembly cache"
        );
    }

    #[test]
    fn foreign_session_events_never_touch_this_chat() {
        let (events, _rx) = crate::provider_events::tap_channel(16);
        let active = Arc::new(Mutex::new(Some("turn-1".to_owned())));
        let target = event_target(&events, Arc::clone(&active));
        emit_opencode_event(
            &target,
            frame(
                "session.idle",
                json!({"sessionID":"ses_other_not_this_chat"}),
            ),
        );
        assert_eq!(
            *active.lock().unwrap(),
            Some("turn-1".to_owned()),
            "another session's idle must not take this chat's active turn"
        );
    }

    #[test]
    fn user_prompt_parts_and_step_markers_never_become_reply_items() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".to_owned()))));
        let part = |message: &str, id: &str, kind: &str| frame("message.part.updated",
            json!({"part":{"sessionID":"native-1","messageID":message,"id":id,"type":kind,"text":"Work in this repository"}}));
        let items = |rx: &mut tokio::sync::broadcast::Receiver<super::super::ProviderEvent>| std::iter::from_fn(|| rx.try_recv().ok())
            .filter(|event| event.kind == "chat.item").map(|event| event.data).collect::<Vec<_>>();
        // Live 1.18.35: the prompt's own text part was shown as the reply.
        emit_opencode_event(&target, frame("message.updated", json!({"info":{"id":"user-msg","sessionID":"native-1","role":"user"}})));
        emit_opencode_event(&target, part("user-msg", "user-text", "text"));
        emit_opencode_event(&target, frame("message.part.delta", json!({"sessionID":"native-1","messageID":"user-msg","partID":"user-text","field":"text","delta":"more"})));
        for kind in ["step-start", "step-finish", "snapshot", "patch"] {
            emit_opencode_event(&target, part("reply-msg", kind, kind));
        }
        assert!(items(&mut rx).is_empty(), "no prompt echo and no bookkeeping parts");
        // A part that arrives before its message's role is withdrawn once the role is known.
        emit_opencode_event(&target, part("late-user", "late-text", "text"));
        assert_eq!(items(&mut rx).len(), 1);
        emit_opencode_event(&target, frame("message.updated", json!({"info":{"id":"late-user","sessionID":"native-1","role":"user"}})));
        let withdrawn = items(&mut rx);
        assert_eq!(withdrawn.len(), 1);
        assert_eq!(withdrawn[0]["item"]["id"], "late-user");
        assert_eq!(withdrawn[0]["parts"], json!([]));
        // Assistant text still projects.
        emit_opencode_event(&target, part("reply-msg", "reply-text", "text"));
        assert_eq!(items(&mut rx)[0]["parts"][0]["type"], "text");
    }

    #[test]
    fn foreign_and_stopped_events_cannot_project_or_settle_this_turn() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let active = Arc::new(Mutex::new(Some("turn-1".to_owned())));
        let target = event_target(&events, Arc::clone(&active));
        for raw in [
            frame(
                "message.part.updated",
                json!({"sessionID":"foreign","part":{"id":"p1","messageID":"m1","sessionID":"foreign","type":"text","text":"FOREIGN"}}),
            ),
            frame(
                "permission.asked",
                json!({"sessionID":"foreign","id":"foreign-approval","permission":"bash"}),
            ),
            frame(
                "session.error",
                json!({"sessionID":"foreign","message":"foreign failure"}),
            ),
            frame("session.idle", json!({"sessionID":"foreign"})),
            frame("session.idle", json!({})),
        ] {
            emit_opencode_event(&target, raw);
        }
        assert!(rx.try_recv().is_err());
        assert_eq!(*active.lock().unwrap(), Some("turn-1".to_owned()));
        target.stopped.store(true, Ordering::SeqCst);
        emit_opencode_event(
            &target,
            frame("session.idle", json!({"sessionID":"native-1"})),
        );
        assert!(rx.try_recv().is_err());
        assert_eq!(*active.lock().unwrap(), Some("turn-1".to_owned()));
    }

    #[test]
    fn conformance_child_and_foreign_frames_are_scoped_and_only_parent_idle_completes() {
        let (events, mut rx) = crate::provider_events::tap_channel(32);
        let active = Arc::new(Mutex::new(Some("turn-1".to_owned())));
        let target = event_target(&events, Arc::clone(&active));

        // The parent and child intentionally collide on both native item ids.
        // Parent transcript identity remains native-session scoped.
        emit_opencode_event(
            &target,
            frame(
                "message.part.updated",
                json!({"part":{"sessionID":"native-1","messageID":"shared","id":"part","type":"text","text":"parent text"}}),
            ),
        );
        let parent = rx.try_recv().unwrap();
        assert_eq!(parent.kind, "chat.item");
        assert_eq!(parent.data["item"]["id"], "shared");

        emit_opencode_event(
            &target,
            frame(
                "question.asked",
                json!({"sessionID":"child-1","id":"child-question","questions":[{"question":"Child choice?","options":[{"label":"Blue"}]}]}),
            ),
        );
        assert!(rx.try_recv().is_err(), "an unbound child question must not leak");
        assert_eq!(*active.lock().unwrap(), Some("turn-1".to_owned()));
        emit_opencode_event(&target, task_frame("agent", "running", Some("child-1")));
        let binding = [rx.try_recv().unwrap(), rx.try_recv().unwrap()];
        assert_eq!(binding[0].kind, "chat.subagent");
        assert_eq!(binding[1].kind, "chat.approval");
        assert_eq!(binding[1].data["approvalId"], "child-question");
        for event in &binding {
            super::super::conformance::assert_no_parent_effect(std::slice::from_ref(event), "chat-s");
        }
        emit_opencode_event(
            &target,
            frame(
                "message.part.updated",
                json!({"part":{"sessionID":"child-1","messageID":"shared","id":"part","type":"text","text":"child text"}}),
            ),
        );
        let child = rx.try_recv().unwrap();
        assert_eq!(child.kind, "chat.subagent.item");
        assert_eq!(child.data["key"], "agent");
        assert_eq!(child.data["item"]["id"], "shared:part");
        super::super::conformance::assert_no_parent_effect(&[child], "chat-s");
        assert!(rx.try_recv().is_err(), "a child frame must not project a parent event");

        for raw in [
            frame("session.idle", json!({"sessionID":"child-1"})),
            frame("session.idle", json!({"sessionID":"foreign"})),
            frame("question.asked", json!({"sessionID":"foreign","id":"foreign-question","questions":[{"question":"Foreign choice?","options":[{"label":"Red"}]}]})),
            frame("message.part.updated", json!({"part":{"sessionID":"foreign","messageID":"shared","id":"part","type":"text","text":"foreign text"}})),
        ] {
            emit_opencode_event(&target, raw);
        }
        assert!(rx.try_recv().is_err(), "foreign/child frames must have no parent effect");
        assert_eq!(*active.lock().unwrap(), Some("turn-1".to_owned()));

        emit_opencode_event(&target, frame("session.idle", json!({"sessionID":"native-1"})));
        let terminal = rx.try_recv().unwrap();
        assert_eq!(terminal.kind, "chat.turn.completed");
        assert_eq!(terminal.turn_id.as_deref(), Some("turn-1"));
        assert!(rx.try_recv().is_err());
        assert!(active.lock().unwrap().is_none());
    }

    #[test]
    fn replied_permission_cannot_be_reopened_by_late_update() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".to_owned()))));
        emit_opencode_event(
            &target,
            frame(
                "permission.asked",
                json!({"sessionID":"native-1","id":"per_1","permission":"bash"}),
            ),
        );
        emit_opencode_event(
            &target,
            frame(
                "permission.replied",
                json!({"sessionID":"native-1","requestID":"per_1","reply":"reject"}),
            ),
        );
        emit_opencode_event(
            &target,
            frame(
                "permission.updated",
                json!({"sessionID":"native-1","id":"per_1","permission":"bash"}),
            ),
        );
        let emitted: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        assert_eq!(
            emitted
                .iter()
                .filter(|event| event.kind == "chat.approval")
                .count(),
            1
        );
        assert_eq!(
            emitted
                .iter()
                .filter(|event| event.kind == "chat.approval.resolved")
                .count(),
            1
        );
        assert!(target.permissions.lock().unwrap().is_empty());
    }

    #[test]
    fn repeated_ask_keeps_original_turn_identity() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let active = Arc::new(Mutex::new(Some("turn-original".to_owned())));
        let target = event_target(&events, Arc::clone(&active));
        let asked = frame(
            "permission.asked",
            json!({"sessionID":"native-1","id":"per_1","permission":"bash"}),
        );
        emit_opencode_event(&target, asked.clone());
        *active.lock().unwrap() = Some("turn-later".to_owned());
        emit_opencode_event(&target, asked);
        emit_opencode_event(
            &target,
            frame(
                "permission.replied",
                json!({"sessionID":"native-1","requestID":"per_1","reply":"once"}),
            ),
        );
        let emitted: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        assert_eq!(
            emitted.last().unwrap().turn_id.as_deref(),
            Some("turn-original")
        );
    }

    #[test]
    fn permission_replies_distinguish_rejection_cancellation_and_unknown() {
        let (events, mut rx) = crate::provider_events::tap_channel(32);
        let db = projection_db();
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".to_owned()))));
        for (id, reply) in [
            ("per_reject", "reject"),
            ("per_cancel", "cancelled"),
            ("per_odd", "other"),
        ] {
            emit_opencode_event(
                &target,
                frame(
                    "permission.asked",
                    json!({"sessionID":"native-1","id":id,"permission":"bash"}),
                ),
            );
            emit_opencode_event(
                &target,
                frame(
                    "permission.replied",
                    json!({"sessionID":"native-1","requestID":id,"reply":reply}),
                ),
            );
        }
        drain(&db, &mut rx, "chat-s");
        let items = db.chat_items("chat-s").unwrap();
        let status = |id: &str| {
            items
                .iter()
                .find(|item| item.id == format!("chat-s:approval:{id}"))
                .unwrap()
                .parts[0]["status"]
                .clone()
        };
        assert_eq!(status("per_reject"), "resolved");
        assert_eq!(status("per_cancel"), "expired");
        assert_eq!(status("per_odd"), "outcomeUnknown");
    }

    #[test]
    fn two_distinct_messages_and_two_parts_of_one_message_all_survive() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let db = projection_db();
        let active = Arc::new(Mutex::new(Some("turn-1".to_owned())));
        let target = event_target(&events, Arc::clone(&active));
        for raw in [
            frame(
                "message.part.updated",
                json!({"sessionID":"native-1","part":{"id":"prt_1","messageID":"msg_1","sessionID":"native-1","type":"text","text":"FIRST-PART"}}),
            ),
            frame(
                "message.part.updated",
                json!({"sessionID":"native-1","part":{"id":"prt_2","messageID":"msg_2","sessionID":"native-1","type":"text","text":"SECOND-PART"}}),
            ),
            frame(
                "message.part.updated",
                json!({"sessionID":"native-1","part":{"id":"prt_3","messageID":"msg_2","sessionID":"native-1","type":"text","text":"THIRD-PART"}}),
            ),
        ] {
            emit_opencode_event(&target, raw);
        }
        drain(&db, &mut rx, "chat-s");
        let texts = projected_texts(&db, "chat-s");
        assert!(
            texts.iter().any(|text| text.contains("FIRST-PART")),
            "first message lost: {texts:?}"
        );
        assert!(
            texts.iter().any(|text| text.contains("SECOND-PART")),
            "second message lost: {texts:?}"
        );
        assert!(
            texts.iter().any(|text| text.contains("THIRD-PART")),
            "second part of the second message lost: {texts:?}"
        );
    }

    #[test]
    fn deltas_then_full_snapshot_update_one_part_without_duplicates() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let db = projection_db();
        let active = Arc::new(Mutex::new(Some("turn-1".to_owned())));
        let target = event_target(&events, Arc::clone(&active));
        for raw in [
            frame(
                "message.part.delta",
                json!({"sessionID":"native-1","messageID":"msg_1","partID":"prt_1","field":"text","delta":"Hello "}),
            ),
            frame(
                "message.part.delta",
                json!({"sessionID":"native-1","messageID":"msg_1","partID":"prt_1","field":"text","delta":"world"}),
            ),
        ] {
            emit_opencode_event(&target, raw);
        }
        drain(&db, &mut rx, "chat-s");
        let streamed = projected_texts(&db, "chat-s");
        assert!(
            streamed.iter().any(|text| text == "Hello world"),
            "deltas must stream into one accumulating part, got: {streamed:?}"
        );
        // A full snapshot of the same part, delivered twice, replaces it once.
        for _ in 0..2 {
            emit_opencode_event(
                &target,
                frame(
                    "message.part.updated",
                    json!({"sessionID":"native-1","part":{"id":"prt_1","messageID":"msg_1","sessionID":"native-1","type":"text","text":"Hello world"}}),
                ),
            );
        }
        drain(&db, &mut rx, "chat-s");
        let texts = projected_texts(&db, "chat-s");
        assert_eq!(
            texts.iter().filter(|text| text.contains("Hello")).count(),
            1,
            "deltas and repeated snapshots must produce exactly one text part: {texts:?}"
        );
        assert!(
            texts.iter().any(|text| text == "Hello world"),
            "final text wrong: {texts:?}"
        );
    }

    #[test]
    fn text_tool_reasoning_and_later_text_keep_native_part_order() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let db = projection_db();
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".to_owned()))));
        for part in [
            json!({"id":"prt_a","messageID":"msg_1","sessionID":"native-1","type":"text","text":"before"}),
            json!({"id":"prt_b","messageID":"msg_1","sessionID":"native-1","type":"tool","tool":"bash","state":{"status":"completed"}}),
            json!({"id":"prt_c","messageID":"msg_1","sessionID":"native-1","type":"reasoning","text":"thinking"}),
            json!({"id":"prt_d","messageID":"msg_1","sessionID":"native-1","type":"text","text":"after"}),
        ] {
            emit_opencode_event(
                &target,
                frame(
                    "message.part.updated",
                    json!({"sessionID":"native-1","part":part}),
                ),
            );
        }
        drain(&db, &mut rx, "chat-s");
        let item = db
            .chat_items("chat-s")
            .unwrap()
            .into_iter()
            .find(|item| item.id == "chat-s:assistant:msg_1")
            .unwrap();
        assert_eq!(item.parts.len(), 4);
        assert_eq!(item.parts[0]["text"], "before");
        assert_eq!(item.parts[1]["type"], "tool");
        assert_eq!(item.parts[2]["type"], "thinking");
        assert_eq!(item.parts[3]["text"], "after");
    }

    #[test]
    fn permission_replied_resolves_only_the_matching_card() {
        let (events, mut rx) = crate::provider_events::tap_channel(16);
        let db = projection_db();
        let active = Arc::new(Mutex::new(Some("turn-1".to_owned())));
        let target = event_target(&events, Arc::clone(&active));
        for raw in [
            frame(
                "permission.asked",
                json!({"sessionID":"native-1","id":"per_1","permission":"bash","patterns":[],"metadata":{},"always":[]}),
            ),
            frame(
                "permission.asked",
                json!({"sessionID":"native-1","id":"per_2","permission":"write","patterns":[],"metadata":{},"always":[]}),
            ),
            frame(
                "permission.replied",
                json!({"sessionID":"native-1","requestID":"per_1","reply":"once"}),
            ),
        ] {
            emit_opencode_event(&target, raw);
        }
        drain(&db, &mut rx, "chat-s");
        let items = db.chat_items("chat-s").unwrap();
        let first = items
            .iter()
            .find(|item| item.id == "chat-s:approval:per_1")
            .expect("the asked card must exist");
        let second = items
            .iter()
            .find(|item| item.id == "chat-s:approval:per_2")
            .expect("the other card must exist");
        assert_ne!(
            first.parts[0].get("status").and_then(Value::as_str),
            Some("pending"),
            "a replied permission must not stay pending"
        );
        assert_eq!(
            second.parts[0].get("status").and_then(Value::as_str),
            Some("pending"),
            "the other card must stay pending"
        );
    }
}
