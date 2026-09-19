use crate::{config::RuntimeConfig, local_client::RuntimeClient};
use anyhow::Result;
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    path::Path,
};

const MAX_LINE: usize = 1024 * 1024;
const MCP_VERSION: &str = "2025-06-18";

pub async fn run_stdio() -> Result<()> {
    let config = RuntimeConfig::load()?;
    let mut lifecycle = Lifecycle::AwaitInitialize;
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        if line.len() > MAX_LINE {
            emit(&mut stdout, error(Value::Null, -32600, "request_too_large"));
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                emit(&mut stdout, error(Value::Null, -32700, "parse_error"));
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            emit(&mut stdout, error(id, -32600, "invalid_request"));
            continue;
        }
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let response = match method {
            "initialize"
                if lifecycle == Lifecycle::AwaitInitialize && valid_initialize(&request) =>
            {
                lifecycle = Lifecycle::AwaitInitialized;
                Some(ok(
                    id,
                    json!({"protocolVersion":MCP_VERSION,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"threadterm-v3-terminal-host","version":env!("CARGO_PKG_VERSION")}}),
                ))
            }
            "initialize" => Some(error(id, -32600, "invalid_initialize")),
            "notifications/initialized"
                if lifecycle == Lifecycle::AwaitInitialized && request.get("id").is_none() =>
            {
                lifecycle = Lifecycle::Ready;
                None
            }
            "notifications/initialized" => {
                Some(error(id, -32600, "invalid_initialized_notification"))
            }
            "ping" if lifecycle == Lifecycle::Ready => Some(ok(id, json!({}))),
            "tools/list"
                if lifecycle == Lifecycle::Ready
                    && request.get("params").is_none_or(|v| v == &json!({})) =>
            {
                Some(ok(id, json!({"tools":tools()})))
            }
            "tools/call"
                if lifecycle == Lifecycle::Ready
                    && request.get("params").is_some_and(exact_tool_call) =>
            {
                Some(ok(id, call(&config, request["params"].clone()).await))
            }
            _ if lifecycle != Lifecycle::Ready => Some(error(id, -32600, "initialize_required")),
            "tools/list" | "tools/call" => Some(error(id, -32602, "invalid_params")),
            _ => Some(error(id, -32601, "method_not_found")),
        };
        if let Some(response) = response {
            emit(&mut stdout, response);
        }
    }
    Ok(())
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Lifecycle {
    AwaitInitialize,
    AwaitInitialized,
    Ready,
}
fn valid_initialize(request: &Value) -> bool {
    request.get("id").is_some_and(|v| !v.is_null())
        && request
            .pointer("/params/protocolVersion")
            .and_then(Value::as_str)
            == Some(MCP_VERSION)
        && request
            .pointer("/params/capabilities")
            .is_some_and(Value::is_object)
        && request
            .pointer("/params/clientInfo")
            .is_some_and(Value::is_object)
}
fn exact_tool_call(v: &Value) -> bool {
    v.as_object().is_some_and(|o| {
        o.keys().all(|k| k == "name" || k == "arguments")
            && o.get("name")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
            && o.get("arguments").is_none_or(Value::is_object)
    })
}
fn tools() -> Vec<Value> {
    vec![
        tool(
            "terminal_host_status",
            "Report authenticated V3 runtime health.",
            json!({"type":"object","additionalProperties":false}),
        ),
        tool(
            "terminal_create",
            "Create a direct executable terminal in an existing absolute directory.",
            json!({"type":"object","additionalProperties":false,"required":["request_id","launch","placement"],"properties":{"request_id":{"type":"string","minLength":1,"maxLength":512},"launch":{"type":"object","additionalProperties":false,"required":["executable","args","cwd"],"properties":{"executable":{"type":"string","minLength":1},"args":{"type":"array","maxItems":256,"items":{"type":"string"}},"cwd":{"type":"string","minLength":1}}},"placement":{"enum":["workspace","window"]},"title":{"type":"string","maxLength":1024},"workspace_path":{"type":"string"},"presentation":{"enum":["background","focused"]}}}),
        ),
        tool(
            "terminal_get",
            "Get a terminal by handle or durable create request_id.",
            json!({"type":"object","additionalProperties":false,"properties":{"handle":{"type":"string"},"request_id":{"type":"string"},"cursor":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":1048576}},"oneOf":[{"required":["handle"]},{"required":["request_id"]}]}),
        ),
        tool(
            "terminal_list",
            "List V3 terminals, optionally by status.",
            json!({"type":"object","additionalProperties":false,"properties":{"state":{"enum":["starting","running","idle","waiting","exited","interrupted","error"]}}}),
        ),
        tool(
            "terminal_present",
            "Request presentation through the desktop coordinator.",
            json!({"type":"object","additionalProperties":false,"required":["handle","placement"],"properties":{"handle":{"type":"string"},"placement":{"enum":["workspace","window"]},"workspace_path":{"type":"string"},"presentation":{"enum":["background","focused"]}}}),
        ),
        tool(
            "terminal_close",
            "Stop a V3 terminal by handle.",
            json!({"type":"object","additionalProperties":false,"required":["handle"],"properties":{"handle":{"type":"string"},"mode":{"enum":["graceful","force"]}}}),
        ),
    ]
}
fn tool(name: &str, description: &str, input: Value) -> Value {
    json!({"name":name,"description":description,"inputSchema":input})
}
async fn call(config: &RuntimeConfig, params: Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let result = match name {
        "terminal_host_status" => status(config).await,
        "terminal_create" => create(config, args).await,
        "terminal_list" => list(config, args).await,
        "terminal_get" => get(config, args).await,
        "terminal_close" => close(config, args).await,
        "terminal_present" => present(config, args).await,
        _ => Err(typed("invalid_request", "unknown tool", false)),
    };
    match result {
        Ok(v) => content(v, false),
        Err(e) => content(e, true),
    }
}
async fn client(config: &RuntimeConfig) -> Result<RuntimeClient, Value> {
    RuntimeClient::connect(config, format!("mcp-{}", uuid::Uuid::new_v4()))
        .await
        .map_err(|_| {
            typed(
                "app_unavailable",
                "ThreadTerm V3 runtime is unavailable",
                true,
            )
        })
}
async fn status(config: &RuntimeConfig) -> Result<Value, Value> {
    let mut c = client(config).await?;
    c.request("runtime.health", json!({})).await.map_err(|_| {
        typed(
            "app_unavailable",
            "ThreadTerm V3 runtime is unavailable",
            true,
        )
    })
}
async fn snapshot(config: &RuntimeConfig) -> Result<Value, Value> {
    let mut c = client(config).await?;
    c.request("runtime.snapshot", json!({}))
        .await
        .map_err(|e| typed("runtime_error", e.to_string(), true))
}
async fn create(config: &RuntimeConfig, args: Value) -> Result<Value, Value> {
    let object = args
        .as_object()
        .ok_or_else(|| typed("invalid_request", "arguments must be an object", false))?;
    reject_unknown(
        object,
        &[
            "request_id",
            "launch",
            "placement",
            "title",
            "workspace_path",
            "presentation",
        ],
    )?;
    let request_id = str_field(object, "request_id")?;
    let launch = object
        .get("launch")
        .and_then(Value::as_object)
        .ok_or_else(|| typed("invalid_request", "launch is required", false))?;
    reject_unknown(launch, &["executable", "args", "cwd"])?;
    let executable = str_field(launch, "executable")?;
    let cwd = str_field(launch, "cwd")?;
    let canonical = canonical_existing(&cwd)?;
    let argv = launch
        .get("args")
        .and_then(Value::as_array)
        .ok_or_else(|| typed("invalid_request", "launch.args is required", false))?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| typed("invalid_request", "launch.args must contain strings", false))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if argv.len() > 256 {
        return Err(typed("invalid_request", "too many arguments", false));
    };
    let placement = object
        .get("placement")
        .and_then(Value::as_str)
        .filter(|v| matches!(*v, "workspace" | "window"))
        .ok_or_else(|| typed("invalid_request", "invalid placement", false))?;
    if let Some(path) = object.get("workspace_path").and_then(Value::as_str) {
        if placement != "workspace" || canonical_existing(path)? != canonical {
            return Err(typed(
                "invalid_request",
                "workspace_path must equal cwd for workspace placement",
                false,
            ));
        }
    };
    let title = object.get("title").and_then(Value::as_str);
    let mut c = client(config).await?;
    let session=c.request("session.create",json!({"cwd":canonical,"title":title,"provider":"custom","mode":"terminal","executable":executable,"args":argv,"operationId":request_id})).await.map_err(|e|typed("runtime_error",e.to_string(),true))?;
    Ok(
        json!({"terminal":session,"placement":placement,"presentation":object.get("presentation").cloned().unwrap_or_else(||json!("focused"))}),
    )
}
async fn list(config: &RuntimeConfig, args: Value) -> Result<Value, Value> {
    let state = args.get("state").and_then(Value::as_str);
    let sessions = snapshot(config)
        .await?
        .get("sessions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|s| {
            s.get("mode").and_then(Value::as_str) == Some("terminal")
                && state.is_none_or(|x| s.get("status").and_then(Value::as_str) == Some(x))
        })
        .collect::<Vec<_>>();
    Ok(json!({"terminals":sessions}))
}
async fn get(config: &RuntimeConfig, args: Value) -> Result<Value, Value> {
    let mut client = client(config).await?;
    let session = match (
        args.get("handle").and_then(Value::as_str),
        args.get("request_id").and_then(Value::as_str),
    ) {
        (Some(handle), None) => snapshot(config)
            .await?
            .get("sessions")
            .and_then(Value::as_array)
            .and_then(|sessions| {
                sessions
                    .iter()
                    .find(|session| session.get("id").and_then(Value::as_str) == Some(handle))
            })
            .cloned(),
        (None, Some(request_id)) => Some(
            client
                .request("session.lookup", json!({"operationId":request_id}))
                .await
                .map_err(|error| typed("runtime_error", error.to_string(), true))?,
        ),
        _ => {
            return Err(typed(
                "invalid_request",
                "provide exactly one selector",
                false,
            ))
        }
    }
    .filter(|session| !session.is_null())
    .ok_or_else(|| typed("terminal_not_found", "terminal was not found", false))?;
    if session.get("mode").and_then(Value::as_str) != Some("terminal") {
        return Err(typed(
            "terminal_not_found",
            "session is not a terminal",
            false,
        ));
    }
    let handle = session
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| typed("runtime_error", "session has no id", false))?;
    let cursor = args.get("cursor").and_then(Value::as_i64).unwrap_or(0);
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(65_536);
    if cursor < 0 || limit > 1024 * 1024 {
        return Err(typed(
            "invalid_request",
            "invalid output cursor or limit",
            false,
        ));
    }
    let output = client
        .request(
            "terminal.read",
            json!({"sessionId":handle,"cursor":cursor,"limit":limit}),
        )
        .await
        .map_err(|error| typed("runtime_error", error.to_string(), true))?;
    Ok(json!({"terminal":session,"output":output}))
}
async fn close(config: &RuntimeConfig, args: Value) -> Result<Value, Value> {
    let handle = args
        .get("handle")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| typed("invalid_request", "handle is required", false))?;
    let mut c = client(config).await?;
    c.request(
        "session.stop",
        json!({"sessionId":handle,"operationId":uuid::Uuid::new_v4().to_string()}),
    )
    .await
    .map_err(|e| typed("runtime_error", e.to_string(), true))?;
    Ok(json!({"handle":handle,"closed":true}))
}
async fn present(config: &RuntimeConfig, args: Value) -> Result<Value, Value> {
    let handle = args
        .get("handle")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| typed("invalid_request", "handle is required", false))?;
    let placement = args
        .get("placement")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "workspace" | "window"))
        .ok_or_else(|| typed("invalid_request", "invalid placement", false))?;
    let presentation = args
        .get("presentation")
        .and_then(Value::as_str)
        .unwrap_or("focused");
    if !matches!(presentation, "background" | "focused") {
        return Err(typed("invalid_request", "invalid presentation", false));
    }
    let workspace_path = args.get("workspace_path").and_then(Value::as_str);
    let mut client = client(config).await?;
    let queued = client.request("session.present", json!({"sessionId":handle,"placement":placement,"presentation":presentation,"workspacePath":workspace_path,"operationId":uuid::Uuid::new_v4().to_string()})).await.map_err(|error| typed("runtime_error", error.to_string(), true))?;
    Ok(
        json!({"handle":handle,"queued":queued.get("queued").and_then(Value::as_bool).unwrap_or(true)}),
    )
}
fn canonical_existing(path: &str) -> Result<String, Value> {
    let p = Path::new(path);
    if !p.is_absolute() || !p.is_dir() {
        return Err(typed(
            "invalid_request",
            "cwd must be an existing absolute directory",
            false,
        ));
    };
    std::fs::canonicalize(p)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| typed("invalid_request", "cwd could not be canonicalized", false))
}
fn str_field(map: &serde_json::Map<String, Value>, key: &str) -> Result<String, Value> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| typed("invalid_request", format!("{key} is required"), false))
}
fn reject_unknown(map: &serde_json::Map<String, Value>, allowed: &[&str]) -> Result<(), Value> {
    if map.keys().any(|k| !allowed.contains(&k.as_str())) {
        Err(typed("invalid_request", "unknown argument", false))
    } else {
        Ok(())
    }
}
fn typed(code: &str, message: impl Into<String>, retryable: bool) -> Value {
    json!({"code":code,"message":message.into(),"effect":"no_effect","retryable":retryable})
}
fn content(value: Value, is_error: bool) -> Value {
    json!({"content":[{"type":"text","text":serde_json::to_string(&value).unwrap_or_else(|_|"{\"code\":\"internal_error\"}".into())}],"structuredContent":value,"isError":is_error})
}
fn ok(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}
fn error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
fn emit(writer: &mut impl Write, value: Value) {
    let _ = serde_json::to_writer(&mut *writer, &value);
    let _ = writer.write_all(b"\n");
    let _ = writer.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lifecycle_validation_is_strict() {
        assert!(valid_initialize(
            &json!({"id":1,"params":{"protocolVersion":MCP_VERSION,"capabilities":{},"clientInfo":{}}})
        ));
        assert!(!valid_initialize(
            &json!({"id":1,"params":{"protocolVersion":"old","capabilities":{},"clientInfo":{}}})
        ));
        assert!(exact_tool_call(
            &json!({"name":"terminal_list","arguments":{}})
        ));
        assert!(!exact_tool_call(
            &json!({"name":"terminal_list","other":true})
        ));
    }
    #[test]
    fn tool_surface_excludes_shell_backdoor() {
        let names = tools()
            .into_iter()
            .filter_map(|v| v.get("name").and_then(Value::as_str).map(str::to_owned))
            .collect::<Vec<_>>();
        assert_eq!(names.len(), 6);
        assert!(!names
            .iter()
            .any(|name| name.contains("input") || name.contains("exec")));
    }
}
