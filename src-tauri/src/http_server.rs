use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, Query, State, WebSocketUpgrade,
    },
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::net::UdpSocket;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

pub struct AppState {
    pub app_handle: tauri::AppHandle,
    pub lan_ip: String,
    pub dist_path: PathBuf,
}

/// Detect the local LAN IP address by connecting a UDP socket to a public address.
/// This doesn't actually send any data, just lets the OS pick the right interface.
fn detect_local_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("8.8.8.8:80")?;
            socket.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

pub async fn start_http_server(app_handle: tauri::AppHandle) {
    let lan_ip = detect_local_ip();
    tracing::info!("[http-server] Local IP: {}", lan_ip);

    // Determine the dist path: try multiple candidates for dev and production
    let dist_path = {
        let exe = std::env::current_exe().unwrap_or_default();
        let exe_dir = exe.parent().unwrap_or(std::path::Path::new("."));
        let candidates = [
            exe_dir.join("../../../dist"),   // dev: target/debug/../../../dist
            exe_dir.join("dist"),             // prod flat
            PathBuf::from("dist"),            // cwd
        ];
        candidates
            .into_iter()
            .find(|p| p.join("index.html").exists())
            .unwrap_or_else(|| PathBuf::from("dist"))
    };

    tracing::info!(
        "[http-server] Serving static files from: {}",
        dist_path.display()
    );

    let state = Arc::new(AppState {
        app_handle,
        lan_ip: lan_ip.clone(),
        dist_path,
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        // API routes
        .route("/health", get(health_handler))
        .route("/api/local-ip", get(local_ip_handler))
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions", post(create_session))
        .route("/api/sessions/{id}/send", post(send_to_session))
        .route("/api/sessions/{id}/kill", post(kill_session))
        .route("/api/projects", get(list_projects))
        .route("/api/projects", post(add_project))
        .route("/api/projects/remove", post(remove_project))
        .route("/api/session-history", get(list_session_history))
        .route("/api/session-history/{session_id}/messages", get(get_session_messages))
        .route("/api/pty/{id}/ws", get(pty_ws_handler))
        .route("/ws", get(ws_handler))
        // SPA fallback: serve static files or index.html
        .fallback(get(static_file_handler))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3002").await;
    match listener {
        Ok(l) => {
            tracing::info!(
                "[http-server] Listening on http://0.0.0.0:3002 (LAN: http://{}:3002)",
                lan_ip
            );
            if let Err(e) = axum::serve(l, app).await {
                tracing::error!("[http-server] Server error: {e}");
            }
        }
        Err(e) => {
            tracing::error!("[http-server] Failed to bind port 3002: {e}");
        }
    }
}

// ── Static File Serving (SPA) ────────────────────────────────────────────────

/// Guess MIME type from file extension.
fn mime_for_path(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        Some("map") => "application/json",
        _ => "application/octet-stream",
    }
}

async fn static_file_handler(
    State(state): State<Arc<AppState>>,
    uri: Uri,
) -> Response {
    let path = uri.path().trim_start_matches('/');

    // Try the exact file path first
    let file_path = state.dist_path.join(path);
    if file_path.is_file() {
        if let Ok(contents) = tokio::fs::read(&file_path).await {
            let mime = mime_for_path(&file_path);
            return Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
                .body(axum::body::Body::from(contents))
                .unwrap();
        }
    }

    // SPA fallback: serve index.html for client-side routes
    let index_path = state.dist_path.join("index.html");
    match tokio::fs::read(&index_path).await {
        Ok(contents) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(axum::body::Body::from(contents))
            .unwrap(),
        Err(_) => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "text/plain")
            .body(axum::body::Body::from(
                "dist/ not found. Run 'npm run build' first.",
            ))
            .unwrap(),
    }
}

async fn health_handler(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "app": "openwork",
        "lanUrl": format!("http://{}:3002", state.lan_ip)
    }))
}

async fn local_ip_handler(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ip": state.lan_ip,
        "url": format!("http://{}:3002", state.lan_ip)
    }))
}

// ── Sessions ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct SessionInfo {
    id: String,
    state: String,
    provider: Option<String>,
}

async fn list_sessions(State(_state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let sessions = crate::pty::list_sessions_internal();
    let result: Vec<SessionInfo> = sessions
        .into_iter()
        .map(|(id, s)| SessionInfo {
            id,
            state: format!("{:?}", s),
            provider: None,
        })
        .collect();
    Json(serde_json::json!({ "sessions": result }))
}

#[derive(Deserialize)]
struct CreateSessionRequest {
    project_path: String,
    provider: Option<String>,
    resume_session_id: Option<String>,
}

async fn create_session(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateSessionRequest>,
) -> Json<serde_json::Value> {
    let handle = state.app_handle.clone();
    let provider = req.provider.unwrap_or_else(|| "claude".to_string());
    let result = tokio::task::spawn_blocking(move || {
        crate::ai::start_session_internal(
            &handle,
            req.project_path,
            provider,
            req.resume_session_id,
        )
    })
    .await
    .unwrap_or_else(|e| Err(format!("task error: {e}")));

    match result {
        Ok(pty_id) => Json(serde_json::json!({ "ok": true, "ptyId": pty_id })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Deserialize)]
struct SendRequest {
    text: String,
}

async fn send_to_session(
    Path(id): Path<String>,
    State(_state): State<Arc<AppState>>,
    Json(req): Json<SendRequest>,
) -> Json<serde_json::Value> {
    let result = crate::pty::pty_write_internal(&id, req.text);
    match result {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

async fn kill_session(
    Path(id): Path<String>,
    State(_state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    let result = crate::pty::pty_kill_internal(&id);
    match result {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

// ── Projects ─────────────────────────────────────────────────────────────────

async fn list_projects() -> Json<serde_json::Value> {
    match crate::projects::projects_list().await {
        Ok(projects) => Json(serde_json::json!(projects)),
        Err(e) => Json(serde_json::json!({ "error": e })),
    }
}

#[derive(Deserialize)]
struct AddProjectRequest {
    name: String,
    path: String,
}

async fn add_project(Json(req): Json<AddProjectRequest>) -> Json<serde_json::Value> {
    match crate::projects::projects_add(req.name, req.path).await {
        Ok(project) => Json(serde_json::json!(project)),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Deserialize)]
struct RemoveProjectRequest {
    path: String,
}

async fn remove_project(Json(req): Json<RemoveProjectRequest>) -> Json<serde_json::Value> {
    match crate::projects::projects_remove(req.path).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

// ── Session History ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SessionHistoryQuery {
    project_path: Option<String>,
    provider: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

async fn list_session_history(
    Query(q): Query<SessionHistoryQuery>,
) -> Json<serde_json::Value> {
    let project_path = q.project_path.unwrap_or_default();
    let provider = q.provider.unwrap_or_else(|| "claude".to_string());
    match crate::session_history::session_list(project_path, provider, q.limit, q.offset).await {
        Ok(sessions) => Json(serde_json::json!(sessions)),
        Err(e) => Json(serde_json::json!({ "error": e })),
    }
}

#[derive(Deserialize)]
struct SessionMessagesQuery {
    project_path: Option<String>,
    provider: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

async fn get_session_messages(
    Path(session_id): Path<String>,
    Query(q): Query<SessionMessagesQuery>,
) -> Json<serde_json::Value> {
    let project_path = q.project_path.unwrap_or_default();
    let provider = q.provider.unwrap_or_else(|| "claude".to_string());
    match crate::session_history::session_messages(project_path, session_id, q.limit, q.offset, Some(provider)).await {
        Ok(msgs) => Json(serde_json::json!(msgs)),
        Err(e) => Json(serde_json::json!({ "error": e })),
    }
}



async fn pty_ws_handler(
    ws: WebSocketUpgrade,
    Path(id): Path<String>,
    State(_state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_pty_ws(socket, id))
}

async fn handle_pty_ws(mut socket: WebSocket, session_id: String) {
    // Subscribe to PTY output broadcast channel
    let mut rx = crate::pty::register_ws_channel(&session_id);

    // Send recent output as history replay
    if let Some(recent) = crate::pty::get_recent_output(&session_id) {
        let payload = serde_json::json!({
            "type": "pty-history",
            "id": session_id,
            "data": recent
        });
        let _ = socket
            .send(Message::Text(payload.to_string().into()))
            .await;
    }

    loop {
        tokio::select! {
            // Forward PTY output to WS client
            result = rx.recv() => {
                match result {
                    Ok(msg) => {
                        if socket.send(Message::Text(msg.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                }
            }
            // Forward WS input to PTY
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let text_str: &str = &text;
                        if let Ok(cmd) = serde_json::from_str::<serde_json::Value>(text_str) {
                            if cmd["type"] == "pty-input" {
                                if let Some(data) = cmd["data"].as_str() {
                                    let _ = crate::pty::pty_write_internal(&session_id, data.to_string());
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }
}

// ── General WebSocket ────────────────────────────────────────────────────────

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_ws(socket, state))
}

async fn handle_ws(mut socket: WebSocket, state: Arc<AppState>) {
    let _app = state.app_handle.clone();

    let welcome = serde_json::json!({
        "type": "connected",
        "app": "openwork",
        "version": "1.0"
    });
    let _ = socket
        .send(Message::Text(welcome.to_string().into()))
        .await;

    while let Some(msg) = socket.recv().await {
        match msg {
            Ok(Message::Text(text)) => {
                let text_str: &str = &text;
                if let Ok(cmd) = serde_json::from_str::<serde_json::Value>(text_str) {
                    handle_ws_command(&mut socket, cmd).await;
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }
}

async fn handle_ws_command(socket: &mut WebSocket, cmd: serde_json::Value) {
    let cmd_type = cmd["type"].as_str().unwrap_or("");
    match cmd_type {
        "ping" => {
            let _ = socket
                .send(Message::Text(
                    serde_json::json!({ "type": "pong" }).to_string().into(),
                ))
                .await;
        }
        "list_sessions" => {
            let sessions = crate::pty::list_sessions_internal();
            let result: Vec<_> = sessions
                .into_iter()
                .map(|(id, state)| {
                    serde_json::json!({
                        "id": id,
                        "state": format!("{:?}", state)
                    })
                })
                .collect();
            let _ = socket
                .send(Message::Text(
                    serde_json::json!({ "type": "sessions", "data": result })
                        .to_string()
                        .into(),
                ))
                .await;
        }
        _ => {}
    }
}
