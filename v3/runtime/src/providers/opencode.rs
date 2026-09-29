use super::{
    approval::{allow_deny_choices, approval_payload, map_allow_deny_choice},
    common::{
        command_output, find_executable, history_page, insert_optional, spawn_managed_service,
        validate_native_id, version_probe, CommandSpec,
    },
    emit_scoped, ChatSession, ProviderAdapter, ProviderCapability, ProviderError, ProviderEvent,
    TerminalCommand,
};
use base64::Engine;
use chrono::{TimeZone, Utc};
use rand::RngCore;
use reqwest::blocking::{Client, Response};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
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
use tokio::sync::broadcast;

pub struct OpenCodeAdapter {
    events: broadcast::Sender<ProviderEvent>,
}
impl OpenCodeAdapter {
    pub fn new(events: broadcast::Sender<ProviderEvent>) -> Self {
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
            id: "opencode".to_owned(),
            name: "OpenCode".to_owned(),
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
        let server = OpenCodeServer::start(cwd, "terminal-prepare", broadcast::channel(1).0, "")?;
        let session =
            server.json(server.request(reqwest::Method::POST, "/session", Some(json!({})))?)?;
        let id = session.get("id").and_then(Value::as_str).ok_or_else(|| {
            ProviderError::new("provider_protocol", "OpenCode returned no session id")
        })?;
        validate_native_id(id)?;
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
    permissions: Arc<Mutex<HashMap<String, Option<String>>>>,
    events: broadcast::Sender<ProviderEvent>,
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
        events: broadcast::Sender<ProviderEvent>,
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
            native_turn_observed: AtomicBool::new(false),
            stopped: Arc::clone(&self.stopped),
            event_gate: Arc::clone(&self.event_gate),
            liveness: Arc::clone(&liveness),
            snapshot_client: self.client.clone(),
            base_url: self.base_url.clone(),
            directory: self.cwd.clone(),
            username: self.username.clone(),
            password: self.password.clone(),
        });
        let context = SseContext {
            reader: BufReader::new(response),
            target: Arc::clone(&target),
            stopped: Arc::clone(&self.stopped),
            liveness: Arc::clone(&liveness),
        };
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

struct OpenCodeChat {
    server: OpenCodeServer,
    session_id: String,
    native_id: String,
    events: broadcast::Sender<ProviderEvent>,
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
    fn send(&mut self, text: &str, operation_id: &str) -> Result<Value, ProviderError> {
        validate_native_id(operation_id)?;
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
        let sent = self.server.request(
            reqwest::Method::POST,
            &format!("/session/{}/prompt_async", self.native_id),
            Some(json!({"parts":[{"type":"text","text":text}]})),
        );
        if let Err(error) = sent {
            let commit = self.server.event_gate.lock().map_err(|_| {
                self.sse_target.liveness.store(false, Ordering::SeqCst);
                ProviderError::new("provider_internal", "OpenCode event gate poisoned")
            })?;
            let status = error
                .details
                .as_ref()
                .and_then(|details| details.get("httpStatus"))
                .and_then(Value::as_u64);
            let uncertain = error.code == "provider_disconnected"
                || status.is_none_or(|status| status >= 500)
                || self.sse_target.native_turn_observed.load(Ordering::SeqCst);
            if uncertain {
                // A 5xx, lost reply, or native event before the HTTP failure
                // cannot prove the prompt was rejected. Never replay it.
                expire_stream_locked(
                    &self.sse_target,
                    "send_result_unknown",
                    &error.message,
                    &commit,
                );
            } else {
                if let Ok(mut active) = self.server.active_turn.lock() {
                    if active.as_deref() == Some(operation_id) {
                        *active = None;
                        emit_scoped(
                            &self.events,
                            "opencode",
                            &self.session_id,
                            Some(&self.native_id),
                            Some(operation_id),
                            "chat.error",
                            json!({"message":error.message.clone(),"reason":"prompt_rejected"}),
                            Some(&self.worker_token),
                        );
                    }
                }
            }
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
                "OpenCode prompt result is uncertain after event-stream loss",
            ));
        }
        Ok(json!({"turnId":operation_id}))
    }
    fn cancel(&mut self, turn_id: &str) -> Result<(), ProviderError> {
        let matches = self
            .server
            .active_turn
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "OpenCode turn lock poisoned"))?
            .as_deref()
            == Some(turn_id);
        if !matches {
            return Err(ProviderError::new(
                "turn_not_active",
                "the requested OpenCode turn is not active",
            ));
        }
        self.server.request(
            reqwest::Method::POST,
            &format!("/session/{}/abort", self.native_id),
            None,
        )?;
        Ok(())
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
            .is_none_or(|asked_turn| asked_turn.as_deref().is_some_and(|asked| asked != turn_id))
        {
            return Err(ProviderError::new(
                "approval_not_pending",
                "OpenCode permission is no longer pending",
            ));
        }
        drop(known);
        drop(commit);
        let response = match map_allow_deny_choice(choice_id)? {
            "allow" => "once",
            _ => "reject",
        };
        let sent = self.server.request(
            reqwest::Method::POST,
            &format!("/session/{}/permissions/{approval_id}", self.native_id),
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
    seeded: HashSet<String>,
    authoritative_only: bool,
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
        .collect()
}

/// The state an SSE event may touch: everything except the transport reader.
/// Split out so the projection path is testable without a live socket.
struct EventTarget {
    threadterm_session: String,
    native_id: String,
    worker_token: String,
    events: broadcast::Sender<ProviderEvent>,
    active: Arc<Mutex<Option<String>>>,
    assembly: Arc<Mutex<OpenCodeAssembly>>,
    permissions: Arc<Mutex<HashMap<String, Option<String>>>>,
    settled_permissions: Arc<Mutex<HashSet<String>>>,
    native_turn_observed: AtomicBool,
    stopped: Arc<AtomicBool>,
    event_gate: Arc<Mutex<()>>,
    liveness: Arc<AtomicBool>,
    snapshot_client: Client,
    base_url: String,
    directory: String,
    username: String,
    password: String,
}

impl EventTarget {
    fn assembled_parts(
        &self,
        message_id: &str,
        local_update: impl FnOnce(&mut OpenCodeAssembly) -> Vec<Value>,
    ) -> Result<Vec<Value>, ProviderError> {
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
            let (parts, overflow) = self
                .assembly
                .lock()
                .map(|mut assembly| {
                    let parts = local_update(&mut assembly);
                    let overflow = assembly.exceeds_payload_budget();
                    if overflow {
                        assembly.discard_local_cache();
                    }
                    (parts, overflow)
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
                Ok(parts)
            }
        }
    }

    fn snapshot_parts(&self, message_id: &str) -> Result<Vec<Value>, ProviderError> {
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
        Ok(native_message_parts(&row, message_id, &self.native_id)?
            .into_iter()
            .map(|(_, part)| part)
            .collect())
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
    let pending = target
        .permissions
        .lock()
        .map(|mut permissions| std::mem::take(&mut *permissions))
        .unwrap_or_default();
    for (approval_id, asked_turn) in pending {
        emit_scoped(
            &target.events,
            "opencode",
            &target.threadterm_session,
            Some(&target.native_id),
            asked_turn.as_deref(),
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

    // Attribution gate: an event must name this exact native session before it
    // may touch the chat. Foreign sessions (including unknown sub-agent
    // sessions) and global events that name no session are never projected.
    let event_session = properties
        .get("sessionID")
        .or_else(|| properties.get("sessionId"))
        .and_then(Value::as_str)
        .or_else(|| {
            properties
                .get("info")
                .and_then(|v| v.get("sessionID"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            properties
                .get("part")
                .and_then(|v| v.get("sessionID"))
                .and_then(Value::as_str)
        });
    if event_session != Some(target.native_id.as_str()) {
        return;
    }
    let Ok(commit_guard) = target.event_gate.lock() else {
        return;
    };
    if target.stopped.load(Ordering::SeqCst) || !target.liveness.load(Ordering::SeqCst) {
        return;
    }
    let native_id = Some(target.native_id.as_str());
    let turn = target.active.lock().ok().and_then(|value| value.clone());
    if turn.is_some() {
        target.native_turn_observed.store(true, Ordering::SeqCst);
    }

    match event_type {
        "message.part.updated" => {
            let part = properties.get("part").cloned().unwrap_or(Value::Null);
            let (Some(part_id), Some(message_id)) = (
                part.get("id").and_then(Value::as_str),
                part.get("messageID").and_then(Value::as_str),
            ) else {
                return;
            };
            drop(commit_guard);
            let snapshot = match target.assembled_parts(message_id, |assembly| {
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
            emit_scoped(
                &target.events,
                "opencode",
                &target.threadterm_session,
                native_id,
                turn.as_deref(),
                "chat.item",
                json!({"item":{"id":message_id},"parts":snapshot,"raw":raw}),
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
            if field != "text" || delta.is_empty() {
                return;
            }
            drop(commit_guard);
            let snapshot = match target.assembled_parts(message_id, |assembly| {
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
            emit_scoped(
                &target.events,
                "opencode",
                &target.threadterm_session,
                native_id,
                turn.as_deref(),
                "chat.item",
                json!({"item":{"id":message_id},"parts":snapshot,"raw":raw}),
                Some(&target.worker_token),
            );
        }
        "permission.asked" | "permission.updated" => {
            // Real 1.18 frames carry the PermissionRequest flat in properties;
            // older fixtures nested it under `permission`.
            let permission = match properties.get("permission") {
                Some(value) if value.is_object() => value,
                _ => properties,
            };
            let Some(approval_id) = permission.get("id").and_then(Value::as_str) else {
                return;
            };
            if target
                .settled_permissions
                .lock()
                .ok()
                .is_some_and(|settled| settled.contains(approval_id))
            {
                return;
            }
            let asked_turn = match target.permissions.lock() {
                Ok(mut permissions) => {
                    if let Some(asked_turn) = permissions.get(approval_id) {
                        if event_type == "permission.asked" {
                            return;
                        }
                        asked_turn.clone()
                    } else {
                        permissions.insert(approval_id.to_owned(), turn.clone());
                        turn.clone()
                    }
                }
                Err(_) => return,
            };
            emit_scoped(
                &target.events,
                "opencode",
                &target.threadterm_session,
                native_id,
                asked_turn.as_deref(),
                "chat.approval",
                json!({
                    "approvalId":approval_id,
                    "request":permission,
                    "choices":allow_deny_choices(),
                    "part":{"type":"approval","approvalId":approval_id,"status":"pending","data":approval_payload(approval_id,"opencode","permission.asked",permission.get("title").and_then(Value::as_str).or_else(||permission.get("permission").and_then(Value::as_str)).unwrap_or("Permission request"),permission,&allow_deny_choices(),asked_turn.as_deref(),true)}
                }),
                Some(&target.worker_token),
            );
        }
        "permission.replied" => {
            let request_id = properties.get("requestID").and_then(Value::as_str);
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
                        settled.insert(id.to_owned());
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
                        native_id,
                        asked_turn.as_deref(),
                        "chat.approval.resolved",
                        json!({"approvalId":id,"status":status,"outcome":reply}),
                        Some(&target.worker_token),
                    );
                }
                (Some(_), None) => {
                    // Unknown or already-settled request: diagnose, never close
                    // a batch of cards by guessing.
                    emit_scoped(
                        &target.events,
                        "opencode",
                        &target.threadterm_session,
                        native_id,
                        turn.as_deref(),
                        "provider.event",
                        json!({"raw":raw,"note":"permission reply for an unknown or settled request"}),
                        Some(&target.worker_token),
                    );
                }
                (None, _) => {
                    emit_scoped(
                        &target.events,
                        "opencode",
                        &target.threadterm_session,
                        native_id,
                        turn.as_deref(),
                        "provider.event",
                        json!({"raw":raw,"note":"permission reply without a request id"}),
                        Some(&target.worker_token),
                    );
                }
            }
        }
        "session.idle" => {
            let completed = target.active.lock().ok().and_then(|mut value| value.take());
            if completed.is_none() {
                emit_scoped(
                    &target.events,
                    "opencode",
                    &target.threadterm_session,
                    native_id,
                    None,
                    "provider.event",
                    json!({"raw":raw}),
                    Some(&target.worker_token),
                );
                return;
            }
            emit_scoped(
                &target.events,
                "opencode",
                &target.threadterm_session,
                native_id,
                completed.as_deref(),
                "chat.turn.completed",
                json!({"raw":raw}),
                Some(&target.worker_token),
            );
        }
        "session.error" => {
            let failed = target.active.lock().ok().and_then(|mut value| value.take());
            emit_scoped(
                &target.events,
                "opencode",
                &target.threadterm_session,
                native_id,
                failed.as_deref(),
                "chat.error",
                json!({"raw":raw}),
                Some(&target.worker_token),
            );
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
    messages.into_iter().enumerate().filter_map(|(index,entry)|{
        let info=entry.get("info").unwrap_or(&entry);let role=info.get("role").and_then(Value::as_str)?;
        if !matches!(role,"user"|"assistant"){return None;}let parts=entry.get("parts").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().map(|part|{
            if part.get("type").and_then(Value::as_str)==Some("text"){json!({"type":"text","text":part.get("text").and_then(Value::as_str).unwrap_or_default()})}
            else {
                let mut tool = json!({"type":"tool","toolName":part.get("type").and_then(Value::as_str).unwrap_or("tool"),"data":part});
                insert_optional(&mut tool, "toolId", part.get("id").and_then(Value::as_str).map(|value| json!(value)));
                insert_optional(&mut tool, "status", part.get("state").and_then(|value| value.get("status")).and_then(Value::as_str).map(|value| json!(value)));
                crate::file_references::enrich_tool_part(&mut tool, None);
                tool
            }
        }).collect::<Vec<_>>();
        Some(json!({"id":info.get("id").and_then(Value::as_str).map(ToOwned::to_owned).unwrap_or_else(||format!("opencode-{index}")),"role":role,"parts":parts,"createdAt":Utc::now().to_rfc3339()}))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use std::io::{Read, Write};
    #[test]
    fn terminal_identity_is_prepared_through_native_session_api() {
        let adapter = OpenCodeAdapter::new(broadcast::channel(1).0);
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
        events: &broadcast::Sender<ProviderEvent>,
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
            native_turn_observed: AtomicBool::new(false),
            stopped: Arc::new(AtomicBool::new(false)),
            event_gate: Arc::new(Mutex::new(())),
            liveness: Arc::new(AtomicBool::new(true)),
            snapshot_client: Client::new(),
            base_url: "http://127.0.0.1:0".into(),
            directory: String::new(),
            username: String::new(),
            password: String::new(),
        }
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
        let (events, mut rx) = broadcast::channel(16);
        let target = event_target(&events, Arc::new(Mutex::new(Some("turn-1".into()))));
        target
            .permissions
            .lock()
            .unwrap()
            .insert("per_1".into(), Some("turn-1".into()));
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

        let (stop_events, mut stop_rx) = broadcast::channel(4);
        let stopped = event_target(&stop_events, Arc::new(Mutex::new(Some("turn-2".into()))));
        stopped.stopped.store(true, Ordering::SeqCst);
        expire_stream(&stopped, "event_stream_silent", "ignored after stop");
        assert!(stop_rx.try_recv().is_err());
    }

    #[test]
    fn refreshed_frame_wins_over_a_watchdog_waiting_for_the_commit_gate() {
        let (events, mut rx) = broadcast::channel(8);
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
        let (events, mut rx) = broadcast::channel(16);
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
        let (events, _rx) = broadcast::channel(16);
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
    fn foreign_and_stopped_events_cannot_project_or_settle_this_turn() {
        let (events, mut rx) = broadcast::channel(16);
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
    fn replied_permission_cannot_be_reopened_by_late_update() {
        let (events, mut rx) = broadcast::channel(16);
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
        let (events, mut rx) = broadcast::channel(16);
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
        let (events, mut rx) = broadcast::channel(32);
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
        let (events, mut rx) = broadcast::channel(16);
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
        let (events, mut rx) = broadcast::channel(16);
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
        let (events, mut rx) = broadcast::channel(16);
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
        let (events, mut rx) = broadcast::channel(16);
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
