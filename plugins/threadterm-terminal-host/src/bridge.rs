use std::{
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
};

use serde_json::{json, Value};
use terminal_host_protocol::{
    ClientClass, CloseMode, EmptyRequest, EnvelopeKind, EventEnvelope, HelloRequest, Method,
    Placement, Presentation, ProtocolRange, RequestEnvelope, ResponseEnvelope, SessionCloseRequest,
    SessionCreateRequest, SessionCreateResponse, SessionGetRequest, SessionListRequest,
    SessionPresentRequest, SessionRecord, SessionSelector, MAX_ARGUMENTS, MAX_COMMAND_BYTES,
    MAX_TITLE_BYTES, PROTOCOL_VERSION, REQUEST_ID_MAX_BYTES, SESSION_HANDLE_MAX_BYTES,
};
use threadterm_terminal_host::bootstrap::{read_endpoint, BootstrapPaths, Secret};
use threadterm_terminal_host::service::{HealthResult, HelloAck};

const MAX_FRAME: usize = 8 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_PROFILE_FILE_BYTES: u64 = 64 * 1024;

pub fn tools() -> Vec<Value> {
    vec![
        tool(
            "terminal_host_status",
            "Report whether the already-running ThreadTerm terminal host is available.",
            schema(json!({"type":"object","additionalProperties":false})),
        ),
        tool(
            "terminal_create",
            "Create a direct executable terminal in an existing absolute directory.",
            schema(
                json!({"type":"object","additionalProperties":false,"required":["request_id","launch","placement"],"properties":{"request_id":{"type":"string","minLength":1,"maxLength":512},"launch":{"type":"object","additionalProperties":false,"required":["executable","args","cwd"],"properties":{"executable":{"type":"string","minLength":1,"maxLength":32768},"args":{"type":"array","maxItems":256,"items":{"type":"string","maxLength":32768}},"cwd":{"type":"string","minLength":1,"maxLength":32768}}},"placement":{"type":"string","enum":["workspace","window"]},"title":{"type":"string","maxLength":1024},"workspace_path":{"type":"string","minLength":1,"maxLength":32768},"presentation":{"type":"string","enum":["background","focused"]},"exit_behavior":{"type":"string","enum":["keep","close-on-success","close-on-exit"]}}}),
            ),
        ),
        tool(
            "terminal_get",
            "Get one terminal by exactly one selector.",
            schema(
                json!({"type":"object","additionalProperties":false,"properties":{"handle":{"type":"string","minLength":1,"maxLength":128},"request_id":{"type":"string","minLength":1,"maxLength":512}},"oneOf":[{"required":["handle"]},{"required":["request_id"]}]}),
            ),
        ),
        tool(
            "terminal_list",
            "List terminals, optionally filtered by state.",
            schema(
                json!({"type":"object","additionalProperties":false,"properties":{"state":{"enum":["creating","running","exited","closing","closed","lost"]}}}),
            ),
        ),
        tool(
            "terminal_present",
            "Present an existing terminal.",
            schema(
                json!({"type":"object","additionalProperties":false,"required":["handle","placement"],"properties":{"handle":{"type":"string","minLength":1,"maxLength":128},"placement":{"type":"string","enum":["workspace","window"]},"workspace_path":{"type":"string","minLength":1,"maxLength":32768},"presentation":{"type":"string","enum":["background","focused"]}}}),
            ),
        ),
        tool(
            "terminal_close",
            "Close a terminal gracefully by default.",
            schema(
                json!({"type":"object","additionalProperties":false,"required":["handle"],"properties":{"handle":{"type":"string","minLength":1,"maxLength":128},"mode":{"type":"string","enum":["graceful","force"]}}}),
            ),
        ),
    ]
}
fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({"name":name,"description":description,"inputSchema":input_schema})
}
fn schema(value: Value) -> Value {
    value
}

pub async fn call(params: Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let result = match name {
        "terminal_host_status" => status().await,
        "terminal_create" => create(arguments).await,
        "terminal_get" => get(arguments).await,
        "terminal_list" => list(arguments).await,
        "terminal_present" => present(arguments).await,
        "terminal_close" => close(arguments).await,
        _ => Err(typed(
            "invalid_request",
            "unknown tool",
            "no_effect",
            None,
            None,
            false,
        )),
    };
    match result {
        Ok(value) => content(value, false),
        Err(error) => content(error, true),
    }
}
fn content(value: Value, is_error: bool) -> Value {
    json!({"content":[{"type":"text","text":serde_json::to_string(&value).unwrap_or_else(|_| "{\"code\":\"internal_error\"}".into())}],"structuredContent":value,"isError":is_error})
}
fn typed(
    code: &str,
    message: &str,
    effect: &str,
    request_id: Option<String>,
    handle: Option<String>,
    retryable: bool,
) -> Value {
    json!({"code":code,"message":message,"effect":effect,"request_id":request_id,"handle":handle,"retryable":retryable})
}

async fn status() -> Result<Value, Value> {
    #[cfg(not(windows))]
    {
        return Ok(
            json!({"platform":"unsupported","runtime_state":"unavailable","desktop_available":false,"contract_versions":[],"capabilities":[]}),
        );
    }
    #[cfg(windows)]
    {
        let client = Client::connect().await;
        match client {
            Ok(mut client) => match client.request(Method::Health, EmptyRequest {}).await {
                Ok(value) => {
                    let health: HealthResult =
                        serde_json::from_value(value).map_err(|_| unavailable())?;
                    if health.runtime_id != client.runtime_id {
                        return Ok(unavailable());
                    }
                    Ok(
                        json!({"platform":"windows","runtime_state":"available","desktop_available":health.desktop_available,"runtime_id":client.runtime_id,"protocol_version":client.version.major,"contract_versions":if launch_supported(&client.capabilities){vec!["terminal-launch/v1"]}else{Vec::new()},"capabilities":public_capabilities(&client.capabilities)}),
                    )
                }
                Err(_) => Ok(unavailable()),
            },
            Err(ClientError::UpgradeDeferred) => Ok(
                json!({"platform":"windows","runtime_state":"upgrade_deferred","desktop_available":false,"contract_versions":[],"capabilities":[]}),
            ),
            Err(_) => Ok(unavailable()),
        }
    }
}
fn unavailable() -> Value {
    json!({"platform":"windows","runtime_state":"unavailable","desktop_available":false,"contract_versions":[],"capabilities":[]})
}
fn launch_supported(capabilities: &[String]) -> bool {
    [
        "session.create",
        "session.get",
        "session.present",
        "session.close",
    ]
    .iter()
    .all(|required| capabilities.iter().any(|candidate| candidate == required))
}
fn public_capabilities(capabilities: &[String]) -> Vec<&'static str> {
    if launch_supported(capabilities) {
        vec![
            "terminal.create",
            "terminal.get-by-request-id",
            "terminal.present",
            "terminal.close-by-handle",
            "presentation.window.background",
            "exit.close-on-exit",
        ]
    } else {
        Vec::new()
    }
}

async fn create(args: Value) -> Result<Value, Value> {
    object_keys(
        &args,
        &[
            "request_id",
            "launch",
            "placement",
            "title",
            "workspace_path",
            "presentation",
            "exit_behavior",
        ],
    )?;
    let request_id = required(&args, "request_id")?;
    bounded(&request_id, REQUEST_ID_MAX_BYTES)?;
    let launch = args.get("launch").ok_or_else(invalid)?.clone();
    object_keys(&launch, &["executable", "args", "cwd"])?;
    let executable = required(&launch, "executable")?;
    bounded(&executable, MAX_COMMAND_BYTES)?;
    let cwd = canonical_existing_absolute(&required(&launch, "cwd")?)?;
    let workspace = args
        .get("workspace_path")
        .and_then(Value::as_str)
        .map(canonical_existing_absolute)
        .transpose()?;
    let placement = placement(&required(&args, "placement")?)?;
    if (matches!(placement, Placement::Window) && workspace.is_some())
        || workspace.as_deref().is_some_and(|path| path != cwd)
    {
        return Err(invalid());
    }
    let arguments = launch
        .get("args")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or_else(invalid))
        .collect::<Result<Vec<_>, _>>()?;
    if arguments.len() > MAX_ARGUMENTS || arguments.iter().any(|arg| arg.len() > MAX_COMMAND_BYTES)
    {
        return Err(invalid());
    }
    let title = match args.get("title") {
        Some(value) => Some(value.as_str().ok_or_else(invalid)?),
        None => None,
    };
    if title.is_some_and(|title| title.len() > MAX_TITLE_BYTES) {
        return Err(invalid());
    }
    let request = SessionCreateRequest {
        request_id: request_id.clone(),
        executable,
        args: arguments,
        cwd,
        title: title.and_then(|title| (!title.trim().is_empty()).then(|| title.to_owned())),
        placement,
        presentation: presentation(&args)?,
        exit_behavior: exit_behavior(&args)?,
        rows: 24,
        cols: 80,
    };
    let mut client = Client::connect().await.map_err(|error| {
        if matches!(error, ClientError::UpgradeDeferred) {
            return typed(
                "incompatible_runtime",
                "ThreadTerm runtime upgrade is deferred",
                "no_effect",
                Some(request_id.clone()),
                None,
                true,
            );
        }
        typed(
            "app_unavailable",
            "ThreadTerm terminal host is not running",
            "no_effect",
            Some(request_id.clone()),
            None,
            true,
        )
    })?;
    match client.request(Method::SessionCreate, request).await {
        Ok(value) => serde_json::from_value(value)
            .map(public_create)
            .map_err(|_| {
                typed(
                    "internal_error",
                    "daemon returned the wrong result type",
                    "outcome_unknown",
                    Some(request_id),
                    None,
                    true,
                )
            }),
        Err(ClientError::Daemon(error)) => Err(map_daemon(error)),
        Err(_) => Err(typed(
            "internal_error",
            "create outcome is unknown; retry the same request_id",
            "outcome_unknown",
            Some(request_id),
            None,
            true,
        )),
    }
}
async fn get(args: Value) -> Result<Value, Value> {
    object_keys(&args, &["handle", "request_id"])?;
    let selector = selector(&args)?;
    let mut c = Client::connect().await.map_err(unavailable_error)?;
    c.request(Method::SessionGet, SessionGetRequest { selector })
        .await
        .and_then(|value| {
            serde_json::from_value(value)
                .map(public_record)
                .map_err(|_| ClientError::Io)
        })
        .map_err(map_client)
}
async fn list(args: Value) -> Result<Value, Value> {
    object_keys(&args, &["state"])?;
    if args.get("state").is_some_and(|state| {
        !matches!(
            state.as_str(),
            Some("creating" | "running" | "exited" | "closing" | "closed" | "lost")
        )
    }) {
        return Err(invalid());
    }
    let mut c = Client::connect().await.map_err(unavailable_error)?;
    let value = c
        .request(Method::SessionList, SessionListRequest {})
        .await
        .map_err(map_client)?;
    let value: terminal_host_protocol::SessionListResponse =
        serde_json::from_value(value).map_err(|_| invalid_daemon_result())?;
    let mut terminals = value
        .sessions
        .into_iter()
        .map(public_record)
        .collect::<Vec<_>>();
    if let Some(state) = args.get("state").and_then(Value::as_str) {
        terminals.retain(|v| v["state"] == state);
    }
    Ok(json!({"terminals":terminals}))
}
async fn present(args: Value) -> Result<Value, Value> {
    object_keys(
        &args,
        &["handle", "placement", "workspace_path", "presentation"],
    )?;
    let handle = required(&args, "handle")?;
    bounded(&handle, SESSION_HANDLE_MAX_BYTES)?;
    let placement = placement(&required(&args, "placement")?)?;
    let target = if matches!(placement, Placement::Workspace) {
        args.get("workspace_path")
            .and_then(Value::as_str)
            .map(canonical_existing_absolute)
            .transpose()?
    } else {
        if args.get("workspace_path").is_some() {
            return Err(invalid());
        }
        None
    };
    let mut c = Client::connect().await.map_err(unavailable_error)?;
    c.request(
        Method::SessionPresent,
        SessionPresentRequest {
            handle,
            placement,
            workspace_target: target,
            presentation: presentation(&args)?,
        },
    )
    .await
    .and_then(|value| {
        serde_json::from_value(value)
            .map(public_record)
            .map_err(|_| ClientError::Io)
    })
    .map_err(map_client)
}
async fn close(args: Value) -> Result<Value, Value> {
    object_keys(&args, &["handle", "mode"])?;
    let mut c = Client::connect().await.map_err(unavailable_error)?;
    let handle = required(&args, "handle")?;
    bounded(&handle, SESSION_HANDLE_MAX_BYTES)?;
    let mode = match args.get("mode") {
        None => CloseMode::Graceful,
        Some(Value::String(value)) if value == "graceful" => CloseMode::Graceful,
        Some(Value::String(value)) if value == "force" => CloseMode::Force,
        _ => return Err(invalid()),
    };
    let close_result = c
        .request(
            Method::SessionClose,
            SessionCloseRequest {
                handle: handle.clone(),
                mode,
            },
        )
        .await
        .and_then(|value| {
            serde_json::from_value::<terminal_host_protocol::EmptyResponse>(value)
                .map_err(|_| ClientError::Io)
        });
    close_result.map_err(map_client)?;
    c.request(
        Method::SessionGet,
        SessionGetRequest {
            selector: SessionSelector {
                handle: Some(handle),
                request_id: None,
            },
        },
    )
    .await
    .and_then(|value| {
        serde_json::from_value(value)
            .map(public_record)
            .map_err(|_| ClientError::Io)
    })
    .map_err(map_client)
}
fn required(value: &Value, key: &str) -> Result<String, Value> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(invalid)
}
fn object_keys(value: &Value, allowed: &[&str]) -> Result<(), Value> {
    let object = value.as_object().ok_or_else(invalid)?;
    object
        .keys()
        .all(|key| allowed.contains(&key.as_str()))
        .then_some(())
        .ok_or_else(invalid)
}
fn bounded(value: &str, max: usize) -> Result<(), Value> {
    (value.len() <= max).then_some(()).ok_or_else(invalid)
}
fn invalid_daemon_result() -> Value {
    typed(
        "internal_error",
        "daemon returned an invalid result",
        "no_effect",
        None,
        None,
        true,
    )
}
fn public_create(value: SessionCreateResponse) -> Value {
    json!({"disposition":match value.disposition { terminal_host_protocol::CreateDisposition::Created => "created", terminal_host_protocol::CreateDisposition::Reused => "reused" },"terminal":public_record(value.session)})
}
fn public_record(record: SessionRecord) -> Value {
    json!({
        "handle":record.handle,
        "state":match record.state { terminal_host_protocol::SessionState::Creating=>"creating", terminal_host_protocol::SessionState::Running=>"running", terminal_host_protocol::SessionState::Exited=>"exited", terminal_host_protocol::SessionState::Closing=>"closing", terminal_host_protocol::SessionState::Closed=>"closed", terminal_host_protocol::SessionState::Lost=>"lost" },
        "placement":match record.placement { Placement::Workspace=>"workspace", Placement::Window=>"window" },
        "presentation":match record.presentation { Presentation::Background=>"background", Presentation::Focused=>"focused" },
        "exit_behavior":match record.exit_behavior { terminal_host_protocol::ExitBehavior::Keep=>"keep", terminal_host_protocol::ExitBehavior::CloseOnSuccess=>"close-on-success", terminal_host_protocol::ExitBehavior::CloseOnExit=>"close-on-exit" },
        "workspace_path":record.workspace_target,
        "surface_hidden":record.surface_hidden,
        "child_pid":record.child_pid,
        "exit_code":record.exit_code
    })
}
fn invalid() -> Value {
    typed(
        "invalid_request",
        "arguments do not satisfy the strict tool schema",
        "no_effect",
        None,
        None,
        false,
    )
}
fn unavailable_error(_: ClientError) -> Value {
    typed(
        "app_unavailable",
        "ThreadTerm terminal host is not running",
        "no_effect",
        None,
        None,
        true,
    )
}
fn map_client(e: ClientError) -> Value {
    match e {
        ClientError::Daemon(v) => map_daemon(v),
        ClientError::UpgradeDeferred => typed(
            "incompatible_runtime",
            "ThreadTerm runtime upgrade is deferred",
            "no_effect",
            None,
            None,
            true,
        ),
        _ => typed(
            "internal_error",
            "local daemon connection failed",
            "no_effect",
            None,
            None,
            true,
        ),
    }
}
fn map_daemon(value: Value) -> Value {
    let code = value
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("internal_error");
    let effect = value
        .get("effect")
        .and_then(Value::as_str)
        .unwrap_or("no_effect");
    json!({"code":code,"message":value.get("message").and_then(Value::as_str).unwrap_or("daemon request failed"),"effect":effect,"request_id":value.get("request_id"),"handle":value.get("handle"),"retryable":value.get("retryable").and_then(Value::as_bool).unwrap_or(false)})
}
fn selector(v: &Value) -> Result<SessionSelector, Value> {
    let h = v.get("handle").and_then(Value::as_str).map(str::to_owned);
    let r = v
        .get("request_id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if h.as_deref()
        .is_some_and(|v| v.trim().is_empty() || v.len() > SESSION_HANDLE_MAX_BYTES)
        || r.as_deref()
            .is_some_and(|v| v.trim().is_empty() || v.len() > REQUEST_ID_MAX_BYTES)
        || h.is_some() == r.is_some()
    {
        Err(invalid())
    } else {
        Ok(SessionSelector {
            handle: h,
            request_id: r,
        })
    }
}
fn placement(v: &str) -> Result<Placement, Value> {
    match v {
        "workspace" => Ok(Placement::Workspace),
        "window" => Ok(Placement::Window),
        _ => Err(invalid()),
    }
}
fn presentation(v: &Value) -> Result<Presentation, Value> {
    match v
        .get("presentation")
        .and_then(Value::as_str)
        .unwrap_or("focused")
    {
        "focused" => Ok(Presentation::Focused),
        "background" => Ok(Presentation::Background),
        _ => Err(invalid()),
    }
}
fn exit_behavior(v: &Value) -> Result<terminal_host_protocol::ExitBehavior, Value> {
    match v
        .get("exit_behavior")
        .and_then(Value::as_str)
        .unwrap_or("keep")
    {
        "keep" => Ok(terminal_host_protocol::ExitBehavior::Keep),
        "close-on-success" => Ok(terminal_host_protocol::ExitBehavior::CloseOnSuccess),
        "close-on-exit" => Ok(terminal_host_protocol::ExitBehavior::CloseOnExit),
        _ => Err(invalid()),
    }
}
fn canonical_existing_absolute(candidate: &str) -> Result<String, Value> {
    bounded(candidate, MAX_COMMAND_BYTES)?;
    let candidate = PathBuf::from(candidate);
    if !candidate.is_absolute() || !candidate.is_dir() {
        return Err(invalid());
    }
    candidate
        .canonicalize()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|_| invalid())
}

#[derive(Debug)]
enum ClientError {
    Unavailable,
    UpgradeDeferred,
    Io,
    Daemon(Value),
}
struct Client {
    #[cfg(windows)]
    pipe: tokio::net::windows::named_pipe::NamedPipeClient,
    version: terminal_host_protocol::ProtocolVersion,
    runtime_id: String,
    capabilities: Vec<String>,
    next_id: u64,
}
impl Client {
    async fn connect() -> Result<Self, ClientError> {
        #[cfg(not(windows))]
        {
            Err(ClientError::Unavailable)
        }
        #[cfg(windows)]
        {
            let profile = profile_dir().ok_or(ClientError::Unavailable)?;
            let paths =
                BootstrapPaths::from_profile_dir(profile).map_err(|_| ClientError::Unavailable)?;
            let endpoint = read_endpoint(paths.endpoint()).map_err(|_| ClientError::Unavailable)?;
            if endpoint.protocol_min != PROTOCOL_VERSION
                || endpoint.protocol_max != PROTOCOL_VERSION
            {
                return Err(ClientError::UpgradeDeferred);
            }
            let secret = Secret::read(paths.secret()).map_err(|_| ClientError::Unavailable)?;
            use tokio::net::windows::named_pipe::ClientOptions;
            let pipe = tokio::time::timeout(CONNECT_TIMEOUT, async {
                loop {
                    match ClientOptions::new().open(&endpoint.pipe_name) {
                        Ok(p) => return Ok(p),
                        Err(e) if e.raw_os_error() == Some(231) => {
                            tokio::time::sleep(Duration::from_millis(20)).await
                        }
                        Err(_) => return Err(ClientError::Io),
                    }
                }
            })
            .await
            .map_err(|_| ClientError::Io)??;
            let mut client = Self {
                pipe,
                version: PROTOCOL_VERSION,
                runtime_id: endpoint.runtime_id.clone(),
                capabilities: Vec::new(),
                next_id: 1,
            };
            let hello = HelloRequest {
                protocol: ProtocolRange {
                    min: PROTOCOL_VERSION,
                    max: PROTOCOL_VERSION,
                },
                client: ClientClass::McpBridge,
                capabilities: vec![],
                secret: secret.encoded(),
            };
            let value = client.request(Method::Hello, hello).await?;
            let ack: HelloAck =
                serde_json::from_value(value).map_err(|_| ClientError::Unavailable)?;
            if ack.runtime_id != endpoint.runtime_id
                || ack.launch_nonce != endpoint.launch_nonce
                || ack.owner_generation != endpoint.owner_generation
                || ack.selected_version != PROTOCOL_VERSION
                || !ack
                    .capabilities
                    .iter()
                    .any(|capability| capability == "runtime.health")
            {
                return Err(ClientError::Unavailable);
            }
            client.capabilities = ack.capabilities;
            Ok(client)
        }
    }
    async fn request<T: serde::Serialize>(
        &mut self,
        method: Method,
        params: T,
    ) -> Result<Value, ClientError> {
        #[cfg(not(windows))]
        {
            let _ = (method, params);
            Err(ClientError::Unavailable)
        }
        #[cfg(windows)]
        {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let id = self.next_id;
            self.next_id += 1;
            let request = RequestEnvelope {
                version: self.version,
                kind: EnvelopeKind::Request,
                id,
                method: method.clone(),
                params: serde_json::to_value(params).map_err(|_| ClientError::Io)?,
            };
            let body = serde_json::to_vec(&request).map_err(|_| ClientError::Io)?;
            if body.len() > MAX_FRAME {
                return Err(ClientError::Io);
            };
            self.pipe
                .write_u32_le(body.len() as u32)
                .await
                .map_err(|_| ClientError::Io)?;
            self.pipe
                .write_all(&body)
                .await
                .map_err(|_| ClientError::Io)?;
            loop {
                let len = tokio::time::timeout(REQUEST_TIMEOUT, self.pipe.read_u32_le())
                    .await
                    .map_err(|_| ClientError::Io)?
                    .map_err(|_| ClientError::Io)? as usize;
                if len == 0 || len > MAX_FRAME {
                    return Err(ClientError::Io);
                }
                let mut body = vec![0; len];
                tokio::time::timeout(REQUEST_TIMEOUT, self.pipe.read_exact(&mut body))
                    .await
                    .map_err(|_| ClientError::Io)?
                    .map_err(|_| ClientError::Io)?;
                let Some(response) = decode_inbound_frame(&body, &self.version)? else {
                    continue;
                };
                if response.kind == EnvelopeKind::Response && response.id == id {
                    response
                        .validate_for(&self.version)
                        .map_err(|_| ClientError::Io)?;
                    if response.error.is_some() {
                        return Err({
                            ClientError::Daemon(
                                serde_json::to_value(response.error)
                                    .unwrap_or_else(|_| json!({"code":"internal_error"})),
                            )
                        });
                    }
                    return response.result.ok_or(ClientError::Io);
                }
            }
        }
    }
}
fn decode_inbound_frame(
    body: &[u8],
    version: &terminal_host_protocol::ProtocolVersion,
) -> Result<Option<ResponseEnvelope>, ClientError> {
    match serde_json::from_slice(body) {
        Ok(response) => Ok(Some(response)),
        Err(_) => {
            let event: EventEnvelope = serde_json::from_slice(body).map_err(|_| ClientError::Io)?;
            event.validate_for(version).map_err(|_| ClientError::Io)?;
            Ok(None)
        }
    }
}
fn profile_dir() -> Option<PathBuf> {
    if let Some(value) = env::var_os("THREADTERM_PROFILE_DIR") {
        let p = PathBuf::from(value);
        return (p.is_absolute() && p.is_dir()).then_some(p);
    }
    let base = env::var_os("APPDATA")?.into();
    let base: PathBuf = base;
    for pointer in [
        base.join("com.Heluth-Crazy.threadterm/data-location.json"),
        base.join("com.Heluth-Crazy.threadterm/data-location.previous.json"),
    ] {
        if let Some(state) = managed_state_from_pointer(&pointer) {
            return Some(state);
        }
    }
    env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|p| p.join(".threadterm/state"))
        .filter(|p| p.is_dir())
}
fn read_bounded(path: &Path) -> Option<Vec<u8>> {
    let metadata = fs::metadata(path).ok()?;
    (metadata.len() <= MAX_PROFILE_FILE_BYTES).then_some(())?;
    fs::read(path).ok()
}
fn managed_state_from_pointer(pointer: &Path) -> Option<PathBuf> {
    let value: Value = serde_json::from_slice(&read_bounded(pointer)?).ok()?;
    if value.get("pointerVersion")?.as_u64()? != 1 {
        return None;
    }
    let root = PathBuf::from(value.get("currentRoot")?.as_str()?);
    if !root.is_absolute() {
        return None;
    }
    let manifest: Value =
        serde_json::from_slice(&read_bounded(&root.join("manifest.json"))?).ok()?;
    if manifest.get("appId")?.as_str()? != "com.Heluth-Crazy.threadterm"
        || manifest.get("formatVersion")?.as_u64()? != 1
    {
        return None;
    }
    let state = root.join("state");
    state.is_dir().then_some(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn schemas_are_strict() {
        for tool in tools() {
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
        }
        let create = &tools()[1]["inputSchema"];
        assert_eq!(create["properties"]["request_id"]["maxLength"], 512);
        assert_eq!(
            create["properties"]["launch"]["properties"]["cwd"]["maxLength"],
            32768
        );
        assert_eq!(
            create["properties"]["launch"]["properties"]["args"]["items"]["maxLength"],
            32768
        );
        assert_eq!(
            tools()[2]["inputSchema"]["properties"]["handle"]["maxLength"],
            128
        );
    }
    #[test]
    fn selector_requires_one() {
        assert!(selector(&json!({"handle":"a","request_id":"b"})).is_err())
    }
    #[test]
    fn public_launch_contract_is_derived_from_v1_daemon_methods() {
        let daemon_capabilities = vec![
            "runtime.health".to_string(),
            "session.create".to_string(),
            "session.get".to_string(),
            "session.present".to_string(),
            "session.close".to_string(),
        ];
        assert!(launch_supported(&daemon_capabilities));
        assert_eq!(
            public_capabilities(&daemon_capabilities),
            vec![
                "terminal.create",
                "terminal.get-by-request-id",
                "terminal.present",
                "terminal.close-by-handle",
                "presentation.window.background",
                "exit.close-on-exit",
            ]
        );
    }
    #[test]
    fn managed_pointer_requires_the_threadterm_manifest() {
        let fixture = tempdir().unwrap();
        let root = fixture.path().join("managed");
        fs::create_dir_all(root.join("state")).unwrap();
        fs::write(
            root.join("manifest.json"),
            br#"{"appId":"com.Heluth-Crazy.threadterm","formatVersion":1}"#,
        )
        .unwrap();
        let pointer = fixture.path().join("data-location.json");
        let root_json = root.to_string_lossy().replace('\\', "\\\\");
        fs::write(
            &pointer,
            format!(r#"{{"pointerVersion":1,"currentRoot":"{}"}}"#, root_json),
        )
        .unwrap();
        assert_eq!(
            managed_state_from_pointer(&pointer),
            Some(root.join("state"))
        );
        fs::write(
            root.join("manifest.json"),
            br#"{"appId":"other","formatVersion":1}"#,
        )
        .unwrap();
        assert_eq!(managed_state_from_pointer(&pointer), None);
    }
    #[test]
    fn workspace_paths_are_independent_existing_absolute_directories() {
        let fixture = tempdir().unwrap();
        let first = fixture.path().join("first");
        let second = fixture.path().join("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let first = canonical_existing_absolute(first.to_str().unwrap()).unwrap();
        let second = canonical_existing_absolute(second.to_str().unwrap()).unwrap();
        assert_ne!(first, second);
    }
}
