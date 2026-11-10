//! On-demand MCP stdio shim.
//!
//! `threadterm-v3-mcp lazy --name <name> --cache-dir <dir> --idle-secs <secs> -- <command> [args...]`
//!
//! The shim answers the cached handshake while the real server is stopped and
//! starts it on the first request that needs it. After the idle time with
//! nothing in flight it closes the server's stdin and ends its whole Windows
//! job, so a Playwright browser goes with it.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

/// A result bigger than this is not cached: a Playwright screenshot is a tool
/// result, not a list, so the ordinary lists stay far below it.
const CACHE_LIMIT: usize = 4 * 1024 * 1024;
/// Request ids the shim sends to the real server can never be the client's.
const SHIM_ID_PREFIX: &str = "threadterm-lazy-shim-";
const SERVER_START_TIMEOUT: Duration = Duration::from_secs(120);
const SERVER_LIST_TIMEOUT: Duration = Duration::from_secs(60);
const SERVER_STOP_GRACE: Duration = Duration::from_millis(1500);
const IDLE_POLL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone)]
pub struct LazyOptions {
    pub name: String,
    pub cache_dir: PathBuf,
    pub idle: Duration,
    pub command: String,
    pub args: Vec<String>,
}

/// Parses the argument list after `lazy` (the fixed command line the runtime
/// writes and the probes use).
pub fn parse_options(args: &[OsString]) -> anyhow::Result<LazyOptions> {
    let mut name = None;
    let mut cache_dir = None;
    let mut idle = None;
    let mut rest = None;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].to_string_lossy();
        match arg.as_ref() {
            "--name" => {
                index += 1;
                name = args.get(index).map(|value| value.to_string_lossy().into_owned());
            }
            "--cache-dir" => {
                index += 1;
                cache_dir = args.get(index).map(PathBuf::from);
            }
            "--idle-secs" => {
                index += 1;
                idle = args
                    .get(index)
                    .and_then(|value| value.to_string_lossy().parse::<u64>().ok());
            }
            "--" => {
                rest = Some(args[index + 1..].to_vec());
                break;
            }
            other => anyhow::bail!("unexpected lazy argument {other}"),
        }
        index += 1;
    }
    let Some(name) = name.filter(|value| !value.is_empty()) else {
        anyhow::bail!("lazy --name is required");
    };
    let Some(cache_dir) = cache_dir else {
        anyhow::bail!("lazy --cache-dir is required");
    };
    let Some(idle) = idle else {
        anyhow::bail!("lazy --idle-secs is required");
    };
    let Some(mut rest) = rest.filter(|rest| !rest.is_empty()) else {
        anyhow::bail!("lazy needs a command after --");
    };
    let command = rest.remove(0).to_string_lossy().into_owned();
    let args = rest
        .into_iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect();
    Ok(LazyOptions { name, cache_dir, idle: Duration::from_secs(idle), command, args })
}

/// Entry point for the `lazy` subcommand of `threadterm-v3-mcp`.
pub fn run_cli(args: &[OsString]) -> anyhow::Result<()> {
    let options = parse_options(args)?;
    run(options, std::io::stdin(), std::io::stdout())
}

/// In-process entry so tests drive the shim without the built binary.
pub fn run<R: Read, W: Write + Send + 'static>(
    options: LazyOptions,
    reader: R,
    writer: W,
) -> anyhow::Result<()> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let cache_path = cache_path(&options, &cwd);
    let cache = read_cache(&cache_path);
    let inner = Arc::new(Inner {
        options,
        cache_path,
        writer: Arc::new(Mutex::new(Box::new(writer))),
        lifecycle: Mutex::new(()),
        state: Mutex::new(State {
            cache,
            server: None,
            client_initialize: None,
            client_pending: HashMap::new(),
            server_requests: HashSet::new(),
            in_flight: 0,
            last_activity: Instant::now(),
            served_tools_from_cache: false,
            next_generation: 0,
            next_shim_id: 0,
            shim_waiters: HashMap::new(),
        }),
    });
    let done = Arc::new(AtomicBool::new(false));
    let monitor = {
        let inner = Arc::clone(&inner);
        let done = Arc::clone(&done);
        thread::Builder::new()
            .name("mcp-lazy-idle".into())
            .spawn(move || {
                while !done.load(Ordering::SeqCst) {
                    thread::sleep(IDLE_POLL);
                    stop_if_idle(&inner);
                }
            })?
    };
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let text = line.trim_end_matches(['\r', '\n']);
        if text.trim().is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(text) {
            Ok(message) => message,
            Err(_) => {
                write_client(
                    &inner,
                    &json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse_error"}}),
                );
                continue;
            }
        };
        handle_client(&inner, message);
    }
    done.store(true, Ordering::SeqCst);
    stop_current(&inner);
    let _ = monitor.join();
    Ok(())
}

struct Inner {
    options: LazyOptions,
    cache_path: PathBuf,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    lifecycle: Mutex<()>,
    state: Mutex<State>,
}

struct State {
    cache: Option<Cache>,
    server: Option<Server>,
    client_initialize: Option<Value>,
    client_pending: HashMap<String, Value>,
    server_requests: HashSet<String>,
    in_flight: usize,
    last_activity: Instant,
    served_tools_from_cache: bool,
    next_generation: u64,
    next_shim_id: u64,
    shim_waiters: HashMap<String, mpsc::Sender<Result<Value, String>>>,
}

struct Server {
    child: Child,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    job: Option<crate::job::SessionJob>,
    generation: u64,
    reader: Option<thread::JoinHandle<()>>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct Cache {
    initialize: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tools: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prompts: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resources: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resource_templates: Option<Value>,
}

enum ShimReply {
    Result(Value),
    Error(Value),
}

fn handle_client(inner: &Arc<Inner>, message: Value) {
    let method = message.get("method").and_then(Value::as_str).map(str::to_owned);
    let id = message.get("id").cloned();
    match (method.as_deref(), id) {
        (Some("initialize"), Some(id)) => {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            let cached = {
                let mut state = lock(&inner.state);
                state.client_initialize = Some(params);
                state.last_activity = Instant::now();
                if state.server.is_none() {
                    state.cache.clone()
                } else {
                    None
                }
            };
            if let Some(cache) = cached {
                write_client(inner, &ok(id, cache.initialize));
                return;
            }
            let _lifecycle = lock(&inner.lifecycle);
            match ensure_server_locked(inner) {
                Ok(Some(result)) => write_client(inner, &ok(id, result)),
                Ok(None) => {
                    forward_request(inner, &message);
                }
                Err(error) => write_error(inner, id, -32000, &error),
            }
        }
        (Some(method), Some(id)) if is_list(method) => {
            let cached = {
                let mut state = lock(&inner.state);
                state.last_activity = Instant::now();
                if state.server.is_none() {
                    state.cache.clone()
                } else {
                    None
                }
            };
            if let Some(cache) = cached {
                if method == "tools/list" {
                    lock(&inner.state).served_tools_from_cache = true;
                }
                write_client(inner, &ok(id, cached_list(&cache, method)));
            } else if let Err(error) = ensure_running(inner, &message, id.clone()) {
                write_error(inner, id, -32000, &error);
            }
        }
        (Some("ping"), Some(id)) => {
            let stopped_with_cache = {
                let mut state = lock(&inner.state);
                state.last_activity = Instant::now();
                state.server.is_none() && state.cache.is_some()
            };
            if stopped_with_cache {
                write_client(inner, &ok(id, json!({})));
            } else if let Err(error) = ensure_running(inner, &message, id.clone()) {
                write_error(inner, id, -32000, &error);
            }
        }
        (Some(_), Some(id)) => {
            if let Err(error) = ensure_running(inner, &message, id.clone()) {
                write_error(inner, id, -32000, &error);
            }
        }
        (Some("notifications/initialized"), None) => {
            // The shim sends its own initialized notification after every
            // start, so the client's copy is always swallowed.
            lock(&inner.state).last_activity = Instant::now();
        }
        (Some(_), None) => {
            let running = {
                let mut state = lock(&inner.state);
                state.last_activity = Instant::now();
                state.server.is_some()
            };
            if running {
                let _ = write_server(inner, &message);
            }
        }
        (None, Some(id)) => {
            let key = id_key(&id);
            let was_server_request = lock(&inner.state).server_requests.remove(&key);
            if was_server_request {
                let mut state = lock(&inner.state);
                state.in_flight = state.in_flight.saturating_sub(1);
                state.last_activity = Instant::now();
            }
            if lock(&inner.state).server.is_some() {
                let _ = write_server(inner, &message);
            }
        }
        (None, None) => {}
    }
}

/// Starts the server for a request that needs it, then forwards that request.
/// One lifecycle guard covers both, so an idle stop cannot take the server
/// away between the check and the write: once forwarded, the request counts
/// as in flight.
fn ensure_running(inner: &Arc<Inner>, message: &Value, _id: Value) -> Result<(), String> {
    let _lifecycle = lock(&inner.lifecycle);
    ensure_server_locked(inner)?;
    forward_request(inner, message);
    Ok(())
}

/// Returns the `initialize` result when this call started the server, `None`
/// when it was already running. The caller holds `inner.lifecycle`, so every
/// failure path below stops the server with `stop_server_locked`.
fn ensure_server_locked(inner: &Arc<Inner>) -> Result<Option<Value>, String> {
    if lock(&inner.state).server.is_some() {
        return Ok(None);
    }
    let initialize = lock(&inner.state)
        .client_initialize
        .clone()
        .ok_or_else(|| "client initialize was not received".to_owned())?;
    let generation = {
        let mut state = lock(&inner.state);
        state.next_generation += 1;
        state.next_generation
    };
    let spawned = spawn_server(inner, generation)?;
    let reader_inner = Arc::clone(inner);
    let stdout = spawned.stdout;
    {
        let mut state = lock(&inner.state);
        state.server = Some(Server {
            child: spawned.child,
            stdin: spawned.stdin,
            job: spawned.job,
            generation,
            reader: None,
        });
    }
    let reader = {
        let name = inner.options.name.clone();
        thread::Builder::new()
            .name(format!("mcp-lazy-server-{name}"))
            .spawn(move || server_reader(reader_inner, stdout, generation))
    };
    let reader = match reader {
        Ok(reader) => reader,
        Err(error) => {
            stop_server_locked(inner, generation);
            return Err(format!("starting the server reader: {error}"));
        }
    };
    if let Some(server) = lock(&inner.state).server.as_mut() {
        if server.generation == generation {
            server.reader = Some(reader);
        }
    }
    let result = (|| {
        let reply = shim_request(
            inner,
            "initialize",
            initialize,
            SERVER_START_TIMEOUT,
        )?;
        match reply {
            ShimReply::Result(result) => Ok(result),
            ShimReply::Error(error) => {
                Err(format!("MCP initialize failed: {}", error_text(&error)))
            }
        }
    })();
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            stop_server_locked(inner, generation);
            return Err(error);
        }
    };
    if let Err(error) = write_server(inner, &json!({"jsonrpc":"2.0","method":"notifications/initialized"})) {
        stop_server_locked(inner, generation);
        return Err(format!("completing the MCP handshake: {error}"));
    }
    match fetch_cache(inner, &result) {
        Ok(cache) => store_cache(inner, cache),
        Err(error) => {
            stop_server_locked(inner, generation);
            return Err(error);
        }
    }
    Ok(Some(result))
}

struct SpawnedServer {
    child: Child,
    stdout: ChildStdout,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    job: Option<crate::job::SessionJob>,
}

fn spawn_server(inner: &Arc<Inner>, _generation: u64) -> Result<SpawnedServer, String> {
    let program = crate::providers::common::find_executable(&inner.options.command)
        .ok_or_else(|| {
            format!(
                "{} executable was not found on PATH",
                inner.options.command
            )
        })?;
    let args = inner.options.args.clone();
    let mut command = command_for(&program, &args)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = command
        .spawn()
        .map_err(|error| format!("starting {}: {error}", program.display()))?;
    // The job's kill-on-close ends every descendant, including a browser.
    let job = match crate::job::SessionJob::assign(child.id()) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("assigning the MCP server process tree: {error:#}"));
        }
    };
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "MCP server stdin is unavailable".to_owned())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "MCP server stdout is unavailable".to_owned())?;
    Ok(SpawnedServer {
        child,
        stdout,
        stdin: Arc::new(Mutex::new(Some(stdin))),
        job: Some(job),
    })
}

fn command_for(program: &Path, args: &[String]) -> Result<Command, String> {
    #[cfg(windows)]
    if let Some(invocation) = crate::providers::common::windows_script_invocation(
        &program.to_string_lossy(),
        args,
    )
    .map_err(|error| error.to_string())?
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = Command::new(&invocation.program);
        command.args(&invocation.args);
        command.raw_arg(&invocation.raw_payload);
        command.creation_flags(CREATE_NO_WINDOW);
        return Ok(command);
    }
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(command)
}

fn server_reader(inner: Arc<Inner>, stdout: ChildStdout, generation: u64) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let text = line.trim_end_matches(['\r', '\n']);
        if text.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        handle_server_message(&inner, generation, message);
    }
    server_disconnected(&inner, generation);
}

fn handle_server_message(inner: &Arc<Inner>, _generation: u64, message: Value) {
    let id = message.get("id").cloned();
    let is_response = message.get("method").is_none() && id.is_some();
    if is_response {
        let key = id.as_ref().map(id_key);
        if id
            .as_ref()
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with(SHIM_ID_PREFIX))
        {
            if let Some(key) = key.as_ref() {
                let waiter = lock(&inner.state).shim_waiters.remove(key);
                if let Some(waiter) = waiter {
                    let _ = waiter.send(Ok(message));
                    return;
                }
            }
        }
        {
            let mut state = lock(&inner.state);
            if let Some(key) = key.as_ref() {
                state.client_pending.remove(key);
            }
            state.in_flight = state.in_flight.saturating_sub(1);
            state.last_activity = Instant::now();
        }
        write_client(inner, &message);
    } else {
        let has_id = id.is_some() && message.get("method").is_some();
        {
            let mut state = lock(&inner.state);
            if has_id {
                if let Some(key) = id.as_ref().map(id_key) {
                    state.server_requests.insert(key);
                }
                state.in_flight += 1;
            }
            state.last_activity = Instant::now();
        }
        write_client(inner, &message);
    }
}

fn server_disconnected(inner: &Arc<Inner>, generation: u64) {
    let (server, pending, waiters) = {
        let mut state = lock(&inner.state);
        if state.server.as_ref().map(|server| server.generation) != Some(generation) {
            // An intentional stop already took the server out.
            return;
        }
        let server = state.server.take();
        let pending = std::mem::take(&mut state.client_pending);
        let waiters = std::mem::take(&mut state.shim_waiters);
        state.server_requests.clear();
        state.in_flight = 0;
        (server, pending, waiters)
    };
    for (_, waiter) in waiters {
        let _ = waiter.send(Err("MCP server exited".to_owned()));
    }
    for (_, id) in pending {
        write_error(inner, id, -32000, "MCP server exited");
    }
    if let Some(mut server) = server {
        close_stdin(&server);
        server.job.take();
        let _ = server.child.wait();
    }
}

fn stop_if_idle(inner: &Arc<Inner>) {
    // Cheap check first; the lifecycle guard is only taken when a stop looks
    // due, and the check is repeated under it so a request forwarded in
    // between keeps its server and gets its answer.
    if idle_generation(inner).is_none() {
        return;
    }
    let _lifecycle = lock(&inner.lifecycle);
    if let Some(generation) = idle_generation(inner) {
        stop_server_locked(inner, generation);
    }
}

fn idle_generation(inner: &Arc<Inner>) -> Option<u64> {
    let state = lock(&inner.state);
    match state.server.as_ref() {
        Some(server)
            if state.in_flight == 0 && state.last_activity.elapsed() >= inner.options.idle =>
        {
            Some(server.generation)
        }
        _ => None,
    }
}

fn stop_current(inner: &Arc<Inner>) {
    let _lifecycle = lock(&inner.lifecycle);
    let server = lock(&inner.state).server.take();
    if let Some(server) = server {
        end_server(server, true);
    }
}

/// Stops the server of that generation. The caller holds `inner.lifecycle`.
fn stop_server_locked(inner: &Arc<Inner>, generation: u64) {
    let server = {
        let mut state = lock(&inner.state);
        if state.server.as_ref().map(|server| server.generation) == Some(generation) {
            state.server.take()
        } else {
            None
        }
    };
    if let Some(server) = server {
        end_server(server, true);
    }
}

fn end_server(mut server: Server, join_reader: bool) {
    close_stdin(&server);
    let deadline = Instant::now() + SERVER_STOP_GRACE;
    while Instant::now() < deadline {
        if server.child.try_wait().ok().flatten().is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    // Dropping the job ends the remaining tree even when the server ignored
    // its closed stdin. This includes a Playwright browser.
    server.job.take();
    let _ = server.child.kill();
    let _ = server.child.wait();
    if join_reader {
        if let Some(reader) = server.reader.take() {
            let _ = reader.join();
        }
    }
}

fn close_stdin(server: &Server) {
    if let Ok(mut stdin) = server.stdin.lock() {
        stdin.take();
    }
}

fn shim_request(
    inner: &Arc<Inner>,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<ShimReply, String> {
    let id = {
        let mut state = lock(&inner.state);
        state.next_shim_id += 1;
        format!("{SHIM_ID_PREFIX}{}", state.next_shim_id)
    };
    let key = id_key(&Value::String(id.clone()));
    let (sender, receiver) = mpsc::channel();
    {
        let mut state = lock(&inner.state);
        state.shim_waiters.insert(key.clone(), sender);
        state.in_flight += 1;
        state.last_activity = Instant::now();
    }
    let message = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    if let Err(error) = write_server(inner, &message) {
        let mut state = lock(&inner.state);
        state.shim_waiters.remove(&key);
        state.in_flight = state.in_flight.saturating_sub(1);
        return Err(error);
    }
    let reply = receiver.recv_timeout(timeout);
    {
        let mut state = lock(&inner.state);
        state.in_flight = state.in_flight.saturating_sub(1);
        state.last_activity = Instant::now();
    }
    match reply {
        Ok(Ok(message)) => Ok(match message.get("error") {
            Some(error) => ShimReply::Error(error.clone()),
            None => ShimReply::Result(message.get("result").cloned().unwrap_or(Value::Null)),
        }),
        Ok(Err(error)) => Err(error),
        Err(_) => {
            lock(&inner.state).shim_waiters.remove(&key);
            Err(format!("MCP {method} timed out"))
        }
    }
}

fn fetch_cache(inner: &Arc<Inner>, initialize: &Value) -> Result<Cache, String> {
    let capabilities = initialize.get("capabilities").cloned().unwrap_or(Value::Null);
    let mut cache = Cache {
        initialize: initialize.clone(),
        tools: None,
        prompts: None,
        resources: None,
        resource_templates: None,
    };
    cache.tools = fetch_list(inner, "tools/list")?;
    if capabilities.get("prompts").is_some() {
        cache.prompts = fetch_list(inner, "prompts/list")?;
    }
    if capabilities.get("resources").is_some() {
        cache.resources = fetch_list(inner, "resources/list")?;
        cache.resource_templates = fetch_list(inner, "resources/templates/list")?;
    }
    Ok(cache)
}

fn fetch_list(inner: &Arc<Inner>, method: &str) -> Result<Option<Value>, String> {
    let mut result = match shim_request(inner, method, json!({}), SERVER_LIST_TIMEOUT)? {
        ShimReply::Result(result) => result,
        ShimReply::Error(error) => {
            if error.get("code").and_then(Value::as_i64) == Some(-32601) {
                return Ok(None);
            }
            return Err(format!("MCP {method} failed: {}", error_text(&error)));
        }
    };
    let key = list_key(method);
    let mut combined = Vec::new();
    if let Some(items) = result.get(key).and_then(Value::as_array) {
        combined.extend(items.iter().cloned());
    }
    while let Some(cursor) = result
        .get("nextCursor")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        let page = match shim_request(
            inner,
            method,
            json!({"cursor":cursor}),
            SERVER_LIST_TIMEOUT,
        )? {
            ShimReply::Result(page) => page,
            ShimReply::Error(error) => {
                return Err(format!("MCP {method} failed: {}", error_text(&error)));
            }
        };
        if let Some(items) = page.get(key).and_then(Value::as_array) {
            combined.extend(items.iter().cloned());
        }
        result = page;
    }
    if let Some(object) = result.as_object_mut() {
        object.remove("nextCursor");
        object.insert(key.to_owned(), Value::Array(combined));
    }
    Ok(Some(result))
}

fn store_cache(inner: &Arc<Inner>, new: Cache) {
    let (old, served) = {
        let state = lock(&inner.state);
        (state.cache.clone(), state.served_tools_from_cache)
    };
    let old_tools = old.as_ref().and_then(|cache| cache.tools.clone());
    let changed = old.as_ref() != Some(&new);
    let mut stored = false;
    if changed {
        if let Ok(bytes) = serde_json::to_vec(&new) {
            if bytes.len() <= CACHE_LIMIT {
                let _ = write_cache(&inner.cache_path, &bytes);
                stored = true;
            }
        }
    } else {
        stored = true;
    }
    {
        let mut state = lock(&inner.state);
        if stored {
            state.cache = Some(new.clone());
        }
        state.served_tools_from_cache = false;
    }
    if served && old_tools != new.tools {
        write_client(
            inner,
            &json!({"jsonrpc":"2.0","method":"notifications/tools/list_changed"}),
        );
    }
}

fn write_cache(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let written = fs::write(&temporary, bytes).and_then(|_| fs::rename(&temporary, path));
    if written.is_err() {
        // Another shim may hold the file open; never leave the temporary behind.
        let _ = fs::remove_file(&temporary);
    }
    written
}

fn read_cache(path: &Path) -> Option<Cache> {
    let text = fs::read_to_string(path).ok()?;
    if text.len() > CACHE_LIMIT {
        return None;
    }
    let cache: Cache = serde_json::from_str(&text).ok()?;
    cache.initialize.is_object().then_some(cache)
}

fn cache_path(options: &LazyOptions, cwd: &Path) -> PathBuf {
    let identity = json!([
        options.name,
        options.command,
        options.args,
        cwd.to_string_lossy(),
    ]);
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&identity).unwrap_or_default());
    let hash = hex::encode(hasher.finalize());
    let name = options
        .name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    options.cache_dir.join(format!("{name}-{hash}.json"))
}

fn is_list(method: &str) -> bool {
    matches!(
        method,
        "tools/list" | "prompts/list" | "resources/list" | "resources/templates/list"
    )
}

fn list_key(method: &str) -> &'static str {
    match method {
        "tools/list" => "tools",
        "prompts/list" => "prompts",
        "resources/list" => "resources",
        _ => "resourceTemplates",
    }
}

fn cached_list(cache: &Cache, method: &str) -> Value {
    match method {
        "tools/list" => cache.tools.clone().unwrap_or_else(|| json!({"tools":[]})),
        "prompts/list" => cache.prompts.clone().unwrap_or_else(|| json!({"prompts":[]})),
        "resources/list" => cache
            .resources
            .clone()
            .unwrap_or_else(|| json!({"resources":[]})),
        "resources/templates/list" => cache
            .resource_templates
            .clone()
            .unwrap_or_else(|| json!({"resourceTemplates":[]})),
        _ => json!({}),
    }
}

fn forward_request(inner: &Arc<Inner>, message: &Value) -> bool {
    let Some(id) = message.get("id").cloned() else {
        return false;
    };
    let key = id_key(&id);
    {
        let mut state = lock(&inner.state);
        state.client_pending.insert(key.clone(), id.clone());
        state.in_flight += 1;
        state.last_activity = Instant::now();
    }
    if let Err(error) = write_server(inner, message) {
        {
            let mut state = lock(&inner.state);
            state.client_pending.remove(&key);
            state.in_flight = state.in_flight.saturating_sub(1);
        }
        write_error(inner, id, -32000, &error);
        return false;
    }
    true
}

fn write_server(inner: &Arc<Inner>, message: &Value) -> Result<(), String> {
    let stdin = lock(&inner.state)
        .server
        .as_ref()
        .map(|server| Arc::clone(&server.stdin))
        .ok_or_else(|| "MCP server is not running".to_owned())?;
    let mut guard = lock(&stdin);
    let Some(writer) = guard.as_mut() else {
        return Err("MCP server stdin is closed".to_owned());
    };
    serde_json::to_writer(&mut *writer, message).map_err(|error| error.to_string())?;
    writer
        .write_all(b"\n")
        .and_then(|_| writer.flush())
        .map_err(|error| error.to_string())
}

fn write_client(inner: &Arc<Inner>, message: &Value) {
    let mut writer = lock(&inner.writer);
    let _ = serde_json::to_writer(&mut **writer, message);
    let _ = writer.write_all(b"\n");
    let _ = writer.flush();
}

fn ok(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

fn write_error(inner: &Arc<Inner>, id: Value, code: i64, message: &str) {
    write_client(
        inner,
        &json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}),
    );
}

fn error_text(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| error.to_string())
}

fn id_key(id: &Value) -> String {
    serde_json::to_string(id).unwrap_or_else(|_| "null".to_owned())
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}



#[cfg(test)]
mod tests {
    use super::*;
    use std::io::pipe;
    use std::sync::mpsc::{channel, Receiver};

    const FAKE_SERVER: &str = r##"
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const opt = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const log = opt('--log');
const pidFile = opt('--pidfile');
const toolsFile = opt('--tools-file');
const failInitFile = opt('--fail-init-file');
const staticTools = (opt('--tools') || 'echo,slow,crash,ask').split(',').filter(Boolean);
const record = (event, extra = {}) => { if (log) appendFileSync(log, JSON.stringify({ event, ...extra }) + '\n'); };
record('start', { pid: process.pid, argv: args });
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
if (pidFile) writeFileSync(pidFile, `${process.pid},${grandchild.pid}`);
const tools = () => {
  let names = staticTools;
  if (toolsFile) {
    try { names = readFileSync(toolsFile, 'utf8').split(',').map(name => name.trim()).filter(Boolean); } catch {}
  }
  return names.map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
};
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let askId = 0;
const pendingAsk = new Map();
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  record('request', { message });
  if (message.id !== undefined && message.method === undefined) {
    const done = pendingAsk.get(message.id);
    if (done) { pendingAsk.delete(message.id); done(message); }
    return;
  }
  const id = message.id;
  const method = message.method;
  if (method === 'initialize') {
    let failMode = '';
    if (failInitFile) { try { failMode = readFileSync(failInitFile, 'utf8').trim(); } catch {} }
    if (failMode === 'exit') process.exit(3);
    if (failMode === 'error') return send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'initialize refused' } });
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake-mcp', version: '0' }, instructions: 'fake instructions' } });
  } else if (method === 'notifications/initialized') {
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: tools() } });
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else if (method === 'tools/call') {
    const name = message.params?.name;
    const toolArgs = message.params?.arguments || {};
    if (name === 'crash') { process.exit(1); }
    if (name === 'slow') {
      setTimeout(() => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'slow' }] } }), Number(toolArgs.ms || 2000));
      return;
    }
    if (name === 'ask') {
      const ask = `ask-${++askId}`;
      pendingAsk.set(ask, reply => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(reply.result ?? reply.error ?? null) }] } }));
      send({ jsonrpc: '2.0', id: ask, method: 'roots/list', params: {} });
      return;
    }
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(toolArgs) }] } });
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }
});
"##;

    struct Fixture {
        dir: tempfile::TempDir,
        node: PathBuf,
        log: PathBuf,
        pidfile: PathBuf,
        tools_file: PathBuf,
        cache_dir: PathBuf,
    }

    impl Fixture {
        fn new(tools: &str) -> Option<Self> {
            let node = crate::providers::common::find_executable("node")?;
            let dir = tempfile::tempdir().unwrap();
            let script = dir.path().join("fake-mcp.mjs");
            fs::write(&script, FAKE_SERVER).unwrap();
            let log = dir.path().join("server.log");
            let pidfile = dir.path().join("server.pid");
            let tools_file = dir.path().join("tools.txt");
            fs::write(&tools_file, tools).unwrap();
            let cache_dir = dir.path().join("cache");
            Some(Self {
                dir,
                node,
                log,
                pidfile,
                tools_file,
                cache_dir,
            })
        }

        fn options(&self, idle_secs: u64) -> LazyOptions {
            let script = self.dir.path().join("fake-mcp.mjs");
            LazyOptions {
                name: "fake".to_owned(),
                cache_dir: self.cache_dir.clone(),
                idle: Duration::from_secs(idle_secs),
                command: self.node.to_string_lossy().into_owned(),
                args: vec![
                    script.to_string_lossy().into_owned(),
                    "--log".to_owned(),
                    self.log.to_string_lossy().into_owned(),
                    "--pidfile".to_owned(),
                    self.pidfile.to_string_lossy().into_owned(),
                    "--tools-file".to_owned(),
                    self.tools_file.to_string_lossy().into_owned(),
                    "--tools".to_owned(),
                    "echo,slow,crash,ask".to_owned(),
                    "--fail-init-file".to_owned(),
                    self.dir.path().join("fail-init.txt").to_string_lossy().into_owned(),
                ],
            }
        }

        fn starts(&self) -> usize {
            self.log_lines()
                .into_iter()
                .filter(|line| line["event"] == "start")
                .count()
        }

        fn requests(&self) -> Vec<Value> {
            self.log_lines()
                .into_iter()
                .filter_map(|line| line.get("message").cloned())
                .collect()
        }

        fn log_lines(&self) -> Vec<Value> {
            fs::read_to_string(&self.log)
                .unwrap_or_default()
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect()
        }

        fn server_pids(&self) -> Vec<u32> {
            fs::read_to_string(&self.pidfile)
                .unwrap_or_default()
                .trim()
                .split(',')
                .filter_map(|value| value.parse().ok())
                .collect()
        }

        fn cache_files(&self) -> Vec<PathBuf> {
            fs::read_dir(&self.cache_dir)
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .map(|entry| entry.path())
                        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
                        .collect()
                })
                .unwrap_or_default()
        }
    }

    struct Driver {
        writer: Option<std::io::PipeWriter>,
        receiver: Receiver<Value>,
        done: Receiver<anyhow::Result<()>>,
        shim: Option<thread::JoinHandle<()>>,
        notifications: Vec<Value>,
        next_id: u64,
    }

    impl Driver {
        fn start(options: LazyOptions) -> Self {
            let (shim_reader, client_writer) = pipe().unwrap();
            let (client_reader, shim_writer) = pipe().unwrap();
            let (done_sender, done) = channel();
            let shim = thread::spawn(move || {
                let result = run(options, shim_reader, shim_writer);
                let _ = done_sender.send(result);
            });
            let (sender, receiver) = channel();
            thread::spawn(move || {
                let mut reader = BufReader::new(client_reader);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    let text = line.trim_end_matches(['\r', '\n']);
                    if let Ok(message) = serde_json::from_str::<Value>(text) {
                        if sender.send(message).is_err() {
                            break;
                        }
                    }
                }
            });
            Self {
                writer: Some(client_writer),
                receiver,
                done,
                shim: Some(shim),
                notifications: Vec::new(),
                next_id: 1,
            }
        }

        fn initialize(&mut self, client: &str) -> (Value, Value) {
            let params = json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": client, "version": "0"}
            });
            let reply = self.request_with("initialize", params.clone(), None);
            self.notify("notifications/initialized", None);
            (reply, params)
        }

        fn request(&mut self, method: &str, params: Value) -> Value {
            self.request_with(method, params, None)
        }

        fn request_with_roots(&mut self, method: &str, params: Value, roots: Value) -> Value {
            self.request_with(method, params, Some(roots))
        }

        fn request_with(&mut self, method: &str, params: Value, roots: Option<Value>) -> Value {
            let id = self.next_id;
            self.next_id += 1;
            let message = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
            self.write(&message);
            let deadline = Instant::now() + Duration::from_secs(60);
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                assert!(!remaining.is_zero(), "{method} response timed out");
                let received = self.receiver.recv_timeout(remaining).expect("shim closed");
                if let Some(roots) = roots.as_ref() {
                    if received.get("method").is_some() && received.get("id").is_some() {
                        self.write(&json!({
                            "jsonrpc":"2.0",
                            "id": received["id"].clone(),
                            "result": roots.clone()
                        }));
                        continue;
                    }
                }
                if received.get("id") == Some(&json!(id)) && received.get("method").is_none() {
                    return received;
                }
                self.notifications.push(received);
            }
        }

        fn notify(&mut self, method: &str, params: Option<Value>) {
            let mut message = json!({"jsonrpc":"2.0","method":method});
            if let Some(params) = params {
                message["params"] = params;
            }
            self.write(&message);
        }

        fn write(&mut self, message: &Value) {
            let writer = self.writer.as_mut().expect("driver already closed");
            writer
                .write_all(format!("{message}\n").as_bytes())
                .unwrap();
            writer.flush().unwrap();
        }

        fn wait_notification(&mut self, method: &str) {
            if self.notifications.iter().any(|message| message["method"] == method) {
                return;
            }
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                assert!(!remaining.is_zero(), "{method} notification timed out");
                let received = self.receiver.recv_timeout(remaining).expect("shim closed");
                if received["method"] == method {
                    self.notifications.push(received);
                    return;
                }
                self.notifications.push(received);
            }
        }

        fn close(mut self) -> anyhow::Result<()> {
            self.writer.take();
            let result = self
                .done
                .recv_timeout(Duration::from_secs(20))
                .expect("shim did not exit after client EOF");
            if let Some(shim) = self.shim.take() {
                shim.join().unwrap();
            }
            result
        }
    }

    fn warm(fixture: &Fixture) -> usize {
        let mut driver = Driver::start(fixture.options(30));
        let (init, _) = driver.initialize("first-client");
        assert_eq!(init["result"]["serverInfo"]["name"], "fake-mcp");
        let tools = driver.request("tools/list", json!({}));
        assert_eq!(tools["result"]["tools"][0]["name"], "echo");
        let call = driver.request("tools/call", json!({"name":"echo","arguments":{"x":1}}));
        assert!(call["result"]["content"][0]["text"].as_str().unwrap().contains("\"x\":1"));
        driver.close().unwrap();
        fixture.starts()
    }

    #[cfg(windows)]
    fn pid_alive(pid: u32) -> bool {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{OpenProcess, WaitForSingleObject},
        };
        const SYNCHRONIZE: u32 = 0x0010_0000;
        unsafe {
            let handle = OpenProcess(SYNCHRONIZE, 0, pid);
            if handle.is_null() {
                return false;
            }
            let active = WaitForSingleObject(handle, 0) != 0;
            CloseHandle(handle);
            active
        }
    }

    #[cfg(not(windows))]
    fn pid_alive(_pid: u32) -> bool {
        false
    }

    fn wait_until_gone(pids: &[u32]) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while pids.iter().any(|pid| pid_alive(*pid)) {
            assert!(Instant::now() < deadline, "server tree is still alive: {pids:?}");
            thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    fn lazy_command_line_is_parsed() {
        let args = ["--name", "playwright", "--cache-dir", "D:/tmp/cache", "--idle-secs", "600", "--", "npx", "-y", "@playwright/mcp"]
            .into_iter()
            .map(OsString::from)
            .collect::<Vec<_>>();
        let options = parse_options(&args).unwrap();
        assert_eq!(options.name, "playwright");
        assert_eq!(options.cache_dir, PathBuf::from("D:/tmp/cache"));
        assert_eq!(options.idle, Duration::from_secs(600));
        assert_eq!(options.command, "npx");
        assert_eq!(options.args, ["-y", "@playwright/mcp"]);
    }

    #[test]
    fn cached_handshake_is_answered_without_starting_the_server() {
        let Some(fixture) = Fixture::new("echo") else {
            eprintln!("node is unavailable; skipping lazy shim fixture");
            return;
        };
        let starts = warm(&fixture);
        assert_eq!(starts, 1);
        let cache = std::fs::read_to_string(fixture.cache_files()[0].clone()).unwrap();
        assert!(cache.contains("fake-mcp"));

        let mut driver = Driver::start(fixture.options(30));
        let (init, _) = driver.initialize("second-client");
        assert_eq!(init["result"]["serverInfo"]["name"], "fake-mcp");
        let tools = driver.request("tools/list", json!({}));
        assert_eq!(tools["result"]["tools"][0]["name"], "echo");
        let ping = driver.request("ping", json!({}));
        assert_eq!(ping["result"], json!({}));
        thread::sleep(Duration::from_millis(500));
        assert_eq!(fixture.starts(), starts);
        driver.close().unwrap();
    }

    #[test]
    fn cold_initialize_starts_the_server_and_writes_the_cache() {
        let Some(fixture) = Fixture::new("echo") else {
            eprintln!("node is unavailable; skipping lazy shim fixture");
            return;
        };
        assert!(fixture.cache_files().is_empty());
        let mut driver = Driver::start(fixture.options(30));
        let (init, _) = driver.initialize("cold-client");
        assert_eq!(init["result"]["serverInfo"]["name"], "fake-mcp");
        assert_eq!(fixture.starts(), 1);
        assert_eq!(fixture.cache_files().len(), 1);
        assert!(fixture.pidfile.exists());
        driver.close().unwrap();
    }

    #[test]
    fn first_call_starts_the_server_with_the_clients_initialize_params() {
        let Some(fixture) = Fixture::new("echo") else {
            eprintln!("node is unavailable; skipping lazy shim fixture");
            return;
        };
        let starts = warm(&fixture);
        let mut driver = Driver::start(fixture.options(30));
        let (init, params) = driver.initialize("second-client");
        assert_eq!(init["result"]["serverInfo"]["name"], "fake-mcp");
        driver.request("tools/list", json!({}));
        assert_eq!(fixture.starts(), starts);
        let call = driver.request("tools/call", json!({"name":"echo","arguments":{"after":"idle"}}));
        assert!(call["result"]["content"][0]["text"].as_str().unwrap().contains("\"after\":\"idle\""));
        assert_eq!(fixture.starts(), starts + 1);
        let initialize = fixture
            .requests()
            .into_iter()
            .filter(|message| message["method"] == "initialize")
            .last()
            .unwrap();
        assert_eq!(initialize["params"], params);
        driver.close().unwrap();
    }

    #[test]
    fn changed_tools_rewrite_the_cache_and_notify_list_changed() {
        let Some(fixture) = Fixture::new("echo") else {
            eprintln!("node is unavailable; skipping lazy shim fixture");
            return;
        };
        warm(&fixture);
        fs::write(&fixture.tools_file, "echo,slow").unwrap();
        let mut driver = Driver::start(fixture.options(30));
        driver.initialize("second-client");
        let cached = driver.request("tools/list", json!({}));
        assert_eq!(cached["result"]["tools"].as_array().unwrap().len(), 1);
        let call = driver.request("tools/call", json!({"name":"echo","arguments":{}}));
        assert!(call["result"].is_object());
        driver.wait_notification("notifications/tools/list_changed");
        let files = fixture.cache_files();
        assert_eq!(files.len(), 1);
        let cache: Value = serde_json::from_str(&fs::read_to_string(&files[0]).unwrap()).unwrap();
        let names = cache["tools"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, ["echo", "slow"]);
        driver.close().unwrap();
    }

    #[test]
    fn idle_stop_ends_server_tree_and_next_call_restarts() {
        let Some(fixture) = Fixture::new("echo") else {
            eprintln!("node is unavailable; skipping lazy shim fixture");
            return;
        };
        let mut driver = Driver::start(fixture.options(1));
        driver.initialize("idle-client");
        assert_eq!(fixture.starts(), 1);
        let deadline = Instant::now() + Duration::from_secs(10);
        while fixture.server_pids().len() < 2 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        let pids = fixture.server_pids();
        assert_eq!(pids.len(), 2);
        wait_until_gone(&pids);
        // The shim is still alive and answers from the cache.
        let ping = driver.request("ping", json!({}));
        assert_eq!(ping["result"], json!({}));
        let call = driver.request("tools/call", json!({"name":"echo","arguments":{"again":true}}));
        assert!(call["result"]["content"][0]["text"].as_str().unwrap().contains("again"));
        assert_eq!(fixture.starts(), 2);
        driver.close().unwrap();
    }

    #[test]
    fn slow_call_longer_than_idle_is_not_cut_off() {
        let Some(fixture) = Fixture::new("echo,slow") else {
            eprintln!("node is unavailable; skipping lazy shim fixture");
            return;
        };
        let mut driver = Driver::start(fixture.options(1));
        driver.initialize("slow-client");
        let started = Instant::now();
        let call = driver.request("tools/call", json!({"name":"slow","arguments":{"ms":2500}}));
        assert_eq!(call["result"]["content"][0]["text"], "slow");
        assert!(started.elapsed() >= Duration::from_millis(2300));
        assert_eq!(fixture.starts(), 1);
        driver.close().unwrap();
    }

    #[test]
    fn server_request_round_trip_through_shim() {
        let Some(fixture) = Fixture::new("echo,ask") else {
            eprintln!("node is unavailable; skipping lazy shim fixture");
            return;
        };
        let mut driver = Driver::start(fixture.options(30));
        driver.initialize("ask-client");
        let roots = json!({"roots":[{"uri":"file:///D:/repo","name":"repo"}]});
        let call = driver.request_with_roots(
            "tools/call",
            json!({"name":"ask","arguments":{}}),
            roots.clone(),
        );
        let text = call["result"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(serde_json::from_str::<Value>(text).unwrap(), roots);
        driver.close().unwrap();
    }

    #[test]
    fn crash_errors_in_flight_call_and_next_call_restarts() {
        let Some(fixture) = Fixture::new("echo,crash") else {
            eprintln!("node is unavailable; skipping lazy shim fixture");
            return;
        };
        let mut driver = Driver::start(fixture.options(30));
        driver.initialize("crash-client");
        let crashed = driver.request("tools/call", json!({"name":"crash","arguments":{}}));
        assert!(crashed.get("error").is_some(), "{crashed}");
        let call = driver.request("tools/call", json!({"name":"echo","arguments":{"after":"crash"}}));
        assert!(call["result"]["content"][0]["text"].as_str().unwrap().contains("crash"));
        assert_eq!(fixture.starts(), 2);
        driver.close().unwrap();
    }

    /// A server that dies or refuses `initialize` must answer the call that
    /// started it with an error, and leave the shim able to start it again.
    #[test]
    fn failed_start_answers_the_call_and_the_next_call_retries() {
        let Some(fixture) = Fixture::new("echo") else {
            eprintln!("node is unavailable; skipping lazy shim fixture");
            return;
        };
        let starts = warm(&fixture);
        let fail = fixture.dir.path().join("fail-init.txt");
        let mut driver = Driver::start(fixture.options(30));
        driver.initialize("retry-client");
        for mode in ["exit", "error"] {
            fs::write(&fail, mode).unwrap();
            let failed = driver.request("tools/call", json!({"name":"echo","arguments":{"mode":mode}}));
            assert!(failed.get("error").is_some(), "{mode}: {failed}");
        }
        fs::remove_file(&fail).unwrap();
        let call = driver.request("tools/call", json!({"name":"echo","arguments":{"after":"retry"}}));
        assert!(call["result"]["content"][0]["text"].as_str().unwrap().contains("retry"), "{call}");
        assert_eq!(fixture.starts(), starts + 3);
        driver.close().unwrap();
    }

    #[test]
    fn client_eof_ends_server_tree_and_shim() {
        let Some(fixture) = Fixture::new("echo") else {
            eprintln!("node is unavailable; skipping lazy shim fixture");
            return;
        };
        let mut driver = Driver::start(fixture.options(30));
        driver.initialize("eof-client");
        let deadline = Instant::now() + Duration::from_secs(10);
        while fixture.server_pids().len() < 2 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        let pids = fixture.server_pids();
        assert_eq!(pids.len(), 2);
        driver.close().unwrap();
        wait_until_gone(&pids);
    }

    #[test]
    fn corrupt_cache_is_a_miss() {
        let Some(fixture) = Fixture::new("echo") else {
            eprintln!("node is unavailable; skipping lazy shim fixture");
            return;
        };
        let starts = warm(&fixture);
        let file = fixture.cache_files()[0].clone();
        fs::write(&file, "this is not a cache").unwrap();
        let mut driver = Driver::start(fixture.options(30));
        let (init, _) = driver.initialize("corrupt-client");
        assert_eq!(init["result"]["serverInfo"]["name"], "fake-mcp");
        assert_eq!(fixture.starts(), starts + 1);
        driver.close().unwrap();
    }
}
