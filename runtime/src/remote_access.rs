//! Disabled-by-default HTTPS gateway for paired terminal devices.
//!
//! The gateway owns a separate, closed dispatcher. It never forwards a
//! caller-supplied method directly to the local control dispatcher.
use crate::{
    config::RuntimeConfig,
    db::Database,
    devices::{DeviceManager, DevicePermission},
    domain::RpcRequest,
    service::RuntimeService,
};
use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{
    body::Incoming,
    header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE},
    server::conn::http1,
    service::service_fn,
    Method, Request, Response, StatusCode,
};
use hyper_util::rt::TokioIo;
use rcgen::generate_simple_self_signed;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    convert::Infallible,
    fs::{self, OpenOptions},
    io::{BufReader, Write},
    net::{IpAddr, Ipv4Addr, TcpListener as StdTcpListener, UdpSocket},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, RwLock, Weak},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{oneshot, Semaphore},
    task::{JoinHandle, JoinSet},
    time::timeout,
};
use tokio_rustls::{rustls, TlsAcceptor};
use uuid::Uuid;

pub const REMOTE_CERTIFICATE_FILE: &str = "remote-access-cert.pem";
pub const REMOTE_PRIVATE_KEY_FILE: &str = "remote-access-key.pem";
const MAX_REQUEST_BYTES: usize = 128 * 1024;
const MAX_REMOTE_OUTPUT_BYTES: u32 = 256 * 1024;
const MAX_REMOTE_INPUT_BYTES: usize = 64 * 1024;
const MAX_CONNECTIONS: usize = 32;
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_CONNECTION_TIMEOUT: Duration = Duration::from_secs(120);
const REQUEST_BODY_TIMEOUT: Duration = Duration::from_secs(10);
const LISTENER_STOP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessStatus {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    pub tls_fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    // Set only when remote access cannot run because the stored TLS identity
    // is unusable; Devices settings offers an explicit reset for that case.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_error: Option<String>,
}

struct CertificateMaterial {
    config: Arc<rustls::ServerConfig>,
    fingerprint: String,
}

#[derive(Default)]
struct ListenerState {
    enabled: bool,
    generation: u64,
    port: Option<u16>,
    url: Option<String>,
    cancel: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
    running_generation: Option<u64>,
    error: Option<String>,
    identity_error: Option<String>,
}

pub struct RemoteAccess {
    service: Weak<RuntimeService>,
    devices: DeviceManager,
    db: Arc<Database>,
    data_dir: PathBuf,
    // Loaded lazily: the TLS identity is optional and never created while
    // remote access is disabled (F01).
    identity: RwLock<Option<Arc<CertificateMaterial>>>,
    state: Mutex<ListenerState>,
    stopped: Condvar,
    // Remote DB activity takes a read lock. Disable takes the write lock, so a
    // completed disable is also a drain barrier for relocation.
    access_gate: RwLock<()>,
}

impl RemoteAccess {
    pub fn new(
        service: Weak<RuntimeService>,
        db: Arc<Database>,
        config: RuntimeConfig,
    ) -> Result<Arc<Self>> {
        // Read the preference before touching the identity: remote access is
        // optional, so a damaged identity must never block local startup.
        let devices = DeviceManager::new(Arc::clone(&db))?;
        let preference = devices.remote_access_preference()?;
        let this = Arc::new(Self {
            service,
            devices,
            db,
            data_dir: config.data_dir,
            identity: RwLock::new(None),
            state: Mutex::new(ListenerState {
                port: preference.port,
                error: preference.last_error.clone(),
                ..ListenerState::default()
            }),
            stopped: Condvar::new(),
            access_gate: RwLock::new(()),
        });
        if preference.enabled {
            // An unusable identity is recorded as a remote-access error and
            // reported to Settings; it never aborts the runtime.
            this.start_listener()?;
        }
        Ok(this)
    }

    pub fn dispatch(self: &Arc<Self>, method: &str, params: &Value) -> Result<Option<Value>> {
        let result = match method {
            "device.status" => {
                parse::<Empty>(params)?;
                serde_json::to_value(self.status()?)?
            }
            "device.enable" => {
                let request: OperationOnly = parse(params)?;
                if !self.devices.operation_completed(&request.operation_id)? {
                    self.start_listener()?;
                    self.devices
                        .complete_marker(&request.operation_id, "device.enable")?;
                }
                serde_json::to_value(self.status()?)?
            }
            "device.disable" => {
                let request: OperationOnly = parse(params)?;
                if !self.devices.operation_completed(&request.operation_id)? {
                    self.disable()?;
                    self.devices
                        .complete_marker(&request.operation_id, "device.disable")?;
                }
                serde_json::to_value(self.status()?)?
            }
            "device.identity.reset" => {
                let request: OperationOnly = parse(params)?;
                if !self.devices.operation_completed(&request.operation_id)? {
                    self.reset_identity(&request.operation_id)?;
                }
                serde_json::to_value(self.status()?)?
            }
            "device.pairing.create" => {
                let request: CreatePairing = parse(params)?;
                let status = self.status()?;
                let server_url = status
                    .url
                    .as_deref()
                    .ok_or_else(|| anyhow!("remote_access_disabled"))?;
                serde_json::to_value(self.devices.create_pairing(
                    request.permission,
                    &request.operation_id,
                    server_url,
                    &status.tls_fingerprint,
                )?)?
            }
            "device.pairing.cancel" => {
                let request: CancelPairing = parse(params)?;
                self.devices
                    .cancel_pairing(&request.pairing_id, &request.operation_id)?;
                Value::Null
            }
            "device.list" => {
                parse::<Empty>(params)?;
                serde_json::to_value(self.devices.list()?)?
            }
            "device.rename" => {
                let request: RenameDevice = parse(params)?;
                serde_json::to_value(self.devices.rename(
                    &request.device_id,
                    &request.name,
                    &request.operation_id,
                )?)?
            }
            "device.renew" => {
                let request: RenewDevice = parse(params)?;
                serde_json::to_value(
                    self.devices
                        .renew(&request.device_id, &request.operation_id)?,
                )?
            }
            "device.revoke" => {
                let request: RevokeDevice = parse(params)?;
                // Local dispatch already holds the relocation gate, so this
                // preserves the global -> remote lock order. The write lock
                // drains every action authorized before this revoke.
                let _barrier = self
                    .access_gate
                    .write()
                    .map_err(|_| anyhow!("remote access gate poisoned"))?;
                self.devices
                    .revoke(&request.device_id, &request.operation_id)?;
                Value::Null
            }
            _ => return Ok(None),
        };
        Ok(Some(result))
    }

    pub fn status(&self) -> Result<RemoteAccessStatus> {
        let state = self
            .state
            .lock()
            .map_err(|_| anyhow!("remote access state lock poisoned"))?;
        Ok(RemoteAccessStatus {
            enabled: state.enabled,
            url: state.url.clone(),
            port: state.port,
            tls_fingerprint: self.fingerprint(),
            error: state.error.clone(),
            identity_error: state.identity_error.clone(),
        })
    }

    fn fingerprint(&self) -> String {
        // Before the identity is loaded, report the stored certificate without
        // creating or validating one.
        if let Ok(identity) = self.identity.read() {
            if let Some(identity) = identity.as_ref() {
                return identity.fingerprint.clone();
            }
        }
        existing_fingerprint(&self.data_dir).unwrap_or_default()
    }

    // Creates the identity only when remote access is actually starting. A
    // failure is reported through the listener state, never propagated as a
    // startup failure.
    fn identity(&self) -> Result<Arc<CertificateMaterial>> {
        if let Some(identity) = self
            .identity
            .read()
            .map_err(|_| anyhow!("remote access identity lock poisoned"))?
            .as_ref()
        {
            return Ok(Arc::clone(identity));
        }
        let identity = Arc::new(load_or_create_certificate(&self.data_dir)?);
        *self
            .identity
            .write()
            .map_err(|_| anyhow!("remote access identity lock poisoned"))? =
            Some(Arc::clone(&identity));
        Ok(identity)
    }

    pub fn is_enabled(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.enabled)
            .unwrap_or(false)
    }

    fn is_generation_enabled(&self, generation: u64) -> bool {
        self.state
            .lock()
            .map(|state| state.enabled && state.generation == generation)
            .unwrap_or(false)
    }

    pub fn disable(&self) -> Result<()> {
        self.stop_listener(false)
    }

    /// Stops remote access, replaces the TLS identity and revokes every paired
    /// device. Only an explicit user action may do this: already paired
    /// devices pinned the old certificate, so they must pair again.
    fn reset_identity(self: &Arc<Self>, operation_id: &str) -> Result<()> {
        self.stop_listener_inner(None)?;
        {
            // Same lock order as revoke: global relocation -> this gate.
            let _barrier = self
                .access_gate
                .write()
                .map_err(|_| anyhow!("remote access gate poisoned"))?;
            self.devices.revoke_all()?;
            create_certificate_pair(
                &self.data_dir.join(REMOTE_CERTIFICATE_FILE),
                &self.data_dir.join(REMOTE_PRIVATE_KEY_FILE),
            )?;
            let identity = Arc::new(load_certificate(&self.data_dir)?);
            *self
                .identity
                .write()
                .map_err(|_| anyhow!("remote access identity lock poisoned"))? =
                Some(identity);
            let mut state = self
                .state
                .lock()
                .map_err(|_| anyhow!("remote access state lock poisoned"))?;
            state.identity_error = None;
            state.error = None;
        }
        if self.devices.remote_access_preference()?.enabled {
            self.start_listener()?;
        }
        self.devices
            .complete_marker(operation_id, "device.identity.reset")
    }

    /// Stops network activity without changing the persisted user preference.
    pub fn shutdown(&self) {
        let _ = self.stop_listener_inner(None);
    }

    fn start_listener(self: &Arc<Self>) -> Result<()> {
        let _barrier = self
            .access_gate
            .write()
            .map_err(|_| anyhow!("remote access gate poisoned"))?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("remote access state lock poisoned"))?;
        if state.enabled {
            return Ok(());
        }
        let preference = self.devices.remote_access_preference()?;
        let certificate = match self.identity() {
            Ok(certificate) => certificate,
            Err(error) => {
                let reason = format!("{error:#}");
                state.enabled = false;
                state.port = preference.port;
                state.url = None;
                state.error = Some(format!("Remote access unavailable: {reason}"));
                state.identity_error = Some(reason);
                return Ok(());
            }
        };
        state.identity_error = None;
        let requested_port = preference.port.unwrap_or(0);
        let std_listener = match StdTcpListener::bind((Ipv4Addr::UNSPECIFIED, requested_port)) {
            Ok(listener) => listener,
            Err(error) => {
                let message = if requested_port == 0 {
                    format!("Remote HTTPS listener could not start: {error}")
                } else {
                    format!("Remote HTTPS port {requested_port} is unavailable: {error}")
                };
                self.devices.set_remote_access_preference(
                    false,
                    preference.port,
                    Some(&message),
                )?;
                state.enabled = false;
                state.port = preference.port;
                state.url = None;
                state.error = Some(message);
                return Ok(());
            }
        };
        std_listener
            .set_nonblocking(true)
            .context("making remote HTTPS listener nonblocking")?;
        let port = std_listener.local_addr()?.port();
        let ip = lan_ipv4();
        let url = format!("https://{ip}:{port}");
        let listener =
            TcpListener::from_std(std_listener).context("registering remote HTTPS listener")?;
        let (cancel, mut cancelled) = oneshot::channel();
        state.generation = state.generation.wrapping_add(1);
        let generation = state.generation;
        let weak = Arc::downgrade(self);
        let acceptor = TlsAcceptor::from(Arc::clone(&certificate.config));
        let task = tokio::spawn(async move {
            let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
            let mut tasks = JoinSet::new();
            let mut listener_error = None;
            loop {
                let accepted = tokio::select! {
                    _ = &mut cancelled => break,
                    accepted = listener.accept() => accepted,
                    _ = tasks.join_next(), if !tasks.is_empty() => continue,
                };
                let (stream, _peer) = match accepted {
                    Ok(value) => value,
                    Err(error) => {
                        listener_error = Some(format!("Remote HTTPS listener stopped: {error}"));
                        break;
                    }
                };
                let Ok(permit) = Arc::clone(&connections).try_acquire_owned() else {
                    drop(stream);
                    continue;
                };
                let acceptor = acceptor.clone();
                let connection_weak = weak.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    let Ok(Ok(tls)) = timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await else {
                        return;
                    };
                    let request_weak = connection_weak.clone();
                    let service = service_fn(move |request| {
                        let weak = request_weak.clone();
                        async move {
                            let response = match weak.upgrade() {
                                Some(remote) => remote.handle_http(request, generation).await,
                                None => json_response(
                                    StatusCode::SERVICE_UNAVAILABLE,
                                    json!({"error":{"code":"runtime_unavailable","message":"runtime unavailable"}}),
                                ),
                            };
                            Ok::<_, Infallible>(response)
                        }
                    });
                    let connection = http1::Builder::new()
                        .keep_alive(true)
                        .serve_connection(TokioIo::new(tls), service);
                    let _ = timeout(HTTP_CONNECTION_TIMEOUT, connection).await;
                });
            }
            tasks.shutdown().await;
            if let Some(remote) = weak.upgrade() {
                remote.mark_listener_stopped(generation, listener_error);
            }
        });
        self.devices
            .set_remote_access_preference(true, Some(port), None)?;
        state.enabled = true;
        state.port = Some(port);
        state.url = Some(url);
        state.error = None;
        state.cancel = Some(cancel);
        state.task = Some(task);
        state.running_generation = Some(generation);
        Ok(())
    }

    fn stop_listener(&self, persist_disabled: bool) -> Result<()> {
        self.stop_listener_inner(Some(persist_disabled))
    }

    fn stop_listener_inner(&self, persist_disabled: Option<bool>) -> Result<()> {
        let generation = {
            let _barrier = self
                .access_gate
                .write()
                .map_err(|_| anyhow!("remote access gate poisoned"))?;
            let mut state = self
                .state
                .lock()
                .map_err(|_| anyhow!("remote access state lock poisoned"))?;
            if persist_disabled == Some(false) {
                self.devices
                    .set_remote_access_preference(false, state.port, None)?;
                state.error = None;
            }
            state.enabled = false;
            state.url = None;
            if let Some(cancel) = state.cancel.take() {
                let _ = cancel.send(());
            }
            state.running_generation
        };
        if let Some(generation) = generation {
            let state = self
                .state
                .lock()
                .map_err(|_| anyhow!("remote access state lock poisoned"))?;
            let (mut state, timed_out) = self
                .stopped
                .wait_timeout_while(state, LISTENER_STOP_TIMEOUT, |state| {
                    state.running_generation == Some(generation)
                })
                .map_err(|_| anyhow!("remote access state lock poisoned"))?;
            if timed_out.timed_out() && state.running_generation == Some(generation) {
                if let Some(task) = state.task.as_ref() {
                    task.abort();
                }
                state.running_generation = None;
            }
            state.task.take();
        }
        Ok(())
    }

    fn mark_listener_stopped(&self, generation: u64, listener_error: Option<String>) {
        if let Ok(mut state) = self.state.lock() {
            if state.generation == generation {
                state.enabled = false;
                state.url = None;
                state.cancel = None;
                state.running_generation = None;
                if listener_error.is_some() {
                    state.error = listener_error;
                }
                self.stopped.notify_all();
            }
        }
    }

    async fn handle_http(
        self: Arc<Self>,
        request: Request<Incoming>,
        listener_generation: u64,
    ) -> Response<Full<Bytes>> {
        if request.method() != Method::POST {
            return error_response(
                StatusCode::METHOD_NOT_ALLOWED,
                "method_not_allowed",
                "POST required",
            );
        }
        let path = request.uri().path().to_owned();
        if path != "/v1/pair" && path != "/v1/rpc" {
            return error_response(StatusCode::NOT_FOUND, "not_found", "endpoint not found");
        }
        let authorization = request
            .headers()
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = match timeout(
            REQUEST_BODY_TIMEOUT,
            read_body_limited(request.into_body(), MAX_REQUEST_BYTES),
        )
        .await
        {
            Ok(Ok(body)) => body,
            Ok(Err(error)) => return error.into_response(),
            Err(_) => {
                return error_response(
                    StatusCode::REQUEST_TIMEOUT,
                    "request_timeout",
                    "request body timed out",
                )
            }
        };
        let remote = Arc::clone(&self);
        let Some(runtime) = self.service.upgrade() else {
            return HttpFailure::server("runtime unavailable").into_response();
        };
        match tokio::task::spawn_blocking(move || {
            match runtime.with_remote_gate(|| {
                let result = (|| {
                    let _active = remote
                        .access_gate
                        .read()
                        .map_err(|_| HttpFailure::server("remote access gate poisoned"))?;
                    if !remote.is_generation_enabled(listener_generation) {
                        return Err(HttpFailure::new(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "remote_access_disabled",
                            "remote access is disabled",
                        ));
                    }
                    if path == "/v1/pair" {
                        remote.handle_pair(&body)
                    } else {
                        remote.handle_rpc(authorization.as_deref(), &body)
                    }
                })();
                Ok::<_, crate::domain::RpcError>(result)
            }) {
                Ok(result) => result,
                Err(error) => Err(HttpFailure::from_rpc(error)),
            }
        })
        .await
        {
            Ok(Ok(value)) => json_response(StatusCode::OK, value),
            Ok(Err(error)) => error.into_response(),
            Err(_) => HttpFailure::server("remote request task failed").into_response(),
        }
    }

    fn handle_pair(&self, body: &[u8]) -> std::result::Result<Value, HttpFailure> {
        let request: PairRequest = parse_body(body)?;
        self.devices
            .pair(&request.pairing_id, &request.code, &request.device_name)
            .map(|result| serde_json::to_value(result).expect("pairing result serializes"))
            .map_err(|error| {
                let message = error.to_string();
                if message == "invalid_device_name" {
                    HttpFailure::bad_request(&message)
                } else {
                    HttpFailure::new(
                        StatusCode::UNAUTHORIZED,
                        "invalid_pairing",
                        "pairing failed",
                    )
                }
            })
    }

    fn handle_rpc(
        &self,
        authorization: Option<&str>,
        body: &[u8],
    ) -> std::result::Result<Value, HttpFailure> {
        let token = authorization
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|value| !value.is_empty())
            .ok_or_else(HttpFailure::unauthorized)?;
        let device = self
            .devices
            .authenticate(token)
            .map_err(|_| HttpFailure::unauthorized())?;
        let request: RemoteRpcRequest = parse_body(body)?;
        let result = self.dispatch_remote(&device.id, device.permission, request)?;
        Ok(json!({"result":result}))
    }

    fn dispatch_remote(
        &self,
        device_id: &str,
        permission: DevicePermission,
        request: RemoteRpcRequest,
    ) -> std::result::Result<Value, HttpFailure> {
        let principal = format!("device:{device_id}");
        let (method, params) = match request.method.as_str() {
            "remote.sessions" => {
                parse::<Empty>(&request.params).map_err(HttpFailure::from_anyhow)?;
                let snapshot = self.db.snapshot().map_err(HttpFailure::from_anyhow)?;
                let sessions = snapshot
                    .sessions
                    .into_iter()
                    .filter(|session| session.mode == "terminal")
                    .map(|session| {
                        let mut value = json!({
                            "id":session.id,
                            "title":session.title,
                            "provider":session.provider,
                            "status":session.status,
                            "createdAt":session.created_at,
                            "updatedAt":session.updated_at,
                        });
                        if let Some(project_id) = session.project_id {
                            value["projectId"] = json!(project_id);
                        }
                        value
                    })
                    .collect::<Vec<_>>();
                return Ok(Value::Array(sessions));
            }
            "terminal.read" => {
                let value: RemoteTerminalRead =
                    parse(&request.params).map_err(HttpFailure::from_anyhow)?;
                self.require_terminal_session(&value.session_id)?;
                let limit = value
                    .limit
                    .unwrap_or(64 * 1024)
                    .min(MAX_REMOTE_OUTPUT_BYTES);
                (
                    "terminal.read",
                    json!({"sessionId":value.session_id,"cursor":value.cursor,"limit":limit}),
                )
            }
            _ if permission == DevicePermission::Readonly => {
                return Err(HttpFailure::forbidden());
            }
            "session.create" => {
                let value: RemoteSessionCreate =
                    parse(&request.params).map_err(HttpFailure::from_anyhow)?;
                if !matches!(
                    value.provider.as_str(),
                    "codex" | "claude" | "kimi" | "gemini" | "opencode" | "shell"
                ) {
                    return Err(HttpFailure::bad_request("invalid terminal provider"));
                }
                if value.operation_id.is_empty()
                    || value
                        .title
                        .as_deref()
                        .is_some_and(|title| title.chars().count() > 120)
                {
                    return Err(HttpFailure::bad_request("invalid session request"));
                }
                let project = self
                    .db
                    .snapshot()
                    .map_err(HttpFailure::from_anyhow)?
                    .projects
                    .into_iter()
                    .find(|project| project.id == value.project_id)
                    .ok_or_else(|| HttpFailure::bad_request("project not found"))?;
                (
                    "session.create",
                    json!({
                        "projectId":project.id,
                        "cwd":project.path,
                        "title":value.title,
                        "provider":value.provider,
                        "mode":"terminal",
                        "operationId":value.operation_id,
                    }),
                )
            }
            "session.stop" => {
                let value: RemoteSessionStop =
                    parse(&request.params).map_err(HttpFailure::from_anyhow)?;
                self.require_terminal_session(&value.session_id)?;
                (
                    "session.stop",
                    serde_json::to_value(value).expect("remote stop serializes"),
                )
            }
            "session.claim" => {
                let value: SessionIdentity =
                    parse(&request.params).map_err(HttpFailure::from_anyhow)?;
                self.require_terminal_session(&value.session_id)?;
                ("session.claim", json!({"sessionId":value.session_id}))
            }
            "session.renew" | "session.release" => {
                let value: RemoteLease =
                    parse(&request.params).map_err(HttpFailure::from_anyhow)?;
                self.require_terminal_session(&value.session_id)?;
                (
                    request.method.as_str(),
                    serde_json::to_value(value).expect("remote lease serializes"),
                )
            }
            "terminal.input" => {
                let value: RemoteInput =
                    parse(&request.params).map_err(HttpFailure::from_anyhow)?;
                self.require_terminal_session(&value.session_id)?;
                if value.data.len() > MAX_REMOTE_INPUT_BYTES {
                    return Err(HttpFailure::bad_request("terminal input is too large"));
                }
                (
                    "terminal.input",
                    serde_json::to_value(value).expect("remote input serializes"),
                )
            }
            "terminal.resize" => {
                let value: RemoteResize =
                    parse(&request.params).map_err(HttpFailure::from_anyhow)?;
                self.require_terminal_session(&value.session_id)?;
                if value.cols == 0 || value.rows == 0 || value.cols > 500 || value.rows > 500 {
                    return Err(HttpFailure::bad_request("invalid terminal size"));
                }
                (
                    "terminal.resize",
                    serde_json::to_value(value).expect("remote resize serializes"),
                )
            }
            _ => return Err(HttpFailure::forbidden()),
        };
        let service = self
            .service
            .upgrade()
            .ok_or_else(|| HttpFailure::server("runtime unavailable"))?;
        service
            .dispatch_under_gate(
                &principal,
                RpcRequest {
                    v: 1,
                    id: Uuid::new_v4().to_string(),
                    method: method.to_owned(),
                    params,
                },
            )
            .map_err(|error| {
                let status = match error.code.as_str() {
                    "lease_held" | "stale_lease" | "operation_conflict" => StatusCode::CONFLICT,
                    _ => StatusCode::BAD_REQUEST,
                };
                HttpFailure::new(status, &error.code, &error.message)
            })
    }

    fn require_terminal_session(&self, session_id: &str) -> std::result::Result<(), HttpFailure> {
        if session_id.is_empty() || session_id.len() > 128 {
            return Err(HttpFailure::bad_request("invalid session id"));
        }
        let session = self
            .db
            .session_by_id(session_id)
            .map_err(HttpFailure::from_anyhow)?
            .ok_or_else(|| HttpFailure::bad_request("session not found"))?;
        if session.mode != "terminal" {
            return Err(HttpFailure::forbidden());
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperationOnly {
    operation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreatePairing {
    permission: DevicePermission,
    operation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelPairing {
    pairing_id: String,
    operation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenameDevice {
    device_id: String,
    name: String,
    operation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenewDevice {
    device_id: String,
    operation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RevokeDevice {
    device_id: String,
    operation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairRequest {
    pairing_id: String,
    code: String,
    device_name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteRpcRequest {
    method: String,
    #[serde(default = "empty_object")]
    params: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteTerminalRead {
    session_id: String,
    cursor: Option<i64>,
    limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteSessionCreate {
    project_id: String,
    title: Option<String>,
    provider: String,
    operation_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteSessionStop {
    session_id: String,
    operation_id: String,
    #[serde(default)]
    force: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionIdentity {
    session_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteLease {
    session_id: String,
    lease_epoch: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteInput {
    session_id: String,
    data: String,
    lease_epoch: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteResize {
    session_id: String,
    cols: u16,
    rows: u16,
    lease_epoch: i64,
}

fn parse<T: DeserializeOwned>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone()).map_err(Into::into)
}

fn parse_body<T: DeserializeOwned>(body: &[u8]) -> std::result::Result<T, HttpFailure> {
    serde_json::from_slice(body).map_err(|_| HttpFailure::bad_request("invalid JSON body"))
}

fn empty_object() -> Value {
    json!({})
}

async fn read_body_limited(
    mut body: Incoming,
    limit: usize,
) -> std::result::Result<Vec<u8>, HttpFailure> {
    let mut output = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| HttpFailure::bad_request("could not read request body"))?;
        if let Some(data) = frame.data_ref() {
            if output.len().saturating_add(data.len()) > limit {
                return Err(HttpFailure::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "request_too_large",
                    "request body is too large",
                ));
            }
            output.extend_from_slice(data);
        }
    }
    Ok(output)
}

#[derive(Debug)]
struct HttpFailure {
    status: StatusCode,
    code: String,
    message: String,
}

impl HttpFailure {
    fn new(status: StatusCode, code: &str, message: &str) -> Self {
        Self {
            status,
            code: code.to_owned(),
            message: message.to_owned(),
        }
    }
    fn bad_request(message: &str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", message)
    }
    fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "invalid device token",
        )
    }
    fn forbidden() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "method is not permitted",
        )
    }
    fn server(message: &str) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "runtime_error", message)
    }
    fn from_anyhow(error: anyhow::Error) -> Self {
        Self::bad_request(&error.to_string())
    }
    fn from_rpc(error: crate::domain::RpcError) -> Self {
        let status = match error.code.as_str() {
            "runtime_stopping" => StatusCode::SERVICE_UNAVAILABLE,
            "relocation_pending" => StatusCode::CONFLICT,
            _ => StatusCode::BAD_REQUEST,
        };
        Self::new(status, &error.code, &error.message)
    }
    fn into_response(self) -> Response<Full<Bytes>> {
        error_response(self.status, &self.code, &self.message)
    }
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response<Full<Bytes>> {
    json_response(status, json!({"error":{"code":code,"message":message}}))
}

fn json_response(status: StatusCode, value: Value) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(
        serde_json::to_vec(&value)
            .unwrap_or_else(|_| b"{\"error\":{\"code\":\"serialization_error\"}}".to_vec()),
    )));
    *response.status_mut() = status;
    response.headers_mut().insert(
        CONTENT_TYPE,
        "application/json; charset=utf-8"
            .parse()
            .expect("static header"),
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, "no-store".parse().expect("static header"));
    response
}

fn load_or_create_certificate(data_dir: &Path) -> Result<CertificateMaterial> {
    let certificate_path = data_dir.join(REMOTE_CERTIFICATE_FILE);
    let key_path = data_dir.join(REMOTE_PRIVATE_KEY_FILE);
    // Only a completely fresh store creates an identity. A half pair or an
    // unreadable file is reported instead of silently re-keying the store,
    // because paired devices pinned the existing certificate.
    if !certificate_path.exists() && !key_path.exists() {
        create_certificate_pair(&certificate_path, &key_path)?;
    }
    load_certificate(data_dir)
}

fn load_certificate(data_dir: &Path) -> Result<CertificateMaterial> {
    let certificate_path = data_dir.join(REMOTE_CERTIFICATE_FILE);
    let key_path = data_dir.join(REMOTE_PRIVATE_KEY_FILE);
    match (certificate_path.exists(), key_path.exists()) {
        (true, true) => {}
        (true, false) => bail!(
            "remote TLS certificate/key pair is incomplete: {REMOTE_PRIVATE_KEY_FILE} is missing"
        ),
        (false, true) => bail!(
            "remote TLS certificate/key pair is incomplete: {REMOTE_CERTIFICATE_FILE} is missing"
        ),
        (false, false) => bail!("remote TLS certificate/key pair is missing"),
    }
    #[cfg(windows)]
    crate::windows_security::restrict_file_to_current_user(&key_path)?;
    #[cfg(unix)]
    restrict_private_file(&key_path)?;

    let certificate_pem = fs::read(&certificate_path)
        .with_context(|| format!("reading {}", certificate_path.display()))?;
    let key_pem = fs::read(&key_path).with_context(|| format!("reading {}", key_path.display()))?;
    let mut certificate_reader = BufReader::new(certificate_pem.as_slice());
    let certificates = rustls_pemfile::certs(&mut certificate_reader)
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| format!("reading {}", certificate_path.display()))?;
    let fingerprint = fingerprint(
        certificates
            .first()
            .ok_or_else(|| anyhow!("remote TLS certificate is empty"))?
            .as_ref(),
    );
    let mut key_reader = BufReader::new(key_pem.as_slice());
    let key = rustls_pemfile::private_key(&mut key_reader)
        .with_context(|| format!("reading {}", key_path.display()))?
        .ok_or_else(|| anyhow!("remote TLS private key is empty"))?;
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certificates, key)
        .context("loading remote TLS identity")?;
    Ok(CertificateMaterial {
        config: Arc::new(config),
        fingerprint,
    })
}

/// Fingerprint of the identity already on disk, without creating one.
fn existing_fingerprint(data_dir: &Path) -> Result<String> {
    let pem = fs::read(data_dir.join(REMOTE_CERTIFICATE_FILE))?;
    let mut reader = BufReader::new(pem.as_slice());
    let certificates = rustls_pemfile::certs(&mut reader)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(certificates
        .first()
        .map(|certificate| fingerprint(certificate.as_ref()))
        .unwrap_or_default())
}

// Both files are written and restricted before either is installed, so an
// interrupted reset leaves the previous pair or an explicit identity error,
// never a silently generated replacement.
fn create_certificate_pair(certificate_path: &Path, key_path: &Path) -> Result<()> {
    let certified = generate_simple_self_signed(certificate_names())?;
    let certificate_pem = certified.cert.pem();
    let key_pem = certified.key_pair.serialize_pem();
    let certificate_temp = temporary_sibling(certificate_path);
    let key_temp = temporary_sibling(key_path);
    let install = || -> Result<()> {
        write_new(&key_temp, key_pem.as_bytes())?;
        #[cfg(windows)]
        crate::windows_security::restrict_file_to_current_user(&key_temp)?;
        #[cfg(unix)]
        restrict_private_file(&key_temp)?;
        write_new(&certificate_temp, certificate_pem.as_bytes())?;
        // Key first: until the certificate lands, a crash leaves a mismatch
        // that reports "could not load remote TLS identity" instead of a key
        // that silently belongs to another certificate.
        fs::rename(&key_temp, key_path).context("installing remote TLS private key")?;
        fs::rename(&certificate_temp, certificate_path)
            .context("installing remote TLS certificate")
    };
    let result = install();
    if result.is_err() {
        let _ = fs::remove_file(&key_temp);
        let _ = fs::remove_file(&certificate_temp);
    }
    result
}

fn write_new(path: &Path, value: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(value)?;
    file.sync_all()?;
    Ok(())
}

fn temporary_sibling(path: &Path) -> PathBuf {
    path.with_extension(format!("tmp-{}", Uuid::new_v4()))
}

#[cfg(unix)]
fn restrict_private_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn lan_ipv4() -> IpAddr {
    if let Ok(interfaces) = local_ip_address::list_afinet_netifas() {
        if let Some(ip) = interfaces
            .iter()
            .map(|(_, ip)| *ip)
            .find(|ip| matches!(ip, IpAddr::V4(value) if value.is_private() && !value.is_loopback()))
            .or_else(|| {
                interfaces
                    .iter()
                    .map(|(_, ip)| *ip)
                    .find(|ip| matches!(ip, IpAddr::V4(value) if !value.is_loopback() && !value.is_unspecified()))
            })
        {
            return ip;
        }
    }
    UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|socket| {
            socket.connect((Ipv4Addr::new(192, 0, 2, 1), 80))?;
            socket.local_addr()
        })
        .map(|address| address.ip())
        .ok()
        .filter(|ip| ip.is_ipv4() && !ip.is_unspecified())
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST))
}

fn certificate_names() -> Vec<String> {
    let mut names = vec!["localhost".to_owned(), Ipv4Addr::LOCALHOST.to_string()];
    if let Ok(interfaces) = local_ip_address::list_afinet_netifas() {
        for (_, ip) in interfaces {
            if matches!(ip, IpAddr::V4(value) if !value.is_unspecified()) {
                let value = ip.to_string();
                if !names.contains(&value) {
                    names.push(value);
                }
            }
        }
    }
    let selected = lan_ipv4().to_string();
    if !names.contains(&selected) {
        names.push(selected);
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db::CreateSession, domain::RpcRequest};
    use base64::Engine;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use tempfile::tempdir;

    #[test]
    fn remote_allowlist_redacts_paths_and_denies_readonly_control() {
        let directory = tempdir().unwrap();
        let db = Arc::new(Database::open(&directory.path().join("runtime.sqlite3")).unwrap());
        let project = db
            .add_project(
                directory.path().to_str().unwrap(),
                Some("Project"),
                "add-project",
            )
            .unwrap();
        let session = db
            .create_session(CreateSession {
                project_id: Some(&project.id),
                title: Some("Terminal"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "create-session",
            })
            .unwrap();
        let remote = test_remote(Arc::clone(&db), directory.path());
        let sessions = remote
            .dispatch_remote(
                "d",
                DevicePermission::Readonly,
                RemoteRpcRequest {
                    method: "remote.sessions".into(),
                    params: json!({}),
                },
            )
            .unwrap();
        let encoded = serde_json::to_string(&sessions).unwrap();
        assert!(!encoded.contains(directory.path().to_str().unwrap()));
        assert!(remote
            .dispatch_remote(
                "d",
                DevicePermission::Readonly,
                RemoteRpcRequest {
                    method: "terminal.input".into(),
                    params: json!({"sessionId":session.id,"data":"x","leaseEpoch":1})
                }
            )
            .is_err());
        assert!(remote.dispatch_remote("d", DevicePermission::Readonly, RemoteRpcRequest { method: "session.create".into(), params: json!({"projectId":project.id,"provider":"shell","operationId":"remote-create"}) }).is_err());
        for denied in [
            "runtime.shutdown",
            "settings.update",
            "plugin.list",
            "plugin.setEnabled",
            "plugin.reload",
            "filesystem.resolve",
            "filesystem.read",
            "git.status",
            "git.index.write",
            "git.discard",
            "git.log",
            "filesystem.delete",
            "filesystem.search",
            "review.list",
            "review.revert",
            "chat.read",
            "chat.subagent.read",
            "chat.approve",
            "chat.answer",
            "group.prerequisites",
            "group.create",
            "group.list",
            "group.read",
            "group.send",
            "group.stop",
            "group.resend",
            "group.member.add",
            "group.member.update",
            "group.member.remove",
            "group.rename",
            "group.archive",
            "history.list",
            "device.identity.reset",
            "device.list",
            "device.pairing.cancel",
            "device.rename",
            "device.renew",
        ] {
            assert!(
                remote
                    .dispatch_remote(
                        "d",
                        DevicePermission::Fullcontrol,
                        RemoteRpcRequest {
                            method: denied.into(),
                            params: json!({})
                        }
                    )
                    .is_err(),
                "{denied} must be denied"
            );
        }
    }

    #[test]
    fn revoke_waits_for_authorized_actions_and_fences_the_token() {
        let directory = tempdir().unwrap();
        let db = Arc::new(Database::open(&directory.path().join("runtime.sqlite3")).unwrap());
        let remote = test_remote(db, directory.path());
        let offer = remote
            .devices
            .create_pairing(
                DevicePermission::Fullcontrol,
                "concurrent-pair",
                "https://localhost:1",
                "AA",
            )
            .unwrap();
        let paired = remote
            .devices
            .pair(&offer.id, &offer.code, "Controller")
            .unwrap();
        let mutation_finished = Arc::new(AtomicBool::new(false));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let action_remote = Arc::clone(&remote);
        let action_finished = Arc::clone(&mutation_finished);
        let action = std::thread::spawn(move || {
            let _active = action_remote.access_gate.read().unwrap();
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            action_finished.store(true, Ordering::Release);
        });
        entered_rx.recv().unwrap();

        let revoke_remote = Arc::clone(&remote);
        let device_id = paired.device.id.clone();
        let (revoked_tx, revoked_rx) = mpsc::channel();
        let revoke = std::thread::spawn(move || {
            revoke_remote
                .dispatch(
                    "device.revoke",
                    &json!({"deviceId":device_id,"operationId":"concurrent-revoke"}),
                )
                .unwrap();
            revoked_tx.send(()).unwrap();
        });
        assert!(revoked_rx.recv_timeout(Duration::from_millis(50)).is_err());
        release_tx.send(()).unwrap();
        action.join().unwrap();
        revoked_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        revoke.join().unwrap();
        assert!(mutation_finished.load(Ordering::Acquire));
        assert!(remote.devices.authenticate(&paired.token).is_err());
    }

    #[test]
    fn requests_from_an_old_listener_generation_stay_disabled_after_reenable() {
        let directory = tempdir().unwrap();
        let db = Arc::new(Database::open(&directory.path().join("runtime.sqlite3")).unwrap());
        let remote = test_remote(db, directory.path());
        {
            let mut state = remote.state.lock().unwrap();
            state.enabled = true;
            state.generation = 2;
        }
        assert!(!remote.is_generation_enabled(1));
        assert!(remote.is_generation_enabled(2));
    }

    fn test_remote(db: Arc<Database>, data_dir: &Path) -> Arc<RemoteAccess> {
        Arc::new(RemoteAccess {
            service: Weak::new(),
            devices: DeviceManager::new(Arc::clone(&db)).unwrap(),
            db,
            data_dir: data_dir.to_owned(),
            identity: RwLock::new(Some(Arc::new(
                load_or_create_certificate(data_dir).unwrap(),
            ))),
            state: Mutex::new(ListenerState::default()),
            stopped: Condvar::new(),
            access_gate: RwLock::new(()),
        })
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn pinned_https_pair_permissions_terminal_lease_and_revoke() {
        let directory = tempdir().unwrap();
        let config = RuntimeConfig {
            data_dir: directory.path().to_owned(),
            database_path: directory.path().join("runtime.sqlite3"),
            credential_path: directory.path().join("runtime.credential"),
            pipe_base: r"\\.\pipe\threadterm-v3-remote-test".into(),
        };
        let db = Arc::new(Database::open(&config.database_path).unwrap());
        crate::workspace_services::initialize(&db).unwrap();
        crate::settings_services::initialize(&db).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        let project = db
            .add_project(
                directory.path().to_str().unwrap(),
                Some("Remote project"),
                "test-project",
            )
            .unwrap();
        let readable = db
            .create_session(CreateSession {
                project_id: Some(&project.id),
                title: Some("Existing terminal"),
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "existing-terminal",
            })
            .unwrap();
        let service = Arc::new(RuntimeService::new(config.clone(), Arc::clone(&db)));
        service.initialize_remote().unwrap();

        let enabled = local(
            &service,
            "device.enable",
            json!({"operationId":"enable-remote"}),
        );
        assert_eq!(enabled["enabled"], true);
        let port = enabled["port"].as_u64().unwrap() as u16;
        let base = format!("https://localhost:{port}");
        let certificate = reqwest::Certificate::from_pem(
            &fs::read(directory.path().join(REMOTE_CERTIFICATE_FILE)).unwrap(),
        )
        .unwrap();
        let client = reqwest::Client::builder()
            .add_root_certificate(certificate)
            .https_only(true)
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();

        let readonly_offer = local(
            &service,
            "device.pairing.create",
            json!({"permission":"readonly","operationId":"pair-readonly"}),
        );
        assert_eq!(readonly_offer["tlsFingerprint"], enabled["tlsFingerprint"]);
        let readonly = pair_over_https(&client, &base, &readonly_offer, "Reader").await;
        let readonly_token = readonly["token"].as_str().unwrap();
        let (status, sessions) =
            rpc_over_https(&client, &base, readonly_token, "remote.sessions", json!({})).await;
        assert_eq!(status, 200, "{sessions}");
        assert!(sessions["result"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value["id"] == readable.id));
        let (status, output) = rpc_over_https(
            &client,
            &base,
            readonly_token,
            "terminal.read",
            json!({"sessionId":readable.id,"cursor":0,"limit":1024}),
        )
        .await;
        assert_eq!(status, 200, "{output}");
        for (method, params) in [
            (
                "terminal.input",
                json!({"sessionId":readable.id,"data":"whoami\r\n","leaseEpoch":1}),
            ),
            (
                "session.create",
                json!({"projectId":project.id,"provider":"shell","operationId":"readonly-create"}),
            ),
        ] {
            let (status, body) =
                rpc_over_https(&client, &base, readonly_token, method, params).await;
            assert_eq!(status, 403, "{method}: {body}");
        }

        let cancelled_offer = local(
            &service,
            "device.pairing.create",
            json!({"permission":"readonly","operationId":"pair-cancelled"}),
        );
        local(
            &service,
            "device.pairing.cancel",
            json!({"pairingId":cancelled_offer["id"],"operationId":"cancel-pairing"}),
        );
        let cancelled_response = client
            .post(format!("{base}/v1/pair"))
            .json(&json!({"pairingId":cancelled_offer["id"],"code":cancelled_offer["code"],"deviceName":"Cancelled"}))
            .send()
            .await
            .unwrap();
        assert_eq!(cancelled_response.status(), StatusCode::UNAUTHORIZED);

        let full_offer = local(
            &service,
            "device.pairing.create",
            json!({"permission":"fullcontrol","operationId":"pair-full"}),
        );
        let full = pair_over_https(&client, &base, &full_offer, "Controller").await;
        let full_token = full["token"].as_str().unwrap();
        let device_id = full["device"]["id"].as_str().unwrap();
        let renamed = local(
            &service,
            "device.rename",
            json!({"deviceId":device_id,"name":"  Desk controller  ","operationId":"rename-full"}),
        );
        assert_eq!(renamed["name"], "Desk controller");
        assert_eq!(
            local(
                &service,
                "device.rename",
                json!({"deviceId":device_id,"name":"  Desk controller  ","operationId":"rename-full"}),
            ),
            renamed
        );
        let conflicting_rename = service
            .dispatch(
                "remote-integration-test",
                RpcRequest {
                    v: 1,
                    id: Uuid::new_v4().to_string(),
                    method: "device.rename".into(),
                    params: json!({"deviceId":device_id,"name":"Different","operationId":"rename-full"}),
                },
            )
            .unwrap_err();
        assert_eq!(conflicting_rename.code, "operation_conflict");
        let renewed = local(
            &service,
            "device.renew",
            json!({"deviceId":device_id,"operationId":"renew-full"}),
        );
        assert_eq!(renewed["id"], device_id);
        assert!(renewed.get("token").is_none());
        assert!(
            renewed["expiresAt"].as_str().unwrap() >= full["device"]["expiresAt"].as_str().unwrap()
        );
        for (method, params) in [
            (
                "device.pairing.cancel",
                json!({"pairingId":full_offer["id"],"operationId":"remote-cancel"}),
            ),
            (
                "device.rename",
                json!({"deviceId":device_id,"name":"Remote rename","operationId":"remote-rename"}),
            ),
            (
                "device.renew",
                json!({"deviceId":device_id,"operationId":"remote-renew"}),
            ),
        ] {
            let (status, body) = rpc_over_https(&client, &base, full_token, method, params).await;
            assert_eq!(status, 403, "{method}: {body}");
        }
        let (status, created) = rpc_over_https(
            &client,
            &base,
            full_token,
            "session.create",
            json!({"projectId":project.id,"provider":"shell","title":"Remote shell","operationId":"full-create"}),
        )
        .await;
        assert_eq!(status, 200, "{created}");
        let session_id = created["result"]["id"].as_str().unwrap();
        let (status, claimed) = rpc_over_https(
            &client,
            &base,
            full_token,
            "session.claim",
            json!({"sessionId":session_id}),
        )
        .await;
        assert_eq!(status, 200, "{claimed}");
        let lease_epoch = claimed["result"]["leaseEpoch"].as_i64().unwrap();
        let (status, input) = rpc_over_https(
            &client,
            &base,
            full_token,
            "terminal.input",
            json!({"sessionId":session_id,"data":"echo REMOTE_TLS_OK\r\n","leaseEpoch":lease_epoch}),
        )
        .await;
        assert_eq!(status, 200, "{input}");

        let mut observed = false;
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let (status, output) = rpc_over_https(
                &client,
                &base,
                full_token,
                "terminal.read",
                json!({"sessionId":session_id,"cursor":0,"limit":65536}),
            )
            .await;
            assert_eq!(status, 200, "{output}");
            let encoded = output["result"]["data"].as_str().unwrap();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap();
            if String::from_utf8_lossy(&bytes).contains("REMOTE_TLS_OK") {
                observed = true;
                break;
            }
        }
        assert!(observed, "real PTY output was not returned over HTTPS");

        let (status, renewed) = rpc_over_https(
            &client,
            &base,
            full_token,
            "session.renew",
            json!({"sessionId":session_id,"leaseEpoch":lease_epoch}),
        )
        .await;
        assert_eq!(status, 200, "{renewed}");
        let (status, exited) = rpc_over_https(
            &client,
            &base,
            full_token,
            "terminal.input",
            json!({"sessionId":session_id,"data":"exit\r\n","leaseEpoch":lease_epoch}),
        )
        .await;
        assert_eq!(status, 200, "{exited}");
        let (status, released) = rpc_over_https(
            &client,
            &base,
            full_token,
            "session.release",
            json!({"sessionId":session_id,"leaseEpoch":lease_epoch}),
        )
        .await;
        assert_eq!(status, 200, "{released}");

        local(
            &service,
            "device.revoke",
            json!({"deviceId":device_id,"operationId":"revoke-full"}),
        );
        let (status, revoked) =
            rpc_over_https(&client, &base, full_token, "remote.sessions", json!({})).await;
        assert_eq!(status, 401, "{revoked}");

        local(
            &service,
            "device.disable",
            json!({"operationId":"disable-remote"}),
        );
        let reenabled = local(
            &service,
            "device.enable",
            json!({"operationId":"reenable-remote"}),
        );
        assert_eq!(reenabled["port"].as_u64(), Some(port as u64));
        local(
            &service,
            "device.disable",
            json!({"operationId":"final-disable"}),
        );
        service.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn occupied_persisted_port_disables_remote_without_failing_runtime() {
        let directory = tempdir().unwrap();
        let occupied = StdTcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
        let port = occupied.local_addr().unwrap().port();
        let config = RuntimeConfig {
            data_dir: directory.path().to_owned(),
            database_path: directory.path().join("runtime.sqlite3"),
            credential_path: directory.path().join("runtime.credential"),
            pipe_base: r"\\.\pipe\threadterm-v3-port-test".into(),
        };
        let db = Arc::new(Database::open(&config.database_path).unwrap());
        crate::workspace_services::initialize(&db).unwrap();
        crate::settings_services::initialize(&db).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        DeviceManager::new(Arc::clone(&db))
            .unwrap()
            .set_remote_access_preference(true, Some(port), None)
            .unwrap();
        let service = Arc::new(RuntimeService::new(config, db));
        service.initialize_remote().unwrap();
        let status = local(&service, "device.status", json!({}));
        assert_eq!(status["enabled"], false);
        assert_eq!(status["port"], port);
        assert!(status["error"].as_str().unwrap().contains("unavailable"));
        assert_eq!(
            local(&service, "runtime.health", json!({}))["version"],
            crate::RUNTIME_VERSION
        );
        service.shutdown();
    }

    // F01: an optional remote identity must never stop local work. Each case
    // plants the damage before the runtime opens the store.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn remote_identity_failures_do_not_block_startup() {
        for case in ["missing half pair", "corrupt pem", "unreadable key"] {
            for enabled in [false, true] {
                let directory = tempdir().unwrap();
                plant_broken_identity(directory.path(), case);
                let service = broken_identity_service(&directory, case, enabled);
                let status = local(&service, "device.status", json!({}));
                assert_eq!(status["enabled"], false, "{case} (enabled preference {enabled})");
                if enabled {
                    assert!(
                        status["error"]
                            .as_str()
                            .unwrap()
                            .contains("Remote access unavailable"),
                        "{case}: {status}"
                    );
                    assert!(status["identityError"].is_string(), "{case}: {status}");
                } else {
                    // A disabled remote access never reads or reports the identity.
                    assert!(status.get("error").is_none(), "{case}: {status}");
                    let enabled_status = local(
                        &service,
                        "device.enable",
                        json!({"operationId":format!("enable-{case}-{enabled}")}),
                    );
                    assert_eq!(enabled_status["enabled"], false, "{case}");
                    assert!(
                        enabled_status["error"]
                            .as_str()
                            .unwrap()
                            .contains("Remote access unavailable"),
                        "{case}: {enabled_status}"
                    );
                    assert!(
                        enabled_status["identityError"].is_string(),
                        "{case}: {enabled_status}"
                    );
                }
                assert_local_work(&service, directory.path(), &format!("broken-{case}-{enabled}"));
                service.shutdown();
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn identity_reset_requires_an_explicit_action_and_invalidates_pairings() {
        let directory = tempdir().unwrap();
        let service = broken_identity_service(&directory, "identity-reset", false);
        // Remote disabled: nothing is created until it is enabled.
        assert!(!directory.path().join(REMOTE_CERTIFICATE_FILE).exists());
        assert!(!directory.path().join(REMOTE_PRIVATE_KEY_FILE).exists());
        let enabled = local(
            &service,
            "device.enable",
            json!({"operationId":"reset-enable"}),
        );
        assert_eq!(enabled["enabled"], true);
        let original = enabled["tlsFingerprint"].as_str().unwrap().to_owned();
        let devices = DeviceManager::new(Arc::clone(&service.db)).unwrap();
        let offer = local(
            &service,
            "device.pairing.create",
            json!({"permission":"fullcontrol","operationId":"reset-pair"}),
        );
        let paired = devices
            .pair(
                offer["id"].as_str().unwrap(),
                offer["code"].as_str().unwrap(),
                "Phone",
            )
            .unwrap();
        assert!(devices.authenticate(&paired.token).is_ok());
        // Reading the status must never replace the identity.
        local(&service, "device.status", json!({}));
        assert_eq!(
            local(&service, "device.status", json!({}))["tlsFingerprint"],
            original
        );
        let reset = local(
            &service,
            "device.identity.reset",
            json!({"operationId":"reset-identity"}),
        );
        let replaced = reset["tlsFingerprint"].as_str().unwrap().to_owned();
        assert_ne!(replaced, original);
        assert_eq!(reset["enabled"], true);
        assert!(reset.get("identityError").is_none());
        assert!(reset.get("error").is_none());
        // Paired devices pinned the old certificate and must pair again.
        assert!(devices.authenticate(&paired.token).is_err());
        let listed = local(&service, "device.list", json!({}));
        assert_eq!(listed[0]["revokedAt"].is_string(), true);
        // Replaying the operation returns the identity it already installed.
        assert_eq!(
            local(
                &service,
                "device.identity.reset",
                json!({"operationId":"reset-identity"}),
            )["tlsFingerprint"],
            replaced
        );
        // The restarted listener serves the replacement identity: the previous
        // token is rejected and a new device pairs over the new certificate.
        let port = reset["port"].as_u64().unwrap() as u16;
        let client = reqwest::Client::builder()
            .add_root_certificate(
                reqwest::Certificate::from_pem(
                    &fs::read(directory.path().join(REMOTE_CERTIFICATE_FILE)).unwrap(),
                )
                .unwrap(),
            )
            .https_only(true)
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        let base = format!("https://localhost:{port}");
        let (status, body) = rpc_over_https(
            &client,
            &base,
            &paired.token,
            "remote.sessions",
            json!({}),
        )
        .await;
        assert_eq!(status, 401, "{body}");
        let offer = local(
            &service,
            "device.pairing.create",
            json!({"permission":"readonly","operationId":"reset-pair-again"}),
        );
        assert_eq!(offer["tlsFingerprint"], replaced);
        let repaired = pair_over_https(&client, &base, &offer, "Phone again").await;
        let repaired_token = repaired["token"].as_str().unwrap();
        let (status, body) = rpc_over_https(
            &client,
            &base,
            repaired_token,
            "remote.sessions",
            json!({}),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        // A reset while disabled is still explicit and never starts a listener.
        local(
            &service,
            "device.disable",
            json!({"operationId":"reset-disable"}),
        );
        let disabled_reset = local(
            &service,
            "device.identity.reset",
            json!({"operationId":"reset-identity-disabled"}),
        );
        assert_eq!(disabled_reset["enabled"], false);
        assert_ne!(disabled_reset["tlsFingerprint"], replaced);
        assert!(devices.authenticate(repaired_token).is_err());
        service.shutdown();
    }

    fn broken_identity_service(
        directory: &tempfile::TempDir,
        pipe: &str,
        enabled: bool,
    ) -> Arc<RuntimeService> {
        let config = RuntimeConfig {
            data_dir: directory.path().to_owned(),
            database_path: directory.path().join("runtime.sqlite3"),
            credential_path: directory.path().join("runtime.credential"),
            pipe_base: format!(r"\\.\pipe\threadterm-v3-{pipe}"),
        };
        let db = Arc::new(Database::open(&config.database_path).unwrap());
        crate::workspace_services::initialize(&db).unwrap();
        crate::settings_services::initialize(&db).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        crate::retry_scheduler::initialize(&db).unwrap();
        DeviceManager::new(Arc::clone(&db))
            .unwrap()
            .set_remote_access_preference(enabled, None, None)
            .unwrap();
        let service = Arc::new(RuntimeService::new(config, db));
        // Startup must succeed with a damaged identity.
        service.initialize_remote().unwrap();
        service
    }

    fn plant_broken_identity(data_dir: &Path, case: &str) {
        let certificate = data_dir.join(REMOTE_CERTIFICATE_FILE);
        let key = data_dir.join(REMOTE_PRIVATE_KEY_FILE);
        match case {
            "missing half pair" => {
                let source = tempdir().unwrap();
                load_or_create_certificate(source.path()).unwrap();
                fs::copy(source.path().join(REMOTE_CERTIFICATE_FILE), &certificate).unwrap();
            }
            "corrupt pem" => {
                fs::write(&certificate, b"-----BEGIN CERTIFICATE-----\ntruncated").unwrap();
                fs::write(&key, b"-----BEGIN PRIVATE KEY-----\ntruncated").unwrap();
            }
            // A directory where the key belongs is unreadable as a key on
            // every platform, without depending on Windows ACL helpers.
            "unreadable key" => {
                let source = tempdir().unwrap();
                load_or_create_certificate(source.path()).unwrap();
                fs::copy(source.path().join(REMOTE_CERTIFICATE_FILE), &certificate).unwrap();
                fs::create_dir(&key).unwrap();
            }
            other => panic!("unknown identity case {other}"),
        }
    }

    fn assert_local_work(service: &Arc<RuntimeService>, directory: &Path, operation: &str) {
        assert_eq!(
            local(service, "runtime.health", json!({}))["version"],
            crate::RUNTIME_VERSION
        );
        let session = local(
            service,
            "session.create",
            json!({"cwd":directory,"provider":"shell","mode":"terminal","operationId":operation}),
        );
        local(
            service,
            "terminal.read",
            json!({"sessionId":session["id"],"cursor":0,"limit":1024}),
        );
        local(
            service,
            "session.stop",
            json!({"sessionId":session["id"],"operationId":format!("{operation}-stop")}),
        );
    }

    fn local(service: &RuntimeService, method: &str, params: Value) -> Value {
        service
            .dispatch(
                "remote-integration-test",
                RpcRequest {
                    v: 1,
                    id: Uuid::new_v4().to_string(),
                    method: method.to_owned(),
                    params,
                },
            )
            .unwrap_or_else(|error| panic!("{method}: {} ({})", error.message, error.code))
    }

    async fn pair_over_https(
        client: &reqwest::Client,
        base: &str,
        offer: &Value,
        name: &str,
    ) -> Value {
        let response = client
            .post(format!("{base}/v1/pair"))
            .json(&json!({"pairingId":offer["id"],"code":offer["code"],"deviceName":name}))
            .send()
            .await
            .unwrap();
        let status = response.status();
        let body: Value = response.json().await.unwrap();
        assert_eq!(status.as_u16(), 200, "{body}");
        body
    }

    async fn rpc_over_https(
        client: &reqwest::Client,
        base: &str,
        token: &str,
        method: &str,
        params: Value,
    ) -> (u16, Value) {
        let response = client
            .post(format!("{base}/v1/rpc"))
            .bearer_auth(token)
            .json(&json!({"method":method,"params":params}))
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        let body = response.json().await.unwrap();
        (status, body)
    }
}
