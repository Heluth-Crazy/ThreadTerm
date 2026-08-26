use std::{
    fmt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde::{de::DeserializeOwned, Deserialize};
use terminal_host_protocol::{
    EmptyRequest, EmptyResponse, EnvelopeKind, EventEnvelope, EventPayload, Method,
    RequestEnvelope, ResponseEnvelope, SessionAckRequest, SessionAttachRequest,
    SessionAttachResponse, SessionDetachRequest, SessionInputRequest, SessionListRequest,
    SessionListResponse, SessionPresentRequest, SessionRecord, SessionResizeRequest,
    SessionResyncRequest, SurfaceHiddenRequest, SurfaceReadyRequest, TransportError,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{mpsc, oneshot},
    time::Instant,
};

use super::{
    connection::{authenticate, read_bootstrap, read_json_frame, write_request, Connected},
    event_projection::{DaemonEvent, DaemonEventSink, ReconcileSnapshot},
    presentation::desktop_registration,
    request_mux::{RequestMux, DEFAULT_PENDING_LIMIT},
};

const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_RECONNECT_DELAY: Duration = Duration::from_millis(250);
const COMMAND_QUEUE_CAPACITY: usize = 128;

#[derive(Clone)]
pub struct DaemonClientConfig {
    pub profile_dir: PathBuf,
    /// Development/packaging bootstrap path. No executable lookup is performed.
    pub daemon_exe: Option<PathBuf>,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    pub reconnect_delay: Duration,
    pub pending_limit: usize,
}

impl DaemonClientConfig {
    pub fn new(profile_dir: PathBuf) -> Self {
        Self {
            profile_dir,
            daemon_exe: None,
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            reconnect_delay: DEFAULT_RECONNECT_DELAY,
            pending_limit: DEFAULT_PENDING_LIMIT,
        }
    }

    fn validate(&self) -> Result<(), DaemonClientError> {
        if !self.profile_dir.is_absolute()
            || self.connect_timeout.is_zero()
            || self.request_timeout.is_zero()
            || self.reconnect_delay.is_zero()
            || self.pending_limit == 0
            || self.pending_limit > 4096
            || self
                .daemon_exe
                .as_ref()
                .is_some_and(|path| !path.is_absolute())
        {
            return Err(DaemonClientError::InvalidConfiguration);
        }
        Ok(())
    }
}

impl fmt::Debug for DaemonClientConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DaemonClientConfig")
            .field("profile_dir", &"[redacted-path]")
            .field(
                "daemon_exe",
                &self.daemon_exe.as_ref().map(|_| "[redacted-path]"),
            )
            .field("connect_timeout", &self.connect_timeout)
            .field("request_timeout", &self.request_timeout)
            .field("reconnect_delay", &self.reconnect_delay)
            .field("pending_limit", &self.pending_limit)
            .finish()
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HealthStatus {
    pub status: String,
    pub runtime_id: String,
    pub owner_generation: u64,
    pub desktop_available: bool,
}

impl fmt::Debug for HealthStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HealthStatus")
            .field("status", &self.status)
            .field("runtime_id", &self.runtime_id)
            .field("owner_generation", &self.owner_generation)
            .field("desktop_available", &self.desktop_available)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum DaemonClientError {
    UnsupportedPlatform,
    InvalidConfiguration,
    InvalidEndpoint,
    Unavailable,
    Authentication,
    Protocol,
    Disconnected,
    Busy,
    Timeout,
    Remote(TransportError),
}

impl fmt::Debug for DaemonClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl fmt::Display for DaemonClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for DaemonClientError {}

impl DaemonClientError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedPlatform => "unsupported_platform",
            Self::InvalidConfiguration => "invalid_configuration",
            Self::InvalidEndpoint => "invalid_endpoint",
            Self::Unavailable => "app_unavailable",
            Self::Authentication => "authentication_failed",
            Self::Protocol => "protocol_error",
            Self::Disconnected => "disconnected",
            Self::Busy => "runtime_busy",
            Self::Timeout => "timeout",
            Self::Remote(error) => match error.code {
                terminal_host_protocol::TransportErrorCode::UnsupportedVersion => {
                    "unsupported_version"
                }
                terminal_host_protocol::TransportErrorCode::InvalidKind => "invalid_kind",
                terminal_host_protocol::TransportErrorCode::InvalidMethod => "invalid_method",
                terminal_host_protocol::TransportErrorCode::InvalidRequest => "invalid_request",
                terminal_host_protocol::TransportErrorCode::RequestConflict => "request_conflict",
                terminal_host_protocol::TransportErrorCode::TerminalNotFound => {
                    "terminal_not_found"
                }
                terminal_host_protocol::TransportErrorCode::SpawnFailed => "spawn_failed",
                terminal_host_protocol::TransportErrorCode::AppUnavailable => "app_unavailable",
                terminal_host_protocol::TransportErrorCode::SurfaceFailed => "surface_failed",
                terminal_host_protocol::TransportErrorCode::IncompatibleRuntime => {
                    "incompatible_runtime"
                }
                terminal_host_protocol::TransportErrorCode::StalePresentation => {
                    "stale_presentation"
                }
                terminal_host_protocol::TransportErrorCode::RuntimeBusy => "runtime_busy",
                terminal_host_protocol::TransportErrorCode::InternalError => "internal_error",
            },
        }
    }
}

pub(crate) enum ClientCommand {
    Request {
        method: Method,
        params: serde_json::Value,
        response: oneshot::Sender<Result<ResponseEnvelope, DaemonClientError>>,
    },
    Shutdown(oneshot::Sender<()>),
}

#[derive(Clone)]
pub struct DaemonClientHandle {
    pub(crate) commands: mpsc::Sender<ClientCommand>,
    pub(crate) request_timeout: Duration,
}

impl fmt::Debug for DaemonClientHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DaemonClientHandle")
            .field("request_timeout", &self.request_timeout)
            .finish_non_exhaustive()
    }
}

impl DaemonClientHandle {
    pub async fn start(
        config: DaemonClientConfig,
        sink: Arc<dyn DaemonEventSink>,
    ) -> Result<Self, DaemonClientError> {
        config.validate()?;
        #[cfg(not(windows))]
        {
            let _ = sink;
            return Err(DaemonClientError::UnsupportedPlatform);
        }
        #[cfg(windows)]
        {
            let (commands, receiver) = mpsc::channel(COMMAND_QUEUE_CAPACITY);
            let request_timeout = config.request_timeout;
            tokio::spawn(coordinator(config, sink, receiver));
            Ok(Self {
                commands,
                request_timeout,
            })
        }
    }

    pub async fn health(&self) -> Result<HealthStatus, DaemonClientError> {
        let response = self.request(Method::Health, &EmptyRequest {}).await?;
        decode_response(response)
    }

    pub async fn list(&self) -> Result<SessionListResponse, DaemonClientError> {
        let response = self
            .request(Method::SessionList, &SessionListRequest {})
            .await?;
        decode_response(response)
    }

    pub async fn attach(
        &self,
        handle: impl Into<String>,
    ) -> Result<SessionAttachResponse, DaemonClientError> {
        let response = self
            .request(
                Method::SessionAttach,
                &SessionAttachRequest {
                    handle: handle.into(),
                },
            )
            .await?;
        decode_response(response)
    }

    pub async fn detach(&self, request: SessionDetachRequest) -> Result<(), DaemonClientError> {
        let response = self.request(Method::SessionDetach, &request).await?;
        ensure_success(&response)
    }

    pub async fn input(&self, request: SessionInputRequest) -> Result<(), DaemonClientError> {
        let response = self.request(Method::SessionInput, &request).await?;
        ensure_success(&response)
    }

    pub async fn resize(&self, request: SessionResizeRequest) -> Result<(), DaemonClientError> {
        let response = self.request(Method::SessionResize, &request).await?;
        ensure_success(&response)
    }

    pub async fn ack(&self, request: SessionAckRequest) -> Result<(), DaemonClientError> {
        let response = self.request(Method::SessionAck, &request).await?;
        ensure_success(&response)
    }

    pub async fn resync(
        &self,
        request: SessionResyncRequest,
    ) -> Result<SessionAttachResponse, DaemonClientError> {
        let response = self.request(Method::SessionResync, &request).await?;
        decode_response(response)
    }

    pub async fn present(
        &self,
        request: SessionPresentRequest,
    ) -> Result<SessionRecord, DaemonClientError> {
        let response = self.request(Method::SessionPresent, &request).await?;
        decode_response(response)
    }

    pub async fn surface_ready(
        &self,
        request: SurfaceReadyRequest,
    ) -> Result<SessionRecord, DaemonClientError> {
        let response = self.request(Method::SurfaceReady, &request).await?;
        decode_response(response)
    }

    pub async fn surface_hidden(
        &self,
        request: SurfaceHiddenRequest,
    ) -> Result<SessionRecord, DaemonClientError> {
        let response = self.request(Method::SurfaceHidden, &request).await?;
        decode_response(response)
    }

    /// Stops only the desktop client actor. It deliberately sends no surface.hidden.
    pub async fn shutdown(&self) {
        let (sent, received) = oneshot::channel();
        if self
            .commands
            .send(ClientCommand::Shutdown(sent))
            .await
            .is_ok()
        {
            let _ = tokio::time::timeout(self.request_timeout, received).await;
        }
    }

    async fn request<T: serde::Serialize>(
        &self,
        method: Method,
        params: &T,
    ) -> Result<ResponseEnvelope, DaemonClientError> {
        let params = serde_json::to_value(params).map_err(|_| DaemonClientError::Protocol)?;
        let (sent, received) = oneshot::channel();
        tokio::time::timeout(
            self.request_timeout,
            self.commands.send(ClientCommand::Request {
                method,
                params,
                response: sent,
            }),
        )
        .await
        .map_err(|_| DaemonClientError::Timeout)?
        .map_err(|_| DaemonClientError::Disconnected)?;
        tokio::time::timeout(self.request_timeout + Duration::from_secs(1), received)
            .await
            .map_err(|_| DaemonClientError::Timeout)?
            .map_err(|_| DaemonClientError::Disconnected)?
    }
}

fn decode_response<T: DeserializeOwned>(
    response: ResponseEnvelope,
) -> Result<T, DaemonClientError> {
    if let Some(error) = response.error {
        return Err(DaemonClientError::Remote(error));
    }
    serde_json::from_value(response.result.ok_or(DaemonClientError::Protocol)?)
        .map_err(|_| DaemonClientError::Protocol)
}

#[cfg(windows)]
async fn coordinator(
    config: DaemonClientConfig,
    sink: Arc<dyn DaemonEventSink>,
    mut commands: mpsc::Receiver<ClientCommand>,
) {
    let mut previous_runtime_id = None;
    let mut attempted_start = false;
    loop {
        let connection = connect(&config).await;
        let mut connected = match connection {
            Ok(connection) => connection,
            Err(_) => {
                if !attempted_start {
                    if let Some(executable) = config.daemon_exe.as_deref() {
                        let _ = ensure_daemon_running(executable, &config.profile_dir).await;
                    }
                    attempted_start = true;
                }
                if wait_disconnected(&config, &mut commands).await {
                    return;
                }
                continue;
            }
        };

        let catalog = match initialize_desktop(&mut connected, config.request_timeout, &sink).await
        {
            Ok(catalog) => catalog,
            Err(_) => {
                sink.on_event(DaemonEvent::Disconnected);
                if wait_disconnected(&config, &mut commands).await {
                    return;
                }
                continue;
            }
        };
        let runtime_id = connected.runtime_id.clone();
        sink.on_event(DaemonEvent::Reconcile(ReconcileSnapshot {
            previous_runtime_id: previous_runtime_id.clone(),
            runtime_id: runtime_id.clone(),
            catalog,
        }));
        previous_runtime_id = Some(runtime_id);
        attempted_start = false;

        match serve_connected(connected, &config, &sink, &mut commands).await {
            ConnectionEnd::Shutdown(acknowledge) => {
                let _ = acknowledge.send(());
                return;
            }
            ConnectionEnd::Disconnected => sink.on_event(DaemonEvent::Disconnected),
        }
    }
}

#[cfg(windows)]
async fn connect(
    config: &DaemonClientConfig,
) -> Result<Connected<tokio::net::windows::named_pipe::NamedPipeClient>, DaemonClientError> {
    let (endpoint, secret) = read_bootstrap(&config.profile_dir)?;
    let stream =
        super::connection::connect_pipe(&endpoint.pipe_name, config.connect_timeout).await?;
    authenticate(stream, &endpoint, secret, config.connect_timeout).await
}

pub(crate) async fn initialize_desktop<S>(
    connected: &mut Connected<S>,
    timeout: Duration,
    sink: &Arc<dyn DaemonEventSink>,
) -> Result<SessionListResponse, DaemonClientError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let registration = direct_request(
        connected,
        2,
        Method::DesktopRegister,
        &desktop_registration(),
        timeout,
        sink,
    )
    .await?;
    ensure_success(&registration)?;
    let response = direct_request(
        connected,
        3,
        Method::SessionList,
        &SessionListRequest {},
        timeout,
        sink,
    )
    .await?;
    decode_response(response)
}

fn ensure_success(response: &ResponseEnvelope) -> Result<(), DaemonClientError> {
    if let Some(error) = response.error.clone() {
        Err(DaemonClientError::Remote(error))
    } else {
        serde_json::from_value::<EmptyResponse>(
            response.result.clone().ok_or(DaemonClientError::Protocol)?,
        )
        .map(|_| ())
        .map_err(|_| DaemonClientError::Protocol)
    }
}

async fn direct_request<S, T>(
    connected: &mut Connected<S>,
    id: u64,
    method: Method,
    params: &T,
    timeout: Duration,
    sink: &Arc<dyn DaemonEventSink>,
) -> Result<ResponseEnvelope, DaemonClientError>
where
    S: AsyncRead + AsyncWrite + Unpin,
    T: serde::Serialize,
{
    let request = RequestEnvelope {
        version: connected.selected,
        kind: EnvelopeKind::Request,
        id,
        method,
        params: serde_json::to_value(params).map_err(|_| DaemonClientError::Protocol)?,
    };
    write_request(&mut connected.stream, &request).await?;
    tokio::time::timeout(timeout, async {
        loop {
            match read_wire_frame(&mut connected.stream, connected.selected).await? {
                WireFrame::Response(response) if response.id == id => return Ok(response),
                WireFrame::Response(_) => return Err(DaemonClientError::Protocol),
                WireFrame::Event(event) => project_event(event, sink),
            }
        }
    })
    .await
    .map_err(|_| DaemonClientError::Timeout)?
}

enum ConnectionEnd {
    Disconnected,
    Shutdown(oneshot::Sender<()>),
}

async fn serve_connected<S>(
    connected: Connected<S>,
    config: &DaemonClientConfig,
    sink: &Arc<dyn DaemonEventSink>,
    commands: &mut mpsc::Receiver<ClientCommand>,
) -> ConnectionEnd
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let selected = connected.selected;
    let (mut reader, mut writer) = tokio::io::split(connected.stream);
    let mut mux = RequestMux::new(4, config.pending_limit, config.request_timeout);
    let mut expiration = tokio::time::interval(Duration::from_millis(100));
    expiration.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(ClientCommand::Shutdown(acknowledge)) => {
                    mux.fail_all(DaemonClientError::Disconnected);
                    return ConnectionEnd::Shutdown(acknowledge);
                }
                Some(ClientCommand::Request { method, params, response }) => {
                    if mux.is_full() {
                        let _ = response.send(Err(DaemonClientError::Busy));
                        continue;
                    }
                    let id = match mux.reserve(response) {
                        Ok(id) => id,
                        Err(_) => unreachable!("capacity was checked before reservation"),
                    };
                    let request = RequestEnvelope {
                        version: selected,
                        kind: EnvelopeKind::Request,
                        id,
                        method,
                        params,
                    };
                    if write_request(&mut writer, &request).await.is_err() {
                        mux.fail_all(DaemonClientError::Disconnected);
                        return ConnectionEnd::Disconnected;
                    }
                }
                None => {
                    mux.fail_all(DaemonClientError::Disconnected);
                    return ConnectionEnd::Shutdown(oneshot::channel().0);
                }
            },
            frame = read_wire_frame(&mut reader, selected) => match frame {
                Ok(WireFrame::Response(response)) => {
                    let Some(pending) = mux.take(response.id) else {
                        mux.fail_all(DaemonClientError::Protocol);
                        return ConnectionEnd::Disconnected;
                    };
                    if response.validate_for(&selected).is_err() {
                        let _ = pending.response.send(Err(DaemonClientError::Protocol));
                        mux.fail_all(DaemonClientError::Protocol);
                        return ConnectionEnd::Disconnected;
                    }
                    let _ = pending.response.send(Ok(response));
                }
                Ok(WireFrame::Event(event)) => project_event(event, sink),
                Err(_) => {
                    mux.fail_all(DaemonClientError::Disconnected);
                    return ConnectionEnd::Disconnected;
                }
            },
            _ = expiration.tick() => mux.expire(Instant::now()),
        }
    }
}

enum WireFrame {
    Response(ResponseEnvelope),
    Event(EventEnvelope),
}

async fn read_wire_frame<R>(
    reader: &mut R,
    selected: terminal_host_protocol::ProtocolVersion,
) -> Result<WireFrame, DaemonClientError>
where
    R: AsyncRead + Unpin,
{
    let body = read_json_frame(reader).await?;
    let value: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| DaemonClientError::Protocol)?;
    match value.get("kind").and_then(serde_json::Value::as_str) {
        Some("response") => {
            let response: ResponseEnvelope =
                serde_json::from_value(value).map_err(|_| DaemonClientError::Protocol)?;
            response
                .validate_for(&selected)
                .map_err(|_| DaemonClientError::Protocol)?;
            Ok(WireFrame::Response(response))
        }
        Some("event") => {
            let event: EventEnvelope =
                serde_json::from_value(value).map_err(|_| DaemonClientError::Protocol)?;
            event
                .validate_for(&selected)
                .map_err(|_| DaemonClientError::Protocol)?;
            Ok(WireFrame::Event(event))
        }
        _ => Err(DaemonClientError::Protocol),
    }
}

fn project_event(event: EventEnvelope, sink: &Arc<dyn DaemonEventSink>) {
    let projected = match event.decode_payload() {
        Ok(EventPayload::SessionOutput(value)) => DaemonEvent::SessionOutput(value),
        Ok(EventPayload::SessionState(value)) => DaemonEvent::SessionState(value),
        Ok(EventPayload::SessionExit(value)) => DaemonEvent::SessionExit(value),
        Ok(EventPayload::SessionResyncRequired(value)) => DaemonEvent::SessionResyncRequired(value),
        Ok(EventPayload::SurfacePresentRequested(value)) => {
            DaemonEvent::SurfacePresentRequested(value)
        }
        Err(_) => return,
    };
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink.on_event(projected)));
}

#[cfg(windows)]
async fn wait_disconnected(
    config: &DaemonClientConfig,
    commands: &mut mpsc::Receiver<ClientCommand>,
) -> bool {
    let delay = tokio::time::sleep(config.reconnect_delay);
    tokio::pin!(delay);
    loop {
        tokio::select! {
            _ = &mut delay => return false,
            command = commands.recv() => match command {
                Some(ClientCommand::Request { response, .. }) => {
                    let _ = response.send(Err(DaemonClientError::Unavailable));
                }
                Some(ClientCommand::Shutdown(acknowledge)) => {
                    let _ = acknowledge.send(());
                    return true;
                }
                None => return true,
            }
        }
    }
}

/// Development/packaging helper. It never performs PATH lookup or shell parsing.
pub async fn ensure_daemon_running(
    daemon_exe: &Path,
    profile_dir: &Path,
) -> Result<(), DaemonClientError> {
    if !daemon_exe.is_absolute() || !profile_dir.is_absolute() {
        return Err(DaemonClientError::InvalidConfiguration);
    }
    #[cfg(not(windows))]
    {
        let _ = (daemon_exe, profile_dir);
        Err(DaemonClientError::UnsupportedPlatform)
    }
    #[cfg(windows)]
    {
        use std::{os::windows::process::CommandExt, process::Stdio};
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let mut command = tokio::process::Command::new(daemon_exe);
        command
            .args([
                "--profile-dir",
                profile_dir
                    .to_str()
                    .ok_or(DaemonClientError::InvalidConfiguration)?,
                "--role",
                "become-owner",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
            .as_std_mut()
            .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
        command
            .spawn()
            .map_err(|_| DaemonClientError::Unavailable)?;
        Ok(())
    }
}

#[cfg(test)]
pub(crate) async fn run_test_connection<S>(
    connected: Connected<S>,
    config: DaemonClientConfig,
    sink: Arc<dyn DaemonEventSink>,
    mut commands: mpsc::Receiver<ClientCommand>,
) where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let _ = serve_connected(connected, &config, &sink, &mut commands).await;
}
