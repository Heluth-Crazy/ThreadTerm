use crate::{
    domain::{RpcRequest, RpcResponse},
    protocol_contract::{self, ContractRole},
    service::RuntimeService,
    PROTOCOL_CONTRACT, PROTOCOL_VERSION,
};
use anyhow::{bail, Context, Result};
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::Sha256;
use std::sync::{Arc, Mutex};

#[cfg(windows)]
use crate::send_trace::{self, Context as SendTraceContext, Event as SendTraceEvent, Timer as SendTraceTimer};

pub const MAX_FRAME: usize = 8 * 1024 * 1024;
/// One control frame never carries more than this. A larger answer is refused
/// for that request alone (`response_too_large`), so a legal long transcript can
/// never tear down the connection and the other views on it.
pub const MAX_RESPONSE_BYTES: usize = 6 * 1024 * 1024;
const TERMINAL_HISTORY_GAP: &str = "terminal_history_gap";
type HmacSha256 = Hmac<Sha256>;

fn is_terminal_history_gap(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string() == TERMINAL_HISTORY_GAP)
}

fn output_gap_cursor(db: &crate::db::Database, id: &str, cursor: i64) -> Result<i64> {
    // The boundary read checks its watermark under one DB lock, distinguishing
    // retention from corruption before falling back to the current durable end.
    match db.read_output_window(id, Some(cursor), false, 1) {
        Ok((from, _, _, _)) if from > cursor => Ok(from),
        Ok(_) => db.output_end(id),
        Err(error) if is_terminal_history_gap(&error) => db.output_end(id),
        Err(error) => Err(error),
    }
}

fn advance_cursor_past_history_gap(cursor: &mut i64, durable_end: i64) {
    *cursor = durable_end;
}

#[cfg(windows)]
fn guard_stream(service: &RuntimeService, principal: &str, method: &str) -> Result<()> {
    crate::peer::guard(service, principal, method)
        .map_err(|error| anyhow::anyhow!("{}: {}", error.code, error.message))
}

#[cfg(windows)]
pub async fn serve(service: Arc<RuntimeService>, credential: String) -> Result<()> {
    // Before the first connection, so every live lease still belongs to a client of a previous runtime.
    service.leases.adopt_previous(&service.db)?;
    tokio::try_join!(
        accept_control(Arc::clone(&service), credential.clone()),
        accept_output(Arc::clone(&service), credential.clone()),
        accept_browser(Arc::clone(&service), credential)
    )?;
    Ok(())
}
#[cfg(windows)]
async fn accept_control(service: Arc<RuntimeService>, credential: String) -> Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let name = service.config.control_pipe();
    let mut first = true;
    loop {
        let mut acl = crate::windows_security::SecurityAttributes::current_user_only()?;
        let mut pipe = unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .create_with_security_attributes_raw(&name, acl.raw().cast())
        }
        .context("creating control named pipe")?;
        first = false;
        {
            let connection = pipe.connect();
            tokio::pin!(connection);
            loop {
                tokio::select! {
                    result = &mut connection => { result?; break; }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                        if service.shutdown_requested() { return Ok(()); }
                    }
                }
            }
        }
        let s = Arc::clone(&service);
        let c = credential.clone();
        tokio::spawn(async move {
            let Ok(epoch) = s.db.epoch() else { return; };
            let Ok(principal) = authenticate(&mut pipe, &c, &epoch).await else { return; };
            let _ = serve_control(pipe, s, principal).await;
        });
        if service.shutdown_requested() {
            return Ok(());
        }
    }
}
#[cfg(windows)]
async fn accept_browser(service: Arc<RuntimeService>, credential: String) -> Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let name = service.config.browser_pipe();
    let mut first = true;
    loop {
        let mut acl = crate::windows_security::SecurityAttributes::current_user_only()?;
        let mut pipe = unsafe {
            ServerOptions::new().first_pipe_instance(first)
                .create_with_security_attributes_raw(&name, acl.raw().cast())
        }.context("creating private browser named pipe")?;
        first = false;
        tokio::select! {
            connected = pipe.connect() => { connected?; }
            _ = service.wait_for_shutdown() => return Ok(()),
        }
        let service = Arc::clone(&service);
        let credential = credential.clone();
        tokio::spawn(async move {
            let Ok(epoch) = service.db.epoch() else { return; };
            let Ok(principal) = authenticate(&mut pipe, &credential, &epoch).await else { return; };
            let _ = serve_browser(pipe, service, principal).await;
        });
    }
}

#[cfg(windows)]
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserRequest {
    v: u32,
    id: String,
    method: String,
    params: Value,
}

/// This connection carries only private browser traffic. Admission never
/// waits in the decoder; replies retain capacity independently of admin work.
#[cfg(windows)]
pub(crate) async fn serve_browser<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    pipe: T,
    service: Arc<RuntimeService>,
    principal: String,
) -> Result<()> {
    let connection_id = uuid::Uuid::new_v4().to_string();
    let (events, mut notifications) = tokio::sync::mpsc::channel::<Value>(128);
    let _presence = service.browser_tools.connect(&principal, &connection_id, events)?;
    let (mut reader, mut writer) = tokio::io::split(pipe);
    let mut decoder = FrameDecoder::default();
    let (completed, mut replies) = tokio::sync::mpsc::channel::<Value>(64);
    let administration = Arc::new(tokio::sync::Semaphore::new(48));
    let acknowledgements = Arc::new(tokio::sync::Semaphore::new(16));
    loop {
        tokio::select! {
            frame = decoder.read(&mut reader) => {
                let frame = frame?;
                if frame.len() > 916 * 1024 { bail!("private browser frame exceeds limit"); }
                let request: BrowserRequest = serde_json::from_slice(&frame)?;
                if request.v != PROTOCOL_VERSION || request.id.is_empty() || request.id.len() > 256
                    || !request.params.is_object() || !matches!(request.method.as_str(),
                        "browser.attach" | "browser.registerTab" | "browser.unregisterTab" | "browser.detach" | "browser.desktop.dispatch" | "browser.desktop.reply" | "browser.desktop.evalPrepared" | "browser.desktop.evalInvalidated") {
                    bail!("invalid private browser request");
                }
                let pool = if matches!(request.method.as_str(), "browser.desktop.reply" | "browser.desktop.dispatch" | "browser.desktop.evalPrepared" | "browser.desktop.evalInvalidated") { &acknowledgements } else { &administration };
                let permit = match Arc::clone(pool).try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        let body = json!({"v":PROTOCOL_VERSION,"id":request.id,"error":{"code":"browser_busy","message":"Browser connection is busy"}});
                        // A stalled private writer invalidates this connection;
                        // it cannot create an unbounded completion queue.
                        completed.try_send(body).map_err(|_| anyhow::anyhow!("private browser reply queue full"))?;
                        continue;
                    }
                };
                let service = Arc::clone(&service);
                let principal = principal.clone();
                let connection_id = connection_id.clone();
                let completed = completed.clone();
                tokio::spawn(async move {
                    let id = request.id;
                    let result = tokio::task::spawn_blocking(move || {
                        guard_stream(&service, &principal, &request.method)?;
                        service.browser_tools.desktop_dispatch(&principal, &connection_id, &request.method, &request.params)
                    }).await;
                    let body = match result {
                        Ok(Ok(result)) => json!({"v":PROTOCOL_VERSION,"id":id,"result":result}),
                        Ok(Err(error)) => json!({"v":PROTOCOL_VERSION,"id":id,"error":crate::service::browser_rpc_error(error)}),
                        Err(_) => json!({"v":PROTOCOL_VERSION,"id":id,"error":{"code":"browser_request_failed","message":"Browser request could not be completed"}}),
                    };
                    let _ = completed.send(body).await;
                    drop(permit);
                });
            }
            Some(reply) = replies.recv() => { write_json(&mut writer, &reply).await?; }
            Some(notification) = notifications.recv() => { write_json(&mut writer, &notification).await?; }
            _ = service.wait_for_shutdown() => return Ok(()),
        }
    }
}

#[cfg(windows)]
async fn accept_output(service: Arc<RuntimeService>, credential: String) -> Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let name = service.config.output_pipe();
    let mut first = true;
    loop {
        let mut acl = crate::windows_security::SecurityAttributes::current_user_only()?;
        let mut pipe = unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .create_with_security_attributes_raw(&name, acl.raw().cast())
        }
        .context("creating output named pipe")?;
        first = false;
        {
            let connection = pipe.connect();
            tokio::pin!(connection);
            loop {
                tokio::select! {
                    result = &mut connection => { result?; break; }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                        if service.shutdown_requested() { return Ok(()); }
                    }
                }
            }
        }
        let s = Arc::clone(&service);
        let c = credential.clone();
        tokio::spawn(async move {
            let Ok(epoch) = s.db.epoch() else { return; };
            let Ok(principal) = authenticate(&mut pipe, &c, &epoch).await else { return; };
            let _ = serve_output(pipe, s, principal).await;
        });
        if service.shutdown_requested() {
            return Ok(());
        }
    }
}
#[cfg(not(windows))]
pub async fn serve(_service: Arc<RuntimeService>, _credential: String) -> Result<()> {
    bail!("ThreadTerm V3 runtime named-pipe transport is Windows-only")
}

/// How a control request is scheduled on its connection. Replies carry the request id, so
/// requests in different lanes may complete out of order; each sequenced lane keeps arrival order.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lane {
    /// Read-only and possibly slow (Git, file walks, review diffs, history pages): run
    /// concurrently, so one slow read never holds up terminal.read or a status poll. The
    /// desktop has one control connection; one-at-a-time dispatch let a slow request stall
    /// replay ("stopped at byte 0") and time out git.status (branch chip fell back to the folder).
    Concurrent,
    /// Terminal control (input, resize and the lease guarding them): arrival order, independent
    /// of slow mutations, so a 120 s `git push` never freezes typing or lets the lease lapse.
    Terminal,
    /// Everything else: one at a time in arrival order, as before.
    Ordered,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn request_lane(method: &str) -> Lane {
    if matches!(method, "browser.tool.call" | "browser.tool.cancel") { return Lane::Concurrent; }
    if method.starts_with("preview.") { return Lane::Concurrent; }
    match method {
        "chat.tool.ask" | "chat.tool.sessionInfo" | "chat.tool.feedback" | "chat.feedback.read"
        | "chat.image.read" => Lane::Concurrent,
        // The run reads never wait for the user; `run.start`/`run.restart` do, and stay
        // ordered so one approval cannot reorder a stop behind a start.
        "chat.tool.run.list" | "chat.tool.run.status" | "chat.tool.run.logs" => Lane::Concurrent,
        "group.prerequisites"
        | "terminal.read"
        | "project.catalog.list"
        | "quickLaunch.detect"
        | "quickLaunch.port.read"
        | "quickLaunch.repo.list"
        | "quickLaunch.recent" | "quickLaunch.proposals.list"
        | "session.launch.read"
        | "git.status"
        | "git.diff"
        | "git.fingerprints"
        | "git.history.plan"
        | "git.log"
        | "git.push.preview"
        | "git.stash.list"
        | "git.stash.show"
        | "git.undo.list"
        | "git.branches"
        | "git.commit.show"
        | "git.commit.diff"
        | "git.blame"
        | "git.compare.files"
        | "git.compare.diff"
        | "filesystem.list"
        | "filesystem.read"
        | "filesystem.external.read"
        | "filesystem.external.image"
        | "filesystem.external.list"
        | "filesystem.files"
        | "filesystem.search"
        | "review.list"
        | "review.changes"
        | "review.diff"
        | "codeReview.options"
        | "worktree.branches"
        | "usage.query"
        | "history.list"
        | "history.read"
        | "draft.list" => Lane::Concurrent,
        "terminal.input" | "terminal.resize" | "session.claim" | "session.renew"
        | "session.release" => Lane::Terminal,
        _ => Lane::Ordered,
    }
}

#[cfg(windows)]
/// Concurrent reads in flight per connection; the reader stops taking frames while all are busy.
const MAX_CONCURRENT_READS: usize = 16;
#[cfg(windows)]
/// Queued requests per sequenced lane before the reader waits (the old loop read nothing while busy).
const LANE_QUEUE: usize = 64;

#[cfg(windows)]
struct Reply {
    body: Result<Value>,
    sequenced: bool,
    accepted_shutdown: bool,
    served_snapshot: bool,
}

#[cfg(windows)]
struct QueuedRequest {
    request: RpcRequest,
    queued: Option<SendTraceTimer>,
}

#[cfg(windows)]
struct ActiveLaneRequest {
    request_id: String,
    method: &'static str,
}

#[cfg(windows)]
struct LaneSender {
    sender: tokio::sync::mpsc::Sender<QueuedRequest>,
    active: Option<Arc<Mutex<Option<ActiveLaneRequest>>>>,
    traced: bool,
}

#[cfg(windows)]
impl LaneSender {
    async fn send(
        &self,
        request: RpcRequest,
    ) -> Result<(), tokio::sync::mpsc::error::SendError<QueuedRequest>> {
        let queued = self.traced.then(SendTraceTimer::start);
        if self.traced {
            let mut event = request_trace_event("transport.ordered.enqueue", &request);
            if let Some(active) = self.active.as_ref()
                .and_then(|state| state.lock().ok())
                .and_then(|state| state.as_ref().map(|active| (active.request_id.clone(), active.method)))
            {
                event = event.active_request_id(&active.0).active_method(active.1);
                send_trace::emit(event);
            } else {
                send_trace::emit(event);
            }
        }
        self.sender.send(QueuedRequest { request, queued }).await
    }
}

// Pure classifier: the send-trace plumbing that consumes it is Windows-only, but
// the test must compile everywhere (Linux `cargo test` failed with E0425).
#[cfg(any(windows, test))]
fn trace_method(method: &str) -> &'static str {
    const KNOWN: &[&str] = &[
        "agentReview.list", "agentReview.mark", "agentReview.start",
        "codeReview.cancel", "codeReview.options", "codeReview.start",
        "catalog.visibility.list", "catalog.visibility.update",
        "chat.answer", "chat.approve", "chat.backgroundTask.stop", "chat.backgroundTasks.list", "chat.cancel", "chat.connect",
        "chat.connection", "chat.context.read", "chat.draft.read", "chat.draft.save", "chat.option.set",
        "chat.options", "chat.queue.add", "chat.queue.move", "chat.queue.pause",
        "chat.queue.read", "chat.queue.remove", "chat.queue.resume", "chat.queue.send",
        "chat.image.read", "chat.queue.update", "chat.read", "chat.repair", "chat.send",
        "chat.snapshot", "chat.subagent.read", "data.backup", "data.relocation.cancel",
        "data.relocation.prepare", "data.relocation.status", "data.status", "device.disable",
        "device.enable", "device.list", "device.pairing.cancel", "device.pairing.create",
        "device.rename", "device.renew", "device.revoke", "draft.delete", "draft.put",
        "filesystem.create", "filesystem.delete", "filesystem.image", "filesystem.rename",
        "filesystem.resolve", "filesystem.write", "git.branch.delete", "git.checkout",
        "git.commit", "git.commit.selected", "git.discard", "git.fetch", "git.index.write",
        "git.merge", "git.merge.abort", "git.cherryPick", "git.revert", "git.reset", "git.operation.abort", "git.operation.continue", "git.pull", "git.push", "git.stage", "git.stash.apply",
        "git.stash.drop", "git.stash.push", "git.unstage",
        "history.import", "inbox.read", "plugin.list", "plugin.reload",
        "plugin.selectBrowserBinding", "plugin.setEnabled", "project.add", "project.remove",
        "project.update", "provider.list",
        "provider.refresh",
        "quickLaunch.delete", "quickLaunch.detect", "quickLaunch.list", "quickLaunch.restart", "quickLaunch.run", "quickLaunch.save",
        "quickLaunch.repo.delete", "quickLaunch.repo.list", "quickLaunch.repo.save", "quickLaunch.repo.trust",
        "quickLaunch.setup.read", "quickLaunch.setup.run", "quickLaunch.setup.save",
        "quickLaunch.setup.status", "quickLaunch.port.read", "quickLaunch.sequence.cancel", "quickLaunch.recent", "quickLaunch.proposals.list", "quickLaunch.proposals.accept", "quickLaunch.proposals.reject", "chat.tool.run.propose", "review.checkpoint", "review.revert", "runtime.health",
        "runtime.shutdown", "runtime.snapshot", "session.attention.acknowledge",
        "session.config.read", "session.config.save", "session.create", "session.documents.list",
        "session.documents.pin", "session.documents.unpin", "session.lookup", "session.organize",
        "session.present", "session.rerun", "session.resume", "session.retry.read",
        "session.retry.update", "session.stop", "session.update", "settings.export",
        "settings.import.apply", "settings.import.preview", "settings.update", "terminal.host",
        "workspace.delete", "workspace.save", "worktree.create", "worktree.list",
        "worktree.relocate", "worktree.remove",
    ];
    KNOWN.iter().copied().find(|known| *known == method).unwrap_or("other")
}

#[cfg(windows)]
fn request_trace_event<'a>(stage: &'static str, request: &'a RpcRequest) -> SendTraceEvent<'a> {
    let mut event = SendTraceEvent::new(stage)
        .request_id(&request.id)
        .method(trace_method(&request.method));
    if let Some(operation_id) = request.params.get("operationId").and_then(Value::as_str) {
        event = event.operation_id(operation_id);
    }
    if let Some(session_id) = request.params.get("sessionId").and_then(Value::as_str) {
        event = event.session_id(session_id);
    }
    event
}

#[cfg(windows)]
async fn run_request(
    service: Arc<RuntimeService>,
    principal: String,
    request: RpcRequest,
    sequenced: bool,
) -> Reply {
    let id = request.id.clone();
    let is_shutdown = request.method == "runtime.shutdown";
    let is_snapshot = request.method == "runtime.snapshot";
    let is_chat_send = request.method == "chat.send";
    let trace_context = is_chat_send
        .then(|| SendTraceContext::capture(
            Some(&request.id),
            request.params.get("operationId").and_then(Value::as_str),
            request.params.get("sessionId").and_then(Value::as_str),
        ))
        .flatten();
    let trace_timer = is_chat_send.then(SendTraceTimer::start);
    let result = if request.method == "browser.tool.call" {
        match crate::peer::guard(&service, &principal, &request.method) {
            Ok(()) => service.browser_tool_call(&principal, request).await,
            Err(error) => Err(error),
        }
    } else { tokio::task::spawn_blocking(move || {
        let _trace_context = trace_context.map(SendTraceContext::enter);
        if is_chat_send {
            send_trace::emit(SendTraceEvent::new("transport.dispatch.begin").method("chat.send"));
        }
        crate::peer::guard(&service, &principal, &request.method)?;
        let result = service.dispatch(&principal, request);
        if is_chat_send {
            send_trace::emit(SendTraceEvent::new("transport.dispatch.end")
                .method("chat.send")
                .outcome(if result.is_ok() { "ok" } else { "error" })
                .duration_us(trace_timer.as_ref().and_then(SendTraceTimer::elapsed_us)));
        }
        result
    })
        .await
        .unwrap_or_else(|_| {
            Err(crate::domain::RpcError {
                code: "runtime_error".into(),
                message: "runtime command worker failed".into(),
                details: None,
            })
        }) };
    let accepted_shutdown = is_shutdown && result.is_ok();
    let served_snapshot = is_snapshot && result.is_ok();
    let response = match result {
        Ok(result) => RpcResponse::Ok {
            v: PROTOCOL_VERSION,
            id,
            result,
        },
        Err(error) => RpcResponse::Err {
            v: PROTOCOL_VERSION,
            id,
            error,
        },
    };
    Reply {
        body: serde_json::to_value(response).map_err(Into::into),
        sequenced,
        accepted_shutdown,
        served_snapshot,
    }
}

#[cfg(windows)]
/// One sequential worker per sequenced lane; its replies go to the connection's single writer.
fn lane_worker(
    service: Arc<RuntimeService>,
    principal: String,
    replies: tokio::sync::mpsc::UnboundedSender<Reply>,
    traced: bool,
) -> LaneSender {
    let (sender, mut requests) = tokio::sync::mpsc::channel::<QueuedRequest>(LANE_QUEUE);
    let active = (traced && send_trace::enabled())
        .then(|| Arc::new(Mutex::new(None::<ActiveLaneRequest>)));
    let worker_active = active.clone();
    tokio::spawn(async move {
        while let Some(queued) = requests.recv().await {
            if let Some(state) = &worker_active {
                if let Ok(mut active) = state.lock() {
                    *active = send_trace::safe_correlation_id(&queued.request.id).map(|request_id| {
                        ActiveLaneRequest {
                            request_id: request_id.to_owned(),
                            method: trace_method(&queued.request.method),
                        }
                    });
                }
            }
            if traced {
                send_trace::emit(request_trace_event("transport.ordered.dequeue", &queued.request)
                    .queue_wait_us(queued.queued.as_ref().and_then(SendTraceTimer::elapsed_us)));
            }
            let request = queued.request;
            let reply = run_request(Arc::clone(&service), principal.clone(), request, true).await;
            if let Some(state) = &worker_active {
                if let Ok(mut active) = state.lock() {
                    *active = None;
                }
            }
            if replies.send(reply).is_err() {
                break;
            }
        }
    });
    LaneSender { sender, active, traced }
}

fn parse_event_filter(params: &Value) -> std::result::Result<(), crate::domain::RpcError> {
    if params.as_object().is_some_and(|p| p.len() == 1 && p.get("preset") == Some(&json!("tree"))) { return Ok(()); }
    Err(crate::domain::RpcError { code:"invalid_request".into(), message:"Unknown event filter preset".into(), details:None })
}

fn tree_event(event: &str, data: &Value) -> bool {
    match event {
        "session.status" | "session.activity" | "inbox.created" | "inbox.resolved" | "presentation.requested" | "runtime.degraded" => true,
        "state.changed" => matches!(data.get("kind").and_then(Value::as_str),
            None | Some("project" | "project.catalog" | "catalog.visibility" | "session" | "session.title"
            | "session.activity" | "session.organization" | "session.launch" | "session.native_bound"
            | "session.native_replaced" | "session.resume" | "history.import" | "history.import.restore"
            | "chat.fork" | "chat.turn.started" | "chat.turn.completed" | "chat.approval"
            | "chat.approval.resolved" | "chat.error" | "inbox" | "git" | "settings")),
        _ => false,
    }
}

#[cfg(windows)]
pub(crate) async fn serve_control<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    pipe: T,
    service: Arc<RuntimeService>,
    principal: String,
) -> Result<()> {
    // Leases follow the principal's control connections; this one counts until serve_control returns.
    let _presence = service.leases.connect(&principal);
    let _preview_presence = service.previews.connect(&principal);
    let _browser_presence = service.browser_tools.connect_control(&principal)?;
    let mut turn_speeds = service.subscribe_turn_speed();
    let mut turn_speeds_open = true;
    let mut sent_seq = service.db.snapshot()?.revision;
    let mut tree_filter = false;
    let (mut reader, mut writer) = tokio::io::split(pipe);
    let mut decoder = FrameDecoder::default();
    let (replies, mut completed) = tokio::sync::mpsc::unbounded_channel::<Reply>();
    let ordered = lane_worker(Arc::clone(&service), principal.clone(), replies.clone(), true);
    let terminal = lane_worker(Arc::clone(&service), principal.clone(), replies.clone(), false);
    let reads = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_READS));
    // Sequenced requests without a reply yet. Events wait for them, as in the old one-at-a-time
    // loop, so a mutation's reply is still written before the events it caused.
    let mut sequenced_in_flight = 0usize;
    loop {
        tokio::select! {
            frame = decoder.read(&mut reader) => {
                let request: RpcRequest = serde_json::from_slice(&frame?)?;
                if request.method == "runtime.events.filter" {
                    let result = crate::peer::guard(&service, &principal, &request.method)
                        .and_then(|()| parse_event_filter(&request.params));
                    let response = match result {
                        Ok(()) => {
                            tree_filter = true;
                            json!({"v":PROTOCOL_VERSION,"id":request.id,"result":{"preset":"tree","tree":service.db.tree_projection("state.changed", &json!({}))?}})
                        }
                        Err(error) => json!({"v":PROTOCOL_VERSION,"id":request.id,"error":error}),
                    };
                    write_json(&mut writer, &response).await?;
                    continue;
                }
                match request_lane(&request.method) {
                    Lane::Ordered => {
                        sequenced_in_flight += 1;
                        ordered.send(request).await.context("ordered lane stopped")?;
                    }
                    Lane::Terminal => {
                        sequenced_in_flight += 1;
                        terminal.send(request).await.context("terminal lane stopped")?;
                    }
                    Lane::Concurrent => {
                        let permit = Arc::clone(&reads).acquire_owned().await.context("read pool closed")?;
                        let service = Arc::clone(&service);
                        let principal = principal.clone();
                        let replies = replies.clone();
                        tokio::spawn(async move {
                            let reply = run_request(service, principal, request, false).await;
                            drop(permit);
                            let _ = replies.send(reply);
                        });
                    }
                }
            }
            Some(reply) = completed.recv() => {
                if reply.sequenced {
                    sequenced_in_flight = sequenced_in_flight.saturating_sub(1);
                }
                let delivery = write_response(&mut writer, reply.body).await;
                if reply.accepted_shutdown {
                    // Do not tear down Tokio while the response is still in the
                    // pipe. New clients acknowledge receipt; older clients get
                    // a bounded drain window before the requested shutdown.
                    if delivery.is_ok() { let _ = tokio::time::timeout(std::time::Duration::from_secs(2), decoder.read(&mut reader)).await; }
                    service.acknowledge_shutdown();
                    delivery?;
                    return Ok(());
                }
                delivery?;
                if reply.served_snapshot { service.db.start_retention(); }
            }
            received = turn_speeds.recv(), if !tree_filter && turn_speeds_open && sequenced_in_flight == 0 => {
                let epoch = service.db.epoch()?;
                if received.is_ok() { guard_stream(&service, &principal, "runtime.event")?; }
                turn_speeds_open = forward_turn_speed(&mut writer, &epoch, received).await?;
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {}
        }
        if sequenced_in_flight == 0 {
            let epoch = service.db.epoch()?;
            let previous_seq = sent_seq;
            for (seq, event, mut data) in service.db.events_after(sent_seq)? {
                sent_seq = seq;
                if tree_filter && !tree_event(&event, &data) { continue; }
                if tree_filter && event != "runtime.degraded" {
                    data["tree"] = service.db.tree_projection(&event, &data)?;
                }
                let frame = json!({"v":PROTOCOL_VERSION,"event":event,"epoch":epoch,"seq":seq,"data":data});
                // Durable state that cannot fit a frame stays in the database; the
                // connection reports a projection gap instead of dying, and the view
                // resynchronizes through the bounded snapshot pages.
                let bytes = serde_json::to_vec(&frame)?;
                guard_stream(&service, &principal, "runtime.event")?;
                if bytes.len() > MAX_RESPONSE_BYTES {
                    write_json(
                        &mut writer,
                        &json!({"v":PROTOCOL_VERSION,"event":"runtime.degraded","epoch":epoch,"seq":seq,"data":{"reason":"chat_event_too_large"}}),
                    )
                    .await?;
                } else {
                    write_binary(&mut writer, &bytes).await?;
                }
            }
            if tree_filter && sent_seq != previous_seq {
                write_json(&mut writer, &json!({"v":PROTOCOL_VERSION,"event":"runtime.cursor","epoch":epoch,"seq":sent_seq,"data":{}})).await?;
            }
        }
        if service.shutdown_requested() {
            return Ok(());
        }
    }
}
/// Ephemeral speed events have no durable sequence and never enter the outbox.
/// Lag loses samples only; a closed source disables its select branch so the
/// connection keeps serving requests and durable events without a busy loop.
#[cfg(windows)]
async fn forward_turn_speed<T: tokio::io::AsyncWrite + Unpin>(
    writer: &mut T,
    epoch: &str,
    received: std::result::Result<Value, tokio::sync::broadcast::error::RecvError>,
) -> Result<bool> {
    use tokio::sync::broadcast::error::RecvError;
    match received {
        Ok(data) => {
            write_json(writer, &json!({"v":PROTOCOL_VERSION,"event":"chat.turnSpeed","epoch":epoch,"seq":0,"data":data})).await?;
            Ok(true)
        }
        Err(RecvError::Lagged(_)) => Ok(true),
        Err(RecvError::Closed) => Ok(false),
    }
}

#[cfg(windows)]
pub(crate) async fn serve_output<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    mut pipe: T,
    service: Arc<RuntimeService>,
    principal: String,
) -> Result<()> {
    let mut decoder = FrameDecoder::default();
    let mut subscriptions: std::collections::HashMap<String, (i64, i64)> =
        std::collections::HashMap::new();
    loop {
        let input = tokio::select! { frame=decoder.read(&mut pipe)=>Some(frame?), _=service.output_notified()=>None, _=tokio::time::sleep(std::time::Duration::from_millis(250))=>None };
        if let Some(input) = input {
            if input.is_empty() {
                bail!("empty output frame")
            };
            let kind = input[0];
            let (header, _body) = split_binary(&input[1..])?;
            match kind {
                3 => {
                    guard_stream(&service, &principal, "terminal.output")?;
                    let session_id = header
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .context("subscribe sessionId")?
                        .to_owned();
                    let cursor = header.get("cursor").and_then(Value::as_i64).unwrap_or(0);
                    if !subscriptions.contains_key(&session_id) && subscriptions.len() >= 64 {
                        bail!("subscription limit reached")
                    }
                    subscriptions.insert(session_id, (cursor, 0));
                }
                2 => {
                    guard_stream(&service, &principal, "terminal.output")?;
                    let credit = header
                        .get("credit")
                        .and_then(Value::as_i64)
                        .context("credit")?;
                    if credit < 0 {
                        bail!("negative credit")
                    };
                    let session_id = header
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .context("credit sessionId")?;
                    if let Some((_cursor, available)) = subscriptions.get_mut(session_id) {
                        *available = available.saturating_add(credit).min((MAX_FRAME * 4) as i64);
                    } else {
                        bail!("credit for unknown subscription")
                    }
                }
                5 => {
                    let id = header
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .context("unsubscribe sessionId")?;
                    subscriptions.remove(id);
                }
                _ => bail!("unsupported output frame"),
            };
        }
        for (id, (cursor, credit)) in &mut subscriptions {
            while *credit > 0 {
                let chunks =
                    match service
                        .db
                        .output_from(id, *cursor, (*credit as usize).min(MAX_FRAME))
                    {
                        Ok(chunks) => chunks,
                        Err(error) if is_terminal_history_gap(&error) => {
                            // A pruned prefix resumes at retained bytes; an internal
                            // hole keeps the existing durable-end resync. Neither
                            // consumes credit or drops the multiplexed pipe.
                            let next = output_gap_cursor(&service.db, id, *cursor)?;
                            guard_stream(&service, &principal, "terminal.output")?;
                            write_output(&mut pipe, 4, &json!({"sessionId":id,"cursor":next}), &[])
                                .await?;
                            advance_cursor_past_history_gap(cursor, next);
                            continue;
                        }
                        Err(error) => return Err(error),
                    };
                if chunks.is_empty() {
                    break;
                }
                for (start, data) in chunks {
                    let offset = (*cursor - start).max(0) as usize;
                    let bytes = &data[offset..];
                    let take = bytes.len().min(*credit as usize);
                    guard_stream(&service, &principal, "terminal.output")?;
                    write_output(
                        &mut pipe,
                        1,
                        &json!({"sessionId":id,"cursor":*cursor}),
                        &bytes[..take],
                    )
                    .await?;
                    *cursor += take as i64;
                    *credit -= take as i64;
                    if take < bytes.len() {
                        break;
                    }
                }
            }
        }
    }
}

/// Decoder state belongs to the connection, not the selected future. A timer
/// can cancel `read` after any partial length/body without losing consumed bytes.
#[derive(Default)]
struct FrameDecoder {
    pending: Vec<u8>,
}
impl FrameDecoder {
    async fn read<T: tokio::io::AsyncRead + Unpin>(&mut self, stream: &mut T) -> Result<Vec<u8>> {
        use tokio::io::AsyncReadExt;
        loop {
            if self.pending.len() >= 4 {
                let length = u32::from_le_bytes(self.pending[..4].try_into()?) as usize;
                if length > MAX_FRAME {
                    bail!("frame exceeds 8 MiB");
                }
                if self.pending.len() >= length + 4 {
                    let remainder = self.pending.split_off(length + 4);
                    let frame = self.pending[4..].to_vec();
                    self.pending = remainder;
                    return Ok(frame);
                }
            }
            let mut chunk = [0u8; 8192];
            let count = stream.read(&mut chunk).await?;
            if count == 0 {
                bail!("pipe closed mid-frame");
            }
            self.pending.extend_from_slice(&chunk[..count]);
        }
    }
}

#[cfg(windows)]
async fn authenticate<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    stream: &mut T,
    credential: &str,
    runtime_epoch: &str,
) -> Result<String> {
    use tokio::time::{timeout, Duration};
    let mut nonce = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut nonce);
    let nonce = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(nonce);
    write_json(
        stream,
        &json!({"kind":"challenge","nonce":nonce,"protocol":PROTOCOL_VERSION,"contract":PROTOCOL_CONTRACT}),
    )
    .await?;
    let reply = timeout(Duration::from_secs(10), read_json(stream))
        .await
        .context("authentication timeout")??;
    if reply.get("kind").and_then(Value::as_str) != Some("auth") {
        bail!("authentication required")
    };
    let client_id = reply
        .get("clientId")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 256)
        .context("clientId")?;
    if reply.get("protocol").and_then(Value::as_u64) != Some(PROTOCOL_VERSION as u64)
        || reply.get("nonce").and_then(Value::as_str) != Some(&nonce)
    {
        bail!("authentication protocol mismatch")
    };
    if let Err(error) = protocol_contract::require_peer_contract(&reply, ContractRole::Runtime) {
        let _ = write_json(
            stream,
            &json!({
                "kind":"incompatible",
                "code":"protocol_incompatible",
                "message":error.to_string(),
                "protocol":PROTOCOL_VERSION,
                "contract":PROTOCOL_CONTRACT
            }),
        )
        .await;
        return Err(error);
    }
    let proof = hex::decode(reply.get("hmac").and_then(Value::as_str).context("hmac")?)?;
    let mut mac = HmacSha256::new_from_slice(credential.as_bytes())?;
    mac.update(format!("{}:{}:{}", PROTOCOL_VERSION, client_id, nonce).as_bytes());
    mac.verify_slice(&proof)
        .map_err(|_| anyhow::anyhow!("authentication failed"))?;
    let mut server_mac = HmacSha256::new_from_slice(credential.as_bytes())?;
    server_mac.update(format!("server:{}:{}:{}", PROTOCOL_VERSION, client_id, nonce).as_bytes());
    write_json(stream,&json!({"kind":"authenticated","principal":client_id,"epoch":runtime_epoch,"contract":PROTOCOL_CONTRACT,"hmac":hex::encode(server_mac.finalize().into_bytes())})).await?;
    Ok(client_id.to_owned())
}

#[cfg(windows)]
pub(crate) async fn read_json<T: tokio::io::AsyncRead + Unpin>(stream: &mut T) -> Result<Value> {
    let bytes = read_binary(stream).await?;
    Ok(serde_json::from_slice(&bytes)?)
}
#[cfg(windows)]
pub(crate) async fn write_json<T: tokio::io::AsyncWrite + Unpin>(stream: &mut T, value: &Value) -> Result<()> {
    write_binary(stream, &serde_json::to_vec(value)?).await
}
/// One oversized answer becomes a typed error for its own request id; the
/// connection and its event stream stay open.
#[cfg(windows)]
async fn write_response<T: tokio::io::AsyncWrite + Unpin>(
    stream: &mut T,
    body: Result<Value>,
) -> Result<()> {
    let value = body?;
    let bytes = serde_json::to_vec(&value)?;
    if bytes.len() <= MAX_RESPONSE_BYTES {
        return write_binary(stream, &bytes).await;
    }
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    write_binary(stream, &serde_json::to_vec(&response_too_large(&id))?).await
}
#[cfg(windows)]
fn response_too_large(id: &str) -> Value {
    json!(RpcResponse::Err {
        v: PROTOCOL_VERSION,
        id: id.to_owned(),
        error: crate::domain::RpcError {
            code: "response_too_large".into(),
            // Electron's IPC drops the typed code, so the message repeats it.
            message: format!("response_too_large: response exceeds {MAX_RESPONSE_BYTES} bytes"),
            details: Some(json!({"limitBytes": MAX_RESPONSE_BYTES})),
        },
    })
}
#[cfg(windows)]
async fn read_binary<T: tokio::io::AsyncRead + Unpin>(stream: &mut T) -> Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let len = stream.read_u32_le().await? as usize;
    if len > MAX_FRAME {
        bail!("frame exceeds 8 MiB")
    };
    let mut bytes = vec![0; len];
    stream.read_exact(&mut bytes).await?;
    Ok(bytes)
}
#[cfg(windows)]
async fn write_binary<T: tokio::io::AsyncWrite + Unpin>(
    stream: &mut T,
    bytes: &[u8],
) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    if bytes.len() > MAX_FRAME {
        bail!("frame exceeds 8 MiB")
    };
    stream.write_u32_le(bytes.len() as u32).await?;
    stream.write_all(bytes).await?;
    stream.flush().await?;
    Ok(())
}
#[cfg(windows)]
fn split_binary(input: &[u8]) -> Result<(Value, &[u8])> {
    if input.len() < 4 {
        bail!("short binary header")
    };
    let length = u32::from_le_bytes(input[..4].try_into().unwrap()) as usize;
    if length > input.len() - 4 {
        bail!("binary header overflow")
    };
    Ok((
        serde_json::from_slice(&input[4..4 + length])?,
        &input[4 + length..],
    ))
}
#[cfg(windows)]
async fn write_output<T: tokio::io::AsyncWrite + Unpin>(
    stream: &mut T,
    kind: u8,
    header: &Value,
    body: &[u8],
) -> Result<()> {
    let header = serde_json::to_vec(header)?;
    let mut bytes = Vec::with_capacity(1 + 4 + header.len() + body.len());
    bytes.push(kind);
    bytes.extend_from_slice(&(header.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&header);
    bytes.extend_from_slice(body);
    write_binary(stream, &bytes).await
}

#[cfg(test)]
mod decoder_tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    /// An answer over the response ceiling fails for its own request id only;
    /// the same connection keeps serving. Before this guard the oversized write
    /// errored and `serve_control` dropped the whole control connection.
    #[cfg(windows)]
    #[tokio::test]
    async fn an_oversized_answer_fails_alone_and_the_connection_keeps_serving() {
        let (mut server, mut client) = tokio::io::duplex(32 * 1024 * 1024);
        let big = json!({"v":PROTOCOL_VERSION,"id":"big","result":{"items":[{"text":"x".repeat(MAX_FRAME + 1)}]}});
        // This is the exact write that used to fail and take the connection down.
        assert!(write_json(&mut server, &big).await.is_err(), "an over-MAX_FRAME answer cannot be written raw");
        write_response(&mut server, Ok(big)).await.unwrap();
        let first = read_json(&mut client).await.unwrap();
        assert_eq!(first["id"], "big");
        assert_eq!(first["error"]["code"], "response_too_large");
        assert_eq!(first["error"]["details"]["limitBytes"], MAX_RESPONSE_BYTES);
        // The code survives a transport that carries only the message (Electron IPC).
        assert!(first["error"]["message"].as_str().unwrap().starts_with("response_too_large: "));
        assert!(first.get("result").is_none());
        let small = json!({"v":PROTOCOL_VERSION,"id":"small","result":{"items":[]}});
        write_response(&mut server, Ok(small.clone())).await.unwrap();
        assert_eq!(read_json(&mut client).await.unwrap(), small, "the connection still answers the next request");
        // An answer that fits is written unchanged, including a large one.
        let fits = json!({"v":PROTOCOL_VERSION,"id":"fits","result":{"text":"y".repeat(MAX_RESPONSE_BYTES - 1024)}});
        write_response(&mut server, Ok(fits.clone())).await.unwrap();
        assert_eq!(read_json(&mut client).await.unwrap(), fits);
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn turn_speed_forwarding_uses_current_epoch_and_an_ephemeral_sequence() {
        let (mut writer, mut reader) = tokio::io::duplex(4096);
        let (sender, mut receiver) = tokio::sync::broadcast::channel(4);
        for data in [
            json!({"sessionId":"s","turnId":"t","active":true,"usage":{"outputTokens":52,"generationMs":1000,"outputTokensEstimated":false}}),
            json!({"sessionId":"s","turnId":"t","active":false}),
        ] {
            sender.send(data.clone()).unwrap();
            assert!(forward_turn_speed(&mut writer, "current-epoch", receiver.recv().await).await.unwrap());
            let event = read_json(&mut reader).await.unwrap();
            assert_eq!(event, json!({"v":PROTOCOL_VERSION,"event":"chat.turnSpeed","epoch":"current-epoch","seq":0,"data":data}));
        }
        // A new control connection observes only future broadcasts, never the
        // prior connection's speed history or a durable outbox replay.
        let mut reconnected = sender.subscribe();
        assert!(matches!(reconnected.try_recv(), Err(tokio::sync::broadcast::error::TryRecvError::Empty)));
        sender.send(json!({"sessionId":"s","turnId":"next","active":true})).unwrap();
        assert!(forward_turn_speed(&mut writer, "next-epoch", reconnected.recv().await).await.unwrap());
        assert_eq!(read_json(&mut reader).await.unwrap()["epoch"], "next-epoch");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn turn_speed_lag_and_close_do_not_interrupt_the_control_writer() {
        use tokio::sync::broadcast::error::RecvError;
        let (mut writer, mut reader) = tokio::io::duplex(4096);
        assert!(forward_turn_speed(&mut writer, "epoch", Err(RecvError::Lagged(3))).await.unwrap());
        assert!(!forward_turn_speed(&mut writer, "epoch", Err(RecvError::Closed)).await.unwrap());
        // Neither condition creates a frame. The same writer remains usable
        // for ordinary durable events at their original sequence.
        let durable = json!({"v":PROTOCOL_VERSION,"event":"chat.item","epoch":"epoch","seq":42,"data":{"sessionId":"s"}});
        write_json(&mut writer, &durable).await.unwrap();
        assert_eq!(read_json(&mut reader).await.unwrap(), durable);
    }

    #[test]
    fn tree_filter_accepts_only_the_named_preset() {
        assert!(parse_event_filter(&json!({"preset":"tree"})).is_ok());
        for params in [json!({"preset":"other"}), json!({"preset":"tree","events":["chat.item"]}), json!({"events":[]})] {
            assert!(parse_event_filter(&params).is_err());
        }
        assert!(!tree_event("chat.item", &json!({})));
        assert!(!tree_event("chat.turnSpeed", &json!({})));
        assert!(!tree_event("state.changed", &json!({"kind":"chat.delta"})));
        assert!(tree_event("state.changed", &json!({"kind":"chat.approval.resolved"})));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn tree_filter_delivers_status_and_inbox_but_no_chat_stream_and_default_is_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let config = crate::config::RuntimeConfig {
            data_dir:root.path().into(), database_path:root.path().join("runtime.sqlite"),
            credential_path:root.path().join("credential"), pipe_base:"tree-filter-test".into(),
        };
        let db = Arc::new(crate::db::Database::open(&config.database_path).unwrap());
        crate::workspace_services::initialize(&db).unwrap();
        crate::project_catalog::initialize(&db).unwrap();
        crate::settings_services::initialize(&db).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        crate::retry_scheduler::initialize(&db).unwrap();
        let service = Arc::new(RuntimeService::with_test_providers(config, Arc::clone(&db), vec![]));
        let (server, mut filtered) = tokio::io::duplex(1024 * 1024);
        let a = tokio::spawn(serve_control(server, Arc::clone(&service), "filtered".into()));
        write_json(&mut filtered, &json!({"v":1,"id":"unknown","method":"runtime.events.filter","params":{"preset":"unknown"}})).await.unwrap();
        assert_eq!(read_json(&mut filtered).await.unwrap()["error"]["code"], "invalid_request");
        write_json(&mut filtered, &json!({"v":1,"id":"filter","method":"runtime.events.filter","params":{"preset":"tree"}})).await.unwrap();
        assert_eq!(read_json(&mut filtered).await.unwrap()["result"]["preset"], "tree");
        let (server, mut local) = tokio::io::duplex(1024 * 1024);
        let b = tokio::spawn(serve_control(server, Arc::clone(&service), "local".into()));
        write_json(&mut local, &json!({"v":1,"id":"health","method":"runtime.health","params":{}})).await.unwrap();
        assert_eq!(read_json(&mut local).await.unwrap()["id"], "health");
        let session = db.create_session(crate::db::CreateSession {project_id:None,title:Some("Tree"),provider:"codex",mode:"chat",native_id:None,operation_id:"tree-session"}).unwrap();
        db.set_session_status(&session.id, "running", None).unwrap();
        for (kind, data) in [
            ("chat.turn.started", json!({})),
            ("chat.delta", json!({"item":{"id":"answer"},"part":{"type":"text","text":"secret stream"}})),
            ("chat.approval", json!({"approvalId":"approval","part":{"type":"approval","approvalId":"approval","status":"pending","data":{}}})),
        ] { db.record_provider_event(&session.id, Some("turn"), kind, &data).unwrap(); }
        let mut status = false; let mut inbox = false;
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let frame = read_json(&mut filtered).await.unwrap();
                assert_ne!(frame["event"], "chat.item");
                assert_ne!(frame["event"], "chat.turnSpeed");
                if frame["event"] == "session.status" && frame["data"]["status"] == "running" { status = true; }
                if frame["event"] == "inbox.created" { inbox = true; }
                if status && inbox && frame["event"] == "runtime.cursor" { break; }
            }
        }).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop { if read_json(&mut local).await.unwrap()["event"] == "chat.item" { break; } }
        }).await.unwrap();
        db.record_provider_event(&session.id, Some("turn"), "chat.approval.resolved", &json!({"approvalId":"approval","status":"resolved","preserveSessionState":true})).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let frame = read_json(&mut filtered).await.unwrap();
                assert_ne!(frame["event"], "chat.item");
                if frame["event"] == "inbox.resolved" {
                    assert!(frame["data"]["tree"]["inbox"].as_array().unwrap().is_empty(), "the tree inbox carries unread items only");
                    break;
                }
            }
        }).await.unwrap();
        a.abort(); b.abort(); service.shutdown();
    }

    #[tokio::test]
    async fn fragmented_frame_survives_repeated_future_cancellation() {
        let (mut writer, mut reader) = tokio::io::duplex(128);
        let body = br#"{"method":"runtime.health"}"#;
        let mut frame = (body.len() as u32).to_le_bytes().to_vec();
        frame.extend_from_slice(body);
        let mut decoder = FrameDecoder::default();
        writer.write_all(&frame[..2]).await.unwrap();
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(10),
            decoder.read(&mut reader)
        )
        .await
        .is_err());
        writer.write_all(&frame[2..8]).await.unwrap();
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(10),
            decoder.read(&mut reader)
        )
        .await
        .is_err());
        writer.write_all(&frame[8..]).await.unwrap();
        assert_eq!(decoder.read(&mut reader).await.unwrap(), body);
        writer.write_all(&frame).await.unwrap();
        assert_eq!(decoder.read(&mut reader).await.unwrap(), body);
    }

    #[test]
    fn trimmed_running_subscription_gaps_to_retained_start_and_keeps_credit() {
        let root = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(&root.path().join("trimmed.sqlite")).unwrap();
        let id = db
            .create_session(crate::db::CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "trimmed",
            })
            .unwrap()
            .id;
        db.set_session_status(&id, "running", None).unwrap();
        db.append_output(&id, 0, b"abcdefghij").unwrap();
        crate::retention::compact_active_for_test(&db, &id, 5, 1).unwrap();
        let mut cursor = 0;
        let credit = 100;
        assert!(is_terminal_history_gap(
            &db.output_from(&id, cursor, credit).unwrap_err()
        ));
        let gap = output_gap_cursor(&db, &id, cursor).unwrap();
        assert_eq!(gap, 5);
        advance_cursor_past_history_gap(&mut cursor, gap);
        assert_eq!(credit, 100);
        assert_eq!(
            db.output_from(&id, cursor, credit).unwrap(),
            vec![(5, b"fghij".to_vec())]
        );
        db.append_output(&id, 10, b"tail").unwrap();
        assert_eq!(
            db.output_from(&id, 10, credit).unwrap(),
            vec![(10, b"tail".to_vec())]
        );
    }

    #[test]
    fn history_gap_is_the_only_database_error_recovered_per_subscription() {
        assert!(is_terminal_history_gap(&anyhow::anyhow!(
            TERMINAL_HISTORY_GAP
        )));
        assert!(is_terminal_history_gap(
            &anyhow::anyhow!(TERMINAL_HISTORY_GAP).context("output read")
        ));
        assert!(!is_terminal_history_gap(&anyhow::anyhow!(
            "database lock poisoned"
        )));
    }

    #[test]
    fn repo_config_reads_and_mutations_use_their_expected_lanes() {
        assert_eq!(request_lane("quickLaunch.repo.list"), Lane::Concurrent);
        for method in ["quickLaunch.repo.save", "quickLaunch.repo.delete", "quickLaunch.repo.trust"] {
            assert_eq!(request_lane(method), Lane::Ordered, "{method}");
            assert_eq!(trace_method(method), method);
        }
    }

    #[test]
    fn slow_reads_run_concurrently_and_terminal_control_keeps_its_own_order() {
        for read in [
            "terminal.read",
            "chat.tool.ask",
            "chat.tool.sessionInfo",
            "chat.tool.feedback",
            "chat.tool.run.list",
            "chat.tool.run.status",
            "chat.tool.run.logs",
            "chat.feedback.read",
            "project.catalog.list",
            "quickLaunch.detect",
            "quickLaunch.port.read",
            "git.status",
            "git.diff",
            "git.fingerprints",
            "git.history.plan",
            "git.log",
            "git.push.preview",
            "git.stash.list",
            "git.stash.show",
            "git.undo.list",
            "git.blame",
            "git.compare.files",
            "git.compare.diff",
            "review.changes",
            "filesystem.search",
            "filesystem.external.read",
            "filesystem.external.image",
            "filesystem.external.list",
            "usage.query",
        ] {
            assert_eq!(request_lane(read), Lane::Concurrent, "{read}");
        }
        for control in [
            "terminal.input",
            "terminal.resize",
            "session.claim",
            "session.renew",
            "session.release",
        ] {
            assert_eq!(request_lane(control), Lane::Terminal, "{control}");
        }
        // Mutations and anything unlisted stay one at a time in arrival order.
        for method in [
            "git.fetch",
            "filesystem.external.open",
            "filesystem.external.forget",
            "git.push",
            "git.commit",
            "git.commit.selected",
            "git.index.write",
            "git.stash.push",
            "git.stash.apply",
            "git.stash.drop",
            "git.undo",
            "git.cherryPick",
            "git.revert",
            "git.reset",
            "git.operation.abort",
            "git.operation.continue",
            "session.resume",
            "session.stop",
            "chat.tool.run.start",
            "chat.tool.run.stop",
            "chat.tool.run.restart",
            "chat.tool.run.propose",
            "quickLaunch.proposals.accept",
            "quickLaunch.proposals.reject",
            "quickLaunch.restart",
            "quickLaunch.sequence.cancel",
            "worktree.list",
            "workspace.save",
            "filesystem.write",
            "review.checkpoint",
            "review.revert",
            "runtime.shutdown",
            "provider.refresh",
            "not.a.method",
        ] {
            assert_eq!(request_lane(method), Lane::Ordered, "{method}");
        }

        // The agent run tools specifically: a status/log list poll must never wait behind
        // a slow read, and the three that can block on the user stay ordered.
        for read in [
            "chat.tool.run.list",
            "chat.tool.run.status",
            "chat.tool.run.logs",
        ] {
            assert_eq!(request_lane(read), Lane::Concurrent, "{read}");
        }
        for mutation in [
            "chat.tool.run.start",
            "chat.tool.run.stop",
            "chat.tool.run.restart",
            "chat.tool.run.propose",
            "quickLaunch.proposals.accept",
            "quickLaunch.proposals.reject",
        ] {
            assert_eq!(request_lane(mutation), Lane::Ordered, "{mutation}");
        }
    }

    #[test]
    fn send_trace_classifies_only_fixed_public_ordered_methods() {
        for known in [
            "git.fetch",
            "git.stash.push",
            "session.config.save",
            "chat.queue.add",
            "review.revert",
            "agentReview.start",
            "codeReview.start",
            "data.backup",
            "git.stash.apply",
            "git.cherryPick",
        ] {
            assert_eq!(trace_method(known), known, "{known}");
        }
        for private_or_unknown in ["qa.chat.projection.fail", "private.secret", "git.future"] {
            let classified = trace_method(private_or_unknown);
            assert_eq!(classified, "other");
            assert_ne!(classified, private_or_unknown);
        }
    }

    #[test]
    fn history_gap_advances_only_the_subscription_cursor_not_its_live_credit() {
        let mut cursor = 12;
        let credit = 64 * 1024;
        advance_cursor_past_history_gap(&mut cursor, 96);
        assert_eq!(cursor, 96);
        assert_eq!(credit, 64 * 1024, "gap frames do not consume output credit");
    }
}
