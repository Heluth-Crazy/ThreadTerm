use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

pub struct AppState {
    pub app_handle: tauri::AppHandle,
}

pub async fn start_http_server(app_handle: tauri::AppHandle) {
    let state = Arc::new(AppState { app_handle });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions", post(create_session))
        .route("/api/sessions/:id/send", post(send_to_session))
        .route("/ws", get(ws_handler))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3002").await;
    match listener {
        Ok(l) => {
            tracing::info!("[http-server] Listening on http://0.0.0.0:3002");
            if let Err(e) = axum::serve(l, app).await {
                tracing::error!("[http-server] Server error: {e}");
            }
        }
        Err(e) => {
            tracing::error!("[http-server] Failed to bind port 3002: {e}");
        }
    }
}

async fn health_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "app": "openwork" }))
}

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
    let result = crate::ai::start_session_internal(
        &state.app_handle,
        req.project_path,
        req.provider.unwrap_or_else(|| "claude".to_string()),
        req.resume_session_id,
    );

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
    axum::extract::Path(id): axum::extract::Path<String>,
    State(_state): State<Arc<AppState>>,
    Json(req): Json<SendRequest>,
) -> Json<serde_json::Value> {
    let result = crate::pty::pty_write_internal(&id, req.text);
    match result {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_ws(socket, state))
}

async fn handle_ws(mut socket: WebSocket, state: Arc<AppState>) {
    let app = state.app_handle.clone();

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
                    handle_ws_command(&mut socket, &app, cmd).await;
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }
}

async fn handle_ws_command(
    socket: &mut WebSocket,
    _app: &tauri::AppHandle,
    cmd: serde_json::Value,
) {
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
