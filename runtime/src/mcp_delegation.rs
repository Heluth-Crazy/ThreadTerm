//! `threadterm-v3-mcp` in the `delegation` profile: the stdio MCP server
//! ThreadTerm attaches to a parent Chat session (see `delegation.rs`). Each
//! tool call becomes a `delegation.*` request to the runtime carrying the
//! session id and per-open token from this process's environment.
//!
//! Unlike the terminal host it negotiates the protocol version, handles calls
//! concurrently (a long `delegate_wait` never blocks pings), ignores
//! notifications, and treats `notifications/cancelled` as "stop this wait"
//! only — Kimi sends one after every call, so it never cancels a delegate.
use crate::{config::RuntimeConfig, local_client::RuntimeClient};
use anyhow::Result;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    io::{BufRead, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const SUPPORTED_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const FALLBACK_VERSION: &str = "2025-06-18";
const MAX_LINE: usize = 1024 * 1024;
/// Kimi times MCP calls out at 60 s; stay well below.
const MAX_WAIT_SECONDS: u64 = 45;
const DEFAULT_WAIT_SECONDS: u64 = 30;
const POLL_INTERVAL: Duration = Duration::from_millis(1000);
const AGENTS: [&str; 6] = ["claude", "codex", "kimi", "grok", "gemini", "opencode"];
const TERMINAL_STATES: [&str; 3] = ["completed", "failed", "cancelled"];

/// How to brief a delegate (guidance only; nothing checks it). Shared by
/// `INSTRUCTIONS` and the `delegate_start` `prompt` description: agents that
/// ignore server instructions still read tool descriptions.
macro_rules! handoff_guide {
    () => {
        "A delegate sees only its prompt, not your conversation. ThreadTerm puts the user's own words above your \
prompt: their latest messages in this chat, copied word for word (userMessages: default 1, the message that \
started your turn; up to 10; 0 for none). Set it to cover every message this task comes from, corrections \
included, even when your brief already covers them: they let the delegate check your brief against what the user \
actually said (it is told later ones win). Use 0 only when none of them concern the delegate's part or they are \
private. Don't quote the user yourself. One line is fine for a small task; for anything larger write \
a brief with these headings as written (leave out sections that don't apply; write \"none known\" rather than \
inventing content):\n```\n\
## Assignment (your part only)\n\
## Constraints (must / must not)\n\
## Acceptance criteria + how to verify\n\
## Deliverable (what to return)\n\
## Context (pointers; re-check before relying on them)\n\
## Open questions + decision policy (stop | assume and flag)\n\
```\nTag each Assignment line [user] (the user asked for it), [inferred] (your reading) or [verified] (you \
checked it); [inferred] lines are not pass/fail criteria. Give the delegate only its part and say what is handled \
elsewhere."
    };
}

/// Claude Code truncates server instructions after 2048 characters.
const INSTRUCTIONS: &str = concat!(
    "ThreadTerm delegation: start other coding agents as visible ThreadTerm Chat sessions \
and follow them. Workflow: delegate_start (one call per task; up to 4 at once) → delegate_wait repeatedly until \
every delegate is completed, failed or cancelled → delegate_result for each answer. When a delegate is \
awaiting_parent it needs your decision: answer its pendingRequests with delegate_respond. Stay in your turn while \
delegates run; if your turn ends, their requests go to the user instead. Delegates cannot delegate further.\n\n",
    handoff_guide!()
);
const GENERATED_UI_INSTRUCTIONS: &str = "ThreadTerm generated UI: when a compact visual answer helps, emit one fenced ```threadterm-ui block containing JSON. The root has version, components, and buttons; for example, {\"version\":1,\"components\":[],\"buttons\":[{\"label\":\"Example\",\"text\":\"Example text\"}]}. version is always 1. Source is at most 64 KiB, the component tree has at most 256 nodes and depth 6, and buttons has at most 12 entries with label/text only and text at most 4000 characters. Components are: card {\"type\":\"card\",\"title\"?:string,\"children\"?:components[]}; stat {\"type\":\"stat\",\"label\":string,\"value\":string|number}; table {\"type\":\"table\",\"columns\":string[],\"rows\":(string|number)[][]} with at most 100 rows and 20 columns; list {\"type\":\"list\",\"items\":string[]}; badge {\"type\":\"badge\",\"text\":string,\"tone\"?:\"neutral\"|\"success\"|\"warning\"|\"danger\"}; progress {\"type\":\"progress\",\"value\":number,\"max\"?:number,\"label\"?:string}, where max defaults to 100; chart {\"type\":\"chart\",\"kind\":\"bar\"|\"line\"|\"pie\",\"title\"?:string,\"data\":[{\"label\":string,\"value\":number}]}, with at most 200 nonnegative data values. ThreadTerm renders charts as handwritten SVG. Buttons only insert their given text into the composer. Do not include URLs, scripts, event handlers, or any executable content.\n";

#[derive(Clone)]
struct Caller {
    session_id: String,
    token: String,
}

impl Caller {
    fn from_env() -> Option<Self> {
        let session_id = std::env::var("THREADTERM_SESSION_ID").ok().filter(|value| !value.is_empty())?;
        let token = std::env::var("THREADTERM_SESSION_TOKEN").ok().filter(|value| !value.is_empty())?;
        Some(Self { session_id, token })
    }

    fn params(&self, mut params: Value) -> Value {
        if let Some(object) = params.as_object_mut() {
            object.insert("callerSessionId".into(), json!(self.session_id));
            object.insert("callerToken".into(), json!(self.token));
        }
        params
    }
}

type Output = Arc<Mutex<std::io::Stdout>>;

#[derive(Clone)]
struct PreviewCaller {session_id:String,token:String}
impl PreviewCaller {
    fn from_env()->Option<Self> {
        if std::env::var("THREADTERM_MCP_PROFILE").as_deref()!=Ok("chat-tools") {return None}
        Some(Self {session_id:std::env::var("THREADTERM_PREVIEW_SESSION_ID").ok().filter(|s|!s.is_empty())?,token:std::env::var("THREADTERM_PREVIEW_TOKEN").ok().filter(|s|!s.is_empty())?})
    }
}
#[derive(Clone)]
struct ChatCaller {session_id:String,token:String,ask:bool,session_info:bool,feedback:bool}
impl ChatCaller {
    fn from_env()->Option<Self> {
        if std::env::var("THREADTERM_MCP_PROFILE").as_deref()!=Ok("chat-tools") { return None; }
        let session_id=std::env::var("THREADTERM_CHAT_SESSION_ID").ok().filter(|s|!s.is_empty())?;
        let token=std::env::var("THREADTERM_CHAT_TOKEN").ok().filter(|s|!s.is_empty())?;
        let enabled=|name:&str| std::env::var(name).as_deref()==Ok("1");
        Some(Self {session_id,token,ask:enabled("THREADTERM_CHAT_TOOL_ASK"),session_info:enabled("THREADTERM_CHAT_TOOL_SESSION_INFO"),feedback:enabled("THREADTERM_CHAT_TOOL_FEEDBACK")})
    }
    fn params(&self, mut params:Value)->Result<Value,Value> {
        let object=params.as_object_mut().ok_or_else(||failure("invalid_arguments","Tool arguments must be an object."))?;
        if object.contains_key("callerSessionId")||object.contains_key("callerToken") { return Err(failure("invalid_arguments","Caller identity is runtime-owned.")); }
        object.insert("callerSessionId".into(),json!(self.session_id));
        object.insert("callerToken".into(),json!(self.token));
        Ok(params)
    }
}
fn composed_tools(delegation:bool,preview:bool,chat:Option<&ChatCaller>)->Vec<Value> {
    let mut catalog=if delegation {tools()} else {vec![]};
    if preview {catalog.extend(crate::preview::tools())}
    if let Some(chat)=chat { catalog.extend(chat_tools(chat)); }
    catalog
}
fn generated_ui_from_env()->bool {
    std::env::var("THREADTERM_GENERATED_UI").as_deref()==Ok("1")
}
fn composed_instructions(delegation:bool,preview:bool,chat:Option<&ChatCaller>,generated_ui:bool)->String {
    let mut text=format!("ThreadTerm capabilities: delegation={} (delegate_start/wait/result); local preview={} (preview_present/status). Preview: verify the server URL first; presentation/load events never prove application readiness. Browser and delegation permissions are independent.\n",delegation,preview);
    // Claude Code keeps only the first 2048 characters. Generated UI has no tool
    // description to fall back on, so it goes first; the rest repeat in tools.
    if generated_ui {text.push_str(GENERATED_UI_INSTRUCTIONS)}
    if preview {text.push_str(crate::preview::INSTRUCTIONS);text.push('\n');}
    if delegation {text.push_str(INSTRUCTIONS)}
    if let Some(chat)=chat {
        if chat.ask { text.push_str("\nUse ask_user when a user choice would materially affect the work. It waits for the user's answer; do not use it for routine implementation decisions."); }
        if chat.session_info { text.push_str("\nUse session_info to read a referenced ThreadTerm chat; it returns bounded plain-text history."); }
        if chat.feedback { text.push_str("\nFor long tasks, call feedback_check between major steps to receive user notes sent during this turn."); }
    }
    text
}
async fn call_chat_tool(config:&RuntimeConfig,caller:Option<&Caller>,preview:Option<&PreviewCaller>,chat:Option<&ChatCaller>,name:&str,arguments:&Value,cancelled:&AtomicBool)->Result<Value,Value> {
    if crate::preview::TOOL_NAMES.contains(&name) {
        let preview=preview.ok_or_else(||failure("preview_not_configured","Preview tools are not authorized for this Chat."))?;
        let mut params=arguments.clone();let object=params.as_object_mut().ok_or_else(||failure("invalid_arguments","Tool arguments must be an object."))?;
        if object.contains_key("callerSessionId")||object.contains_key("callerToken"){return Err(failure("invalid_arguments","Caller identity is runtime-owned."))}
        object.insert("callerSessionId".into(),json!(preview.session_id));object.insert("callerToken".into(),json!(preview.token));
        let mut client=RuntimeClient::connect(config,format!("mcp-preview-{}",uuid::Uuid::new_v4())).await.map_err(|_|failure("app_unavailable","ThreadTerm runtime is unavailable"))?;
        return client.request(if name=="preview_present"{"preview.tool.present"}else{"preview.tool.status"},params).await.map_err(|error|failure("preview_request_failed",error.to_string()));
    }
    let Some(chat)=chat else { return call_tool(config,caller,name,arguments,cancelled).await };
    let (method, enabled) = match name {
        "ask_user" => ("chat.tool.ask", chat.ask),
        "session_info" => ("chat.tool.sessionInfo", chat.session_info),
        "feedback_check" => ("chat.tool.feedback", chat.feedback),
        _ => return call_tool(config,caller,name,arguments,cancelled).await,
    };
    if !enabled { return Err(failure("tool_disabled", "This Chat tool is disabled for this connection.")); }
    let params=chat.params(arguments.clone())?;
    let mut client=RuntimeClient::connect(config,format!("mcp-chat-tool-{}",uuid::Uuid::new_v4())).await.map_err(|_|failure("app_unavailable","ThreadTerm runtime is unavailable"))?;
    client.request(method,params).await.map_err(|error|failure("chat_tool_request_failed",error.to_string()))
}

fn chat_tools(caller:&ChatCaller)->Vec<Value> {
    let mut result=Vec::new();
    if caller.ask { result.push(tool("ask_user", "Ask the user up to four concise multiple-choice questions when their decision is needed. This call waits for an answer, dismissal, cancellation, or session close.", json!({"type":"object","additionalProperties":false,"required":["questions"],"properties":{"questions":{"type":"array","minItems":1,"maxItems":4,"items":{"type":"object","additionalProperties":false,"required":["question","options"],"properties":{"header":{"type":"string","minLength":1,"maxLength":80},"question":{"type":"string","minLength":1,"maxLength":4000},"options":{"type":"array","minItems":2,"maxItems":6,"items":{"type":"object","additionalProperties":false,"required":["label"],"properties":{"label":{"type":"string","minLength":1,"maxLength":256},"description":{"type":"string","maxLength":2000}}}},"multiSelect":{"type":"boolean"},"allowOther":{"type":"boolean"}}}}}}))); }
    if caller.session_info { result.push(tool("session_info", "Read bounded metadata and recent plain-text transcript items for a ThreadTerm session in this runtime.", json!({"type":"object","additionalProperties":false,"required":["session"],"properties":{"session":{"type":"string","minLength":1,"maxLength":512}}}))); }
    if caller.feedback { result.push(tool("feedback_check", "Read feedback notes the user sent during this turn. Call between major steps of long tasks; returned notes are marked received.", json!({"type":"object","additionalProperties":false,"properties":{}}))); }
    result
}

fn emit(output: &Output, value: &Value) {
    if let Ok(mut stdout) = output.lock() {
        let _ = serde_json::to_writer(&mut *stdout, value);
        let _ = stdout.write_all(b"\n");
        let _ = stdout.flush();
    }
}

fn ok(id: &Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

fn rpc_error(id: &Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

pub async fn run_stdio(config: RuntimeConfig) -> Result<()> {
    let caller = Caller::from_env();
    let preview = PreviewCaller::from_env();
    let chat = ChatCaller::from_env();
    let instructions = composed_instructions(caller.is_some(), preview.is_some(), chat.as_ref(), generated_ui_from_env());
    let output: Output = Arc::new(Mutex::new(std::io::stdout()));
    let inflight: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> = Arc::default();
    let (lines, mut incoming) = tokio::sync::mpsc::unbounded_channel::<String>();
    // Blocking stdin on its own thread; the runtime handles calls concurrently.
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if lines.send(line).is_err() {
                break;
            }
        }
    });
    let mut initialized = false;
    while let Some(line) = incoming.recv().await {
        if line.trim().is_empty() {
            continue;
        }
        if line.len() > MAX_LINE {
            emit(&output, &rpc_error(&Value::Null, -32600, "request_too_large"));
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            emit(&output, &rpc_error(&Value::Null, -32700, "parse_error"));
            continue;
        };
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let Some(id) = message.get("id").filter(|id| !id.is_null()).cloned() else {
            // Notifications never get a response.
            if method == "notifications/cancelled" {
                if let Some(request) = message.pointer("/params/requestId") {
                    if let Some(flag) = inflight.lock().ok().and_then(|calls| calls.get(&request.to_string()).cloned()) {
                        flag.store(true, Ordering::SeqCst);
                    }
                }
            }
            continue;
        };
        if method.is_empty() {
            continue; // a response to a request we never send
        }
        match method {
            "initialize" => {
                initialized = true;
                let requested = message.pointer("/params/protocolVersion").and_then(Value::as_str);
                emit(
                    &output,
                    &ok(
                        &id,
                        json!({
                            "protocolVersion": negotiate_version(requested),
                            "capabilities": {"tools": {"listChanged": false}},
                            "serverInfo": {"name": "threadterm", "title": "ThreadTerm Chat tools", "version": env!("CARGO_PKG_VERSION")},
                            "instructions": instructions,
                        }),
                    ),
                );
            }
            "ping" => emit(&output, &ok(&id, json!({}))),
            _ if !initialized => emit(&output, &rpc_error(&id, -32600, "initialize_required")),
            "tools/list" => emit(&output, &ok(&id, json!({"tools": composed_tools(caller.is_some(),preview.is_some(),chat.as_ref())}))),
            "tools/call" => {
                let name = message.pointer("/params/name").and_then(Value::as_str).unwrap_or("").to_owned();
                let arguments = message.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
                let cancelled = Arc::new(AtomicBool::new(false));
                let key = id.to_string();
                if let Ok(mut calls) = inflight.lock() {
                    calls.insert(key.clone(), Arc::clone(&cancelled));
                }
                let (config, caller, preview, chat, output, inflight) = (config.clone(), caller.clone(), preview.clone(), chat.clone(), Arc::clone(&output), Arc::clone(&inflight));
                tokio::spawn(async move {
                    let result = call_chat_tool(&config, caller.as_ref(), preview.as_ref(), chat.as_ref(), &name, &arguments, &cancelled).await;
                    if let Ok(mut calls) = inflight.lock() {
                        calls.remove(&key);
                    }
                    // A cancelled call gets no response (MCP cancellation).
                    if !cancelled.load(Ordering::SeqCst) {
                        emit(&output, &ok(&id, tool_content(result)));
                    }
                });
            }
            _ => emit(&output, &rpc_error(&id, -32601, "method_not_found")),
        }
    }
    Ok(())
}

fn negotiate_version(requested: Option<&str>) -> &'static str {
    requested
        .and_then(|version| SUPPORTED_VERSIONS.iter().copied().find(|supported| *supported == version))
        .unwrap_or(FALLBACK_VERSION)
}

fn tool_content(result: Result<Value, Value>) -> Value {
    let (value, is_error) = match result {
        Ok(value) => (value, false),
        Err(error) => (error, true),
    };
    let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
    json!({"content": [{"type": "text", "text": text}], "isError": is_error})
}

fn tool(name: &str, description: &str, schema: Value) -> Value {
    json!({"name": name, "description": description, "inputSchema": schema})
}

fn tools() -> Vec<Value> {
    vec![
        tool(
            "delegate_start",
            "Start another coding agent as a visible ThreadTerm Chat session that works on `prompt`. The delegate does not see your conversation, so make the prompt self-contained (its description gives the recommended brief). Returns at once with a delegationId; then call delegate_wait. workspace `shared` (default) works in your folder; `worktree` gives the delegate its own git branch and folder created from your current commit (your uncommitted changes are not included) — use it when several delegates edit files in parallel. At most 4 active delegates; delegates cannot delegate.",
            json!({"type":"object","additionalProperties":false,"required":["agent","prompt"],"properties":{
                "agent":{"type":"string","enum":AGENTS,"description":"Agent to delegate to; delegate_status lists the available ones."},
                "prompt":{"type":"string","minLength":1,"description":concat!("Self-contained task for the delegate. ", handoff_guide!())},
                "title":{"type":"string","maxLength":120,"description":"Short session title shown in ThreadTerm."},
                "userMessages":{"type":"integer","minimum":0,"maximum":crate::delegation::MAX_USER_MESSAGES,"description":"How many of the user's latest messages in this chat ThreadTerm attaches word for word above your prompt (default 1: the message that started your turn; 0: none)."},
                "workspace":{"type":"string","enum":["shared","worktree"]}
            }}),
        ),
        tool(
            "delegate_status",
            "List your delegates (or the given ids) with their state (starting, running, awaiting_parent, awaiting_user, completed, failed, cancelled) and pending requests, plus the agents you can delegate to.",
            json!({"type":"object","additionalProperties":false,"properties":{"ids":{"type":"array","items":{"type":"string"}}}}),
        ),
        tool(
            "delegate_wait",
            "Wait up to timeoutSeconds (default 30, max 45) for your delegates (or the given ids) to change state; returns early on any change or as soon as one needs you. Call it repeatedly until every delegate is completed, failed or cancelled. A delegate in awaiting_parent needs your decision: answer its pendingRequests with delegate_respond. Stay in your turn while delegates run; if your turn ends, their requests go to the user.",
            json!({"type":"object","additionalProperties":false,"properties":{
                "ids":{"type":"array","items":{"type":"string"}},
                "timeoutSeconds":{"type":"integer","minimum":1,"maximum":MAX_WAIT_SECONDS}
            }}),
        ),
        tool(
            "delegate_respond",
            "Answer a delegate's pending approval request (from delegate_status / delegate_wait pendingRequests) with one of its choiceIds. Choices that would save a permanent rule are reserved for the user and not offered.",
            json!({"type":"object","additionalProperties":false,"required":["id","requestId","choiceId"],"properties":{
                "id":{"type":"string","description":"delegationId"},"requestId":{"type":"string"},"choiceId":{"type":"string"}
            }}),
        ),
        tool(
            "delegate_result",
            "Read a delegate's final answer, state, error, and the files changed in its folder since it started (in a shared folder this can include others' edits).",
            json!({"type":"object","additionalProperties":false,"required":["id"],"properties":{"id":{"type":"string","description":"delegationId"}}}),
        ),
        tool(
            "delegate_cancel",
            "Stop a delegate's work. Its session stays visible to the user.",
            json!({"type":"object","additionalProperties":false,"required":["id"],"properties":{"id":{"type":"string","description":"delegationId"}}}),
        ),
    ]
}

fn failure(code: &str, message: impl Into<String>) -> Value {
    json!({"error": {"code": code, "message": message.into()}})
}

fn string_arg(arguments: &Value, key: &str) -> Result<String, Value> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| failure("invalid_arguments", format!("`{key}` is required")))
}

/// `userMessages` as a whole number in range; some agents send integers as floats (`3.0`).
fn user_messages_arg(arguments: &Value) -> Result<Option<u64>, Value> {
    match arguments.get("userMessages") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .or_else(|| value.as_f64().filter(|number| number.fract() == 0.0 && *number >= 0.0).map(|number| number as u64))
            .filter(|count| *count <= u64::from(crate::delegation::MAX_USER_MESSAGES))
            .map(Some)
            .ok_or_else(|| failure("invalid_arguments", format!("`userMessages` must be a whole number from 0 to {}", crate::delegation::MAX_USER_MESSAGES))),
    }
}

fn ids_arg(arguments: &Value) -> Result<Vec<String>, Value> {
    match arguments.get("ids") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned).ok_or_else(|| failure("invalid_arguments", "`ids` must be strings")))
            .collect(),
        Some(_) => Err(failure("invalid_arguments", "`ids` must be an array")),
    }
}

async fn call_tool(
    config: &RuntimeConfig,
    caller: Option<&Caller>,
    name: &str,
    arguments: &Value,
    cancelled: &AtomicBool,
) -> Result<Value, Value> {
    let caller = caller.ok_or_else(|| failure("not_configured", "This MCP server was not started by ThreadTerm for a Chat session."))?;
    match name {
        "delegate_start" => {
            let agent = string_arg(arguments, "agent")?;
            let prompt = string_arg(arguments, "prompt")?;
            let mut params = json!({"agent": agent, "prompt": prompt, "operationId": uuid::Uuid::new_v4().to_string()});
            for key in ["title", "workspace"] {
                if let Some(value) = arguments.get(key).and_then(Value::as_str) {
                    params[key] = json!(value);
                }
            }
            if let Some(count) = user_messages_arg(arguments)? {
                params["userMessages"] = json!(count);
            }
            request(config, caller, "delegation.start", params).await
        }
        "delegate_status" => request(config, caller, "delegation.status", json!({"ids": ids_arg(arguments)?})).await,
        "delegate_wait" => {
            let seconds = arguments
                .get("timeoutSeconds")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_WAIT_SECONDS)
                .clamp(1, MAX_WAIT_SECONDS);
            wait(config, caller, ids_arg(arguments)?, Duration::from_secs(seconds), cancelled).await
        }
        "delegate_respond" => {
            let params = json!({
                "id": string_arg(arguments, "id")?,
                "requestId": string_arg(arguments, "requestId")?,
                "choiceId": string_arg(arguments, "choiceId")?,
                "operationId": uuid::Uuid::new_v4().to_string(),
            });
            request(config, caller, "delegation.respond", params).await
        }
        "delegate_result" => request(config, caller, "delegation.result", json!({"id": string_arg(arguments, "id")?})).await,
        "delegate_cancel" => request(config, caller, "delegation.cancel", json!({"id": string_arg(arguments, "id")?})).await,
        _ => Err(failure("unknown_tool", format!("unknown tool {name}"))),
    }
}

async fn connect(config: &RuntimeConfig) -> Result<RuntimeClient, Value> {
    RuntimeClient::connect(config, format!("mcp-delegation-{}", uuid::Uuid::new_v4()))
        .await
        .map_err(|_| failure("app_unavailable", "ThreadTerm runtime is unavailable"))
}

async fn send(client: &mut RuntimeClient, caller: &Caller, method: &str, params: Value) -> Result<Value, Value> {
    client.request(method, caller.params(params)).await.map_err(|error| {
        let message = error.to_string();
        let code = if crate::delegation::ERROR_CODES.contains(&message.as_str()) { message.clone() } else { "runtime_error".into() };
        failure(&code, message)
    })
}

async fn request(config: &RuntimeConfig, caller: &Caller, method: &str, params: Value) -> Result<Value, Value> {
    let mut client = connect(config).await?;
    send(&mut client, caller, method, params).await
}

/// Per delegate: state plus the ids of requests waiting for the parent.
fn summarize(status: &Value) -> BTreeMap<String, (String, Vec<String>)> {
    status
        .get("delegates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|delegate| {
            let id = delegate.get("delegationId")?.as_str()?.to_owned();
            let state = delegate.get("state").and_then(Value::as_str).unwrap_or("").to_owned();
            let requests = delegate
                .get("pendingRequests")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|request| request.get("requestId").and_then(Value::as_str).map(str::to_owned))
                .collect();
            Some((id, (state, requests)))
        })
        .collect()
}

/// Nothing to wait for: some delegate needs the parent, or all are finished.
fn needs_no_wait(summary: &BTreeMap<String, (String, Vec<String>)>) -> bool {
    summary.values().any(|(state, requests)| state == "awaiting_parent" && !requests.is_empty())
        || summary.values().all(|(state, _)| TERMINAL_STATES.contains(&state.as_str()))
}

fn wait_result(status: Value, changed: Vec<String>, timed_out: bool, waited: Duration) -> Value {
    let summary = summarize(&status);
    let all_finished = summary.values().all(|(state, _)| TERMINAL_STATES.contains(&state.as_str()));
    let needs_you = summary.iter().filter(|(_, (state, requests))| state == "awaiting_parent" && !requests.is_empty()).map(|(id, _)| id.clone()).collect::<Vec<_>>();
    let hint = if !needs_you.is_empty() {
        "Some delegates are waiting for your decision: answer their pendingRequests with delegate_respond, then call delegate_wait again."
    } else if all_finished {
        "All delegates have finished: read each answer with delegate_result."
    } else {
        "Delegates are still working: call delegate_wait again."
    };
    json!({
        "changed": changed,
        "timedOut": timed_out,
        "waitedSeconds": waited.as_secs(),
        "allFinished": all_finished,
        "needsYou": needs_you,
        "hint": hint,
        "delegates": status.get("delegates").cloned().unwrap_or_else(|| json!([])),
    })
}

async fn wait(config: &RuntimeConfig, caller: &Caller, ids: Vec<String>, timeout: Duration, cancelled: &AtomicBool) -> Result<Value, Value> {
    let started = Instant::now();
    let mut client = connect(config).await?;
    let status = send(&mut client, caller, "delegation.status", json!({"ids": ids})).await?;
    let baseline = summarize(&status);
    if needs_no_wait(&baseline) {
        return Ok(wait_result(status, Vec::new(), false, started.elapsed()));
    }
    loop {
        // Sleep in short steps so a cancelled call stops promptly.
        let next = Instant::now() + POLL_INTERVAL;
        while Instant::now() < next {
            if cancelled.load(Ordering::SeqCst) {
                return Err(failure("cancelled", "the wait was cancelled"));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let status = send(&mut client, caller, "delegation.status", json!({"ids": ids})).await?;
        let current = summarize(&status);
        let changed: Vec<String> = current
            .iter()
            .filter(|(id, value)| baseline.get(*id) != Some(*value))
            .map(|(id, _)| id.clone())
            .collect();
        if !changed.is_empty() {
            return Ok(wait_result(status, changed, false, started.elapsed()));
        }
        if started.elapsed() >= timeout {
            return Ok(wait_result(status, Vec::new(), true, started.elapsed()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiates_known_versions_and_falls_back() {
        assert_eq!(negotiate_version(Some("2025-03-26")), "2025-03-26");
        assert_eq!(negotiate_version(Some("2025-11-25")), "2025-11-25");
        assert_eq!(negotiate_version(Some("1999-01-01")), FALLBACK_VERSION);
        assert_eq!(negotiate_version(None), FALLBACK_VERSION);
    }

    #[test]
    fn exposes_only_delegation_tools() {
        let names: Vec<_> = tools().iter().map(|tool| tool["name"].as_str().unwrap().to_owned()).collect();
        // Adapters auto-approve exactly `delegation::TOOL_NAMES`; keep them in sync.
        assert_eq!(names, crate::delegation::TOOL_NAMES);
        assert!(names.iter().all(|name| !name.starts_with("terminal_")));
    }

    #[test]
    fn composed_catalogs_keep_preview_and_delegation_authorities_separate() {
        let names = |delegation, preview| composed_tools(delegation, preview, None)
            .into_iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(names(false, true), crate::preview::TOOL_NAMES);
        assert_eq!(names(true, false), crate::delegation::TOOL_NAMES);
        let combined = names(true, true);
        assert_eq!(combined.len(), 8);
        assert_eq!(&combined[..6], crate::delegation::TOOL_NAMES);
        assert_eq!(&combined[6..], crate::preview::TOOL_NAMES);

        let preview = composed_tools(false, true, None);
        assert_eq!(preview[0]["inputSchema"]["required"], json!(["requestId", "url"]));
        assert_eq!(preview[0]["inputSchema"]["additionalProperties"], false);
        assert_eq!(preview[1]["inputSchema"]["required"], json!(["requestId"]));
        assert_eq!(preview[1]["inputSchema"]["additionalProperties"], false);

        let instructions = composed_instructions(true, true, None, false);
        let prefix = instructions.chars().take(512).collect::<String>();
        assert!(prefix.contains("delegation=true") && prefix.contains("local preview=true"));
        assert!(instructions.contains(crate::preview::INSTRUCTIONS));
        assert!(!instructions.contains(GENERATED_UI_INSTRUCTIONS));
    }

    #[test]
    fn generated_ui_instructions_add_no_tools_or_authority() {
        let instructions = composed_instructions(false, false, None, true);
        assert!(instructions.contains(GENERATED_UI_INSTRUCTIONS));
        assert!(instructions.contains("{\"version\":1,\"components\":[],\"buttons\":[{\"label\":\"Example\",\"text\":\"Example text\"}]}"));
        assert!(instructions.contains("at most 256 nodes and depth 6"));
        assert_eq!(composed_tools(false, false, None), Vec::<Value>::new());
        assert!(!composed_instructions(false, false, None, false).contains(GENERATED_UI_INSTRUCTIONS));
    }

    #[test]
    fn generated_ui_instructions_survive_claude_codes_2048_character_cut() {
        // Live 2026-10-14: appended after delegation guidance, Claude never saw it.
        let chat = ChatCaller { session_id: "s".into(), token: "t".into(), ask: true, session_info: true, feedback: true };
        let instructions = composed_instructions(true, true, Some(&chat), true);
        let kept = instructions.chars().take(2048).collect::<String>();
        assert!(kept.contains(GENERATED_UI_INSTRUCTIONS), "generated UI must fit inside the kept prefix");
        assert!(kept.starts_with("ThreadTerm capabilities: delegation=true"));
    }

    #[tokio::test]
    async fn preview_calls_reject_model_supplied_caller_identity_before_runtime_connection() {
        let config = RuntimeConfig {
            data_dir: std::env::temp_dir(),
            database_path: std::env::temp_dir().join("unused-preview-test.sqlite"),
            credential_path: std::env::temp_dir().join("unused-preview-test.credential"),
            pipe_base: "preview-spoof-test".into(),
        };
        let preview = PreviewCaller { session_id: "session-owned-by-runtime".into(), token: "secret".into() };
        let error = call_chat_tool(
            &config,
            None,
            Some(&preview),
            None,
            "preview_present",
            &json!({"requestId":"r","url":"http://127.0.0.1:3000","callerSessionId":"spoofed"}),
            &AtomicBool::new(false),
        )
        .await
        .unwrap_err();
        assert_eq!(error["error"]["code"], "invalid_arguments");
        assert!(!error.to_string().contains("secret"));
    }

    #[test]
    fn app_tool_catalog_obeys_the_per_open_snapshot() {
        let chat = ChatCaller { session_id: "s".into(), token: "t".into(), ask: true, session_info: false, feedback: true };
        let names: Vec<_> = composed_tools(false, false, Some(&chat)).into_iter().map(|tool| tool["name"].as_str().unwrap().to_owned()).collect();
        assert_eq!(names, ["ask_user", "feedback_check"]);
        assert!(chat_tools(&chat).iter().all(|tool| tool["inputSchema"]["additionalProperties"] == false));
        let ask = &chat_tools(&chat)[0]["inputSchema"]["properties"]["questions"]["items"]["properties"];
        assert_eq!(ask["header"]["maxLength"], 80);
        assert_eq!(ask["question"]["maxLength"], 4_000);
        assert_eq!(ask["options"]["items"]["properties"]["label"]["maxLength"], 256);
        assert_eq!(ask["options"]["items"]["properties"]["description"]["maxLength"], 2_000);
    }

    #[test]
    fn app_tool_identity_is_runtime_owned() {
        let chat = ChatCaller { session_id: "s".into(), token: "secret".into(), ask: true, session_info: true, feedback: true };
        assert_eq!(chat.params(json!({})).unwrap(), json!({"callerSessionId":"s","callerToken":"secret"}));
        assert_eq!(chat.params(json!({"callerToken":"spoof"})).unwrap_err()["error"]["code"], "invalid_arguments");
    }

    #[test]
    fn recommends_the_handoff_brief_and_leaves_the_users_words_to_the_runtime() {
        let start = &tools()[0];
        let prompt = start["inputSchema"]["properties"]["prompt"]["description"].as_str().unwrap();
        for heading in ["## Assignment", "## Constraints", "## Acceptance criteria", "## Deliverable", "## Context", "## Open questions"] {
            assert!(INSTRUCTIONS.contains(heading) && prompt.contains(heading), "{heading}");
        }
        // The runtime quotes the user (`delegation::first_message`); the parent picks how many messages.
        assert!(!prompt.contains("## User's words") && prompt.contains("userMessages") && prompt.contains("Don't quote the user yourself"));
        // Live run: a parent sent 0 for a conversation whose later message corrected an earlier one.
        assert!(prompt.contains("corrections included"));
        assert!(INSTRUCTIONS.chars().count() <= 2048, "{} chars would be truncated", INSTRUCTIONS.chars().count());
        // `prompt` stays one free-form string; `userMessages` is optional.
        assert_eq!(start["inputSchema"]["required"], json!(["agent", "prompt"]));
        assert_eq!(start["inputSchema"]["properties"]["prompt"]["type"], "string");
        assert_eq!(start["inputSchema"]["properties"]["userMessages"]["maximum"], crate::delegation::MAX_USER_MESSAGES);
        let fields: Vec<_> = start["inputSchema"]["properties"].as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(fields, ["agent", "prompt", "title", "userMessages", "workspace"]);
    }

    #[test]
    fn user_messages_must_be_a_whole_number_in_range() {
        assert_eq!(user_messages_arg(&json!({})), Ok(None));
        assert_eq!(user_messages_arg(&json!({"userMessages":3})), Ok(Some(3)));
        assert_eq!(user_messages_arg(&json!({"userMessages":3.0})), Ok(Some(3)));
        assert_eq!(user_messages_arg(&json!({"userMessages":0})), Ok(Some(0)));
        for bad in [json!(11), json!(-1), json!(2.5), json!("3")] {
            assert_eq!(user_messages_arg(&json!({"userMessages":bad}))
                .unwrap_err()["error"]["code"], "invalid_arguments");
        }
    }

    #[test]
    fn caller_identity_is_added_to_every_request() {
        let caller = Caller { session_id: "s".into(), token: "t".into() };
        assert_eq!(caller.params(json!({"id":"d"})), json!({"id":"d","callerSessionId":"s","callerToken":"t"}));
    }

    #[test]
    fn waiting_ends_at_once_when_a_delegate_needs_the_parent_or_all_finished() {
        let status = |delegates: Value| summarize(&json!({"delegates": delegates}));
        let running = status(json!([{"delegationId":"a","state":"running","pendingRequests":[]}]));
        assert!(!needs_no_wait(&running));
        let asking = status(json!([
            {"delegationId":"a","state":"running","pendingRequests":[]},
            {"delegationId":"b","state":"awaiting_parent","pendingRequests":[{"requestId":"r1"}]}
        ]));
        assert!(needs_no_wait(&asking));
        let done = status(json!([{"delegationId":"a","state":"completed"},{"delegationId":"b","state":"failed"}]));
        assert!(needs_no_wait(&done));
        // A new request on the same delegate is a change.
        let first = status(json!([{"delegationId":"b","state":"awaiting_parent","pendingRequests":[{"requestId":"r1"}]}]));
        let second = status(json!([{"delegationId":"b","state":"awaiting_parent","pendingRequests":[{"requestId":"r2"}]}]));
        assert_ne!(first, second);
    }

    #[test]
    fn wait_results_tell_the_agent_what_to_do_next() {
        let result = wait_result(
            json!({"delegates":[{"delegationId":"b","state":"awaiting_parent","pendingRequests":[{"requestId":"r1"}]}]}),
            vec!["b".into()],
            false,
            Duration::from_secs(3),
        );
        assert_eq!(result["needsYou"], json!(["b"]));
        assert_eq!(result["allFinished"], false);
        assert!(result["hint"].as_str().unwrap().contains("delegate_respond"));
        let content = tool_content(Err(failure("delegation_nested", "delegation_nested")));
        assert_eq!(content["isError"], true);
    }
}
