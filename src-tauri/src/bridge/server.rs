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

    mobile_pair_page_template().replace("__OTP_JSON__", &otp_json)
}

fn mobile_pair_page_template() -> &'static str {
    r###"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>ThreadTerm Mobile Pairing</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #10151d;
      color: #e8edf5;
    }
    * { box-sizing: border-box; }
    html,
    body {
      width: 100%;
      overflow-x: hidden;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: stretch;
      background: #10151d;
    }
    main {
      width: 100%;
      max-width: 720px;
      min-width: 0;
      margin: 0 auto;
      overflow-x: hidden;
      padding: max(24px, env(safe-area-inset-top)) 18px max(24px, env(safe-area-inset-bottom));
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(24px, 9vw, 42px);
      line-height: 1.2;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: #a9b4c3;
      line-height: 1.5;
    }
    .panel {
      margin-top: 22px;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      border: 1px solid #303949;
      border-radius: 12px;
      background: #151b24;
      padding: 16px;
    }
    .toolbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }
    .status {
      font-size: 14px;
      font-weight: 650;
      color: #e8edf5;
    }
    .muted { color: #a9b4c3; }
    .error { color: #ff8a8a; }
    .ok { color: #7dd3a8; }
    .actions {
      display: flex;
      flex: 0 0 auto;
      gap: 8px;
    }
    .cards {
      margin-top: 12px;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 10px;
      min-width: 0;
    }
    .card {
      display: block;
      width: 100%;
      min-width: 0;
      max-width: 100%;
      margin: 0;
      border-radius: 10px;
      background: #0b0f16;
      padding: 12px;
      border: 1px solid #253043;
      color: inherit;
      text-align: left;
      box-shadow: 0 18px 44px rgba(0, 0, 0, 0.22);
    }
    .card:active { transform: translateY(1px); }
    .card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
      min-width: 0;
    }
    .card-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 700;
    }
    .pill {
      flex: 0 0 auto;
      border-radius: 999px;
      background: #1f2a3a;
      padding: 3px 8px;
      color: #cbd7e8;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .pill.running { color: #7dd3a8; }
    .pill.failed { color: #ff8a8a; }
    .preview {
      min-width: 0;
      color: #d9e7ff;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
    }
    .preview-line {
      max-width: 100%;
      overflow: hidden;
      overflow-wrap: anywhere;
      white-space: normal;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .detail-preview .preview-line {
      -webkit-line-clamp: unset;
      display: block;
      padding: 2px 0;
    }
    .meta {
      margin-top: 8px;
      color: #738198;
      font-size: 11px;
    }
    .empty,
    .notice {
      margin-top: 12px;
      border-radius: 10px;
      background: #0b0f16;
      padding: 14px;
      color: #a9b4c3;
    }
    .detail-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
      margin-top: 14px;
    }
    .detail-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #e8edf5;
      font-size: 18px;
      font-weight: 750;
    }
    .detail-preview {
      margin-top: 12px;
      max-height: 48vh;
      overflow: auto;
      border-radius: 10px;
      border: 1px solid #253043;
      background: #0b0f16;
      padding: 12px;
    }
    button {
      min-height: 44px;
      border: 0;
      border-radius: 10px;
      background: #4f8bd6;
      color: #07111f;
      font-weight: 700;
      padding: 10px 14px;
    }
    .ghost {
      background: #1f2a3a;
      color: #dbe7f7;
    }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <main>
    <h1>ThreadTerm Mobile Pairing</h1>
    <p id="summary">Pair this device with the desktop bridge.</p>
    <section class="panel">
      <div class="toolbar">
        <div style="min-width:0">
          <div id="status" class="status">Preparing pairing...</div>
          <p id="detail" class="muted"></p>
        </div>
        <div class="actions">
          <button id="retry" type="button" class="ghost" hidden>Retry</button>
        </div>
      </div>
      <div id="list-view">
        <div id="cards" class="cards" hidden></div>
      </div>
      <div id="detail-view" hidden>
        <div class="detail-head">
          <div>
            <div id="detail-title" class="detail-title"></div>
            <div id="detail-meta" class="meta"></div>
          </div>
          <button id="back" type="button" class="ghost">Back</button>
        </div>
        <div id="detail-preview" class="preview detail-preview"></div>
        <div id="readonly-notice" class="notice">
          This paired device is read-only. Input controls are disabled.
        </div>
      </div>
    </section>
  </main>
  <script>
    const BRIDGE_PROTOCOL_VERSION = 1;
    const otp = __OTP_JSON__;
    const TOKEN_KEY = 'threadterm.bridgeToken';
    const PERMISSION_KEY = 'threadterm.bridgePermission';
    const statusEl = document.getElementById('status');
    const detailEl = document.getElementById('detail');
    const retryEl = document.getElementById('retry');
    const listViewEl = document.getElementById('list-view');
    const detailViewEl = document.getElementById('detail-view');
    const cardsEl = document.getElementById('cards');
    const backEl = document.getElementById('back');
    const detailTitleEl = document.getElementById('detail-title');
    const detailMetaEl = document.getElementById('detail-meta');
    const detailPreviewEl = document.getElementById('detail-preview');
    const readonlyNoticeEl = document.getElementById('readonly-notice');

    const state = {
      token: localStorage.getItem(TOKEN_KEY) || '',
      permission: localStorage.getItem(PERMISSION_KEY) || 'read_only',
      cards: new Map(),
      selectedCardId: null,
      socket: null,
      reconnectTimer: 0,
    };

    function deviceName() {
      const ua = navigator.userAgent || 'Mobile Browser';
      return ua.length > 80 ? ua.slice(0, 80) : ua;
    }

    function setStatus(message, kind = '') {
      statusEl.textContent = message;
      statusEl.className = `status ${kind}`;
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

    function previewLines(card, limit = 3) {
      return String(card?.lastReplyPreview || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-limit);
    }

    function normalizeCard(card) {
      if (!card || !card.id) return null;
      return {
        id: String(card.id),
        status: String(card.status || 'idle'),
        lastReplyPreview: String(card.lastReplyPreview || ''),
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

    function applyServerMessage(message) {
      switch (message.kind) {
        case 'snapshot':
          state.cards.clear();
          for (const card of Array.isArray(message.cards) ? message.cards : []) {
            mergeCard(card);
          }
          break;
        case 'card_added':
        case 'card_updated':
          mergeCard(message.card);
          break;
        case 'card_removed':
          if (message.card?.id) state.cards.delete(String(message.card.id));
          if (state.selectedCardId === message.card?.id) state.selectedCardId = null;
          break;
        case 'preview': {
          const id = String(message.card_id || '');
          const existing = state.cards.get(id) || { id, status: 'idle', recentOutputBytes: 0 };
          state.cards.set(id, {
            ...existing,
            lastReplyPreview: String(message.last_reply_preview || ''),
            hiddenLineCount: Number(message.hidden_line_count || 0),
          });
          break;
        }
        case 'state': {
          const id = String(message.card_id || '');
          const existing = state.cards.get(id) || { id, lastReplyPreview: '', hiddenLineCount: 0, recentOutputBytes: 0 };
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
        case 'pong':
        case 'notification':
          break;
        case 'error':
          detailEl.textContent = message.message || 'Bridge error.';
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
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No live terminal sessions yet.';
        cardsEl.appendChild(empty);
        cardsEl.hidden = false;
        return;
      }

      for (const card of cards) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'card session-card';
        item.addEventListener('click', () => selectCard(card.id));

        const head = document.createElement('div');
        head.className = 'card-head';

        const title = document.createElement('div');
        title.className = 'card-title';
        title.textContent = `Session ${String(card.id || '').slice(0, 8) || 'unknown'}`;

        const status = document.createElement('div');
        const statusValue = String(card.status || 'unknown');
        status.className = `pill ${statusValue}`;
        status.textContent = statusValue.replaceAll('_', ' ');

        head.append(title, status);
        item.appendChild(head);

        const preview = document.createElement('div');
        preview.className = 'preview';
        const lines = previewLines(card, 2);
        if (lines.length === 0) lines.push('No preview yet.');
        for (const line of lines) {
          const row = document.createElement('div');
          row.className = 'preview-line';
          row.textContent = line;
          preview.appendChild(row);
        }
        item.appendChild(preview);

        const meta = document.createElement('div');
        meta.className = 'meta';
        const hidden = Number(card.hiddenLineCount || 0);
        meta.textContent = `${formatBytes(Number(card.recentOutputBytes || 0))} output${hidden > 0 ? ` · +${hidden} hidden lines` : ''}`;
        item.appendChild(meta);

        cardsEl.appendChild(item);
      }
      cardsEl.hidden = false;
    }

    function renderDetail(card) {
      detailTitleEl.textContent = `Session ${String(card.id || '').slice(0, 12) || 'unknown'}`;
      const hidden = Number(card.hiddenLineCount || 0);
      detailMetaEl.textContent = `${String(card.status || 'unknown').replaceAll('_', ' ')} · ${formatBytes(Number(card.recentOutputBytes || 0))} output${hidden > 0 ? ` · +${hidden} hidden lines` : ''}`;
      readonlyNoticeEl.hidden = state.permission === 'full';

      clearElement(detailPreviewEl);
      const lines = previewLines(card, 12);
      if (lines.length === 0) lines.push('No preview yet.');
      for (const line of lines) {
        const row = document.createElement('div');
        row.className = 'preview-line';
        row.textContent = line;
        detailPreviewEl.appendChild(row);
      }
    }

    function selectCard(cardId) {
      state.selectedCardId = cardId;
      render();
    }

    function showList() {
      state.selectedCardId = null;
      render();
    }

    function connectWebSocket() {
      if (!state.token) return;
      if (state.socket) state.socket.close();
      window.clearTimeout(state.reconnectTimer);

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${location.host}/ws?token=${encodeURIComponent(state.token)}`;
      const socket = new WebSocket(url);
      state.socket = socket;
      setStatus('Connecting...', '');
      detailEl.textContent = 'Opening live bridge connection.';

      socket.onopen = () => {
        setStatus('Connected', 'ok');
        detailEl.textContent = state.permission === 'full'
          ? 'Live desktop sessions synced. Full controls are enabled.'
          : 'Live desktop sessions synced in read-only mode.';
        socket.send(JSON.stringify({ protocol_version: BRIDGE_PROTOCOL_VERSION, kind: 'subscribe' }));
        retryEl.hidden = true;
      };

      socket.onmessage = (event) => {
        try {
          applyServerMessage(validateMessage(JSON.parse(event.data)));
        } catch (error) {
          detailEl.textContent = error instanceof Error ? error.message : String(error);
        }
      };

      socket.onerror = () => {
        setStatus('Connection error', 'error');
        detailEl.textContent = 'The desktop bridge connection failed.';
      };

      socket.onclose = () => {
        if (state.socket !== socket) return;
        state.socket = null;
        setStatus('Disconnected', 'error');
        detailEl.textContent = 'The bridge connection closed. Retry when the desktop bridge is running.';
        retryEl.hidden = false;
      };
    }

    async function pair() {
      retryEl.hidden = true;
      cardsEl.hidden = true;
      clearElement(cardsEl);

      if (!otp) {
        if (state.token) {
          connectWebSocket();
          return;
        }
        setStatus('Missing pairing code', 'error');
        detailEl.textContent = 'Open the pairing link shown in ThreadTerm again.';
        return;
      }

      try {
        setStatus('Pairing device...');
        detailEl.textContent = 'This one-time code will be consumed after a successful pairing.';

        const response = await fetch('/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ otp, deviceName: deviceName(), permission: 'read_only' }),
        });

        if (!response.ok) {
          const message = await response.text();
          throw new Error(message || `Pairing failed with HTTP ${response.status}`);
        }

        const payload = await response.json();
        state.token = payload.deviceToken || '';
        state.permission = payload.device?.permission || 'read_only';
        localStorage.setItem(TOKEN_KEY, state.token);
        localStorage.setItem(PERMISSION_KEY, state.permission);
        setStatus('Paired', 'ok');
        detailEl.textContent = 'Pairing succeeded. Connecting to live sessions.';
        connectWebSocket();
      } catch (error) {
        setStatus('Pairing failed', 'error');
        detailEl.textContent = error instanceof Error ? error.message : String(error);
        retryEl.hidden = false;
      }
    }

    retryEl.addEventListener('click', pair);
    backEl.addEventListener('click', showList);
    pair();
  </script>
</body>
</html>"###
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
        assert!(html.contains("permission: 'read_only'"));
        assert!(html.contains("new WebSocket"));
        assert!(html.contains("function applyServerMessage"));
        assert!(html.contains("function selectCard"));
        assert!(html.contains("className = 'card session-card'"));
        assert!(html.contains("overflow-wrap: anywhere"));
        assert!(html.contains("id=\"cards\""));
        assert!(!html.contains("JSON.stringify(await snapshot.json()"));
    }

    #[test]
    fn pair_landing_page_handles_missing_otp() {
        let html = pair_page_html(None);

        assert!(html.contains("const otp = \"\";"));
        assert!(html.contains("localStorage.getItem(TOKEN_KEY)"));
        assert!(html.contains("Missing pairing code"));
    }
}
