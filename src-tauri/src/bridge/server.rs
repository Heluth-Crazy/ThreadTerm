use std::{
    collections::HashSet,
    future::Future,
    net::SocketAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Request, State,
    },
    http::{
        header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, HOST, ORIGIN},
        HeaderMap, HeaderName, HeaderValue, StatusCode, Uri,
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use tokio::{
    net::TcpListener,
    sync::{broadcast, watch, Notify},
    task::JoinHandle,
    time::{Instant, MissedTickBehavior},
};
use tower_http::trace::TraceLayer;

use super::{
    authz::{authorize, AuthzDevice, BridgeOperation, BridgeTransport},
    pairing::AuthorizationLease,
    protocol::{
        parse_client_message, versioned_server_message, BridgeDevice, ClientMessage,
        MobileCardRequest, MobileRenameCardRequest, MobileSpawnCardRequest, PairRequest,
        ServerMessage,
    },
    BridgeRuntime,
};

const MOBILE_INDEX_HTML: &[u8] = include_bytes!("../../../mobile-app/dist/index.html");
const MOBILE_INDEX_CSS: &[u8] = include_bytes!("../../../mobile-app/dist/assets/index.css");
const MOBILE_INDEX_JS: &[u8] = include_bytes!("../../../mobile-app/dist/assets/index.js");
const MOBILE_VENDOR_REACT_JS: &[u8] =
    include_bytes!("../../../mobile-app/dist/assets/vendor-react.js");
const MOBILE_VENDOR_XTERM_JS: &[u8] =
    include_bytes!("../../../mobile-app/dist/assets/vendor-xterm.js");
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_TRAILING_SUBMIT_KEYS: usize = 8;
const CONNECTION_ABORT_GRACE: Duration = Duration::from_millis(250);
const MOBILE_CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

pub struct BridgeServerHandle {
    pub host: String,
    pub port: u16,
    shutdown: watch::Sender<bool>,
    join: Option<JoinHandle<()>>,
    connections: ConnectionTracker,
}

impl BridgeServerHandle {
    /// Stop accepting new requests and drain every HTTP/WebSocket task.
    ///
    /// Axum owns the task created by `on_upgrade`, so listener shutdown alone
    /// does not prove those tasks have exited. Each upgrade is registered in
    /// `ConnectionTracker`; if graceful cancellation exceeds the deadline we
    /// explicitly abort the remaining futures before returning.
    pub async fn stop(&mut self, timeout: Duration) -> Result<(), String> {
        self.shutdown.send_replace(true);
        let deadline = Instant::now() + timeout;
        let mut failures = Vec::new();

        if let Some(mut join) = self.join.take() {
            match tokio::time::timeout_at(deadline, &mut join).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) if error.is_cancelled() => {
                    tracing::debug!("Mobile bridge listener task was already cancelled");
                }
                Ok(Err(error)) => {
                    failures.push(format!("Mobile bridge listener task failed: {error}"));
                }
                Err(_) => {
                    failures.push(
                        "Mobile bridge listener did not stop before the deadline.".to_string(),
                    );
                    tracing::warn!(
                        active_connections = self.connections.active_count(),
                        "Mobile bridge listener shutdown timed out; aborting server task"
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
                "{remaining} mobile bridge request or socket task(s) did not drain before the deadline."
            ));
            tracing::warn!(
                active_connections = remaining,
                "Mobile bridge connection drain timed out; aborting socket tasks"
            );
        }

        // Always latch force-abort, even after an apparently clean drain. A
        // request accepted just before listener shutdown may register after
        // the zero-count observation; retained cancellation prevents it from
        // starting authenticated extractors or handlers after stop returns.
        self.connections.abort_all();
        if tokio::time::timeout(CONNECTION_ABORT_GRACE, self.connections.wait_for_idle())
            .await
            .is_err()
        {
            let remaining = self.connections.active_count();
            failures.push(format!(
                "{remaining} mobile bridge request or socket task(s) remained after forced cancellation."
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

    #[cfg(test)]
    pub(crate) fn hold_activity_for_test(&self) -> BridgeActivityTestGuard {
        let (activity, _force_abort) = self.connections.register();
        BridgeActivityTestGuard(activity)
    }
}

#[cfg(test)]
#[allow(dead_code)]
pub(crate) struct BridgeActivityTestGuard(TrackedConnection);

#[derive(Clone)]
struct ServerContext {
    runtime: Arc<BridgeRuntime>,
    shutdown: watch::Receiver<bool>,
    connections: ConnectionTracker,
}

#[derive(Clone)]
struct ConnectionTracker {
    inner: Arc<ConnectionTrackerInner>,
}

struct ConnectionTrackerInner {
    next_id: AtomicU64,
    active: Mutex<HashSet<u64>>,
    idle: Notify,
    force_abort: watch::Sender<bool>,
}

struct TrackedConnection {
    id: u64,
    inner: Arc<ConnectionTrackerInner>,
}

impl ConnectionTracker {
    fn register(&self) -> (TrackedConnection, watch::Receiver<bool>) {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        self.inner
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
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
            .unwrap_or_else(|error| error.into_inner())
            .len()
    }

    fn abort_all(&self) {
        self.inner.force_abort.send_replace(true);
    }

    async fn wait_for_idle(&self) {
        loop {
            let notified = self.inner.idle.notified();
            if self.active_count() == 0 {
                return;
            }
            notified.await;
        }
    }
}

impl Default for ConnectionTracker {
    fn default() -> Self {
        let (force_abort, _) = watch::channel(false);
        Self {
            inner: Arc::new(ConnectionTrackerInner {
                next_id: AtomicU64::new(0),
                active: Mutex::new(HashSet::new()),
                idle: Notify::new(),
                force_abort,
            }),
        }
    }
}

impl Drop for TrackedConnection {
    fn drop(&mut self) {
        self.inner
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.id);
        self.inner.idle.notify_waiters();
    }
}

pub async fn start(
    runtime: Arc<BridgeRuntime>,
    host: String,
    port: u16,
) -> Result<BridgeServerHandle, String> {
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .map_err(|e| format!("Invalid bridge bind address: {e}"))?;
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind bridge server on {addr}: {e}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| format!("Failed to read bridge server address: {e}"))?;
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let connections = ConnectionTracker::default();
    let context = ServerContext {
        runtime,
        shutdown: shutdown_rx.clone(),
        connections: connections.clone(),
    };
    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/snapshot", get(snapshot_handler))
        .route("/pair", get(pair_page_handler).post(pair_handler))
        .route("/ws", get(ws_handler))
        .fallback(get(mobile_static_handler))
        .layer(
            TraceLayer::new_for_http().make_span_with(|request: &axum::http::Request<Body>| {
                tracing::debug_span!(
                    "mobile_bridge_http",
                    method = %request.method(),
                    path = %request.uri().path(),
                )
            }),
        )
        // Added last so this is the outermost application layer: tracking is
        // established before route auth, JSON extraction, database work, or
        // any handler side effect begins.
        .layer(middleware::from_fn_with_state(
            connections.clone(),
            track_http_request,
        ))
        .with_state(context);

    // We deliberately use `tokio::spawn` instead of `tauri::async_runtime::spawn`
    // here. The Tauri global async runtime is a separate Tokio reactor, but
    // the `TcpListener` we just bound is registered with whichever runtime
    // called `bridge_start`. Spawning the `accept` loop on a different
    // reactor produces sporadic `Connection refused` errors (and broke the
    // S2-1 wscat-style integration test). Plain `tokio::spawn` reuses the
    // current runtime and keeps the listener and acceptor co-located.
    let join = tokio::spawn(async move {
        let mut server_shutdown = shutdown_rx;
        let server = axum::serve(listener, app).with_graceful_shutdown(async move {
            if *server_shutdown.borrow() {
                return;
            }
            let _ = server_shutdown.changed().await;
        });
        if let Err(error) = server.await {
            tracing::warn!(error = %error, "Mobile bridge server stopped with error");
        }
    });

    Ok(BridgeServerHandle {
        host,
        port: local_addr.port(),
        shutdown: shutdown_tx,
        join: Some(join),
        connections,
    })
}

async fn track_http_request(
    State(connections): State<ConnectionTracker>,
    request: Request,
    next: Next,
) -> Response {
    let (_request, mut force_abort) = connections.register();
    tokio::select! {
        biased;
        _ = wait_for_bridge_shutdown(&mut force_abort) => {
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
        response = next.run(request) => response,
    }
}

async fn health_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "name": "ThreadTerm mobile bridge"
    }))
}

fn mobile_asset_response(path: &str) -> Response {
    let normalized = path.trim_start_matches('/');
    let file = mobile_asset_bytes(normalized);

    let mut response = match file {
        Some((contents, served_path)) => {
            let body = if served_path == "index.html" {
                Body::from(cache_busted_mobile_index_html())
            } else {
                Body::from(contents)
            };
            let mut response = Response::new(body);
            response.headers_mut().insert(
                CONTENT_TYPE,
                HeaderValue::from_static(content_type_for_path(served_path)),
            );
            response
                .headers_mut()
                .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(Body::from("mobile asset not found"))
            .unwrap_or_else(|_| Response::new(Body::empty())),
    };
    add_mobile_security_headers(response.headers_mut());
    response
}

fn add_mobile_security_headers(headers: &mut HeaderMap) {
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(MOBILE_CONTENT_SECURITY_POLICY),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
}

fn cache_busted_mobile_index_html() -> String {
    let version = env!("CARGO_PKG_VERSION");
    let html = std::str::from_utf8(MOBILE_INDEX_HTML).unwrap_or_default();
    html.replace("/assets/index.js", &format!("/assets/index.js?v={version}"))
        .replace(
            "/assets/vendor-react.js",
            &format!("/assets/vendor-react.js?v={version}"),
        )
        .replace(
            "/assets/vendor-xterm.js",
            &format!("/assets/vendor-xterm.js?v={version}"),
        )
        .replace(
            "/assets/index.css",
            &format!("/assets/index.css?v={version}"),
        )
}

fn mobile_asset_bytes(path: &str) -> Option<(&'static [u8], &'static str)> {
    match path {
        "" | "index.html" => Some((MOBILE_INDEX_HTML, "index.html")),
        "assets/index.css" => Some((MOBILE_INDEX_CSS, "assets/index.css")),
        "assets/index.js" => Some((MOBILE_INDEX_JS, "assets/index.js")),
        "assets/vendor-react.js" => Some((MOBILE_VENDOR_REACT_JS, "assets/vendor-react.js")),
        "assets/vendor-xterm.js" => Some((MOBILE_VENDOR_XTERM_JS, "assets/vendor-xterm.js")),
        value if !value.contains('.') => Some((MOBILE_INDEX_HTML, "index.html")),
        _ => None,
    }
}

fn content_type_for_path(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default() {
        "css" => "text/css; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "wasm" => "application/wasm",
        "ico" => "image/x-icon",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

async fn pair_page_handler() -> Response {
    mobile_asset_response("index.html")
}

async fn mobile_static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    mobile_asset_response(if path.is_empty() { "index.html" } else { path })
}

async fn snapshot_handler(
    State(context): State<ServerContext>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    if !browser_origin_matches_host(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let device = authenticate_request(&context, &headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let lease = context
        .runtime
        .pairing
        .acquire_active_lease(&device.id)
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    // Convert to a concrete response while authorization is leased so both
    // snapshot generation and JSON serialization finish before revoke can
    // report that this device is fully drained.
    let response =
        Json(versioned_server_message(context.runtime.snapshot().into())).into_response();
    drop(lease);
    Ok(response)
}

async fn pair_handler(
    State(context): State<ServerContext>,
    headers: HeaderMap,
    Json(request): Json<PairRequest>,
) -> Result<Json<super::protocol::PairResponse>, (StatusCode, String)> {
    if !browser_origin_matches_host(&headers) {
        return Err((
            StatusCode::FORBIDDEN,
            "Pairing request origin does not match this computer.".to_string(),
        ));
    }
    context
        .runtime
        .pairing
        .pair(request)
        .map(Json)
        .map_err(|message| (StatusCode::UNAUTHORIZED, message))
}

async fn ws_handler(
    State(context): State<ServerContext>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    if !browser_origin_matches_host(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let device = authenticate_request(&context, &headers);
    // Register before handing the callback to Axum. This closes the race in
    // which `bridge_stop` could observe zero active sockets while an accepted
    // upgrade callback had not started polling yet.
    let (connection, mut force_abort) = context.connections.register();
    Ok(ws.on_upgrade(move |socket| async move {
        let _connection = connection;
        tokio::select! {
            _ = handle_socket(context, device, socket) => {}
            _ = wait_for_bridge_shutdown(&mut force_abort) => {}
        }
    }))
}

async fn handle_socket(
    context: ServerContext,
    mut device: Option<BridgeDevice>,
    mut socket: WebSocket,
) {
    let mut rx = context.runtime.subscribe();
    let mut shutdown = context.shutdown.clone();
    let mut auth_revision = context.runtime.pairing.subscribe_auth_revision();
    let mut auth_check = tokio::time::interval(Duration::from_secs(1));
    auth_check.set_missed_tick_behavior(MissedTickBehavior::Delay);

    // The per-server shutdown watch retains its value. A socket task created
    // after stop was signalled must close immediately instead of subscribing
    // past a one-shot revision event and keeping the old generation alive.
    if *shutdown.borrow() {
        if let Some(current_device) = device.as_ref() {
            if let Ok(lease) = context
                .runtime
                .pairing
                .acquire_active_lease(&current_device.id)
            {
                close_socket_with_error_authorized(
                    &mut socket,
                    "bridge_stopped",
                    "The mobile bridge was stopped.",
                    &lease,
                )
                .await;
            }
        } else {
            close_socket_with_error(
                &mut socket,
                "bridge_stopped",
                "The mobile bridge was stopped.",
            )
            .await;
        }
        return;
    }

    // An authenticated socket keeps a read/send lease until it closes. This
    // is deliberately broader than an individual send: revoke can tombstone
    // immediately, then wait until any in-progress frame (including the final
    // auth-revoked error/close frame) has completed before returning.
    let mut device_lease = match device.as_ref() {
        Some(current_device) => match context
            .runtime
            .pairing
            .acquire_active_lease(&current_device.id)
        {
            Ok(lease) => Some(lease),
            Err(_) => return,
        },
        None => None,
    };
    if let Some(lease) = device_lease.as_ref() {
        if send_initial_messages(&context, lease, &mut socket)
            .await
            .is_err()
        {
            return;
        }
    }

    loop {
        tokio::select! {
            shutdown_changed = shutdown.changed() => {
                if shutdown_changed.is_ok() && *shutdown.borrow() {
                    if let Some(lease) = device_lease.as_ref() {
                        close_socket_with_error_authorized(
                            &mut socket,
                            "bridge_stopped",
                            "The mobile bridge was stopped.",
                            lease,
                        ).await;
                    } else {
                        close_socket_with_error(
                            &mut socket,
                            "bridge_stopped",
                            "The mobile bridge was stopped.",
                        ).await;
                    }
                }
                break;
            }
            auth_changed = auth_revision.changed() => {
                if auth_changed.is_err() {
                    break;
                }
                if let Some(current_device) = device.as_ref() {
                    if !context.runtime.pairing.is_device_active(&current_device.id) {
                        close_socket_with_error_authorized(
                            &mut socket,
                            "auth_revoked",
                            "This mobile bridge authorization is no longer active.",
                            device_lease.as_ref().expect("authenticated socket lease"),
                        ).await;
                        break;
                    }
                }
            }
            _ = auth_check.tick() => {
                if let Some(current_device) = device.as_ref() {
                    if !context.runtime.pairing.is_device_active(&current_device.id) {
                        close_socket_with_error_authorized(
                            &mut socket,
                            "auth_expired",
                            "This mobile bridge authorization expired.",
                            device_lease.as_ref().expect("authenticated socket lease"),
                        ).await;
                        break;
                    }
                }
            }
            outbound = rx.recv() => {
                if device.is_none() {
                    continue;
                }
                if !context.runtime.pairing.is_device_active(
                    &device.as_ref().expect("authenticated device").id,
                ) {
                    close_socket_with_error_authorized(
                        &mut socket,
                        "auth_revoked",
                        "This mobile bridge authorization is no longer active.",
                        device_lease.as_ref().expect("authenticated socket lease"),
                    ).await;
                    break;
                }
                let lease = device_lease.as_ref().expect("authenticated socket lease");
                match outbound {
                    Ok(message) => {
                        if send_json_authorized(&mut socket, &message, lease).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let message = ServerMessage::Error {
                            code: "backpressure".to_string(),
                            message: "Client fell behind; intermediate events were dropped.".to_string(),
                        };
                        if send_json_authorized(&mut socket, &message, lease).await.is_err() {
                            break;
                        }
                        let mut resync_failed = false;
                        for message in initial_messages_for_client(&context) {
                            if send_json_authorized(&mut socket, &message, lease).await.is_err() {
                                resync_failed = true;
                                break;
                            }
                        }
                        if resync_failed {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if text.contains("\"kind\":\"input\"") {
                            tracing::debug!(
                                device_id = device.as_ref().map(|device| device.id.as_str()).unwrap_or("unauthenticated"),
                                raw_len = text.len(),
                                "Mobile bridge raw input frame"
                            );
                        }
                        let Some(current_device) = device.as_ref() else {
                            match authenticate_socket_message(&context, &text) {
                                Ok(authenticated) => {
                                    let lease = match context
                                        .runtime
                                        .pairing
                                        .acquire_active_lease(&authenticated.id)
                                    {
                                        Ok(lease) => lease,
                                        Err(_) => break,
                                    };
                                    device = Some(authenticated);
                                    device_lease = Some(lease);
                                    if send_initial_messages(
                                        &context,
                                        device_lease
                                            .as_ref()
                                            .expect("authenticated socket lease"),
                                        &mut socket,
                                    )
                                    .await
                                    .is_err()
                                    {
                                        break;
                                    }
                                }
                                Err((code, message)) => {
                                    let _ = send_json(&mut socket, &ServerMessage::Error {
                                        code,
                                        message,
                                    }).await;
                                    break;
                                }
                            }
                            continue;
                        };
                        if !context.runtime.pairing.is_device_active(&current_device.id) {
                            close_socket_with_error_authorized(
                                &mut socket,
                                "auth_revoked",
                                "This mobile bridge authorization is no longer active.",
                                device_lease.as_ref().expect("authenticated socket lease"),
                            ).await;
                            break;
                        }
                        match handle_client_message(&context, current_device, &text).await {
                            Ok(responses) => {
                                for response in responses {
                                    if send_json_authorized(
                                        &mut socket,
                                        &response,
                                        device_lease.as_ref().expect("authenticated socket lease"),
                                    )
                                    .await
                                    .is_err()
                                    {
                                        return;
                                    }
                                }
                            }
                            Err((code, message)) => {
                                tracing::warn!(code = %code, message = %message, "Mobile bridge client message rejected");
                                let _ = send_json_authorized(
                                    &mut socket,
                                    &ServerMessage::Error {
                                        code: code.clone(),
                                        message,
                                    },
                                    device_lease.as_ref().expect("authenticated socket lease"),
                                ).await;
                                if matches!(
                                    code.as_str(),
                                    "protocol_version_mismatch" | "auth_revoked" | "bridge_stopped"
                                ) {
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        tracing::debug!(error = %error, "Mobile bridge websocket closed");
                        break;
                    }
                }
            }
        }
    }
}

async fn send_initial_messages(
    context: &ServerContext,
    lease: &AuthorizationLease<'_>,
    socket: &mut WebSocket,
) -> Result<(), axum::Error> {
    for message in initial_messages_for_client(context) {
        send_json_authorized(socket, &message, lease).await?;
    }
    Ok(())
}

fn authenticate_socket_message(
    context: &ServerContext,
    text: &str,
) -> Result<BridgeDevice, (String, String)> {
    match parse_client_message(text).map_err(|e| (e.error_code().to_string(), e.to_string()))? {
        ClientMessage::Auth { token } => authenticate(context, Some(&token)).ok_or_else(|| {
            (
                "auth_failed".to_string(),
                "Invalid mobile bridge auth token.".to_string(),
            )
        }),
        _ => Err((
            "auth_required".to_string(),
            "Mobile bridge websocket auth is required.".to_string(),
        )),
    }
}

fn initial_messages_for_client(context: &ServerContext) -> Vec<ServerMessage> {
    let theme = context.runtime.current_theme();
    let snapshot = context.runtime.snapshot();
    let terminal_snapshots = snapshot
        .cards
        .iter()
        .filter_map(|card| super::terminal_snapshot_message(&context.runtime, &card.id))
        .map(|snapshot| ServerMessage::TerminalSnapshot { snapshot })
        .collect::<Vec<_>>();
    let initial = ServerMessage::from(snapshot);

    std::iter::once(ServerMessage::Theme {
        app: theme.app,
        terminal: theme.terminal,
        mode: theme.mode,
    })
    .chain(std::iter::once(initial))
    .chain(terminal_snapshots)
    .collect()
}

async fn handle_client_message(
    context: &ServerContext,
    device: &BridgeDevice,
    text: &str,
) -> Result<Vec<ServerMessage>, (String, String)> {
    // Reject workspace/file/draft kinds on the plaintext v1 transport before
    // the normal v1 parser turns them into a generic invalid_message.
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
        if let Some(kind) = value.get("kind").and_then(|value| value.as_str()) {
            if super::protocol::is_v1_forbidden_workspace_kind(kind) {
                return match authorize(
                    BridgeTransport::LegacyPlaintext,
                    AuthzDevice {
                        client_class: device.client_class,
                        permission: &device.permission,
                        active: true,
                    },
                    BridgeOperation::WorkspaceRead,
                ) {
                    Err(error) => Err((error.code().to_string(), error.message().to_string())),
                    Ok(()) => Err((
                        "secure_transport_required".to_string(),
                        "Workspace and file operations require the secure mobile bridge (TLS v2)."
                            .to_string(),
                    )),
                };
            }
        }
        // Protocol 2 with a workspace kind is a secure-transport violation.
        // Other wrong versions still use the normal protocol_version_mismatch path.
        if value
            .get("protocol_version")
            .and_then(|value| value.as_u64())
            == Some(2)
        {
            if let Some(kind) = value.get("kind").and_then(|value| value.as_str()) {
                if super::protocol::is_v1_forbidden_workspace_kind(kind)
                    || matches!(
                        kind,
                        "pair" | "get_workspace_snapshot" | "subscribe_workspace"
                    )
                {
                    return Err((
                        "secure_transport_required".to_string(),
                        "Protocol v2 requires the secure mobile bridge (TLS v2).".to_string(),
                    ));
                }
            }
        }
    }

    let message: ClientMessage =
        parse_client_message(text).map_err(|e| (e.error_code().to_string(), e.to_string()))?;

    let authorization_lease = if client_message_requires_full_authorization(&message) {
        ensure_full_permission(device)?;
        Some(
            context
                .runtime
                .pairing
                .acquire_full_lease(&device.id)
                .map_err(|message| ("auth_revoked".to_string(), message))?,
        )
    } else {
        None
    };

    let result = match message {
        ClientMessage::Auth { .. } => Ok(Vec::new()),
        ClientMessage::Subscribe { .. } => Ok(Vec::new()),
        ClientMessage::TerminalResync => Ok(initial_messages_for_client(context)),
        ClientMessage::Ping => {
            context
                .runtime
                .broadcast(ServerMessage::Pong { t: now_millis() });
            Ok(Vec::new())
        }
        ClientMessage::Input { card_id, data } => {
            validate_pty_input(&data)?;
            let pty_id = context.runtime.pty_id_for_card(&card_id);
            let input_summary = summarize_input(&data);
            tracing::debug!(
                device_id = %device.id,
                card_id = %card_id,
                pty_id = %pty_id,
                len = data.len(),
                summary = %input_summary,
                "Mobile bridge input received"
            );
            crate::db::enqueue_audit_log(&device.id, "input", Some(&card_id), &input_summary);
            paced_pty_input(context, device, &pty_id, &data)
                .await
                .map(|_| Vec::new())
        }
        ClientMessage::Resize {
            card_id,
            cols,
            rows,
        } => {
            let pty_id = context.runtime.pty_id_for_card(&card_id);
            crate::pty::pty_resize(pty_id, rows, cols)
                .await
                .map_err(|message| ("command_failed".to_string(), message))
                .map(|_| Vec::new())
        }
        ClientMessage::Close {
            card_id,
            request_id,
        } => {
            crate::db::enqueue_audit_log(&device.id, "close", Some(&card_id), "close session");
            let request_id =
                request_id.unwrap_or_else(|| format!("close:{}:{}", card_id, now_millis()));
            context
                .runtime
                .emit_remove_request(MobileCardRequest {
                    request_id,
                    card_id,
                })
                .map_err(|message| ("command_failed".to_string(), message))
                .map(|_| Vec::new())
        }
        ClientMessage::MarkRead { .. }
        | ClientMessage::Pin { .. }
        | ClientMessage::SetIntent { .. } => Ok(Vec::new()),
        ClientMessage::Activate {
            request_id,
            card_id,
        } => {
            crate::db::enqueue_audit_log(
                &device.id,
                "activate",
                Some(&card_id),
                "activate session",
            );
            context
                .runtime
                .emit_activate_request(MobileCardRequest {
                    request_id,
                    card_id,
                })
                .map_err(|message| ("command_failed".to_string(), message))
                .map(|_| Vec::new())
        }
        ClientMessage::Spawn {
            request_id,
            terminal_type,
            project_path,
            command,
        } => {
            let summary = format!(
                "spawn metadata: terminal_type={}, project_path_bytes={}, command_present={}",
                terminal_type,
                project_path.len(),
                command
                    .as_ref()
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false)
            );
            crate::db::enqueue_audit_log(&device.id, "spawn", None, &summary);
            context
                .runtime
                .emit_spawn_request(MobileSpawnCardRequest {
                    request_id,
                    terminal_type,
                    project_path,
                    command,
                })
                .map_err(|message| ("command_failed".to_string(), message))
                .map(|_| Vec::new())
        }
        ClientMessage::RenameCard {
            request_id,
            card_id,
            project_name,
        } => {
            let rename_summary = format!("rename metadata: name_bytes={}", project_name.len());
            crate::db::enqueue_audit_log(
                &device.id,
                "rename_card",
                Some(&card_id),
                &rename_summary,
            );
            context
                .runtime
                .emit_rename_card_request(MobileRenameCardRequest {
                    request_id,
                    card_id,
                    project_name,
                })
                .map_err(|message| ("command_failed".to_string(), message))
                .map(|_| Vec::new())
        }
    };

    drop(authorization_lease);
    result
}

fn client_message_requires_full_authorization(message: &ClientMessage) -> bool {
    match message {
        ClientMessage::Input { .. }
        | ClientMessage::Resize { .. }
        | ClientMessage::Close { .. }
        | ClientMessage::Activate { .. }
        | ClientMessage::Spawn { .. }
        | ClientMessage::RenameCard { .. } => true,
        ClientMessage::Auth { .. }
        | ClientMessage::Subscribe { .. }
        | ClientMessage::TerminalResync
        | ClientMessage::Pin { .. }
        | ClientMessage::SetIntent { .. }
        | ClientMessage::MarkRead { .. }
        | ClientMessage::Ping => false,
    }
}

/// Mobile clients buffer keystrokes into a single batched payload (e.g.
/// "test\r"), but TUI AI CLIs such as `codex` distinguish typed input from
/// pasted input via timing — bytes arriving back-to-back can land in a paste
/// handler that never echoes into the input box, leaving the user staring at
/// a blank prompt. We split the payload into a "text body" portion and a
/// trailing submission key, writing the body in one go (so it lands in the
/// CLI's read buffer atomically) and then waiting long enough for the TUI to
/// commit the text into its input box before delivering the Enter/newline.
///
/// Lone single-byte payloads (e.g. a stray `\r`, `Ctrl-C`, `Esc`) bypass the
/// split entirely so their existing single-write semantics are preserved.
async fn paced_pty_input(
    context: &ServerContext,
    device: &BridgeDevice,
    card_id: &str,
    data: &str,
) -> Result<(), (String, String)> {
    validate_pty_input(data)?;
    if data.is_empty() {
        return Ok(());
    }

    let mut shutdown = context.shutdown.clone();
    let mut auth_revision = context.runtime.pairing.subscribe_auth_revision();

    // Pull off any trailing submit chars (`\r`, `\n`) so the CLI gets the
    // text body first and only then the Enter key. Sending them together can
    // cause the body to be discarded by paste/coalesce handlers.
    let (body, submit_tail) = split_submit_tail(data);

    if body.is_empty() && submit_tail.is_empty() {
        return Ok(());
    }

    if !body.is_empty() {
        let result = run_while_connection_active(
            context,
            device,
            &mut shutdown,
            &mut auth_revision,
            crate::pty::pty_input(card_id.to_string(), body.to_string()),
        )
        .await?;
        if let Err(message) = result {
            tracing::warn!(card_id = %card_id, %message, "pty_input failed for mobile bridge input body");
            return Err(("command_failed".to_string(), message));
        }
    }

    if !submit_tail.is_empty() {
        if !body.is_empty() {
            // Give the receiving CLI a beat to flush the text into its input
            // box before we deliver the Enter key. ~60ms is fast enough to
            // feel instant but slow enough that ratatui/crossterm-style TUI
            // event loops finish handling the prior bytes first.
            run_while_connection_active(
                context,
                device,
                &mut shutdown,
                &mut auth_revision,
                tokio::time::sleep(Duration::from_millis(60)),
            )
            .await?;
        }
        // Deliver Enter one byte at a time so each is treated as a distinct
        // key press rather than a paste sequence.
        for (i, byte) in submit_tail.as_bytes().iter().enumerate() {
            let single = (*byte as char).to_string();
            let result = run_while_connection_active(
                context,
                device,
                &mut shutdown,
                &mut auth_revision,
                crate::pty::pty_input(card_id.to_string(), single),
            )
            .await?;
            if let Err(message) = result {
                tracing::warn!(card_id = %card_id, %message, index = i, "pty_input failed for mobile bridge submit key");
                return Err(("command_failed".to_string(), message));
            }
            if i + 1 < submit_tail.len() {
                run_while_connection_active(
                    context,
                    device,
                    &mut shutdown,
                    &mut auth_revision,
                    tokio::time::sleep(Duration::from_millis(20)),
                )
                .await?;
            }
        }
    }

    Ok(())
}

fn validate_pty_input(data: &str) -> Result<(), (String, String)> {
    if data.len() > MAX_INPUT_BYTES {
        return Err((
            "payload_too_large".to_string(),
            format!("Terminal input exceeds the {MAX_INPUT_BYTES}-byte limit."),
        ));
    }
    let (_, submit_tail) = split_submit_tail(data);
    if submit_tail.len() > MAX_TRAILING_SUBMIT_KEYS {
        return Err((
            "invalid_input".to_string(),
            format!(
                "Terminal input may contain at most {MAX_TRAILING_SUBMIT_KEYS} trailing submit keys."
            ),
        ));
    }
    Ok(())
}

async fn run_while_connection_active<T, F>(
    context: &ServerContext,
    device: &BridgeDevice,
    shutdown: &mut watch::Receiver<bool>,
    auth_revision: &mut watch::Receiver<u64>,
    operation: F,
) -> Result<T, (String, String)>
where
    F: Future<Output = T>,
{
    tokio::select! {
        biased;
        _ = wait_for_bridge_shutdown(shutdown) => Err(bridge_stopped_error()),
        _ = wait_for_device_revocation(context, &device.id, auth_revision) => {
            Err(auth_revoked_error())
        }
        result = operation => {
            if *shutdown.borrow() {
                Err(bridge_stopped_error())
            } else if !context.runtime.pairing.is_device_active(&device.id) {
                Err(auth_revoked_error())
            } else {
                Ok(result)
            }
        }
    }
}

async fn wait_for_bridge_shutdown(shutdown: &mut watch::Receiver<bool>) {
    loop {
        if *shutdown.borrow() {
            return;
        }
        if shutdown.changed().await.is_err() {
            return;
        }
    }
}

async fn wait_for_device_revocation(
    context: &ServerContext,
    device_id: &str,
    auth_revision: &mut watch::Receiver<u64>,
) {
    loop {
        if !context.runtime.pairing.is_device_active(device_id) {
            return;
        }
        if auth_revision.changed().await.is_err() {
            return;
        }
    }
}

fn bridge_stopped_error() -> (String, String) {
    (
        "bridge_stopped".to_string(),
        "The mobile bridge was stopped.".to_string(),
    )
}

fn auth_revoked_error() -> (String, String) {
    (
        "auth_revoked".to_string(),
        "This mobile bridge authorization is no longer active.".to_string(),
    )
}

/// Split trailing line-submission chars (`\r`, `\n`) off the end of `data`.
fn split_submit_tail(data: &str) -> (&str, &str) {
    let bytes = data.as_bytes();
    let mut split = bytes.len();
    while split > 0 {
        let b = bytes[split - 1];
        if b == b'\r' || b == b'\n' {
            split -= 1;
        } else {
            break;
        }
    }
    (&data[..split], &data[split..])
}

fn authenticate_request(context: &ServerContext, headers: &HeaderMap) -> Option<BridgeDevice> {
    authenticate(context, bearer_token(headers))
}

fn browser_origin_matches_host(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Ok(origin_uri) = origin.parse::<Uri>() else {
        return false;
    };
    let Some(origin_authority) = origin_uri.authority() else {
        return false;
    };
    let Some(host_header) = headers.get(HOST).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let Ok(host_authority) = host_header.parse::<axum::http::uri::Authority>() else {
        return false;
    };
    if !origin_authority
        .host()
        .eq_ignore_ascii_case(host_authority.host())
    {
        return false;
    }
    let default_port = match origin_uri.scheme_str() {
        Some("https") => 443,
        Some("http") => 80,
        _ => return false,
    };
    origin_authority.port_u16().unwrap_or(default_port)
        == host_authority.port_u16().unwrap_or(default_port)
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?.trim();
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    if token.is_empty() {
        return None;
    }
    Some(token)
}

fn authenticate(context: &ServerContext, token: Option<&str>) -> Option<BridgeDevice> {
    context.runtime.pairing.validate_token(token?)
}

fn ensure_full_permission(device: &BridgeDevice) -> Result<(), (String, String)> {
    if device.permission == super::protocol::DevicePermission::Full {
        Ok(())
    } else {
        Err((
            "command_failed".to_string(),
            "This device is paired in read-only mode.".to_string(),
        ))
    }
}

async fn send_json(socket: &mut WebSocket, message: &ServerMessage) -> Result<(), axum::Error> {
    socket
        .send(Message::Text(
            serde_json::to_string(&versioned_server_message(message.clone())).unwrap_or_else(
                |_| {
                    format!(
                        r#"{{"protocol_version":{},"kind":"error","code":"serialize_failed","message":"Failed to serialize bridge message"}}"#,
                        super::protocol::PROTOCOL_VERSION
                    )
                },
            ),
        ))
        .await
}

async fn send_json_authorized(
    socket: &mut WebSocket,
    message: &ServerMessage,
    _lease: &AuthorizationLease<'_>,
) -> Result<(), axum::Error> {
    send_json(socket, message).await
}

async fn close_socket_with_error(socket: &mut WebSocket, code: &str, message: &str) {
    let _ = send_json(
        socket,
        &ServerMessage::Error {
            code: code.to_string(),
            message: message.to_string(),
        },
    )
    .await;
    let _ = socket.send(Message::Close(None)).await;
}

async fn close_socket_with_error_authorized(
    socket: &mut WebSocket,
    code: &str,
    message: &str,
    lease: &AuthorizationLease<'_>,
) {
    let _ = send_json_authorized(
        socket,
        &ServerMessage::Error {
            code: code.to_string(),
            message: message.to_string(),
        },
        lease,
    )
    .await;
    let _lease = lease;
    let _ = socket.send(Message::Close(None)).await;
}

fn summarize_input(data: &str) -> String {
    let chars = data.chars().count();
    let line_breaks = data.chars().filter(|ch| *ch == '\r' || *ch == '\n').count();
    let control_chars = data
        .chars()
        .filter(|ch| ch.is_control() && *ch != '\r' && *ch != '\n' && *ch != '\t')
        .count();
    let submit = data.ends_with('\r') || data.ends_with('\n');
    format!(
        "input metadata: bytes={}, chars={}, line_breaks={}, submit={}, control_chars={}",
        data.len(),
        chars,
        line_breaks,
        submit,
        control_chars
    )
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
    use crate::bridge::protocol::{BridgeTheme, ThemeMode};

    #[tokio::test]
    async fn mobile_bundle_serves_index_and_assets() {
        let index = mobile_asset_response("index.html");
        assert_eq!(index.status(), StatusCode::OK);
        assert_eq!(
            index.headers().get(CONTENT_TYPE),
            Some(&HeaderValue::from_static("text/html; charset=utf-8"))
        );
        assert_eq!(
            index.headers().get(CACHE_CONTROL),
            Some(&HeaderValue::from_static("no-store"))
        );
        assert_eq!(
            index.headers().get("content-security-policy"),
            Some(&HeaderValue::from_static(MOBILE_CONTENT_SECURITY_POLICY))
        );
        assert_eq!(
            index.headers().get("referrer-policy"),
            Some(&HeaderValue::from_static("no-referrer"))
        );
        assert_eq!(
            index.headers().get("x-content-type-options"),
            Some(&HeaderValue::from_static("nosniff"))
        );
        assert_eq!(
            index.headers().get("x-frame-options"),
            Some(&HeaderValue::from_static("DENY"))
        );
        let index_body = axum::body::to_bytes(index.into_body(), usize::MAX)
            .await
            .expect("index body");
        let index_html = std::str::from_utf8(&index_body).expect("index utf8");
        assert!(index_html.contains("/assets/index.js?v="));
        assert!(index_html.contains("/assets/vendor-react.js?v="));
        assert!(index_html.contains("/assets/vendor-xterm.js?v="));
        assert!(index_html.contains("/assets/index.css?v="));

        let js = mobile_asset_response("assets/index.js");
        assert_eq!(js.status(), StatusCode::OK);
        assert_eq!(
            js.headers().get(CONTENT_TYPE),
            Some(&HeaderValue::from_static(
                "application/javascript; charset=utf-8"
            ))
        );
        assert_eq!(
            js.headers().get(CACHE_CONTROL),
            Some(&HeaderValue::from_static("no-store"))
        );
    }

    #[test]
    fn mobile_bundle_falls_back_to_index_for_spa_paths() {
        let response = mobile_asset_response("cards/card-1");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(CONTENT_TYPE),
            Some(&HeaderValue::from_static("text/html; charset=utf-8"))
        );
    }

    #[test]
    fn mobile_bundle_returns_404_for_unknown_file_assets() {
        let response = mobile_asset_response("assets/missing.js");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.headers().get(CONTENT_TYPE),
            Some(&HeaderValue::from_static("text/plain; charset=utf-8"))
        );
    }

    #[test]
    fn initial_websocket_messages_send_theme_before_snapshot() {
        let runtime = Arc::new(BridgeRuntime::new());
        let theme = BridgeTheme {
            mode: ThemeMode::Light,
            ..BridgeTheme::default()
        };
        runtime.set_theme(theme);
        let (_shutdown_tx, shutdown) = watch::channel(false);
        let context = ServerContext {
            runtime,
            shutdown,
            connections: ConnectionTracker::default(),
        };

        let messages = initial_messages_for_client(&context);
        assert!(matches!(
            messages.first(),
            Some(ServerMessage::Theme {
                mode: ThemeMode::Light,
                ..
            })
        ));
        assert!(matches!(
            messages.get(1),
            Some(ServerMessage::Snapshot { .. })
        ));
        let runtime_id = context.runtime.runtime_id().to_string();
        assert!(matches!(
            messages.get(1),
            Some(ServerMessage::Snapshot {
                runtime_id: message_runtime_id,
                stream_seq: 0,
                ..
            }) if message_runtime_id == &runtime_id
        ));
    }

    #[tokio::test]
    async fn terminal_resync_returns_current_runtime_snapshot() {
        let runtime = Arc::new(BridgeRuntime::new());
        let (_shutdown_tx, shutdown) = watch::channel(false);
        let context = ServerContext {
            runtime,
            shutdown,
            connections: ConnectionTracker::default(),
        };
        let device = BridgeDevice {
            id: "device-1".to_string(),
            name: "test".to_string(),
            permission: super::super::protocol::DevicePermission::ReadOnly,
            client_class: super::super::protocol::ClientClass::LegacyTerminal,
            created_at: 0,
            last_seen_at: None,
        };

        let responses = handle_client_message(
            &context,
            &device,
            r#"{"protocol_version":1,"kind":"terminal_resync"}"#,
        )
        .await
        .expect("terminal resync");

        assert!(matches!(
            responses.first(),
            Some(ServerMessage::Theme { .. })
        ));
        assert!(matches!(
            responses.get(1),
            Some(ServerMessage::Snapshot { runtime_id, .. })
                if runtime_id == context.runtime.runtime_id()
        ));
    }

    #[test]
    fn bearer_token_parses_authorization_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer device-token"),
        );

        assert_eq!(bearer_token(&headers), Some("device-token"));

        headers.insert(AUTHORIZATION, HeaderValue::from_static("Basic nope"));
        assert_eq!(bearer_token(&headers), None);
    }

    #[test]
    fn summarize_input_records_metadata_without_raw_input() {
        let summary = summarize_input("run secret-token\r\n");

        assert_eq!(
            summary,
            "input metadata: bytes=18, chars=18, line_breaks=2, submit=true, control_chars=0"
        );
        assert!(!summary.contains("run"));
        assert!(!summary.contains("secret-token"));
        assert!(!summary.contains("\\r"));
        assert!(!summary.contains("\\n"));
    }

    #[test]
    fn summarize_input_counts_non_submit_control_chars() {
        assert_eq!(
            summarize_input("\u{1b}[A"),
            "input metadata: bytes=3, chars=3, line_breaks=0, submit=false, control_chars=1"
        );
    }

    #[test]
    fn terminal_input_limits_payload_and_submit_tail() {
        assert!(validate_pty_input(&"x".repeat(MAX_INPUT_BYTES)).is_ok());
        let oversized = validate_pty_input(&"x".repeat(MAX_INPUT_BYTES + 1))
            .expect_err("oversized input should be rejected");
        assert_eq!(oversized.0, "payload_too_large");

        assert!(
            validate_pty_input(&format!("run{}", "\r".repeat(MAX_TRAILING_SUBMIT_KEYS))).is_ok()
        );
        let excessive_submit =
            validate_pty_input(&format!("run{}", "\n".repeat(MAX_TRAILING_SUBMIT_KEYS + 1)))
                .expect_err("excessive submit tail should be rejected");
        assert_eq!(excessive_submit.0, "invalid_input");
    }

    #[tokio::test]
    async fn plaintext_v1_rejects_workspace_ops_with_secure_transport_required() {
        let runtime = Arc::new(BridgeRuntime::new());
        let (_shutdown_tx, shutdown) = watch::channel(false);
        let context = ServerContext {
            runtime,
            shutdown,
            connections: ConnectionTracker::default(),
        };
        let device = BridgeDevice {
            id: "device-1".to_string(),
            name: "test".to_string(),
            permission: super::super::protocol::DevicePermission::Full,
            client_class: super::super::protocol::ClientClass::LegacyTerminal,
            created_at: 0,
            last_seen_at: None,
        };

        let err = handle_client_message(
            &context,
            &device,
            r#"{"protocol_version":1,"kind":"read_file","request_id":"r1","workspace_id":"w","relative_path":"a.rs"}"#,
        )
        .await
        .expect_err("workspace on v1");
        assert_eq!(err.0, "secure_transport_required");

        let err = handle_client_message(
            &context,
            &device,
            r#"{"protocol_version":2,"kind":"read_file","request_id":"r","workspace_id":"w","relative_path":"a.rs"}"#,
        )
        .await
        .expect_err("v2 workspace on plaintext");
        assert_eq!(err.0, "secure_transport_required");
    }

    #[tokio::test]
    async fn paced_operation_cancels_for_shutdown_or_revoked_device() {
        let runtime = Arc::new(BridgeRuntime::new());
        let (shutdown_tx, shutdown) = watch::channel(false);
        let context = ServerContext {
            runtime,
            shutdown,
            connections: ConnectionTracker::default(),
        };
        let device = BridgeDevice {
            id: "missing-device".to_string(),
            name: "test".to_string(),
            permission: super::super::protocol::DevicePermission::Full,
            client_class: super::super::protocol::ClientClass::LegacyTerminal,
            created_at: 0,
            last_seen_at: None,
        };

        let mut shutdown_rx = context.shutdown.clone();
        let mut auth_revision = context.runtime.pairing.subscribe_auth_revision();
        let revoked = run_while_connection_active(
            &context,
            &device,
            &mut shutdown_rx,
            &mut auth_revision,
            std::future::pending::<()>(),
        )
        .await
        .expect_err("missing device should cancel the operation");
        assert_eq!(revoked.0, "auth_revoked");

        shutdown_tx.send(true).expect("signal shutdown");
        let mut shutdown_rx = context.shutdown.clone();
        let mut auth_revision = context.runtime.pairing.subscribe_auth_revision();
        let stopped = run_while_connection_active(
            &context,
            &device,
            &mut shutdown_rx,
            &mut auth_revision,
            std::future::pending::<()>(),
        )
        .await
        .expect_err("shutdown should cancel the operation");
        assert_eq!(stopped.0, "bridge_stopped");
    }

    #[tokio::test]
    async fn passive_expiry_cancels_authorized_pacing_tail() {
        let runtime = Arc::new(BridgeRuntime::new());
        let qr = runtime.pairing.create_pair_qr(
            "127.0.0.1".to_string(),
            5174,
            super::super::protocol::DevicePermission::Full,
        );
        let paired = runtime
            .pairing
            .pair(super::super::protocol::PairRequest {
                otp: qr.otp,
                device_name: "expiry-tail".to_string(),
                permission: Some(super::super::protocol::DevicePermission::Full),
            })
            .expect("pair full-control device");
        let (_shutdown_tx, shutdown) = watch::channel(false);
        let context = ServerContext {
            runtime,
            shutdown,
            connections: ConnectionTracker::default(),
        };
        let lease = context
            .runtime
            .pairing
            .acquire_full_lease(&paired.device.id)
            .expect("acquire authorization lease");
        let expiry_runtime = context.runtime.clone();
        let device_id = paired.device.id.clone();
        let expire = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            expiry_runtime.pairing.expire_device(&device_id);
        });

        let mut shutdown_rx = context.shutdown.clone();
        let mut auth_revision = context.runtime.pairing.subscribe_auth_revision();
        let error = run_while_connection_active(
            &context,
            &paired.device,
            &mut shutdown_rx,
            &mut auth_revision,
            tokio::time::sleep(Duration::from_secs(1)),
        )
        .await
        .expect_err("expiry should cancel a pending input tail");
        assert_eq!(error.0, "auth_revoked");

        expire.await.expect("expiry task");
        drop(lease);
    }

    #[tokio::test]
    async fn connection_tracker_aborts_and_drains_registered_task() {
        let tracker = ConnectionTracker::default();
        let (connection, mut force_abort) = tracker.register();
        let task = tokio::spawn(async move {
            let _connection = connection;
            wait_for_bridge_shutdown(&mut force_abort).await;
        });
        assert_eq!(tracker.active_count(), 1);

        tracker.abort_all();
        tokio::time::timeout(Duration::from_secs(1), tracker.wait_for_idle())
            .await
            .expect("aborted connection should drain");
        task.await.expect("tracked task should exit cleanly");
        assert_eq!(tracker.active_count(), 0);

        let (late_connection, mut late_abort) = tracker.register();
        assert!(
            *late_abort.borrow(),
            "force-abort must remain latched for late registrations"
        );
        let late_task = tokio::spawn(async move {
            let _late_connection = late_connection;
            wait_for_bridge_shutdown(&mut late_abort).await;
        });
        tokio::time::timeout(Duration::from_secs(1), tracker.wait_for_idle())
            .await
            .expect("late connection should observe retained cancellation");
        late_task.await.expect("late tracked task should exit");
    }

    #[tokio::test]
    async fn http_request_is_tracked_before_json_extraction() {
        use tokio::io::AsyncWriteExt;

        let runtime = Arc::new(BridgeRuntime::new());
        let mut handle = start(runtime, "127.0.0.1".to_string(), 0)
            .await
            .expect("start bridge server");
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", handle.port))
            .await
            .expect("connect bridge server");
        stream
            .write_all(
                format!(
                    "POST /pair HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: 128\r\n\r\n{{",
                    handle.port
                )
                .as_bytes(),
            )
            .await
            .expect("write partial pair request");

        tokio::time::timeout(Duration::from_secs(1), async {
            while handle.connections.active_count() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("request should be tracked while JSON extraction waits for its body");

        drop(stream);
        tokio::time::timeout(Duration::from_secs(1), handle.connections.wait_for_idle())
            .await
            .expect("dropped HTTP request should drain");
        handle
            .stop(Duration::from_secs(1))
            .await
            .expect("server should stop after request drain");
    }

    #[tokio::test]
    async fn server_stop_reports_uninterruptible_tracked_work() {
        let tracker = ConnectionTracker::default();
        let (connection, _force_abort) = tracker.register();
        let (shutdown, _shutdown_rx) = watch::channel(false);
        let join = tokio::spawn(std::future::pending::<()>());
        let mut handle = BridgeServerHandle {
            host: "127.0.0.1".to_string(),
            port: 0,
            shutdown,
            join: Some(join),
            connections: tracker.clone(),
        };

        let error = handle
            .stop(Duration::from_millis(10))
            .await
            .expect_err("stop must not report success while tracked work remains");
        assert!(error.contains("did not stop before the deadline"));
        assert!(error.contains("remained after forced cancellation"));
        assert!(*tracker.inner.force_abort.borrow());

        drop(connection);
        tokio::time::timeout(Duration::from_secs(1), tracker.wait_for_idle())
            .await
            .expect("simulated blocking work should drain after release");
        handle
            .stop(Duration::from_secs(1))
            .await
            .expect("retry should succeed after tracked work drains");
    }
}
