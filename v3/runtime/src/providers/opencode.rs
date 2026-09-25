use super::{
    approval::{allow_deny_choices, approval_payload, map_allow_deny_choice},
    common::{
        command_output, find_executable, history_page, insert_optional, spawn_managed_service,
        validate_native_id, version_probe, CommandSpec,
    },
    emit, ChatSession, ProviderAdapter, ProviderCapability, ProviderError, ProviderEvent,
    TerminalCommand,
};
use base64::Engine;
use chrono::{TimeZone, Utc};
use rand::RngCore;
use reqwest::blocking::{Client, Response};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader},
    net::TcpListener,
    process::Child,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tokio::sync::broadcast;

pub struct OpenCodeAdapter {
    events: broadcast::Sender<ProviderEvent>,
}
impl OpenCodeAdapter {
    pub fn new(events: broadcast::Sender<ProviderEvent>) -> Self {
        Self { events }
    }
}

impl ProviderAdapter for OpenCodeAdapter {
    fn id(&self) -> &'static str {
        "opencode"
    }
    fn capability(&self) -> ProviderCapability {
        let (installed, version, probe_error) = version_probe("opencode");
        let auth = if installed {
            CommandSpec::provider("opencode", &["auth", "list"])
                .and_then(|spec| command_output(&spec, Duration::from_secs(5)))
                .map(|output| {
                    if output.contains("0 credentials") {
                        "unauthenticated"
                    } else {
                        "unknown"
                    }
                })
                .unwrap_or("unknown")
                .to_owned()
        } else {
            "unknown".to_owned()
        };
        ProviderCapability {
            id: "opencode".to_owned(),
            name: "OpenCode".to_owned(),
            installed,
            version,
            terminal: installed,
            chat: installed && auth != "unauthenticated",
            history: installed,
            resume: installed,
            terminal_resume_capture: self.terminal_capture().as_str(),
            reason: if installed {
                probe_error
            } else {
                Some("OpenCode CLI is not installed".to_owned())
            },
            auth,
        }
    }

    fn terminal_command(
        &self,
        resume_id: Option<&str>,
        assign_id: Option<&str>,
    ) -> Result<TerminalCommand, ProviderError> {
        let mut args = Vec::new();
        if let Some(id) = resume_id.or(assign_id) {
            validate_native_id(id)?;
            args.extend(["--session".to_owned(), id.to_owned()]);
        }
        let path = find_executable("opencode").ok_or_else(|| {
            ProviderError::unavailable("opencode", "OpenCode executable was not found on PATH")
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

    fn prepare_terminal(&self, cwd: &str) -> Result<Option<String>, ProviderError> {
        // Create through the authenticated local native API. No prompt/turn
        // is sent, and the terminal subsequently opens this exact session.
        let server = OpenCodeServer::start(cwd, "terminal-prepare", broadcast::channel(1).0)?;
        let session =
            server.json(server.request(reqwest::Method::POST, "/session", Some(json!({})))?)?;
        let id = session.get("id").and_then(Value::as_str).ok_or_else(|| {
            ProviderError::new("provider_protocol", "OpenCode returned no session id")
        })?;
        validate_native_id(id)?;
        Ok(Some(id.to_owned()))
    }

    fn history_list(
        &self,
        cursor: Option<&str>,
        limit: u32,
        cwd: Option<&str>,
    ) -> Result<Value, ProviderError> {
        let offset = cursor
            .map(str::parse::<usize>)
            .transpose()
            .map_err(|_| {
                ProviderError::new("invalid_cursor", "OpenCode history cursor is invalid")
            })?
            .unwrap_or(0);
        let spec = CommandSpec::provider(
            "opencode",
            &[
                "session",
                "list",
                "--format",
                "json",
                "--max-count",
                "10000",
                "--pure",
            ],
        )?;
        let output = command_output(&spec, Duration::from_secs(15))?;
        let value: Value = serde_json::from_str(&output).map_err(|error| {
            ProviderError::new(
                "provider_protocol",
                format!("OpenCode returned invalid session JSON: {error}"),
            )
        })?;
        let rows = value
            .as_array()
            .or_else(|| value.get("sessions").and_then(Value::as_array))
            .cloned()
            .unwrap_or_default();
        let filtered = rows
            .into_iter()
            .filter_map(|row| opencode_history_item(&row, cwd))
            .collect::<Vec<_>>();
        let filtered_total = filtered.len();
        let items = filtered
            .into_iter()
            .skip(offset)
            .take(limit as usize)
            .collect::<Vec<_>>();
        let next = if offset + items.len() < filtered_total {
            Some((offset + items.len()).to_string())
        } else {
            None
        };
        Ok(history_page(items, next.map(Value::String)))
    }

    fn history_read(&self, native_id: &str) -> Result<Value, ProviderError> {
        validate_native_id(native_id)?;
        let spec = CommandSpec::provider("opencode", &["export", native_id, "--pure"])?;
        let output = command_output(&spec, Duration::from_secs(30))?;
        let raw: Value = serde_json::from_str(&output).map_err(|error| {
            ProviderError::new(
                "provider_protocol",
                format!("OpenCode returned invalid export JSON: {error}"),
            )
        })?;
        Ok(Value::Array(opencode_transcript(&raw)))
    }

    fn open_chat(
        &self,
        session_id: &str,
        cwd: &str,
        native_id: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        if let Some(id) = native_id {
            validate_native_id(id)?;
        }
        let server = OpenCodeServer::start(cwd, session_id, self.events.clone())?;
        let session = if let Some(id) = native_id {
            server.json(server.request(reqwest::Method::GET, &format!("/session/{id}"), None)?)?
        } else {
            server.json(server.request(reqwest::Method::POST, "/session", Some(json!({})))?)?
        };
        let native_id = session
            .get("id")
            .and_then(Value::as_str)
            .or(native_id)
            .ok_or_else(|| {
                ProviderError::new("provider_protocol", "OpenCode returned no session id")
            })?
            .to_owned();
        emit(
            &self.events,
            "opencode",
            session_id,
            Some(&native_id),
            None,
            "session.ready",
            json!({"nativeId":native_id}),
        );
        Ok(Box::new(OpenCodeChat {
            server,
            session_id: session_id.to_owned(),
            native_id,
            events: self.events.clone(),
        }))
    }
}

struct OpenCodeServer {
    base_url: String,
    cwd: String,
    username: String,
    password: String,
    client: Client,
    child: Arc<Mutex<Child>>,
    stopped: Arc<AtomicBool>,
    active_turn: Arc<Mutex<Option<String>>>,
    _job: crate::job::SessionJob,
}

impl OpenCodeServer {
    fn start(
        cwd: &str,
        threadterm_session: &str,
        events: broadcast::Sender<ProviderEvent>,
    ) -> Result<Self, ProviderError> {
        let port = TcpListener::bind(("127.0.0.1", 0))
            .and_then(|listener| listener.local_addr())
            .map_err(|error| ProviderError::new("provider_launch_failed", error.to_string()))?
            .port();
        let mut random = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut random);
        let password = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random);
        let username = "threadterm".to_owned();
        let spec = CommandSpec::provider(
            "opencode",
            &[
                "serve",
                "--hostname",
                "127.0.0.1",
                "--port",
                &port.to_string(),
            ],
        )?;
        let (mut child, job) = spawn_managed_service(
            &spec,
            Some(cwd),
            &[
                ("OPENCODE_SERVER_USERNAME", &username),
                ("OPENCODE_SERVER_PASSWORD", &password),
            ],
        )?;
        if let Some(stdout) = child.stdout.take() {
            thread::spawn(move || for _ in BufReader::new(stdout).lines() {});
        }
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    eprintln!("[opencode-server] {line}");
                }
            });
        }
        let child = Arc::new(Mutex::new(child));
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|error| ProviderError::new("provider_internal", error.to_string()))?;
        let base_url = format!("http://127.0.0.1:{port}");
        let started = Instant::now();
        loop {
            if let Ok(response) = client
                .get(format!("{base_url}/global/health"))
                .basic_auth(&username, Some(&password))
                .send()
            {
                if response.status().is_success() {
                    break;
                }
            }
            if started.elapsed() >= Duration::from_secs(10) {
                if let Ok(mut child) = child.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                return Err(ProviderError::new(
                    "provider_launch_failed",
                    "OpenCode server did not become healthy",
                ));
            }
            thread::sleep(Duration::from_millis(50));
        }
        let stopped = Arc::new(AtomicBool::new(false));
        let active_turn = Arc::new(Mutex::new(None));
        spawn_sse(SseContext {
            base_url: base_url.clone(),
            username: username.clone(),
            password: password.clone(),
            cwd: cwd.to_owned(),
            session_id: threadterm_session.to_owned(),
            events,
            active: Arc::clone(&active_turn),
            stopped: Arc::clone(&stopped),
        });
        Ok(Self {
            base_url,
            cwd: cwd.to_owned(),
            username,
            password,
            client,
            child,
            stopped,
            active_turn,
            _job: job,
        })
    }

    fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Response, ProviderError> {
        let mut request = self
            .client
            .request(method, format!("{}{}", self.base_url, path))
            .basic_auth(&self.username, Some(&self.password))
            .query(&[("directory", &self.cwd)]);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().map_err(|error| {
            ProviderError::new(
                "provider_disconnected",
                format!("OpenCode request failed: {error}"),
            )
        })?;
        if response.status().is_success() {
            Ok(response)
        } else {
            let status = response.status();
            let message = response.text().unwrap_or_default();
            Err(ProviderError::new(
                "provider_error",
                format!("OpenCode returned {status}: {message}"),
            ))
        }
    }
    fn json(&self, response: Response) -> Result<Value, ProviderError> {
        response.json().map_err(|error| {
            ProviderError::new(
                "provider_protocol",
                format!("invalid OpenCode response: {error}"),
            )
        })
    }
    fn shutdown(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.request(reqwest::Method::POST, "/instance/dispose", None);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Drop for OpenCodeServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct OpenCodeChat {
    server: OpenCodeServer,
    session_id: String,
    native_id: String,
    events: broadcast::Sender<ProviderEvent>,
}
impl ChatSession for OpenCodeChat {
    fn native_id(&self) -> Option<String> {
        Some(self.native_id.clone())
    }
    fn send(&mut self, text: &str, operation_id: &str) -> Result<Value, ProviderError> {
        validate_native_id(operation_id)?;
        {
            let mut active = self.server.active_turn.lock().map_err(|_| {
                ProviderError::new("provider_internal", "OpenCode turn lock poisoned")
            })?;
            if active.is_some() {
                return Err(ProviderError::new(
                    "turn_in_progress",
                    "OpenCode session already has an active turn",
                ));
            }
            *active = Some(operation_id.to_owned());
        }
        let sent = self.server.request(
            reqwest::Method::POST,
            &format!("/session/{}/prompt_async", self.native_id),
            Some(json!({"parts":[{"type":"text","text":text}]})),
        );
        if let Err(error) = sent {
            if let Ok(mut active) = self.server.active_turn.lock() {
                *active = None;
            }
            return Err(error);
        }
        emit(
            &self.events,
            "opencode",
            &self.session_id,
            Some(&self.native_id),
            Some(operation_id),
            "chat.turn.started",
            json!({}),
        );
        Ok(json!({"turnId":operation_id}))
    }
    fn cancel(&mut self, turn_id: &str) -> Result<(), ProviderError> {
        let matches = self
            .server
            .active_turn
            .lock()
            .map_err(|_| ProviderError::new("provider_internal", "OpenCode turn lock poisoned"))?
            .as_deref()
            == Some(turn_id);
        if !matches {
            return Err(ProviderError::new(
                "turn_not_active",
                "the requested OpenCode turn is not active",
            ));
        }
        self.server.request(
            reqwest::Method::POST,
            &format!("/session/{}/abort", self.native_id),
            None,
        )?;
        Ok(())
    }
    fn approve(
        &mut self,
        _turn_id: &str,
        approval_id: &str,
        choice_id: &str,
        _operation_id: &str,
    ) -> Result<(), ProviderError> {
        validate_native_id(approval_id)?;
        let response = match map_allow_deny_choice(choice_id)? {
            "allow" => "once",
            _ => "reject",
        };
        self.server.request(
            reqwest::Method::POST,
            &format!("/session/{}/permissions/{approval_id}", self.native_id),
            Some(json!({"response":response})),
        )?;
        Ok(())
    }
    fn stop(&mut self) -> Result<(), ProviderError> {
        self.server.shutdown();
        Ok(())
    }
}

struct SseContext {
    base_url: String,
    username: String,
    password: String,
    cwd: String,
    session_id: String,
    events: broadcast::Sender<ProviderEvent>,
    active: Arc<Mutex<Option<String>>>,
    stopped: Arc<AtomicBool>,
}

fn spawn_sse(context: SseContext) {
    thread::Builder::new().name(format!("opencode-sse-{}", context.session_id)).spawn(move||{
        let client=match Client::builder().connect_timeout(Duration::from_secs(3)).build(){Ok(client)=>client,Err(_)=>return};
        let response=client.get(format!("{}/global/event",context.base_url)).basic_auth(context.username,Some(context.password)).query(&[("directory",context.cwd)]).send();
        let mut response=match response{Ok(response)if response.status().is_success()=>response,Ok(response)=>{emit(&context.events,"opencode",&context.session_id,None,None,"chat.error",json!({"message":format!("OpenCode event stream returned {}",response.status())}));return},Err(error)=>{emit(&context.events,"opencode",&context.session_id,None,None,"chat.error",json!({"message":error.to_string()}));return}};
        let mut reader=BufReader::new(&mut response); let mut line=String::new(); let mut data=String::new();
        loop{line.clear();match reader.read_line(&mut line){Ok(0)=>break,Err(_)=>break,Ok(_)=>{let trimmed=line.trim_end_matches(['\r','\n']);if let Some(value)=trimmed.strip_prefix("data:"){data.push_str(value.trim_start());}else if trimmed.is_empty()&&!data.is_empty(){if let Ok(raw)=serde_json::from_str::<Value>(&data){emit_opencode_event(&context.events,&context.session_id,&context.active,raw);}data.clear();}}}}
        if !context.stopped.load(Ordering::SeqCst){emit(&context.events,"opencode",&context.session_id,None,None,"chat.error",json!({"message":"OpenCode event stream disconnected"}));}
    }).ok();
}

fn emit_opencode_event(
    events: &broadcast::Sender<ProviderEvent>,
    session_id: &str,
    active: &Mutex<Option<String>>,
    raw: Value,
) {
    let payload = raw.get("payload").unwrap_or(&raw);
    let properties = payload.get("properties").unwrap_or(payload);
    let native_id = properties
        .get("sessionID")
        .or_else(|| properties.get("sessionId"))
        .and_then(Value::as_str)
        .or_else(|| {
            properties
                .get("info")
                .and_then(|v| v.get("sessionID"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            properties
                .get("part")
                .and_then(|v| v.get("sessionID"))
                .and_then(Value::as_str)
        });
    let event_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("provider.event");
    let turn = active.lock().ok().and_then(|value| value.clone());
    if event_type == "message.part.updated" {
        let part = properties.get("part").cloned().unwrap_or(Value::Null);
        let delta = properties.get("delta").and_then(Value::as_str);
        let data = delta
            .map(|text| json!({"part":{"type":"text","text":text},"raw":raw}))
            .unwrap_or_else(|| json!({"part":opencode_chat_part(&part),"raw":raw}));
        emit(
            events,
            "opencode",
            session_id,
            native_id,
            turn.as_deref(),
            if delta.is_some() {
                "chat.delta"
            } else {
                "chat.item"
            },
            data,
        );
        return;
    }
    if event_type == "permission.asked" || event_type == "permission.updated" {
        let permission = properties.get("permission").unwrap_or(properties);
        let approval_id = permission
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        emit(
            events,
            "opencode",
            session_id,
            native_id,
            turn.as_deref(),
            "chat.approval",
            json!({
                "approvalId":approval_id,
                "request":permission,
                "choices":allow_deny_choices(),
                "part":{"type":"approval","approvalId":approval_id,"status":"pending","data":approval_payload(approval_id,"opencode","permission.asked",permission.get("title").and_then(Value::as_str).unwrap_or("Permission request"),permission,&allow_deny_choices(),turn.as_deref(),true)}
            }),
        );
        return;
    }
    if event_type == "permission.replied" {
        emit(
            events,
            "opencode",
            session_id,
            native_id,
            turn.as_deref(),
            "chat.approval.resolved",
            json!({"raw":raw}),
        );
        return;
    }
    if event_type == "session.idle" {
        let completed = active.lock().ok().and_then(|mut value| value.take());
        if completed.is_none() {
            emit(
                events,
                "opencode",
                session_id,
                native_id,
                None,
                "provider.event",
                json!({"raw":raw}),
            );
            return;
        }
        emit(
            events,
            "opencode",
            session_id,
            native_id,
            completed.as_deref(),
            "chat.turn.completed",
            json!({"raw":raw}),
        );
        return;
    }
    if event_type == "session.error" {
        let failed = active.lock().ok().and_then(|mut value| value.take());
        emit(
            events,
            "opencode",
            session_id,
            native_id,
            failed.as_deref(),
            "chat.error",
            json!({"raw":raw}),
        );
        return;
    }
    emit(
        events,
        "opencode",
        session_id,
        native_id,
        turn.as_deref(),
        "provider.event",
        json!({"raw":raw}),
    );
}

fn opencode_chat_part(part: &Value) -> Value {
    if part.get("type").and_then(Value::as_str) == Some("text") {
        return json!({
            "type":"text",
            "text":part.get("text").and_then(Value::as_str).unwrap_or_default()
        });
    }
    let kind = part
        .get("tool")
        .or_else(|| part.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let mut normalized = json!({"type":"tool","toolName":kind,"data":part});
    insert_optional(
        &mut normalized,
        "toolId",
        part.get("id")
            .or_else(|| part.get("callID"))
            .and_then(Value::as_str)
            .map(|value| json!(value)),
    );
    insert_optional(
        &mut normalized,
        "status",
        part.get("state")
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str)
            .map(|value| json!(value)),
    );
    normalized
}

fn opencode_history_item(row: &Value, cwd: Option<&str>) -> Option<Value> {
    let id = row.get("id")?.as_str()?;
    let directory = row.get("directory").and_then(Value::as_str);
    if cwd.is_some() && directory != cwd {
        return None;
    }
    let updated = row
        .get("updated")
        .or_else(|| row.get("time").and_then(|v| v.get("updated")))
        .and_then(Value::as_i64)
        .and_then(|value| Utc.timestamp_millis_opt(value).single())
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let mut item = json!({"provider":"opencode","nativeId":id,"title":row.get("title").and_then(Value::as_str).unwrap_or("OpenCode session"),"updatedAt":updated,"resumable":true});
    insert_optional(&mut item, "cwd", directory.map(|value| json!(value)));
    Some(item)
}

fn opencode_transcript(raw: &Value) -> Vec<Value> {
    let messages = raw
        .get("messages")
        .or_else(|| raw.get("data"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    messages.into_iter().enumerate().filter_map(|(index,entry)|{
        let info=entry.get("info").unwrap_or(&entry);let role=info.get("role").and_then(Value::as_str)?;
        if !matches!(role,"user"|"assistant"){return None;}let parts=entry.get("parts").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().map(|part|{
            if part.get("type").and_then(Value::as_str)==Some("text"){json!({"type":"text","text":part.get("text").and_then(Value::as_str).unwrap_or_default()})}
            else {
                let mut tool = json!({"type":"tool","toolName":part.get("type").and_then(Value::as_str).unwrap_or("tool"),"data":part});
                insert_optional(&mut tool, "toolId", part.get("id").and_then(Value::as_str).map(|value| json!(value)));
                insert_optional(&mut tool, "status", part.get("state").and_then(|value| value.get("status")).and_then(Value::as_str).map(|value| json!(value)));
                tool
            }
        }).collect::<Vec<_>>();
        Some(json!({"id":info.get("id").and_then(Value::as_str).map(ToOwned::to_owned).unwrap_or_else(||format!("opencode-{index}")),"role":role,"parts":parts,"createdAt":Utc::now().to_rfc3339()}))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_identity_is_prepared_through_native_session_api() {
        let adapter = OpenCodeAdapter::new(broadcast::channel(1).0);
        assert_eq!(
            adapter.terminal_capture(),
            super::super::TerminalCapture::PreAssigned
        );
    }
    #[test]
    fn filters_history_by_cwd() {
        assert!(opencode_history_item(&json!({"id":"s","directory":"/a"}), Some("/b")).is_none());
    }
    #[test]
    fn reads_export_messages() {
        assert_eq!(
            opencode_transcript(
                &json!({"messages":[{"info":{"id":"m","role":"assistant"},"parts":[{"type":"text","text":"ok"}]}]})
            )[0]["parts"][0]["text"],
            "ok"
        );
    }
    #[test]
    fn normalizes_live_parts_to_the_public_chat_contract() {
        let text = opencode_chat_part(&json!({
            "id":"part-1","sessionID":"session-1","type":"text","text":"OK"
        }));
        assert_eq!(text, json!({"type":"text","text":"OK"}));
        let tool = opencode_chat_part(&json!({
            "id":"part-2","sessionID":"session-1","type":"tool","tool":"bash",
            "state":{"status":"completed"}
        }));
        assert_eq!(tool["type"], "tool");
        assert_eq!(tool["toolName"], "bash");
        assert_eq!(tool["toolId"], "part-2");
        assert_eq!(tool["status"], "completed");
        assert!(tool.get("sessionID").is_none());
    }
}
