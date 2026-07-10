use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
#[cfg(windows)]
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex};

const NOTIFICATION_EVENT: &str = "codex-app://notification";
const REQUEST_EVENT: &str = "codex-app://request";
const DISCONNECTED_EVENT: &str = "codex-app://disconnected";
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(180);

type PendingRequest = oneshot::Sender<Result<Value, String>>;
type PendingMap = Arc<Mutex<HashMap<u64, PendingRequest>>>;

static CODEX_APP_MANAGER: Lazy<CodexAppManager> = Lazy::new(CodexAppManager::default);

#[derive(Default)]
struct CodexAppManager {
    state: Mutex<CodexAppState>,
}

#[derive(Default)]
struct CodexAppState {
    child: Option<Child>,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    pending: PendingMap,
    next_id: u64,
    initialized: bool,
    initialize_response: Option<Value>,
    last_error: Option<String>,
    card_threads: HashMap<String, String>,
    thread_cards: HashMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppStatus {
    running: bool,
    initialized: bool,
    user_agent: Option<String>,
    codex_home: Option<String>,
    platform_os: Option<String>,
    last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppOpenCardResult {
    card_id: String,
    thread_id: String,
    session_id: Option<String>,
    thread_path: Option<String>,
    status: String,
    thread: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexAppNotificationPayload {
    card_id: Option<String>,
    method: String,
    params: Value,
    raw: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexAppRequestPayload {
    request_id: Value,
    card_id: Option<String>,
    method: String,
    params: Value,
    raw: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexAppDisconnectedPayload {
    message: String,
}

#[tauri::command]
pub async fn codex_app_status() -> Result<CodexAppStatus, String> {
    Ok(CODEX_APP_MANAGER.status().await)
}

#[tauri::command]
pub async fn codex_app_open_card(
    app: AppHandle,
    card_id: String,
    cwd: String,
    codex_app_thread_id: Option<String>,
    provider_session_id: Option<String>,
) -> Result<CodexAppOpenCardResult, String> {
    CODEX_APP_MANAGER
        .open_card(app, card_id, cwd, codex_app_thread_id, provider_session_id)
        .await
}

#[tauri::command]
pub async fn codex_app_send_message(
    app: AppHandle,
    card_id: String,
    thread_id: String,
    text: String,
    input: Option<Value>,
    cwd: Option<String>,
) -> Result<Value, String> {
    CODEX_APP_MANAGER.ensure_initialized(&app).await?;
    CODEX_APP_MANAGER
        .register_card_thread(card_id.clone(), thread_id.clone())
        .await;

    let turn_input = normalize_turn_input(text, input)?;
    let mut params = json!({
        "threadId": thread_id,
        "clientUserMessageId": format!("threadterm-{card_id}-{}", next_client_message_suffix()),
        "input": turn_input,
    });
    if let Some(cwd) = clean_optional_string(cwd) {
        params["cwd"] = Value::String(cwd);
    }

    CODEX_APP_MANAGER.send_request("turn/start", params).await
}

#[tauri::command]
pub async fn codex_app_respond_request(
    app: AppHandle,
    request_id: Value,
    response: Value,
) -> Result<(), String> {
    CODEX_APP_MANAGER.ensure_initialized(&app).await?;
    CODEX_APP_MANAGER.send_response(request_id, response).await
}

#[tauri::command]
pub async fn codex_app_interrupt(
    app: AppHandle,
    thread_id: String,
    turn_id: String,
) -> Result<Value, String> {
    CODEX_APP_MANAGER.ensure_initialized(&app).await?;
    CODEX_APP_MANAGER
        .send_request(
            "turn/interrupt",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
            }),
        )
        .await
}

#[tauri::command]
pub async fn codex_app_compact(app: AppHandle, thread_id: String) -> Result<Value, String> {
    CODEX_APP_MANAGER.ensure_initialized(&app).await?;
    CODEX_APP_MANAGER
        .send_request(
            "thread/compact/start",
            json!({
                "threadId": thread_id,
            }),
        )
        .await
}

#[tauri::command]
pub async fn codex_app_set_goal(
    app: AppHandle,
    thread_id: String,
    objective: Option<String>,
    token_budget: Option<u64>,
) -> Result<Value, String> {
    CODEX_APP_MANAGER.ensure_initialized(&app).await?;
    CODEX_APP_MANAGER
        .send_request(
            "thread/goal/set",
            json!({
                "threadId": thread_id,
                "objective": objective.and_then(|value| clean_optional_string(Some(value))),
                "status": "active",
                "tokenBudget": token_budget,
            }),
        )
        .await
}

#[tauri::command]
pub async fn codex_app_list_skills(app: AppHandle, cwd: String) -> Result<Value, String> {
    CODEX_APP_MANAGER.ensure_initialized(&app).await?;
    CODEX_APP_MANAGER
        .send_request(
            "skills/list",
            json!({
                "cwds": [cwd],
                "forceReload": false,
            }),
        )
        .await
}

impl CodexAppManager {
    async fn status(&self) -> CodexAppStatus {
        let state = self.state.lock().await;
        let init = state.initialize_response.as_ref();
        CodexAppStatus {
            running: state.stdin.is_some(),
            initialized: state.initialized,
            user_agent: init
                .and_then(|value| value.get("userAgent"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            codex_home: init
                .and_then(|value| value.get("codexHome"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            platform_os: init
                .and_then(|value| value.get("platformOs"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            last_error: state.last_error.clone(),
        }
    }

    async fn open_card(
        &self,
        app: AppHandle,
        card_id: String,
        cwd: String,
        codex_app_thread_id: Option<String>,
        _provider_session_id: Option<String>,
    ) -> Result<CodexAppOpenCardResult, String> {
        self.ensure_initialized(&app).await?;

        if let Some(thread_id) = clean_optional_string(codex_app_thread_id) {
            match self.resume_thread(&thread_id, &cwd).await {
                Ok(thread) => {
                    return self
                        .open_result(card_id, thread, "resumed".to_string())
                        .await;
                }
                Err(err) => {
                    tracing::debug!(
                        thread_id = %thread_id,
                        error = %err,
                        "Codex app-server resume candidate failed"
                    );
                }
            }
        }

        if let Some(thread) = self.latest_thread_for_cwd(&cwd).await? {
            return self
                .open_result(card_id, thread, "listed".to_string())
                .await;
        }

        let started = self
            .send_request(
                "thread/start",
                json!({
                    "cwd": cwd,
                    "threadSource": "user",
                }),
            )
            .await?;
        let thread = extract_thread(started)
            .ok_or_else(|| "Codex app-server returned no thread for thread/start".to_string())?;
        self.open_result(card_id, thread, "created".to_string())
            .await
    }

    async fn open_result(
        &self,
        card_id: String,
        thread: Value,
        status: String,
    ) -> Result<CodexAppOpenCardResult, String> {
        let summary = summarize_thread(&thread)
            .ok_or_else(|| "Codex app-server returned a malformed thread".to_string())?;
        self.register_card_thread(card_id.clone(), summary.id.clone())
            .await;
        Ok(CodexAppOpenCardResult {
            card_id,
            thread_id: summary.id,
            session_id: summary.session_id,
            thread_path: summary.path,
            status,
            thread,
        })
    }

    async fn resume_thread(&self, thread_id: &str, cwd: &str) -> Result<Value, String> {
        let resumed = self
            .send_request(
                "thread/resume",
                json!({
                    "threadId": thread_id,
                    "cwd": cwd,
                }),
            )
            .await?;
        extract_thread(resumed)
            .ok_or_else(|| "Codex app-server returned no thread for thread/resume".to_string())
    }

    async fn latest_thread_for_cwd(&self, cwd: &str) -> Result<Option<Value>, String> {
        let response = self
            .send_request(
                "thread/list",
                json!({
                    "cwd": cwd,
                    "limit": 1,
                    "sortKey": "updated_at",
                    "sortDirection": "desc",
                }),
            )
            .await?;
        let Some(thread_id) = response
            .get("data")
            .and_then(Value::as_array)
            .and_then(|threads| threads.first())
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
        else {
            return Ok(None);
        };

        self.resume_thread(&thread_id, cwd).await.map(Some)
    }

    async fn ensure_initialized(&self, app: &AppHandle) -> Result<(), String> {
        let needs_init = self.ensure_process(app).await?;
        if !needs_init {
            return Ok(());
        }

        let response = self
            .send_request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "threadterm",
                        "title": "ThreadTerm",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "capabilities": {
                        "experimentalApi": true,
                        "requestAttestation": false,
                    },
                }),
            )
            .await?;
        {
            let mut state = self.state.lock().await;
            state.initialized = true;
            state.initialize_response = Some(response);
            state.last_error = None;
        }
        self.send_notification("initialized", json!({})).await?;
        Ok(())
    }

    async fn ensure_process(&self, app: &AppHandle) -> Result<bool, String> {
        let mut state = self.state.lock().await;
        if state.stdin.is_some() {
            return Ok(!state.initialized);
        }

        let launch = codex_app_server_launch();
        let mut command = Command::new(&launch.program);
        command
            .args(&launch.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command
            .spawn()
            .map_err(|err| format!("Failed to start `{}`: {err}", launch.display()))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Codex app-server stdin is unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex app-server stdout is unavailable".to_string())?;
        let stderr = child.stderr.take();
        let pending = state.pending.clone();
        let app_for_stdout = app.clone();
        tokio::spawn(async move {
            read_stdout(app_for_stdout, stdout, pending).await;
        });
        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                read_stderr(stderr).await;
            });
        }

        state.child = Some(child);
        state.stdin = Some(Arc::new(Mutex::new(stdin)));
        state.initialized = false;
        state.initialize_response = None;
        state.last_error = None;
        Ok(true)
    }

    async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let (id, stdin, pending) = {
            let mut state = self.state.lock().await;
            let stdin = state
                .stdin
                .as_ref()
                .cloned()
                .ok_or_else(|| "Codex app-server is not running".to_string())?;
            state.next_id = state.next_id.saturating_add(1);
            (state.next_id, stdin, state.pending.clone())
        };

        let (tx, rx) = oneshot::channel();
        pending.lock().await.insert(id, tx);
        let line = format!(
            "{}\n",
            json!({
                "id": id,
                "method": method,
                "params": params,
            })
        );

        if let Err(err) = write_line(stdin, line).await {
            pending.lock().await.remove(&id);
            return Err(err);
        }

        match tokio::time::timeout(RESPONSE_TIMEOUT, rx).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => Err("Codex app-server response channel closed".to_string()),
            Err(_) => {
                pending.lock().await.remove(&id);
                Err(format!("Codex app-server request `{method}` timed out"))
            }
        }
    }

    async fn send_response(&self, request_id: Value, response: Value) -> Result<(), String> {
        let stdin = {
            let state = self.state.lock().await;
            state
                .stdin
                .as_ref()
                .cloned()
                .ok_or_else(|| "Codex app-server is not running".to_string())?
        };
        write_line(
            stdin,
            format!(
                "{}\n",
                json!({
                    "id": request_id,
                    "result": response,
                })
            ),
        )
        .await
    }

    async fn send_notification(&self, method: &str, params: Value) -> Result<(), String> {
        let stdin = {
            let state = self.state.lock().await;
            state
                .stdin
                .as_ref()
                .cloned()
                .ok_or_else(|| "Codex app-server is not running".to_string())?
        };
        write_line(
            stdin,
            format!(
                "{}\n",
                json!({
                    "method": method,
                    "params": params,
                })
            ),
        )
        .await
    }

    async fn register_card_thread(&self, card_id: String, thread_id: String) {
        let mut state = self.state.lock().await;
        if let Some(previous_thread_id) = state
            .card_threads
            .insert(card_id.clone(), thread_id.clone())
        {
            state.thread_cards.remove(&previous_thread_id);
        }
        state.thread_cards.insert(thread_id, card_id);
    }

    async fn card_id_for_params(&self, params: &Value) -> Option<String> {
        let thread_id = params.get("threadId").and_then(Value::as_str)?;
        let state = self.state.lock().await;
        state.thread_cards.get(thread_id).cloned()
    }

    async fn handle_disconnect(&self, app: AppHandle, message: String) {
        let pending_map = {
            let mut state = self.state.lock().await;
            state.child = None;
            state.stdin = None;
            state.initialized = false;
            state.last_error = Some(message.clone());
            state.pending.clone()
        };
        let pending = std::mem::take(&mut *pending_map.lock().await);
        for (_, tx) in pending {
            let _ = tx.send(Err(message.clone()));
        }
        let _ = app.emit(DISCONNECTED_EVENT, CodexAppDisconnectedPayload { message });
    }
}

async fn write_line(stdin: Arc<Mutex<ChildStdin>>, line: String) -> Result<(), String> {
    let mut guard = stdin.lock().await;
    guard
        .write_all(line.as_bytes())
        .await
        .map_err(|err| format!("Failed to write to Codex app-server: {err}"))?;
    guard
        .flush()
        .await
        .map_err(|err| format!("Failed to flush Codex app-server stdin: {err}"))
}

async fn read_stdout(app: AppHandle, stdout: ChildStdout, pending: PendingMap) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => handle_server_line(&app, &pending, line).await,
            Ok(None) => {
                CODEX_APP_MANAGER
                    .handle_disconnect(app, "Codex app-server disconnected".to_string())
                    .await;
                break;
            }
            Err(err) => {
                CODEX_APP_MANAGER
                    .handle_disconnect(app, format!("Codex app-server read failed: {err}"))
                    .await;
                break;
            }
        }
    }
}

async fn read_stderr(stderr: ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::debug!(target: "codex_app", stderr = %line, "Codex app-server stderr");
    }
}

async fn handle_server_line(app: &AppHandle, pending: &PendingMap, line: String) {
    let Ok(raw) = serde_json::from_str::<Value>(&line) else {
        tracing::warn!(target: "codex_app", line = %line, "Ignored malformed Codex app-server JSON");
        return;
    };

    if is_response_message(&raw) {
        if let Some(id) = raw.get("id").and_then(Value::as_u64) {
            if let Some(tx) = pending.lock().await.remove(&id) {
                let _ = tx.send(response_result(&raw));
            }
        }
        return;
    }

    let Some(method) = raw
        .get("method")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
    else {
        return;
    };
    let params = raw.get("params").cloned().unwrap_or(Value::Null);
    let card_id = CODEX_APP_MANAGER.card_id_for_params(&params).await;

    if raw.get("id").is_some() {
        let payload = CodexAppRequestPayload {
            request_id: raw.get("id").cloned().unwrap_or(Value::Null),
            card_id,
            method,
            params,
            raw,
        };
        let _ = app.emit(REQUEST_EVENT, payload);
    } else {
        let payload = CodexAppNotificationPayload {
            card_id,
            method,
            params,
            raw,
        };
        let _ = app.emit(NOTIFICATION_EVENT, payload);
    }
}

fn response_result(raw: &Value) -> Result<Value, String> {
    if let Some(error) = raw.get("error") {
        return Err(error_to_string(error));
    }
    Ok(raw.get("result").cloned().unwrap_or(Value::Null))
}

fn error_to_string(error: &Value) -> String {
    if let Some(message) = error.get("message").and_then(Value::as_str) {
        return message.to_string();
    }
    if let Some(message) = error.as_str() {
        return message.to_string();
    }
    error.to_string()
}

fn is_response_message(raw: &Value) -> bool {
    raw.get("id").is_some() && (raw.get("result").is_some() || raw.get("error").is_some())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CodexAppServerLaunch {
    program: String,
    args: Vec<String>,
}

impl CodexAppServerLaunch {
    fn display(&self) -> String {
        std::iter::once(self.program.as_str())
            .chain(self.args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn codex_app_server_launch() -> CodexAppServerLaunch {
    #[cfg(windows)]
    {
        if let Some(path) = resolve_windows_codex_exe() {
            return CodexAppServerLaunch {
                program: path.to_string_lossy().to_string(),
                args: vec!["app-server".to_string(), "--stdio".to_string()],
            };
        }

        // npm exposes Codex on Windows as codex.cmd/codex.ps1, which cannot
        // be launched reliably through CreateProcess as a bare `codex` binary.
        // Keep this shell fallback static so stdin/stdout still proxy directly
        // to `codex app-server --stdio` without user-controlled interpolation.
        CodexAppServerLaunch {
            program: "cmd.exe".to_string(),
            args: vec![
                "/d".to_string(),
                "/s".to_string(),
                "/c".to_string(),
                "codex app-server --stdio".to_string(),
            ],
        }
    }

    #[cfg(not(windows))]
    {
        CodexAppServerLaunch {
            program: "codex".to_string(),
            args: vec!["app-server".to_string(), "--stdio".to_string()],
        }
    }
}

#[cfg(windows)]
fn resolve_windows_codex_exe() -> Option<PathBuf> {
    windows_codex_exe_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
}

#[cfg(windows)]
fn windows_codex_exe_candidates() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        roots.extend(std::env::split_paths(&path));
    }

    let mut candidates = Vec::new();
    for root in roots {
        candidates.push(root.join("codex.exe"));
        candidates.push(
            root.join("node_modules")
                .join("@openai")
                .join("codex")
                .join("node_modules")
                .join("@openai")
                .join("codex-win32-x64")
                .join("vendor")
                .join("x86_64-pc-windows-msvc")
                .join("bin")
                .join("codex.exe"),
        );
        candidates.push(
            root.join("node_modules")
                .join("@openai")
                .join("codex")
                .join("vendor")
                .join("x86_64-pc-windows-msvc")
                .join("bin")
                .join("codex.exe"),
        );
    }
    candidates
}

fn extract_thread(response: Value) -> Option<Value> {
    response.get("thread").cloned()
}

#[derive(Debug, PartialEq, Eq)]
struct ThreadSummary {
    id: String,
    session_id: Option<String>,
    path: Option<String>,
}

fn summarize_thread(thread: &Value) -> Option<ThreadSummary> {
    let id = thread.get("id")?.as_str()?.to_string();
    let session_id = thread
        .get("sessionId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let path = thread
        .get("path")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    Some(ThreadSummary {
        id,
        session_id,
        path,
    })
}

fn normalize_turn_input(text: String, input: Option<Value>) -> Result<Vec<Value>, String> {
    if let Some(Value::Array(items)) = input {
        if items.is_empty() {
            return Err("Codex turn input cannot be empty".to_string());
        }
        return Ok(items);
    }

    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Codex message cannot be empty".to_string());
    }
    Ok(vec![json!({
        "type": "text",
        "text": text,
        "text_elements": [],
    })])
}

fn clean_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn next_client_message_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    millis.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_message_requires_result_or_error() {
        assert!(is_response_message(&json!({"id": 1, "result": {}})));
        assert!(is_response_message(&json!({"id": 1, "error": "nope"})));
        assert!(!is_response_message(
            &json!({"id": 1, "method": "item/tool/call"})
        ));
        assert!(!is_response_message(&json!({"method": "turn/started"})));
    }

    #[test]
    fn summarizes_thread_binding_fields() {
        let summary = summarize_thread(&json!({
            "id": "thread-1",
            "sessionId": "session-1",
            "path": "/tmp/thread.jsonl"
        }));
        assert_eq!(
            summary,
            Some(ThreadSummary {
                id: "thread-1".to_string(),
                session_id: Some("session-1".to_string()),
                path: Some("/tmp/thread.jsonl".to_string()),
            })
        );
    }

    #[test]
    fn normalize_turn_input_prefers_structured_input() {
        let input = normalize_turn_input(
            "".to_string(),
            Some(json!([
                {"type": "skill", "name": "foo", "path": "/tmp/foo"}
            ])),
        )
        .expect("structured input");
        assert_eq!(input[0]["type"], "skill");
    }

    #[test]
    fn normalize_turn_input_builds_text_input() {
        let input = normalize_turn_input("  hello  ".to_string(), None).expect("text input");
        assert_eq!(
            input,
            vec![json!({
                "type": "text",
                "text": "hello",
                "text_elements": [],
            })]
        );
    }

    #[test]
    fn app_server_launch_uses_stdio_transport() {
        let launch = codex_app_server_launch();
        assert!(launch.display().contains("app-server"));
        assert!(launch.display().contains("--stdio"));
    }
}
