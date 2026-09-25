use super::{
    approval::{allow_deny_choices, approval_payload, map_allow_deny_choice},
    common::{
        find_executable, history_page, insert_optional, validate_native_id, version_probe,
        CommandSpec, EnvelopeStyle, JsonLineProcess,
    },
    emit, ChatSession, ProviderAdapter, ProviderCapability, ProviderError, ProviderEvent,
    TerminalCommand,
};
use chrono::{TimeZone, Utc};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::broadcast;

pub struct ClaudeAdapter {
    events: broadcast::Sender<ProviderEvent>,
}

impl ClaudeAdapter {
    pub fn new(events: broadcast::Sender<ProviderEvent>) -> Self {
        Self { events }
    }

    fn worker_spec(&self) -> Result<CommandSpec, ProviderError> {
        let script = claude_worker_path().ok_or_else(|| {
            ProviderError::unavailable(
                "claude",
                "Claude Agent SDK worker was not built; run the claude-sdk workspace build",
            )
        })?;
        let node = std::env::var_os("THREADTERM_CLAUDE_NODE")
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .or_else(|| find_executable("node"))
            .ok_or_else(|| {
                ProviderError::unavailable(
                    "claude",
                    "Node.js was not found for the Claude Agent SDK worker",
                )
            })?;
        Ok(CommandSpec::from_path(
            node,
            vec![script.to_string_lossy().into_owned()],
        ))
    }

    fn spawn(
        &self,
        session_id: &str,
        native: Arc<Mutex<Option<String>>>,
        project_events: bool,
    ) -> Result<JsonLineProcess, ProviderError> {
        let spec = self.worker_spec()?;
        let worker_env: &[(&str, &str)] = if claude_worker_uses_electron_node() {
            &[("ELECTRON_RUN_AS_NODE", "1")]
        } else {
            &[]
        };
        let events = self.events.clone();
        let owned_session = session_id.to_owned();
        let on_message = Arc::new(move |raw| {
            if project_events {
                emit_claude_message(&events, &owned_session, &native, raw);
            }
        });
        let process = JsonLineProcess::spawn(
            "claude-sdk",
            &spec,
            None,
            worker_env,
            EnvelopeStyle::Sidecar,
            on_message,
        )?;
        process.sidecar_request("host.ping", json!({}))?;
        Ok(process)
    }

    fn temporary(&self) -> Result<JsonLineProcess, ProviderError> {
        self.spawn("history", Arc::new(Mutex::new(None)), false)
    }
}

fn claude_worker_uses_electron_node() -> bool {
    std::env::var_os("THREADTERM_CLAUDE_ELECTRON_NODE").is_some_and(|value| value == "1")
}

impl ProviderAdapter for ClaudeAdapter {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn capability(&self) -> ProviderCapability {
        let (installed, version, probe_error) = version_probe("claude");
        let worker_probe = self.temporary().map(|_| ()).map_err(|error| error.message);
        let worker = worker_probe.is_ok();
        let sdk_credentials = claude_sdk_credentials_configured();
        // Presence of a credential config enables Chat, but is not proof the
        // credential is valid. Avoid reporting a successful authentication
        // without making a billable Agent SDK request.
        let auth = if sdk_credentials {
            "unknown"
        } else {
            "unauthenticated"
        }
        .to_owned();
        let chat = worker && sdk_credentials;
        let reason = if !worker {
            worker_probe
                .err()
                .or_else(|| Some("Claude Agent SDK worker is unavailable".to_owned()))
        } else if !sdk_credentials {
            Some(
                "Claude Chat requires ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN; Claude CLI login remains available in Terminal mode"
                    .to_owned(),
            )
        } else if !installed {
            probe_error.or_else(|| {
                Some("Claude CLI is not installed; Terminal mode is unavailable".to_owned())
            })
        } else {
            probe_error
        };
        ProviderCapability {
            id: "claude".to_owned(),
            name: "Claude".to_owned(),
            installed,
            version,
            terminal: installed,
            chat,
            history: worker,
            resume: chat,
            terminal_resume_capture: self.terminal_capture().as_str(),
            reason,
            auth,
        }
    }

    fn terminal_command(
        &self,
        resume_id: Option<&str>,
        assign_id: Option<&str>,
    ) -> Result<TerminalCommand, ProviderError> {
        let mut args = Vec::new();
        if let Some(id) = resume_id {
            validate_native_id(id)?;
            args.extend(["--resume".to_owned(), id.to_owned()]);
        } else if let Some(id) = assign_id {
            // Claude adopts a caller-chosen UUID for a new conversation, so the
            // native identity is known before the PTY starts.
            validate_native_id(id)?;
            if !super::common::is_uuid(id) {
                return Err(ProviderError::new(
                    "invalid_native_id",
                    "Claude --session-id requires a UUID",
                ));
            }
            args.extend(["--session-id".to_owned(), id.to_owned()]);
        }
        let path = find_executable("claude").ok_or_else(|| {
            ProviderError::unavailable("claude", "Claude executable was not found on PATH")
        })?;
        let spec = CommandSpec::from_path(path, args);
        Ok(TerminalCommand {
            program: spec.program,
            args: spec.args,
            display: spec.display,
        })
    }

    fn terminal_capture(&self) -> super::TerminalCapture {
        super::TerminalCapture::PreAssigned
    }

    fn history_list(
        &self,
        cursor: Option<&str>,
        limit: u32,
        cwd: Option<&str>,
    ) -> Result<Value, ProviderError> {
        let offset = cursor
            .map(|value| value.parse::<u64>())
            .transpose()
            .map_err(|_| ProviderError::new("invalid_cursor", "Claude history cursor is invalid"))?
            .unwrap_or(0);
        let process = self.temporary()?;
        let result = process.sidecar_request(
            "history.list",
            json!({"cwd":cwd,"limit":limit,"offset":offset}),
        )?;
        let rows = result
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let count = rows.len() as u64;
        let items = rows
            .into_iter()
            .filter_map(claude_history_item)
            .collect::<Vec<_>>();
        let next = if count == limit as u64 {
            Some((offset + count).to_string())
        } else {
            None
        };
        Ok(history_page(items, next.map(Value::String)))
    }

    fn history_read(&self, native_id: &str) -> Result<Value, ProviderError> {
        validate_native_id(native_id)?;
        let process = self.temporary()?;
        let result = process.sidecar_request("history.read", json!({"sessionId":native_id}))?;
        let raw = result
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(Value::Array(claude_transcript(&raw)))
    }

    fn open_chat(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        ensure_claude_sdk_credentials()?;
        if let Some(id) = native_id {
            validate_native_id(id)?;
        }
        let native = Arc::new(Mutex::new(native_id.map(ToOwned::to_owned)));
        let process = self.spawn(session_id, Arc::clone(&native), true)?;
        let result = process.sidecar_request(
            "session.start",
            json!({"cardId":session_id,"cwd":cwd,"sessionId":native_id}),
        )?;
        let bound = result
            .get("sessionId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| native_id.map(ToOwned::to_owned));
        Ok(Box::new(ClaudeChat {
            process,
            session_id: session_id.to_owned(),
            native_id: bound,
        }))
    }
}

struct ClaudeChat {
    process: JsonLineProcess,
    session_id: String,
    native_id: Option<String>,
}

impl ChatSession for ClaudeChat {
    fn native_id(&self) -> Option<String> {
        self.native_id.clone()
    }
    fn is_alive(&self) -> bool {
        self.process.is_alive()
    }
    fn send(&mut self, text: &str, operation_id: &str) -> Result<Value, ProviderError> {
        validate_native_id(operation_id)?;
        self.process.sidecar_request(
            "session.send",
            json!({"cardId":self.session_id,"text":text,"operationId":operation_id}),
        )?;
        Ok(json!({"turnId":operation_id}))
    }
    fn cancel(&mut self, _turn_id: &str) -> Result<(), ProviderError> {
        self.process
            .sidecar_request("session.interrupt", json!({"cardId":self.session_id}))?;
        Ok(())
    }
    fn approve(
        &mut self,
        _turn_id: &str,
        approval_id: &str,
        choice_id: &str,
        _operation_id: &str,
    ) -> Result<(), ProviderError> {
        let behavior = map_allow_deny_choice(choice_id)?;
        self.process.sidecar_request(
            "session.decision",
            json!({"cardId":self.session_id,"requestId":approval_id,"behavior":behavior}),
        )?;
        Ok(())
    }
    fn stop(&mut self) -> Result<(), ProviderError> {
        self.process
            .sidecar_request("session.stop", json!({"cardId":self.session_id}))?;
        Ok(())
    }
}

fn claude_sdk_credentials_configured() -> bool {
    ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
        .into_iter()
        .any(|name| {
            std::env::var_os(name).is_some_and(|value| !value.to_string_lossy().trim().is_empty())
        })
}

fn ensure_claude_sdk_credentials() -> Result<(), ProviderError> {
    if claude_sdk_credentials_configured() {
        Ok(())
    } else {
        Err(ProviderError::unavailable(
            "claude",
            "Claude Chat requires ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN; use Terminal mode for Claude CLI login",
        ))
    }
}

fn claude_worker_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("THREADTERM_CLAUDE_SDK_HOST")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut candidates = vec![
        manifest.join("../providers/claude-sdk/dist/claude-sdk-host.mjs"),
        manifest.join("../providers/claude-sdk/src/main.mjs"),
    ];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("../providers/claude-sdk-host.mjs"));
            candidates.push(dir.join("claude-sdk-host.mjs"));
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn emit_claude_message(
    events: &broadcast::Sender<ProviderEvent>,
    session_id: &str,
    native: &Mutex<Option<String>>,
    raw: Value,
) {
    let ev = raw
        .get("ev")
        .and_then(Value::as_str)
        .unwrap_or("provider.event");
    let learned_native = raw
        .get("sessionId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    if let Some(id) = &learned_native {
        if let Ok(mut value) = native.lock() {
            *value = Some(id.clone());
        }
    }
    let native_id = learned_native.or_else(|| native.lock().ok().and_then(|value| value.clone()));
    let turn_id = raw.get("operationId").and_then(Value::as_str);
    if ev == "session.request" {
        let approval_id = raw
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        emit(
            events,
            "claude",
            session_id,
            native_id.as_deref(),
            turn_id,
            "chat.approval",
            json!({
                "approvalId":approval_id,
                "request":raw,
                "choices":allow_deny_choices(),
                "part":{"type":"approval","approvalId":approval_id,"status":"pending","data":approval_payload(approval_id,"claude","session.request",raw.get("title").and_then(Value::as_str).unwrap_or("Permission request"),&raw,&allow_deny_choices(),turn_id,true)}
            }),
        );
        return;
    }
    if ev == "session.status" {
        let phase = raw
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let kind = match phase {
            "ready" => "session.ready",
            "running" => "chat.turn.started",
            "idle" => "chat.turn.completed",
            "error" => "chat.error",
            "closed" => "session.closed",
            _ => "provider.event",
        };
        emit(
            events,
            "claude",
            session_id,
            native_id.as_deref(),
            turn_id,
            kind,
            json!({"raw":raw}),
        );
        return;
    }
    if ev == "session.event" {
        let message = raw.get("message").cloned().unwrap_or(Value::Null);
        let text = message
            .get("event")
            .and_then(|e| e.get("delta"))
            .and_then(|d| d.get("text"))
            .and_then(Value::as_str);
        let kind = if text.is_some() {
            "chat.delta"
        } else {
            "chat.item"
        };
        let data = text
            .map(|text| json!({"part":{"type":"text","text":text},"raw":raw}))
            .unwrap_or_else(|| json!({"raw":raw}));
        emit(
            events,
            "claude",
            session_id,
            native_id.as_deref(),
            turn_id,
            kind,
            data,
        );
        return;
    }
    emit(
        events,
        "claude",
        session_id,
        native_id.as_deref(),
        turn_id,
        "provider.event",
        json!({"raw":raw}),
    );
}

fn claude_history_item(row: Value) -> Option<Value> {
    let id = row
        .get("sessionId")
        .or_else(|| row.get("session_id"))
        .and_then(Value::as_str)?;
    let title = row
        .get("customTitle")
        .or_else(|| row.get("custom_title"))
        .or_else(|| row.get("summary"))
        .and_then(Value::as_str)
        .unwrap_or("Claude session");
    let updated = row
        .get("lastModified")
        .or_else(|| row.get("last_modified"))
        .and_then(Value::as_i64)
        .and_then(|millis| Utc.timestamp_millis_opt(millis).single())
        .map(|date| date.to_rfc3339())
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let mut item = json!({"provider":"claude","nativeId":id,"title":title,"updatedAt":updated,"resumable":true});
    insert_optional(
        &mut item,
        "cwd",
        row.get("cwd")
            .or_else(|| row.get("projectPath"))
            .or_else(|| row.get("project_path"))
            .and_then(Value::as_str)
            .map(|value| json!(value)),
    );
    Some(item)
}

fn claude_transcript(raw: &[Value]) -> Vec<Value> {
    raw.iter().enumerate().filter_map(|(index, entry)| {
        let message = entry.get("message")?;
        let role = entry.get("type").or_else(|| message.get("role")).and_then(Value::as_str)?;
        if !matches!(role, "user"|"assistant") { return None; }
        let parts = message.get("content").and_then(Value::as_array).map(|content| content.iter().filter_map(|part| {
            match part.get("type").and_then(Value::as_str) {
                Some("text") => Some(json!({"type":"text","text":part.get("text").and_then(Value::as_str).unwrap_or_default()})),
                Some(kind) => {
                    let mut tool = json!({"type":"tool","toolName":kind,"data":part});
                    insert_optional(
                        &mut tool,
                        "toolId",
                        part.get("id")
                            .and_then(Value::as_str)
                            .map(|value| json!(value)),
                    );
                    Some(tool)
                }
                None => None,
            }
        }).collect::<Vec<_>>()).unwrap_or_default();
        Some(json!({"id":entry.get("uuid").and_then(Value::as_str).map(ToOwned::to_owned).unwrap_or_else(|| format!("claude-{index}")),"role":role,"parts":parts,"createdAt":Utc::now().to_rfc3339()}))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_claude_session_id() {
        assert_eq!(
            claude_history_item(json!({"sessionId":"c1","summary":"Hello"})).unwrap()["nativeId"],
            "c1"
        );
    }
    #[test]
    fn extracts_text_blocks() {
        assert_eq!(
            claude_transcript(&[
                json!({"type":"assistant","uuid":"m1","message":{"content":[{"type":"text","text":"ok"}]}})
            ])[0]["parts"][0]["text"],
            "ok"
        );
    }
}
