use std::{sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use terminal_host_core::{
    Catalog, CatalogCommand, CatalogResult, TerminalState, MAX_LIST_PAGE_SIZE,
};
use terminal_host_protocol::{
    ClientClass, EffectClassification, EnvelopeKind, HelloRequest, IpcError, Method, ProtocolRange,
    ProtocolVersion, RequestEnvelope, ResponseEnvelope, SessionListResponse, SessionRecord,
    SessionState, TransportError, TransportErrorCode, MAX_HELLO_FRAME_BYTES,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{mpsc, Semaphore},
    time::timeout,
};

use crate::{
    bootstrap::{RuntimeEndpoint, Secret},
    HostError,
};

#[cfg(feature = "terminal-daemon-owner")]
mod presentation;
#[cfg(feature = "terminal-daemon-owner")]
mod pty;

#[cfg(feature = "terminal-daemon-owner")]
use pty::RuntimeControl;

pub const DEFAULT_HELLO_TIMEOUT: Duration = Duration::from_secs(2);
pub const DEFAULT_MAX_PREAUTH_CONNECTIONS: usize = 16;
pub const DEFAULT_WRITER_QUEUE_CAPACITY: usize = 32;
pub const DEFAULT_MAX_CONNECTIONS: usize = 64;
pub const DEFAULT_MAX_LIST_RECORDS: usize = 4_096;
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
pub const DEFAULT_IDLE_SHUTDOWN: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
pub struct ServiceLimits {
    pub hello_timeout: Duration,
    pub max_preauth_connections: usize,
    pub writer_queue_capacity: usize,
    pub max_connections: usize,
    pub max_list_records: usize,
    pub request_timeout: Duration,
    pub idle_shutdown: Duration,
}

impl Default for ServiceLimits {
    fn default() -> Self {
        Self {
            hello_timeout: DEFAULT_HELLO_TIMEOUT,
            max_preauth_connections: DEFAULT_MAX_PREAUTH_CONNECTIONS,
            writer_queue_capacity: DEFAULT_WRITER_QUEUE_CAPACITY,
            max_connections: DEFAULT_MAX_CONNECTIONS,
            max_list_records: DEFAULT_MAX_LIST_RECORDS,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            idle_shutdown: DEFAULT_IDLE_SHUTDOWN,
        }
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HelloAck {
    pub selected_version: ProtocolVersion,
    pub runtime_id: String,
    pub launch_nonce: String,
    pub owner_generation: u64,
    pub connection_id: String,
    pub capabilities: Vec<String>,
}

impl std::fmt::Debug for HelloAck {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HelloAck")
            .field("selected_version", &self.selected_version)
            .field("runtime_id", &self.runtime_id)
            .field("launch_nonce", &self.launch_nonce)
            .field("owner_generation", &self.owner_generation)
            .field("connection_id", &"[redacted]")
            .field("capabilities", &self.capabilities)
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HealthResult {
    pub status: String,
    pub runtime_id: String,
    pub owner_generation: u64,
    pub desktop_available: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionClose {
    Continue,
    Close,
}

#[derive(Clone)]
pub struct TerminalHostService {
    endpoint: RuntimeEndpoint,
    secret: Secret,
    catalog: Option<Arc<Catalog>>,
    #[cfg(feature = "terminal-daemon-owner")]
    engine: Option<Arc<terminal_host_core::DaemonPtyEngine>>,
    #[cfg(feature = "terminal-daemon-owner")]
    control: Arc<RuntimeControl>,
    limits: ServiceLimits,
    preauth: Arc<Semaphore>,
    connections: Arc<Semaphore>,
}

impl TerminalHostService {
    pub fn new(
        endpoint: RuntimeEndpoint,
        secret: Secret,
        catalog: Catalog,
        limits: ServiceLimits,
    ) -> Result<Self, HostError> {
        endpoint.validate()?;
        if limits.max_preauth_connections == 0
            || limits.max_connections == 0
            || limits.max_list_records == 0
            || limits.max_list_records > MAX_LIST_PAGE_SIZE as usize
            || limits.writer_queue_capacity == 0
            || limits.hello_timeout.is_zero()
            || limits.request_timeout.is_zero()
            || limits.idle_shutdown.is_zero()
        {
            return Err(HostError::InvalidArguments);
        }
        Ok(Self {
            endpoint,
            secret,
            catalog: Some(Arc::new(catalog)),
            #[cfg(feature = "terminal-daemon-owner")]
            engine: None,
            #[cfg(feature = "terminal-daemon-owner")]
            control: Arc::new(RuntimeControl::new()),
            preauth: Arc::new(Semaphore::new(limits.max_preauth_connections)),
            connections: Arc::new(Semaphore::new(limits.max_connections)),
            limits,
        })
    }

    #[cfg(feature = "terminal-daemon-owner")]
    pub fn new_with_engine(
        endpoint: RuntimeEndpoint,
        secret: Secret,
        engine: terminal_host_core::DaemonPtyEngine,
        limits: ServiceLimits,
    ) -> Result<Self, HostError> {
        endpoint.validate()?;
        validate_limits(&limits)?;
        Ok(Self {
            endpoint,
            secret,
            catalog: None,
            engine: Some(Arc::new(engine)),
            control: Arc::new(RuntimeControl::new()),
            preauth: Arc::new(Semaphore::new(limits.max_preauth_connections)),
            connections: Arc::new(Semaphore::new(limits.max_connections)),
            limits,
        })
    }

    pub fn pipe_name(&self) -> Result<&str, HostError> {
        self.endpoint.validate()?;
        Ok(&self.endpoint.pipe_name)
    }

    pub fn authenticate_frame(
        &self,
        frame: &[u8],
    ) -> Result<(u64, ProtocolVersion, HelloAck), HostError> {
        if frame.is_empty() || frame.len() > MAX_HELLO_FRAME_BYTES {
            return Err(HostError::Unauthorized);
        }
        self.authenticate_frame_detailed(frame)
            .map(|(id, selected, ack, _)| (id, selected, ack))
    }

    fn authenticate_frame_detailed(
        &self,
        frame: &[u8],
    ) -> Result<(u64, ProtocolVersion, HelloAck, ClientClass), HostError> {
        let envelope: RequestEnvelope =
            serde_json::from_slice(frame).map_err(|_| HostError::Unauthorized)?;
        if envelope.kind != EnvelopeKind::Request || envelope.method != Method::Hello {
            return Err(HostError::Unauthorized);
        }
        let hello: HelloRequest =
            serde_json::from_value(envelope.params).map_err(|_| HostError::Unauthorized)?;
        hello.validate().map_err(|_| HostError::Unauthorized)?;
        if !self.secret.verify_encoded(&hello.secret) {
            return Err(HostError::Unauthorized);
        }
        let supported = ProtocolRange {
            min: self.endpoint.protocol_min,
            max: self.endpoint.protocol_max,
        };
        let selected = supported
            .negotiate(&hello.protocol)
            .ok_or(HostError::Unauthorized)?;
        if envelope.version != selected {
            return Err(HostError::Unauthorized);
        }
        let client = hello.client;
        Ok((
            envelope.id,
            selected,
            HelloAck {
                selected_version: selected,
                runtime_id: self.endpoint.runtime_id.clone(),
                launch_nonce: self.endpoint.launch_nonce.clone(),
                owner_generation: self.endpoint.owner_generation,
                connection_id: uuid::Uuid::new_v4().simple().to_string(),
                capabilities: self.capabilities(&client),
            },
            client,
        ))
    }

    fn capabilities(&self, client: &ClientClass) -> Vec<String> {
        #[cfg(feature = "terminal-daemon-owner")]
        if self.engine.is_some() {
            let mut capabilities = vec![
                "runtime.health",
                "runtime.stop",
                "session.create",
                "session.get",
                "session.list",
                "session.attach",
                "session.detach",
                "session.input",
                "session.resize",
                "session.ack",
                "session.resync",
                "session.close",
                "session.present",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
            if client == &ClientClass::Desktop {
                capabilities.push("desktop.register".into());
                capabilities.push("surface.ready".into());
                capabilities.push("surface.hidden".into());
            }
            return capabilities;
        }
        #[cfg(not(feature = "terminal-daemon-owner"))]
        let _ = client;
        vec!["runtime.health".into(), "session.list".into()]
    }

    pub fn handle_authenticated_frame(
        &self,
        selected: ProtocolVersion,
        frame: &[u8],
    ) -> ResponseEnvelope {
        let envelope: RequestEnvelope = match serde_json::from_slice(frame) {
            Ok(value) => value,
            Err(_) => return error_response(selected, 0, TransportErrorCode::InvalidRequest),
        };
        if let Err(error) = envelope.validate_for(&selected) {
            let code = match error {
                IpcError::UnsupportedVersion => TransportErrorCode::UnsupportedVersion,
                IpcError::InvalidKind => TransportErrorCode::InvalidKind,
                IpcError::InvalidProtocolRange
                | IpcError::InvalidRequest
                | IpcError::InvalidResponse => TransportErrorCode::InvalidRequest,
            };
            return error_response(selected, envelope.id, code);
        }
        if matches!(envelope.method, Method::Health | Method::SessionList)
            && !envelope
                .params
                .as_object()
                .is_some_and(serde_json::Map::is_empty)
        {
            return error_response(selected, envelope.id, TransportErrorCode::InvalidRequest);
        }
        let result: Result<serde_json::Value, TransportErrorCode> = match envelope.method {
            Method::Health => serde_json::to_value(HealthResult {
                status: "ok".into(),
                runtime_id: self.endpoint.runtime_id.clone(),
                owner_generation: self.endpoint.owner_generation,
                desktop_available: false,
            })
            .map_err(|_| TransportErrorCode::InternalError),
            Method::SessionList => match self.catalog.as_ref().and_then(|catalog| {
                catalog
                    .execute(CatalogCommand::ListPage {
                        limit: self.limits.max_list_records as u32,
                    })
                    .ok()
            }) {
                Some(CatalogResult::ListPage(page)) if !page.has_more => {
                    let sessions = page
                        .records
                        .into_iter()
                        .map(map_catalog_record)
                        .collect::<Vec<_>>();
                    serde_json::to_value(SessionListResponse { sessions })
                        .map_err(|_| TransportErrorCode::InternalError)
                }
                Some(CatalogResult::ListPage(_)) => Err(TransportErrorCode::InternalError),
                _ => Err(TransportErrorCode::InternalError),
            },
            _ => Err(TransportErrorCode::InvalidMethod),
        };
        match result {
            Ok(result) => ResponseEnvelope {
                version: selected,
                kind: EnvelopeKind::Response,
                id: envelope.id,
                result: Some(result),
                error: None,
            },
            Err(code) => error_response(selected, envelope.id, code),
        }
    }

    pub async fn serve_stream<S>(&self, stream: &mut S) -> Result<(), HostError>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        #[cfg(feature = "terminal-daemon-owner")]
        if self.engine.is_some() {
            return pty::serve_pty_stream(self, stream).await;
        }
        let _connection = self
            .connections
            .clone()
            .try_acquire_owned()
            .map_err(|_| HostError::QueueFull)?;
        let preauth = self
            .preauth
            .clone()
            .try_acquire_owned()
            .map_err(|_| HostError::QueueFull)?;
        let first = timeout(
            self.limits.hello_timeout,
            read_frame(stream, MAX_HELLO_FRAME_BYTES),
        )
        .await
        .map_err(|_| HostError::Timeout)??;
        let (id, selected, ack) = match self.authenticate_frame(&first) {
            Ok(value) => value,
            Err(_) => {
                write_unauthorized(stream).await?;
                return Err(HostError::Unauthorized);
            }
        };
        write_response(
            stream,
            &ResponseEnvelope {
                version: selected,
                kind: EnvelopeKind::Response,
                id,
                result: Some(serde_json::to_value(ack).map_err(|_| HostError::Io)?),
                error: None,
            },
        )
        .await?;
        drop(preauth);
        let (mut reader, mut writer) = tokio::io::split(stream);
        let (writer_tx, mut writer_rx) =
            mpsc::channel::<ResponseEnvelope>(self.limits.writer_queue_capacity);
        let writer_future = async {
            while let Some(response) = writer_rx.recv().await {
                write_response(&mut writer, &response).await?;
            }
            Ok::<(), HostError>(())
        };
        let reader_future = async move {
            loop {
                let frame = match timeout(
                    self.limits.request_timeout,
                    read_frame(&mut reader, terminal_host_protocol::MAX_FRAME_BYTES),
                )
                .await
                {
                    Ok(Ok(frame)) => frame,
                    Ok(Err(_)) => return Ok::<(), HostError>(()),
                    Err(_) => return Err(HostError::Timeout),
                };
                let response = self.handle_authenticated_frame(selected, &frame);
                writer_tx
                    .try_send(response)
                    .map_err(|_| HostError::QueueFull)?;
            }
        };
        tokio::pin!(reader_future);
        tokio::pin!(writer_future);
        tokio::select! {
            read_result = &mut reader_future => {
                read_result?;
                writer_future.await
            }
            write_result = &mut writer_future => write_result,
        }
    }
}

async fn read_frame<S: AsyncRead + Unpin>(
    stream: &mut S,
    maximum: usize,
) -> Result<Vec<u8>, HostError> {
    let length = stream.read_u32_le().await.map_err(|_| HostError::Io)? as usize;
    if length == 0 || length > maximum {
        return Err(HostError::Unauthorized);
    }
    let mut body = vec![0_u8; length];
    stream
        .read_exact(&mut body)
        .await
        .map_err(|_| HostError::Io)?;
    Ok(body)
}

async fn write_response<S: AsyncWrite + Unpin>(
    stream: &mut S,
    response: &ResponseEnvelope,
) -> Result<(), HostError> {
    let body = serde_json::to_vec(response).map_err(|_| HostError::Io)?;
    if body.len() > terminal_host_protocol::MAX_FRAME_BYTES {
        return Err(HostError::Io);
    }
    stream
        .write_u32_le(body.len() as u32)
        .await
        .map_err(|_| HostError::Io)?;
    stream.write_all(&body).await.map_err(|_| HostError::Io)?;
    stream.flush().await.map_err(|_| HostError::Io)
}

fn error_response(version: ProtocolVersion, id: u64, code: TransportErrorCode) -> ResponseEnvelope {
    error_response_with_effect(version, id, code, None, None, None)
}

fn error_response_with_effect(
    version: ProtocolVersion,
    id: u64,
    code: TransportErrorCode,
    effect: Option<EffectClassification>,
    request_id: Option<String>,
    handle: Option<String>,
) -> ResponseEnvelope {
    let message = match code {
        TransportErrorCode::UnsupportedVersion => "unsupported_version",
        TransportErrorCode::InvalidKind => "invalid_kind",
        TransportErrorCode::InvalidMethod => "invalid_method",
        TransportErrorCode::InvalidRequest => "invalid_request",
        TransportErrorCode::RequestConflict => "request_conflict",
        TransportErrorCode::TerminalNotFound => "terminal_not_found",
        TransportErrorCode::SpawnFailed => "spawn_failed",
        TransportErrorCode::AppUnavailable => "app_unavailable",
        TransportErrorCode::SurfaceFailed => "surface_failed",
        TransportErrorCode::IncompatibleRuntime => "incompatible_runtime",
        TransportErrorCode::StalePresentation => "stale_presentation",
        TransportErrorCode::RuntimeBusy => "runtime_busy",
        TransportErrorCode::InternalError => "internal_error",
    };
    ResponseEnvelope {
        version,
        kind: EnvelopeKind::Response,
        id,
        result: None,
        error: Some(TransportError {
            code,
            message: message.into(),
            effect,
            request_id,
            handle,
            retryable: matches!(
                code,
                TransportErrorCode::RuntimeBusy
                    | TransportErrorCode::AppUnavailable
                    | TransportErrorCode::SurfaceFailed
            ),
        }),
    }
}

#[cfg(feature = "terminal-daemon-owner")]
fn validate_limits(limits: &ServiceLimits) -> Result<(), HostError> {
    if limits.max_preauth_connections == 0
        || limits.max_connections == 0
        || limits.max_list_records == 0
        || limits.max_list_records > MAX_LIST_PAGE_SIZE as usize
        || limits.writer_queue_capacity == 0
        || limits.hello_timeout.is_zero()
        || limits.request_timeout.is_zero()
        || limits.idle_shutdown.is_zero()
    {
        Err(HostError::InvalidArguments)
    } else {
        Ok(())
    }
}

fn map_catalog_record(record: terminal_host_core::TerminalRecord) -> SessionRecord {
    SessionRecord {
        runtime_id: record.runtime_id,
        handle: record.handle,
        stream_id: record.stream_id,
        state: map_state(record.state),
        revision: record.revision,
        placement: record.placement,
        presentation: record.presentation,
        exit_behavior: record.exit_behavior,
        workspace_target: record.workspace_target,
        surface_hidden: record.surface_hidden,
        exit_code: record.exit_code,
        child_pid: None,
    }
}

fn map_state(state: TerminalState) -> SessionState {
    match state {
        TerminalState::Creating => SessionState::Creating,
        TerminalState::Running => SessionState::Running,
        TerminalState::Exited => SessionState::Exited,
        TerminalState::Closing => SessionState::Closing,
        TerminalState::Closed => SessionState::Closed,
        TerminalState::Lost => SessionState::Lost,
    }
}

async fn write_unauthorized<S: AsyncWrite + Unpin>(stream: &mut S) -> Result<(), HostError> {
    let response = ResponseEnvelope {
        version: terminal_host_protocol::PROTOCOL_VERSION,
        kind: EnvelopeKind::Response,
        id: 0,
        result: None,
        error: Some(TransportError {
            code: TransportErrorCode::InvalidRequest,
            message: "unauthorized".into(),
            effect: None,
            request_id: None,
            handle: None,
            retryable: false,
        }),
    };
    write_response(stream, &response).await
}
