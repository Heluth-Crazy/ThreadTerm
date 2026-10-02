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

const INSTRUCTIONS: &str = "ThreadTerm delegation: start other coding agents as visible ThreadTerm Chat sessions \
and follow them. Workflow: delegate_start (one call per task; up to 4 at once) → delegate_wait repeatedly until \
every delegate is completed, failed or cancelled → delegate_result for each answer. When a delegate is \
awaiting_parent it needs your decision: answer its pendingRequests with delegate_respond. Stay in your turn while \
delegates run; if your turn ends, their requests go to the user instead. Delegates cannot delegate further.";

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
                            "serverInfo": {"name": "threadterm", "title": "ThreadTerm delegation", "version": env!("CARGO_PKG_VERSION")},
                            "instructions": INSTRUCTIONS,
                        }),
                    ),
                );
            }
            "ping" => emit(&output, &ok(&id, json!({}))),
            _ if !initialized => emit(&output, &rpc_error(&id, -32600, "initialize_required")),
            "tools/list" => emit(&output, &ok(&id, json!({"tools": tools()}))),
            "tools/call" => {
                let name = message.pointer("/params/name").and_then(Value::as_str).unwrap_or("").to_owned();
                let arguments = message.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
                let cancelled = Arc::new(AtomicBool::new(false));
                let key = id.to_string();
                if let Ok(mut calls) = inflight.lock() {
                    calls.insert(key.clone(), Arc::clone(&cancelled));
                }
                let (config, caller, output, inflight) = (config.clone(), caller.clone(), Arc::clone(&output), Arc::clone(&inflight));
                tokio::spawn(async move {
                    let result = call_tool(&config, caller.as_ref(), &name, &arguments, &cancelled).await;
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
            "Start another coding agent as a visible ThreadTerm Chat session that works on `prompt`. The delegate does not see your conversation, so make the prompt a self-contained task (goal, files, constraints, what to report back). Returns at once with a delegationId; then call delegate_wait. workspace `shared` (default) works in your folder; `worktree` gives the delegate its own git branch and folder created from your current commit (your uncommitted changes are not included) — use it when several delegates edit files in parallel. At most 4 active delegates; delegates cannot delegate.",
            json!({"type":"object","additionalProperties":false,"required":["agent","prompt"],"properties":{
                "agent":{"type":"string","enum":AGENTS,"description":"Agent to delegate to; delegate_status lists the available ones."},
                "prompt":{"type":"string","minLength":1,"description":"Self-contained task for the delegate."},
                "title":{"type":"string","maxLength":120,"description":"Short session title shown in ThreadTerm."},
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
