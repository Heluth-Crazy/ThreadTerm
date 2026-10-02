use super::{
    approval::{allow_deny_choices, approval_payload, map_allow_deny_choice},
    common::{
        find_executable, history_page, insert_optional, validate_native_id, version_probe,
        CommandSpec, EnvelopeStyle, JsonLineProcess,
    },
    emit_scoped, ChatSession, ProviderAdapter, ProviderCapability, ProviderError, ProviderEvent,
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

/// Tracks whether the SDK query inside a Claude sidecar has ended. The host
/// Node process can stay alive after the query finished, so process liveness
/// alone is not evidence the Chat session is usable.
#[derive(Clone, Default)]
pub(crate) struct WorkerLiveness {
    ended: Arc<std::sync::atomic::AtomicBool>,
}

impl WorkerLiveness {
    fn mark_ended(&self) {
        self.ended.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    pub(crate) fn ended(&self) -> bool {
        self.ended.load(std::sync::atomic::Ordering::SeqCst)
    }
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
        CommandSpec::from_path(node, vec![script.to_string_lossy().into_owned()])
    }

    fn spawn(
        &self,
        session_id: &str,
        native: Arc<Mutex<Option<String>>>,
        project_events: bool,
    ) -> Result<JsonLineProcess, ProviderError> {
        self.spawn_with_liveness(session_id, native, project_events, None)
            .map(|(process, _)| process)
    }

    fn spawn_with_liveness(
        &self,
        session_id: &str,
        native: Arc<Mutex<Option<String>>>,
        project_events: bool,
        worker_token: Option<&str>,
    ) -> Result<(JsonLineProcess, WorkerLiveness), ProviderError> {
        let spec = self.worker_spec()?;
        let worker_env: &[(&str, &str)] = if claude_worker_uses_electron_node() {
            &[("ELECTRON_RUN_AS_NODE", "1")]
        } else {
            &[]
        };
        let events = self.events.clone();
        let owned_session = session_id.to_owned();
        let owned_token = worker_token.map(ToOwned::to_owned);
        let liveness = WorkerLiveness::default();
        let liveness_ref = liveness.clone();
        let on_message = Arc::new(move |raw| {
            if project_events {
                emit_claude_message(
                    &events,
                    &owned_session,
                    &native,
                    &liveness_ref,
                    owned_token.as_deref(),
                    raw,
                );
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
        Ok((process, liveness))
    }

    fn temporary(&self) -> Result<JsonLineProcess, ProviderError> {
        self.spawn("history", Arc::new(Mutex::new(None)), false)
    }

    fn open_chat_worker(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
        worker_token: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        ensure_claude_sdk_credentials()?;
        if let Some(id) = native_id {
            validate_native_id(id)?;
        }
        let native = Arc::new(Mutex::new(native_id.map(ToOwned::to_owned)));
        let (process, liveness) =
            self.spawn_with_liveness(session_id, Arc::clone(&native), true, worker_token)?;
        let result = process.sidecar_request(
            "session.start",
            json!({"cardId":session_id,"cwd":cwd,"sessionId":native_id}),
        )?;
        if liveness.ended() {
            return Err(ProviderError::new(
                "provider_disconnected",
                "Claude SDK query ended during initialization",
            ));
        }
        let learned = native.lock().ok().and_then(|value| value.clone());
        let bound = result
            .get("sessionId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or(learned)
            .or_else(|| native_id.map(ToOwned::to_owned));
        Ok(Box::new(ClaudeChat {
            process,
            session_id: session_id.to_owned(),
            native_id: bound,
            liveness,
        }))
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
        let spec = CommandSpec::from_path(path, args)?;
        Ok(TerminalCommand {
            program: spec.program,
            args: spec.args,
            display: spec.display,
        })
    }

    fn terminal_capture(&self) -> super::TerminalCapture {
        super::TerminalCapture::PreAssigned
    }

    fn preflight_terminal_resume(&self, cwd: &str, native_id: &str) -> Result<(), ProviderError> {
        validate_native_id(native_id)?;
        let process = self.temporary()?;
        let has_messages = |result: &Value| -> Result<bool, ProviderError> {
            result
                .get("messages")
                .and_then(Value::as_array)
                .map(|messages| !messages.is_empty())
                .ok_or_else(|| {
                    ProviderError::new(
                        "provider_protocol",
                        "Claude SDK returned malformed session history",
                    )
                })
        };
        // Check the current project first. A relocated cwd can be empty even
        // when the exact native ID still exists in another project; the SDK's
        // no-dir lookup handles that case without selecting a new identity.
        // This only checks presence; the native CLI still decides whether its
        // exact-ID resume is valid (including ambiguous duplicate records).
        let local =
            process.sidecar_request("history.read", json!({"sessionId":native_id,"cwd":cwd}))?;
        if has_messages(&local)? {
            return Ok(());
        }
        let global = process.sidecar_request("history.read", json!({"sessionId":native_id}))?;
        if has_messages(&global)? {
            return Ok(());
        }
        Err(ProviderError::new(
            "session_has_no_native_history",
            "Claude has no persisted conversation for this session ID; an empty terminal session cannot be resumed",
        ))
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
        self.open_chat_worker(session_id, cwd, native_id, None)
    }

    fn scopes_chat_events(&self) -> bool {
        true
    }

    fn open_chat_scoped(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
        worker_token: &str,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        self.open_chat_worker(session_id, cwd, native_id, Some(worker_token))
    }
}

struct ClaudeChat {
    process: JsonLineProcess,
    session_id: String,
    native_id: Option<String>,
    liveness: WorkerLiveness,
}

impl ChatSession for ClaudeChat {
    fn native_id(&self) -> Option<String> {
        self.native_id.clone()
    }
    fn is_alive(&self) -> bool {
        // The sidecar host process can outlive the SDK query it drives; both
        // must be alive for the session to count as usable.
        self.process.is_alive() && !self.liveness.ended()
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
    liveness: &WorkerLiveness,
    worker_token: Option<&str>,
    raw: Value,
) {
    let ev = raw
        .get("ev")
        .and_then(Value::as_str)
        .unwrap_or("provider.event");
    if ev == "host.fatal" {
        liveness.mark_ended();
        emit_scoped(
            events,
            "claude",
            session_id,
            native
                .lock()
                .ok()
                .and_then(|value| value.clone())
                .as_deref(),
            None,
            "chat.error",
            json!({"raw":raw}),
            worker_token,
        );
        return;
    }
    if raw
        .get("cardId")
        .and_then(Value::as_str)
        .is_some_and(|id| id != session_id)
    {
        return;
    }
    let learned_native = raw
        .get("sessionId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    if let Some(id) = &learned_native {
        if let Ok(mut value) = native.lock() {
            if value.as_ref().is_some_and(|bound| bound != id) {
                liveness.mark_ended();
                emit_scoped(
                    events,
                    "claude",
                    session_id,
                    value.as_deref(),
                    raw.get("operationId").and_then(Value::as_str),
                    "chat.error",
                    json!({"raw":{"error":"Claude native session identity changed unexpectedly"}}),
                    worker_token,
                );
                return;
            }
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
        emit_scoped(
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
            worker_token,
        );
        return;
    }
    if ev == "session.request_cancelled" {
        // A cancellation settles exactly one card: expire it, never approve it,
        // and never touch any other pending request.
        let approval_id = raw
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        emit_scoped(
            events,
            "claude",
            session_id,
            native_id.as_deref(),
            turn_id,
            "chat.approval.resolved",
            json!({
                "approvalId":approval_id,
                "status":"expired",
                "outcome":"cancelled",
                "message":raw.get("message").and_then(Value::as_str).unwrap_or("Request cancelled")
            }),
            worker_token,
        );
        return;
    }
    if ev == "session.status" {
        let phase = raw
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        if matches!(phase, "closed" | "error") {
            liveness.mark_ended();
        }
        let kind = match phase {
            "ready" => "session.ready",
            "running" => "chat.turn.started",
            "idle" => "chat.turn.completed",
            "error" => "chat.error",
            "closed" => "session.closed",
            _ => "provider.event",
        };
        emit_scoped(
            events,
            "claude",
            session_id,
            native_id.as_deref(),
            turn_id,
            kind,
            json!({"raw":raw}),
            worker_token,
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
        emit_scoped(
            events,
            "claude",
            session_id,
            native_id.as_deref(),
            turn_id,
            kind,
            data,
            worker_token,
        );
        if text.is_none() {
            // Complete SDK assistant/user messages can carry several native
            // tool blocks. Never turn their text blocks into a second copy of
            // the already-streamed answer; merge each tool by its native id.
            for (tool_id, part) in claude_message_tool_parts(&message) {
                emit_scoped(
                    events,
                    "claude",
                    session_id,
                    native_id.as_deref(),
                    turn_id,
                    "chat.item",
                    json!({"item":{"id":tool_id},"merge":true,"part":part}),
                    worker_token,
                );
            }
        }
        return;
    }
    emit_scoped(
        events,
        "claude",
        session_id,
        native_id.as_deref(),
        turn_id,
        "provider.event",
        json!({"raw":raw}),
        worker_token,
    );
}

fn claude_message_tool_parts(message: &Value) -> Vec<(String, Value)> {
    let Some(content) = message
        .pointer("/message/content")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    content
        .iter()
        .take(64)
        .filter_map(|block| {
            let kind = block.get("type")?.as_str()?;
            let tool_id = match kind {
                "tool_use" => block.get("id")?.as_str()?,
                "tool_result" => block.get("tool_use_id")?.as_str()?,
                _ => return None,
            };
            let status = if kind == "tool_result" {
                if block.get("is_error").and_then(Value::as_bool) == Some(true) {
                    "failed"
                } else {
                    "complete"
                }
            } else {
                "running"
            };
            let mut part = json!({"type":"tool","toolId":tool_id,"status":status,"data":block});
            if let Some(name) = block.get("name").and_then(Value::as_str) {
                part["toolName"] = json!(name);
            }
            crate::file_references::enrich_tool_part(&mut part, None);
            Some((tool_id.to_owned(), part))
        })
        .collect()
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
                            .or_else(|| part.get("tool_use_id"))
                            .and_then(Value::as_str)
                            .map(|value| json!(value)),
                    );
                    crate::file_references::enrich_tool_part(&mut tool, None);
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
    use std::time::Duration;

    #[test]
    fn sdk_tool_use_and_failed_result_keep_native_id_without_duplicate_text() {
        let (events, mut receiver) = broadcast::channel(16);
        let native = Mutex::new(Some("native".to_owned()));
        let liveness = WorkerLiveness::default();
        for message in [
            json!({"type":"assistant","message":{"content":[
                {"type":"text","text":"already streamed"},
                {"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"src/one.rs"}},
                {"type":"tool_use","id":"toolu_2","name":"Write","input":{"path":"src/two.rs"}}
            ]}}),
            json!({"type":"user","message":{"content":[
                {"type":"tool_result","tool_use_id":"toolu_1","is_error":true,"content":[{"path":"src/three.rs"}]}
            ]}}),
        ] {
            emit_claude_message(
                &events,
                "session",
                &native,
                &liveness,
                Some("worker"),
                json!({"ev":"session.event","cardId":"session","sessionId":"native","operationId":"turn","message":message}),
            );
        }
        let all: Vec<_> = (0..5).map(|_| receiver.try_recv().unwrap()).collect();
        assert_eq!(
            all.iter()
                .filter(|event| event.data.get("part").is_some())
                .count(),
            3
        );
        assert_eq!(all[1].data["item"]["id"], "toolu_1");
        assert_eq!(all[2].data["item"]["id"], "toolu_2");
        assert_eq!(all[4].data["part"]["status"], "failed");
        assert_eq!(all[4].data["part"]["toolId"], "toolu_1");
        assert_eq!(all[4].worker_token.as_deref(), Some("worker"));
        let history = claude_transcript(&[
            json!({"type":"assistant","message":{"content":[
                {"type":"tool_use","id":"toolu_h","name":"Read","input":{"path":"history.rs"}}
            ]}}),
            json!({"type":"user","message":{"content":[
                {"type":"tool_result","tool_use_id":"toolu_h","is_error":true,"content":[{"file_path":"failed.rs"}]}
            ]}}),
        ]);
        assert_eq!(
            history[0]["parts"][0]["fileReferences"][0]["path"],
            "history.rs"
        );
        assert_eq!(history[1]["parts"][0]["toolId"], "toolu_h");
        assert_eq!(
            history[1]["parts"][0]["fileReferences"][0]["path"],
            "failed.rs"
        );
    }

    struct EnvironmentRestore(Vec<(&'static str, Option<std::ffi::OsString>)>);

    impl EnvironmentRestore {
        fn set(&mut self, key: &'static str, value: impl AsRef<std::ffi::OsStr>) {
            if !self.0.iter().any(|(existing, _)| *existing == key) {
                self.0.push((key, std::env::var_os(key)));
            }
            std::env::set_var(key, value);
        }
    }

    impl Drop for EnvironmentRestore {
        fn drop(&mut self) {
            for (key, value) in self.0.drain(..) {
                if let Some(value) = value {
                    std::env::set_var(key, value);
                } else {
                    std::env::remove_var(key);
                }
            }
        }
    }

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

    #[test]
    fn request_cancelled_maps_to_a_targeted_expired_resolution() {
        let (events, mut rx) = broadcast::channel(16);
        let native = Mutex::new(Some("native-1".to_owned()));
        let liveness = WorkerLiveness::default();
        emit_claude_message(
            &events,
            "card-1",
            &native,
            &liveness,
            None,
            json!({
                "ev":"session.request_cancelled",
                "requestId":"card-1-permission-3",
                "operationId":"op-9",
                "sessionId":"native-1"
            }),
        );
        let event = rx.try_recv().unwrap();
        assert_eq!(event.kind, "chat.approval.resolved");
        assert_eq!(event.session_id, "card-1");
        assert_eq!(event.native_id.as_deref(), Some("native-1"));
        assert_eq!(event.turn_id.as_deref(), Some("op-9"));
        assert_eq!(event.data["approvalId"], "card-1-permission-3");
        assert_eq!(event.data["status"], "expired");
        assert_eq!(event.data["outcome"], "cancelled");
    }

    #[test]
    fn closed_and_error_phases_mark_the_worker_ended() {
        let (events, _rx) = broadcast::channel(16);
        let native = Mutex::new(None);
        let liveness = WorkerLiveness::default();
        assert!(!liveness.ended());
        emit_claude_message(
            &events,
            "card-1",
            &native,
            &liveness,
            None,
            json!({"ev":"session.status","phase":"running"}),
        );
        assert!(!liveness.ended(), "a running turn is not a death signal");
        emit_claude_message(
            &events,
            "card-1",
            &native,
            &liveness,
            None,
            json!({"ev":"session.status","phase":"error","error":"boom"}),
        );
        assert!(liveness.ended(), "an internal error must end liveness");
        let second = WorkerLiveness::default();
        emit_claude_message(
            &events,
            "card-1",
            &native,
            &second,
            None,
            json!({"ev":"session.status","phase":"closed"}),
        );
        assert!(second.ended(), "an internal close must end liveness");
    }

    #[test]
    fn mismatched_native_identity_cannot_replace_a_resumed_binding() {
        let (events, mut rx) = broadcast::channel(16);
        let native = Mutex::new(Some("native-original".to_owned()));
        let liveness = WorkerLiveness::default();
        emit_claude_message(
            &events,
            "card-1",
            &native,
            &liveness,
            Some("worker-1"),
            json!({"ev":"session.status","cardId":"card-1","phase":"ready","sessionId":"native-other"}),
        );
        assert_eq!(native.lock().unwrap().as_deref(), Some("native-original"));
        assert!(liveness.ended());
        let event = rx.try_recv().unwrap();
        assert_eq!(event.kind, "chat.error");
        assert_eq!(event.native_id.as_deref(), Some("native-original"));
        assert_eq!(event.worker_token.as_deref(), Some("worker-1"));
        assert!(
            rx.try_recv().is_err(),
            "a foreign ready event must not leak"
        );
    }

    #[test]
    fn host_fatal_ends_liveness_with_the_original_worker_token() {
        let (events, mut rx) = broadcast::channel(16);
        let native = Mutex::new(None);
        let liveness = WorkerLiveness::default();
        emit_claude_message(
            &events,
            "card-1",
            &native,
            &liveness,
            Some("worker-1"),
            json!({"ev":"host.fatal","cardId":"","error":"SDK crashed"}),
        );
        assert!(liveness.ended());
        let event = rx.try_recv().unwrap();
        assert_eq!(event.kind, "chat.error");
        assert_eq!(event.worker_token.as_deref(), Some("worker-1"));
    }

    /// Writes a minimal sidecar-protocol host. mode: `ok` answers session.start
    /// after `delay_ms`; `fail` answers with an error; `die` answers then
    /// reports the internal query closed shortly after.
    #[cfg(windows)]
    fn fake_host(dir: &std::path::Path, mode: &str, delay_ms: u64) -> PathBuf {
        let script = format!(
            r#"import {{ createInterface }} from 'node:readline';
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
let localHistoryId;
createInterface({{ input: process.stdin, crlfDelay: Infinity }}).on('line', line => {{
  let req; try {{ req = JSON.parse(line); }} catch {{ return; }}
  if (req.op === 'host.ping') return write({{ id: req.id, ok: {{ pid: process.pid }} }});
  if (req.op === 'history.read') {{
    if ('{mode}' === 'history-relocated' || '{mode}' === 'history-global-malformed' || '{mode}' === 'history-global-error') {{
      if (req.cwd) {{ localHistoryId = req.sessionId; return write({{ id: req.id, ok: {{ messages: [] }} }}); }}
      if (localHistoryId !== req.sessionId) return write({{ id: req.id, error: {{ message: 'global lookup used another worker or ID' }} }});
      if ('{mode}' === 'history-relocated') return write({{ id: req.id, ok: {{ messages: [{{ fixtureHistoryPresent: true }}] }} }});
      if ('{mode}' === 'history-global-malformed') return write({{ id: req.id, ok: {{ messages: 'not-an-array' }} }});
      return write({{ id: req.id, error: {{ message: 'global history read failed' }} }});
    }}
    if ('{mode}' === 'history-error') return req.cwd
      ? write({{ id: req.id, error: {{ message: 'native history read failed' }} }})
      : write({{ id: req.id, ok: {{ messages: [{{ fixtureHistoryPresent: true }}] }} }});
    if ('{mode}' === 'history-malformed') return req.cwd
      ? write({{ id: req.id, ok: {{ messages: 'not-an-array' }} }})
      : write({{ id: req.id, ok: {{ messages: [{{ fixtureHistoryPresent: true }}] }} }});
    if ('{mode}' === 'history-empty') return write({{ id: req.id, ok: {{ messages: [] }} }});
    return write({{ id: req.id, error: {{ message: 'unsupported history fixture' }} }});
  }}
  if (req.op === 'session.start') {{
    setTimeout(() => {{
      if ('{mode}' === 'fail') return write({{ id: req.id, error: {{ message: 'handshake rejected: not authenticated' }} }});
      if ('{mode}' === 'die-before') write({{ ev: 'session.status', cardId: req.cardId, phase: 'closed', sessionId: 'native-fixture' }});
      write({{ id: req.id, ok: {{ sessionId: req.sessionId ?? null }} }});
      if ('{mode}' === 'die') setTimeout(() => write({{ ev: 'session.status', cardId: req.cardId, phase: 'closed', sessionId: 'native-fixture' }}), 250);
    }}, {delay_ms});
    return;
  }}
  if (req.op === 'session.stop') return write({{ id: req.id, ok: {{}} }});
  write({{ id: req.id, error: {{ message: 'unsupported op' }} }});
}});
"#
        );
        let path = dir.join(format!("fake-host-{mode}.mjs"));
        std::fs::write(&path, script).unwrap();
        path
    }

    #[cfg(windows)]
    #[test]
    fn sidecar_handshake_gates_open_and_internal_death_ends_liveness() {
        if crate::providers::common::find_executable("node").is_none() {
            eprintln!("node is unavailable; skipping the sidecar fixture test");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut environment = EnvironmentRestore(Vec::new());
        environment.set("ANTHROPIC_API_KEY", "qa-fixture-key");
        let cwd = dir.path().to_string_lossy().into_owned();

        // A slow handshake must delay open_chat instead of reporting ready early.
        let ok_host = fake_host(dir.path(), "ok", 400);
        environment.set("THREADTERM_CLAUDE_SDK_HOST", &ok_host);
        let adapter = ClaudeAdapter::new(broadcast::channel(16).0);
        let started = std::time::Instant::now();
        let mut chat = adapter.open_chat("card-ok", &cwd, None).unwrap();
        assert!(
            started.elapsed() >= Duration::from_millis(350),
            "open_chat returned before the sidecar handshake completed"
        );
        assert!(chat.is_alive());
        chat.stop().unwrap();

        // A rejected handshake fails open_chat with the real error.
        let fail_host = fake_host(dir.path(), "fail", 20);
        environment.set("THREADTERM_CLAUDE_SDK_HOST", &fail_host);
        let failure = adapter
            .open_chat("card-fail", &cwd, None)
            .err()
            .expect("a rejected handshake must fail open_chat");
        assert!(
            failure.message.contains("not authenticated"),
            "unexpected failure: {}",
            failure.message
        );

        // A query that dies before its successful start reply cannot leave a
        // briefly ready worker behind.
        let early_death_host = fake_host(dir.path(), "die-before", 20);
        environment.set("THREADTERM_CLAUDE_SDK_HOST", &early_death_host);
        let early_death = adapter
            .open_chat("card-die-before", &cwd, None)
            .err()
            .expect("an already-ended query cannot open a ready chat");
        assert_eq!(early_death.code, "provider_disconnected");

        // The host staying alive while the internal query ends must end liveness.
        let die_host = fake_host(dir.path(), "die", 20);
        environment.set("THREADTERM_CLAUDE_SDK_HOST", &die_host);
        let chat = adapter.open_chat("card-die", &cwd, None).unwrap();
        assert!(chat.is_alive());
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while chat.is_alive() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !chat.is_alive(),
            "host process alive but internal query closed must not stay alive"
        );

        let native_id = "3d209631-5558-452c-adf5-25d14cff23d7";
        let relocated_host = fake_host(dir.path(), "history-relocated", 0);
        environment.set("THREADTERM_CLAUDE_SDK_HOST", &relocated_host);
        adapter.preflight_terminal_resume(&cwd, native_id).unwrap();
        for (mode, code, message) in [
            (
                "history-empty",
                "session_has_no_native_history",
                "Claude has no persisted conversation",
            ),
            (
                "history-malformed",
                "provider_protocol",
                "malformed session history",
            ),
            (
                "history-error",
                "provider_error",
                "native history read failed",
            ),
            (
                "history-global-malformed",
                "provider_protocol",
                "malformed session history",
            ),
            (
                "history-global-error",
                "provider_error",
                "global history read failed",
            ),
        ] {
            let host = fake_host(dir.path(), mode, 0);
            environment.set("THREADTERM_CLAUDE_SDK_HOST", &host);
            let error = adapter
                .preflight_terminal_resume(&cwd, native_id)
                .unwrap_err();
            assert_eq!(error.code, code, "{mode}");
            assert!(error.message.contains(message), "{mode}: {}", error.message);
        }
    }
}
