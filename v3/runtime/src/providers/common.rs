use super::ProviderError;
use crate::job::SessionJob;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    ffi::OsStr,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy)]
pub enum EnvelopeStyle {
    JsonRpc2,
    Codex,
    Sidecar,
}

#[derive(Debug, Clone)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub display: String,
}

impl CommandSpec {
    pub fn provider(command: &str, args: &[&str]) -> Result<Self, ProviderError> {
        let path = find_executable(command).ok_or_else(|| {
            ProviderError::unavailable(
                command,
                format!("{command} executable was not found on PATH"),
            )
        })?;
        Ok(Self::from_path(
            path,
            args.iter().map(|value| (*value).to_owned()).collect(),
        ))
    }

    pub fn from_path(path: PathBuf, args: Vec<String>) -> Self {
        #[cfg(windows)]
        if is_windows_script(&path) {
            let command_line = std::iter::once(quote_cmd_arg(&path.to_string_lossy()))
                .chain(args.iter().map(|arg| quote_cmd_arg(arg)))
                .collect::<Vec<_>>()
                .join(" ");
            return Self {
                display: command_line.clone(),
                program: "cmd.exe".to_owned(),
                args: vec![
                    "/d".to_owned(),
                    "/s".to_owned(),
                    "/c".to_owned(),
                    command_line,
                ],
            };
        }

        let program = path.to_string_lossy().into_owned();
        let display = std::iter::once(program.as_str())
            .chain(args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ");
        Self {
            program,
            args,
            display,
        }
    }

    pub fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.args);
        hide_background_window(&mut command);
        command
    }
}

#[cfg(windows)]
fn is_windows_script(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "cmd" | "bat" | "ps1"
            )
        })
}

#[cfg(windows)]
fn quote_cmd_arg(value: &str) -> String {
    let escaped = value
        .replace('^', "^^")
        .replace('&', "^&")
        .replace('|', "^|")
        .replace('<', "^<")
        .replace('>', "^>")
        .replace('%', "%%")
        .replace('"', "\\\"");
    format!("\"{escaped}\"")
}

pub fn find_executable(command: &str) -> Option<PathBuf> {
    let direct = PathBuf::from(command);
    if direct.components().count() > 1 && direct.is_file() {
        return Some(direct);
    }
    let path = env::var_os("PATH")?;
    #[cfg(windows)]
    let extensions = ["exe", "cmd", "bat", "ps1", ""];
    #[cfg(not(windows))]
    let extensions = [""];
    for directory in env::split_paths(&path) {
        for extension in extensions {
            let name = if extension.is_empty() {
                command.to_owned()
            } else {
                format!("{command}.{extension}")
            };
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(prefer_native_opencode(candidate));
            }
        }
    }
    None
}

fn prefer_native_opencode(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let stem = path.file_stem().and_then(OsStr::to_str).unwrap_or_default();
        if stem.eq_ignore_ascii_case("opencode") {
            if let Some(parent) = path.parent() {
                let native = parent
                    .join("node_modules")
                    .join("opencode-ai")
                    .join("bin")
                    .join("opencode.exe");
                if native.is_file() {
                    return native;
                }
            }
        }
    }
    path
}

pub fn command_output(spec: &CommandSpec, timeout: Duration) -> Result<String, ProviderError> {
    let mut command = spec.command();
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        ProviderError::new(
            "provider_launch_failed",
            format!("failed to start {}: {error}", spec.display),
        )
    })?;
    // Drain both pipes while the process runs. Waiting for exit before reading
    // deadlocks as soon as a history export fills an OS pipe buffer.
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ProviderError::new("provider_internal", "stdout pipe unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ProviderError::new("provider_internal", "stderr pipe unavailable"))?;
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = BufReader::new(stdout).read_to_end(&mut bytes);
        bytes
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut bytes);
        bytes
    });
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = String::from_utf8_lossy(&stdout_reader.join().unwrap_or_default())
                    .trim()
                    .to_owned();
                let stderr = String::from_utf8_lossy(&stderr_reader.join().unwrap_or_default())
                    .trim()
                    .to_owned();
                return if status.success() {
                    Ok(if stdout.is_empty() { stderr } else { stdout })
                } else {
                    Err(ProviderError::new(
                        "provider_probe_failed",
                        if stderr.is_empty() { stdout } else { stderr },
                    ))
                };
            }
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(ProviderError::new(
                    "provider_timeout",
                    format!(
                        "{} did not finish within {} seconds",
                        spec.display,
                        timeout.as_secs()
                    ),
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(ProviderError::new(
                    "provider_probe_failed",
                    error.to_string(),
                ));
            }
        }
    }
}

pub fn version_probe(command: &str) -> (bool, Option<String>, Option<String>) {
    let Ok(spec) = CommandSpec::provider(command, &["--version"]) else {
        return (
            false,
            None,
            Some(format!("{command} executable was not found on PATH")),
        );
    };
    match command_output(&spec, Duration::from_secs(5)) {
        Ok(output) => (
            true,
            output
                .lines()
                .find(|line| !line.trim().is_empty())
                .map(str::trim)
                .map(ToOwned::to_owned),
            None,
        ),
        Err(error) => (true, None, Some(error.message)),
    }
}

enum Pending {
    Blocking(mpsc::SyncSender<Result<Value, ProviderError>>),
    Async(Box<dyn FnOnce(Result<Value, ProviderError>) + Send>),
}

pub struct JsonLineProcess {
    label: String,
    style: EnvelopeStyle,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<String, Pending>>>,
    next_id: AtomicU64,
    alive: Arc<std::sync::atomic::AtomicBool>,
    _job: SessionJob,
}

#[derive(Clone)]
pub struct JsonLineResponder {
    label: String,
    style: EnvelopeStyle,
    stdin: Arc<Mutex<ChildStdin>>,
}

impl JsonLineResponder {
    pub fn respond(&self, id: Value, result: Value) -> Result<(), ProviderError> {
        write_stdin(
            &self.stdin,
            &self.label,
            match self.style {
                EnvelopeStyle::JsonRpc2 => json!({"jsonrpc":"2.0","id":id,"result":result}),
                EnvelopeStyle::Codex => json!({"id":id,"result":result}),
                EnvelopeStyle::Sidecar => {
                    return Err(ProviderError::new(
                        "provider_internal",
                        "sidecar notifications are unsupported",
                    ))
                }
            },
        )
    }

    pub fn reject(&self, id: Value, code: i64, message: &str) -> Result<(), ProviderError> {
        write_stdin(
            &self.stdin,
            &self.label,
            match self.style {
                EnvelopeStyle::JsonRpc2 => {
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
                }
                EnvelopeStyle::Codex => json!({"id":id,"error":{"code":code,"message":message}}),
                EnvelopeStyle::Sidecar => {
                    return Err(ProviderError::new(
                        "provider_internal",
                        "sidecar notifications are unsupported",
                    ))
                }
            },
        )
    }
}

pub fn spawn_managed_service(
    spec: &CommandSpec,
    cwd: Option<&str>,
    envs: &[(&str, &str)],
) -> Result<(Child, SessionJob), ProviderError> {
    let owned_cwd = cwd
        .map(ToOwned::to_owned)
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|path| path.to_string_lossy().into_owned())
        })
        .ok_or_else(|| {
            ProviderError::new("provider_launch_failed", "current directory is unavailable")
        })?;

    #[cfg(windows)]
    let (mut command, gate) = {
        let gate = crate::bootstrap::BootstrapGate::new().map_err(|error| {
            ProviderError::new(
                "provider_launch_failed",
                format!("creating provider launch gate: {error:#}"),
            )
        })?;
        let command = gate
            .service_command(&spec.program, &spec.args, &owned_cwd)
            .map_err(|error| {
                ProviderError::new(
                    "provider_launch_failed",
                    format!("configuring provider bootstrap: {error:#}"),
                )
            })?;
        (command, gate)
    };
    #[cfg(not(windows))]
    let mut command = spec.command();

    command
        .current_dir(&owned_cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in envs {
        command.env(name, value);
    }
    let mut child = command.spawn().map_err(|error| {
        ProviderError::new(
            "provider_launch_failed",
            format!("failed to start {}: {error}", spec.display),
        )
    })?;
    let job = match SessionJob::assign(child.id()) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ProviderError::new(
                "provider_launch_failed",
                format!("assigning provider process tree: {error:#}"),
            ));
        }
    };
    #[cfg(windows)]
    if let Err(error) = gate.release(child.id()) {
        let _ = child.kill();
        let _ = child.wait();
        drop(job);
        return Err(ProviderError::new(
            "provider_launch_failed",
            format!("releasing provider launch gate: {error:#}"),
        ));
    }
    Ok((child, job))
}

impl JsonLineProcess {
    pub fn spawn(
        label: impl Into<String>,
        spec: &CommandSpec,
        cwd: Option<&str>,
        envs: &[(&str, &str)],
        style: EnvelopeStyle,
        on_message: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> Result<Self, ProviderError> {
        let label = label.into();
        let (mut child, job) = spawn_managed_service(spec, cwd, envs)?;
        let stdin = child.stdin.take().ok_or_else(|| {
            ProviderError::new(
                "provider_launch_failed",
                format!("{label} stdin is unavailable"),
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ProviderError::new(
                "provider_launch_failed",
                format!("{label} stdout is unavailable"),
            )
        })?;
        let stderr = child.stderr.take();
        let child = Arc::new(Mutex::new(child));
        let pending = Arc::new(Mutex::new(HashMap::<String, Pending>::new()));
        let reader_pending = Arc::clone(&pending);
        let reader_label = label.clone();
        let alive = Arc::new(AtomicBool::new(true));
        let reader_alive = Arc::clone(&alive);
        thread::Builder::new()
            .name(format!("{label}-stdout"))
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let raw = match line {
                        Ok(line) => match serde_json::from_str::<Value>(&line) {
                            Ok(raw) => raw,
                            Err(error) => {
                                on_message(json!({"kind":"protocol.error","message":format!("invalid JSON from {reader_label}: {error}")}));
                                continue;
                            }
                        },
                        Err(error) => {
                            on_message(json!({"kind":"process.error","message":format!("failed reading {reader_label}: {error}")}));
                            break;
                        }
                    };
                    if is_response(&raw) {
                        let key = id_key(raw.get("id").unwrap_or(&Value::Null));
                        let pending_request = reader_pending
                            .lock()
                            .ok()
                            .and_then(|mut pending| pending.remove(&key));
                        if let Some(pending_request) = pending_request {
                            let result = response_result(&raw);
                            match pending_request {
                                Pending::Blocking(sender) => {
                                    let _ = sender.send(result);
                                }
                                Pending::Async(callback) => callback(result),
                            }
                        } else {
                            on_message(raw);
                        }
                    } else {
                        on_message(raw);
                    }
                }
                reader_alive.store(false, Ordering::SeqCst);
                let disconnected = ProviderError::new(
                    "provider_disconnected",
                    format!("{reader_label} closed its output stream"),
                );
                if let Ok(mut pending) = reader_pending.lock() {
                    for (_, request) in pending.drain() {
                        match request {
                            Pending::Blocking(sender) => {
                                let _ = sender.send(Err(disconnected.clone()));
                            }
                            Pending::Async(callback) => callback(Err(disconnected.clone())),
                        }
                    }
                }
            })
            .map_err(|error| ProviderError::new("provider_internal", error.to_string()))?;
        if let Some(stderr) = stderr {
            let stderr_label = label.clone();
            let _ = thread::Builder::new()
                .name(format!("{label}-stderr"))
                .spawn(move || {
                    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                        eprintln!("[{stderr_label}] {line}");
                    }
                });
        }
        Ok(Self {
            label,
            style,
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            pending,
            next_id: AtomicU64::new(1),
            alive,
            _job: job,
        })
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub fn responder(&self) -> JsonLineResponder {
        JsonLineResponder {
            label: self.label.clone(),
            style: self.style,
            stdin: Arc::clone(&self.stdin),
        }
    }

    pub fn request(&self, method: &str, params: Value) -> Result<Value, ProviderError> {
        let (id, frame) = self.request_frame(method, params);
        let (sender, receiver) = mpsc::sync_channel(1);
        self.pending
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "pending request lock poisoned"))?
            .insert(id.to_string(), Pending::Blocking(sender));
        if let Err(error) = self.write(frame) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id.to_string());
            }
            return Err(error);
        }
        match receiver.recv_timeout(REQUEST_TIMEOUT) {
            Ok(result) => result,
            Err(_) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id.to_string());
                }
                Err(ProviderError::new(
                    "provider_timeout",
                    format!("{} request {method} timed out", self.label),
                ))
            }
        }
    }

    pub fn request_async(
        &self,
        method: &str,
        params: Value,
        callback: impl FnOnce(Result<Value, ProviderError>) + Send + 'static,
    ) -> Result<u64, ProviderError> {
        let (id, frame) = self.request_frame(method, params);
        self.pending
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "pending request lock poisoned"))?
            .insert(id.to_string(), Pending::Async(Box::new(callback)));
        if let Err(error) = self.write(frame) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id.to_string());
            }
            return Err(error);
        }
        Ok(id)
    }

    pub fn notification(&self, method: &str, params: Value) -> Result<(), ProviderError> {
        let frame = match self.style {
            EnvelopeStyle::JsonRpc2 => json!({"jsonrpc":"2.0","method":method,"params":params}),
            EnvelopeStyle::Codex => json!({"method":method,"params":params}),
            EnvelopeStyle::Sidecar => {
                return Err(ProviderError::new(
                    "provider_internal",
                    "sidecar notifications are unsupported",
                ));
            }
        };
        self.write(frame)
    }

    pub fn sidecar_request(&self, op: &str, mut params: Value) -> Result<Value, ProviderError> {
        if !matches!(self.style, EnvelopeStyle::Sidecar) {
            return Err(ProviderError::new(
                "provider_internal",
                "not a sidecar process",
            ));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let object = params.as_object_mut().ok_or_else(|| {
            ProviderError::new(
                "provider_internal",
                "sidecar request params must be an object",
            )
        })?;
        object.insert("id".to_owned(), Value::from(id));
        object.insert("op".to_owned(), Value::String(op.to_owned()));
        let (sender, receiver) = mpsc::sync_channel(1);
        self.pending
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "pending request lock poisoned"))?
            .insert(id.to_string(), Pending::Blocking(sender));
        if let Err(error) = self.write(params) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id.to_string());
            }
            return Err(error);
        }
        match receiver.recv_timeout(REQUEST_TIMEOUT) {
            Ok(result) => result,
            Err(_) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id.to_string());
                }
                Err(ProviderError::new(
                    "provider_timeout",
                    format!("{} request {op} timed out", self.label),
                ))
            }
        }
    }

    pub fn respond(&self, id: Value, result: Value) -> Result<(), ProviderError> {
        self.responder().respond(id, result)
    }

    fn request_frame(&self, method: &str, params: Value) -> (u64, Value) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let frame = match self.style {
            EnvelopeStyle::JsonRpc2 => {
                json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
            }
            EnvelopeStyle::Codex => json!({"id":id,"method":method,"params":params}),
            EnvelopeStyle::Sidecar => json!({"id":id,"op":method,"params":params}),
        };
        (id, frame)
    }

    fn write(&self, frame: Value) -> Result<(), ProviderError> {
        write_stdin(&self.stdin, &self.label, frame)
    }
}

fn write_stdin(
    stdin: &Arc<Mutex<ChildStdin>>,
    label: &str,
    frame: Value,
) -> Result<(), ProviderError> {
    let mut stdin = stdin
        .lock()
        .map_err(|_| ProviderError::new("provider_internal", "provider stdin lock poisoned"))?;
    serde_json::to_writer(&mut *stdin, &frame)
        .map_err(|error| ProviderError::new("provider_protocol", error.to_string()))?;
    stdin
        .write_all(b"\n")
        .and_then(|_| stdin.flush())
        .map_err(|error| {
            ProviderError::new(
                "provider_disconnected",
                format!("failed writing to {label}: {error}"),
            )
        })
}

impl Drop for JsonLineProcess {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn id_key(id: &Value) -> String {
    serde_json::to_string(id)
        .unwrap_or_else(|_| "null".to_owned())
        .trim_matches('"')
        .to_owned()
}

fn is_response(raw: &Value) -> bool {
    raw.get("id").is_some()
        && (raw.get("result").is_some() || raw.get("error").is_some() || raw.get("ok").is_some())
}

fn response_result(raw: &Value) -> Result<Value, ProviderError> {
    if let Some(error) = raw.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| error.as_str())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| error.to_string());
        return Err(ProviderError::new("provider_error", message).with_details(error.clone()));
    }
    Ok(raw
        .get("result")
        .or_else(|| raw.get("ok"))
        .cloned()
        .unwrap_or(Value::Null))
}

pub fn encode_approval_id(id: &Value) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(id.to_string())
}

pub fn decode_approval_id(value: &str) -> Result<Value, ProviderError> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| ProviderError::new("invalid_approval", "approval id is malformed"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| ProviderError::new("invalid_approval", "approval id is malformed"))
}

pub fn validate_native_id(value: &str) -> Result<(), ProviderError> {
    if value.is_empty()
        || value.len() > 512
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.:/".contains(character))
    {
        return Err(ProviderError::new(
            "invalid_native_id",
            "provider-native session id contains unsupported characters",
        ));
    }
    Ok(())
}

/// Builds the public history page without serializing an absent cursor as
/// JSON null. Optional TypeScript properties do not accept null on the wire.
pub fn history_page(items: Vec<Value>, next_cursor: Option<Value>) -> Value {
    let mut page = json!({"items": items});
    if let (Some(object), Some(cursor)) = (
        page.as_object_mut(),
        next_cursor.filter(|value| !value.is_null()),
    ) {
        object.insert("nextCursor".to_owned(), cursor);
    }
    page
}

/// Adds a provider-supplied optional property only when it has a concrete
/// value. This keeps nullable upstream APIs behind the provider boundary.
pub fn insert_optional(object: &mut Value, key: &str, value: Option<Value>) {
    if let (Some(fields), Some(value)) = (
        object.as_object_mut(),
        value.filter(|candidate| !candidate.is_null()),
    ) {
        fields.insert(key.to_owned(), value);
    }
}

#[cfg(windows)]
fn hide_background_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_background_window(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_ids_round_trip_json_rpc_ids() {
        for id in [json!(7), json!("request-7")] {
            let encoded = encode_approval_id(&id);
            assert_eq!(decode_approval_id(&encoded).unwrap(), id);
        }
    }

    #[test]
    fn native_ids_reject_shell_metacharacters() {
        assert!(validate_native_id("session-123").is_ok());
        assert!(validate_native_id("session & del C:\\x").is_err());
    }

    #[test]
    fn history_page_omits_an_absent_cursor() {
        let page = history_page(Vec::new(), None);
        assert!(page.get("nextCursor").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn managed_service_preserves_json_stdio_through_bootstrap() {
        let script = "$line=[Console]::In.ReadLine(); [Console]::Out.WriteLine($line)";
        let spec = CommandSpec::provider(
            "powershell",
            &["-NoProfile", "-NonInteractive", "-Command", script],
        )
        .unwrap();
        let (mut child, job) = spawn_managed_service(&spec, None, &[]).unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        stdin.write_all(b"{\"probe\":true}\n").unwrap();
        stdin.flush().unwrap();
        drop(stdin);
        let mut observed = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line == r#"{"probe":true}"# {
                observed = true;
                break;
            }
        }
        let _ = child.wait();
        drop(job);
        assert!(observed, "bootstrap did not preserve service stdin/stdout");
    }
}
