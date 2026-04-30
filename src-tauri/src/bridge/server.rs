use std::{
    net::SocketAddr,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use tauri::async_runtime::JoinHandle;
use tokio::{
    net::TcpListener,
    sync::{broadcast, oneshot},
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use super::{
    protocol::{BridgeDevice, ClientMessage, PairRequest, ServerMessage},
    BridgeRuntime,
};

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
        .route("/pair", post(pair_handler))
        .route("/ws", get(ws_handler))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(context);

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let join = tauri::async_runtime::spawn(async move {
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

async fn health_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "name": "ThreadTerm mobile bridge"
    }))
}

async fn snapshot_handler(
    State(context): State<ServerContext>,
    Query(query): Query<AuthQuery>,
) -> Result<Json<ServerMessage>, StatusCode> {
    authenticate(&context, query.token.as_deref())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(Json(context.runtime.snapshot().into()))
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
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    let device = authenticate(&context, query.token.as_deref())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(ws.on_upgrade(move |socket| handle_socket(context, device, socket)))
}

async fn handle_socket(context: ServerContext, device: BridgeDevice, mut socket: WebSocket) {
    let initial = ServerMessage::from(context.runtime.snapshot());
    if send_json(&mut socket, &initial).await.is_err() {
        return;
    }

    let mut rx = context.runtime.subscribe();

    loop {
        tokio::select! {
            outbound = rx.recv() => {
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
                        let _ = send_json(&mut socket, &message).await;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if let Err(message) = handle_client_message(&context, &device, &text).await {
                            let _ = send_json(&mut socket, &ServerMessage::Error {
                                code: "command_failed".to_string(),
                                message,
                            }).await;
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

async fn handle_client_message(
    context: &ServerContext,
    device: &BridgeDevice,
    text: &str,
) -> Result<(), String> {
    let message: ClientMessage = serde_json::from_str(text)
        .map_err(|e| format!("Invalid client message: {e}"))?;

    match message {
        ClientMessage::Subscribe { .. } => Ok(()),
        ClientMessage::Ping => {
            context.runtime.broadcast(ServerMessage::Pong { t: now_millis() });
            Ok(())
        }
        ClientMessage::Input { card_id, data } => {
            ensure_full_permission(device)?;
            crate::db::insert_audit_log(
                &device.id,
                "input",
                Some(&card_id),
                &summarize_input(&data),
            )
            .map_err(|e| format!("Failed to audit input: {e}"))?;
            crate::pty::pty_input(card_id, data).await
        }
        ClientMessage::Resize { card_id, cols, rows } => {
            ensure_full_permission(device)?;
            crate::pty::pty_resize(card_id, rows, cols).await
        }
        ClientMessage::Close { card_id } => {
            ensure_full_permission(device)?;
            crate::db::insert_audit_log(&device.id, "close", Some(&card_id), "close session")
                .map_err(|e| format!("Failed to audit close: {e}"))?;
            crate::pty::pty_kill(card_id).await
        }
        ClientMessage::MarkRead { .. }
        | ClientMessage::Pin { .. }
        | ClientMessage::SetIntent { .. } => Ok(()),
        ClientMessage::Spawn { .. } => {
            Err("Remote spawn is not implemented in Stage 1.".to_string())
        }
    }
}

fn authenticate(context: &ServerContext, token: Option<&str>) -> Option<BridgeDevice> {
    context.runtime.pairing.validate_token(token?)
}

fn ensure_full_permission(device: &BridgeDevice) -> Result<(), String> {
    if device.permission == super::protocol::DevicePermission::Full {
        Ok(())
    } else {
        Err("This device is paired in read-only mode.".to_string())
    }
}

async fn send_json(socket: &mut WebSocket, message: &ServerMessage) -> Result<(), axum::Error> {
    socket
        .send(Message::Text(
            serde_json::to_string(message).unwrap_or_else(|_| {
                r#"{"kind":"error","code":"serialize_failed","message":"Failed to serialize bridge message"}"#
                    .to_string()
            }),
        ))
        .await
}

fn summarize_input(data: &str) -> String {
    let mut value = data.replace('\r', "\\r").replace('\n', "\\n");
    if value.len() > 240 {
        value.truncate(240);
        value.push('…');
    }
    value
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
