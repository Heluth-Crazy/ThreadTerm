pub mod claude;
pub mod codex;
pub mod grok;
pub mod kimi;
pub mod opencode;
pub mod pi;
#[cfg(test)]
mod reader_contract_tests;

use super::facts::{Parsed, ReaderState};
use serde_json::Value;

pub fn parse(
    provider: &str,
    value: &Value,
    offset: u64,
    file_id: &str,
    state: &mut ReaderState,
) -> Parsed {
    let explicit = value
        .get("schema_version")
        .or_else(|| value.get("formatVersion"))
        .and_then(Value::as_u64);
    let pi_version = (provider == "pi"
        && value.get("type").and_then(Value::as_str) == Some("session"))
    .then(|| value.get("version").and_then(Value::as_u64))
    .flatten();
    if explicit.is_some_and(|v| v != 1) || pi_version.is_some_and(|v| !(1..=3).contains(&v)) {
        if !state.data.is_object() {
            state.data = serde_json::json!({});
        }
        state.data["unsupportedFormat"] = serde_json::json!(true);
        return Parsed {
            problems: vec![format!(
                "unsupported_format_v{}",
                explicit.or(pi_version).unwrap()
            )],
            ..Default::default()
        };
    }
    if state.data.get("unsupportedFormat").and_then(Value::as_bool) == Some(true) {
        return Parsed::default();
    }
    if provider == "kimi"
        && (value.pointer("/message/payload/token_usage").is_some()
            || value.get("token_usage").is_some())
    {
        return Parsed {
            problems: vec!["unsupported_format_kimi_python".into()],
            ..Default::default()
        };
    }
    if provider == "grok" && value.pointer("/params/update/usage/input_tokens").is_some() {
        return Parsed {
            problems: vec!["unsupported_format_grok_snake_case".into()],
            ..Default::default()
        };
    }
    match provider {
        "claude" => claude::parse(value, offset, file_id, state),
        "codex" => codex::parse(value, offset, file_id, state),
        "grok" => grok::parse(value, offset, file_id, state),
        "kimi" => kimi::parse(value, offset, file_id, state),
        "opencode" => opencode::parse(value, offset, file_id, state),
        "pi" => pi::parse(value, offset, file_id, state),
        _ => Parsed {
            problems: vec!["not_supported_yet".into()],
            ..Default::default()
        },
    }
}
