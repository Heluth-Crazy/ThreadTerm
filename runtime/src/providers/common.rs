use super::ProviderError;
use crate::job::SessionJob;
use serde_json::{json, Value};
#[cfg(any(test, not(windows)))]
use std::process::Command;
use std::{
    collections::HashMap,
    env,
    ffi::OsStr,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Stdio},
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
        Self::from_path(path, args.iter().map(|value| (*value).to_owned()).collect())
    }

    /// Builds a launch spec for an executable path. The program and arguments
    /// stay structured; Windows command scripts are validated here but wrapped
    /// in their `cmd.exe` invocation only at the actual spawn points.
    pub fn from_path(path: PathBuf, args: Vec<String>) -> Result<Self, ProviderError> {
        #[cfg(windows)]
        windows_script_invocation(&path.to_string_lossy(), &args)?;
        let program = path.to_string_lossy().into_owned();
        let display = std::iter::once(program.as_str())
            .chain(args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ");
        Ok(Self {
            program,
            args,
            display,
        })
    }

    #[cfg(any(test, not(windows)))]
    pub fn command(&self) -> Result<Command, ProviderError> {
        #[cfg(windows)]
        if let Some(invocation) = windows_script_invocation(&self.program, &self.args)? {
            use std::os::windows::process::CommandExt;
            let mut command = Command::new(&invocation.program);
            command.args(&invocation.args);
            // The /c payload is a fully prepared cmd.exe command line. Appending
            // it verbatim avoids the MSVC-style quoting that would otherwise
            // corrupt the inner quotes before cmd.exe parses them.
            command.raw_arg(&invocation.raw_payload);
            hide_background_window(&mut command);
            return Ok(command);
        }
        let mut command = Command::new(&self.program);
        command.args(&self.args);
        hide_background_window(&mut command);
        Ok(command)
    }
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsScriptInvocation {
    pub program: String,
    pub args: Vec<String>,
    pub raw_payload: String,
}

/// Resolves how a Windows command script must be launched: `Ok(None)` for
/// native executables, `Ok(Some)` with the `cmd.exe` invocation for cmd/bat
/// scripts, and an explicit error for PowerShell scripts (unsupported) and for
/// arguments that cannot be represented safely on a cmd.exe command line.
#[cfg(windows)]
pub(crate) fn windows_script_invocation(
    program: &str,
    args: &[String],
) -> Result<Option<WindowsScriptInvocation>, ProviderError> {
    let extension = Path::new(program)
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("cmd") | Some("bat") => {}
        Some("ps1") => {
            return Err(ProviderError::new(
                "provider_script_unsupported",
                format!(
                    "{program} is a PowerShell script, which ThreadTerm cannot launch directly; install the provider's .cmd or .exe entry point instead"
                ),
            ));
        }
        _ => return Ok(None),
    }
    let mut tokens = vec![quote_cmd_token(program)?];
    for arg in args {
        tokens.push(quote_cmd_token(arg)?);
    }
    // `cmd /s /c` strips the first and last quote of the payload before running
    // it, so the inner command line is wrapped in one extra outer pair.
    let raw_payload = format!("\"{}\"", tokens.join(" "));
    Ok(Some(WindowsScriptInvocation {
        program: "cmd.exe".to_owned(),
        args: ["/d", "/s", "/v:off", "/c"]
            .iter()
            .map(|flag| (*flag).to_owned())
            .collect(),
        raw_payload,
    }))
}

/// Quotes one token for a cmd.exe script command line. Inside double quotes
/// `& | < > ^ !` are literal; `%` is never safe because cmd.exe expands
/// `%VAR%` patterns even inside quotes, and `"` cannot be represented
/// faithfully through batch shims that forward `%*` to a native executable.
/// Both are rejected instead of being silently corrupted.
#[cfg(windows)]
fn quote_cmd_token(value: &str) -> Result<String, ProviderError> {
    if value.contains(['\0', '\r', '\n']) {
        return Err(ProviderError::new(
            "invalid_argument",
            "argument contains a control character and cannot be passed to a Windows command script",
        ));
    }
    if value.contains('%') {
        return Err(ProviderError::new(
            "invalid_argument",
            "argument contains '%' and cannot be passed safely to a Windows command script because cmd.exe expands %VAR% patterns",
        ));
    }
    if value.contains('"') {
        return Err(ProviderError::new(
            "invalid_argument",
            "argument contains a double quote and cannot be passed safely to a Windows command script",
        ));
    }
    if value.is_empty() {
        return Ok("\"\"".to_owned());
    }
    let needs_quotes = value.chars().any(|character| {
        matches!(
            character,
            ' ' | '\t' | '&' | '|' | '<' | '>' | '^' | '!' | '(' | ')' | ',' | ';' | '='
        )
    });
    // npm-style shims forward `%*` to a native executable. A trailing slash
    // before our closing quote escapes that quote in the native argv parser,
    // potentially merging the following argument into this one.
    if needs_quotes && value.ends_with('\\') {
        return Err(ProviderError::new(
            "invalid_argument",
            "argument ends in a backslash after requiring quotes and cannot be passed safely through a Windows command script",
        ));
    }
    Ok(if needs_quotes {
        format!("\"{value}\"")
    } else {
        value.to_owned()
    })
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
    #[cfg(windows)]
    let (mut child, job) = spawn_managed_service(spec, None, &[])?;
    #[cfg(not(windows))]
    let mut command = spec.command()?;
    #[cfg(not(windows))]
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(not(windows))]
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
                #[cfg(windows)]
                drop(job);
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
                #[cfg(windows)]
                drop(job);
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
                #[cfg(windows)]
                drop(job);
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
    let spec = match CommandSpec::provider(command, &["--version"]) {
        Ok(spec) => spec,
        Err(error) => return (false, None, Some(error.message)),
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
        Err(error) => (false, None, Some(error.message)),
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

    // Validate script launch arguments before opening the bootstrap gate so an
    // unencodable argument fails fast instead of surfacing as a gate timeout.
    #[cfg(windows)]
    windows_script_invocation(&spec.program, &spec.args)?;

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
    let mut command = spec.command()?;

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

/// True for canonical UUID text (`8-4-4-4-12` hexadecimal), the shape Codex,
/// Claude, and Grok use for native session ids.
pub fn is_uuid(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    let lengths = [8, 4, 4, 4, 12];
    parts.len() == 5
        && parts.iter().zip(lengths).all(|(part, length)| {
            part.len() == length && part.chars().all(|c| c.is_ascii_hexdigit())
        })
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

#[cfg(all(test, windows))]
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

/// Cross-path fixtures proving a Windows cmd/bat script receives its arguments
/// byte-for-byte. The batch file mirrors how npm shims parse their command
/// line: one cmd.exe parse of the `/c` payload, then batch parameter handling.
#[cfg(all(test, windows))]
pub(crate) mod windows_script_fixtures {
    use std::io::Write;
    use std::path::{Path, PathBuf};

    /// Writes `echoargs.cmd` into `dir`. The script stores each argument with
    /// delayed expansion disabled, then echoes it back with delayed expansion
    /// so metacharacters in the value are never re-parsed by cmd.
    pub(crate) fn write_echo_fixture(dir: &Path) -> PathBuf {
        let script = dir.join("echoargs.cmd");
        let mut content = String::from("@echo off\r\nsetlocal DisableDelayedExpansion\r\n");
        for index in 1..=6 {
            content.push_str(&format!("set \"__{index}=%~{index}\"\r\n"));
        }
        content.push_str("setlocal EnableDelayedExpansion\r\n");
        for index in 1..=6 {
            content.push_str(&format!("echo(ARG{index}=!__{index}!\r\n"));
        }
        content.push_str("echo(DONE\r\n");
        std::fs::File::create(&script)
            .unwrap()
            .write_all(content.as_bytes())
            .unwrap();
        script
    }

    /// Extracts the echoed argument values in order. Panics unless the script
    /// ran to completion.
    pub(crate) fn parse_echo_output(output: &str) -> Vec<String> {
        let mut args = Vec::new();
        let mut done = false;
        for line in output.lines() {
            let line = line.trim_end_matches(['\r', '\n']);
            if line == "DONE" {
                done = true;
                break;
            }
            if let Some(value) = line
                .strip_prefix("ARG")
                .and_then(|rest| rest.split_once('='))
                .map(|(_, value)| value)
            {
                args.push(value.to_owned());
            }
        }
        assert!(done, "echo fixture did not complete; output was:\n{output}");
        args
    }

    /// Compares echoed arguments against the launch arguments, ignoring the
    /// empty trailing echoes for parameters that were never passed.
    pub(crate) fn assert_echo_matches(output: &str, expected: &[String]) {
        let parsed = parse_echo_output(output);
        assert!(
            parsed.len() >= expected.len(),
            "echo fixture returned too few args: {parsed:?}"
        );
        assert_eq!(&parsed[..expected.len()], expected, "arguments mangled");
    }

    /// Removes ANSI CSI (`ESC [ ... final`) and OSC (`ESC ] ... BEL`) sequences
    /// so echoed lines can be found in ConPTY output. Only used on test
    /// captures; never applied to retained terminal bytes.
    pub(crate) fn strip_ansi(input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        let mut chars = input.chars().peekable();
        while let Some(c) = chars.next() {
            if c != '\u{1b}' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    let mut prev = '\0';
                    for c in chars.by_ref() {
                        if c == '\u{7}' || (prev == '\u{1b}' && c == '\\') {
                            break;
                        }
                        prev = c;
                    }
                }
                _ => {}
            }
        }
        out
    }

    /// A script directory whose path contains spaces and non-ASCII characters,
    /// matching npm prefixes under real user profiles.
    pub(crate) fn fixture_dir() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("带 空格 dir");
        std::fs::create_dir_all(&dir).unwrap();
        let script = write_echo_fixture(&dir);
        (root, script)
    }

    /// cmd.exe writes pipe and ConPTY output in the machine OEM codepage; tests
    /// decode it explicitly instead of lossy UTF-8 so non-ASCII checks work.
    pub(crate) fn oem_decode(bytes: &[u8]) -> String {
        use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_OEMCP};
        if bytes.is_empty() {
            return String::new();
        }
        unsafe {
            let len = MultiByteToWideChar(
                CP_OEMCP,
                0,
                bytes.as_ptr(),
                bytes.len() as i32,
                std::ptr::null_mut(),
                0,
            );
            let mut wide = vec![0u16; len as usize];
            MultiByteToWideChar(
                CP_OEMCP,
                0,
                bytes.as_ptr(),
                bytes.len() as i32,
                wide.as_mut_ptr(),
                len,
            );
            String::from_utf16_lossy(&wide)
        }
    }

    /// The closest value cmd.exe can carry for `value`: its OEM best-fit form.
    /// On machines whose OEM codepage cannot represent a character this yields
    /// the fallback, keeping assertions portable while still proving full
    /// fidelity wherever the character is representable.
    pub(crate) fn oem_attainable(value: &str) -> String {
        use windows_sys::Win32::Globalization::{WideCharToMultiByte, CP_OEMCP};
        let wide: Vec<u16> = value.encode_utf16().collect();
        let bytes = unsafe {
            let len = WideCharToMultiByte(
                CP_OEMCP,
                0,
                wide.as_ptr(),
                wide.len() as i32,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
                std::ptr::null_mut(),
            );
            let mut bytes = vec![0u8; len as usize];
            WideCharToMultiByte(
                CP_OEMCP,
                0,
                wide.as_ptr(),
                wide.len() as i32,
                bytes.as_mut_ptr(),
                len,
                std::ptr::null(),
                std::ptr::null_mut(),
            );
            bytes
        };
        oem_decode(&bytes)
    }

    pub(crate) fn oem_attainable_args(args: &[String]) -> Vec<String> {
        args.iter().map(|arg| oem_attainable(arg)).collect()
    }
}

#[cfg(all(test, windows))]
mod windows_script_tests {
    use super::windows_script_fixtures::{
        assert_echo_matches, fixture_dir, oem_attainable_args, oem_decode,
    };
    use super::*;

    /// Every argument in this matrix must reach a cmd/bat script unchanged.
    fn argument_matrix() -> Vec<String> {
        vec![
            "plain".to_owned(),
            "with space".to_owned(),
            "中文参数".to_owned(),
            "a&b|c<d>e".to_owned(),
            "caret^bang!".to_owned(),
            "(paren),semi;eq=al".to_owned(),
        ]
    }

    fn extra_argument_matrix() -> Vec<String> {
        vec![
            String::new(),
            "trail\\".to_owned(),
            "--session-id".to_owned(),
            "550e8400-e29b-41d4-a716-446655440000".to_owned(),
        ]
    }

    fn run_command_bytes(spec: &CommandSpec, cwd: &Path) -> Vec<u8> {
        let mut command = spec.command().unwrap();
        command
            .current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        let mut bytes = Vec::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        let mut err = Vec::new();
        child.stderr.take().unwrap().read_to_end(&mut err).unwrap();
        let status = child.wait().unwrap();
        assert!(status.success(), "script failed: {}", oem_decode(&err));
        bytes
    }

    fn native_npm_shim_args(args: Vec<String>) -> Vec<String> {
        let (root, _) = fixture_dir();
        let directory = root.path().join("npm shim");
        std::fs::create_dir_all(&directory).unwrap();
        let shim = directory.join("native-args.cmd");
        std::fs::write(&shim, "@echo off\r\nnode \"%~dp0native-args.cjs\" %*\r\n").unwrap();
        std::fs::write(
            directory.join("native-args.cjs"),
            "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n",
        )
        .unwrap();
        let spec = CommandSpec::from_path(shim, args).unwrap();
        serde_json::from_slice(&run_command_bytes(&spec, &directory)).unwrap()
    }

    #[test]
    fn npm_style_shim_preserves_native_node_arguments() {
        let args = vec![
            "with space".to_owned(),
            "中文参数".to_owned(),
            "a&b|c<d>e".to_owned(),
            "caret^bang!".to_owned(),
            String::new(),
        ];
        assert_eq!(native_npm_shim_args(args.clone()), args);
    }

    #[test]
    fn npm_style_shim_does_not_silently_mangle_quoted_trailing_backslash() {
        let args = vec!["C:\\foo bar\\".to_owned(), "next".to_owned()];
        let error = CommandSpec::from_path(PathBuf::from("native-args.cmd"), args).unwrap_err();
        assert_eq!(error.code, "invalid_argument");
        assert!(error.message.contains("backslash"));
    }

    #[test]
    fn script_args_round_trip_through_plain_command() {
        let (_root, script) = fixture_dir();
        let cwd = script.parent().unwrap();
        for args in [argument_matrix(), extra_argument_matrix()] {
            let spec = CommandSpec::from_path(script.clone(), args.clone()).unwrap();
            let output = oem_decode(&run_command_bytes(&spec, cwd));
            assert_echo_matches(&output, &oem_attainable_args(&args));
        }
    }

    #[test]
    fn script_args_round_trip_through_managed_service_bootstrap() {
        let (_root, script) = fixture_dir();
        let cwd = script.parent().unwrap().to_string_lossy().into_owned();
        for args in [argument_matrix(), extra_argument_matrix()] {
            let spec = CommandSpec::from_path(script.clone(), args.clone()).unwrap();
            let (mut child, job) = spawn_managed_service(&spec, Some(&cwd), &[]).unwrap();
            let mut stdout = child.stdout.take().unwrap();
            let mut bytes = Vec::new();
            let _ = stdout.read_to_end(&mut bytes);
            let _ = child.wait();
            drop(job);
            assert_echo_matches(&oem_decode(&bytes), &oem_attainable_args(&args));
        }
    }

    #[test]
    fn script_launch_rejects_arguments_cmd_cannot_carry() {
        let (_root, script) = fixture_dir();
        for bad in [
            "100%done",
            "%PATH%",
            "%*",
            "quote\"in",
            "line\nbreak",
            "carriage\rreturn",
        ] {
            let result = CommandSpec::from_path(script.clone(), vec![bad.to_owned()]);
            let error = result.unwrap_err();
            assert_eq!(error.code, "invalid_argument", "arg {bad:?}");
        }
    }

    #[test]
    fn powershell_script_entries_are_explicitly_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("tool.ps1");
        std::fs::write(&script, "Write-Output hi\r\n").unwrap();
        let error = CommandSpec::from_path(script, Vec::new()).unwrap_err();
        assert_eq!(error.code, "provider_script_unsupported");
    }

    #[test]
    fn native_exe_specs_stay_direct() {
        let kernel = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_owned());
        let exe = Path::new(&kernel).join("System32").join("where.exe");
        if !exe.is_file() {
            return;
        }
        let spec =
            CommandSpec::from_path(exe.clone(), vec!["/R".to_owned(), kernel.clone()]).unwrap();
        assert_eq!(spec.program, exe.to_string_lossy());
        assert_eq!(spec.args, vec!["/R".to_owned(), kernel]);
    }

    #[test]
    fn nonzero_script_version_probe_is_not_reported_installed() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("broken-tool.cmd");
        std::fs::write(
            &script,
            "@echo off\r\necho broken version probe 1>&2\r\nexit /b 17\r\n",
        )
        .unwrap();
        let (installed, version, reason) = version_probe(&script.to_string_lossy());
        assert!(
            !installed,
            "a failed version probe cannot authorize terminal launch"
        );
        assert!(version.is_none());
        assert!(reason.unwrap_or_default().contains("broken version probe"));
    }

    #[test]
    fn command_output_closes_descendant_pipes_before_returning() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("background-tool.cmd");
        std::fs::write(
            &script,
            "@echo off\r\nstart \"\" /b powershell.exe -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 2\"\r\necho parentdone\r\nexit /b 0\r\n",
        )
        .unwrap();
        let spec = CommandSpec::from_path(script, Vec::new()).unwrap();
        let started = std::time::Instant::now();
        let output = command_output(&spec, Duration::from_millis(500)).unwrap();
        assert!(output.contains("parentdone"));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "finished probe waited for a background descendant's output pipe"
        );
    }

    #[test]
    fn command_output_timeout_closes_descendant_pipes_before_joining() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("slow-background-tool.cmd");
        std::fs::write(
            &script,
            "@echo off\r\nstart \"\" /b powershell.exe -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 2\"\r\nping -n 5 127.0.0.1 >nul\r\n",
        )
        .unwrap();
        let spec = CommandSpec::from_path(script, Vec::new()).unwrap();
        let started = std::time::Instant::now();
        let error = command_output(&spec, Duration::from_millis(150)).unwrap_err();
        assert_eq!(error.code, "provider_timeout");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "timed-out probe waited for a background descendant's output pipe"
        );
    }
}
