#![deny(unsafe_code)]

use std::io::{self, BufRead, Write};

use serde_json::{json, Value};

mod bridge;

const MAX_JSON_LINE_BYTES: usize = 1024 * 1024;

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut lifecycle = Lifecycle::AwaitInitialize;
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.len() > MAX_JSON_LINE_BYTES {
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
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            emit(&mut stdout, error(id, -32600, "invalid_request"));
            continue;
        }
        let response = match method {
            "initialize"
                if lifecycle == Lifecycle::AwaitInitialize && valid_initialize(&request) =>
            {
                lifecycle = Lifecycle::AwaitInitialized;
                Some(ok(
                    id,
                    json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"threadterm-terminal-host","version":"0.1.0"}}),
                ))
            }
            "initialize" => Some(error(id, -32600, "invalid_initialize")),
            "notifications/initialized"
                if lifecycle == Lifecycle::AwaitInitialized
                    && request.get("id").is_none()
                    && request
                        .get("params")
                        .map_or(true, |params| params == &json!({})) =>
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
                    && request.get("params").map_or(true, |v| v == &json!({})) =>
            {
                Some(ok(id, json!({"tools": bridge::tools()})))
            }
            "tools/call"
                if lifecycle == Lifecycle::Ready
                    && request.get("params").is_some_and(is_exact_tool_call) =>
            {
                Some(ok(
                    id,
                    bridge::call(request.get("params").cloned().unwrap_or(Value::Null)).await,
                ))
            }
            _ if lifecycle != Lifecycle::Ready => Some(error(id, -32600, "initialize_required")),
            "tools/list" | "tools/call" => Some(error(id, -32602, "invalid_params")),
            _ => Some(error(id, -32601, "method_not_found")),
        };
        if let Some(response) = response {
            emit(&mut stdout, response);
        }
    }
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum Lifecycle {
    AwaitInitialize,
    AwaitInitialized,
    Ready,
}
fn valid_initialize(request: &Value) -> bool {
    if request.get("id").is_none() || request["id"].is_null() {
        return false;
    }
    let Some(params) = request.get("params").and_then(Value::as_object) else {
        return false;
    };
    if !params.keys().all(|key| {
        matches!(
            key.as_str(),
            "protocolVersion" | "capabilities" | "clientInfo"
        )
    }) {
        return false;
    }
    params.get("protocolVersion").and_then(Value::as_str) == Some("2025-06-18")
        && params.get("capabilities").is_some_and(Value::is_object)
        && params.get("clientInfo").is_some_and(Value::is_object)
}
fn is_exact_tool_call(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object
        .keys()
        .all(|key| matches!(key.as_str(), "name" | "arguments"))
        && object
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.is_empty())
        && object.get("arguments").map_or(true, Value::is_object)
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
    fn lifecycle_requires_initialized_notification_before_tools() {
        assert!(valid_initialize(
            &json!({"id":1,"params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{}}})
        ));
        assert!(!valid_initialize(
            &json!({"id":1,"params":{"protocolVersion":"2025-06-18","capabilities":{}}})
        ));
        assert!(!valid_initialize(
            &json!({"id":1,"params":{"protocolVersion":"2024-11-05"}})
        ));
        assert!(is_exact_tool_call(
            &json!({"name":"terminal_list","arguments":{}})
        ));
        assert!(!is_exact_tool_call(
            &json!({"name":"terminal_list","unexpected":true})
        ));
    }
}
