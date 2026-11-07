use crate::{
    error::ClientError,
    framing::{self, MAX_RESPONSE},
    transport::{authenticate, AuthenticateRequest, Dialer, IrohDialer, PinnedTls, MOBILE_ALPN},
    ClientEventListener, ConnectionInfo, MachineCredentials,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncWriteExt, ReadHalf, WriteHalf},
    sync::{oneshot, Mutex as AsyncMutex},
    task::AbortHandle,
};
use zeroize::Zeroizing;

const MAX_PENDING_REQUESTS: usize = 256;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

type PendingSender = oneshot::Sender<Result<Value, ClientError>>;
type ListenerSlot = Arc<Mutex<Option<Arc<dyn ClientEventListener>>>>;

pub(crate) struct Connections {
    iroh: IrohDialer,
    entries: Mutex<HashMap<String, Arc<MachineConnection>>>,
    connect_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    generations: Arc<Mutex<HashMap<String, u64>>>,
    next_generation: AtomicU64,
    listener: ListenerSlot,
}

pub(crate) struct MachineConnection {
    machine_id: String,
    generation: u64,
    client_id: String,
    epoch: String,
    permission: String,
    credential: Zeroizing<String>,
    dialer: Dialer,
    writer: AsyncMutex<WriteHalf<PinnedTls>>,
    pending: AsyncMutex<HashMap<String, PendingSender>>,
    active: AtomicBool,
    closing: AtomicBool,
    reader_abort: Mutex<Option<AbortHandle>>,
    listener: ListenerSlot,
    generations: Arc<Mutex<HashMap<String, u64>>>,
}

impl Connections {
    pub(crate) fn new(iroh: IrohDialer, listener: ListenerSlot) -> Self {
        Self {
            iroh,
            entries: Mutex::new(HashMap::new()),
            connect_locks: Mutex::new(HashMap::new()),
            generations: Arc::new(Mutex::new(HashMap::new())),
            next_generation: AtomicU64::new(1),
            listener,
        }
    }

    pub(crate) fn set_listener(
        &self,
        listener: Option<Arc<dyn ClientEventListener>>,
    ) -> Result<(), ClientError> {
        *self
            .listener
            .lock()
            .map_err(|_| ClientError::internal("event listener lock poisoned"))? = listener;
        Ok(())
    }

    pub(crate) async fn connect(
        &self,
        machine: MachineCredentials,
    ) -> Result<ConnectionInfo, ClientError> {
        validate_machine(&machine)?;
        let machine_id = machine.machine_id.clone();
        let lock = self.connection_lock(&machine_id)?;
        let _single_flight = lock.lock().await;
        if let Some(existing) = self.entry(&machine_id)? {
            if existing.is_active() {
                return Ok(existing.info());
            }
        }
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        self.generations
            .lock()
            .map_err(|_| ClientError::internal("generation lock poisoned"))?
            .insert(machine_id.clone(), generation);
        emit_state(&self.listener, &machine_id, "connecting", None);
        let result = self.establish(machine, generation).await;
        let state = match result {
            Ok(state) => state,
            Err(error) => {
                self.emit_state_if_current(
                    &machine_id,
                    generation,
                    state_for_error(&error),
                    Some(error.to_string()),
                );
                return Err(error);
            }
        };
        let generation_is_current = {
            let generations = self
                .generations
                .lock()
                .map_err(|_| ClientError::internal("generation lock poisoned"))?;
            generations.get(&machine_id).copied() == Some(generation)
        };
        if !generation_is_current {
            state.close().await;
            return Err(ClientError::NotConnected(
                "connection attempt was cancelled".into(),
            ));
        }
        let old = {
            self.entries
                .lock()
                .map_err(|_| ClientError::internal("connection registry lock poisoned"))?
                .insert(machine_id.clone(), Arc::clone(&state))
        };
        if let Some(old) = old {
            old.close().await;
        }
        state.start_reader();
        if !state.is_active()
            || !self.emit_state_if_current(&machine_id, generation, "connected", None)
        {
            state.close().await;
            return Err(ClientError::NotConnected(
                "connection attempt was cancelled".into(),
            ));
        }
        Ok(state.info())
    }

    async fn establish(
        &self,
        machine: MachineCredentials,
        generation: u64,
    ) -> Result<Arc<MachineConnection>, ClientError> {
        let dialer = Dialer::new(
            machine.endpoint.clone(),
            machine.tls_fingerprint.clone(),
            self.iroh.clone(),
        )?;
        let mut stream = dialer.open_tls(MOBILE_ALPN).await?;
        let client_id = uuid::Uuid::new_v4().to_string();
        let authenticated = authenticate(
            &mut stream,
            AuthenticateRequest {
                credential: &machine.credential,
                channel: "control",
                machine_id: &machine.machine_id,
                client_id: &client_id,
                epoch: None,
                port: None,
                loopback: None,
            },
        )
        .await?;
        let (reader, writer) = tokio::io::split(stream);
        let state = Arc::new(MachineConnection {
            machine_id: machine.machine_id,
            generation,
            client_id,
            epoch: authenticated.epoch,
            permission: authenticated.permission,
            credential: Zeroizing::new(machine.credential),
            dialer,
            writer: AsyncMutex::new(writer),
            pending: AsyncMutex::new(HashMap::new()),
            active: AtomicBool::new(true),
            closing: AtomicBool::new(false),
            reader_abort: Mutex::new(None),
            listener: Arc::clone(&self.listener),
            generations: Arc::clone(&self.generations),
        });
        state.install_reader(reader);
        Ok(state)
    }

    pub(crate) async fn disconnect(&self, machine_id: &str) -> Result<(), ClientError> {
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        self.generations
            .lock()
            .map_err(|_| ClientError::internal("generation lock poisoned"))?
            .insert(machine_id.to_owned(), generation);
        let lock = self.connection_lock(machine_id)?;
        let _single_flight = lock.lock().await;
        self.generations
            .lock()
            .map_err(|_| ClientError::internal("generation lock poisoned"))?
            .insert(machine_id.to_owned(), generation);
        let state = self
            .entries
            .lock()
            .map_err(|_| ClientError::internal("connection registry lock poisoned"))?
            .remove(machine_id);
        if let Some(state) = state {
            state.close().await;
        }
        emit_state(&self.listener, machine_id, "disconnected", None);
        Ok(())
    }

    pub(crate) async fn disconnect_all(&self) -> Result<(), ClientError> {
        let ids = self
            .entries
            .lock()
            .map_err(|_| ClientError::internal("connection registry lock poisoned"))?
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            self.disconnect(&id).await?;
        }
        Ok(())
    }

    pub(crate) async fn request(
        &self,
        machine_id: &str,
        method: &str,
        params_json: &str,
    ) -> Result<String, ClientError> {
        let state = self
            .entry(machine_id)?
            .filter(|state| state.is_active())
            .ok_or_else(|| ClientError::NotConnected("computer is not connected".into()))?;
        state.request(method, params_json).await
    }

    pub(crate) fn entry(
        &self,
        machine_id: &str,
    ) -> Result<Option<Arc<MachineConnection>>, ClientError> {
        Ok(self
            .entries
            .lock()
            .map_err(|_| ClientError::internal("connection registry lock poisoned"))?
            .get(machine_id)
            .cloned())
    }

    fn connection_lock(&self, machine_id: &str) -> Result<Arc<AsyncMutex<()>>, ClientError> {
        let mut locks = self
            .connect_locks
            .lock()
            .map_err(|_| ClientError::internal("connection lock poisoned"))?;
        Ok(Arc::clone(
            locks
                .entry(machine_id.to_owned())
                .or_insert_with(|| Arc::new(AsyncMutex::new(()))),
        ))
    }

    fn emit_state_if_current(
        &self,
        machine_id: &str,
        generation: u64,
        state: &str,
        message: Option<String>,
    ) -> bool {
        let Ok(generations) = self.generations.lock() else {
            return false;
        };
        if generations.get(machine_id).copied() != Some(generation) {
            return false;
        }
        emit_state(&self.listener, machine_id, state, message);
        true
    }
}

impl MachineConnection {
    fn info(&self) -> ConnectionInfo {
        ConnectionInfo {
            epoch: self.epoch.clone(),
            permission: self.permission.clone(),
        }
    }

    pub(crate) fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire) && self.generation_matches()
    }

    fn install_reader(self: &Arc<Self>, reader: ReadHalf<PinnedTls>) {
        let state = Arc::clone(self);
        let task = tokio::spawn(async move {
            state.read_loop(reader).await;
        });
        if let Ok(mut slot) = self.reader_abort.lock() {
            *slot = Some(task.abort_handle());
        }
    }

    fn start_reader(&self) {
        // The task is installed before publication so a host frame cannot race
        // an absent reader. This hook documents the publication boundary.
    }

    async fn read_loop(self: Arc<Self>, mut reader: ReadHalf<PinnedTls>) {
        let result = loop {
            let bytes = match framing::read_frame(&mut reader).await {
                Ok(bytes) => bytes,
                Err(error) => break Err(error),
            };
            let value: Value = match serde_json::from_slice(&bytes) {
                Ok(value) => value,
                Err(_) => break Err(ClientError::protocol("invalid JSON frame")),
            };
            if value.get("id").is_some() && bytes.len() > MAX_RESPONSE {
                break Err(ClientError::protocol("response exceeds 6 MiB"));
            }
            match self.handle_frame(value).await {
                Ok(true) => {}
                Ok(false) => break Ok(()),
                Err(error) => break Err(error),
            }
        };
        let _ = self.writer.lock().await.shutdown().await;
        self.fail_pending(ClientError::NotConnected("connection closed".into()))
            .await;
        let was_active = self.active.swap(false, Ordering::AcqRel);
        if was_active && !self.closing.load(Ordering::Acquire) {
            let (state, message) = match result {
                Ok(()) => (
                    "revoked",
                    Some("computer revoked this connection".to_owned()),
                ),
                Err(error) => (state_for_error(&error), Some(error.to_string())),
            };
            self.emit_state_if_current(state, message);
        }
    }

    async fn handle_frame(&self, value: Value) -> Result<bool, ClientError> {
        if !self.generation_matches() {
            return Ok(false);
        }
        if value.get("v").and_then(Value::as_u64) != Some(1) {
            return Err(ClientError::protocol("invalid protocol frame version"));
        }
        if let Some(id) = value.get("id").and_then(Value::as_str) {
            let result = value.get("result");
            let error = value.get("error");
            if result.is_some() == error.is_some() {
                return Err(ClientError::protocol(
                    "response must contain exactly one of result or error",
                ));
            }
            let error_details = error
                .map(|error| {
                    let code = error
                        .get("code")
                        .and_then(Value::as_str)
                        .ok_or_else(|| ClientError::protocol("response error omitted code"))?;
                    let message = error
                        .get("message")
                        .and_then(Value::as_str)
                        .ok_or_else(|| ClientError::protocol("response error omitted message"))?;
                    Ok::<_, ClientError>((code, message))
                })
                .transpose()?;
            let sender = self.pending.lock().await.remove(id);
            if let Some(sender) = sender {
                if let Some(result) = result {
                    let _ = sender.send(Ok(result.clone()));
                } else if let Some((code, message)) = error_details {
                    let remote = ClientError::Remote(format!("{code}: {message}"));
                    let revoked = matches!(
                        code,
                        "mobile_revoked" | "peer_revoked" | "device_revoked" | "credential_expired"
                    );
                    let _ = sender.send(Err(remote));
                    if revoked {
                        return Ok(false);
                    }
                }
            }
            return Ok(true);
        }
        let event = value
            .get("event")
            .and_then(Value::as_str)
            .ok_or_else(|| ClientError::protocol("unknown control frame"))?;
        let epoch = value
            .get("epoch")
            .and_then(Value::as_str)
            .ok_or_else(|| ClientError::protocol("event omitted epoch"))?;
        if epoch != self.epoch {
            return Ok(true);
        }
        if event.is_empty()
            || value.get("seq").and_then(Value::as_u64).is_none()
            || value.get("data").is_none()
        {
            return Err(ClientError::protocol("invalid runtime event"));
        }
        if let Some(reason) = terminal_revoke_reason(&value, event)? {
            return Err(ClientError::Remote(format!(
                "{reason}: computer revoked this connection"
            )));
        }
        if self.active.load(Ordering::Acquire) {
            let json = serde_json::to_string(&value).map_err(ClientError::internal)?;
            self.emit_runtime_if_current(json);
        }
        Ok(true)
    }

    async fn request(&self, method: &str, params_json: &str) -> Result<String, ClientError> {
        if !self.is_active() {
            return Err(ClientError::NotConnected(
                "computer is not connected".into(),
            ));
        }
        if method.is_empty() || method.len() > 128 || method.chars().any(char::is_control) {
            return Err(ClientError::protocol("invalid method"));
        }
        let params: Value = serde_json::from_str(params_json)
            .map_err(|_| ClientError::protocol("paramsJson is not valid JSON"))?;
        if !params.is_object() {
            return Err(ClientError::protocol("request params must be an object"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            if pending.len() >= MAX_PENDING_REQUESTS {
                return Err(ClientError::Remote(
                    "request_capacity: too many pending requests".into(),
                ));
            }
            pending.insert(id.clone(), sender);
        }
        let frame = serde_json::json!({"v":1,"id":id,"method":method,"params":params});
        let write = tokio::time::timeout(REQUEST_TIMEOUT, async {
            let mut writer = self.writer.lock().await;
            if !self.active.load(Ordering::Acquire) || !self.generation_matches() {
                return Err(ClientError::NotConnected(
                    "computer is not connected".into(),
                ));
            }
            framing::write_value(&mut *writer, &frame).await
        })
        .await;
        let write = match write {
            Ok(result) => result,
            Err(_) => Err(ClientError::RequestTimeout(format!(
                "{method} write timed out; the request may have been sent and was not replayed"
            ))),
        };
        if let Err(error) = write {
            self.pending.lock().await.remove(&id);
            self.fence_transport(&error).await;
            return Err(error);
        }
        let result = match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(ClientError::NotConnected(
                "connection closed before the response".into(),
            )),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(ClientError::RequestTimeout(format!(
                    "{method} timed out; the request was not replayed"
                )))
            }
        }?;
        serde_json::to_string(&result).map_err(ClientError::internal)
    }

    pub(crate) async fn open_tunnel(
        &self,
        port: u16,
        loopback: &str,
    ) -> Result<PinnedTls, ClientError> {
        if !self.is_active() {
            return Err(ClientError::NotConnected(
                "computer is not connected".into(),
            ));
        }
        if port == 0 || !matches!(loopback, "127.0.0.1" | "::1") {
            return Err(ClientError::protocol("invalid loopback tunnel target"));
        }
        let mut stream = self.dialer.open_tls(MOBILE_ALPN).await?;
        authenticate(
            &mut stream,
            AuthenticateRequest {
                credential: &self.credential,
                channel: "tunnel",
                machine_id: &self.machine_id,
                client_id: &self.client_id,
                epoch: Some(&self.epoch),
                port: Some(port),
                loopback: Some(loopback),
            },
        )
        .await?;
        Ok(stream)
    }

    async fn close(&self) {
        self.closing.store(true, Ordering::Release);
        self.active.store(false, Ordering::Release);
        if let Ok(mut abort) = self.reader_abort.lock() {
            if let Some(abort) = abort.take() {
                abort.abort();
            }
        }
        let _ = self.writer.lock().await.shutdown().await;
        self.fail_pending(ClientError::NotConnected("connection closed".into()))
            .await;
    }

    async fn fail_pending(&self, error: ClientError) {
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for (_, sender) in pending {
            let _ = sender.send(Err(error.clone()));
        }
    }

    async fn fence_transport(&self, error: &ClientError) {
        let was_active = self.active.swap(false, Ordering::AcqRel);
        if let Ok(mut abort) = self.reader_abort.lock() {
            if let Some(abort) = abort.take() {
                abort.abort();
            }
        }
        let _ = self.writer.lock().await.shutdown().await;
        self.fail_pending(ClientError::NotConnected("connection closed".into()))
            .await;
        if was_active && !self.closing.load(Ordering::Acquire) {
            self.emit_state_if_current(state_for_error(error), Some(error.to_string()));
        }
    }

    fn generation_matches(&self) -> bool {
        self.generations
            .lock()
            .ok()
            .and_then(|generations| generations.get(&self.machine_id).copied())
            == Some(self.generation)
    }

    fn emit_runtime_if_current(&self, event_json: String) -> bool {
        let Ok(generations) = self.generations.lock() else {
            return false;
        };
        if generations.get(&self.machine_id).copied() != Some(self.generation)
            || !self.active.load(Ordering::Acquire)
        {
            return false;
        }
        emit_runtime(&self.listener, &self.machine_id, event_json);
        true
    }

    fn emit_state_if_current(&self, state: &str, message: Option<String>) -> bool {
        let Ok(generations) = self.generations.lock() else {
            return false;
        };
        if generations.get(&self.machine_id).copied() != Some(self.generation) {
            return false;
        }
        emit_state(&self.listener, &self.machine_id, state, message);
        true
    }
}

fn validate_machine(machine: &MachineCredentials) -> Result<(), ClientError> {
    if uuid::Uuid::parse_str(&machine.machine_id).is_err()
        || machine.credential.len() < 32
        || machine.credential.len() > 128
        || machine.credential.chars().any(char::is_control)
    {
        return Err(ClientError::protocol("invalid machine credentials"));
    }
    Ok(())
}

fn terminal_revoke_reason<'a>(
    value: &'a Value,
    event: &str,
) -> Result<Option<&'a str>, ClientError> {
    if event != "mobile.revoked" {
        return Ok(None);
    }
    let reason = value
        .get("data")
        .and_then(|data| data.get("reason"))
        .and_then(Value::as_str)
        .filter(|reason| matches!(*reason, "revoked" | "credential_expired"))
        .ok_or_else(|| ClientError::protocol("invalid mobile revoke event"))?;
    if value.get("seq").and_then(Value::as_u64) != Some(0) {
        return Err(ClientError::protocol("invalid mobile revoke sequence"));
    }
    Ok(Some(reason))
}

fn state_for_error(error: &ClientError) -> &'static str {
    match error {
        ClientError::PinMismatch(_) => "pin-mismatch",
        ClientError::Incompatible(_) | ClientError::AlpnMismatch(_) => "incompatible",
        ClientError::Remote(message)
            if message.contains("revoked") || message.contains("expired") =>
        {
            "revoked"
        }
        _ => "disconnected",
    }
}

fn emit_runtime(listener: &ListenerSlot, machine_id: &str, event_json: String) {
    let listener = listener.lock().ok().and_then(|slot| slot.clone());
    if let Some(listener) = listener {
        listener.runtime_event(machine_id.to_owned(), event_json);
    }
}

pub(crate) fn emit_state(
    listener: &ListenerSlot,
    machine_id: &str,
    state: &str,
    message: Option<String>,
) {
    let listener = listener.lock().ok().and_then(|slot| slot.clone());
    if let Some(listener) = listener {
        listener.connection_state(machine_id.to_owned(), state.to_owned(), message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn credentials_are_strictly_bounded() {
        let base = MachineCredentials {
            machine_id: uuid::Uuid::new_v4().to_string(),
            endpoint: "https://127.0.0.1:1".into(),
            tls_fingerprint: "aa".repeat(32),
            credential: "x".repeat(32),
        };
        assert!(validate_machine(&base).is_ok());
        assert!(validate_machine(&MachineCredentials {
            credential: "x".repeat(31),
            ..base
        })
        .is_err());
    }

    #[test]
    fn only_the_typed_terminal_revoke_shape_is_permanent() {
        let revoked = json!({"v":1,"event":"mobile.revoked","epoch":"epoch","seq":0,"data":{"reason":"revoked"}});
        assert_eq!(
            terminal_revoke_reason(&revoked, "mobile.revoked").unwrap(),
            Some("revoked")
        );
        let expired = json!({"v":1,"event":"mobile.revoked","epoch":"epoch","seq":0,"data":{"reason":"credential_expired"}});
        assert_eq!(
            terminal_revoke_reason(&expired, "mobile.revoked").unwrap(),
            Some("credential_expired")
        );
        let ordinary = json!({"v":1,"event":"mobile.changed","epoch":"epoch","seq":1,"data":{}});
        assert_eq!(
            terminal_revoke_reason(&ordinary, "mobile.changed").unwrap(),
            None
        );
        let malformed = json!({"v":1,"event":"mobile.revoked","epoch":"epoch","seq":1,"data":{"reason":"revoked"}});
        assert!(terminal_revoke_reason(&malformed, "mobile.revoked").is_err());
    }
}
