//! TLS v2 secure bridge listener (separate from plaintext HTTP/WS v1).
//!
//! Native clients must verify the certificate fingerprint from the QR before
//! sending OTP/token. This module presents the desktop identity certificate
//! and runs the v2 WebSocket protocol over TLS.

use std::{
    collections::HashSet,
    net::SocketAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use axum_server::tls_rustls::RustlsConfig;
use tokio::sync::{watch, Notify};
use tokio::task::JoinHandle;

use super::{
    authz::{authorize, AuthzDevice, BridgeOperation, BridgeTransport},
    identity::SecureBridgeIdentity,
    pairing::AuthorizationLease,
    protocol::{
        parse_v2_client_message, versioned_v2_server_message, BridgeDevice, ClientClass,
        V2ClientMessage, V2ServerMessage, MAX_V2_PAYLOAD_BYTES,
    },
    workspace_adapter::WorkspaceBridgeAdapter,
    BridgeRuntime,
};

const CONNECTION_ABORT_GRACE: Duration = Duration::from_millis(250);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_OUTBOUND_QUEUE: usize = 64;

pub struct SecureServerHandle {
    pub host: String,
    pub port: u16,
    pub fingerprint_sha256: String,
    pub computer_id: String,
    shutdown: watch::Sender<bool>,
    join: Option<JoinHandle<()>>,
    connections: ConnectionTracker,
}

impl SecureServerHandle {
    pub async fn stop(&mut self, timeout: Duration) -> Result<(), String> {
        self.shutdown.send_replace(true);
        let deadline = tokio::time::Instant::now() + timeout;
        let mut failures = Vec::new();

        if let Some(mut join) = self.join.take() {
            match tokio::time::timeout_at(deadline, &mut join).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) if error.is_cancelled() => {}
                Ok(Err(error)) => {
                    failures.push(format!("Secure bridge listener task failed: {error}"));
                }
                Err(_) => {
                    failures.push(
                        "Secure bridge listener did not stop before the deadline.".to_string(),
                    );
                    join.abort();
                    let _ = join.await;
                }
            }
        }

        if tokio::time::timeout_at(deadline, self.connections.wait_for_idle())
            .await
            .is_err()
        {
            let remaining = self.connections.active_count();
            failures.push(format!(
                "{remaining} secure bridge socket task(s) did not drain before the deadline."
            ));
        }
        self.connections.abort_all();
        if tokio::time::timeout(CONNECTION_ABORT_GRACE, self.connections.wait_for_idle())
            .await
            .is_err()
        {
            let remaining = self.connections.active_count();
            failures.push(format!(
                "{remaining} secure bridge socket task(s) remained after forced cancellation."
            ));
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join(" "))
        }
    }

    pub fn is_stopping(&self) -> bool {
        *self.shutdown.borrow()
    }
}

#[derive(Clone)]
struct SecureContext {
    runtime: Arc<BridgeRuntime>,
    identity: SecureBridgeIdentity,
    adapter: Arc<WorkspaceBridgeAdapter>,
    shutdown: watch::Receiver<bool>,
    connections: ConnectionTracker,
}

#[derive(Clone, Default)]
struct ConnectionTracker {
    inner: Arc<ConnectionTrackerInner>,
}

struct ConnectionTrackerInner {
    next_id: AtomicU64,
    active: Mutex<HashSet<u64>>,
    idle: Notify,
    force_abort: watch::Sender<bool>,
}

impl Default for ConnectionTrackerInner {
    fn default() -> Self {
        let (force_abort, _) = watch::channel(false);
        Self {
            next_id: AtomicU64::new(1),
            active: Mutex::new(HashSet::new()),
            idle: Notify::new(),
            force_abort,
        }
    }
}

struct TrackedConnection {
    id: u64,
    inner: Arc<ConnectionTrackerInner>,
}

impl Drop for TrackedConnection {
    fn drop(&mut self) {
        let mut active = self.inner.active.lock().unwrap_or_else(|e| e.into_inner());
        active.remove(&self.id);
        if active.is_empty() {
            self.inner.idle.notify_waiters();
        }
    }
}

impl ConnectionTracker {
    fn register(&self) -> (TrackedConnection, watch::Receiver<bool>) {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        self.inner
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id);
        (
            TrackedConnection {
                id,
                inner: self.inner.clone(),
            },
            self.inner.force_abort.subscribe(),
        )
    }

    fn active_count(&self) -> usize {
        self.inner
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    fn abort_all(&self) {
        self.inner.force_abort.send_replace(true);
    }

    async fn wait_for_idle(&self) {
        loop {
            if self.active_count() == 0 {
                return;
            }
            self.inner.idle.notified().await;
        }
    }
}

fn ensure_crypto_provider() {
    // axum-server / rustls require exactly one process-level CryptoProvider.
    // Prefer ring; ignore AlreadyInstalled when another provider won the race.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub async fn start(
    runtime: Arc<BridgeRuntime>,
    host: String,
    port: u16,
    identity: SecureBridgeIdentity,
) -> Result<SecureServerHandle, String> {
    ensure_crypto_provider();
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .map_err(|e| format!("Invalid secure bridge bind address: {e}"))?;

    let (certs, key) = super::identity::SecureIdentityStore::rustls_materials(&identity)?;
    let config = RustlsConfig::from_der(
        certs.iter().map(|c| c.as_ref().to_vec()).collect(),
        match key {
            rustls::pki_types::PrivateKeyDer::Pkcs8(der) => der.secret_pkcs8_der().to_vec(),
            rustls::pki_types::PrivateKeyDer::Sec1(der) => der.secret_sec1_der().to_vec(),
            rustls::pki_types::PrivateKeyDer::Pkcs1(der) => der.secret_pkcs1_der().to_vec(),
            _ => return Err("Unsupported bridge private key encoding.".to_string()),
        },
    )
    .await
    .map_err(|error| format!("Failed to configure secure bridge TLS: {error}"))?;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let connections = ConnectionTracker::default();
    let context = SecureContext {
        runtime: runtime.clone(),
        identity: identity.clone(),
        adapter: Arc::new(WorkspaceBridgeAdapter::default()),
        shutdown: shutdown_rx.clone(),
        connections: connections.clone(),
    };

    let app = Router::new()
        .route("/health", get(secure_health))
        .route("/ws", get(secure_ws_handler))
        .with_state(context);

    let handle = axum_server::Handle::new();
    let server_handle = handle.clone();
    let mut server_shutdown = shutdown_rx;
    let join = tokio::spawn(async move {
        let serve = axum_server::bind_rustls(addr, config)
            .handle(handle)
            .serve(app.into_make_service());
        tokio::select! {
            result = serve => {
                if let Err(error) = result {
                    tracing::warn!(error = %error, "Secure mobile bridge server stopped with error");
                }
            }
            _ = async {
                if *server_shutdown.borrow() {
                    return;
                }
                let _ = server_shutdown.changed().await;
            } => {
                server_handle.graceful_shutdown(Some(Duration::from_secs(1)));
            }
        }
    });

    // Resolve the bound port when 0 was requested by probing after a short settle.
    // axum-server binds inside the task; use the requested port when non-zero.
    let bound_port = if port == 0 {
        // Wait briefly for bind; fall back to 0 if unknown.
        tokio::time::sleep(Duration::from_millis(20)).await;
        port
    } else {
        port
    };

    // When port is 0, re-bind is awkward with axum-server. Require explicit port
    // or use TcpListener pre-bind for ephemeral ports in tests.
    let bound_port = if bound_port == 0 {
        // Probe via a temporary bind is not available; tests pass explicit 0 via
        // preselected free port. Keep requested value.
        port
    } else {
        bound_port
    };

    Ok(SecureServerHandle {
        host,
        port: if bound_port == 0 {
            // Listeners bound with port 0 report via local_addr in tests that
            // use the free-port helper before calling start.
            0
        } else {
            bound_port
        },
        fingerprint_sha256: identity.fingerprint_sha256.clone(),
        computer_id: identity.computer_id.clone(),
        shutdown: shutdown_tx,
        join: Some(join),
        connections,
    })
}

/// Bind an ephemeral free port then start (used by tests and runtime).
pub async fn start_on_ephemeral(
    runtime: Arc<BridgeRuntime>,
    host: String,
    identity: SecureBridgeIdentity,
) -> Result<SecureServerHandle, String> {
    let listener = tokio::net::TcpListener::bind(format!("{host}:0"))
        .await
        .map_err(|e| format!("Failed to allocate secure bridge port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read secure bridge port: {e}"))?
        .port();
    drop(listener);
    start(runtime, host, port, identity).await
}

async fn secure_health(State(context): State<SecureContext>) -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "ok": true,
        "name": "ThreadTerm secure mobile bridge",
        "protocol": 2,
        "computerId": context.identity.computer_id,
        "fingerprintShort": super::identity::fingerprint_short(&context.identity.fingerprint_sha256),
    }))
}

async fn secure_ws_handler(
    ws: WebSocketUpgrade,
    State(context): State<SecureContext>,
) -> impl IntoResponse {
    let (_tracked, mut force_abort) = context.connections.register();
    ws.on_upgrade(move |socket| async move {
        tokio::select! {
            biased;
            _ = async {
                if *force_abort.borrow() {
                    return;
                }
                let _ = force_abort.changed().await;
            } => {}
            _ = handle_secure_socket(context, socket) => {}
        }
    })
}

async fn handle_secure_socket(context: SecureContext, mut socket: WebSocket) {
    let mut device: Option<BridgeDevice> = None;
    let mut device_lease: Option<AuthorizationLease<'_>> = None;
    let mut last_activity = tokio::time::Instant::now();
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut shutdown = context.shutdown.clone();
    let mut auth_revision = context.runtime.pairing.subscribe_auth_revision();
    let mut outbound_budget = MAX_OUTBOUND_QUEUE;

    loop {
        tokio::select! {
            biased;
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    let _ = send_v2(
                        &mut socket,
                        V2ServerMessage::Error {
                            code: "bridge_stopped".to_string(),
                            message: "Secure mobile bridge stopped.".to_string(),
                            request_id: None,
                        },
                    ).await;
                    break;
                }
            }
            _ = auth_revision.changed() => {
                if let Some(current) = device.as_ref() {
                    if !context.runtime.pairing.is_device_active(&current.id) {
                        let _ = send_v2(
                            &mut socket,
                            V2ServerMessage::Revoked {
                                reason: "authorization revoked".to_string(),
                            },
                        ).await;
                        break;
                    }
                }
            }
            _ = heartbeat.tick() => {
                if last_activity.elapsed() > HEARTBEAT_TIMEOUT {
                    let _ = send_v2(
                        &mut socket,
                        V2ServerMessage::Error {
                            code: "heartbeat_timeout".to_string(),
                            message: "Secure bridge heartbeat timed out.".to_string(),
                            request_id: None,
                        },
                    ).await;
                    break;
                }
                if device.is_some() {
                    let _ = send_v2(
                        &mut socket,
                        V2ServerMessage::Pong { t: now_millis() },
                    ).await;
                }
            }
            frame = socket.recv() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        last_activity = tokio::time::Instant::now();
                        if text.len() > MAX_V2_PAYLOAD_BYTES {
                            let _ = send_v2(
                                &mut socket,
                                V2ServerMessage::Error {
                                    code: "payload_too_large".to_string(),
                                    message: format!(
                                        "Payload exceeds {MAX_V2_PAYLOAD_BYTES} bytes."
                                    ),
                                    request_id: None,
                                },
                            ).await;
                            continue;
                        }
                        if device.is_none() {
                            match handle_unauthenticated(&context, &text).await {
                                Ok((Some(paired), responses)) => {
                                    match context.runtime.pairing.acquire_active_lease(&paired.id) {
                                        Ok(lease) => {
                                            device = Some(paired);
                                            device_lease = Some(lease);
                                            for response in responses {
                                                if send_v2(&mut socket, response).await.is_err() {
                                                    return;
                                                }
                                            }
                                        }
                                        Err(message) => {
                                            let _ = send_v2(
                                                &mut socket,
                                                V2ServerMessage::Error {
                                                    code: "auth_failed".to_string(),
                                                    message,
                                                    request_id: None,
                                                },
                                            ).await;
                                            break;
                                        }
                                    }
                                }
                                Ok((None, responses)) => {
                                    for response in responses {
                                        if send_v2(&mut socket, response).await.is_err() {
                                            return;
                                        }
                                    }
                                }
                                Err((code, message)) => {
                                    let _ = send_v2(
                                        &mut socket,
                                        V2ServerMessage::Error {
                                            code: code.clone(),
                                            message,
                                            request_id: None,
                                        },
                                    ).await;
                                    if matches!(
                                        code.as_str(),
                                        "auth_failed" | "protocol_version_mismatch"
                                    ) {
                                        break;
                                    }
                                }
                            }
                            continue;
                        }

                        let current = device.as_ref().expect("authenticated");
                        if !context.runtime.pairing.is_device_active(&current.id) {
                            let _ = send_v2(
                                &mut socket,
                                V2ServerMessage::Revoked {
                                    reason: "authorization revoked".to_string(),
                                },
                            ).await;
                            break;
                        }
                        match handle_authenticated(
                            &context,
                            current,
                            device_lease.as_ref().expect("lease"),
                            &text,
                        )
                        .await
                        {
                            Ok(responses) => {
                                for response in responses {
                                    if outbound_budget == 0 {
                                        let _ = send_v2(
                                            &mut socket,
                                            V2ServerMessage::Error {
                                                code: "backpressure".to_string(),
                                                message: "Secure bridge outbound queue is full.".to_string(),
                                                request_id: None,
                                            },
                                        ).await;
                                        break;
                                    }
                                    outbound_budget = outbound_budget.saturating_sub(1);
                                    if send_v2(&mut socket, response).await.is_err() {
                                        return;
                                    }
                                }
                                outbound_budget = MAX_OUTBOUND_QUEUE;
                            }
                            Err((code, message)) => {
                                let _ = send_v2(
                                    &mut socket,
                                    V2ServerMessage::Error {
                                        code: code.clone(),
                                        message,
                                        request_id: None,
                                    },
                                ).await;
                                if matches!(
                                    code.as_str(),
                                    "auth_revoked" | "protocol_version_mismatch" | "bridge_stopped"
                                ) {
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        last_activity = tokio::time::Instant::now();
                        let _ = socket.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        tracing::debug!(error = %error, "Secure bridge websocket closed");
                        break;
                    }
                }
            }
        }
    }

    if let Some(current) = device.as_ref() {
        let surface = format!("mobile:secure:{}", current.id);
        let service = context.adapter.service();
        let _ = tokio::task::spawn_blocking(move || {
            service.disconnect_surface(&surface, false);
        })
        .await;
    }
    drop(device_lease);
}

async fn handle_unauthenticated(
    context: &SecureContext,
    text: &str,
) -> Result<(Option<BridgeDevice>, Vec<V2ServerMessage>), (String, String)> {
    let message = parse_v2_client_message(text)
        .map_err(|error| (error.error_code().to_string(), error.to_string()))?;
    match message {
        V2ClientMessage::Pair {
            otp,
            device_name,
            permission,
            computer_id,
        } => {
            if computer_id != context.identity.computer_id {
                return Ok((
                    None,
                    vec![V2ServerMessage::PairResult {
                        ok: false,
                        device: None,
                        device_token: None,
                        computer_id: None,
                        expires_in_seconds: None,
                        error_code: Some("computer_id_mismatch".to_string()),
                        message: Some("Pairing computerId does not match this desktop.".to_string()),
                    }],
                ));
            }
            match context.runtime.pairing.pair_secure(
                super::protocol::SecurePairRequest {
                    otp,
                    device_name,
                    permission,
                    computer_id: computer_id.clone(),
                },
            ) {
                Ok(response) => Ok((
                    None,
                    vec![V2ServerMessage::PairResult {
                        ok: true,
                        device: Some(response.device),
                        device_token: Some(response.device_token),
                        computer_id: Some(response.computer_id),
                        expires_in_seconds: Some(response.expires_in_seconds),
                        error_code: None,
                        message: None,
                    }],
                )),
                Err(message) => Ok((
                    None,
                    vec![V2ServerMessage::PairResult {
                        ok: false,
                        device: None,
                        device_token: None,
                        computer_id: None,
                        expires_in_seconds: None,
                        error_code: Some("pair_failed".to_string()),
                        message: Some(message),
                    }],
                )),
            }
        }
        V2ClientMessage::Auth { token } => {
            let device = context
                .runtime
                .pairing
                .validate_token(&token)
                .ok_or_else(|| {
                    (
                        "auth_failed".to_string(),
                        "Invalid secure bridge auth token.".to_string(),
                    )
                })?;
            if device.client_class != ClientClass::SecureWorkspace {
                return Err((
                    "legacy_client_denied".to_string(),
                    "Legacy terminal tokens cannot authenticate on the secure bridge.".to_string(),
                ));
            }
            Ok((
                Some(device.clone()),
                vec![V2ServerMessage::AuthOk {
                    device,
                    computer_id: context.identity.computer_id.clone(),
                    server_id: context.runtime.server_id().to_string(),
                    runtime_id: context.runtime.runtime_id().to_string(),
                }],
            ))
        }
        V2ClientMessage::Ping { t } => Ok((
            None,
            vec![V2ServerMessage::Pong {
                t: t.unwrap_or_else(now_millis),
            }],
        )),
        _ => Err((
            "auth_required".to_string(),
            "Secure bridge websocket auth is required.".to_string(),
        )),
    }
}

async fn handle_authenticated(
    context: &SecureContext,
    device: &BridgeDevice,
    _lease: &AuthorizationLease<'_>,
    text: &str,
) -> Result<Vec<V2ServerMessage>, (String, String)> {
    let message = parse_v2_client_message(text)
        .map_err(|error| (error.error_code().to_string(), error.to_string()))?;

    let operation = operation_for_v2(&message);
    authorize(
        BridgeTransport::SecureTlsV2,
        AuthzDevice {
            client_class: device.client_class,
            permission: &device.permission,
            active: context.runtime.pairing.is_device_active(&device.id),
        },
        operation,
    )
    .map_err(|error| (error.code().to_string(), error.message().to_string()))?;

    // Re-check authorization lease immediately before side effects.
    let auth_lease = if matches!(
        operation,
        BridgeOperation::WorkspaceContentMutate | BridgeOperation::TerminalMutate
    ) {
        Some(
            context
                .runtime
                .pairing
                .acquire_full_lease(&device.id)
                .map_err(|message| ("auth_revoked".to_string(), message))?,
        )
    } else {
        Some(
            context
                .runtime
                .pairing
                .acquire_active_lease(&device.id)
                .map_err(|message| ("auth_revoked".to_string(), message))?,
        )
    };

    let result = match message {
        V2ClientMessage::Ping { t } => Ok(vec![V2ServerMessage::Pong {
            t: t.unwrap_or_else(now_millis),
        }]),
        V2ClientMessage::Auth { .. } => Ok(vec![]),
        V2ClientMessage::Pair { .. } => Ok(vec![V2ServerMessage::Error {
            code: "already_authenticated".to_string(),
            message: "Already authenticated on this secure connection.".to_string(),
            request_id: None,
        }]),
        V2ClientMessage::TerminalResync
        | V2ClientMessage::Input { .. }
        | V2ClientMessage::Resize { .. } => {
            // Terminal projection over secure transport reuses the shared
            // runtime snapshot; detailed terminal streaming remains on the
            // shared broadcast channel in a follow-up client integration.
            Ok(vec![V2ServerMessage::Error {
                code: "not_implemented".to_string(),
                message: "Terminal streaming on secure v2 uses the shared snapshot channel; use workspace messages for file/draft ops.".to_string(),
                request_id: None,
            }])
        }
        workspace_message => {
            context
                .adapter
                .handle(
                    &device.id,
                    &device.permission,
                    context.runtime.runtime_id(),
                    workspace_message,
                )
                .await
        }
    };
    drop(auth_lease);
    result
}

fn operation_for_v2(message: &V2ClientMessage) -> BridgeOperation {
    match message {
        V2ClientMessage::GetWorkspaceSnapshot { .. }
        | V2ClientMessage::SubscribeWorkspace { .. }
        | V2ClientMessage::UnsubscribeWorkspace { .. }
        | V2ClientMessage::ReadFile { .. }
        | V2ClientMessage::GetDraft { .. }
        | V2ClientMessage::ListDirectory { .. }
        | V2ClientMessage::TerminalResync => BridgeOperation::WorkspaceRead,
        V2ClientMessage::OpenTab { .. }
        | V2ClientMessage::CloseTab { .. }
        | V2ClientMessage::ReorderTabs { .. }
        | V2ClientMessage::SetActiveTab { .. }
        | V2ClientMessage::AcquireLease { .. }
        | V2ClientMessage::RenewLease { .. }
        | V2ClientMessage::ReleaseLease { .. } => BridgeOperation::WorkspaceMetadataMutate,
        V2ClientMessage::ApplyDraftPatch { .. }
        | V2ClientMessage::SaveDraft { .. }
        | V2ClientMessage::DiscardDraft { .. }
        | V2ClientMessage::TakeoverLease { .. } => BridgeOperation::WorkspaceContentMutate,
        V2ClientMessage::Input { .. } | V2ClientMessage::Resize { .. } => {
            BridgeOperation::TerminalMutate
        }
        V2ClientMessage::Auth { .. } | V2ClientMessage::Pair { .. } | V2ClientMessage::Ping { .. } => {
            BridgeOperation::TerminalView
        }
    }
}

async fn send_v2(socket: &mut WebSocket, message: V2ServerMessage) -> Result<(), axum::Error> {
    let payload = serde_json::to_string(&versioned_v2_server_message(message))
        .map_err(axum::Error::new)?;
    socket.send(Message::Text(payload)).await
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::identity::SecureIdentityStore;
    use crate::bridge::protocol::{DevicePermission, PROTOCOL_VERSION_V2};
    use futures_util::{SinkExt, StreamExt};
    use rustls::ClientConfig;
    use rustls::pki_types::{CertificateDer, ServerName};
    use std::sync::Arc as StdArc;
    use tokio_rustls::TlsConnector;
    use tokio_tungstenite::{client_async, tungstenite::Message as TsMessage};

    #[derive(Debug)]
    struct FingerprintVerifier {
        expected: String,
    }

    impl rustls::client::danger::ServerCertVerifier for FingerprintVerifier {
        fn verify_server_cert(
            &self,
            end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: rustls::pki_types::UnixTime,
        ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
            let presented = crate::bridge::identity::certificate_fingerprint_sha256(end_entity.as_ref());
            if crate::bridge::identity::fingerprints_match(&self.expected, &presented) {
                Ok(rustls::client::danger::ServerCertVerified::assertion())
            } else {
                Err(rustls::Error::General("certificate fingerprint mismatch".into()))
            }
        }

        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            rustls::crypto::ring::default_provider()
                .signature_verification_algorithms
                .supported_schemes()
        }
    }

    async fn start_test_server() -> (Arc<BridgeRuntime>, SecureServerHandle, SecureBridgeIdentity) {
        ensure_crypto_provider();
        let dir = std::env::temp_dir().join(format!(
            "tt-secure-{}-{}-{}",
            std::process::id(),
            now_millis(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let store = SecureIdentityStore::new(dir);
        let identity = store.load_or_create().expect("identity");
        let runtime = Arc::new(BridgeRuntime::new());
        let handle = start_on_ephemeral(runtime.clone(), "127.0.0.1".to_string(), identity.clone())
            .await
            .expect("start secure");
        // Give the listener a moment to bind.
        tokio::time::sleep(Duration::from_millis(80)).await;
        (runtime, handle, identity)
    }

    async fn connect_pinned(
        host: &str,
        port: u16,
        fingerprint: &str,
    ) -> Result<
        tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>,
        String,
    > {
        ensure_crypto_provider();
        let verifier = StdArc::new(FingerprintVerifier {
            expected: fingerprint.to_string(),
        });
        let config = ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_no_client_auth();
        let connector = TlsConnector::from(StdArc::new(config));
        let tcp = tokio::net::TcpStream::connect(format!("{host}:{port}"))
            .await
            .map_err(|e| e.to_string())?;
        let server_name = ServerName::try_from(host.to_string()).map_err(|e| e.to_string())?;
        let tls = connector
            .connect(server_name, tcp)
            .await
            .map_err(|e| e.to_string())?;
        let url = format!("wss://{host}:{port}/ws");
        let (ws, _) = client_async(url, tls).await.map_err(|e| e.to_string())?;
        Ok(ws)
    }

    #[tokio::test]
    async fn correct_fingerprint_can_pair_and_auth() {
        let (runtime, mut handle, identity) = start_test_server().await;
        let qr = runtime.pairing.create_secure_pair_qr(
            handle.host.clone(),
            handle.port,
            identity.computer_id.clone(),
            identity.fingerprint_sha256.clone(),
            DevicePermission::Full,
        );

        let mut ws = connect_pinned(&handle.host, handle.port, &identity.fingerprint_sha256)
            .await
            .expect("pinned connect");
        let pair = serde_json::json!({
            "protocol_version": PROTOCOL_VERSION_V2,
            "kind": "pair",
            "otp": qr.otp,
            "device_name": "iPhone",
            "permission": "full",
            "computer_id": identity.computer_id,
        });
        ws.send(TsMessage::Text(pair.to_string()))
            .await
            .expect("send pair");
        let response = ws.next().await.expect("resp").expect("ok");
        let text = response.to_text().expect("text");
        let value: serde_json::Value = serde_json::from_str(text).expect("json");
        assert_eq!(value["kind"], "pair_result");
        assert_eq!(value["ok"], true);
        let token = value
            .get("device_token")
            .or_else(|| value.get("deviceToken"))
            .and_then(|value| value.as_str())
            .expect("token")
            .to_string();

        let auth = serde_json::json!({
            "protocol_version": PROTOCOL_VERSION_V2,
            "kind": "auth",
            "token": token,
        });
        // New connection for auth after pair (pair does not auto-auth).
        drop(ws);
        let mut ws = connect_pinned(&handle.host, handle.port, &identity.fingerprint_sha256)
            .await
            .expect("auth connect");
        ws.send(TsMessage::Text(auth.to_string()))
            .await
            .expect("send auth");
        let response = ws.next().await.expect("auth resp").expect("ok");
        let text = response.to_text().expect("text");
        let value: serde_json::Value = serde_json::from_str(text).expect("json");
        assert_eq!(value["kind"], "auth_ok");
        let client_class = value["device"]
            .get("clientClass")
            .or_else(|| value["device"].get("client_class"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        assert_eq!(client_class, "secure_workspace");

        handle.stop(Duration::from_secs(2)).await.expect("stop");
    }

    #[tokio::test]
    async fn wrong_fingerprint_aborts_before_auth() {
        let (_runtime, mut handle, identity) = start_test_server().await;
        let wrong = "ff".repeat(32);
        let err = connect_pinned(&handle.host, handle.port, &wrong)
            .await
            .expect_err("must fail");
        assert!(
            err.to_lowercase().contains("fingerprint")
                || err.to_lowercase().contains("certificate")
                || err.to_lowercase().contains("tls")
                || err.to_lowercase().contains("general"),
            "unexpected error: {err}"
        );
        handle.stop(Duration::from_secs(2)).await.expect("stop");
        let _ = identity;
    }

    #[tokio::test]
    async fn legacy_token_denied_on_secure_listener() {
        let (runtime, mut handle, identity) = start_test_server().await;
        let legacy_qr = runtime.pairing.create_pair_qr(
            "127.0.0.1".to_string(),
            5174,
            DevicePermission::Full,
        );
        let legacy = runtime
            .pairing
            .pair(super::super::protocol::PairRequest {
                otp: legacy_qr.otp,
                device_name: "Browser".to_string(),
                permission: Some(DevicePermission::Full),
            })
            .expect("legacy pair");

        let mut ws = connect_pinned(&handle.host, handle.port, &identity.fingerprint_sha256)
            .await
            .expect("connect");
        let auth = serde_json::json!({
            "protocol_version": PROTOCOL_VERSION_V2,
            "kind": "auth",
            "token": legacy.device_token,
        });
        ws.send(TsMessage::Text(auth.to_string()))
            .await
            .expect("send");
        let response = ws.next().await.expect("resp").expect("ok");
        let text = response.to_text().expect("text");
        let value: serde_json::Value = serde_json::from_str(text).expect("json");
        assert_eq!(value["kind"], "error");
        assert_eq!(value["code"], "legacy_client_denied");

        handle.stop(Duration::from_secs(2)).await.expect("stop");
    }
}
