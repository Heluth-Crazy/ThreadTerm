use std::{
    net::SocketAddr,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{
        header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE},
        HeaderMap, HeaderValue, Method, StatusCode, Uri,
    },
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use tokio::{
    net::TcpListener,
    sync::{broadcast, oneshot},
    task::JoinHandle,
};
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};

use super::{
    protocol::{
        parse_client_message, versioned_server_message, BridgeDevice, ClientMessage,
        MobileCardRequest, MobileSpawnCardRequest, PairRequest, ServerMessage,
        VersionedServerMessage,
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

pub struct BridgeServerHandle {
    pub host: String,
    pub port: u16,
    pub shutdown: Option<oneshot::Sender<()>>,
    pub _join: JoinHandle<()>,
}

#[derive(Clone)]
struct ServerContext {
    runtime: Arc<BridgeRuntime>,
}

#[derive(Deserialize)]
struct AuthQuery {
    token: Option<String>,
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
    let context = ServerContext { runtime };
    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/snapshot", get(snapshot_handler))
        .route("/pair", get(pair_page_handler).post(pair_handler))
        .route("/ws", get(ws_handler))
        .fallback(get(mobile_static_handler))
        .layer(mobile_bridge_cors_layer())
        .layer(TraceLayer::new_for_http())
        .with_state(context);

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    // We deliberately use `tokio::spawn` instead of `tauri::async_runtime::spawn`
    // here. The Tauri global async runtime is a separate Tokio reactor, but
    // the `TcpListener` we just bound is registered with whichever runtime
    // called `bridge_start`. Spawning the `accept` loop on a different
    // reactor produces sporadic `Connection refused` errors (and broke the
    // S2-1 wscat-style integration test). Plain `tokio::spawn` reuses the
    // current runtime and keeps the listener and acceptor co-located.
    let join = tokio::spawn(async move {
        let server = axum::serve(listener, app).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        if let Err(error) = server.await {
            tracing::warn!(error = %error, "Mobile bridge server stopped with error");
        }
    });

    Ok(BridgeServerHandle {
        host,
        port: local_addr.port(),
        shutdown: Some(shutdown_tx),
        _join: join,
    })
}

fn mobile_bridge_cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE])
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

    match file {
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
    }
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
    Query(query): Query<AuthQuery>,
    headers: HeaderMap,
) -> Result<Json<VersionedServerMessage>, StatusCode> {
    authenticate_request(&context, query.token.as_deref(), &headers)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(Json(versioned_server_message(
        context.runtime.snapshot().into(),
    )))
}

async fn pair_handler(
    State(context): State<ServerContext>,
    Json(request): Json<PairRequest>,
) -> Result<Json<super::protocol::PairResponse>, (StatusCode, String)> {
    context
        .runtime
        .pairing
        .pair(request)
        .map(Json)
        .map_err(|message| (StatusCode::UNAUTHORIZED, message))
}

async fn ws_handler(
    State(context): State<ServerContext>,
    Query(query): Query<AuthQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    let device = authenticate_request(&context, query.token.as_deref(), &headers);
    Ok(ws.on_upgrade(move |socket| handle_socket(context, device, socket)))
}

async fn handle_socket(
    context: ServerContext,
    mut device: Option<BridgeDevice>,
    mut socket: WebSocket,
) {
    let mut rx = context.runtime.subscribe();
    if device.is_some() {
        if send_initial_messages(&context, &mut socket).await.is_err() {
            return;
        }
    }

    loop {
        tokio::select! {
            outbound = rx.recv() => {
                if device.is_none() {
                    continue;
                }
                match outbound {
                    Ok(message) => {
                        if send_json(&mut socket, &message).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let message = ServerMessage::Error {
                            code: "backpressure".to_string(),
                            message: "Client fell behind; intermediate events were dropped.".to_string(),
                        };
                        if send_json(&mut socket, &message).await.is_err() {
                            break;
                        }
                        let mut resync_failed = false;
                        for message in initial_messages_for_client(&context) {
                            if send_json(&mut socket, &message).await.is_err() {
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
                            tracing::info!(
                                device_id = device.as_ref().map(|device| device.id.as_str()).unwrap_or("unauthenticated"),
                                raw_len = text.len(),
                                "Mobile bridge raw input frame"
                            );
                        }
                        let Some(current_device) = device.as_ref() else {
                            match authenticate_socket_message(&context, &text) {
                                Ok(authenticated) => {
                                    device = Some(authenticated);
                                    if send_initial_messages(&context, &mut socket).await.is_err() {
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
                        if let Err((code, message)) = handle_client_message(&context, current_device, &text).await {
                            tracing::warn!(code = %code, message = %message, "Mobile bridge client message rejected");
                            let _ = send_json(&mut socket, &ServerMessage::Error {
                                code: code.clone(),
                                message,
                            }).await;
                            if code == "protocol_version_mismatch" {
                                break;
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
    socket: &mut WebSocket,
) -> Result<(), axum::Error> {
    for message in initial_messages_for_client(context) {
        send_json(socket, &message).await?;
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
        .filter_map(|card| super::terminal_snapshot_message(&card.id))
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
) -> Result<(), (String, String)> {
    let message: ClientMessage =
        parse_client_message(text).map_err(|e| (e.error_code().to_string(), e.to_string()))?;

    match message {
        ClientMessage::Auth { .. } => Ok(()),
        ClientMessage::Subscribe { .. } => Ok(()),
        ClientMessage::Ping => {
            context
                .runtime
                .broadcast(ServerMessage::Pong { t: now_millis() });
            Ok(())
        }
        ClientMessage::Input { card_id, data } => {
            ensure_full_permission(device)?;
            let pty_id = context.runtime.pty_id_for_card(&card_id);
            let input_summary = summarize_input(&data);
            tracing::info!(
                device_id = %device.id,
                card_id = %card_id,
                pty_id = %pty_id,
                len = data.len(),
                summary = %input_summary,
                "Mobile bridge input received"
            );
            crate::db::insert_audit_log(&device.id, "input", Some(&card_id), &input_summary)
                .map_err(|e| {
                    (
                        "command_failed".to_string(),
                        format!("Failed to audit input: {e}"),
                    )
                })?;
            paced_pty_input(&pty_id, &data).await
        }
        ClientMessage::Resize {
            card_id,
            cols,
            rows,
        } => {
            ensure_full_permission(device)?;
            let pty_id = context.runtime.pty_id_for_card(&card_id);
            crate::pty::pty_resize(pty_id, rows, cols)
                .await
                .map_err(|message| ("command_failed".to_string(), message))
        }
        ClientMessage::Close {
            card_id,
            request_id,
        } => {
            ensure_full_permission(device)?;
            crate::db::insert_audit_log(&device.id, "close", Some(&card_id), "close session")
                .map_err(|e| {
                    (
                        "command_failed".to_string(),
                        format!("Failed to audit close: {e}"),
                    )
                })?;
            let request_id =
                request_id.unwrap_or_else(|| format!("close:{}:{}", card_id, now_millis()));
            context
                .runtime
                .emit_remove_request(MobileCardRequest {
                    request_id,
                    card_id,
                })
                .map_err(|message| ("command_failed".to_string(), message))
        }
        ClientMessage::MarkRead { .. }
        | ClientMessage::Pin { .. }
        | ClientMessage::SetIntent { .. } => Ok(()),
        ClientMessage::Activate {
            request_id,
            card_id,
        } => {
            ensure_full_permission(device)?;
            crate::db::insert_audit_log(&device.id, "activate", Some(&card_id), "activate session")
                .map_err(|e| {
                    (
                        "command_failed".to_string(),
                        format!("Failed to audit activate: {e}"),
                    )
                })?;
            context
                .runtime
                .emit_activate_request(MobileCardRequest {
                    request_id,
                    card_id,
                })
                .map_err(|message| ("command_failed".to_string(), message))
        }
        ClientMessage::Spawn {
            request_id,
            terminal_type,
            project_path,
            command,
        } => {
            ensure_full_permission(device)?;
            let summary = format!(
                "spawn metadata: terminal_type={}, project_path_bytes={}, command_present={}",
                terminal_type,
                project_path.len(),
                command
                    .as_ref()
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false)
            );
            crate::db::insert_audit_log(&device.id, "spawn", None, &summary).map_err(|e| {
                (
                    "command_failed".to_string(),
                    format!("Failed to audit spawn: {e}"),
                )
            })?;
            context
                .runtime
                .emit_spawn_request(MobileSpawnCardRequest {
                    request_id,
                    terminal_type,
                    project_path,
                    command,
                })
                .map_err(|message| ("command_failed".to_string(), message))
        }
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
async fn paced_pty_input(card_id: &str, data: &str) -> Result<(), (String, String)> {
    if data.is_empty() {
        return Ok(());
    }

    // Pull off any trailing submit chars (`\r`, `\n`) so the CLI gets the
    // text body first and only then the Enter key. Sending them together can
    // cause the body to be discarded by paste/coalesce handlers.
    let (body, submit_tail) = split_submit_tail(data);

    if body.is_empty() && submit_tail.is_empty() {
        return Ok(());
    }

    if !body.is_empty() {
        if let Err(message) = crate::pty::pty_input(card_id.to_string(), body.to_string()).await {
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
            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        }
        // Deliver Enter one byte at a time so each is treated as a distinct
        // key press rather than a paste sequence.
        for (i, byte) in submit_tail.as_bytes().iter().enumerate() {
            let single = (*byte as char).to_string();
            if let Err(message) = crate::pty::pty_input(card_id.to_string(), single).await {
                tracing::warn!(card_id = %card_id, %message, index = i, "pty_input failed for mobile bridge submit key");
                return Err(("command_failed".to_string(), message));
            }
            if i + 1 < submit_tail.len() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        }
    }

    Ok(())
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

fn authenticate_request(
    context: &ServerContext,
    query_token: Option<&str>,
    headers: &HeaderMap,
) -> Option<BridgeDevice> {
    let header_token = bearer_token(headers);
    if query_token.is_some() {
        tracing::debug!(
            "Mobile bridge query-token auth path is deprecated; prefer Authorization bearer or websocket auth frame"
        );
    }
    authenticate(context, header_token.or(query_token))
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
        let mut theme = BridgeTheme::default();
        theme.mode = ThemeMode::Light;
        runtime.set_theme(theme);
        let context = ServerContext { runtime };

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
}
