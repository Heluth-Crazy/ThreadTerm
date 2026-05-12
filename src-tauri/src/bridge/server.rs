use std::{
    net::SocketAddr,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{Html, IntoResponse},
    routing::get,
};
use serde::Deserialize;
use tokio::{
    net::TcpListener,
    sync::{broadcast, oneshot},
    task::JoinHandle,
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use super::{
    BridgeRuntime,
    protocol::{
        BridgeDevice, ClientMessage, PairRequest, ServerMessage, VersionedServerMessage,
        parse_client_message, versioned_server_message,
    },
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
    permission: Option<String>,
    theme_bg: Option<String>,
    theme_card: Option<String>,
    theme_primary: Option<String>,
    theme_fg: Option<String>,
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
        .route("/assets/xterm.css", get(xterm_css_handler))
        .route("/assets/xterm.js", get(xterm_js_handler))
        .route("/assets/addon-fit.js", get(xterm_fit_js_handler))
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

async fn xterm_css_handler() -> impl IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../../../node_modules/@xterm/xterm/css/xterm.css"),
    )
}

async fn xterm_js_handler() -> impl IntoResponse {
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )],
        include_str!("../../../node_modules/@xterm/xterm/lib/xterm.js"),
    )
}

async fn xterm_fit_js_handler() -> impl IntoResponse {
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )],
        include_str!("../../../node_modules/@xterm/addon-fit/lib/addon-fit.js"),
    )
}

async fn pair_page_handler(Query(query): Query<PairPageQuery>) -> Html<String> {
    Html(pair_page_html(
        query.otp.as_deref(),
        normalize_pair_permission(query.permission.as_deref()),
        query.theme_bg.as_deref(),
        query.theme_card.as_deref(),
        query.theme_primary.as_deref(),
        query.theme_fg.as_deref(),
    ))
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
    let mut rx = context.runtime.subscribe();
    let snapshot = context.runtime.snapshot();
    let terminal_snapshots = snapshot
        .cards
        .iter()
        .filter_map(|card| super::terminal_snapshot_message(&card.id))
        .collect::<Vec<_>>();
    let initial = ServerMessage::from(snapshot);
    if send_json(&mut socket, &initial).await.is_err() {
        return;
    }
    for snapshot in terminal_snapshots {
        if send_json(&mut socket, &ServerMessage::TerminalSnapshot { snapshot })
            .await
            .is_err()
        {
            return;
        }
    }

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
                        if send_json(&mut socket, &message).await.is_err() {
                            break;
                        }
                        let resync_snapshot = context.runtime.snapshot();
                        let resync_terminal_snapshots = resync_snapshot
                            .cards
                            .iter()
                            .filter_map(|card| super::terminal_snapshot_message(&card.id))
                            .collect::<Vec<_>>();
                        let resync_initial = ServerMessage::from(resync_snapshot);
                        if send_json(&mut socket, &resync_initial).await.is_err() {
                            break;
                        }
                        let mut resync_failed = false;
                        for snapshot in resync_terminal_snapshots {
                            if send_json(
                                &mut socket,
                                &ServerMessage::TerminalSnapshot { snapshot },
                            )
                            .await
                            .is_err()
                            {
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
                                device_id = %device.id,
                                raw_len = text.len(),
                                raw_text = %text,
                                "Mobile bridge raw input frame"
                            );
                        }
                        if let Err((code, message)) = handle_client_message(&context, &device, &text).await {
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
            tracing::info!(
                device_id = %device.id,
                card_id = %card_id,
                len = data.len(),
                data_debug = ?data,
                "Mobile bridge input received"
            );
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
            paced_pty_input(&card_id, &data).await
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

fn normalize_pair_permission(permission: Option<&str>) -> &'static str {
    match permission {
        Some("full") => "full",
        _ => "read_only",
    }
}

fn pair_page_html(
    otp: Option<&str>,
    pair_permission: &str,
    theme_bg: Option<&str>,
    theme_card: Option<&str>,
    theme_primary: Option<&str>,
    theme_fg: Option<&str>,
) -> String {
    let otp_json =
        serde_json::to_string(otp.unwrap_or_default()).unwrap_or_else(|_| "\"\"".to_string());
    let permission_json = serde_json::to_string(normalize_pair_permission(Some(pair_permission)))
        .unwrap_or_else(|_| "\"read_only\"".to_string());

    let bg = theme_bg.unwrap_or("#10151d");
    let card = theme_card.unwrap_or("#151b24");
    let primary = theme_primary.unwrap_or("#4f8bd6");
    let fg = theme_fg.unwrap_or("#e8edf5");

    mobile_pair_page_template()
        .replace("__OTP_JSON__", &otp_json)
        .replace("__PERMISSION_JSON__", &permission_json)
        .replace("__THEME_BG__", bg)
        .replace("__THEME_CARD__", card)
        .replace("__THEME_PRIMARY__", primary)
        .replace("__THEME_FG__", fg)
}

fn mobile_pair_page_template() -> &'static str {
    r###"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>ThreadTerm Mobile Pairing</title>
  <link rel="stylesheet" href="/assets/xterm.css" />
  <style>
    :root {
      --bg: __THEME_BG__;
      --card: __THEME_CARD__;
      --primary: __THEME_PRIMARY__;
      --fg: __THEME_FG__;
      --terminal-bg: #000;
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: stretch;
      background: var(--bg);
      /* 增加一层极淡的蒙层，让背景色更有深度 */
      background-image: linear-gradient(rgba(0,0,0,0.03), rgba(0,0,0,0.03));
      color: var(--fg);
      line-height: 1.4;
      -webkit-font-smoothing: antialiased;
    }

    main {
      width: 100%;
      max-width: 500px;
      margin: 0 auto;
      min-height: 100vh;
      padding: max(16px, env(safe-area-inset-top)) 16px max(32px, env(safe-area-inset-bottom));
      display: flex;
      flex-direction: column;
    }

    /* 顶部标题区域 - 解决重叠 */
    .header-area {
      text-align: center;
      margin-bottom: 32px;
      padding-top: 8px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      background: var(--card);
      border-radius: 100px;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      margin-bottom: 20px;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #34c759; }

    h1 {
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.04em;
      margin: 0 0 8px;
      color: var(--fg);
    }
    .subtitle {
      font-size: 15px;
      color: var(--fg);
      opacity: 0.5;
      margin: 0;
    }

    /* 首页卡片样式 - 增加层次感 */
    .cards {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .card {
      appearance: none;
      background: var(--card);
      border-radius: 20px;
      padding: 20px;
      border: 1px solid rgba(0, 0, 0, 0.05);
      box-shadow: 0 10px 20px -5px rgba(0, 0, 0, 0.1);
      display: flex;
      flex-direction: column;
      gap: 14px;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      text-decoration: none;
      color: inherit;
    }
    .card:active {
      transform: scale(0.97);
      box-shadow: 0 4px 10px -2px rgba(0, 0, 0, 0.1);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
    }
    .card-title-group { min-width: 0; }
    .card-title {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card-path {
      font-size: 12px;
      opacity: 0.4;
      font-family: ui-monospace, SFMono-Regular, monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .pill {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 10px;
      border-radius: 8px;
      background: rgba(0,0,0,0.05);
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .pill.running { color: #10b981; background: rgba(16, 185, 129, 0.1); }

    .summary-line {
      font-size: 14px;
      font-weight: 600;
      color: var(--primary);
    }

    /* 终端预览小窗 */
    .preview {
      background: #000;
      color: #fff;
      padding: 12px;
      border-radius: 12px;
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 11px;
      line-height: 1.6;
      box-shadow: inset 0 2px 4px rgba(0,0,0,0.2);
    }
    .preview-line {
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      opacity: 0.9;
    }

    .card-footer {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      opacity: 0.4;
      font-weight: 500;
    }

    /* 详情页样式 */
    .terminal-container {
      background: var(--terminal-bg);
      border-radius: 20px;
      padding: 2px; /* 减少外框厚度 */
      box-shadow: 0 20px 40px rgba(0,0,0,0.4);
      flex: 1 1 auto;
      min-height: 360px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      /* 防止页面回弹干扰终端滚动 */
      overscroll-behavior: contain;
    }
    .terminal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 18px; /* 稍微增加点击区域 */
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .terminal-title {
      font-size: 11px;
      font-weight: 700;
      opacity: 0.3;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    #back {
      background: transparent;
      color: var(--primary);
      font-size: 16px;
      font-weight: 600;
      padding: 0;
      transition: opacity 0.2s;
    }
    #back:active { opacity: 0.5; }

    .terminal-shell {
      flex: 1 1 auto;
      width: 100%;
      height: 100%;
      min-height: 280px;
      background: var(--terminal-bg);
      overflow: hidden;
      /* 核心滚动性能优化 */
      -webkit-overflow-scrolling: touch;
      position: relative;
    }
    .terminal-host {
      width: 100%;
      height: 100%;
      min-height: 280px;
      background: var(--terminal-bg);
      /* 增加内部留白，解决文字贴边问题 */
      padding: 12px 4px;
      position: relative;
      overflow: hidden;
    }
    .terminal-instance {
      width: 100%;
      height: 100%;
      opacity: 0;
      pointer-events: none;
    }
    .terminal-transcript {
      position: absolute;
      inset: 12px 4px;
      overflow: auto;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      touch-action: pan-y;
      background: var(--terminal-bg);
      color: #f8fafc;
      font-family: ui-monospace, SFProText-Regular, SF Pro Text, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      line-height: 18px;
      white-space: pre;
      contain: strict;
      will-change: scroll-position;
    }
    .terminal-transcript-rows {
      overflow: hidden;
    }
    .terminal-transcript-row {
      height: 18px;
      line-height: 18px;
      white-space: pre;
      overflow: hidden;
    }
    .terminal-transcript-spacer {
      height: 0;
    }
    .terminal-instance,
    .terminal-instance .xterm,
    .terminal-instance .xterm-viewport,
    .terminal-instance .xterm-screen {
      background: var(--terminal-bg) !important;
    }
    .terminal-fallback {
      min-height: 100%;
      padding: 12px;
      border-radius: 14px;
      background: var(--terminal-bg);
      color: var(--fg);
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      overflow: auto;
    }
    .terminal-fallback-title {
      margin-bottom: 8px;
      color: var(--primary);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    /* 修复 xterm 滚动条在移动端的显示 */
    .xterm-viewport {
      overscroll-behavior: contain;
    }

    .control-panel {
      margin-top: 24px;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }
    .terminal-keyboard {
      grid-column: 1 / -1;
      width: 100%;
      min-height: 46px;
      max-height: 86px;
      resize: none;
      border: 0;
      border-radius: 16px;
      padding: 12px 14px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--fg);
      font-family: ui-monospace, SFProText-Regular, SF Pro Text, Menlo, Monaco, Consolas, monospace;
      font-size: 16px;
      line-height: 20px;
      outline: none;
    }
    .terminal-keyboard::placeholder {
      color: currentColor;
      opacity: 0.45;
    }
    .terminal-keyboard:focus {
      box-shadow: 0 0 0 2px var(--primary);
    }
    .control-panel button {
      height: 54px;
      border-radius: 16px;
      font-size: 16px;
      font-weight: 700;
      border: 0;
      background: rgba(255, 255, 255, 0.08);
      color: var(--fg);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.05);
    }
    .control-panel button:active {
      transform: scale(0.94);
      background: rgba(255, 255, 255, 0.12);
    }
    #send-enter { background: var(--primary); color: #000; }

    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <main>
    <div class="header-area">
      <div id="status-badge" class="status-badge">
        <span class="dot"></span>
        <span id="status-text">Connecting...</span>
      </div>
      <h1>ThreadTerm</h1>
      <p id="summary" class="subtitle">Mobile Studio Bridge</p>
    </div>

    <div id="list-view">
      <div id="cards" class="cards" hidden></div>
    </div>

    <div id="detail-view" style="flex:1 1 auto; min-height: calc(100vh - 220px); display:flex; flex-direction:column;" hidden>
      <div class="terminal-container">
        <div class="terminal-header">
          <span id="detail-title" class="terminal-title">TERMINAL</span>
          <button id="back" type="button">Done</button>
        </div>
        <div id="terminal-shell" class="terminal-shell" style="flex:1; padding:10px;">
          <div id="terminal-host" class="terminal-host"></div>
        </div>
      </div>

      <div id="control-panel" class="control-panel">
        <textarea id="terminal-keyboard" class="terminal-keyboard" rows="1" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Tap to type"></textarea>
        <button id="send-ctrl-c" type="button">Ctrl-C</button>
        <button id="send-esc" type="button">Esc</button>
        <button id="send-enter" type="button">Enter</button>
      </div>

      <div id="readonly-notice" style="text-align:center; margin-top:16px; font-size:12px; opacity:0.5;" hidden>
        Read-only session. Input disabled.
      </div>
    </div>

    <button id="retry" type="button" style="margin-top:32px; background:var(--primary); color:#000; border-radius:16px; height:50px; width:100%; font-weight:700;" hidden>Retry Pairing</button>
  </main>
  <script src="/assets/xterm.js"></script>
  <script src="/assets/addon-fit.js"></script>
  <script>
    const BRIDGE_PROTOCOL_VERSION = 1;
    const MOBILE_TERMINAL_SCROLLBACK = 5000;
    const MOBILE_TERMINAL_OUTPUT_BATCH_MS = 24;
    const MOBILE_TOUCH_SCROLL_MULTIPLIER = 1.8;
    const MOBILE_TRANSCRIPT_ROW_HEIGHT = 18;
    const MOBILE_TRANSCRIPT_OVERSCAN_ROWS = 30;
    let otp = __OTP_JSON__;
    const pairPermission = __PERMISSION_JSON__;
    const TOKEN_KEY = 'threadterm.bridgeToken';
    const PERMISSION_KEY = 'threadterm.bridgePermission';
    const statusBadgeEl = document.getElementById('status-badge');
    const statusTextEl = document.getElementById('status-text');
    const retryEl = document.getElementById('retry');
    const listViewEl = document.getElementById('list-view');
    const detailViewEl = document.getElementById('detail-view');
    const cardsEl = document.getElementById('cards');
    const backEl = document.getElementById('back');
    const detailTitleEl = document.getElementById('detail-title');
    const terminalHostEl = document.getElementById('terminal-host');
    const controlPanelEl = document.getElementById('control-panel');
    const sendEnterEl = document.getElementById('send-enter');
    const sendCtrlCEl = document.getElementById('send-ctrl-c');
    const sendEscEl = document.getElementById('send-esc');
    const terminalKeyboardEl = document.getElementById('terminal-keyboard');
    const readonlyNoticeEl = document.getElementById('readonly-notice');

    const state = {
      token: localStorage.getItem(TOKEN_KEY) || '',
      permission: otp ? pairPermission : (localStorage.getItem(PERMISSION_KEY) || 'read_only'),
      pairPermission: pairPermission === 'full' ? 'full' : 'read_only',
      cards: new Map(),
      selectedCardId: null,
      socket: null,
      reconnectTimer: 0,
      reconnectAttempts: 0,
      pendingInputFailFlash: 0,
      pendingInputBuffer: '',
      suppressListHistory: false,
      terminalByCardId: new Map(),
      fitByCardId: new Map(),
      terminalElementByCardId: new Map(),
      terminalTouchCleanupByCardId: new Map(),
      terminalSnapshotByCardId: new Map(),
      transcriptChunksByCardId: new Map(),
      transcriptRowsByCardId: new Map(),
      transcriptViewByCardId: new Map(),
      transcriptColsByCardId: new Map(),
      lastTranscriptSeqByCardId: new Map(),
      receivedTerminalSeqByCardId: new Map(),
      pendingTerminalOutputByCardId: new Map(),
      queuedTerminalOutputByCardId: new Map(),
      outputFlushTimerByCardId: new Map(),
      lastTerminalSeqByCardId: new Map(),
      appliedTerminalSnapshotSeqByCardId: new Map(),
      userScrolledTerminalByCardId: new Map(),
      touchScrollingTerminalByCardId: new Map(),
      suppressResizeByCardId: new Set(),
      resizeObserver: null,
    };

    function deviceName() {
      const ua = navigator.userAgent || 'Mobile Browser';
      return ua.length > 80 ? ua.slice(0, 80) : ua;
    }

    function setStatus(message, kind = '') {
      statusTextEl.textContent = message;
      statusBadgeEl.className = `status-badge ${kind}`;
    }

    function clearElement(el) {
      while (el.firstChild) el.removeChild(el.firstChild);
    }

    function formatBytes(value) {
      if (!Number.isFinite(value) || value <= 0) return '0 B';
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
      return `${(value / 1024 / 1024).toFixed(1)} MB`;
    }

    function projectNameFromPath(path) {
      const clean = String(path || '').trim();
      if (!clean) return 'Unknown project';
      return clean.split(/[\\/]/).filter(Boolean).pop() || clean;
    }

    function previewLines(card, limit = 3, excludeSummary = false) {
      const summary = String(card?.summaryLine || '').trim();
      const lines = String(card?.lastReplyPreview || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !excludeSummary || line !== summary);
      return lines
        .slice(-limit);
    }

    function normalizeCard(card) {
      if (!card || !card.id) return null;
      return {
        id: String(card.id),
        status: String(card.status || 'idle'),
        projectPath: String(card.projectPath || ''),
        projectName: String(card.projectName || projectNameFromPath(card.projectPath)),
        lastReplyPreview: String(card.lastReplyPreview || ''),
        summaryLine: card.summaryLine ? String(card.summaryLine) : '',
        hiddenLineCount: Number(card.hiddenLineCount || 0),
        recentOutputBytes: Number(card.recentOutputBytes || 0),
      };
    }

    function mergeCard(card) {
      const normalized = normalizeCard(card);
      if (!normalized) return;
      state.cards.set(normalized.id, {
        ...(state.cards.get(normalized.id) || {}),
        ...normalized,
      });
    }

    function validateMessage(message) {
      if (!message || message.protocol_version !== BRIDGE_PROTOCOL_VERSION) {
        throw new Error('Bridge protocol version mismatch.');
      }
      if (!message.kind) {
        throw new Error('Bridge message is missing kind.');
      }
      return message;
    }

    function scrubPairingCodeFromUrl() {
      if (otp) {
        otp = '';
      }
      if (!window.history?.replaceState) return;
      const url = new URL(window.location.href);
      if (url.searchParams.has('otp')) {
        url.searchParams.delete('otp');
        window.history.replaceState({ view: state.selectedCardId ? 'detail' : 'list' }, '', `${url.pathname}${url.search}${url.hash}`);
      }
    }

    function hasStoredToken() {
      return Boolean(state.token);
    }

    function clearStoredPairing() {
      state.token = '';
      state.permission = state.pairPermission;
      try {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(PERMISSION_KEY);
      } catch (_) {}
      refreshTerminalPermission();
    }

    async function storedTokenStillAuthorized(token) {
      if (!token) return false;
      try {
        const response = await fetch(`/snapshot?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
        return response.status !== 401 && response.status !== 403;
      } catch (_) {
        return true;
      }
    }

    function cssVar(name, fallback) {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value || fallback;
    }

    function terminalTheme() {
      const bg = cssVar('--terminal-bg', '#000');
      // 确保终端文字在黑色背景下始终保持高亮，不受桌面端亮色模式影响
      const fg = '#f8fafc';
      const primary = cssVar('--primary', '#4f8bd6');
      return {
        background: bg,
        foreground: fg,
        cursor: primary,
        selectionBackground: 'rgba(255,255,255,0.22)',
        black: '#0b0f14',
        red: '#ff6b6b',
        green: '#34d399',
        yellow: '#fbbf24',
        blue: primary,
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: fg,
        brightBlack: '#64748b',
        brightRed: '#f87171',
        brightGreen: '#6ee7b7',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#ffffff',
      };
    }

    function scrollTerminalToBottom(cardId) {
      const id = String(cardId || '');
      if (usesTranscriptRenderer(id)) return;
      const term = state.terminalByCardId.get(id);
      if (!term || state.selectedCardId !== id || detailViewEl.hidden) return;

      const scroll = () => {
        if (state.selectedCardId !== id || detailViewEl.hidden) return;
        try {
          term.scrollToBottom();
          state.userScrolledTerminalByCardId.set(id, false);
        } catch (_) {}
      };

      scroll();
      window.requestAnimationFrame(scroll);
      window.setTimeout(scroll, 40);
      window.setTimeout(scroll, 120);
    }

    function xtermReady() {
      return typeof window.Terminal === 'function'
        && window.FitAddon
        && typeof window.FitAddon.FitAddon === 'function';
    }

    function usesTranscriptRenderer(_cardId) {
      return true;
    }

    function stripAnsiForFallback(value) {
      return String(value || '')
        .replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[()][A-Za-z0-9])/g, '')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    }

    function fallbackLines(cardId) {
      const card = state.cards.get(String(cardId || ''));
      const fromCard = previewLines(card, 10, false);
      if (fromCard.length > 0) return fromCard;
      const snapshot = state.terminalSnapshotByCardId.get(String(cardId || ''));
      const fromSnapshot = stripAnsiForFallback(snapshot ? terminalPayload(snapshot) : '')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-10);
      return fromSnapshot;
    }

    function hideTerminalFallback() {
      const fallback = document.getElementById('terminal-fallback');
      if (fallback) fallback.hidden = true;
    }

    function hideTranscriptViews(activeCardId = '') {
      const active = String(activeCardId || '');
      for (const [id, view] of state.transcriptViewByCardId.entries()) {
        view.root.hidden = id !== active;
      }
    }

    function showTerminalFallback(cardId, title = 'Terminal preview') {
      let fallback = document.getElementById('terminal-fallback');
      if (!fallback) {
        fallback = document.createElement('div');
        fallback.id = 'terminal-fallback';
        fallback.className = 'terminal-fallback';
        terminalHostEl.appendChild(fallback);
      }
      clearElement(fallback);
      const titleEl = document.createElement('div');
      titleEl.className = 'terminal-fallback-title';
      titleEl.textContent = title;
      fallback.appendChild(titleEl);
      const lines = fallbackLines(cardId);
      const body = document.createElement('div');
      body.textContent = lines.length > 0 ? lines.join('\n') : 'Waiting for terminal output.';
      fallback.appendChild(body);
      fallback.hidden = false;
    }

    function normalizeTerminalSnapshot(snapshot) {
      if (!snapshot) return null;
      const cardId = String(snapshot.cardId || snapshot.card_id || '');
      if (!cardId) return null;
      return {
        cardId,
        data: String(snapshot.data || ''),
        seq: Number(snapshot.seq || 0),
        rows: Math.max(1, Number(snapshot.rows || 24)),
        cols: Math.max(2, Number(snapshot.cols || 80)),
        cursorRow: Math.max(1, Number(snapshot.cursorRow || snapshot.cursor_row || 1)),
        cursorCol: Math.max(1, Number(snapshot.cursorCol || snapshot.cursor_col || 1)),
        history: snapshot.history ? String(snapshot.history) : '',
      };
    }

    function terminalPayload(snapshot) {
      return `${snapshot.history || ''}${snapshot.data || ''}`;
    }

    function estimatedTranscriptCols(snapshotCols) {
      const width = Math.max(0, Number(terminalHostEl.clientWidth || 0) - 8);
      const measuredCols = width > 0 ? Math.floor(width / 7.4) : 0;
      const fallbackCols = Number(snapshotCols || 0) || 80;
      return Math.max(16, Math.min(160, measuredCols || fallbackCols));
    }

    function appendWrappedTranscriptRows(rows, text, cols) {
      const width = Math.max(16, Number(cols || 80));
      if (rows.length === 0) rows.push('');
      let current = rows.pop() || '';
      let cursorCol = Number.isFinite(rows._cursorCol) ? rows._cursorCol : current.length;
      cursorCol = Math.min(cursorCol, current.length);
      const source = String(text || '');

      const replaceAtCursor = (char) => {
        if (cursorCol > current.length) {
          current = current.padEnd(cursorCol, ' ');
        }
        current = `${current.slice(0, cursorCol)}${char}${current.slice(cursorCol + 1)}`;
        cursorCol += 1;
        while (cursorCol > width || current.length > width) {
          rows.push(current.slice(0, width));
          current = current.slice(width);
          cursorCol = Math.max(0, cursorCol - width);
        }
      };

      const eraseLine = (mode) => {
        if (mode === 1) {
          current = `${' '.repeat(Math.min(cursorCol, current.length))}${current.slice(cursorCol)}`;
        } else if (mode === 2) {
          current = '';
          cursorCol = 0;
        } else {
          current = current.slice(0, cursorCol);
        }
      };

      const applyCsi = (params, command) => {
        const firstParam = Number(String(params || '').replace(/^\?/, '').split(';')[0] || 0);
        if (command === 'K') {
          eraseLine(firstParam);
        } else if (command === 'G') {
          cursorCol = Math.max(0, (firstParam || 1) - 1);
        } else if (command === 'C') {
          cursorCol += Math.max(1, firstParam || 1);
        } else if (command === 'D') {
          cursorCol = Math.max(0, cursorCol - Math.max(1, firstParam || 1));
        } else if (command === 'J' && (firstParam === 2 || firstParam === 3)) {
          rows.length = 0;
          current = '';
          cursorCol = 0;
        }
      };

      let index = 0;
      while (index < source.length) {
        const char = source[index];
        if (char === '\u001b') {
          const next = source[index + 1];
          if (next === '[') {
            let end = index + 2;
            while (end < source.length && !/[A-Za-z@-~]/.test(source[end])) end += 1;
            if (end < source.length) {
              applyCsi(source.slice(index + 2, end), source[end]);
              index = end + 1;
              continue;
            }
          } else if (next === ']') {
            const bellEnd = source.indexOf('\u0007', index + 2);
            const stEnd = source.indexOf('\u001b\\', index + 2);
            if (bellEnd >= 0 && (stEnd < 0 || bellEnd < stEnd)) {
              index = bellEnd + 1;
              continue;
            }
            if (stEnd >= 0) {
              index = stEnd + 2;
              continue;
            }
          } else if (next) {
            index += 2;
            continue;
          }
        }
        if (char === '\r') {
          cursorCol = 0;
          index += 1;
          continue;
        }
        if (char === '\n') {
          rows.push(current);
          current = '';
          cursorCol = 0;
          index += 1;
          continue;
        }
        if (char === '\b' || char === '\u007f') {
          cursorCol = Math.max(0, cursorCol - 1);
          if (cursorCol < current.length) {
            current = `${current.slice(0, cursorCol)}${current.slice(cursorCol + 1)}`;
          }
          index += 1;
          continue;
        }
        if (char === '\t') {
          const spaces = 4 - (cursorCol % 4);
          for (let count = 0; count < spaces; count += 1) replaceAtCursor(' ');
          index += 1;
          continue;
        }
        if (char < ' ' && char !== '\u00a0') {
          index += 1;
          continue;
        }
        replaceAtCursor(char);
        index += 1;
      }
      rows.push(current);
      rows._cursorCol = cursorCol;
    }

    function rebuildTranscriptRows(cardId, cols) {
      const id = String(cardId || '');
      const nextCols = Math.max(16, Number(cols || estimatedTranscriptCols()) || 80);
      const rows = [];
      rows._cursorCol = 0;
      const chunks = state.transcriptChunksByCardId.get(id) || [];
      for (const chunk of chunks) {
        appendWrappedTranscriptRows(rows, chunk, nextCols);
      }
      state.transcriptRowsByCardId.set(id, rows.length > 0 ? rows : ['']);
      state.transcriptColsByCardId.set(id, nextCols);
    }

    function ensureTranscriptRows(cardId, snapshotCols) {
      const id = String(cardId || '');
      const term = state.terminalByCardId.get(id);
      const cachedRows = state.transcriptRowsByCardId.get(id);
      if (term && cachedRows && cachedRows.length > 0) {
        return cachedRows;
      }
      if (term && syncTranscriptRowsFromTerminal(id, { render: false })) {
        return state.transcriptRowsByCardId.get(id) || [''];
      }
      const nextCols = estimatedTranscriptCols(snapshotCols);
      const currentCols = Number(state.transcriptColsByCardId.get(id) || 0);
      if (!state.transcriptRowsByCardId.has(id) || currentCols !== nextCols) {
        rebuildTranscriptRows(id, nextCols);
      }
      return state.transcriptRowsByCardId.get(id) || [''];
    }

    function transcriptAtBottom(view) {
      if (!view) return true;
      return view.scrollHeight - view.scrollTop - view.clientHeight < MOBILE_TRANSCRIPT_ROW_HEIGHT * 2;
    }

    function ensureTranscriptView(cardId) {
      const id = String(cardId || '');
      if (!id) return null;
      const existing = state.transcriptViewByCardId.get(id);
      if (existing) return existing;

      const root = document.createElement('div');
      root.className = 'terminal-transcript';
      root.hidden = state.selectedCardId !== id;
      root.tabIndex = 0;

      const topSpacer = document.createElement('div');
      topSpacer.className = 'terminal-transcript-spacer';

      const rowsEl = document.createElement('div');
      rowsEl.className = 'terminal-transcript-rows';

      const bottomSpacer = document.createElement('div');
      bottomSpacer.className = 'terminal-transcript-spacer';

      root.append(topSpacer, rowsEl, bottomSpacer);
      root.addEventListener('scroll', () => {
        state.userScrolledTerminalByCardId.set(id, !transcriptAtBottom(root));
        scheduleRenderTranscriptWindow(id);
      }, { passive: true });
      root.addEventListener('touchstart', blurTerminalKeyboard, { passive: true });
      root.addEventListener('click', blurTerminalKeyboard);

      const view = { root, topSpacer, rowsEl, bottomSpacer, firstRow: -1, lastRow: -1, totalRows: 0, raf: 0 };
      state.transcriptViewByCardId.set(id, view);
      terminalHostEl.appendChild(root);
      return view;
    }

    function renderTranscriptWindow(cardId, options = {}) {
      const id = String(cardId || '');
      const view = state.transcriptViewByCardId.get(id);
      if (!view) return;
      const rows = ensureTranscriptRows(id);
      const root = view.root;
      const totalRows = Math.max(1, rows.length);
      const viewportRows = Math.max(1, Math.ceil((root.clientHeight || terminalHostEl.clientHeight || 280) / MOBILE_TRANSCRIPT_ROW_HEIGHT));
      const shouldStickToBottom = options.stickToBottom === true
        || (!options.preserveScroll && !state.userScrolledTerminalByCardId.get(id) && transcriptAtBottom(root));
      const targetScrollTop = shouldStickToBottom
        ? Math.max(0, totalRows * MOBILE_TRANSCRIPT_ROW_HEIGHT - (root.clientHeight || terminalHostEl.clientHeight || 280))
        : (root.scrollTop || 0);
      const start = Math.max(
        0,
        Math.floor(targetScrollTop / MOBILE_TRANSCRIPT_ROW_HEIGHT) - MOBILE_TRANSCRIPT_OVERSCAN_ROWS,
      );
      const end = Math.min(totalRows, start + viewportRows + MOBILE_TRANSCRIPT_OVERSCAN_ROWS * 2);
      const totalRowsChanged = totalRows !== view.totalRows;
      view.totalRows = totalRows;

      if (options.force || start !== view.firstRow || end !== view.lastRow) {
        view.firstRow = start;
        view.lastRow = end;
        view.topSpacer.style.height = `${start * MOBILE_TRANSCRIPT_ROW_HEIGHT}px`;
        view.bottomSpacer.style.height = `${Math.max(0, totalRows - end) * MOBILE_TRANSCRIPT_ROW_HEIGHT}px`;
        clearElement(view.rowsEl);
        const fragment = document.createDocumentFragment();
        for (let index = start; index < end; index += 1) {
          const row = document.createElement('div');
          row.className = 'terminal-transcript-row';
          row.textContent = rows[index] || ' ';
          fragment.appendChild(row);
        }
        view.rowsEl.appendChild(fragment);
      } else if (totalRowsChanged) {
        view.bottomSpacer.style.height = `${Math.max(0, totalRows - end) * MOBILE_TRANSCRIPT_ROW_HEIGHT}px`;
      }

      if (shouldStickToBottom) {
        root.scrollTop = root.scrollHeight;
        window.requestAnimationFrame(() => {
          if (state.selectedCardId !== id || detailViewEl.hidden) return;
          root.scrollTop = root.scrollHeight;
          renderTranscriptWindow(id, { force: true, preserveScroll: true });
        });
      }
    }

    function scheduleRenderTranscriptWindow(cardId) {
      const id = String(cardId || '');
      const view = state.transcriptViewByCardId.get(id);
      if (!view || view.raf) return;
      view.raf = window.requestAnimationFrame(() => {
        view.raf = 0;
        renderTranscriptWindow(id, { preserveScroll: true });
      });
    }

    function syncTranscriptRowsFromTerminal(cardId, options = {}) {
      const id = String(cardId || '');
      const term = state.terminalByCardId.get(id);
      const buffer = term?.buffer?.active;
      if (!id || !term || !buffer) return false;

      const rows = [];
      for (let index = 0; index < buffer.length; index += 1) {
        const line = buffer.getLine(index);
        const text = line ? line.translateToString(true) : '';
        if (line?.isWrapped && /^orking(?:\.{0,3})/.test(text)) {
          const previous = rows[rows.length - 1] || '';
          const moved = previous.match(/W\s*$/);
          if (moved) {
            rows[rows.length - 1] = previous.slice(0, previous.length - moved[0].length);
            rows.push(`W${text}`);
            continue;
          }
        }
        rows.push(text);
      }
      state.transcriptRowsByCardId.set(id, rows.length > 0 ? rows : ['']);
      state.transcriptColsByCardId.set(id, Math.max(16, Number(term.cols || 80)));

      if (options.seq > 0) {
        const nextSeq = Math.max(Number(state.lastTranscriptSeqByCardId.get(id) || 0), Number(options.seq || 0));
        state.lastTranscriptSeqByCardId.set(id, nextSeq);
      }

      if (options.render !== false && state.selectedCardId === id) {
        ensureTranscriptView(id);
        renderTranscriptWindow(id, {
          force: options.force !== false,
          stickToBottom: options.stickToBottom === true,
          preserveScroll: options.preserveScroll === true,
        });
      }
      return true;
    }

    function syncTranscriptLayout(cardId, snapshotCols) {
      const id = String(cardId || '');
      if (!id) return;
      if (state.terminalByCardId.has(id) && syncTranscriptRowsFromTerminal(id, {
        force: true,
        stickToBottom: !state.userScrolledTerminalByCardId.get(id),
      })) {
        return;
      }
      const nextCols = estimatedTranscriptCols(snapshotCols);
      const currentCols = Number(state.transcriptColsByCardId.get(id) || 0);
      if (currentCols !== nextCols) {
        rebuildTranscriptRows(id, nextCols);
        const view = state.transcriptViewByCardId.get(id);
        if (view) {
          view.firstRow = -1;
          view.lastRow = -1;
          renderTranscriptWindow(id, {
            force: true,
            stickToBottom: !state.userScrolledTerminalByCardId.get(id),
          });
        }
      }
    }

    function setTranscriptSnapshot(cardId, snapshot) {
      const id = String(cardId || '');
      if (!id || !snapshot) return;
      const seq = Number(snapshot.seq || 0);
      const currentSeq = Number(state.lastTranscriptSeqByCardId.get(id) || 0);
      if (seq > 0 && currentSeq > 0 && seq < currentSeq) return;
      state.transcriptChunksByCardId.set(id, [terminalPayload(snapshot)]);
      state.lastTranscriptSeqByCardId.set(id, seq);
      state.receivedTerminalSeqByCardId.set(id, Math.max(Number(state.receivedTerminalSeqByCardId.get(id) || 0), seq));
      rebuildTranscriptRows(id, estimatedTranscriptCols(snapshot.cols));
      ensureTranscriptView(id);
      renderTranscriptWindow(id, {
        force: true,
        stickToBottom: state.selectedCardId === id && !state.userScrolledTerminalByCardId.get(id),
      });
    }

    function appendTranscriptOutput(cardId, data, seq) {
      const id = String(cardId || '');
      if (!id || !data) return;
      if (!data) {
        if (seq > 0) state.lastTranscriptSeqByCardId.set(id, Math.max(Number(state.lastTranscriptSeqByCardId.get(id) || 0), seq));
        return;
      }
      const view = state.transcriptViewByCardId.get(id);
      const shouldStickToBottom = state.selectedCardId === id
        && (!view || !state.userScrolledTerminalByCardId.get(id) || transcriptAtBottom(view.root));
      const cols = estimatedTranscriptCols();
      if (Number(state.transcriptColsByCardId.get(id) || 0) !== cols) {
        rebuildTranscriptRows(id, cols);
      }
      const chunks = state.transcriptChunksByCardId.get(id) || [];
      chunks.push(data);
      state.transcriptChunksByCardId.set(id, chunks);
      const rows = state.transcriptRowsByCardId.get(id) || [];
      appendWrappedTranscriptRows(rows, data, state.transcriptColsByCardId.get(id) || cols);
      state.transcriptRowsByCardId.set(id, rows);
      if (seq > 0) {
        state.lastTranscriptSeqByCardId.set(id, Math.max(Number(state.lastTranscriptSeqByCardId.get(id) || 0), seq));
      }
      if (state.selectedCardId === id) {
        ensureTranscriptView(id);
        renderTranscriptWindow(id, {
          force: shouldStickToBottom,
          stickToBottom: shouldStickToBottom,
          preserveScroll: !shouldStickToBottom,
        });
      }
    }

    function scrollTranscriptToBottom(cardId) {
      const id = String(cardId || '');
      const view = state.transcriptViewByCardId.get(id);
      if (!view || state.selectedCardId !== id || detailViewEl.hidden) return;
      view.root.scrollTop = view.root.scrollHeight;
      state.userScrolledTerminalByCardId.set(id, false);
      renderTranscriptWindow(id, { force: true, stickToBottom: true });
    }

    function blurTerminalKeyboard() {
      if (document.activeElement === terminalKeyboardEl) {
        terminalKeyboardEl.blur();
      }
    }

    function terminalAtBottom(term) {
      if (!term?.buffer?.active) return true;
      const buffer = term.buffer.active;
      return buffer.baseY <= buffer.viewportY + 2;
    }

    function terminalCellHeight(term) {
      return Math.max(8, Number(term?._core?._renderService?.dimensions?.css?.cell?.height || 16));
    }

    function installTouchScrollAdapter(cardId, term, element) {
      const id = String(cardId || '');
      if (usesTranscriptRenderer(id)) return;
      if (!id || state.terminalTouchCleanupByCardId.has(id) || !element) return;

      let lastY = 0;
      let pendingRows = 0;
      let raf = 0;

      const flushRows = () => {
        raf = 0;
        const rows = pendingRows;
        pendingRows = 0;
        if (!rows || state.selectedCardId !== id || detailViewEl.hidden) return;
        try {
          term.scrollLines(rows);
          state.userScrolledTerminalByCardId.set(id, !terminalAtBottom(term));
        } catch (_) {}
      };

      const queueRows = (rows) => {
        pendingRows += rows;
        if (!raf) raf = window.requestAnimationFrame(flushRows);
      };

      const onTouchStart = (event) => {
        if (event.touches.length !== 1) return;
        lastY = event.touches[0].clientY;
        state.touchScrollingTerminalByCardId.set(id, true);
      };

      const onTouchMove = (event) => {
        if (event.touches.length !== 1) return;
        const nextY = event.touches[0].clientY;
        const deltaY = lastY - nextY;
        lastY = nextY;
        const rows = Math.trunc((deltaY / terminalCellHeight(term)) * MOBILE_TOUCH_SCROLL_MULTIPLIER);
        if (rows !== 0) {
          event.preventDefault();
          queueRows(rows);
        }
      };

      const onTouchEnd = () => {
        state.touchScrollingTerminalByCardId.set(id, false);
        if (pendingRows) flushRows();
      };

      element.addEventListener('touchstart', onTouchStart, { passive: true });
      element.addEventListener('touchmove', onTouchMove, { passive: false });
      element.addEventListener('touchend', onTouchEnd, { passive: true });
      element.addEventListener('touchcancel', onTouchEnd, { passive: true });
      state.terminalTouchCleanupByCardId.set(id, () => {
        if (raf) window.cancelAnimationFrame(raf);
        element.removeEventListener('touchstart', onTouchStart);
        element.removeEventListener('touchmove', onTouchMove);
        element.removeEventListener('touchend', onTouchEnd);
        element.removeEventListener('touchcancel', onTouchEnd);
      });
    }

    function resizeTerminalLocal(term, cardId, cols, rows) {
      if (!term || term.cols === cols && term.rows === rows) return;
      state.suppressResizeByCardId.add(cardId);
      try {
        term.resize(cols, rows);
      } catch (_) {
        // xterm can throw while a hidden mobile browser view is being laid out.
      } finally {
        window.requestAnimationFrame(() => state.suppressResizeByCardId.delete(cardId));
      }
    }

    function ensureTerminal(cardId) {
      const id = String(cardId || '');
      const existing = state.terminalByCardId.get(id);
      if (existing) {
        return existing;
      }

      const snapshot = state.terminalSnapshotByCardId.get(id);
      const element = document.createElement('div');
      element.className = 'terminal-instance';
      element.hidden = state.selectedCardId !== id;
      terminalHostEl.appendChild(element);

      const term = new window.Terminal({
        cols: snapshot?.cols || 80,
        rows: snapshot?.rows || 24,
        theme: terminalTheme(),
        fontSize: 13,
        lineHeight: 1.2,
        fontFamily: 'ui-monospace, SFProText-Regular, SF Pro Text, Menlo, Monaco, Consolas, monospace',
        convertEol: true,
        cursorBlink: state.permission === 'full',
        allowProposedApi: true,
        disableStdin: state.permission !== 'full',
        scrollback: MOBILE_TERMINAL_SCROLLBACK,
        screenReaderMode: false,
        fastScrollModifier: 'alt',
        scrollSensitivity: 1.5,
      });

      const fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(element);
      term.onData((data) => {
        if (state.permission === 'full' && state.selectedCardId === id) {
          sendInput(data, id);
        }
      });
      term.onResize(({ cols, rows }) => sendResize(id, cols, rows));
      term.onScroll(() => {
        if (!usesTranscriptRenderer(id)) {
          state.userScrolledTerminalByCardId.set(id, !terminalAtBottom(term));
        }
      });
      installTouchScrollAdapter(id, term, element);

      state.terminalByCardId.set(id, term);
      state.fitByCardId.set(id, fit);
      state.terminalElementByCardId.set(id, element);

      if (snapshot) {
        writeTerminalSnapshot(id, snapshot, { force: true });
      } else {
        flushPendingTerminalOutput(id);
      }
      return term;
    }

    function fitTerminal(cardId) {
      const id = String(cardId || '');
      const term = state.terminalByCardId.get(id);
      const fit = state.fitByCardId.get(id);
      if (!term || !fit || state.selectedCardId !== id || detailViewEl.hidden) return;
      if (usesTranscriptRenderer(id)) {
        window.requestAnimationFrame(() => {
          if (state.selectedCardId !== id || detailViewEl.hidden) return;
          const shouldStickToBottom = !state.userScrolledTerminalByCardId.get(id);
          state.suppressResizeByCardId.add(id);
          try {
            fit.fit();
          } catch (_) {
            // The host can be briefly hidden during view transitions.
          } finally {
            window.requestAnimationFrame(() => state.suppressResizeByCardId.delete(id));
          }
          syncTranscriptRowsFromTerminal(id, {
            force: true,
            stickToBottom: shouldStickToBottom,
          });
        });
        return;
      }
      window.requestAnimationFrame(() => {
        if (state.selectedCardId !== id || detailViewEl.hidden) return;
        try {
          fit.fit();
          scrollTerminalToBottom(id);
        } catch (_) {
          // The host can be briefly hidden during view transitions.
        }
      });
    }

    function refreshVisibleTerminal(cardId) {
      const id = String(cardId || '');
      if (!id || state.selectedCardId !== id || detailViewEl.hidden) return;
      syncTranscriptLayout(id);
      renderTranscriptWindow(id, { force: true });
      fitTerminal(id);
      const snapshot = state.terminalSnapshotByCardId.get(id);
      if (snapshot && state.terminalByCardId.has(id)) {
        writeTerminalSnapshot(id, snapshot);
      } else {
        flushPendingTerminalOutput(id);
      }
    }

    function showTerminal(cardId) {
      const id = String(cardId || '');
      if (!id) {
        hideTerminalFallback();
        hideTranscriptViews('');
        return;
      }
      ensureTranscriptView(id);
      hideTranscriptViews(id);
      renderTranscriptWindow(id, { force: true });
      if (!xtermReady()) {
        showTerminalFallback(id, 'Terminal engine loading');
        return;
      }

      try {
        ensureTerminal(id);
        hideTerminalFallback();
      } catch (error) {
        showTerminalFallback(id, 'Terminal preview unavailable');
        return;
      }

      for (const [terminalId, element] of state.terminalElementByCardId.entries()) {
        element.hidden = terminalId !== id;
      }

      fitTerminal(id);
      window.requestAnimationFrame(() => refreshVisibleTerminal(id));
      window.setTimeout(() => refreshVisibleTerminal(id), 80);
      window.setTimeout(() => {
        scrollTerminalToBottom(id);
        scrollTranscriptToBottom(id);
      }, 180);
    }

    function refreshTerminalPermission() {
      terminalKeyboardEl.disabled = state.permission !== 'full';
      terminalKeyboardEl.hidden = state.permission !== 'full';
      for (const term of state.terminalByCardId.values()) {
        term.options = {
          cursorBlink: state.permission === 'full',
          disableStdin: state.permission !== 'full',
        };
      }
    }

    function syncStoredPermission() {
      const storedPermission = localStorage.getItem(PERMISSION_KEY) || 'read_only';
      state.permission = storedPermission === 'full' ? 'full' : 'read_only';
      refreshTerminalPermission();
    }

    function writeTerminalSnapshot(cardId, snapshot, options = {}) {
      const term = state.terminalByCardId.get(cardId);
      if (!term) return;
      const seq = Number(snapshot.seq || 0);
      const appliedSeq = Number(state.appliedTerminalSnapshotSeqByCardId.get(cardId) || 0);
      if (!options.force && seq > 0 && seq <= appliedSeq) {
        flushPendingTerminalOutput(cardId);
        scrollTerminalToBottom(cardId);
        return;
      }
      resizeTerminalLocal(term, cardId, snapshot.cols, snapshot.rows);
      term.reset();
      const payload = terminalPayload(snapshot);
      const view = state.transcriptViewByCardId.get(cardId);
      const shouldStickToBottom = state.selectedCardId === cardId
        && (!view || !state.userScrolledTerminalByCardId.get(cardId) || transcriptAtBottom(view.root));
      const finishSnapshotWrite = () => {
        if (usesTranscriptRenderer(cardId)) {
          syncTranscriptRowsFromTerminal(cardId, {
            seq,
            force: true,
            stickToBottom: shouldStickToBottom,
          });
        }
        flushPendingTerminalOutput(cardId);
        scrollTerminalToBottom(cardId);
      };
      state.lastTerminalSeqByCardId.set(cardId, seq);
      if (seq > 0) {
        state.appliedTerminalSnapshotSeqByCardId.set(cardId, seq);
      }
      if (payload) {
        term.write(payload, finishSnapshotWrite);
      } else {
        finishSnapshotWrite();
      }
      if (state.selectedCardId === cardId) {
        fitTerminal(cardId);
        if (!state.userScrolledTerminalByCardId.get(cardId)) {
          scrollTerminalToBottom(cardId);
          scrollTranscriptToBottom(cardId);
        }
      }
    }

    function applyTerminalSnapshot(snapshotPayload) {
      const snapshot = normalizeTerminalSnapshot(snapshotPayload);
      if (!snapshot) return;
      state.terminalSnapshotByCardId.set(snapshot.cardId, snapshot);
      setTranscriptSnapshot(snapshot.cardId, snapshot);
      trimBufferedOutputThrough(snapshot.cardId, snapshot.seq);
      if (state.terminalByCardId.has(snapshot.cardId)) {
        writeTerminalSnapshot(snapshot.cardId, snapshot);
      } else if (state.selectedCardId === snapshot.cardId) {
        hideTerminalFallback();
        ensureTranscriptView(snapshot.cardId);
        renderTranscriptWindow(snapshot.cardId, { force: true, stickToBottom: true });
      }
    }

    function bufferTerminalOutput(cardId, data, seq) {
      const output = state.pendingTerminalOutputByCardId.get(cardId) || [];
      output.push({ data, seq });
      if (output.length > 2000) {
        output.splice(0, output.length - 2000);
      }
      state.pendingTerminalOutputByCardId.set(cardId, output);
    }

    function writeTerminalOutputChunk(cardId, data, seq) {
      const term = state.terminalByCardId.get(cardId);
      if (!term || !data) return;
      if (usesTranscriptRenderer(cardId)) {
        if (seq > 0) {
          state.lastTerminalSeqByCardId.set(cardId, seq);
        }
        const view = state.transcriptViewByCardId.get(cardId);
        const shouldAutoScroll = state.selectedCardId === cardId
          && (!view || !state.userScrolledTerminalByCardId.get(cardId) || transcriptAtBottom(view.root));
        term.write(data, () => {
          syncTranscriptRowsFromTerminal(cardId, {
            seq,
            force: true,
            stickToBottom: shouldAutoScroll,
            preserveScroll: !shouldAutoScroll,
          });
        });
        return;
      }
      const shouldAutoScroll = state.selectedCardId === cardId
        && !state.userScrolledTerminalByCardId.get(cardId)
        && terminalAtBottom(term);
      term.write(data, () => {
        if (shouldAutoScroll) {
          scrollTerminalToBottom(cardId);
        }
      });
      if (seq > 0) {
        state.lastTerminalSeqByCardId.set(cardId, seq);
      }
    }

    function queueTerminalOutput(cardId, data, seq) {
      const queued = state.queuedTerminalOutputByCardId.get(cardId) || { chunks: [], seq: 0 };
      queued.chunks.push({ data, seq });
      queued.seq = Math.max(Number(queued.seq || 0), Number(seq || 0));
      state.queuedTerminalOutputByCardId.set(cardId, queued);
      if (state.outputFlushTimerByCardId.has(cardId)) return;
      const timer = window.setTimeout(() => {
        state.outputFlushTimerByCardId.delete(cardId);
        const next = state.queuedTerminalOutputByCardId.get(cardId);
        state.queuedTerminalOutputByCardId.delete(cardId);
        if (next) {
          const chunks = Array.isArray(next.chunks) ? next.chunks : [{ data: next.data || '', seq: next.seq || 0 }];
          const term = state.terminalByCardId.get(cardId);
          if (usesTranscriptRenderer(cardId) && term) {
            const lastSeq = Number(state.lastTerminalSeqByCardId.get(cardId) || 0);
            const freshChunks = chunks.filter((chunk) => {
              const chunkSeq = Number(chunk.seq || 0);
              return !(chunkSeq > 0 && chunkSeq <= lastSeq);
            });
            const data = freshChunks.map((chunk) => String(chunk.data || '')).join('');
            const chunkSeq = freshChunks.reduce((max, chunk) => Math.max(max, Number(chunk.seq || 0)), 0);
            if (data) writeTerminalOutputChunk(cardId, data, chunkSeq);
            return;
          }
          for (const chunk of chunks) {
            const chunkSeq = Number(chunk.seq || 0);
            const transcriptSeq = Number(state.lastTranscriptSeqByCardId.get(cardId) || 0);
            if (!(chunkSeq > 0 && chunkSeq <= transcriptSeq)) {
              appendTranscriptOutput(cardId, chunk.data, chunkSeq);
            }
            writeTerminalOutputChunk(cardId, chunk.data, chunkSeq);
          }
        }
      }, MOBILE_TERMINAL_OUTPUT_BATCH_MS);
      state.outputFlushTimerByCardId.set(cardId, timer);
    }

    function trimBufferedOutputThrough(cardId, seq) {
      if (!seq) return;
      const output = state.pendingTerminalOutputByCardId.get(cardId);
      if (!output) return;
      const filtered = output.filter((chunk) => !chunk.seq || chunk.seq > seq);
      if (filtered.length > 0) {
        state.pendingTerminalOutputByCardId.set(cardId, filtered);
      } else {
        state.pendingTerminalOutputByCardId.delete(cardId);
      }
    }

    function flushPendingTerminalOutput(cardId) {
      const term = state.terminalByCardId.get(cardId);
      const output = state.pendingTerminalOutputByCardId.get(cardId);
      if (!term || !output || output.length === 0) return;
      state.pendingTerminalOutputByCardId.delete(cardId);
      if (usesTranscriptRenderer(cardId)) {
        const lastSeq = Number(state.lastTerminalSeqByCardId.get(cardId) || 0);
        const freshOutput = output.filter((chunk) => !(chunk.seq > 0 && chunk.seq <= lastSeq));
        const data = freshOutput.map((chunk) => String(chunk.data || '')).join('');
        const maxSeq = freshOutput.reduce((max, chunk) => Math.max(max, Number(chunk.seq || 0)), 0);
        if (data) writeTerminalOutputChunk(cardId, data, maxSeq);
        return;
      }
      for (const chunk of output) {
        const lastSeq = Number(state.lastTerminalSeqByCardId.get(cardId) || 0);
        if (chunk.seq > 0 && chunk.seq <= lastSeq) continue;
        writeTerminalOutputChunk(cardId, chunk.data, chunk.seq);
      }
    }

    function applyTerminalOutput(message) {
      const cardId = String(message.card_id || message.cardId || '');
      if (!cardId) return;
      const data = String(message.data || '');
      if (!data) return;
      const seq = Number(message.seq || 0);
      const receivedSeq = Number(state.receivedTerminalSeqByCardId.get(cardId) || 0);
      if (seq > 0 && seq <= receivedSeq) return;
      if (seq > 0) state.receivedTerminalSeqByCardId.set(cardId, seq);

      const term = state.terminalByCardId.get(cardId);
      if (!term) {
        bufferTerminalOutput(cardId, data, seq);
        queueTerminalOutput(cardId, data, seq);
        return;
      }
      queueTerminalOutput(cardId, data, seq);
    }

    function disposeTerminal(cardId) {
      const id = String(cardId || '');
      const term = state.terminalByCardId.get(id);
      const element = state.terminalElementByCardId.get(id);
      const transcriptView = state.transcriptViewByCardId.get(id);
      const cleanupTouch = state.terminalTouchCleanupByCardId.get(id);
      if (cleanupTouch) cleanupTouch();
      if (transcriptView?.raf) window.cancelAnimationFrame(transcriptView.raf);
      if (term) {
        try {
          term.dispose();
        } catch (_) {}
      }
      if (element) element.remove();
      if (transcriptView) transcriptView.root.remove();
      state.terminalByCardId.delete(id);
      state.fitByCardId.delete(id);
      state.terminalElementByCardId.delete(id);
      state.terminalTouchCleanupByCardId.delete(id);
      state.terminalSnapshotByCardId.delete(id);
      state.transcriptChunksByCardId.delete(id);
      state.transcriptRowsByCardId.delete(id);
      state.transcriptViewByCardId.delete(id);
      state.transcriptColsByCardId.delete(id);
      state.lastTranscriptSeqByCardId.delete(id);
      state.receivedTerminalSeqByCardId.delete(id);
      state.pendingTerminalOutputByCardId.delete(id);
      state.queuedTerminalOutputByCardId.delete(id);
      const timer = state.outputFlushTimerByCardId.get(id);
      if (timer) window.clearTimeout(timer);
      state.outputFlushTimerByCardId.delete(id);
      state.lastTerminalSeqByCardId.delete(id);
      state.appliedTerminalSnapshotSeqByCardId.delete(id);
      state.userScrolledTerminalByCardId.delete(id);
      state.touchScrollingTerminalByCardId.delete(id);
      state.suppressResizeByCardId.delete(id);
    }

    function applyServerMessage(message) {
      switch (message.kind) {
        case 'snapshot':
          {
            const nextIds = new Set();
            state.cards.clear();
            for (const card of Array.isArray(message.cards) ? message.cards : []) {
              mergeCard(card);
              if (card?.id) nextIds.add(String(card.id));
            }
            const knownIds = new Set([
              ...state.terminalByCardId.keys(),
              ...state.terminalSnapshotByCardId.keys(),
              ...state.transcriptChunksByCardId.keys(),
              ...state.pendingTerminalOutputByCardId.keys(),
              ...state.queuedTerminalOutputByCardId.keys(),
            ]);
            for (const id of knownIds) {
              if (!nextIds.has(id)) disposeTerminal(id);
            }
          }
          break;
        case 'card_added':
        case 'card_updated':
          mergeCard(message.card);
          break;
        case 'card_removed':
          if (message.card?.id) {
            const id = String(message.card.id);
            state.cards.delete(id);
            disposeTerminal(id);
          }
          if (state.selectedCardId === message.card?.id) state.selectedCardId = null;
          break;
        case 'preview': {
          const id = String(message.card_id || '');
          const existing = state.cards.get(id) || { id, status: 'idle', recentOutputBytes: 0 };
          state.cards.set(id, {
            ...existing,
            lastReplyPreview: String(message.last_reply_preview || ''),
            summaryLine: message.summary_line ? String(message.summary_line) : '',
            hiddenLineCount: Number(message.hidden_line_count || 0),
          });
          break;
        }
        case 'state': {
          const id = String(message.card_id || '');
          const existing = state.cards.get(id) || { id, projectPath: '', projectName: projectNameFromPath(''), lastReplyPreview: '', summaryLine: '', hiddenLineCount: 0, recentOutputBytes: 0 };
          state.cards.set(id, { ...existing, status: String(message.status || 'idle') });
          break;
        }
        case 'exit': {
          const id = String(message.card_id || '');
          const existing = state.cards.get(id);
          if (existing) {
            state.cards.set(id, { ...existing, status: message.code === 0 || message.code === null ? 'completed' : 'failed' });
          }
          break;
        }
        case 'attention': {
          const id = String(message.card_id || '');
          const existing = state.cards.get(id);
          if (existing && message.message) {
            state.cards.set(id, {
              ...existing,
              lastReplyPreview: `${existing.lastReplyPreview || ''}\n${message.message}`.trim(),
            });
          }
          break;
        }
        case 'terminal_snapshot':
          applyTerminalSnapshot(message.snapshot);
          return;
        case 'terminal_output':
          applyTerminalOutput(message);
          return;
        case 'pong':
        case 'notification':
          break;
        case 'error':
          statusTextEl.textContent = message.message || 'Bridge error.';
          statusBadgeEl.classList.add('error');
          break;
      }
      render();
    }

    function render() {
      clearElement(cardsEl);
      const cards = Array.from(state.cards.values()).sort((a, b) => a.id.localeCompare(b.id));
      const selected = state.selectedCardId ? state.cards.get(state.selectedCardId) : null;

      listViewEl.hidden = Boolean(selected);
      detailViewEl.hidden = !selected;

      if (selected) {
        renderDetail(selected);
        return;
      }

      if (cards.length === 0) {
        showTerminal('');
        const empty = document.createElement('div');
        empty.style.textAlign = 'center';
        empty.style.padding = '40px 20px';
        empty.style.opacity = '0.4';
        empty.textContent = 'No live terminal sessions.';
        cardsEl.appendChild(empty);
        cardsEl.hidden = false;
        return;
      }

      for (const card of cards) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'card';
        item.onclick = () => selectCard(card.id);

        const head = document.createElement('div');
        head.className = 'card-header';

        const info = document.createElement('div');
        info.className = 'card-title-group';

        const title = document.createElement('div');
        title.className = 'card-title';
        title.textContent = card.projectName || 'Session';

        const path = document.createElement('div');
        path.className = 'card-path';
        path.textContent = card.projectPath || '';

        info.append(title, path);

        const status = document.createElement('div');
        const statusValue = String(card.status || 'unknown');
        status.className = `pill ${statusValue}`;
        status.textContent = statusValue.replace('_', ' ');

        head.append(info, status);
        item.appendChild(head);

        const summary = String(card.summaryLine || '').trim();
        if (summary) {
          const summaryEl = document.createElement('div');
          summaryEl.className = 'summary-line';
          summaryEl.textContent = summary;
          item.appendChild(summaryEl);
        }

        const preview = document.createElement('div');
        preview.className = 'preview';
        const lines = previewLines(card, 2, Boolean(summary));
        if (lines.length === 0 && !summary) lines.push('No output yet.');
        for (const line of lines) {
          const r = document.createElement('div');
          r.className = 'preview-line';
          r.textContent = line;
          preview.appendChild(r);
        }
        item.appendChild(preview);

        const footer = document.createElement('div');
        footer.className = 'card-footer';
        const hidden = Number(card.hiddenLineCount || 0);
        footer.textContent = `${formatBytes(Number(card.recentOutputBytes || 0))} output${hidden > 0 ? ` · +${hidden} lines` : ''}`;
        item.appendChild(footer);

        cardsEl.appendChild(item);
      }
      cardsEl.hidden = false;
    }

    function renderDetail(card) {
      detailTitleEl.textContent = card.projectName || `Session ${String(card.id || '').slice(0, 12) || 'unknown'}`;
      readonlyNoticeEl.hidden = state.permission === 'full';
      controlPanelEl.hidden = state.permission !== 'full';
      terminalKeyboardEl.hidden = state.permission !== 'full';
      terminalKeyboardEl.disabled = state.permission !== 'full';
      showTerminal(card.id);
    }

    function selectCard(cardId) {
      state.selectedCardId = cardId;
      if (!state.suppressListHistory && window.history?.pushState) {
        window.history.pushState({ view: 'detail', cardId }, '', window.location.href);
      }
      render();
    }

    function showList() {
      state.selectedCardId = null;
      showTerminal('');
      render();
    }

    function returnToListFromHistory() {
      state.suppressListHistory = true;
      try {
        showList();
      } finally {
        state.suppressListHistory = false;
      }
    }

    function canSendInput(cardId = state.selectedCardId) {
      return state.permission === 'full'
        && cardId
        && state.socket
        && state.socket.readyState === WebSocket.OPEN;
    }

    function sendInput(data, cardId = state.selectedCardId) {
      if (!data) return;
      if (!canSendInput(cardId)) {
        if (state.permission === 'full' && cardId) {
          flashInputError('Disconnected — reconnecting...');
          scheduleReconnect();
        }
        return;
      }
      try {
        state.socket.send(JSON.stringify({
          protocol_version: BRIDGE_PROTOCOL_VERSION,
          kind: 'input',
          card_id: cardId,
          data,
        }));
      } catch (error) {
        flashInputError('Send failed — reconnecting...');
        try { state.socket && state.socket.close(); } catch (_) {}
        state.socket = null;
        scheduleReconnect();
      }
    }

    function readPendingInput() {
      const buffered = String(state.pendingInputBuffer || '');
      const live = String(terminalKeyboardEl.value || '');
      const raw = live.length >= buffered.length ? live : buffered;
      return raw.replace(/\r?\n/g, '\r');
    }

    function clearPendingInput() {
      state.pendingInputBuffer = '';
      terminalKeyboardEl.value = '';
    }

    function flashSentDiagnostic(value) {
      const preview = value && value.length > 0
        ? (value.length > 24 ? `${value.slice(0, 24)}…` : value)
        : '<empty>';
      setStatus(`Sent: ${preview}`, value ? 'ok' : 'error');
    }

    function performSendKeyboardBuffer() {
      const value = readPendingInput();
      clearPendingInput();
      flashSentDiagnostic(value);
      sendInput(value ? `${value}\r` : '\r');
    }

    function sendKeyboardBuffer() {
      if (!canSendInput()) {
        flashInputError('Disconnected — reconnecting...');
        scheduleReconnect();
        return;
      }
      // Defer the actual read by ~30ms so iOS Safari has time to commit
      // any pending predictive-text/QuickType characters into either the
      // textarea `.value` or our shadow buffer via the `input` event.
      // Reading synchronously can race ahead of iOS' commit, producing an
      // empty string and only sending `\r`.
      window.setTimeout(performSendKeyboardBuffer, 30);
    }

    function sendResize(cardId, cols, rows) {
      if (state.suppressResizeByCardId.has(cardId) || !canSendInput(cardId)) return;
      state.socket.send(JSON.stringify({
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        kind: 'resize',
        card_id: cardId,
        cols,
        rows,
      }));
    }

    function scheduleReconnect(reason) {
      if (!state.token) return;
      if (state.socket) return;
      if (state.reconnectTimer) return;
      const attempt = Math.min(Number(state.reconnectAttempts || 0), 6);
      const delay = Math.min(30000, 1000 * Math.pow(2, attempt));
      state.reconnectAttempts = attempt + 1;
      if (reason) setStatus(reason, 'error');
      state.reconnectTimer = window.setTimeout(() => {
        state.reconnectTimer = 0;
        if (!state.socket) connectWebSocket();
      }, delay);
    }

    function flashInputError(message) {
      setStatus(message || 'Send failed — reconnecting...', 'error');
      try {
        terminalKeyboardEl.classList.add('input-error');
      } catch (_) {}
      window.clearTimeout(state.pendingInputFailFlash);
      state.pendingInputFailFlash = window.setTimeout(() => {
        try {
          terminalKeyboardEl.classList.remove('input-error');
        } catch (_) {}
      }, 1200);
    }

    function connectWebSocket() {
      if (!state.token) return;
      if (!otp) {
        syncStoredPermission();
      }
      if (state.socket) state.socket.close();
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = 0;

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${location.host}/ws?token=${encodeURIComponent(state.token)}`;
      const socket = new WebSocket(url);
      state.socket = socket;
      setStatus('Connecting...', '');

      socket.onopen = () => {
        setStatus('Connected', 'ok');
        state.reconnectAttempts = 0;
        socket.send(JSON.stringify({ protocol_version: BRIDGE_PROTOCOL_VERSION, kind: 'subscribe' }));
        retryEl.hidden = true;
      };

      socket.onmessage = (event) => {
        try {
          applyServerMessage(validateMessage(JSON.parse(event.data)));
        } catch (error) {
          statusTextEl.textContent = error instanceof Error ? error.message : String(error);
          statusBadgeEl.classList.add('error');
        }
      };

      socket.onerror = () => {
        setStatus('Connection error', 'error');
      };

      socket.onclose = (event) => {
        if (state.socket !== socket) return;
        state.socket = null;
        const closedToken = state.token;
        setStatus('Disconnected', 'error');
        if (!otp && closedToken && (event.code === 1006 || event.code === 1008 || event.code === 1011)) {
          storedTokenStillAuthorized(closedToken).then((authorized) => {
            if (authorized || state.token !== closedToken) {
              scheduleReconnect('Disconnected — reconnecting...');
              return;
            }
            clearStoredPairing();
            setStatus('Pairing expired. Scan a fresh QR code.', 'error');
            retryEl.hidden = false;
          });
        } else {
          scheduleReconnect('Disconnected — reconnecting...');
        }
        retryEl.hidden = false;
      };
    }

    async function pair() {
      retryEl.hidden = true;
      cardsEl.hidden = true;
      clearElement(cardsEl);

      if (!otp && hasStoredToken()) {
        scrubPairingCodeFromUrl();
        connectWebSocket();
        return;
      }

      if (!otp) {
        setStatus('Missing pairing code', 'error');
        return;
      }

      try {
        setStatus('Pairing device...');

        const response = await fetch('/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ otp, deviceName: deviceName(), permission: state.pairPermission }),
        });

        if (!response.ok) {
          const message = await response.text();
          throw new Error(message || `Pairing failed with HTTP ${response.status}`);
        }

        const payload = await response.json();
        state.token = payload.deviceToken || '';
        state.permission = payload.device?.permission || 'read_only';
        refreshTerminalPermission();
        localStorage.setItem(TOKEN_KEY, state.token);
        localStorage.setItem(PERMISSION_KEY, state.permission);
        scrubPairingCodeFromUrl();
        setStatus('Paired', 'ok');
        connectWebSocket();
      } catch (error) {
        setStatus('Pairing failed', 'error');
        statusTextEl.textContent = error instanceof Error ? error.message : String(error);
        retryEl.hidden = false;
      }
    }

    retryEl.addEventListener('click', pair);
    backEl.addEventListener('click', showList);
    terminalKeyboardEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendKeyboardBuffer();
      }
    });
    // Mirror the visible textarea content into a shadow buffer so iOS
    // QuickType / predictive text cannot strand the typed text when the
    // textarea loses focus before its `.value` is committed.
    terminalKeyboardEl.addEventListener('input', () => {
      state.pendingInputBuffer = String(terminalKeyboardEl.value || '');
    });
    terminalKeyboardEl.addEventListener('compositionend', () => {
      state.pendingInputBuffer = String(terminalKeyboardEl.value || '');
    });
    // Prevent the action buttons from stealing focus on touchstart so iOS
    // does not dismiss the keyboard before the textarea commits pending
    // characters (predictive text otherwise gets dropped).
    const keepKeyboardFocus = (event) => {
      if (document.activeElement === terminalKeyboardEl) {
        event.preventDefault();
      }
    };
    sendEnterEl.addEventListener('mousedown', keepKeyboardFocus);
    sendEnterEl.addEventListener('touchstart', keepKeyboardFocus, { passive: false });
    sendCtrlCEl.addEventListener('mousedown', keepKeyboardFocus);
    sendCtrlCEl.addEventListener('touchstart', keepKeyboardFocus, { passive: false });
    sendEscEl.addEventListener('mousedown', keepKeyboardFocus);
    sendEscEl.addEventListener('touchstart', keepKeyboardFocus, { passive: false });
    sendEnterEl.addEventListener('click', sendKeyboardBuffer);
    sendCtrlCEl.addEventListener('click', () => {
      clearPendingInput();
      sendInput('\u0003');
    });
    sendEscEl.addEventListener('click', () => sendInput('\u001b'));
    window.addEventListener('popstate', () => {
      if (state.selectedCardId) {
        returnToListFromHistory();
      } else if (hasStoredToken()) {
        scrubPairingCodeFromUrl();
      }
    });
    if (typeof ResizeObserver === 'function') {
      state.resizeObserver = new ResizeObserver(() => {
        if (state.selectedCardId) fitTerminal(state.selectedCardId);
      });
      state.resizeObserver.observe(terminalHostEl);
    }
    window.addEventListener('resize', () => {
      if (state.selectedCardId) fitTerminal(state.selectedCardId);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!state.token) return;
      if (state.socket && state.socket.readyState === WebSocket.OPEN) return;
      state.reconnectAttempts = 0;
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = 0;
      connectWebSocket();
    });
    window.addEventListener('online', () => {
      if (!state.token) return;
      if (state.socket && state.socket.readyState === WebSocket.OPEN) return;
      state.reconnectAttempts = 0;
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = 0;
      connectWebSocket();
    });
    pair();
  </script>
</body>
</html>"###
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_pair_page_html(otp: Option<&str>, pair_permission: &str) -> String {
        pair_page_html(otp, pair_permission, None, None, None, None)
    }

    #[test]
    fn pair_landing_page_posts_otp_to_pair_endpoint() {
        let html = test_pair_page_html(Some("123456"), "read_only");

        assert!(html.contains("ThreadTerm Mobile Pairing"));
        assert!(html.contains("MOBILE_TERMINAL_SCROLLBACK"));
        assert!(html.contains("MOBILE_TERMINAL_OUTPUT_BATCH_MS"));
        assert!(html.contains("MOBILE_TOUCH_SCROLL_MULTIPLIER"));
        assert!(html.contains("href=\"/assets/xterm.css\""));
        assert!(html.contains("src=\"/assets/xterm.js\""));
        assert!(html.contains("src=\"/assets/addon-fit.js\""));
        assert!(html.contains("let otp = \"123456\";"));
        assert!(html.contains("const pairPermission = \"read_only\";"));
        assert!(html.contains("permission: otp ? pairPermission"));
        assert!(html.contains("function syncStoredPermission"));
        assert!(html.contains("function scrubPairingCodeFromUrl"));
        assert!(html.contains("function hasStoredToken"));
        assert!(html.contains("if (!otp && hasStoredToken())"));
        assert!(html.contains("otp = '';"));
        assert!(html.contains("url.searchParams.delete('otp')"));
        assert!(html.contains("window.history.pushState"));
        assert!(html.contains("window.addEventListener('popstate'"));
        assert!(html.contains("returnToListFromHistory"));
        assert!(html.contains("fetch('/pair'"));
        assert!(html.contains("deviceName"));
        assert!(html.contains("permission: state.pairPermission"));
        assert!(html.contains("new WebSocket"));
        assert!(html.contains("function applyServerMessage"));
        assert!(html.contains("function selectCard"));
        assert!(html.contains("function sendInput"));
        assert!(html.contains("function ensureTerminal"));
        assert!(html.contains("function terminalTheme"));
        assert!(html.contains("function scrollTerminalToBottom"));
        assert!(html.contains("function showTerminalFallback"));
        assert!(html.contains("function refreshVisibleTerminal"));
        assert!(html.contains("function applyTerminalSnapshot"));
        assert!(html.contains("function applyTerminalOutput"));
        assert!(html.contains("state.suppressResizeByCardId.add(id);"));
        assert!(html.contains("MOBILE_TRANSCRIPT_ROW_HEIGHT"));
        assert!(html.contains("MOBILE_TRANSCRIPT_OVERSCAN_ROWS"));
        assert!(html.contains("transcriptChunksByCardId"));
        assert!(html.contains("transcriptRowsByCardId"));
        assert!(html.contains("function usesTranscriptRenderer"));
        assert!(html.contains("function ensureTranscriptView"));
        assert!(html.contains("function renderTranscriptWindow"));
        assert!(html.contains("function appendTranscriptOutput"));
        assert!(html.contains("function scheduleRenderTranscriptWindow"));
        assert!(html.contains("rows._cursorCol"));
        assert!(html.contains("command === 'K'"));
        assert!(html.contains("char === '\\r'"));
        assert!(html.contains("root.addEventListener('touchstart', blurTerminalKeyboard"));
        assert!(html.contains("function blurTerminalKeyboard"));
        assert!(html.contains("id=\"terminal-keyboard\""));
        assert!(html.contains("function sendKeyboardBuffer"));
        assert!(html.contains("sendInput(value ? `${value}\\r` : '\\r')"));
        assert!(html.contains("terminalKeyboardEl.addEventListener('keydown'"));
        assert!(html.contains("event.key === 'Enter' && !event.shiftKey"));
        assert!(html.contains("sendEnterEl.addEventListener('click', sendKeyboardBuffer)"));
        assert!(html.contains("terminalKeyboardEl.addEventListener('input'"));
        assert!(html.contains("terminalKeyboardEl.addEventListener('compositionend'"));
        assert!(html.contains("state.pendingInputBuffer"));
        assert!(html.contains("function readPendingInput"));
        assert!(html.contains("terminalKeyboardEl.addEventListener('keydown'"));
        assert!(html.contains("terminal-transcript-row"));
        assert!(html.contains("DocumentFragment"));
        assert!(html.contains("- MOBILE_TRANSCRIPT_OVERSCAN_ROWS"));
        assert!(html.contains("appendTranscriptOutput(cardId, chunk.data, chunkSeq)"));
        assert!(html.contains("function syncTranscriptRowsFromTerminal"));
        assert!(html.contains("term.write(data, () =>"));
        assert!(html.contains("line.translateToString(true)"));
        assert!(html.contains("line?.isWrapped && /^orking"));
        assert!(html.contains("pendingTerminalOutputByCardId"));
        assert!(html.contains("queuedTerminalOutputByCardId"));
        assert!(html.contains("appliedTerminalSnapshotSeqByCardId"));
        assert!(html.contains("userScrolledTerminalByCardId"));
        assert!(html.contains("function flushPendingTerminalOutput"));
        assert!(html.contains("function queueTerminalOutput"));
        assert!(html.contains("function writeTerminalOutputChunk"));
        assert!(html.contains("function installTouchScrollAdapter"));
        assert!(html.contains("term.scrollLines(rows)"));
        assert!(html.contains("touchmove"));
        assert!(html.contains("writeTerminalSnapshot(id, snapshot, { force: true })"));
        assert!(html.contains("seq <= appliedSeq"));
        assert!(html.contains("scrollback: MOBILE_TERMINAL_SCROLLBACK"));
        assert!(!html.contains("window.setTimeout(() => term.focus(), 0)"));
        assert!(html.contains("terminal-fallback"));
        assert!(html.contains("className = 'card'"));
        assert!(html.contains("id=\"cards\""));
        assert!(html.contains("id=\"terminal-shell\""));
        assert!(html.contains("id=\"terminal-host\""));
        assert!(html.contains("min-height: calc(100vh - 220px)"));
        assert!(html.contains("--terminal-bg: #000;"));
        assert!(html.contains("background: var(--terminal-bg)"));
        assert!(html.contains("cssVar('--terminal-bg', '#000')"));
        assert!(html.contains("window.setTimeout(scroll, 120)"));
        assert_eq!(html.matches("<style>").count(), 1);
        assert!(html.contains("id=\"control-panel\""));
        assert!(html.contains("id=\"send-enter\""));
        assert!(html.contains("projectName"));
        assert!(html.contains("summaryLine"));
        assert!(html.contains("case 'terminal_snapshot'"));
        assert!(html.contains("case 'terminal_output'"));
        assert!(html.contains("sendEnterEl.addEventListener('click', sendKeyboardBuffer)"));
        assert!(html.contains("kind: 'input'"));
        assert!(!html.contains("id=\"detail-preview\""));
        assert!(!html.contains("id=\"send-input\""));
        assert!(!html.contains("placeholder=\"Type input and tap Send\""));
        assert!(!html.contains("JSON.stringify(await snapshot.json()"));
    }

    #[test]
    fn pair_landing_page_handles_missing_otp() {
        let html = test_pair_page_html(None, "read_only");

        assert!(html.contains("let otp = \"\";"));
        assert!(html.contains("localStorage.getItem(TOKEN_KEY)"));
        assert!(html.contains("Missing pairing code"));
    }

    #[test]
    fn pair_landing_page_accepts_full_control_permission() {
        let html = test_pair_page_html(Some("123456"), "full");

        assert!(html.contains("const pairPermission = \"full\";"));
        assert!(html.contains("controlPanelEl.hidden = state.permission !== 'full'"));
        assert!(html.contains("disableStdin: state.permission !== 'full'"));
        assert!(html.contains("term.onData((data)"));
        assert_eq!(normalize_pair_permission(Some("full")), "full");
        assert_eq!(normalize_pair_permission(Some("admin")), "read_only");
    }
}
