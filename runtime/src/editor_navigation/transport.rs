use crate::{
    job::SessionJob,
    providers::common::{spawn_managed_service, CommandSpec},
};
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    process::Child,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Condvar, Mutex, Weak,
    },
    thread,
    time::{Duration, Instant},
};

pub(super) const MAX_LSP_FRAME_BYTES: usize = 8 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_STDERR_BYTES: usize = 16 * 1024;
const MAX_PENDING_REQUESTS: usize = 128;
const MAX_CONFIGURATION_ITEMS: usize = 128;
const MAX_SERVER_ERROR_CHARS: usize = 4 * 1024;
const WRITER_QUEUE_CAPACITY: usize = 8;
const WRITE_COMPLETION_TIMEOUT: Duration = Duration::from_secs(1);
const REVERSE_WRITE_TIMEOUT: Duration = Duration::from_millis(250);
const CANCEL_WRITE_TIMEOUT: Duration = Duration::from_millis(50);
const SHUTDOWN_RESPONSE_TIMEOUT: Duration = Duration::from_millis(500);
const GRACEFUL_EXIT_TIMEOUT: Duration = Duration::from_millis(250);
const CHILD_REAP_TIMEOUT: Duration = Duration::from_millis(250);
#[cfg(all(test, windows))]
const TEST_BOOTSTRAP_STDOUT_PREAMBLE: &[u8] = b"\nrunning 1 test\n";

type PendingResult = Arc<(Mutex<Option<Result<Value, String>>>, Condvar)>;
type WriteResult = mpsc::Sender<Result<(), String>>;
type RustQuiescence = Arc<(Mutex<bool>, Condvar)>;

struct WriteCommand {
    bytes: Vec<u8>,
    result: WriteResult,
}

pub(super) struct Transport {
    writer: Mutex<Option<SyncSender<WriteCommand>>>,
    pending: Arc<Mutex<HashMap<u64, PendingResult>>>,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    stopping: AtomicBool,
    child: Mutex<Option<Child>>,
    job: Mutex<Option<SessionJob>>,
    stderr_tail: Arc<Mutex<Vec<u8>>>,
    rust_quiescence: RustQuiescence,
}

impl Transport {
    pub(super) fn spawn(
        spec: &CommandSpec,
        root: &str,
        root_uri: &str,
        client_settings: Option<Value>,
    ) -> Result<Arc<Self>> {
        let (mut child, job) = spawn_managed_service(spec, Some(root), &[])
            .map_err(|error| anyhow!("navigation_server_unavailable: {}", error.message))?;
        let stdin = child.stdin.take().ok_or_else(|| {
            anyhow!("navigation_server_failed: language server stdin is unavailable")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            anyhow!("navigation_server_failed: language server stdout is unavailable")
        })?;
        let stderr = child.stderr.take();
        let (writer, writer_commands) = mpsc::sync_channel::<WriteCommand>(WRITER_QUEUE_CAPACITY);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let stderr_tail = Arc::new(Mutex::new(Vec::new()));
        let rust_quiescence = Arc::new((Mutex::new(false), Condvar::new()));
        let transport = Arc::new(Self {
            writer: Mutex::new(Some(writer.clone())),
            pending: Arc::clone(&pending),
            next_id: AtomicU64::new(1),
            alive: Arc::clone(&alive),
            stopping: AtomicBool::new(false),
            child: Mutex::new(Some(child)),
            job: Mutex::new(Some(job)),
            stderr_tail: Arc::clone(&stderr_tail),
            rust_quiescence: Arc::clone(&rust_quiescence),
        });

        let writer_alive = Arc::clone(&alive);
        let writer_pending = Arc::clone(&pending);
        let writer_transport = Arc::downgrade(&transport);
        let _writer_thread = thread::Builder::new()
            .name("navigation-lsp-writer".into())
            .spawn(move || {
                writer_loop(
                    stdin,
                    writer_commands,
                    writer_alive,
                    writer_pending,
                    writer_transport,
                )
            })
            .context("spawning language server writer")?;

        let owned_root_uri = root_uri.to_owned();
        let reader_transport = Arc::downgrade(&transport);
        let _reader_thread = thread::Builder::new()
            .name("navigation-lsp-reader".into())
            .spawn(move || {
                #[cfg(all(test, windows))]
                let protocol_result = {
                    let mut stdout = stdout;
                    consume_test_bootstrap_stdout_preamble(&mut stdout).and_then(|_| {
                        read_loop(
                            stdout,
                            &writer,
                            &pending,
                            &owned_root_uri,
                            client_settings.as_ref(),
                            &rust_quiescence,
                        )
                    })
                };
                #[cfg(not(all(test, windows)))]
                let protocol_result = read_loop(
                    stdout,
                    &writer,
                    &pending,
                    &owned_root_uri,
                    client_settings.as_ref(),
                    &rust_quiescence,
                );
                let failure = match protocol_result {
                    Ok(()) => "language server closed stdout".to_owned(),
                    Err(error) => format!("language server protocol error: {error:#}"),
                };
                alive.store(false, Ordering::SeqCst);
                fail_all(&pending, failure);
                rust_quiescence.1.notify_all();
                if let Some(transport) = reader_transport.upgrade() {
                    transport.stop();
                }
            })
            .context("spawning language server reader")?;

        if let Some(stderr) = stderr {
            let _stderr_thread = thread::Builder::new()
                .name("navigation-lsp-stderr".into())
                .spawn(move || drain_stderr(stderr, &stderr_tail))
                .context("spawning language server stderr drain")?;
        }
        Ok(transport)
    }

    pub(super) fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancelled: Option<&AtomicBool>,
        on_id: impl FnOnce(u64),
    ) -> Result<Value> {
        self.request_inner(method, params, timeout, cancelled, on_id, false)
    }

    fn request_inner(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancelled: Option<&AtomicBool>,
        on_id: impl FnOnce(u64),
        allow_stopping: bool,
    ) -> Result<Value> {
        if !self.alive.load(Ordering::SeqCst)
            || (!allow_stopping && self.stopping.load(Ordering::SeqCst))
        {
            return Err(anyhow!(
                "navigation_server_failed: language server is not running"
            ));
        }
        let deadline = Instant::now() + timeout;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if id == 0 {
            return Err(anyhow!(
                "navigation_internal: language server request id space was exhausted"
            ));
        }
        let response: PendingResult = Arc::new((Mutex::new(None), Condvar::new()));
        {
            let mut pending = self.pending.lock().map_err(|_| {
                anyhow!("navigation_internal: pending request registry is poisoned")
            })?;
            if pending.len() >= MAX_PENDING_REQUESTS {
                return Err(anyhow!(
                    "navigation_server_busy: language server request limit reached"
                ));
            }
            if pending.contains_key(&id) {
                return Err(anyhow!(
                    "navigation_internal: language server request id was reused"
                ));
            }
            let _ = pending.insert(id, Arc::clone(&response));
        }
        on_id(id);

        let write_wait = deadline
            .saturating_duration_since(Instant::now())
            .min(WRITE_COMPLETION_TIMEOUT);
        if let Err(error) = self.write_with_timeout(
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params,
            }),
            write_wait,
        ) {
            self.remove_pending(id);
            return Err(error);
        }

        let (lock, ready) = &*response;
        let mut value = lock
            .lock()
            .map_err(|_| anyhow!("navigation_internal: request result is poisoned"))?;
        loop {
            if let Some(result) = value.take() {
                self.remove_pending(id);
                return result.map_err(|message| anyhow!("navigation_server_failed: {message}"));
            }
            if cancelled.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                drop(value);
                self.remove_pending(id);
                self.cancel_with_timeout(id, CANCEL_WRITE_TIMEOUT);
                return Err(anyhow!("navigation_cancelled: request was cancelled"));
            }
            let now = Instant::now();
            if now >= deadline {
                drop(value);
                self.remove_pending(id);
                self.cancel_with_timeout(id, CANCEL_WRITE_TIMEOUT);
                return Err(anyhow!(
                    "navigation_timeout: language server request timed out"
                ));
            }
            let slice = deadline
                .saturating_duration_since(now)
                .min(Duration::from_millis(25));
            let (next, _) = ready
                .wait_timeout(value, slice)
                .map_err(|_| anyhow!("navigation_internal: request wait is poisoned"))?;
            value = next;
        }
    }

    pub(super) fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.write(&json!({"jsonrpc":"2.0","method":method,"params":params}))
    }

    pub(super) fn cancel(&self, id: u64) {
        let matched = id != 0
            && self
                .pending
                .lock()
                .map(|pending| pending.contains_key(&id))
                .unwrap_or(false);
        if matched {
            self.cancel_with_timeout(id, CANCEL_WRITE_TIMEOUT);
        }
    }

    fn cancel_with_timeout(&self, id: u64, timeout: Duration) {
        if id != 0 {
            let _ = self.write_with_timeout(
                &json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":id}}),
                timeout,
            );
        }
    }

    fn remove_pending(&self, id: u64) {
        if let Ok(mut pending) = self.pending.lock() {
            let _ = pending.remove(&id);
        }
    }

    fn write(&self, value: &Value) -> Result<()> {
        self.write_with_timeout(value, WRITE_COMPLETION_TIMEOUT)
    }

    fn write_with_timeout(&self, value: &Value, timeout: Duration) -> Result<()> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(anyhow!(
                "navigation_server_failed: language server is not running"
            ));
        }
        let bytes = serde_json::to_vec(value).context("serializing language server frame")?;
        if bytes.len() > MAX_LSP_FRAME_BYTES {
            return Err(anyhow!(
                "navigation_frame_too_large: language server frame exceeds 8 MiB"
            ));
        }
        let guard = self
            .writer
            .lock()
            .map_err(|_| anyhow!("navigation_internal: language server writer is poisoned"))?;
        let writer = guard
            .as_ref()
            .cloned()
            .ok_or_else(|| anyhow!("navigation_server_failed: language server stdin is closed"))?;
        drop(guard);
        enqueue_frame(&writer, bytes, timeout)
    }

    pub(super) fn stderr_summary(&self) -> String {
        let bytes = self
            .stderr_tail
            .lock()
            .map(|bytes| bytes.clone())
            .unwrap_or_default();
        String::from_utf8_lossy(&bytes).trim().to_owned()
    }

    pub(super) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst) && !self.stopping.load(Ordering::SeqCst)
    }

    pub(super) fn wait_for_rust_quiescence(&self, timeout: Duration) -> Result<()> {
        let deadline = Instant::now() + timeout;
        let (lock, ready) = &*self.rust_quiescence;
        let mut quiescent = lock
            .lock()
            .map_err(|_| anyhow!("navigation_internal: rust-analyzer readiness is poisoned"))?;
        loop {
            if !self.is_alive() {
                return Err(anyhow!(
                    "navigation_server_failed: rust-analyzer stopped before becoming quiescent"
                ));
            }
            if *quiescent {
                return Ok(());
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(anyhow!(
                    "navigation_timeout: rust-analyzer did not become quiescent"
                ));
            }
            let slice = deadline
                .saturating_duration_since(now)
                .min(Duration::from_millis(25));
            let (next, _) = ready.wait_timeout(quiescent, slice).map_err(|_| {
                anyhow!("navigation_internal: rust-analyzer readiness wait is poisoned")
            })?;
            quiescent = next;
        }
    }

    pub(super) fn stop(&self) {
        if self.stopping.swap(true, Ordering::SeqCst) {
            return;
        }
        self.rust_quiescence.1.notify_all();
        if self.alive.load(Ordering::SeqCst) {
            let _ = self.request_inner(
                "shutdown",
                Value::Null,
                SHUTDOWN_RESPONSE_TIMEOUT,
                None,
                |_| {},
                true,
            );
            if self.alive.load(Ordering::SeqCst) {
                let _ = self.write_with_timeout(
                    &json!({"jsonrpc":"2.0","method":"exit","params":Value::Null}),
                    CANCEL_WRITE_TIMEOUT,
                );
            }
        }

        let deadline = Instant::now() + GRACEFUL_EXIT_TIMEOUT;
        while Instant::now() < deadline && !self.child_exited() {
            thread::sleep(Duration::from_millis(10));
        }

        self.alive.store(false, Ordering::SeqCst);
        drop(
            self.writer
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take(),
        );
        fail_all(&self.pending, "language server stopped".into());

        // SessionJob is the authoritative tree boundary. Closing it cannot wait
        // on a language server that stopped reading its stdin pipe.
        drop(
            self.job
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take(),
        );
        let child = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(child) = child {
            reap_child_bounded(child, CHILD_REAP_TIMEOUT);
        }
    }

    fn child_exited(&self) -> bool {
        let mut child = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(child) = child.as_mut() else {
            return true;
        };
        child.try_wait().ok().flatten().is_some()
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.stop();
    }
}

fn enqueue_frame(
    writer: &SyncSender<WriteCommand>,
    bytes: Vec<u8>,
    timeout: Duration,
) -> Result<()> {
    if bytes.len() > MAX_LSP_FRAME_BYTES {
        return Err(anyhow!(
            "navigation_frame_too_large: language server frame exceeds 8 MiB"
        ));
    }
    let (result, completed) = mpsc::channel();
    match writer.try_send(WriteCommand { bytes, result }) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            return Err(anyhow!(
                "navigation_server_busy: language server writer queue is full"
            ));
        }
        Err(TrySendError::Disconnected(_)) => {
            return Err(anyhow!(
                "navigation_server_failed: language server writer stopped"
            ));
        }
    }
    match completed.recv_timeout(timeout) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(message)) => Err(anyhow!("navigation_server_failed: {message}")),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(anyhow!(
            "navigation_writer_timeout: language server write timed out"
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(anyhow!(
            "navigation_server_failed: language server writer stopped"
        )),
    }
}

fn writer_loop(
    mut stdin: impl Write,
    commands: Receiver<WriteCommand>,
    alive: Arc<AtomicBool>,
    pending: Arc<Mutex<HashMap<u64, PendingResult>>>,
    transport: Weak<Transport>,
) {
    while let Ok(command) = commands.recv() {
        match write_frame(&mut stdin, &command.bytes) {
            Ok(()) => {
                let _ = command.result.send(Ok(()));
            }
            Err(error) => {
                let message = format!("language server stdin failed: {error:#}");
                let _ = command.result.send(Err(message.clone()));
                for queued in commands.try_iter() {
                    let _ = queued.result.send(Err(message.clone()));
                }
                alive.store(false, Ordering::SeqCst);
                fail_all(&pending, message);
                if let Some(transport) = transport.upgrade() {
                    transport.stop();
                }
                return;
            }
        }
    }
}

fn write_frame(writer: &mut impl Write, bytes: &[u8]) -> Result<()> {
    write!(writer, "Content-Length: {}\r\n\r\n", bytes.len())?;
    writer.write_all(bytes)?;
    writer.flush()?;
    Ok(())
}

#[cfg(all(test, windows))]
fn consume_test_bootstrap_stdout_preamble(reader: &mut impl Read) -> Result<()> {
    let mut actual = [0u8; TEST_BOOTSTRAP_STDOUT_PREAMBLE.len()];
    let mut filled = 0usize;
    while filled < actual.len() {
        match reader.read(&mut actual[filled..]) {
            Ok(0) => {
                return Err(anyhow!(
                    "test bootstrap stdout ended inside its exact preamble: expected {:?}, got {:?}",
                    TEST_BOOTSTRAP_STDOUT_PREAMBLE,
                    &actual[..filled]
                ));
            }
            Ok(read) => filled += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => {
                return Err(error).context("reading exact test bootstrap stdout preamble");
            }
        }
    }
    if &actual[..] != TEST_BOOTSTRAP_STDOUT_PREAMBLE {
        return Err(anyhow!(
            "unexpected test bootstrap stdout preamble: expected {:?}, got {:?}",
            TEST_BOOTSTRAP_STDOUT_PREAMBLE,
            actual
        ));
    }
    Ok(())
}

struct BoundedLineReader<'a, R: BufRead + ?Sized> {
    reader: &'a mut R,
    remaining: usize,
}

impl<'a, R: BufRead + ?Sized> BoundedLineReader<'a, R> {
    fn new(reader: &'a mut R, limit: usize) -> Self {
        Self {
            reader,
            remaining: limit,
        }
    }

    fn read_line(&mut self, line: &mut Vec<u8>) -> Result<usize> {
        line.clear();
        loop {
            let available = self.reader.fill_buf()?;
            if available.is_empty() {
                return Ok(line.len());
            }
            let take = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(available.len(), |index| index + 1);
            if take > self.remaining {
                return Err(anyhow!("frame header exceeds 8 KiB"));
            }
            let ended = available[take - 1] == b'\n';
            line.extend_from_slice(&available[..take]);
            self.reader.consume(take);
            self.remaining -= take;
            if ended {
                return Ok(line.len());
            }
        }
    }
}

fn read_frame(reader: &mut impl BufRead) -> Result<Option<Value>> {
    let mut length = None;
    let mut headers = BoundedLineReader::new(reader, MAX_HEADER_BYTES);
    let mut line = Vec::with_capacity(128);
    let mut saw_header = false;
    loop {
        let read = headers.read_line(&mut line)?;
        if read == 0 {
            if !saw_header {
                return Ok(None);
            }
            return Err(anyhow!("unexpected EOF in frame header"));
        }
        saw_header = true;
        if line == b"\r\n" || line == b"\n" {
            break;
        }
        let header = line.strip_suffix(b"\n").unwrap_or(&line);
        let header = header.strip_suffix(b"\r").unwrap_or(header);
        let colon = header
            .iter()
            .position(|byte| *byte == b':')
            .ok_or_else(|| anyhow!("malformed frame header"))?;
        let (name, value) = (&header[..colon], &header[colon + 1..]);
        if name.eq_ignore_ascii_case(b"Content-Length") {
            if length.is_some() {
                return Err(anyhow!("duplicate Content-Length header"));
            }
            let parsed = std::str::from_utf8(value)
                .map_err(|_| anyhow!("invalid Content-Length header"))?
                .trim()
                .parse::<usize>()
                .map_err(|_| anyhow!("invalid Content-Length header"))?;
            if parsed == 0 || parsed > MAX_LSP_FRAME_BYTES {
                return Err(anyhow!("Content-Length is outside the supported range"));
            }
            length = Some(parsed);
        }
    }
    let length = length.ok_or_else(|| anyhow!("missing Content-Length header"))?;
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .context("decoding language server JSON")
        .map(Some)
}

fn read_loop(
    stdout: impl Read,
    writer: &SyncSender<WriteCommand>,
    pending: &Arc<Mutex<HashMap<u64, PendingResult>>>,
    root_uri: &str,
    client_settings: Option<&Value>,
    rust_quiescence: &RustQuiescence,
) -> Result<()> {
    let mut reader = BufReader::new(stdout);
    while let Some(message) = read_frame(&mut reader)? {
        if message.get("method").is_some() {
            let Some(id) = message.get("id") else {
                observe_rust_quiescence(&message, rust_quiescence);
                continue;
            };
            if !valid_server_request_id(id) {
                return Err(anyhow!("server request has an invalid id"));
            }
            let response = reverse_response(&message, root_uri, client_settings);
            let bytes = serde_json::to_vec(&response)?;
            enqueue_frame(writer, bytes, REVERSE_WRITE_TIMEOUT)?;
            continue;
        }

        let Some(id) = client_response_id(message.get("id")) else {
            continue;
        };
        let response = pending
            .lock()
            .ok()
            .and_then(|mut values| values.remove(&id));
        let Some(response) = response else {
            continue;
        };
        let result = response_result(&message);
        let (lock, ready) = &*response;
        if let Ok(mut slot) = lock.lock() {
            if slot.is_none() {
                *slot = Some(result);
                ready.notify_all();
            }
        };
    }
    Ok(())
}

fn observe_rust_quiescence(message: &Value, rust_quiescence: &RustQuiescence) {
    if message.get("method").and_then(Value::as_str) != Some("experimental/serverStatus") {
        return;
    }
    let Some(value) = message
        .pointer("/params/quiescent")
        .and_then(Value::as_bool)
    else {
        return;
    };
    let (lock, ready) = &**rust_quiescence;
    if let Ok(mut current) = lock.lock() {
        if *current != value {
            *current = value;
            ready.notify_all();
        }
    };
}

fn valid_server_request_id(value: &Value) -> bool {
    match value {
        Value::String(_) => true,
        Value::Number(number) => number.as_i64().is_some() || number.as_u64().is_some(),
        _ => false,
    }
}

fn client_response_id(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(number) => number.as_u64(),
        _ => None,
    }
}

fn response_result(message: &Value) -> Result<Value, String> {
    match (message.get("result"), message.get("error")) {
        (Some(result), None) => Ok(result.clone()),
        (None, Some(error)) => {
            let code = error.get("code").and_then(Value::as_i64).unwrap_or(-32_603);
            let text = error
                .get("message")
                .and_then(Value::as_str)
                .map(|value| {
                    value
                        .chars()
                        .take(MAX_SERVER_ERROR_CHARS)
                        .collect::<String>()
                })
                .unwrap_or_else(|| "language server error".into());
            Err(format!("LSP {code}: {text}"))
        }
        _ => Err("language server returned a malformed response".into()),
    }
}

fn reverse_response(request: &Value, root_uri: &str, client_settings: Option<&Value>) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    match method {
        "workspace/configuration" => match configuration_result(request, client_settings) {
            Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
            Err(message) => rpc_error(id, -32_602, &message),
        },
        "workspace/workspaceFolders" => json!({
            "jsonrpc":"2.0",
            "id":id,
            "result":[{"uri":root_uri,"name":"workspace"}]
        }),
        "window/workDoneProgress/create" => {
            json!({"jsonrpc":"2.0","id":id,"result":Value::Null})
        }
        "client/registerCapability" | "client/unregisterCapability" => rpc_error(
            id,
            -32_601,
            "Dynamic capability registration is not supported",
        ),
        _ => rpc_error(id, -32_601, "Client method is not supported"),
    }
}

fn configuration_result(request: &Value, client_settings: Option<&Value>) -> Result<Value, String> {
    let items = request
        .pointer("/params/items")
        .and_then(Value::as_array)
        .ok_or_else(|| "workspace/configuration items are required".to_owned())?;
    if items.len() > MAX_CONFIGURATION_ITEMS {
        return Err("workspace/configuration item limit exceeded".into());
    }
    let mut result = Vec::with_capacity(items.len());
    for item in items {
        let item = item
            .as_object()
            .ok_or_else(|| "workspace/configuration item is invalid".to_owned())?;
        let section = match item.get("section") {
            None | Some(Value::Null) => None,
            Some(Value::String(section)) => Some(section.as_str()),
            Some(_) => return Err("workspace/configuration section is invalid".into()),
        };
        result.push(setting_section(client_settings, section));
    }
    Ok(Value::Array(result))
}

fn setting_section(settings: Option<&Value>, section: Option<&str>) -> Value {
    let Some(mut value) = settings else {
        return Value::Null;
    };
    let Some(section) = section.filter(|section| !section.is_empty()) else {
        return value.clone();
    };
    for part in section.split('.') {
        let Some(next) = value.get(part) else {
            return Value::Null;
        };
        value = next;
    }
    value.clone()
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc":"2.0",
        "id":id,
        "error":{"code":code,"message":message}
    })
}

fn fail_all(pending: &Arc<Mutex<HashMap<u64, PendingResult>>>, message: String) {
    let values = pending
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .drain()
        .map(|(_, value)| value)
        .collect::<Vec<_>>();
    for response in values {
        let (lock, ready) = &*response;
        if let Ok(mut value) = lock.lock() {
            if value.is_none() {
                *value = Some(Err(message.clone()));
                ready.notify_all();
            }
        }
    }
}

fn drain_stderr(mut stderr: impl Read, tail: &Arc<Mutex<Vec<u8>>>) {
    let mut buffer = [0u8; 4096];
    while let Ok(read) = stderr.read(&mut buffer) {
        if read == 0 {
            break;
        }
        if let Ok(mut output) = tail.lock() {
            if read >= MAX_STDERR_BYTES {
                output.clear();
                output.extend_from_slice(&buffer[read - MAX_STDERR_BYTES..read]);
                continue;
            }
            let retained = MAX_STDERR_BYTES - read;
            if output.len() > retained {
                let remove = output.len() - retained;
                drop(output.drain(..remove));
            }
            output.extend_from_slice(&buffer[..read]);
        }
    }
}

fn reap_child_bounded(mut child: Child, timeout: Duration) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    let _ = child.kill();
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    // Reaping is useful on Unix but must never extend the transport's stop
    // deadline. The process was already killed and its Windows job was closed.
    let _ = thread::Builder::new()
        .name("navigation-lsp-reaper".into())
        .spawn(move || {
            let _ = child.wait();
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn content_length_frames_round_trip_with_split_reads_and_extra_headers() {
        let value = json!({"jsonrpc":"2.0","id":7,"result":{"text":"λ🙂"}});
        let body = serde_json::to_vec(&value).unwrap();
        let mut bytes = format!(
            "Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes();
        bytes.extend(body);
        let decoded = read_frame(&mut BufReader::with_capacity(3, Cursor::new(bytes)))
            .unwrap()
            .unwrap();
        assert_eq!(decoded, value);
    }

    #[cfg(windows)]
    #[test]
    fn test_bootstrap_preamble_adapter_is_exact_and_keeps_lsp_framing_strict() {
        let value = json!({"jsonrpc":"2.0","id":1,"result":"ready"});
        let body = serde_json::to_vec(&value).unwrap();
        let mut stream = TEST_BOOTSTRAP_STDOUT_PREAMBLE.to_vec();
        write_frame(&mut stream, &body).unwrap();

        let mut adapted = Cursor::new(stream.clone());
        consume_test_bootstrap_stdout_preamble(&mut adapted).unwrap();
        let decoded = read_frame(&mut BufReader::new(adapted)).unwrap().unwrap();
        assert_eq!(decoded, value);

        let mut unadapted = BufReader::new(Cursor::new(stream));
        assert!(read_frame(&mut unadapted).is_err());

        let mut unexpected = Cursor::new(b"\nrunning 2 test\n".to_vec());
        let error = consume_test_bootstrap_stdout_preamble(&mut unexpected).unwrap_err();
        assert!(error
            .to_string()
            .contains("unexpected test bootstrap stdout preamble"));
    }

    #[test]
    fn malformed_duplicate_and_oversize_headers_are_rejected_before_allocation() {
        for raw in [
            b"Content-Length: nope\r\n\r\n".as_slice(),
            b"Content-Length: 1\r\nContent-Length: 1\r\n\r\n{}".as_slice(),
            b"Content-Length: 999999999\r\n\r\n".as_slice(),
            b"X broken\r\n\r\n".as_slice(),
        ] {
            assert!(read_frame(&mut BufReader::new(Cursor::new(raw))).is_err());
        }

        let unterminated = vec![b'x'; MAX_HEADER_BYTES + 1];
        let error = read_frame(&mut BufReader::with_capacity(
            MAX_HEADER_BYTES * 2,
            Cursor::new(unterminated),
        ))
        .unwrap_err();
        assert!(error.to_string().contains("header exceeds 8 KiB"));
    }

    #[test]
    fn string_id_configuration_requests_preserve_id_and_return_launch_sections() {
        let settings = json!({
            "typescript":{"disableAutomaticTypeAcquisition":true},
            "python":{"analysis":{"diagnosticMode":"openFilesOnly"}}
        });
        let accepted = reverse_response(
            &json!({
                "jsonrpc":"2.0",
                "id":"server-request-1",
                "method":"workspace/configuration",
                "params":{"items":[
                    {"section":"typescript"},
                    {"section":"python.analysis.diagnosticMode"},
                    {"section":"missing"},
                    {}
                ]}
            }),
            "file:///repo",
            Some(&settings),
        );
        assert_eq!(accepted["id"], "server-request-1");
        assert_eq!(accepted["result"][0], settings["typescript"]);
        assert_eq!(accepted["result"][1], "openFilesOnly");
        assert!(accepted["result"][2].is_null());
        assert_eq!(accepted["result"][3], settings);
    }

    #[test]
    fn reverse_requests_reject_registration_edits_commands_and_unbounded_configuration() {
        for method in [
            "client/registerCapability",
            "client/unregisterCapability",
            "workspace/applyEdit",
            "workspace/executeCommand",
        ] {
            let response = reverse_response(
                &json!({"id":2,"method":method,"params":{}}),
                "file:///repo",
                None,
            );
            assert_eq!(response["error"]["code"], -32_601, "{method}");
        }
        let items = (0..=MAX_CONFIGURATION_ITEMS)
            .map(|_| json!({}))
            .collect::<Vec<_>>();
        let response = reverse_response(
            &json!({"id":3,"method":"workspace/configuration","params":{"items":items}}),
            "file:///repo",
            None,
        );
        assert_eq!(response["error"]["code"], -32_602);
    }

    #[test]
    fn read_loop_preserves_string_server_ids_and_matches_only_numeric_client_ids() {
        let settings = json!({"typescript":{"safe":true}});
        let server_request = json!({
            "jsonrpc":"2.0",
            "id":"config-id",
            "method":"workspace/configuration",
            "params":{"items":[{"section":"typescript"}]}
        });
        let string_response = json!({"jsonrpc":"2.0","id":"7","result":"wrong"});
        let numeric_response = json!({"jsonrpc":"2.0","id":7,"result":"right"});
        let mut input = Vec::new();
        for message in [&server_request, &string_response, &numeric_response] {
            write_frame(&mut input, &serde_json::to_vec(message).unwrap()).unwrap();
        }

        let response: PendingResult = Arc::new((Mutex::new(None), Condvar::new()));
        let pending = Arc::new(Mutex::new(HashMap::from([(7, Arc::clone(&response))])));
        let rust_quiescence = Arc::new((Mutex::new(false), Condvar::new()));
        let output = Arc::new(Mutex::new(Vec::new()));
        let (writer, commands) = mpsc::sync_channel(WRITER_QUEUE_CAPACITY);
        let captured = Arc::clone(&output);
        let writer_thread = thread::spawn(move || {
            writer_loop(
                SharedWriter(captured),
                commands,
                Arc::new(AtomicBool::new(true)),
                Arc::new(Mutex::new(HashMap::new())),
                Weak::new(),
            )
        });
        read_loop(
            Cursor::new(input),
            &writer,
            &pending,
            "file:///repo",
            Some(&settings),
            &rust_quiescence,
        )
        .unwrap();
        drop(writer);
        writer_thread.join().unwrap();

        let settled = response.0.lock().unwrap().take().unwrap().unwrap();
        assert_eq!(settled, "right");
        let bytes = output.lock().unwrap().clone();
        let reply = read_frame(&mut BufReader::new(Cursor::new(bytes)))
            .unwrap()
            .unwrap();
        assert_eq!(reply["id"], "config-id");
        assert_eq!(reply["result"][0], settings["typescript"]);
    }

    fn observed_rust_quiescence(message: Value) -> bool {
        let mut input = Vec::new();
        write_frame(&mut input, &serde_json::to_vec(&message).unwrap()).unwrap();
        let (writer, _commands) = mpsc::sync_channel(1);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let rust_quiescence = Arc::new((Mutex::new(false), Condvar::new()));
        read_loop(
            Cursor::new(input),
            &writer,
            &pending,
            "file:///repo",
            None,
            &rust_quiescence,
        )
        .unwrap();
        let observed = *rust_quiescence.0.lock().unwrap();
        observed
    }

    #[test]
    fn rust_quiescence_tracks_only_the_exact_boolean_server_status_notification() {
        assert!(!observed_rust_quiescence(json!({
            "jsonrpc":"2.0",
            "method":"experimental/serverStatus/other",
            "params":{"quiescent":true}
        })));
        assert!(!observed_rust_quiescence(json!({
            "jsonrpc":"2.0",
            "method":"experimental/serverStatus",
            "params":{"quiescent":"true"}
        })));
        assert!(!observed_rust_quiescence(json!({
            "jsonrpc":"2.0",
            "method":"experimental/serverStatus",
            "params":{"health":"ok","quiescent":false,"message":null}
        })));
        assert!(observed_rust_quiescence(json!({
            "jsonrpc":"2.0",
            "method":"experimental/serverStatus",
            "params":{"health":"ok","quiescent":true,"message":null}
        })));
    }

    #[test]
    fn rust_quiescence_wait_observes_a_raw_framed_notification() {
        let transport = memory_transport(std::io::sink());
        let writer = transport.writer.lock().unwrap().as_ref().unwrap().clone();
        let notification = json!({
            "jsonrpc":"2.0",
            "method":"experimental/serverStatus",
            "params":{"health":"ok","quiescent":true,"message":null}
        });
        let mut input = Vec::new();
        write_frame(&mut input, &serde_json::to_vec(&notification).unwrap()).unwrap();
        read_loop(
            Cursor::new(input),
            &writer,
            &transport.pending,
            "file:///repo",
            None,
            &transport.rust_quiescence,
        )
        .unwrap();
        drop(writer);
        transport
            .wait_for_rust_quiescence(Duration::from_millis(1))
            .unwrap();
        transport.alive.store(false, Ordering::SeqCst);
        transport.stop();
    }

    #[test]
    fn rust_quiescence_wait_has_a_deadline_and_disconnect_cancels_it() {
        let timeout = memory_transport(std::io::sink());
        let started = Instant::now();
        let error = timeout
            .wait_for_rust_quiescence(Duration::from_millis(40))
            .unwrap_err();
        assert!(error.to_string().contains("navigation_timeout"));
        assert!(started.elapsed() < Duration::from_millis(500));
        timeout.alive.store(false, Ordering::SeqCst);
        timeout.stop();

        let disconnected = memory_transport(std::io::sink());
        disconnected.alive.store(false, Ordering::SeqCst);
        disconnected.rust_quiescence.1.notify_all();
        let started = Instant::now();
        let error = disconnected
            .wait_for_rust_quiescence(Duration::from_secs(1))
            .unwrap_err();
        assert!(error.to_string().contains("navigation_server_failed"));
        assert!(started.elapsed() < Duration::from_millis(500));
        disconnected.stop();
    }

    #[test]
    fn request_timeout_removes_pending_and_cancel_is_bounded() {
        let transport = memory_transport(std::io::sink());
        let started = Instant::now();
        let error = transport
            .request(
                "textDocument/definition",
                json!({}),
                Duration::from_millis(60),
                None,
                |_| {},
            )
            .unwrap_err();
        assert!(error.to_string().contains("navigation_timeout"));
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(transport.pending.lock().unwrap().is_empty());
        transport.alive.store(false, Ordering::SeqCst);
        transport.stop();
    }

    #[test]
    fn blocked_writer_completion_has_a_deadline_and_helper_is_released() {
        let (release, gate) = mpsc::channel();
        let (writer, commands) = mpsc::sync_channel(1);
        let writer_thread = thread::spawn(move || {
            writer_loop(
                GatedWriter { gate: Some(gate) },
                commands,
                Arc::new(AtomicBool::new(true)),
                Arc::new(Mutex::new(HashMap::new())),
                Weak::new(),
            )
        });
        let started = Instant::now();
        let error = enqueue_frame(&writer, b"{}".to_vec(), Duration::from_millis(40)).unwrap_err();
        assert!(error.to_string().contains("navigation_writer_timeout"));
        assert!(started.elapsed() < Duration::from_millis(500));
        release.send(()).unwrap();
        drop(writer);
        writer_thread.join().unwrap();
    }

    #[test]
    fn writer_queue_and_outgoing_frames_fail_closed_at_their_bounds() {
        let (writer, _commands) = mpsc::sync_channel(1);
        let (result, _completed) = mpsc::channel();
        writer
            .try_send(WriteCommand {
                bytes: b"{}".to_vec(),
                result,
            })
            .unwrap();
        let error = enqueue_frame(&writer, b"{}".to_vec(), Duration::from_secs(1)).unwrap_err();
        assert!(error.to_string().contains("writer queue is full"));

        let (writer, _commands) = mpsc::sync_channel(1);
        let error = enqueue_frame(
            &writer,
            vec![0; MAX_LSP_FRAME_BYTES + 1],
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(error.to_string().contains("frame exceeds 8 MiB"));
    }

    #[test]
    fn cancellation_is_sent_only_for_a_matching_pending_numeric_id() {
        let output = Arc::new(Mutex::new(Vec::new()));
        let transport = memory_transport(SharedWriter(Arc::clone(&output)));
        let response: PendingResult = Arc::new((Mutex::new(None), Condvar::new()));
        assert!(transport
            .pending
            .lock()
            .unwrap()
            .insert(9, response)
            .is_none());

        transport.cancel(8);
        assert!(output.lock().unwrap().is_empty());
        transport.cancel(9);
        let bytes = output.lock().unwrap().clone();
        let frame = read_frame(&mut BufReader::new(Cursor::new(bytes)))
            .unwrap()
            .unwrap();
        assert_eq!(frame["method"], "$/cancelRequest");
        assert_eq!(frame["params"]["id"], 9);

        transport.alive.store(false, Ordering::SeqCst);
        transport.stop();
    }

    #[test]
    fn eof_and_stderr_are_bounded() {
        let (writer, commands) = mpsc::sync_channel(1);
        drop(commands);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let rust_quiescence = Arc::new((Mutex::new(false), Condvar::new()));
        assert!(read_loop(
            Cursor::new(Vec::new()),
            &writer,
            &pending,
            "file:///repo",
            None,
            &rust_quiescence,
        )
        .is_ok());

        let input = (0..(MAX_STDERR_BYTES + 1024))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let tail = Arc::new(Mutex::new(Vec::new()));
        drain_stderr(Cursor::new(&input), &tail);
        let tail = tail.lock().unwrap();
        assert_eq!(tail.len(), MAX_STDERR_BYTES);
        assert_eq!(tail.as_slice(), &input[input.len() - MAX_STDERR_BYTES..]);
    }

    struct SharedWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedWriter {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct GatedWriter {
        gate: Option<Receiver<()>>,
    }

    impl Write for GatedWriter {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            if let Some(gate) = self.gate.take() {
                gate.recv_timeout(Duration::from_secs(5)).map_err(|_| {
                    std::io::Error::new(std::io::ErrorKind::TimedOut, "test writer gate timed out")
                })?;
            }
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn memory_transport(writer: impl Write + Send + 'static) -> Arc<Transport> {
        let (sender, commands) = mpsc::sync_channel(WRITER_QUEUE_CAPACITY);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let transport = Arc::new(Transport {
            writer: Mutex::new(Some(sender)),
            pending: Arc::clone(&pending),
            next_id: AtomicU64::new(1),
            alive: Arc::clone(&alive),
            stopping: AtomicBool::new(false),
            child: Mutex::new(None),
            job: Mutex::new(None),
            stderr_tail: Arc::new(Mutex::new(Vec::new())),
            rust_quiescence: Arc::new((Mutex::new(false), Condvar::new())),
        });
        let weak = Arc::downgrade(&transport);
        let _ = thread::spawn(move || writer_loop(writer, commands, alive, pending, weak));
        transport
    }

    #[cfg(windows)]
    fn windows_process_running(pid: u32) -> bool {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, WAIT_OBJECT_0},
            System::Threading::{OpenProcess, WaitForSingleObject},
        };

        const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;
        unsafe {
            let handle = OpenProcess(SYNCHRONIZE_ACCESS, 0, pid);
            if handle.is_null() {
                return false;
            }
            let active = WaitForSingleObject(handle, 0) != WAIT_OBJECT_0;
            CloseHandle(handle);
            active
        }
    }

    #[cfg(windows)]
    #[test]
    fn server_stdout_eof_triggers_owned_cleanup() {
        use std::fs;

        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("close-stdout.cmd");
        fs::write(&script, "@exit /b 0\r\n").unwrap();
        let spec = CommandSpec::from_path(script, Vec::new()).unwrap();
        let transport = Transport::spawn(
            &spec,
            &directory.path().to_string_lossy(),
            "file:///fake-root",
            None,
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while (!transport.stopping.load(Ordering::SeqCst)
            || transport.child.lock().unwrap().is_some())
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(transport.stopping.load(Ordering::SeqCst));
        assert!(!transport.is_alive());
        assert!(transport.child.lock().unwrap().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn managed_cmd_server_executes_waits_and_keeps_its_stdio_tree_live() {
        use std::fs;

        let directory = tempfile::tempdir().unwrap();
        let fixture = directory.path().join("cmd fixture");
        fs::create_dir(&fixture).unwrap();
        let ready = fixture.join("cmd-ready.txt");
        let script = fixture.join("never-read.cmd");
        let content = "@echo off\r\n>cmd-ready.txt echo ready\r\n\"%SystemRoot%\\System32\\ping.exe\" -n 31 127.0.0.1 >nul\r\n";
        fs::write(&script, content).unwrap();
        let spec = CommandSpec::from_path(script, Vec::new()).unwrap();
        let transport =
            Transport::spawn(&spec, &fixture.to_string_lossy(), "file:///fake-root", None).unwrap();

        let tree_deadline = Instant::now() + Duration::from_secs(5);
        let process_ids = loop {
            let ids = transport
                .job
                .lock()
                .unwrap()
                .as_ref()
                .map(SessionJob::process_ids)
                .unwrap_or_default();
            if ready.is_file()
                && ids.len() >= 3
                && transport.is_alive()
                && ids.iter().all(|pid| windows_process_running(*pid))
            {
                break ids;
            }
            assert!(
                Instant::now() < tree_deadline,
                "managed .cmd fixture did not execute and wait: ready={}, ids={ids:?}, alive={}, stderr={:?}, script={content:?}",
                ready.is_file(),
                transport.is_alive(),
                transport.stderr_summary(),
            );
            thread::sleep(Duration::from_millis(25));
        };

        let write_started = Instant::now();
        let error = transport
            .notify("test/large", json!({"payload":"x".repeat(1024 * 1024)}))
            .unwrap_err();
        assert!(
            error.to_string().contains("navigation_writer_timeout"),
            "managed .cmd stdin did not block as required: error={error:#}, ids={process_ids:?}, alive={}, stderr={:?}, script={content:?}",
            transport.is_alive(),
            transport.stderr_summary(),
        );
        assert!(write_started.elapsed() < Duration::from_secs(2));

        transport.stop();
        let gone_deadline = Instant::now() + Duration::from_secs(5);
        while process_ids.iter().any(|pid| windows_process_running(*pid))
            && Instant::now() < gone_deadline
        {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(
            process_ids.iter().all(|pid| !windows_process_running(*pid)),
            "managed .cmd fixture tree survived stop: {process_ids:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn never_reading_server_cannot_hold_stop_and_its_managed_tree_is_removed() {
        use std::path::PathBuf;

        let directory = tempfile::tempdir().unwrap();
        let server = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        assert!(
            server.is_file(),
            "Windows PowerShell fixture is unavailable: {server:?}"
        );
        let spec = CommandSpec::from_path(
            server,
            [
                "-NonInteractive",
                "-NoLogo",
                "-NoProfile",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        )
        .unwrap();
        let transport = Transport::spawn(
            &spec,
            &directory.path().to_string_lossy(),
            "file:///fake-root",
            None,
        )
        .unwrap();

        let tree_deadline = Instant::now() + Duration::from_secs(5);
        let process_ids = loop {
            let ids = transport
                .job
                .lock()
                .unwrap()
                .as_ref()
                .map(SessionJob::process_ids)
                .unwrap_or_default();
            if ids.len() >= 2
                && transport.is_alive()
                && ids.iter().all(|pid| windows_process_running(*pid))
            {
                break ids;
            }
            assert!(
                Instant::now() < tree_deadline,
                "fake server tree did not stay live: ids={ids:?}, alive={}, stderr={:?}",
                transport.is_alive(),
                transport.stderr_summary(),
            );
            thread::sleep(Duration::from_millis(25));
        };

        let write_started = Instant::now();
        let error = transport
            .notify("test/large", json!({"payload":"x".repeat(1024 * 1024)}))
            .unwrap_err();
        assert!(
            error.to_string().contains("navigation_writer_timeout"),
            "expected a blocked-pipe writer timeout, got {error:#}; alive={}; stderr={:?}",
            transport.is_alive(),
            transport.stderr_summary(),
        );
        assert!(write_started.elapsed() < Duration::from_secs(2));

        let stop_started = Instant::now();
        transport.stop();
        assert!(stop_started.elapsed() < Duration::from_secs(2));
        let gone_deadline = Instant::now() + Duration::from_secs(5);
        while process_ids.iter().any(|pid| windows_process_running(*pid))
            && Instant::now() < gone_deadline
        {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(
            process_ids.iter().all(|pid| !windows_process_running(*pid)),
            "managed fake server tree survived stop: {process_ids:?}"
        );
    }
}
