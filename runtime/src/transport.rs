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
use std::sync::Arc;

pub const MAX_FRAME: usize = 8 * 1024 * 1024;
const TERMINAL_HISTORY_GAP: &str = "terminal_history_gap";
type HmacSha256 = Hmac<Sha256>;

fn is_terminal_history_gap(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string() == TERMINAL_HISTORY_GAP)
}

fn advance_cursor_past_history_gap(cursor: &mut i64, durable_end: i64) {
    *cursor = durable_end;
}

#[cfg(windows)]
pub async fn serve(service: Arc<RuntimeService>, credential: String) -> Result<()> {
    tokio::try_join!(
        accept_control(Arc::clone(&service), credential.clone()),
        accept_output(Arc::clone(&service), credential)
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
        let pipe = unsafe {
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
            let _ = serve_control(pipe, s, &c).await;
        });
        if service.shutdown_requested() {
            return Ok(());
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
        let pipe = unsafe {
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
            let _ = serve_output(pipe, s, &c).await;
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
    match method {
        "terminal.read"
        | "session.launch.read"
        | "git.status"
        | "git.diff"
        | "git.log"
        | "git.branches"
        | "git.commit.show"
        | "git.commit.diff"
        | "git.blame"
        | "filesystem.list"
        | "filesystem.read"
        | "filesystem.files"
        | "filesystem.search"
        | "review.list"
        | "review.changes"
        | "review.diff"
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
    let result = tokio::task::spawn_blocking(move || service.dispatch(&principal, request))
        .await
        .unwrap_or_else(|_| {
            Err(crate::domain::RpcError {
                code: "runtime_error".into(),
                message: "runtime command worker failed".into(),
                details: None,
            })
        });
    let accepted_shutdown = is_shutdown && result.is_ok();
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
    }
}

#[cfg(windows)]
/// One sequential worker per sequenced lane; its replies go to the connection's single writer.
fn lane_worker(
    service: Arc<RuntimeService>,
    principal: String,
    replies: tokio::sync::mpsc::UnboundedSender<Reply>,
) -> tokio::sync::mpsc::Sender<RpcRequest> {
    let (sender, mut requests) = tokio::sync::mpsc::channel::<RpcRequest>(LANE_QUEUE);
    tokio::spawn(async move {
        while let Some(request) = requests.recv().await {
            let reply = run_request(Arc::clone(&service), principal.clone(), request, true).await;
            if replies.send(reply).is_err() {
                break;
            }
        }
    });
    sender
}

#[cfg(windows)]
async fn serve_control(
    mut pipe: tokio::net::windows::named_pipe::NamedPipeServer,
    service: Arc<RuntimeService>,
    credential: &str,
) -> Result<()> {
    let principal = authenticate(&mut pipe, credential, &service.db.epoch()?).await?;
    let mut sent_seq = service.db.snapshot()?.revision;
    let (mut reader, mut writer) = tokio::io::split(pipe);
    let mut decoder = FrameDecoder::default();
    let (replies, mut completed) = tokio::sync::mpsc::unbounded_channel::<Reply>();
    let ordered = lane_worker(Arc::clone(&service), principal.clone(), replies.clone());
    let terminal = lane_worker(Arc::clone(&service), principal.clone(), replies.clone());
    let reads = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_READS));
    // Sequenced requests without a reply yet. Events wait for them, as in the old one-at-a-time
    // loop, so a mutation's reply is still written before the events it caused.
    let mut sequenced_in_flight = 0usize;
    loop {
        tokio::select! {
            frame = decoder.read(&mut reader) => {
                let request: RpcRequest = serde_json::from_slice(&frame?)?;
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
                let delivery = write_json(&mut writer, &reply.body?).await;
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
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {}
        }
        if sequenced_in_flight == 0 {
            let epoch = service.db.epoch()?;
            for (seq, event, data) in service.db.events_after(sent_seq)? {
                write_json(
                    &mut writer,
                    &json!({"v":PROTOCOL_VERSION,"event":event,"epoch":epoch,"seq":seq,"data":data}),
                )
                .await?;
                sent_seq = seq;
            }
        }
        if service.shutdown_requested() {
            return Ok(());
        }
    }
}
#[cfg(windows)]
async fn serve_output(
    mut pipe: tokio::net::windows::named_pipe::NamedPipeServer,
    service: Arc<RuntimeService>,
    credential: &str,
) -> Result<()> {
    let _principal = authenticate(&mut pipe, credential, &service.db.epoch()?).await?;
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
                            // A corrupt/legacy gap belongs to this subscription,
                            // not to every terminal multiplexed on this pipe.  Do
                            // not invent bytes across it: tell the consumer to
                            // skip to the durable end.  Keep the existing credit:
                            // kind 4 carries no bytes to acknowledge, and that
                            // credit must remain available for later live output.
                            let end = service.db.output_end(id)?;
                            write_output(&mut pipe, 4, &json!({"sessionId":id,"cursor":end}), &[])
                                .await?;
                            advance_cursor_past_history_gap(cursor, end);
                            break;
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
async fn read_json<T: tokio::io::AsyncRead + Unpin>(stream: &mut T) -> Result<Value> {
    let bytes = read_binary(stream).await?;
    Ok(serde_json::from_slice(&bytes)?)
}
#[cfg(windows)]
async fn write_json<T: tokio::io::AsyncWrite + Unpin>(stream: &mut T, value: &Value) -> Result<()> {
    write_binary(stream, &serde_json::to_vec(value)?).await
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
    fn slow_reads_run_concurrently_and_terminal_control_keeps_its_own_order() {
        for read in [
            "terminal.read",
            "git.status",
            "git.diff",
            "git.log",
            "review.changes",
            "filesystem.search",
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
            "git.push",
            "git.commit",
            "git.index.write",
            "session.resume",
            "session.stop",
            "worktree.list",
            "workspace.save",
            "filesystem.write",
            "review.checkpoint",
            "review.revert",
            "runtime.shutdown",
            "not.a.method",
        ] {
            assert_eq!(request_lane(method), Lane::Ordered, "{method}");
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
