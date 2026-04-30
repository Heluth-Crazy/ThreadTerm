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
    response::{Html, IntoResponse},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use tokio::{
    net::TcpListener,
    sync::{broadcast, oneshot},
    task::JoinHandle,
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use super::{
    protocol::{
        parse_client_message, versioned_server_message, BridgeDevice, ClientMessage, PairRequest,
        ServerMessage, VersionedServerMessage,
    },
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

#[derive(Deserialize)]
struct PairPageQuery {
    otp: Option<String>,
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
        .layer(CorsLayer::permissive())
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

async fn health_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "name": "ThreadTerm mobile bridge"
    }))
}

async fn pair_page_handler(Query(query): Query<PairPageQuery>) -> Html<String> {
    Html(pair_page_html(query.otp.as_deref()))
}

async fn snapshot_handler(
    State(context): State<ServerContext>,
    Query(query): Query<AuthQuery>,
) -> Result<Json<VersionedServerMessage>, StatusCode> {
    authenticate(&context, query.token.as_deref()).ok_or(StatusCode::UNAUTHORIZED)?;
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
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    let device = authenticate(&context, query.token.as_deref()).ok_or(StatusCode::UNAUTHORIZED)?;
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
                        if let Err((code, message)) = handle_client_message(&context, &device, &text).await {
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

async fn handle_client_message(
    context: &ServerContext,
    device: &BridgeDevice,
    text: &str,
) -> Result<(), (String, String)> {
    let message: ClientMessage =
        parse_client_message(text).map_err(|e| (e.error_code().to_string(), e.to_string()))?;

    match message {
        ClientMessage::Subscribe { .. } => Ok(()),
        ClientMessage::Ping => {
            context
                .runtime
                .broadcast(ServerMessage::Pong { t: now_millis() });
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
            .map_err(|e| {
                (
                    "command_failed".to_string(),
                    format!("Failed to audit input: {e}"),
                )
            })?;
            crate::pty::pty_input(card_id, data)
                .await
                .map_err(|message| ("command_failed".to_string(), message))
        }
        ClientMessage::Resize {
            card_id,
            cols,
            rows,
        } => {
            ensure_full_permission(device)?;
            crate::pty::pty_resize(card_id, rows, cols)
                .await
                .map_err(|message| ("command_failed".to_string(), message))
        }
        ClientMessage::Close { card_id } => {
            ensure_full_permission(device)?;
            crate::db::insert_audit_log(&device.id, "close", Some(&card_id), "close session")
                .map_err(|e| {
                    (
                        "command_failed".to_string(),
                        format!("Failed to audit close: {e}"),
                    )
                })?;
            crate::pty::pty_kill(card_id)
                .await
                .map_err(|message| ("command_failed".to_string(), message))
        }
        ClientMessage::MarkRead { .. }
        | ClientMessage::Pin { .. }
        | ClientMessage::SetIntent { .. } => Ok(()),
        ClientMessage::Spawn { .. } => Err((
            "command_failed".to_string(),
            "Remote spawn is not implemented in Stage 1.".to_string(),
        )),
    }
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

fn pair_page_html(otp: Option<&str>) -> String {
    let otp_json =
        serde_json::to_string(otp.unwrap_or_default()).unwrap_or_else(|_| "\"\"".to_string());

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>ThreadTerm Mobile Pairing</title>
  <style>
    :root {{
      color-scheme: dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #10151d;
      color: #e8edf5;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: stretch;
      background: #10151d;
    }}
    main {{
      width: 100%;
      max-width: 720px;
      margin: 0 auto;
      padding: 28px 18px;
    }}
    h1 {{
      margin: 0 0 8px;
      font-size: 24px;
      line-height: 1.2;
      letter-spacing: 0;
    }}
    p {{
      margin: 0;
      color: #a9b4c3;
      line-height: 1.5;
    }}
    .panel {{
      margin-top: 22px;
      border: 1px solid #303949;
      border-radius: 12px;
      background: #151b24;
      padding: 16px;
    }}
    .status {{
      font-size: 14px;
      font-weight: 650;
      color: #e8edf5;
    }}
    .muted {{ color: #a9b4c3; }}
    .error {{ color: #ff8a8a; }}
    .ok {{ color: #7dd3a8; }}
    .code {{
      margin-top: 12px;
      overflow-x: auto;
      white-space: pre-wrap;
      border-radius: 10px;
      background: #0b0f16;
      padding: 12px;
      color: #d9e7ff;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
    }}
    button {{
      min-height: 44px;
      margin-top: 14px;
      border: 0;
      border-radius: 10px;
      background: #4f8bd6;
      color: #07111f;
      font-weight: 700;
      padding: 10px 14px;
    }}
  </style>
</head>
<body>
  <main>
    <h1>ThreadTerm Mobile Pairing</h1>
    <p id="summary">Pair this device with the desktop bridge.</p>
    <section class="panel">
      <div id="status" class="status">Preparing pairing...</div>
      <p id="detail" class="muted"></p>
      <button id="retry" type="button" hidden>Retry</button>
      <div id="snapshot" class="code" hidden></div>
    </section>
  </main>
  <script>
    const otp = {otp_json};
    const statusEl = document.getElementById('status');
    const detailEl = document.getElementById('detail');
    const retryEl = document.getElementById('retry');
    const snapshotEl = document.getElementById('snapshot');

    function deviceName() {{
      const ua = navigator.userAgent || 'Mobile Browser';
      return ua.length > 80 ? ua.slice(0, 80) : ua;
    }}

    function setStatus(message, kind = '') {{
      statusEl.textContent = message;
      statusEl.className = `status ${{kind}}`;
    }}

    async function pair() {{
      retryEl.hidden = true;
      snapshotEl.hidden = true;
      snapshotEl.textContent = '';

      if (!otp) {{
        setStatus('Missing pairing code', 'error');
        detailEl.textContent = 'Open the pairing link shown in ThreadTerm again.';
        return;
      }}

      try {{
        setStatus('Pairing device...');
        detailEl.textContent = 'This one-time code will be consumed after a successful pairing.';

        const response = await fetch('/pair', {{
          method: 'POST',
          headers: {{ 'content-type': 'application/json' }},
          body: JSON.stringify({{ otp, deviceName: deviceName() }}),
        }});

        if (!response.ok) {{
          const message = await response.text();
          throw new Error(message || `Pairing failed with HTTP ${{response.status}}`);
        }}

        const payload = await response.json();
        localStorage.setItem('threadterm.bridgeToken', payload.deviceToken);
        setStatus('Paired', 'ok');
        detailEl.textContent = 'This device can now read ThreadTerm bridge snapshots.';

        const snapshot = await fetch(`/snapshot?token=${{encodeURIComponent(payload.deviceToken)}}`);
        if (snapshot.ok) {{
          snapshotEl.textContent = JSON.stringify(await snapshot.json(), null, 2);
          snapshotEl.hidden = false;
        }}
      }} catch (error) {{
        setStatus('Pairing failed', 'error');
        detailEl.textContent = error instanceof Error ? error.message : String(error);
        retryEl.hidden = false;
      }}
    }}

    retryEl.addEventListener('click', pair);
    pair();
  </script>
</body>
</html>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_landing_page_posts_otp_to_pair_endpoint() {
        let html = pair_page_html(Some("123456"));

        assert!(html.contains("ThreadTerm Mobile Pairing"));
        assert!(html.contains("const otp = \"123456\";"));
        assert!(html.contains("fetch('/pair'"));
        assert!(html.contains("deviceName"));
        assert!(html.contains("/snapshot?token="));
    }

    #[test]
    fn pair_landing_page_handles_missing_otp() {
        let html = pair_page_html(None);

        assert!(html.contains("const otp = \"\";"));
        assert!(html.contains("Missing pairing code"));
    }
}
